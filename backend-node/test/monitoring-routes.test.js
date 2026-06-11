// Integration tests for the new monitoring endpoints:
//   GET /api/containers/:id/top
//   GET /api/system/stats/summary
//
// Both wrap dockerode calls; we mock the docker client to control
// per-call outcomes and verify the route does the right plumbing
// (passthrough, ordering, caching, error mapping, role gating).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-monitoring';
  process.env.LOG_LEVEL = 'silent';
});

import { withRole, resetSessions } from './helpers/auth-helper.js';

// ---------- Per-test docker fake ----------
//
// listContainers, top(), stats() are all controlled by mock fns
// the individual tests set up via topMock.mockImplementationOnce
// etc. The fake also exposes a 'getContainer(id)' that returns
// per-container handles bound to those mocks.

const listContainersMock = vi.fn();
const topMock = vi.fn();
const statsMock = vi.fn();

vi.mock('../src/docker-client.js', () => {
  const client = {
    listContainers: (...args) => listContainersMock(...args),
    getContainer(id) {
      return {
        top: (opts) => topMock(id, opts),
        stats: (opts) => statsMock(id, opts),
      };
    },
  };
  return {
    getClient: () => client,
    dockerError: (e) => ({ status: e.statusCode || 500, detail: e.message || 'docker error' }),
  };
});

// Patch out the 1-second sample gap so summary tests stay fast.
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }));
// Override the system module's setTimeout via the global path too;
// the route uses `await new Promise((r) => setTimeout(r, ...))` so
// we'd otherwise wait 1s × N containers. Replace with immediate.
const realSetTimeout = global.setTimeout;
beforeEach(() => {
  global.setTimeout = (cb, ms) => {
    // Only short-circuit when called with an arrow callback (our
    // gap delay); vi.useFakeTimers would also work but is more
    // invasive.
    if (ms <= 1100 && typeof cb === 'function') {
      Promise.resolve().then(cb);
      return 0;
    }
    return realSetTimeout(cb, ms);
  };
});

const { default: containersApi } = await import('../src/routes/containers.js');
const { default: systemApi, _internals: sysInternals } = await import('../src/routes/system.js');
const { sendError } = await import('../src/util.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(containersApi.basePath, containersApi.router);
  app.use(systemApi.basePath, systemApi.router);
  app.use((err, _req, res, _next) => sendError(res, err));
  return app;
}

beforeEach(() => {
  resetSessions();
  listContainersMock.mockReset();
  topMock.mockReset();
  statsMock.mockReset();
  sysInternals.resetCacheForTests();
});

// ============================================================
// GET /api/containers/:id/top
// ============================================================

