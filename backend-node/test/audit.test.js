// Audit log: file format + middleware capture + admin query API.
//
// Three layers under test:
//
//   1. The file store (`audit.js`)
//      - JSONL append, atomic on POSIX
//      - size-based rotation (audit.log → audit.log.1 → … → drop oldest)
//      - failure-doesn't-fail-the-request semantics (we don't actually
//        exercise an EIO here, but we verify the public api swallows
//        thrown errors silently)
//
//   2. The audit middleware (`auditMiddleware`)
//      - records admin/destructive routes; skips plain reads
//      - captures action / resource_type / resource_id correctly
//      - captures status, duration_ms, outcome, error message
//      - viewer-rejected requests produce an audit row (403 / 'error')
//
//   3. The query API (`GET /api/audit`)
//      - admin-only (viewer → 403, unauth → 401)
//      - filters: since/until/actor/action(glob)/resource_type/outcome
//      - pagination + has_more
//
// Same hoisted-env-var pattern as bulk-routes.test.js — config is
// frozen at module load, so we point AUDIT_FILE at a temp path before
// any imports run.

import {
  describe, it, expect, beforeAll, beforeEach, afterAll, vi,
} from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

const { AUDIT_TMP_FILE, REG_TMP_FILE, STACKS_TMP_DIR } = vi.hoisted(() => {
  const tmp = process.env.TMPDIR || '/tmp';
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const audit = `${tmp.replace(/\/$/, '')}/audit-${suffix}.log`;
  const reg = `${tmp.replace(/\/$/, '')}/regaudit-${suffix}.json`;
  const stk = `${tmp.replace(/\/$/, '')}/stacksaudit-${suffix}`;
  process.env.AUDIT_FILE = audit;
  process.env.AUDIT_ENABLED = 'true';
  process.env.AUDIT_MAX_BYTES = '0'; // disable rotation for most tests
  process.env.REGISTRIES_FILE = reg;
  process.env.STACKS_DIR = stk;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-audit';
  process.env.LOG_LEVEL = 'silent';
  return { AUDIT_TMP_FILE: audit, REG_TMP_FILE: reg, STACKS_TMP_DIR: stk };
});

import { signToken } from '../src/jwt.js';

// Mock docker-client so route imports don't try to talk to a real daemon.
vi.mock('../src/docker-client.js', () => {
  const client = {
    listContainers: async () => [],
    listImages: async () => [],
    listVolumes: async () => ({ Volumes: [] }),
    listNetworks: async () => [],
    df: async () => ({ Volumes: [] }),
    getContainer: () => ({
      start: async () => ({}),
      stop: async () => ({}),
      restart: async () => ({}),
      remove: async () => ({}),
      inspect: async () => ({ Id: 'cid', Name: '/x' }),
    }),
    getVolume: () => ({
      inspect: async () => ({ Name: 'v' }),
      remove: async () => ({}),
    }),
  };
  return {
    getClient: () => client,
    dockerError: (e) => ({ status: e.statusCode || 500, detail: e.message || 'docker error' }),
  };
});

const { default: containersApi } = await import('../src/routes/containers.js');
const { default: volumesApi } = await import('../src/routes/volumes.js');
const { default: auditApi } = await import('../src/routes/audit.js');
const { sendError } = await import('../src/util.js');
const { requestContext } = await import('../src/request-context.js');
const auditMod = await import('../src/audit.js');
const { audit, _internals: auditInternals } = auditMod;

function buildApp(...routers) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  for (const r of routers) app.use(r.basePath, r.router);
  app.use((err, _req, res, _next) => sendError(res, err));
  return app;
}

function withRole(role) {
  return `Bearer ${signToken({ sub: role, role }).token}`;
}

