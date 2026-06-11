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

// Mock the filesystem APIs the /dev scanner uses. By default every
// existsSync() returns false (no devices on the synthetic host); the
// 'detects all host_device categories' test overrides this with a
// curated /dev tree.
let fakeFs = { exists: () => false, dirs: {} };
vi.mock('node:fs', async () => {
  const real = await vi.importActual('node:fs');
  return {
    ...real,
    existsSync: (p) => !!fakeFs.exists(p),
  };
});
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises');
  const fakeReaddir = async (p, opts) => {
    const entries = fakeFs.dirs[p];
    if (!entries) {
      const err = new Error(`ENOENT: ${p}`); err.code = 'ENOENT';
      throw err;
    }
    if (opts && opts.withFileTypes) {
      return entries.map((e) => ({
        name: typeof e === 'string' ? e : e.name,
        isDirectory: () => typeof e !== 'string' && !!e.dir,
      }));
    }
    return entries.map((e) => typeof e === 'string' ? e : e.name);
  };
  // routes/system.js does `import fs from 'node:fs/promises'`, so the
  // default export is what callers reach for. Override readdir on
  // BOTH the namespace and the default to cover named + default
  // import styles.
  return {
    ...real,
    default: { ...real.default, readdir: fakeReaddir },
    readdir: fakeReaddir,
  };
});

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
  fakeFs = { exists: () => false, dirs: {} };
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

  // ---------- host_devices (categorised /dev scan) ----------

  it('host_devices: every category appears with available:false when /dev is empty', async () => {
    dockerInfoResponse = { Runtimes: { runc: {} }, DefaultRuntime: 'runc' };
    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    expect(r.status).toBe(200);
    // Sanity: every documented kind appears, sorted by the order in
    // DEVICE_CATEGORIES. Hidden categories would mean the operator
    // can't discover features that are POSSIBLE but require host
    // changes (e.g. enabling TPM pass-through).
    const kinds = r.body.host_devices.map((g) => g.kind);
    expect(kinds).toEqual([
      'gpu_amd', 'audio', 'usb', 'serial', 'video',
      'tpu', 'tpm', 'watchdog',
    ]);
    for (const g of r.body.host_devices) {
      expect(g.available).toBe(false);
      expect(g.devices).toEqual([]);
      expect(g.hint).toBeTruthy(); // every category surfaces its hint
    }
  });

  it('host_devices: detects AMD ROCm (gpu_amd), serial (ttyUSB*), V4L (video*), TPM, watchdog', async () => {
    dockerInfoResponse = { Runtimes: { runc: {} }, DefaultRuntime: 'runc' };
    fakeFs = {
      exists: (p) => p === '/dev/kfd' || p === '/dev',
      dirs: {
        '/dev': [
          'kfd', 'ttyUSB0', 'ttyUSB1', 'ttyACM0', 'video0', 'video1',
          'tpm0', 'tpmrm0', 'watchdog0',
        ],
      },
    };
    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    const byKind = Object.fromEntries(r.body.host_devices.map((g) => [g.kind, g]));

    expect(byKind.gpu_amd).toMatchObject({ available: true, devices: ['/dev/kfd'] });
    expect(byKind.serial.available).toBe(true);
    expect(byKind.serial.devices.sort()).toEqual([
      '/dev/ttyACM0', '/dev/ttyUSB0', '/dev/ttyUSB1',
    ]);
    expect(byKind.video).toMatchObject({
      available: true,
      devices: ['/dev/video0', '/dev/video1'],
    });
    expect(byKind.tpm.available).toBe(true);
    expect(byKind.tpm.devices.sort()).toEqual(['/dev/tpm0', '/dev/tpmrm0']);
    expect(byKind.watchdog).toMatchObject({
      available: true, devices: ['/dev/watchdog0'],
    });
    // Categories with no matching files stay false.
    expect(byKind.audio.available).toBe(false);
    expect(byKind.usb.available).toBe(false);
    expect(byKind.tpu.available).toBe(false);
  });

  it('host_devices: walks /dev/bus/usb/<bus>/<dev> one level deep (recursive dir pattern)', async () => {
    dockerInfoResponse = { Runtimes: { runc: {} }, DefaultRuntime: 'runc' };
    fakeFs = {
      exists: (p) => p === '/dev/bus/usb',
      dirs: {
        '/dev/bus/usb': [{ name: '001', dir: true }, { name: '002', dir: true }],
        '/dev/bus/usb/001': ['001', '002'],
        '/dev/bus/usb/002': ['001'],
      },
    };
    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    const usb = r.body.host_devices.find((g) => g.kind === 'usb');
    expect(usb.available).toBe(true);
    expect(usb.devices.sort()).toEqual([
      '/dev/bus/usb/001/001', '/dev/bus/usb/001/002', '/dev/bus/usb/002/001',
    ]);
  });

  it('host_devices: detects ML accelerators (Coral apex_*, Hailo hailo*, generic accel*)', async () => {
    dockerInfoResponse = { Runtimes: { runc: {} }, DefaultRuntime: 'runc' };
    fakeFs = {
      exists: (p) => p === '/dev',
      dirs: {
        '/dev': ['apex_0', 'hailo0', 'accel0', 'accel1'],
      },
    };
    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    const tpu = r.body.host_devices.find((g) => g.kind === 'tpu');
    expect(tpu.available).toBe(true);
    expect(tpu.devices.sort()).toEqual([
      '/dev/accel0', '/dev/accel1', '/dev/apex_0', '/dev/hailo0',
    ]);
  });

  it('host_devices: dir kind (audio) discovers /dev/snd entries', async () => {
    dockerInfoResponse = { Runtimes: { runc: {} }, DefaultRuntime: 'runc' };
    fakeFs = {
      exists: (p) => p === '/dev/snd',
      dirs: {
        '/dev/snd': [
          'controlC0', 'pcmC0D0p', 'pcmC0D0c', 'seq', 'timer',
          { name: 'by-id', dir: true },
        ],
        '/dev/snd/by-id': ['usb-Some-DAC'],
      },
    };
    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    const audio = r.body.host_devices.find((g) => g.kind === 'audio');
    expect(audio.available).toBe(true);
    // The recursive dir pattern picks up both top-level entries AND
    // one level of subdirectory contents (by-id symlinks).
    expect(audio.devices).toContain('/dev/snd/controlC0');
    expect(audio.devices).toContain('/dev/snd/pcmC0D0p');
    expect(audio.devices).toContain('/dev/snd/by-id/usb-Some-DAC');
  });

  it('host_devices: unreadable directories are skipped silently (no 500)', async () => {
    dockerInfoResponse = { Runtimes: { runc: {} }, DefaultRuntime: 'runc' };
    // /dev/bus/usb appears to exist but readdir throws → scanner
    // should swallow + return [] for that pattern.
    fakeFs = {
      exists: (p) => p === '/dev/bus/usb',
      dirs: { /* no '/dev/bus/usb' key → readdir throws ENOENT */ },
    };
    const r = await request(buildApp())
      .get('/api/system/devices')
      .set('Authorization', withRole('admin'));
    expect(r.status).toBe(200);
    const usb = r.body.host_devices.find((g) => g.kind === 'usb');
    expect(usb.available).toBe(false);
    expect(usb.devices).toEqual([]);
  });
});
