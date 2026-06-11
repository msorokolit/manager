// GET /api/system/devices — accelerator + device discovery.
//
// Two layers under test:
//
//   1. The probe shape — runtimes parsed from `docker info`, nvidia
//      probe path, /dev/dri probe path. We mock both `dockerode.info`
//      and `child_process.spawn` so the test doesn't depend on the
//      manager actually having nvidia-smi installed.
//
//   2. The route — cache behaviour, response shape, no auth required
//      (it's read-only metadata about the host's hardware; same
//      protection as /api/system/info).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-devices';
  process.env.LOG_LEVEL = 'silent';
});

import { signToken } from '../src/jwt.js';
import { withRole, resetSessions } from './helpers/auth-helper.js';

// We rewrite the dockerode .info() return value per-test.
let dockerInfoResponse = null;

vi.mock('../src/docker-client.js', () => {
  const client = {
    info: async () => {
      if (dockerInfoResponse instanceof Error) throw dockerInfoResponse;
      return dockerInfoResponse;
    },
    listContainers: async () => [],
  };
  return {
    getClient: () => client,
    dockerError: (e) => ({ status: e.statusCode || 500, detail: e.message || 'docker error' }),
  };
});

// Mock child_process.spawn — used by the probe to invoke nvidia-smi.
// Each test sets `nvidiaSmiOutcome` to control the simulated process.
let nvidiaSmiOutcome = { code: 'ENOENT' };
vi.mock('node:child_process', () => ({
  spawn: (bin, _args) => {
    const proc = {
      stdout: { _cbs: [], on(ev, cb) { if (ev === 'data') this._cbs.push(cb); return this; } },
      stderr: { _cbs: [], on(ev, cb) { if (ev === 'data') this._cbs.push(cb); return this; } },
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
      if (bin === 'nvidia-smi') {
        if (nvidiaSmiOutcome.code === 'ENOENT') {
          // Simulate "binary not on PATH" — same shape Node uses
          // when execve fails.
          const err = new Error('spawn nvidia-smi ENOENT'); err.code = 'ENOENT';
          proc._error && proc._error(err);
          return;
        }
        if (nvidiaSmiOutcome.stdout) {
          proc.stdout._cbs.forEach((cb) => cb(Buffer.from(nvidiaSmiOutcome.stdout)));
        }
        if (nvidiaSmiOutcome.stderr) {
          proc.stderr._cbs.forEach((cb) => cb(Buffer.from(nvidiaSmiOutcome.stderr)));
        }
        proc._close && proc._close(nvidiaSmiOutcome.code ?? 0, null);
      } else {
        // Any other binary: pretend it's absent.
        const err = new Error(`spawn ${bin} ENOENT`); err.code = 'ENOENT';
        proc._error && proc._error(err);
      }
    });
    return proc;
  },
}));

const { default: systemApi, _internals: systemInternals } = await import('../src/routes/system.js');
const { sendError } = await import('../src/util.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(systemApi.basePath, systemApi.router);
  app.use((err, _req, res, _next) => sendError(res, err));
  return app;
}

beforeEach(() => {
  resetSessions();
  systemInternals.resetCacheForTests();
  dockerInfoResponse = null;
  nvidiaSmiOutcome = { code: 'ENOENT' };
});

describe('GET /api/system/devices', () => {
  it('returns runtimes pulled from docker info', async () => {
    dockerInfoResponse = {
      Runtimes: {
        runc: { path: '/usr/bin/runc' },
        nvidia: { path: '/usr/bin/nvidia-container-runtime' },
        'crun': { path: '/usr/bin/crun' },
      },
      DefaultRuntime: 'runc',
    };

    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    expect(r.status).toBe(200);
    expect(r.body.default_runtime).toBe('runc');
    // Sorted by name
    expect(r.body.runtimes.map((x) => x.name)).toEqual(['crun', 'nvidia', 'runc']);
    expect(r.body.runtimes.find((x) => x.name === 'nvidia').path).toBe('/usr/bin/nvidia-container-runtime');
    expect(r.body.gpu_runtime).toBe('nvidia');
  });

  it('falls back to nvidia-detection note when nvidia-smi is absent', async () => {
    dockerInfoResponse = { Runtimes: { runc: { path: '/usr/bin/runc' } }, DefaultRuntime: 'runc' };
    // nvidiaSmiOutcome stays at ENOENT
    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    expect(r.body.nvidia.available).toBe(false);
    expect(r.body.nvidia.note).toMatch(/nvidia-smi not installed/i);
    expect(r.body.nvidia.gpus).toBeUndefined();
  });

  it('parses GPUs from nvidia-smi CSV output', async () => {
    dockerInfoResponse = { Runtimes: { runc: { path: '/usr/bin/runc' }, nvidia: {} }, DefaultRuntime: 'runc' };
    nvidiaSmiOutcome = {
      code: 0,
      stdout:
        '0, GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa, NVIDIA RTX A4000, 16384, 535.183.01\n' +
        '1, GPU-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb, NVIDIA RTX A4000, 16384, 535.183.01\n',
    };
    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    expect(r.body.nvidia.available).toBe(true);
    expect(r.body.nvidia.gpus).toHaveLength(2);
    expect(r.body.nvidia.gpus[0]).toEqual({
      index: '0',
      uuid: 'GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      name: 'NVIDIA RTX A4000',
      memory_mb: 16384,
      driver_version: '535.183.01',
    });
  });

  it('treats nvidia-smi nonzero exit as "host may have no GPUs"', async () => {
    dockerInfoResponse = { Runtimes: { runc: {} }, DefaultRuntime: 'runc' };
    nvidiaSmiOutcome = { code: 9, stderr: 'No devices were found' };
    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    expect(r.body.nvidia.available).toBe(false);
    expect(r.body.nvidia.note).toMatch(/returned 9/);
  });

  it('caches results for 30s — repeated calls hit the same snapshot', async () => {
    dockerInfoResponse = { Runtimes: { runc: {} }, DefaultRuntime: 'runc' };
    const r1 = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    const t1 = r1.body.discovered_at;

    // Change the underlying source between calls — the cached
    // response should hide the change until the TTL expires.
    dockerInfoResponse = { Runtimes: { runc: {}, nvidia: {} }, DefaultRuntime: 'runc' };
    const r2 = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    expect(r2.body.discovered_at).toBe(t1);
    expect(r2.body.runtimes.map((x) => x.name)).toEqual(['runc']); // stale cache

    // Force a refresh.
    systemInternals.resetCacheForTests();
    const r3 = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    expect(r3.body.runtimes.map((x) => x.name)).toEqual(['nvidia', 'runc']);
  });

  it('still responds (with no runtimes) when docker info fails', async () => {
    dockerInfoResponse = Object.assign(new Error('socket closed'), { statusCode: 500 });
    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    expect(r.status).toBe(200);
    expect(r.body.runtimes).toEqual([]);
    expect(r.body.default_runtime).toBe('runc'); // sensible fallback
  });

  it('viewer can read /api/system/devices (no admin gate)', async () => {
    dockerInfoResponse = { Runtimes: { runc: {} }, DefaultRuntime: 'runc' };
    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
  });

  it('rejects unauthenticated requests', async () => {
    const r = await request(buildApp()).get('/api/system/devices');
    expect(r.status).toBe(401);
  });
});
