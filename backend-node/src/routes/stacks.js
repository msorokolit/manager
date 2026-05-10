// Docker Compose stack management.
import { Router } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { authenticate, requireAdmin } from '../auth.js';
import { settings } from '../config.js';
import { getClient } from '../docker-client.js';
import { asyncHandler, HttpError, intQuery } from '../util.js';

const router = Router();
router.use(authenticate);

const COMPOSE_FILENAME = 'docker-compose.yml';
const ENV_FILENAME = '.env';
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const SERVICE_ACTIONS = new Set(['up', 'start', 'stop', 'restart', 'pull', 'rm']);

function validateName(name) {
  if (!NAME_RE.test(name || '')) {
    throw new HttpError(
      400,
      "Invalid stack name. Use letters, digits, '-' and '_' (1-63 chars).",
    );
  }
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
  try {
    await fs.mkdir(settings.stacksDir, { recursive: true });
    return true;
  } catch (err) {
    if (write) {
      throw new HttpError(
        500,
        `Cannot create STACKS_DIR (${settings.stacksDir}): ${err.message}`,
      );
    }
    try {
      await fs.access(settings.stacksDir);
      return true;
    } catch {
      return false;
    }
  }
}

function isManaged(name) {
  try {
    return existsSync(path.join(stackDir(name), COMPOSE_FILENAME));
  } catch {
    return false;
  }
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
  } catch {
    /* daemon may be unreachable; return what we have */
  }
  return out;
}

function stackSummary(name, discovered) {
  const cs = discovered[name] || [];
  const services = [
    ...new Set(cs.map((c) => c.service).filter(Boolean)),
  ].sort();
  return {
    name,
    managed: isManaged(name),
    services,
    containers: cs.length,
    running: cs.filter((c) => c.status === 'running').length,
  };
}

router.get(
  '/',
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

async function readStackFiles(name) {
  const target = stackDir(name);
  const cp = path.join(target, COMPOSE_FILENAME);
  const ep = path.join(target, ENV_FILENAME);
  let compose = null;
  let env = null;
  try {
    compose = await fs.readFile(cp, 'utf8');
  } catch {
    /* not managed */
  }
  try {
    env = await fs.readFile(ep, 'utf8');
  } catch {
    /* no env */
  }
  return { compose, env };
}

router.get(
  '/:name',
  asyncHandler(async (req, res) => {
    validateName(req.params.name);
    const discovered = await discover();
    const summary = stackSummary(req.params.name, discovered);
    let compose = null;
    let env = null;
    if (summary.managed) {
      ({ compose, env } = await readStackFiles(req.params.name));
    } else if (!discovered[req.params.name]) {
      throw new HttpError(404, 'Stack not found');
    }
    res.json({
      ...summary,
      compose,
      env,
      containers_detail: discovered[req.params.name] || [],
    });
  }),
);

async function writeStackFiles(name, compose, env) {
  validateName(name);
  await ensureRoot(true);
  const target = stackDir(name);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, COMPOSE_FILENAME), compose);
  if (env != null) {
    await fs.writeFile(path.join(target, ENV_FILENAME), env);
  } else {
    try {
      await fs.unlink(path.join(target, ENV_FILENAME));
    } catch {}
  }
  return target;
}

function composeArgv(name, ...args) {
  const target = stackDir(name);
  const cp = path.join(target, COMPOSE_FILENAME);
  if (!existsSync(cp))
    throw new HttpError(404, `No compose file for stack '${name}'`);
  const argv = ['-p', name, '-f', cp];
  const ep = path.join(target, ENV_FILENAME);
  if (existsSync(ep)) argv.push('--env-file', ep);
  argv.push(...args);
  return { argv, cwd: target };
}

function streamCompose(res, name, ...args) {
  let argv, cwd;
  try {
    ({ argv, cwd } = composeArgv(name, ...args));
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ detail: err.detail });
    throw err;
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.write(`$ ${settings.composeBin} ${argv.join(' ')}\n`);

  let proc;
  try {
    proc = spawn(settings.composeBin, argv, { cwd });
  } catch (err) {
    res.write(`ERROR: ${err.message}\n`);
    return res.end();
  }
  proc.stdout.on('data', (c) => res.write(c));
  proc.stderr.on('data', (c) => res.write(c));
  proc.on('error', (err) => {
    if (err.code === 'ENOENT') {
      res.write(`ERROR: ${settings.composeBin} not found.\n`);
    } else {
      res.write(`ERROR: ${err.message}\n`);
    }
    res.end();
  });
  proc.on('close', (code) => {
    res.write(`\n[exit ${code}]\n`);
    res.end();
  });
  res.on('close', () => {
    try {
      proc.kill('SIGTERM');
    } catch {}
  });
}

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    validateName(b.name);
    await ensureRoot(true);
    if (isManaged(b.name)) {
      throw new HttpError(409, `Stack '${b.name}' already exists`);
    }
    if (!b.compose) throw new HttpError(400, 'compose body is required');
    await writeStackFiles(b.name, b.compose, b.env || null);
    if (b.deploy === false) {
      return res.json({ name: b.name, deployed: false });
    }
    streamCompose(res, b.name, 'up', '-d');
  }),
);

