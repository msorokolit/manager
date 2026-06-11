// Integration tests for the bulk-action endpoints introduced across
// containers / images / stacks / registries. dockerode is mocked so the
// tests focus on:
//
//   - per-item ok/error reporting (succeeded/failed split)
//   - daemon-error → HTTP-status remapping (404 → "Not found",
//     409 → friendly conflict message, 304 → success for verbs where
//     "already in target state" is the user's intent)
//   - role gating (viewer 403; unauth 401)
//   - schema enforcement (empty / oversized arrays rejected at 400)
//   - body-level options pass through (force, volumes, timeout)
//
// Stacks have a separate mock surface because they shell out to
// docker-compose rather than dockerode; we stub spawn directly.

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

// ES module imports are hoisted to the top of the file before any
// top-level code runs — so a plain `process.env.X = …` below would
// execute AFTER jwt.js → config.js has already frozen `settings`.
// vi.hoisted() runs its callback before any imports, which lets us
// configure the env vars our config module reads at import time.
// (paths are computed manually since node:os/path aren't yet imported.)
const { REG_TMP_FILE, STACKS_TMP_DIR } = vi.hoisted(() => {
  const tmpdir = process.env.TMPDIR || process.env.TMP || '/tmp';
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const reg = `${tmpdir.replace(/\/$/, '')}/regbulk-${suffix}.json`;
  const stk = `${tmpdir.replace(/\/$/, '')}/stacks-${suffix}`;
  process.env.REGISTRIES_FILE = reg;
  process.env.STACKS_DIR = stk;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-bulk-routes';
  return { REG_TMP_FILE: reg, STACKS_TMP_DIR: stk };
});

import { signToken } from '../src/jwt.js';
import { withRole, resetSessions } from './helpers/auth-helper.js';

// ---------- Shared fake docker daemon ----------

const fakeContainers = new Map();    // id -> { State }
const fakeImages = new Map();        // id -> {}
const containerActionMock = vi.fn(); // (id, verb, args) -> '404'|'409'|'304'|null|throw
const containerRemoveMock = vi.fn(); // (id, opts) -> '404'|'409'|null
const imageRemoveMock = vi.fn();     // (id, opts) -> '404'|'409'|null

vi.mock('../src/docker-client.js', () => {
  const client = {
    listContainers: async () => [],
    listImages: async () => [],
    listVolumes: async () => ({ Volumes: [] }),
    listNetworks: async () => [],
    df: async () => ({ Volumes: [] }),
    getContainer(id) {
      const verbWrap = (verb) => async (args) => {
        const r = containerActionMock(id, verb, args);
        if (!fakeContainers.has(id)) { const e = new Error('not found'); e.statusCode = 404; throw e; }
        if (r === '404') { const e = new Error('not found'); e.statusCode = 404; throw e; }
        if (r === '409') { const e = new Error('container is paused'); e.statusCode = 409; throw e; }
        if (r === '304') { const e = new Error('not modified'); e.statusCode = 304; throw e; }
        if (r === 'throw') { throw new Error('boom'); }
        return {};
      };
      return {
        start: verbWrap('start'),
        stop: verbWrap('stop'),
        restart: verbWrap('restart'),
        pause: verbWrap('pause'),
        unpause: verbWrap('unpause'),
        kill: verbWrap('kill'),
        remove: async (opts) => {
          const r = containerRemoveMock(id, opts);
          if (!fakeContainers.has(id)) { const e = new Error('not found'); e.statusCode = 404; throw e; }
          if (r === '404') { const e = new Error('not found'); e.statusCode = 404; throw e; }
          if (r === '409') { const e = new Error('cannot remove a running container'); e.statusCode = 409; throw e; }
          fakeContainers.delete(id);
          return {};
        },
      };
    },
    getImage(id) {
      return {
        remove: async (opts) => {
          const r = imageRemoveMock(id, opts);
          if (!fakeImages.has(id)) { const e = new Error('not found'); e.statusCode = 404; throw e; }
          if (r === '404') { const e = new Error('not found'); e.statusCode = 404; throw e; }
          if (r === '409') { const e = new Error('image is being used'); e.statusCode = 409; throw e; }
          fakeImages.delete(id);
          return {};
        },
      };
    },
  };
  return {
    getClient: () => client,
    dockerError: (e) => ({ status: e.statusCode || 500, detail: e.message || 'docker error' }),
  };
});