describe('GET /api/containers/:id/top', () => {
  it('returns titles + processes from dockerode .top()', async () => {
    topMock.mockResolvedValueOnce({
      Titles: ['UID', 'PID', 'CMD'],
      Processes: [['root', '1', '/bin/sh'], ['root', '42', 'ps -ef']],
    });
    const r = await request(buildApp())
      .get('/api/containers/c1/top')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      titles: ['UID', 'PID', 'CMD'],
      processes: [['root', '1', '/bin/sh'], ['root', '42', 'ps -ef']],
    });
    expect(topMock).toHaveBeenCalledWith('c1', { ps_args: '-ef' });
  });

  it('forwards a whitelisted preset ps_args verbatim', async () => {
    topMock.mockResolvedValueOnce({ Titles: [], Processes: [] });
    await request(buildApp())
      .get('/api/containers/c1/top?ps_args=aux')
      .set('Authorization', withRole('viewer'));
    expect(topMock).toHaveBeenCalledWith('c1', { ps_args: 'aux' });
  });

  it('accepts every documented preset (-ef, aux, -eo pid,user,pcpu,pmem,comm, axf)', async () => {
    const presets = ['-ef', 'aux', '-eo pid,user,pcpu,pmem,comm', 'axf'];
    for (const ps_args of presets) {
      topMock.mockResolvedValueOnce({ Titles: [], Processes: [] });
      const r = await request(buildApp())
        .get(`/api/containers/c1/top?ps_args=${encodeURIComponent(ps_args)}`)
        .set('Authorization', withRole('viewer'));
      expect(r.status).toBe(200);
      expect(topMock).toHaveBeenCalledWith('c1', { ps_args });
    }
  });

  it('rejects ps_args containing shell metachars (regex-era allowlist still has defense in depth)', async () => {
    const cases = ['aux;rm -rf /', '`reboot`', 'aux|cat /etc/passwd', '$(whoami)', 'aux & sleep 1'];
    for (const ps_args of cases) {
      const r = await request(buildApp())
        .get(`/api/containers/c1/top?ps_args=${encodeURIComponent(ps_args)}`)
        .set('Authorization', withRole('viewer'));
      expect(r.status).toBe(400);
    }
    expect(topMock).not.toHaveBeenCalled();
  });

  it('refuses ps_args that would dump env vars (security regression guard)', async () => {
    // These all PARSE as ps args but each would expose /proc/<pid>/environ
    // for every process in the container. The earlier regex-based
    // allowlist would have accepted them; the new enum-based one
    // must not.
    const envLeakAttempts = [
      '-eo pid,user,env,cmd',
      '-eo pid,environ',
      '-eo env',
      '-ef -o env',
      '-eo pid,comm,env',
    ];
    for (const ps_args of envLeakAttempts) {
      const r = await request(buildApp())
        .get(`/api/containers/c1/top?ps_args=${encodeURIComponent(ps_args)}`)
        .set('Authorization', withRole('viewer'));
      expect(r.status).toBe(400);
    }
    expect(topMock).not.toHaveBeenCalled();
  });

  it('maps daemon 404 to HTTP 404', async () => {
    const err = new Error('not found'); err.statusCode = 404;
    topMock.mockRejectedValueOnce(err);
    const r = await request(buildApp())
      .get('/api/containers/missing/top')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(404);
  });

  it('maps daemon 409 to HTTP 409 with an actionable message', async () => {
    const err = new Error('not running'); err.statusCode = 409;
    topMock.mockRejectedValueOnce(err);
    const r = await request(buildApp())
      .get('/api/containers/stopped/top')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/not running.*start it/i);
  });

  it('viewer JWT works (read-only, no role escalation needed)', async () => {
    topMock.mockResolvedValueOnce({ Titles: ['CMD'], Processes: [['sleep']] });
    const r = await request(buildApp())
      .get('/api/containers/c1/top')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
  });
});

// ============================================================
// GET /api/system/stats/summary
// ============================================================

