// Docker Compose stack management.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import { settings } from '../config.js';
import { getClient } from '../docker-client.js';
import {
  asyncHandler,
  HttpError,
  intQuery,
  writeWithBackpressure,
} from '../util.js';
import { createApiRouter, streamResponse } from '../route-builder.js';
import {
  CreateStackRequest,
  PassThroughObject,
  StackDetail,
  StackNameParam,
  StackServiceActionParam,
  StackServiceParam,
  StackSummary,
  UpdateStackRequest,
  ValidateResponse,
} from '../schemas/index.js';

const r = createApiRouter('/api/stacks', { tag: 'stacks' });

const COMPOSE_FILENAME = 'docker-compose.yml';
const ENV_FILENAME = '.env';
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

function validateName(name) {
  if (!NAME_RE.test(name || '')) throw new HttpError(400, 'invalid stack name');
  return name;
}
function stackDir(name) {
  validateName(name);
  const base = path.resolve(settings.stacksDir);
  const target = path.resolve(path.join(base, name));
  if (!target.startsWith(base + path.sep) && target !== base) {
    throw new HttpError(400, 'Invalid stack path');
  }
  return target;
}
async function ensureRoot(write) {
  try { await fs.mkdir(settings.stacksDir, { recursive: true }); return true; }
  catch (err) {
    if (write) throw new HttpError(500, `Cannot create STACKS_DIR (${settings.stacksDir}): ${err.message}`);
    try { await fs.access(settings.stacksDir); return true; } catch { return false; }
  }
}
function isManaged(name) {
  try { return existsSync(path.join(stackDir(name), COMPOSE_FILENAME)); } catch { return false; }
}
async function discover() {
  const out = {};
  try {
    const list = await getClient().listContainers({ all: true });
    for (const c of list) {
      const labels = c.Labels || {};
      const proj = labels['com.docker.compose.project'];
      if (!proj) continue;
      out[proj] = out[proj] || [];
      out[proj].push({
        id: c.Id,
        name: ((c.Names && c.Names[0]) || '').replace(/^\//, ''),
        service: labels['com.docker.compose.service'] || null,
        status: c.State,
        image: c.Image,
      });
    }
  } catch {}
  return out;
}
function stackSummary(name, discovered) {
  const cs = discovered[name] || [];
  const services = [...new Set(cs.map((c) => c.service).filter(Boolean))].sort();
  return {
    name, managed: isManaged(name),
    services, containers: cs.length,
    running: cs.filter((c) => c.status === 'running').length,
  };
}

async function readStackFiles(name) {
  const target = stackDir(name);
  let compose = null, env = null;
  try { compose = await fs.readFile(path.join(target, COMPOSE_FILENAME), 'utf8'); } catch {}
  try { env = await fs.readFile(path.join(target, ENV_FILENAME), 'utf8'); } catch {}
  return { compose, env };
}
async function writeStackFiles(name, compose, env) {
  validateName(name);
  await ensureRoot(true);
  const target = stackDir(name);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, COMPOSE_FILENAME), compose);
  if (env != null) await fs.writeFile(path.join(target, ENV_FILENAME), env);
  else { try { await fs.unlink(path.join(target, ENV_FILENAME)); } catch {} }
  return target;
}
function composeArgv(name, ...args) {
  const target = stackDir(name);
  const cp = path.join(target, COMPOSE_FILENAME);
  if (!existsSync(cp)) throw new HttpError(404, `No compose file for stack '${name}'`);
  const argv = ['-p', name, '-f', cp];
  const ep = path.join(target, ENV_FILENAME);
  if (existsSync(ep)) argv.push('--env-file', ep);
  argv.push(...args);
  return { argv, cwd: target };
}
function streamCompose(res, name, ...args) {
  let argv, cwd;
  try { ({ argv, cwd } = composeArgv(name, ...args)); }
  catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ detail: err.detail });
    throw err;
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.write(`$ ${settings.composeBin} ${argv.join(' ')}\n`);
  let proc;
  try { proc = spawn(settings.composeBin, argv, { cwd }); }
  catch (err) { res.write(`ERROR: ${err.message}\n`); return res.end(); }

  // ---- Termination handling ----
  // We may need to kill `proc` either because the client closed the
  // connection or because the wall-clock deadline expired. SIGTERM first,
  // SIGKILL after a grace period if the process hasn't exited.
  let killTimer = null;
  let deadlineTimer = null;
  let killed = false;
  function killProc(reason) {
    if (killed) return;
    killed = true;
    if (reason) {
      try { res.write(`\n[manager] ${reason}; sending SIGTERM\n`); } catch {}
    }
    try { proc.kill('SIGTERM'); } catch {}
    killTimer = setTimeout(() => {
      try {
        if (proc.exitCode == null && proc.signalCode == null) {
          try { res.write('[manager] SIGTERM grace expired; sending SIGKILL\n'); } catch {}
          proc.kill('SIGKILL');
        }
      } catch {}
    }, settings.composeKillGraceMs);
    killTimer.unref && killTimer.unref();
  }

  if (settings.composeDeadlineMs > 0) {
    deadlineTimer = setTimeout(
      () => killProc(`compose deadline of ${settings.composeDeadlineMs}ms reached`),
      settings.composeDeadlineMs,
    );
    deadlineTimer.unref && deadlineTimer.unref();
  }

  // ---- Output piping with back-pressure ----
  // stdout and stderr are interleaved into the response. If the client
  // can't keep up, both sources are paused until the response drains.
  const sources = [proc.stdout, proc.stderr];
  proc.stdout.on('data', (c) => writeWithBackpressure(res, c, sources));
  proc.stderr.on('data', (c) => writeWithBackpressure(res, c, sources));

  proc.on('error', (err) => {
    if (err.code === 'ENOENT') res.write(`ERROR: ${settings.composeBin} not found.\n`);
    else res.write(`ERROR: ${err.message}\n`);
    res.end();
  });
  proc.on('close', (code, signal) => {
    if (killTimer) clearTimeout(killTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    const exitDesc = signal ? `${signal}` : String(code);
    try { res.write(`\n[exit ${exitDesc}]\n`); } catch {}
    res.end();
  });
  res.on('close', () => killProc('client disconnected'));
}

