// Docker Compose stack management.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import yaml from 'js-yaml';
import { settings } from '../config.js';
import { getClient } from '../docker-client.js';
import {
  asyncHandler,
  bulkErrorString,
  HttpError,
  intQuery,
  runBoundedParallel,
  summariseBulk,
  writeWithBackpressure,
} from '../util.js';
import { createApiRouter, streamResponse } from '../route-builder.js';
import {
  BulkResponse,
  CreateStackRequest,
  PassThroughObject,
  StackBulkRequest,
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
}

/**
 * Parse + sanity-check a compose YAML string before we hand it to docker
 * compose. Catches YAML syntax errors at the API boundary instead of
 * letting them land as a half-written file on disk + a confusing
 * "compose config" failure several seconds later.
 *
 *   - rejects YAML that doesn't parse (js-yaml throws YAMLException)
 *   - rejects non-mapping documents (e.g. lists, scalars) — compose files
 *     are always object-at-root
 *   - rejects documents that don't have at least one of services / volumes
 *     / networks / configs / secrets — these are the only top-level keys
 *     compose recognises; anything else is almost certainly a typo
 *
 * Returns the parsed object so callers can read e.g. services for
 * downstream validation if they want; we don't currently use it.
 *
 * (We don't replace `docker compose config -q` validation — compose still
 * runs in /validate and on `up`. This is the cheap pre-write check.)
 */
function parseCompose(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new HttpError(400, 'compose: body is empty');
  }
  let doc;
  try {
    doc = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    // js-yaml errors carry line/column info; surface them so the SPA can
    // jump the editor cursor to the right spot.
    const detail =
      err && err.mark
        ? `YAML parse error at line ${err.mark.line + 1}, column ${err.mark.column + 1}: ${err.reason || err.message}`
        : `YAML parse error: ${(err && err.message) || err}`;
    throw new HttpError(400, detail);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new HttpError(400, 'compose: root must be a mapping (object)');
  }
  const recognised = ['services', 'volumes', 'networks', 'configs', 'secrets', 'version', 'name', 'include', 'x-'];
  const keys = Object.keys(doc);
  const hasRecognised = keys.some((k) => recognised.includes(k) || k.startsWith('x-'));
  if (!hasRecognised) {
    throw new HttpError(
      400,
      `compose: no recognised top-level keys (saw: ${keys.slice(0, 5).join(', ') || '<empty>'}); ` +
      'expected at least one of services, volumes, networks, configs, secrets',
    );
  }
  return doc;
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
/**
 * Run a compose command without streaming, returning {ok, code, stdout,
 * stderr}. Used by the bulk endpoints because interleaving 5 compose
 * processes' real-time output into one HTTP response would be useless
 * to the operator. Inherits the same wall-clock deadline / SIGTERM →
 * SIGKILL teardown as streamCompose.
 */