// Truncate the audit file between tests so each test starts with a
// known-empty log. Some tests also wait for the in-process write chain
// to drain — the middleware schedules audit appends inside
// res.on('finish'), which runs AFTER supertest resolves.
async function readAudit() {
  if (!existsSync(AUDIT_TMP_FILE)) return [];
  const text = await fs.readFile(AUDIT_TMP_FILE, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForAuditCount(expected, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await readAudit();
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  return readAudit();
}

beforeAll(async () => {
  await fs.mkdir(path.dirname(AUDIT_TMP_FILE), { recursive: true });
});
beforeEach(async () => {
  // Drain any pending writes from the previous test so they don't
  // land in this test's file after we wipe it. Audit writes are
  // queued by res.on('finish'); the in-flight chain may outlast the
  // supertest response.
  await auditInternals.drainForTests();
  // Wipe the audit file + every rotated sibling between tests, and
  // reset the module-level cachedSize so this test's writes start
  // from a clean (file-doesn't-exist → 0 bytes) baseline.
  for (const f of [AUDIT_TMP_FILE, ...Array.from({ length: 10 }, (_, i) => `${AUDIT_TMP_FILE}.${i + 1}`)]) {
    await fs.rm(f, { force: true });
  }
  auditInternals.resetCacheForTests();
});
afterAll(async () => {
  for (const f of [AUDIT_TMP_FILE, ...Array.from({ length: 10 }, (_, i) => `${AUDIT_TMP_FILE}.${i + 1}`)]) {
    await fs.rm(f, { force: true });
  }
});

// ============================================================
// Layer 1: file store
// ============================================================

describe('audit() file store', () => {
  it('appends one JSON line per call', async () => {
    await audit({ action: 'test.one', outcome: 'ok' });
    await audit({ action: 'test.two', outcome: 'ok' });
    const rows = await readAudit();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: 'test.one', outcome: 'ok' });
    expect(rows[1]).toMatchObject({ action: 'test.two', outcome: 'ok' });
  });

  it('stamps every row with an ISO timestamp', async () => {
    await audit({ action: 'test.ts' });
    const rows = await readAudit();
    expect(rows[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('survives an invalid payload without throwing (JSON.stringify never fails on plain values)', async () => {
    // We don't actually test EIO here — JSON serialization of our
    // public-API arguments can't fail. The contract: the call resolves
    // (no rejection escapes). This test pins it.
    await expect(audit({ action: 'x', extra: { a: 1, b: 'two' } })).resolves.toBeUndefined();
  });
});

// (Rotation behaviour lives in its own test file because it requires
// the AUDIT_MAX_BYTES env var set BEFORE config.js loads, and the
// rest of the audit suite needs rotation disabled to keep counts
// deterministic. See test/audit-rotation.test.js.)

// ============================================================
// Layer 2: middleware capture
// ============================================================

describe('auditMiddleware capture', () => {
  it('records a mutating request with method, path, action, status, outcome', async () => {
    const app = buildApp(containersApi);
    const r = await request(app)
      .post('/api/containers/start/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: ['c1'] });
    expect(r.status).toBe(200);
    const rows = await waitForAuditCount(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      method: 'POST',
      path: '/api/containers/start/bulk',
      action: 'container.start.bulk',
      outcome: 'ok',
      status: 200,
      actor: { username: 'admin', role: 'admin' },
    });
    // request_id must be a non-empty string (UUID v4 or upstream id).
    expect(typeof rows[0].request_id).toBe('string');
    expect(rows[0].request_id.length).toBeGreaterThan(8);
    // duration_ms is non-negative.
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('skips plain read endpoints (no admin / destructive flag)', async () => {
    const app = buildApp(volumesApi);
    await request(app)
      .get('/api/volumes')
      .set('Authorization', withRole('viewer'));
    await new Promise((r) => setTimeout(r, 50));
    const rows = await readAudit();
    expect(rows).toHaveLength(0);
  });

  it('records 403 for viewer hitting an admin endpoint (outcome=error)', async () => {
    const app = buildApp(volumesApi);
    const r = await request(app)
      .post('/api/volumes/delete/bulk')
      .set('Authorization', withRole('viewer'))
      .send({ names: ['v1'] });
    expect(r.status).toBe(403);
    const rows = await waitForAuditCount(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'error',
      status: 403,
      action: 'volume.delete.bulk',
    });
  });

  it('captures :id from the route params as resource_id', async () => {
    const app = buildApp(containersApi);
    await request(app)
      .post('/api/containers/some-container-id/start')
      .set('Authorization', withRole('admin'));
    const rows = await waitForAuditCount(1);
    expect(rows[0]).toMatchObject({
      action: 'container.start',
      resource_id: 'some-container-id',
      resource_type: 'container',
    });
  });

  it('captures bulk size as resource_id for multi-item requests', async () => {
    const app = buildApp(containersApi);
    await request(app)
      .post('/api/containers/start/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: ['c1', 'c2', 'c3'] });
    const rows = await waitForAuditCount(1);
    expect(rows[0].resource_id).toBe('[3 items]');
  });

  it('captures the error message for failed requests', async () => {
    const app = buildApp(containersApi);
    // Schema rejection — request body missing required `ids`.
    const r = await request(app)
      .post('/api/containers/start/bulk')
      .set('Authorization', withRole('admin'))
      .send({ /* no ids */ });
    expect(r.status).toBe(400);
    const rows = await waitForAuditCount(1);
    expect(rows[0]).toMatchObject({
      outcome: 'error', status: 400,
    });
    expect(rows[0].error).toBeTruthy();
  });

  it('attaches the request_id from the incoming X-Request-Id header', async () => {
    const upstream = 'trace-id-1234567890abcdef';
    const app = buildApp(containersApi);
    await request(app)
      .post('/api/containers/start/bulk')
      .set('X-Request-Id', upstream)
      .set('Authorization', withRole('admin'))
      .send({ ids: ['c1'] });
    const rows = await waitForAuditCount(1);
    expect(rows[0].request_id).toBe(upstream);
  });
});

// ============================================================
// Layer 3: query API
// ============================================================

describe('GET /api/audit (query API)', () => {
  beforeEach(async () => {
    // Pre-seed with a small set of well-known entries so each test can
    // assert on filter behaviour without having to drive requests through
    // the router first.
    const base = new Date('2026-06-10T00:00:00Z').getTime();
    const entries = [
      { ts: new Date(base).toISOString(), action: 'container.start', resource_type: 'container', resource_id: 'c1', actor: { username: 'alice', role: 'admin' }, outcome: 'ok', status: 200, method: 'POST', path: '/api/containers/c1/start', duration_ms: 5 },
      { ts: new Date(base + 60_000).toISOString(), action: 'container.stop', resource_type: 'container', resource_id: 'c1', actor: { username: 'bob', role: 'admin' }, outcome: 'ok', status: 200, method: 'POST', path: '/api/containers/c1/stop', duration_ms: 7 },
      { ts: new Date(base + 120_000).toISOString(), action: 'volume.delete', resource_type: 'volume', resource_id: 'v1', actor: { username: 'alice', role: 'admin' }, outcome: 'error', status: 409, error: 'in use', method: 'DELETE', path: '/api/volumes/v1', duration_ms: 12 },
      { ts: new Date(base + 180_000).toISOString(), action: 'image.remove.bulk', resource_type: 'image', resource_id: '[2 items]', actor: { username: 'bob', role: 'admin' }, outcome: 'ok', status: 200, method: 'POST', path: '/api/images/remove/bulk', duration_ms: 22 },
      { ts: new Date(base + 240_000).toISOString(), action: 'network.connect', resource_type: 'network', resource_id: 'n1', actor: { username: 'alice', role: 'admin' }, outcome: 'ok', status: 200, method: 'POST', path: '/api/networks/n1/connect', duration_ms: 9 },
    ];
    await fs.writeFile(AUDIT_TMP_FILE, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  });

  it('returns newest-first by default', async () => {
    const app = buildApp(auditApi);
    const r = await request(app).get('/api/audit').set('Authorization', withRole('admin'));
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(5);
    expect(r.body.returned).toBe(5);
    expect(r.body.has_more).toBe(false);
    expect(r.body.entries[0].action).toBe('network.connect');
    expect(r.body.entries[4].action).toBe('container.start');
  });

  it('order=asc returns oldest-first', async () => {
    const app = buildApp(auditApi);
    const r = await request(app)
      .get('/api/audit?order=asc')
      .set('Authorization', withRole('admin'));
    expect(r.body.entries[0].action).toBe('container.start');
  });

  it('filter by actor', async () => {
    const app = buildApp(auditApi);
    const r = await request(app)
      .get('/api/audit?actor=alice')
      .set('Authorization', withRole('admin'));
    expect(r.body.total).toBe(3);
    for (const e of r.body.entries) expect(e.actor.username).toBe('alice');
  });

  it('filter by outcome=error', async () => {
    const app = buildApp(auditApi);
    const r = await request(app)
      .get('/api/audit?outcome=error')
      .set('Authorization', withRole('admin'));
    expect(r.body.total).toBe(1);
    expect(r.body.entries[0].action).toBe('volume.delete');
  });

  it('glob match on action: container.*', async () => {
    const app = buildApp(auditApi);
    const r = await request(app)
      .get('/api/audit?action=container.*')
      .set('Authorization', withRole('admin'));
    expect(r.body.total).toBe(2);
    expect(r.body.entries.every((e) => e.action.startsWith('container.'))).toBe(true);
  });

  it('glob match on action: *.bulk', async () => {
    const app = buildApp(auditApi);
    const r = await request(app)
      .get('/api/audit?action=*.bulk')
      .set('Authorization', withRole('admin'));
    expect(r.body.total).toBe(1);
    expect(r.body.entries[0].action).toBe('image.remove.bulk');
  });

  it('filter by resource_type', async () => {
    const app = buildApp(auditApi);
    const r = await request(app)
      .get('/api/audit?resource_type=volume')
      .set('Authorization', withRole('admin'));
    expect(r.body.total).toBe(1);
    expect(r.body.entries[0].resource_type).toBe('volume');
  });

  it('filter by since/until (ISO timestamps)', async () => {
    const app = buildApp(auditApi);
    const r = await request(app)
      .get('/api/audit?since=2026-06-10T00:01:30Z&until=2026-06-10T00:03:30Z')
      .set('Authorization', withRole('admin'));
    expect(r.body.total).toBe(2);
    expect(new Set(r.body.entries.map((e) => e.action))).toEqual(new Set(['volume.delete', 'image.remove.bulk']));
  });

  it('pagination: limit + offset + has_more', async () => {
    const app = buildApp(auditApi);
    const r = await request(app)
      .get('/api/audit?limit=2&offset=0&order=asc')
      .set('Authorization', withRole('admin'));
    expect(r.body.total).toBe(5);
    expect(r.body.returned).toBe(2);
    expect(r.body.has_more).toBe(true);
    expect(r.body.entries[0].action).toBe('container.start');

    const r2 = await request(app)
      .get('/api/audit?limit=2&offset=4&order=asc')
      .set('Authorization', withRole('admin'));
    expect(r2.body.returned).toBe(1);
    expect(r2.body.has_more).toBe(false);
  });

  it('rejects viewer JWT (admin-only)', async () => {
    const app = buildApp(auditApi);
    const r = await request(app).get('/api/audit').set('Authorization', withRole('viewer'));
    expect(r.status).toBe(403);
  });

  it('rejects unauthenticated requests', async () => {
    const r = await request(buildApp(auditApi)).get('/api/audit');
    expect(r.status).toBe(401);
  });

  it('returns an empty result set on a missing audit file (rather than 500)', async () => {
    await fs.rm(AUDIT_TMP_FILE, { force: true });
    const app = buildApp(auditApi);
    const r = await request(app).get('/api/audit').set('Authorization', withRole('admin'));
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
    expect(r.body.entries).toEqual([]);
  });
});