r.get(
  '/',
  { summary: 'List stacks (managed + discovered)', responses: { 200: Type.Array(StackSummary) } },
  asyncHandler(async (_req, res) => {
    await ensureRoot(false);
    const discovered = await discover();
    const managedNames = new Set();
    if (existsSync(settings.stacksDir)) {
      for (const entry of await fs.readdir(settings.stacksDir)) {
        const full = path.join(settings.stacksDir, entry, COMPOSE_FILENAME);
        if (existsSync(full)) managedNames.add(entry);
      }
    }
    const names = [...new Set([...managedNames, ...Object.keys(discovered)])].sort();
    res.json(names.map((n) => stackSummary(n, discovered)));
  }),
);

r.get(
  '/:name',
  {
    summary: 'Get stack detail',
    params: StackNameParam,
    responses: { 200: StackDetail },
  },
  asyncHandler(async (req, res) => {
    const discovered = await discover();
    const summary = stackSummary(req.params.name, discovered);
    let compose = null, env = null;
    if (summary.managed) ({ compose, env } = await readStackFiles(req.params.name));
    else if (!discovered[req.params.name]) throw new HttpError(404, 'Stack not found');
    res.json({ ...summary, compose, env, containers_detail: discovered[req.params.name] || [] });
  }),
);

r.post(
  '/',
  {
    summary: 'Create a stack (streams compose stdout if deploy=true)',
    admin: true,
    expensive: true,
    body: CreateStackRequest,
    responses: { 200: streamResponse('compose up -d stdout (or {name, deployed:false})', 'text/plain') },
  },
  asyncHandler(async (req, res) => {
    const b = req.body;
    await ensureRoot(true);
    if (isManaged(b.name)) throw new HttpError(409, `Stack '${b.name}' already exists`);
    await writeStackFiles(b.name, b.compose, b.env || null);
    if (b.deploy === false) return res.json({ name: b.name, deployed: false });
    streamCompose(res, b.name, 'up', '-d');
  }),
);

r.put(
  '/:name',
  {
    summary: 'Replace compose / env files',
    admin: true,
    params: StackNameParam,
    body: UpdateStackRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    if (!isManaged(req.params.name)) throw new HttpError(404, 'Stack not found (or not managed)');
    const b = req.body;
    const target = stackDir(req.params.name);
    if (b.compose != null) await fs.writeFile(path.join(target, COMPOSE_FILENAME), b.compose);
    if (b.env != null) await fs.writeFile(path.join(target, ENV_FILENAME), b.env);
    res.json({ name: req.params.name, updated: true });
  }),
);