function runCompose(name, ...args) {
  return new Promise((resolve) => {
    let argv, cwd;
    try { ({ argv, cwd } = composeArgv(name, ...args)); }
    catch (err) {
      return resolve({
        ok: false, code: -1, stdout: '',
        stderr: err.detail || err.message || 'compose setup failed',
      });
    }
    let proc;
    try { proc = spawn(settings.composeBin, argv, { cwd }); }
    catch (err) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: err.message });
    }
    let stdout = '', stderr = '';
    let killed = false;
    const onKill = (reason) => {
      if (killed) return;
      killed = true;
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, settings.composeKillGraceMs).unref();
      stderr += `\n[manager] ${reason}\n`;
    };
    let deadlineTimer = null;
    if (settings.composeDeadlineMs > 0) {
      deadlineTimer = setTimeout(
        () => onKill(`compose deadline ${settings.composeDeadlineMs}ms reached`),
        settings.composeDeadlineMs,
      );
      deadlineTimer.unref && deadlineTimer.unref();
    }
    proc.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    proc.on('error', (err) => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr + err.message });
    });
    proc.on('close', (code, signal) => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve({
        ok: !killed && code === 0,
        code: signal ? -1 : code,
        signal: signal || null,
        stdout,
        stderr,
      });
    });
  });
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
    destructive: true,
    expensive: true,
    body: CreateStackRequest,
    responses: { 200: streamResponse('compose up -d stdout (or {name, deployed:false})', 'text/plain') },
  },
  asyncHandler(async (req, res) => {
    const b = req.body;
    await ensureRoot(true);
    if (isManaged(b.name)) throw new HttpError(409, `Stack '${b.name}' already exists`);
    // Parse-before-write: catch YAML syntax errors at the API boundary so
    // we never persist an unparseable docker-compose.yml on disk.
    parseCompose(b.compose);
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
    destructive: true,
    params: StackNameParam,
    body: UpdateStackRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    if (!isManaged(req.params.name)) throw new HttpError(404, 'Stack not found (or not managed)');
    const b = req.body;
    const target = stackDir(req.params.name);
    // Same parse-before-write guard as POST /. We only check when compose
    // is actually being replaced; .env-only updates pass through.
    if (b.compose != null) {
      parseCompose(b.compose);
      await fs.writeFile(path.join(target, COMPOSE_FILENAME), b.compose);
    }
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
    destructive: true,
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
    destructive: true,
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
    destructive: true,
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
    destructive: true,
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

// ---------- Bulk endpoints ----------
//
// Bulk operations on stacks fan out compose processes with bounded
// parallelism (3 in flight by default — each compose run is itself
// heavy on the daemon, so 5 was too aggressive). Per-stack failures
// come back as a row in `results` instead of failing the whole batch.
//
// Why not stream interleaved output like the single-stack endpoints?
// Because watching 3-5 streams of compose progress lines in one
// response is unreadable; the SPA's bulk bar surfaces the summary,
// and the operator can drill into individual stacks for full output.
//
// Parallelism is intentionally lower than the volume/network bulks
// because compose itself parallelises across services within one
// stack, so the daemon is already busy.
const STACK_BULK_CONCURRENCY = 3;

async function bulkStacks(names, args, { needsManaged = true } = {}) {
  return runBoundedParallel(
    names,
    async (name) => {
      try {
        if (!NAME_RE.test(name)) {
          return { name, ok: false, error: 'invalid stack name' };
        }
        if (needsManaged && !isManaged(name)) {
          return { name, ok: false, error: 'Not found (or not managed)' };
        }
        const out = await runCompose(name, ...args);
        if (out.ok) return { name, ok: true };
        const tail = (out.stderr || out.stdout || '').trim().slice(-400);
        return { name, ok: false, error: tail || `compose exited ${out.code}` };
      } catch (err) {
        return { name, ok: false, error: bulkErrorString(err) };
      }
    },
    STACK_BULK_CONCURRENCY,
  );
}

r.post(
  '/up/bulk',
  {
    summary: 'compose up -d on many stacks (parallel; per-stack results)',
    admin: true,
    destructive: true,
    expensive: true,
    body: StackBulkRequest,
    responses: { 200: BulkResponse },
  },
  asyncHandler(async (req, res) => {
    await ensureRoot(true);
    const out = await bulkStacks(req.body.names, ['up', '-d', '--remove-orphans']);
    res.json(summariseBulk(out));
  }),
);

r.post(
  '/down/bulk',
  {
    summary: 'compose down on many stacks (parallel; optional -v to drop volumes)',
    admin: true,
    destructive: true,
    expensive: true,
    body: StackBulkRequest,
    responses: { 200: BulkResponse },
  },
  asyncHandler(async (req, res) => {
    await ensureRoot(false);
    const args = ['down', '--remove-orphans'];
    if (req.body.volumes) args.push('-v');
    const out = await bulkStacks(req.body.names, args);
    res.json(summariseBulk(out));
  }),
);

r.post(
  '/restart/bulk',
  {
    summary: 'compose restart on many stacks (parallel; per-stack results)',
    admin: true,
    destructive: true,
    expensive: true,
    body: StackBulkRequest,
    responses: { 200: BulkResponse },
  },
  asyncHandler(async (req, res) => {
    await ensureRoot(false);
    const out = await bulkStacks(req.body.names, ['restart']);
    res.json(summariseBulk(out));
  }),
);

r.post(
  '/remove/bulk',
  {
    summary: 'Tear down + remove many stacks (compose down + delete files)',
    admin: true,
    destructive: true,
    expensive: true,
    body: StackBulkRequest,
    responses: { 200: BulkResponse },
  },
  asyncHandler(async (req, res) => {
    await ensureRoot(false);
    const results = await runBoundedParallel(
      req.body.names,
      async (name) => {
        try {
          if (!NAME_RE.test(name)) {
            return { name, ok: false, error: 'invalid stack name' };
          }
          if (!isManaged(name)) {
            return { name, ok: false, error: 'Not found (or not managed)' };
          }
          // Best-effort tear-down; even if compose down fails we still
          // wipe the stored files (matches the single-stack DELETE
          // behaviour). The compose error, if any, is captured for the
          // result so the operator knows the daemon side may need
          // manual cleanup.
          const downArgs = ['down', '--remove-orphans'];
          if (req.body.volumes) downArgs.push('-v');
          const composeOut = await runCompose(name, ...downArgs);
          await fs.rm(stackDir(name), { recursive: true, force: true });
          if (composeOut.ok) return { name, ok: true };
          // The files are gone but compose down failed (e.g. permission
          // error on a volume). Treat as a partial: return ok:false so
          // the operator can investigate.
          const tail = (composeOut.stderr || composeOut.stdout || '').trim().slice(-400);
          return {
            name, ok: false,
            error: `compose down failed (files removed): ${tail || composeOut.code}`,
          };
        } catch (err) {
          return { name, ok: false, error: bulkErrorString(err) };
        }
      },
      STACK_BULK_CONCURRENCY,
    );
    res.json(summariseBulk(results));
  }),
);

// Visible-for-testing only.
export const _internals = { parseCompose, runCompose };

export default r;