router.put(
  '/:name',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!isManaged(req.params.name))
      throw new HttpError(404, 'Stack not found (or not managed)');
    const b = req.body || {};
    const target = stackDir(req.params.name);
    if (b.compose != null) {
      await fs.writeFile(path.join(target, COMPOSE_FILENAME), b.compose);
    }
    if (b.env != null) {
      await fs.writeFile(path.join(target, ENV_FILENAME), b.env);
    }
    res.json({ name: req.params.name, updated: true });
  }),
);

router.post('/:name/up', requireAdmin, (req, res) =>
  streamCompose(res, req.params.name, 'up', '-d', '--remove-orphans'),
);
router.post('/:name/down', requireAdmin, (req, res) => {
  const args = ['down', '--remove-orphans'];
  if (req.query.volumes === 'true' || req.query.volumes === '1') args.push('-v');
  streamCompose(res, req.params.name, ...args);
});
router.post('/:name/restart', requireAdmin, (req, res) =>
  streamCompose(res, req.params.name, 'restart'),
);
router.post('/:name/pull', requireAdmin, (req, res) =>
  streamCompose(res, req.params.name, 'pull'),
);
router.get('/:name/logs', (req, res) => {
  const tail = intQuery(req.query.tail, 200, { min: 1, max: 5000 });
  streamCompose(
    res,
    req.params.name,
    'logs',
    '--no-color',
    '--tail',
    String(tail),
  );
});

router.post(
  '/:name/validate',
  asyncHandler(async (req, res) => {
    let argv, cwd;
    try {
      ({ argv, cwd } = composeArgv(req.params.name, 'config', '-q'));
    } catch (err) {
      if (err instanceof HttpError)
        return res.status(err.status).json({ detail: err.detail });
      throw err;
    }
    const proc = spawn(settings.composeBin, argv, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    proc.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    const code = await new Promise((resolve, reject) => {
      proc.on('close', resolve);
      proc.on('error', reject);
    });
    res.json({ ok: code === 0, stdout, stderr });
  }),
);

router.post('/:name/services/:service/:action', requireAdmin, (req, res) => {
  const { action, service } = req.params;
  if (!SERVICE_ACTIONS.has(action)) {
    return res.status(400).json({ detail: `Unknown service action '${action}'` });
  }
  if (!service || service.includes('/') || service.startsWith('-')) {
    return res.status(400).json({ detail: 'Invalid service name' });
  }
  if (action === 'up') return streamCompose(res, req.params.name, 'up', '-d', service);
  if (action === 'rm') return streamCompose(res, req.params.name, 'rm', '-sf', service);
  streamCompose(res, req.params.name, action, service);
});

router.get('/:name/services/:service/logs', (req, res) => {
  const { service } = req.params;
  if (!service || service.includes('/') || service.startsWith('-')) {
    return res.status(400).json({ detail: 'Invalid service name' });
  }
  const tail = intQuery(req.query.tail, 200, { min: 1, max: 5000 });
  streamCompose(
    res,
    req.params.name,
    'logs',
    '--no-color',
    '--tail',
    String(tail),
    service,
  );
});

router.delete(
  '/:name',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!isManaged(req.params.name))
      throw new HttpError(404, 'Stack not found (or not managed)');
    const target = stackDir(req.params.name);
    try {
      const { argv, cwd } = composeArgv(
        req.params.name,
        'down',
        '--remove-orphans',
      );
      await new Promise((resolve) => {
        const p = spawn(settings.composeBin, argv, { cwd });
        p.on('close', resolve);
        p.on('error', resolve);
        setTimeout(() => {
          try {
            p.kill('SIGTERM');
          } catch {}
          resolve();
        }, 300_000);
      });
    } catch {
      /* best-effort */
    }
    await fs.rm(target, { recursive: true, force: true });
    res.json({ removed: req.params.name });
  }),
);

export default router;