describe('GET /api/system/stats/summary', () => {
  function statsSample({ cpu = 200, prevCpu = 100, syscpu = 1000, prevSyscpu = 500,
    cpus = 4, mem = 1_000_000, memCache = 200_000, memLimit = 4_000_000,
    netRx = 1000, netTx = 500, blkR = 4096, blkW = 8192 } = {}) {
    return {
      cpu_stats: { cpu_usage: { total_usage: cpu }, system_cpu_usage: syscpu, online_cpus: cpus },
      precpu_stats: { cpu_usage: { total_usage: prevCpu }, system_cpu_usage: prevSyscpu },
      memory_stats: { usage: mem, limit: memLimit, stats: { cache: memCache } },
      networks: { eth0: { rx_bytes: netRx, tx_bytes: netTx } },
      blkio_stats: { io_service_bytes_recursive: [{ op: 'read', value: blkR }, { op: 'write', value: blkW }] },
      pids_stats: { current: 5 },
    };
  }

  it('empty: returns zero totals + empty arrays when no containers run', async () => {
    listContainersMock.mockResolvedValueOnce([]);
    const r = await request(buildApp())
      .get('/api/system/stats/summary')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body.container_count).toBe(0);
    expect(r.body.totals.cpu_pct).toBe(0);
    expect(r.body.top_cpu).toEqual([]);
    expect(r.body.cached).toBe(false);
  });

  it('happy path: samples every running container, orders top_cpu DESC', async () => {
    listContainersMock.mockResolvedValueOnce([
      { Id: 'c1', Names: ['/web'],   Image: 'nginx' },
      { Id: 'c2', Names: ['/db'],    Image: 'postgres' },
      { Id: 'c3', Names: ['/cache'], Image: 'redis' },
    ]);
    // Two samples per container (computeRate requires it).
    // c2 is the CPU hog, c3 is the memory hog.
    const samples = {
      c1: [statsSample({ cpu: 100, prevCpu: 50 }), statsSample({ cpu: 200, prevCpu: 100 })],
      c2: [statsSample({ cpu: 500, prevCpu: 50 }), statsSample({ cpu: 900, prevCpu: 500 })],
      c3: [statsSample({ mem: 3_000_000 }), statsSample({ mem: 3_500_000 })],
    };
    statsMock.mockImplementation((id) => Promise.resolve(samples[id].shift()));

    const r = await request(buildApp())
      .get('/api/system/stats/summary')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body.container_count).toBe(3);
    expect(r.body.top_cpu[0].name).toBe('db');         // c2 had the highest CPU%
    expect(r.body.top_memory[0].name).toBe('cache');   // c3 had the most memory
    // top_cpu sorted descending.
    for (let i = 1; i < r.body.top_cpu.length; i++) {
      expect(r.body.top_cpu[i - 1].cpu_pct).toBeGreaterThanOrEqual(r.body.top_cpu[i].cpu_pct);
    }
    expect(r.body.cached).toBe(false);
  });

  it('honours ?limit= when slicing top_cpu / top_memory', async () => {
    listContainersMock.mockResolvedValueOnce([
      { Id: 'a', Names: ['/a'] }, { Id: 'b', Names: ['/b'] }, { Id: 'c', Names: ['/c'] },
    ]);
    statsMock.mockResolvedValue(statsSample());
    const r = await request(buildApp())
      .get('/api/system/stats/summary?limit=2')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body.top_cpu).toHaveLength(2);
    expect(r.body.top_memory).toHaveLength(2);
    // rows[] is unbounded.
    expect(r.body.rows).toHaveLength(3);
  });

  it('caches results for the cache TTL window — second call returns cached:true', async () => {
    listContainersMock.mockResolvedValueOnce([{ Id: 'c1', Names: ['/c1'] }]);
    statsMock.mockResolvedValue(statsSample());
    const r1 = await request(buildApp())
      .get('/api/system/stats/summary')
      .set('Authorization', withRole('viewer'));
    expect(r1.body.cached).toBe(false);

    // listContainersMock has no more queued responses — if the
    // cache works, the second call won't need it.
    const r2 = await request(buildApp())
      .get('/api/system/stats/summary')
      .set('Authorization', withRole('viewer'));
    expect(r2.status).toBe(200);
    expect(r2.body.cached).toBe(true);
    expect(listContainersMock).toHaveBeenCalledTimes(1);
  });

  it('per-container failure is isolated: bad container is dropped, summary still returns', async () => {
    listContainersMock.mockResolvedValueOnce([
      { Id: 'good', Names: ['/good'] },
      { Id: 'bad',  Names: ['/bad'] },
    ]);
    statsMock.mockImplementation((id) => {
      if (id === 'bad') return Promise.reject(new Error('container gone'));
      return Promise.resolve(statsSample());
    });
    const r = await request(buildApp())
      .get('/api/system/stats/summary')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body.container_count).toBe(1);
    expect(r.body.rows[0].name).toBe('good');
  });

  it('totals sum across all rows (matches what `docker stats` would aggregate)', async () => {
    listContainersMock.mockResolvedValueOnce([
      { Id: 'a', Names: ['/a'] }, { Id: 'b', Names: ['/b'] },
    ]);
    statsMock.mockResolvedValue(statsSample({ mem: 1_000_000, memCache: 200_000, memLimit: 4_000_000 }));
    const r = await request(buildApp())
      .get('/api/system/stats/summary')
      .set('Authorization', withRole('viewer'));
    expect(r.body.totals.mem_used_bytes).toBe(2 * 800_000);
    expect(r.body.totals.mem_limit_bytes).toBe(2 * 4_000_000);
  });

  it('viewer JWT works (read-only)', async () => {
    listContainersMock.mockResolvedValueOnce([]);
    const r = await request(buildApp())
      .get('/api/system/stats/summary')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
  });
});