const RemoveQuery = Type.Object(
  { volumes: Type.Optional(Type.Boolean({ default: false })) },
  { additionalProperties: false },
);
const StreamPlain = streamResponse('compose stdout', 'text/plain');

for (const verb of ['up', 'restart', 'pull']) {
  r.post(
    `/:name/${verb}`,
    {
      summary: `compose ${verb} (streamed)`,
      admin: true,
      // `up` and `pull` move bytes (image pulls); `restart` doesn't, but
      // tagging it expensive is harmless and keeps the policy uniform.
      expensive: true,
      params: StackNameParam,
      responses: { 200: StreamPlain },
    },
    (req, res) => {
      if (verb === 'up') return streamCompose(res, req.params.name, 'up', '-d', '--remove-orphans');
      streamCompose(res, req.params.name, verb);
    },
  );
}

r.post(
  '/:name/down',
  {
    summary: 'compose down (streamed)',
    admin: true,
    expensive: true,
    params: StackNameParam,
    query: RemoveQuery,
    responses: { 200: StreamPlain },
  },
  (req, res) => {
    const args = ['down', '--remove-orphans'];
    if (req.query.volumes === 'true' || req.query.volumes === '1') args.push('-v');
    streamCompose(res, req.params.name, ...args);
  },
);

const TailQuery = Type.Object(
  { tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, default: 200 })) },
  { additionalProperties: false },
);

r.get(
  '/:name/logs',
  {
    summary: 'compose logs (streamed)',
    params: StackNameParam,
    query: TailQuery,
    responses: { 200: StreamPlain },
  },
  (req, res) => {
    const tail = intQuery(req.query.tail, 200, { min: 1, max: 5000 });
    streamCompose(res, req.params.name, 'logs', '--no-color', '--tail', String(tail));
  },
);

r.post(
  '/:name/validate',
  {
    summary: 'compose config -q (validate compose file)',
    params: StackNameParam,
    responses: { 200: ValidateResponse },
  },
  asyncHandler(async (req, res) => {
    let argv, cwd;
    try { ({ argv, cwd } = composeArgv(req.params.name, 'config', '-q')); }
    catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ detail: err.detail });
      throw err;
    }
    const proc = spawn(settings.composeBin, argv, { cwd });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    proc.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    const code = await new Promise((resolve, reject) => { proc.on('close', resolve); proc.on('error', reject); });
    res.json({ ok: code === 0, stdout, stderr });
  }),
);

r.post(
  '/:name/services/:service/:action',
  {
    summary: 'Per-service compose action (admin, streamed)',
    admin: true,
    params: StackServiceActionParam,
    responses: { 200: StreamPlain },
  },
  (req, res) => {
    const { action, service, name } = req.params;
    if (action === 'up') return streamCompose(res, name, 'up', '-d', service);
    if (action === 'rm') return streamCompose(res, name, 'rm', '-sf', service);
    streamCompose(res, name, action, service);
  },
);

r.get(
  '/:name/services/:service/logs',
  {
    summary: 'Per-service compose logs (streamed)',
    params: StackServiceParam,
    query: TailQuery,
    responses: { 200: StreamPlain },
  },
  (req, res) => {
    const tail = intQuery(req.query.tail, 200, { min: 1, max: 5000 });
    streamCompose(res, req.params.name, 'logs', '--no-color', '--tail', String(tail), req.params.service);
  },
);

r.delete(
  '/:name',
  {
    summary: 'Tear down + remove a managed stack',
    admin: true,
    params: StackNameParam,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    if (!isManaged(req.params.name)) throw new HttpError(404, 'Stack not found (or not managed)');
    const target = stackDir(req.params.name);
    try {
      const { argv, cwd } = composeArgv(req.params.name, 'down', '--remove-orphans');
      await new Promise((resolve) => {
        const p = spawn(settings.composeBin, argv, { cwd });
        p.on('close', resolve); p.on('error', resolve);
        setTimeout(() => { try { p.kill('SIGTERM'); } catch {} resolve(); }, 300_000);
      });
    } catch {}
    await fs.rm(target, { recursive: true, force: true });
    res.json({ removed: req.params.name });
  }),
);

export default r;