// ---------- Stub child_process.spawn so the stacks tests don't shell out ----
//
// runCompose() in routes/stacks.js calls spawn() to execute docker-
// compose. We replace it with a fake EventEmitter-like object that
// emits one stdout chunk and one close event with our chosen exit
// code, keyed off the stack name in argv (`-p <name>`).
const stackExits = new Map(); // name -> 0 | 1 (default 0)
const spawnMock = vi.fn((bin, argv) => {
  const dashP = argv.indexOf('-p');
  const stackName = dashP >= 0 ? argv[dashP + 1] : '';
  const exit = stackExits.get(stackName) ?? 0;

  const proc = {
    stdout: {
      _cbs: [],
      on(ev, cb) { if (ev === 'data') this._cbs.push(cb); return this; },
    },
    stderr: {
      _cbs: [],
      on(ev, cb) { if (ev === 'data') this._cbs.push(cb); return this; },
    },
    _close: null,
    _error: null,
    on(ev, cb) {
      if (ev === 'close') this._close = cb;
      if (ev === 'error') this._error = cb;
      return this;
    },
    kill() {},
  };
  setImmediate(() => {
    proc.stdout._cbs.forEach((cb) => cb(Buffer.from(`compose ${argv.join(' ')}\n`)));
    if (exit !== 0) {
      proc.stderr._cbs.forEach((cb) => cb(Buffer.from('compose failed reason\n')));
    }
    proc._close && proc._close(exit, null);
  });
  return proc;
});
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

// ---------- Import routers AFTER mocks ----------
const { default: containersApi } = await import('../src/routes/containers.js');
const { default: imagesApi } = await import('../src/routes/images.js');
const { default: registriesApi } = await import('../src/routes/registries.js');
const { default: stacksApi } = await import('../src/routes/stacks.js');
const { sendError } = await import('../src/util.js');

function buildApp(...routers) {
  const app = express();
  app.use(express.json());
  for (const r of routers) app.use(r.basePath, r.router);
  app.use((err, _req, res, _next) => sendError(res, err));
  return app;
}

beforeEach(() => {
  resetSessions();
  fakeContainers.clear();
  fakeImages.clear();
  containerActionMock.mockReset(); containerActionMock.mockReturnValue(null);
  containerRemoveMock.mockReset(); containerRemoveMock.mockReturnValue(null);
  imageRemoveMock.mockReset(); imageRemoveMock.mockReturnValue(null);
});

// ============================================================
// Containers
// ============================================================

