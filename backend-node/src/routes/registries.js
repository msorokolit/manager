// Per-registry credential store backed by a JSON file (mode 0600).
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authenticate, requireAdmin } from '../auth.js';
import { settings } from '../config.js';
import { getClient } from '../docker-client.js';
import { asyncHandler, HttpError } from '../util.js';

const router = Router();
router.use(authenticate);

let writeLock = Promise.resolve();
function withLock(fn) {
  const next = writeLock.then(fn, fn);
  writeLock = next.catch(() => {});
  return next;
}

async function load() {
  try {
    const raw = await fs.readFile(settings.registriesFile, 'utf8');
    const data = JSON.parse(raw);
    return (data && data.registries) || {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    if (err instanceof SyntaxError) return {};
    return {};
  }
}

async function save(creds) {
  const file = settings.registriesFile;
  const dir = path.dirname(file);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    throw new HttpError(
      500,
      `Cannot create directory for registries file: ${err.message}`,
    );
  }
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ registries: creds }, null, 2));
  try {
    await fs.chmod(tmp, 0o600);
  } catch {
    /* ignore */
  }
  await fs.rename(tmp, file);
}

/**
 * Used by routes/images.js to resolve a stored registry name into a
 * dockerode auth_config object.
 */
export async function getRegistryAuth(name) {
  if (!name) return null;
  const creds = await load();
  const rec = creds[name];
  if (!rec) return null;
  const out = { username: rec.username, password: rec.password };
  if (rec.email) out.email = rec.email;
  if (rec.url) out.serveraddress = rec.url;
  return out;
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const creds = await load();
    const out = Object.entries(creds)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rec]) => ({
        name,
        url: rec.url || '',
        username: rec.username || '',
        email: rec.email || null,
      }));
    res.json(out);
  }),
);

function validatePayload(body) {
  if (!body || !body.name) throw new HttpError(400, 'name is required');
  if (!body.username) throw new HttpError(400, 'username is required');
  if (!body.password) throw new HttpError(400, 'password is required');
}

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    validatePayload(req.body);
    const b = req.body;
    await withLock(async () => {
      const creds = await load();
      creds[b.name] = {
        url: b.url || 'https://index.docker.io/v1/',
        username: b.username,
        password: b.password,
        email: b.email || null,
      };
      await save(creds);
    });
    res.json({ name: b.name, saved: true });
  }),
);

router.put(
  '/:name',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = { ...(req.body || {}), name: req.params.name };
    validatePayload(b);
    await withLock(async () => {
      const creds = await load();
      creds[b.name] = {
        url: b.url || 'https://index.docker.io/v1/',
        username: b.username,
        password: b.password,
        email: b.email || null,
      };
      await save(creds);
    });
    res.json({ name: b.name, saved: true });
  }),
);

router.delete(
  '/:name',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await withLock(async () => {
      const creds = await load();
      if (!creds[req.params.name])
        throw new HttpError(404, 'Registry not found');
      delete creds[req.params.name];
      await save(creds);
    });
    res.json({ removed: req.params.name });
  }),
);

router.post(
  '/:name/test',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const creds = await load();
    const rec = creds[req.params.name];
    if (!rec) throw new HttpError(404, 'Registry not found');
    const docker = getClient();
    // dockerode exposes a low-level checkAuth via the modem's POST /auth
    const result = await new Promise((resolve, reject) => {
      docker.modem.dial(
        {
          path: '/auth',
          method: 'POST',
          options: {
            username: rec.username,
            password: rec.password,
            email: rec.email || undefined,
            serveraddress: rec.url || undefined,
          },
          statusCodes: { 200: true, 500: 'server error' },
        },
        (err, data) => (err ? reject(err) : resolve(data)),
      );
    });
    res.json({ ok: true, result });
  }),
);

export default router;
