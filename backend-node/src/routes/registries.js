// Per-registry credential store backed by a JSON file (mode 0600).
import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import { settings } from '../config.js';
import { getClient } from '../docker-client.js';
import { asyncHandler, HttpError } from '../util.js';
import { createApiRouter } from '../route-builder.js';
import {
  PassThroughObject,
  RegistryPublic,
  RegistryRequest,
  RegistryUpdateRequest,
} from '../schemas/index.js';

const r = createApiRouter('/api/registries', { tag: 'registries' });

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
    return {};
  }
}
async function save(creds) {
  const file = settings.registriesFile;
  const dir = path.dirname(file);
  try { await fs.mkdir(dir, { recursive: true }); }
  catch (err) { throw new HttpError(500, `Cannot create directory for registries file: ${err.message}`); }
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ registries: creds }, null, 2));
  try { await fs.chmod(tmp, 0o600); } catch {}
  await fs.rename(tmp, file);
}

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

const NameParam = Type.Object({ name: Type.String() }, { additionalProperties: false });

r.get(
  '/',
  {
    summary: 'List stored registry credentials',
    responses: { 200: Type.Array(RegistryPublic) },
  },
  asyncHandler(async (_req, res) => {
    const creds = await load();
    const out = Object.entries(creds)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rec]) => ({ name, url: rec.url || '', username: rec.username || '', email: rec.email || null }));
    res.json(out);
  }),
);

r.post(
  '/',
  {
    summary: 'Add or replace a registry credential set',
    admin: true,
    destructive: true,
    body: RegistryRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const b = req.body;
    await withLock(async () => {
      const creds = await load();
      creds[b.name] = { url: b.url || 'https://index.docker.io/v1/', username: b.username, password: b.password, email: b.email || null };
      await save(creds);
    });
    res.json({ name: b.name, saved: true });
  }),
);

r.put(
  '/:name',
  {
    summary: 'Add or replace by path (name comes from URL)',
    admin: true,
    destructive: true,
    params: NameParam,
    body: RegistryUpdateRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const name = req.params.name;
    const b = { ...req.body, name };
    if (!name) throw new HttpError(400, 'name is required');
    if (!b.username || !b.password) throw new HttpError(400, 'username and password are required');
    await withLock(async () => {
      const creds = await load();
      creds[name] = { url: b.url || 'https://index.docker.io/v1/', username: b.username, password: b.password, email: b.email || null };
      await save(creds);
    });
    res.json({ name, saved: true });
  }),
);

r.delete(
  '/:name',
  {
    summary: 'Delete a registry credential set',
    admin: true,
    destructive: true,
    params: NameParam,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    await withLock(async () => {
      const creds = await load();
      if (!creds[req.params.name]) throw new HttpError(404, 'Registry not found');
      delete creds[req.params.name];
      await save(creds);
    });
    res.json({ removed: req.params.name });
  }),
);

r.post(
  '/:name/test',
  {
    summary: 'Test login against the saved credentials',
    admin: true,
    destructive: true,
    params: NameParam,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const creds = await load();
    const rec = creds[req.params.name];
    if (!rec) throw new HttpError(404, 'Registry not found');
    const docker = getClient();
    const result = await new Promise((resolve, reject) => {
      docker.modem.dial(
        {
          path: '/auth', method: 'POST',
          options: { username: rec.username, password: rec.password, email: rec.email || undefined, serveraddress: rec.url || undefined },
          statusCodes: { 200: true, 500: 'server error' },
        },
        (err, data) => (err ? reject(err) : resolve(data)),
      );
    });
    res.json({ ok: true, result });
  }),
);

export default r;