describe('POST /api/containers/:verb/bulk', () => {
  const verbs = ['start', 'restart', 'pause', 'unpause', 'kill'];

  for (const verb of verbs) {
    it(`${verb} bulk: per-item ok/error rollup`, async () => {
      fakeContainers.set('c1', {});
      fakeContainers.set('c2', {});
      // c1 succeeds, c2 returns 304 (already-in-state, treated as ok),
      // c3 doesn't exist → 404 error.
      containerActionMock.mockImplementation((id) => id === 'c2' ? '304' : null);

      const r = await request(buildApp(containersApi))
        .post(`/api/containers/${verb}/bulk`)
        .set('Authorization', withRole('admin'))
        .send({ ids: ['c1', 'c2', 'c3'] });

      expect(r.status).toBe(200);
      expect(r.body.succeeded).toBe(2); // c1 ok + c2 (304 = already)
      expect(r.body.failed).toBe(1);
      const byId = Object.fromEntries(r.body.results.map((x) => [x.id, x]));
      expect(byId.c1.ok).toBe(true);
      expect(byId.c2.ok).toBe(true);
      expect(byId.c3).toMatchObject({ ok: false, error: 'Not found' });
    });

    it(`${verb} bulk: 403 for viewer JWT`, async () => {
      const r = await request(buildApp(containersApi))
        .post(`/api/containers/${verb}/bulk`)
        .set('Authorization', withRole('viewer'))
        .send({ ids: ['c1'] });
      expect(r.status).toBe(403);
    });
  }

  it('stop bulk: passes timeout through; schema default kicks in when omitted', async () => {
    fakeContainers.set('c1', {}); fakeContainers.set('c2', {});
    await request(buildApp(containersApi))
      .post('/api/containers/stop/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: ['c1', 'c2'], timeout: 5 });
    expect(containerActionMock).toHaveBeenCalledWith('c1', 'stop', { t: 5 });
    expect(containerActionMock).toHaveBeenCalledWith('c2', 'stop', { t: 5 });

    containerActionMock.mockReset();
    fakeContainers.set('c1', {});
    await request(buildApp(containersApi))
      .post('/api/containers/stop/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: ['c1'] });
    // Schema declares `default: 10`, so AJV fills it in — that's
    // intentional (the daemon default of 10s is the sensible answer
    // for an operator who didn't think about it).
    expect(containerActionMock).toHaveBeenCalledWith('c1', 'stop', { t: 10 });
  });

  it('start bulk: friendly conflict from daemon 409 is surfaced per-row', async () => {
    fakeContainers.set('c1', {});
    containerActionMock.mockReturnValue('409');
    const r = await request(buildApp(containersApi))
      .post('/api/containers/start/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: ['c1'] });
    expect(r.body.results[0]).toMatchObject({
      id: 'c1', ok: false,
      error: expect.stringMatching(/paused/i),
    });
  });

  it('schema rejects empty / oversized ids[]', async () => {
    const empty = await request(buildApp(containersApi))
      .post('/api/containers/start/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: [] });
    expect(empty.status).toBe(400);
    const big = await request(buildApp(containersApi))
      .post('/api/containers/start/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: Array(501).fill('x') });
    expect(big.status).toBe(400);
  });
});

describe('POST /api/containers/remove/bulk', () => {
  it('passes force + volumes through', async () => {
    fakeContainers.set('c1', {}); fakeContainers.set('c2', {});
    await request(buildApp(containersApi))
      .post('/api/containers/remove/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: ['c1', 'c2'], force: true, volumes: true });
    expect(containerRemoveMock).toHaveBeenCalledWith('c1', { force: true, v: true });
    expect(containerRemoveMock).toHaveBeenCalledWith('c2', { force: true, v: true });
  });

  it('surfaces 409 with the "pass force:true" hint per-row', async () => {
    fakeContainers.set('running', {});
    containerRemoveMock.mockReturnValue('409');
    const r = await request(buildApp(containersApi))
      .post('/api/containers/remove/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: ['running'] });
    expect(r.body.results[0]).toMatchObject({
      id: 'running', ok: false,
      error: expect.stringMatching(/force:true/),
    });
  });

  it('404 per-row when container missing', async () => {
    const r = await request(buildApp(containersApi))
      .post('/api/containers/remove/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: ['ghost'] });
    expect(r.body.results[0]).toMatchObject({ id: 'ghost', ok: false, error: 'Not found' });
  });
});

// ============================================================
// Images
// ============================================================

describe('POST /api/images/remove/bulk', () => {
  it('passes force + noprune through', async () => {
    fakeImages.set('img1', {}); fakeImages.set('img2', {});
    await request(buildApp(imagesApi))
      .post('/api/images/remove/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: ['img1', 'img2'], force: true, noprune: true });
    expect(imageRemoveMock).toHaveBeenCalledWith('img1', { force: true, noprune: true });
    expect(imageRemoveMock).toHaveBeenCalledWith('img2', { force: true, noprune: true });
  });

  it('per-row 409 surfaces the "in use" hint', async () => {
    fakeImages.set('img1', {});
    imageRemoveMock.mockReturnValue('409');
    const r = await request(buildApp(imagesApi))
      .post('/api/images/remove/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: ['img1'] });
    expect(r.body.results[0].error).toMatch(/force:true/);
  });

  it('rejects viewer JWT', async () => {
    const r = await request(buildApp(imagesApi))
      .post('/api/images/remove/bulk')
      .set('Authorization', withRole('viewer'))
      .send({ ids: ['img1'] });
    expect(r.status).toBe(403);
  });

  it('rejects unauthenticated', async () => {
    const r = await request(buildApp(imagesApi))
      .post('/api/images/remove/bulk')
      .send({ ids: ['img1'] });
    expect(r.status).toBe(401);
  });
});

// ============================================================
// Registries — file-backed, no docker daemon involved
// ============================================================

describe('POST /api/registries/delete/bulk', () => {
  // Reset the registries file to a known shape before each test.
  // settings.registriesFile points at REG_TMP_FILE (set at the top of
  // this file, before config.js loaded).
  beforeEach(async () => {
    await fs.writeFile(REG_TMP_FILE, JSON.stringify({
      registries: {
        a: { url: 'https://a', username: 'u', password: 'p' },
        b: { url: 'https://b', username: 'u', password: 'p' },
        c: { url: 'https://c', username: 'u', password: 'p' },
      },
    }));
  });

  afterAll(async () => { await fs.unlink(REG_TMP_FILE).catch(() => {}); });

  it('removes existing names, reports per-item failure for missing ones', async () => {
    const r = await request(buildApp(registriesApi))
      .post('/api/registries/delete/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: ['a', 'b', 'ghost'] });
    expect(r.status).toBe(200);
    expect(r.body.succeeded).toBe(2);
    expect(r.body.failed).toBe(1);
    const m = Object.fromEntries(r.body.results.map((x) => [x.name, x]));
    expect(m.a.ok).toBe(true);
    expect(m.b.ok).toBe(true);
    expect(m.ghost).toMatchObject({ ok: false, error: 'Not found' });

    // File should reflect the removal.
    const after = JSON.parse(await fs.readFile(REG_TMP_FILE, 'utf8'));
    expect(Object.keys(after.registries)).toEqual(['c']);
  });

  it('does not rewrite the file when every name was unknown', async () => {
    const beforeStat = await fs.stat(REG_TMP_FILE);
    await new Promise((r) => setTimeout(r, 20)); // ensure stat resolution gap
    const r = await request(buildApp(registriesApi))
      .post('/api/registries/delete/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: ['ghost-x', 'ghost-y'] });
    expect(r.body.failed).toBe(2);
    const afterStat = await fs.stat(REG_TMP_FILE);
    // No save() should have happened — mtime is unchanged.
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('rejects viewer JWT', async () => {
    const r = await request(buildApp(registriesApi))
      .post('/api/registries/delete/bulk')
      .set('Authorization', withRole('viewer'))
      .send({ names: ['a'] });
    expect(r.status).toBe(403);
  });
});

// ============================================================
// Stacks — compose CLI is stubbed via the spawnMock above
// ============================================================

describe('Stacks bulk endpoints', () => {
  beforeAll(async () => { await fs.mkdir(STACKS_TMP_DIR, { recursive: true }); });
  afterAll(async () => { await fs.rm(STACKS_TMP_DIR, { recursive: true, force: true }); });

  beforeEach(async () => {
    stackExits.clear();
    spawnMock.mockClear();
    // Wipe any stack dirs left from the previous test.
    for (const entry of await fs.readdir(STACKS_TMP_DIR).catch(() => [])) {
      await fs.rm(path.join(STACKS_TMP_DIR, entry), { recursive: true, force: true });
    }
  });

  function makeManagedStack(name) {
    const dir = path.join(STACKS_TMP_DIR, name);
    return fs.mkdir(dir, { recursive: true }).then(() =>
      fs.writeFile(path.join(dir, 'docker-compose.yml'),
        'services:\n  app:\n    image: nginx:alpine\n'));
  }

  it('up/bulk: per-stack results when one compose run fails', async () => {
    await makeManagedStack('s1');
    await makeManagedStack('s2');
    stackExits.set('s1', 0);
    stackExits.set('s2', 1);
    const r = await request(buildApp(stacksApi))
      .post('/api/stacks/up/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: ['s1', 's2'] });
    expect(r.status).toBe(200);
    expect(r.body.succeeded).toBe(1);
    expect(r.body.failed).toBe(1);
    const m = Object.fromEntries(r.body.results.map((x) => [x.name, x]));
    expect(m.s1.ok).toBe(true);
    expect(m.s2).toMatchObject({ ok: false, error: expect.stringMatching(/compose failed/i) });
  });

  it('down/bulk: includes -v when volumes:true', async () => {
    await makeManagedStack('s1');
    await request(buildApp(stacksApi))
      .post('/api/stacks/down/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: ['s1'], volumes: true });
    const composeCall = spawnMock.mock.calls.find((c) => c[1].includes('down'));
    expect(composeCall[1]).toContain('-v');
  });

  it('down/bulk: omits -v when volumes is falsy', async () => {
    await makeManagedStack('s1');
    await request(buildApp(stacksApi))
      .post('/api/stacks/down/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: ['s1'] });
    const composeCall = spawnMock.mock.calls.find((c) => c[1].includes('down'));
    expect(composeCall[1]).not.toContain('-v');
  });

  it('remove/bulk: tears down + deletes files; reports failure when compose down errors but still wipes files', async () => {
    await makeManagedStack('s1');
    stackExits.set('s1', 1); // compose down fails
    const dir = path.join(STACKS_TMP_DIR, 's1');
    const before = await fs.stat(dir).then(() => true, () => false);
    expect(before).toBe(true);

    const r = await request(buildApp(stacksApi))
      .post('/api/stacks/remove/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: ['s1'] });

    // Files gone regardless of compose outcome (matches single-stack DELETE)
    const after = await fs.stat(dir).then(() => true, () => false);
    expect(after).toBe(false);
    // But the result row reports the compose-down failure.
    expect(r.body.failed).toBe(1);
    expect(r.body.results[0].error).toMatch(/files removed/);
  });

  it('reports "Not found" for names that aren\'t managed', async () => {
    const r = await request(buildApp(stacksApi))
      .post('/api/stacks/up/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: ['ghost-stack'] });
    expect(r.body.failed).toBe(1);
    expect(r.body.results[0].error).toMatch(/not managed|not found/i);
  });

  it('rejects invalid stack names with a per-row error (no fs touch)', async () => {
    const r = await request(buildApp(stacksApi))
      .post('/api/stacks/up/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: ['has/slash'] });
    expect(r.body.results[0].error).toMatch(/invalid stack name/);
  });

  it('viewer JWT 403 across all bulk endpoints', async () => {
    for (const verb of ['up', 'down', 'restart', 'remove']) {
      const r = await request(buildApp(stacksApi))
        .post(`/api/stacks/${verb}/bulk`)
        .set('Authorization', withRole('viewer'))
        .send({ names: ['s1'] });
      expect(r.status).toBe(403);
    }
  });
});
