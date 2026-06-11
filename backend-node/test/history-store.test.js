// Tests for src/jsonl-store.js + src/event-history.js +
// src/stats-history.js + their two routes.
//
// All three modules share a write/rotate/read pattern modelled on
// the audit log. We cover the primitive (jsonl-store) with focused
// micro-tests, then exercise the two domain wrappers and their
// routes end-to-end via supertest.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Tests need control over EVENTS_HISTORY_FILE + STATS_HISTORY_FILE
// BEFORE config.js loads.
//
// vi.hoisted runs SYNCHRONOUSLY before any imports execute, which
// is exactly what we want — but it means we can't reference
// top-of-file ESM imports inside the callback (they haven't been
// evaluated yet). Vitest's recommended workaround is the CJS
// `require` global it injects for this purpose; using it here is
// the documented pattern, not a CJS-in-ESM smell.
//
// (An async vi.hoisted was tried — it resolves AFTER imports run,
// which defeats the entire purpose of hoisting.)
const ctx = vi.hoisted(() => {
  const nodeFs = require('node:fs');
  const nodeOs = require('node:os');
  const nodePath = require('node:path');
  const tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'history-store-'));
  process.env.EVENTS_HISTORY_FILE = nodePath.join(tmp, 'events.jsonl');
  process.env.STATS_HISTORY_FILE = nodePath.join(tmp, 'stats.jsonl');
  process.env.EVENTS_HISTORY_MAX_BYTES = '500'; // tiny cap so rotation fires
  process.env.EVENTS_HISTORY_ROTATE_KEEP = '3';
  process.env.STATS_HISTORY_INTERVAL_SEC = '5';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-history';
  process.env.LOG_LEVEL = 'silent';
  return { tmp };
});

import express from 'express';
import request from 'supertest';
import { appendLine, queryLines, createStore } from '../src/jsonl-store.js';
import * as eventHistory from '../src/event-history.js';
import * as statsHistory from '../src/stats-history.js';
import { withRole, resetSessions } from './helpers/auth-helper.js';

vi.mock('../src/docker-client.js', () => ({
  getClient: () => ({ /* not exercised here */ }),
  dockerError: (e) => ({ status: e.statusCode || 500, detail: e.message || 'docker error' }),
}));
const { default: systemApi } = await import('../src/routes/system.js');
const { sendError } = await import('../src/util.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(systemApi.basePath, systemApi.router);
  app.use((err, _req, res, _next) => sendError(res, err));
  return app;
}

beforeEach(async () => {
  resetSessions();
  eventHistory._internals.resetForTests();
  statsHistory._internals.resetForTests();
  // Clean out the temp dir so each test gets a fresh JSONL state.
  for (const f of await fsp.readdir(ctx.tmp)) {
    await fsp.rm(path.join(ctx.tmp, f), { force: true });
  }
});

// ============================================================
// jsonl-store: the primitive
// ============================================================

describe('jsonl-store: append + rotate + read', () => {
  it('appends lines to the file with mode 0600', async () => {
    const file = path.join(ctx.tmp, 'plain.jsonl');
    const s = createStore({ file, maxBytes: 0 });
    await appendLine(s, JSON.stringify({ a: 1 }) + '\n');
    await appendLine(s, JSON.stringify({ a: 2 }) + '\n');
    const stat = await fsp.stat(file);
    // Mode bits — appendFile honours `mode` only on file create.
    // (umask may still mask further; check that owner-only is set.)
    expect((stat.mode & 0o077)).toBe(0);
    const text = await fsp.readFile(file, 'utf8');
    expect(text.trim().split('\n')).toEqual([
      JSON.stringify({ a: 1 }), JSON.stringify({ a: 2 }),
    ]);
  });

  it('rotates when next write would exceed maxBytes', async () => {
    const file = path.join(ctx.tmp, 'rot.jsonl');
    const s = createStore({ file, maxBytes: 30, rotateKeep: 3 });
    // Each line is roughly 20 bytes — after 2 we should rotate.
    for (let i = 0; i < 5; i++) {
      await appendLine(s, JSON.stringify({ i }) + '\n');
    }
    const files = (await fsp.readdir(ctx.tmp)).filter((n) => n.startsWith('rot.jsonl'));
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain('rot.jsonl.1');
  });

  it('keeps at most rotateKeep+1 generations (live + N rotated)', async () => {
    const file = path.join(ctx.tmp, 'cap.jsonl');
    const s = createStore({ file, maxBytes: 20, rotateKeep: 2 });
    for (let i = 0; i < 30; i++) {
      await appendLine(s, JSON.stringify({ i }) + '\n');
    }
    const files = (await fsp.readdir(ctx.tmp)).filter((n) => n.startsWith('cap.jsonl'));
    expect(files.length).toBeLessThanOrEqual(3); // live + .1 + .2
    expect(files).not.toContain('cap.jsonl.3');
  });

  it('queryLines walks rotated siblings in chronological order', async () => {
    const file = path.join(ctx.tmp, 'q.jsonl');
    const s = createStore({ file, maxBytes: 50 });
    for (let i = 0; i < 10; i++) {
      await appendLine(s, JSON.stringify({ ts: new Date(2026, 0, i + 1).toISOString(), i }) + '\n');
    }
    const r = await queryLines(file, () => true, { limit: 100, order: 'asc' });
    // We should see ALL entries across rotated files. (The exact
    // count depends on when rotation kicked in; assertions check
    // the invariant rather than fragile counts.)
    expect(r.entries.length).toBeGreaterThan(0);
    for (let i = 1; i < r.entries.length; i++) {
      expect(Date.parse(r.entries[i].ts)).toBeGreaterThanOrEqual(Date.parse(r.entries[i - 1].ts));
    }
  });

  it('queryLines paginates and reports has_more honestly', async () => {
    const file = path.join(ctx.tmp, 'p.jsonl');
    const s = createStore({ file, maxBytes: 0 });
    for (let i = 0; i < 25; i++) {
      await appendLine(s, JSON.stringify({ ts: new Date(2026, 0, 1, 0, i).toISOString(), i }) + '\n');
    }
    const page1 = await queryLines(file, () => true, { limit: 10, offset: 0, order: 'desc' });
    expect(page1.entries).toHaveLength(10);
    expect(page1.has_more).toBe(true);
    expect(page1.total).toBe(25);
    const page3 = await queryLines(file, () => true, { limit: 10, offset: 20, order: 'desc' });
    expect(page3.entries).toHaveLength(5);
    expect(page3.has_more).toBe(false);
  });

  it('queryLines skips garbage lines without throwing', async () => {
    const file = path.join(ctx.tmp, 'g.jsonl');
    await fsp.writeFile(file, [
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', good: 1 }),
      'not valid json at all',
      '',
      JSON.stringify({ ts: '2026-01-02T00:00:00Z', good: 2 }),
    ].join('\n'));
    const r = await queryLines(file, () => true, { limit: 100 });
    expect(r.entries).toHaveLength(2);
    expect(r.entries.map((e) => e.good).sort()).toEqual([1, 2]);
  });

  it('queryLines respects MAX_SCAN guard against runaway queries', async () => {
    const file = path.join(ctx.tmp, 'big.jsonl');
    const s = createStore({ file, maxBytes: 0 });
    for (let i = 0; i < 10; i++) {
      await appendLine(s, JSON.stringify({ ts: new Date().toISOString(), i }) + '\n');
    }
    const r = await queryLines(file, () => true, { limit: 100, maxScan: 3 });
    expect(r.truncated).toBe(true);
    expect(r.scanned).toBe(4); // hits the guard on the 4th line
  });
});

// ============================================================
// event-history
// ============================================================

describe('event-history: normalise + recordEvent + queryEvents', () => {
  it('normalises the daemon event shape into our stable schema', () => {
    const norm = eventHistory.normaliseEvent({
      Type: 'container', Action: 'die',
      Actor: { ID: 'abc123', Attributes: { name: 'web', image: 'nginx', exitCode: '137', signal: '9' } },
      scope: 'local', time: 1700000000, timeNano: 1700000000_123456789,
    });
    expect(norm.type).toBe('container');
    expect(norm.action).toBe('die');
    expect(norm.actor_id).toBe('abc123');
    expect(norm.actor_name).toBe('web');
    expect(norm.image).toBe('nginx');
    expect(norm.attributes.exitCode).toBe('137');
    expect(norm.attributes.signal).toBe('9');
    expect(norm.ts).toMatch(/^2023-/); // 1.7e9 seconds = 2023-11-14
  });

  it('falls back to status / now when Action / time are missing (older daemons)', () => {
    const before = Date.now();
    const norm = eventHistory.normaliseEvent({
      Type: 'container', status: 'start', Actor: { ID: 'x', Attributes: {} },
    });
    expect(norm.action).toBe('start');
    expect(Date.parse(norm.ts)).toBeGreaterThanOrEqual(before);
  });

  it('returns null on garbage input rather than throwing', () => {
    expect(eventHistory.normaliseEvent(null)).toBeNull();
    expect(eventHistory.normaliseEvent('not an object')).toBeNull();
  });

  it('recordEvent + queryEvents round-trip', async () => {
    await eventHistory.recordEvent({
      Type: 'container', Action: 'start', Actor: { ID: 'c1', Attributes: { name: 'web' } },
      time: 1700000000,
    });
    await eventHistory.recordEvent({
      Type: 'container', Action: 'die', Actor: { ID: 'c1', Attributes: { name: 'web' } },
      time: 1700000100,
    });
    await eventHistory.recordEvent({
      Type: 'image', Action: 'pull', Actor: { ID: 'nginx:latest', Attributes: { name: 'nginx:latest' } },
      time: 1700000200,
    });
    const r = await eventHistory.queryEvents({ limit: 100 });
    expect(r.total).toBe(3);
    expect(r.entries.map((e) => e.action).sort()).toEqual(['die', 'pull', 'start']);
  });

  it('queryEvents filters by type + action glob + actor_id prefix', async () => {
    for (let i = 0; i < 5; i++) {
      await eventHistory.recordEvent({
        Type: 'container', Action: i % 2 ? 'start' : 'die',
        Actor: { ID: `cid-${i}`, Attributes: { name: `c${i}` } }, time: 1700000000 + i,
      });
    }
    await eventHistory.recordEvent({
      Type: 'image', Action: 'pull', Actor: { ID: 'img1', Attributes: {} }, time: 1700000999,
    });
    expect((await eventHistory.queryEvents({ type: 'container' })).total).toBe(5);
    expect((await eventHistory.queryEvents({ type: 'image' })).total).toBe(1);
    expect((await eventHistory.queryEvents({ action: 'start' })).total).toBe(2);
    expect((await eventHistory.queryEvents({ action: '*' })).total).toBe(6);
    expect((await eventHistory.queryEvents({ actor_id: 'cid-' })).total).toBe(5);
    expect((await eventHistory.queryEvents({ actor_id: 'cid-2' })).total).toBe(1);
  });

  it('queryEvents filters by since/until (ISO 8601)', async () => {
    await eventHistory.recordEvent({ Type: 'container', Action: 'start', Actor: { Attributes: {} }, time: 1700000000 });
    await eventHistory.recordEvent({ Type: 'container', Action: 'die',   Actor: { Attributes: {} }, time: 1700000500 });
    const since = new Date(1700000400 * 1000).toISOString();
    const r = await eventHistory.queryEvents({ since });
    expect(r.total).toBe(1);
    expect(r.entries[0].action).toBe('die');
  });
});

// ============================================================
// stats-history
// ============================================================

describe('stats-history: recordSample + queryStats', () => {
  function sampleSummary({ ts, count = 1, rows = [] } = {}) {
    return {
      sampled_at: ts || new Date().toISOString(),
      container_count: count,
      totals: {
        cpu_pct: rows.reduce((a, r) => a + r.cpu_pct, 0),
        mem_used_bytes: rows.reduce((a, r) => a + r.mem_used_bytes, 0),
        mem_limit_bytes: 0,
        net_rx_bytes_per_s: 0, net_tx_bytes_per_s: 0,
        blk_read_bytes_per_s: 0, blk_write_bytes_per_s: 0,
      },
      rows,
    };
  }

  it('round-trips a sample through recordSample / queryStats', async () => {
    await statsHistory.recordSample(sampleSummary({
      ts: '2026-06-11T15:00:00Z',
      count: 2,
      rows: [
        { id: 'c1', name: 'web', cpu_pct: 50, mem_used_bytes: 1024, mem_limit_bytes: 4096, mem_pct: 25, net_rx_bytes_per_s: 0, net_tx_bytes_per_s: 0, blk_read_bytes_per_s: 0, blk_write_bytes_per_s: 0 },
        { id: 'c2', name: 'db', cpu_pct: 80, mem_used_bytes: 2048, mem_limit_bytes: 4096, mem_pct: 50, net_rx_bytes_per_s: 0, net_tx_bytes_per_s: 0, blk_read_bytes_per_s: 0, blk_write_bytes_per_s: 0 },
      ],
    }));
    const r = await statsHistory.queryStats({ limit: 100 });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].container_count).toBe(2);
    // top[] should be sorted by cpu_pct desc.
    expect(r.entries[0].top[0].name).toBe('db');
    expect(r.entries[0].top[1].name).toBe('web');
    // totals carry through verbatim.
    expect(r.entries[0].totals.cpu_pct).toBe(130);
    expect(r.entries[0].totals.mem_used_bytes).toBe(3072);
  });

  it('caps the per-row top[] at topN', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`, name: `c${i}`, cpu_pct: i, mem_used_bytes: 0, mem_limit_bytes: 0,
      mem_pct: 0, net_rx_bytes_per_s: 0, net_tx_bytes_per_s: 0,
      blk_read_bytes_per_s: 0, blk_write_bytes_per_s: 0,
    }));
    await statsHistory.recordSample(sampleSummary({ rows }), { topN: 10 });
    const r = await statsHistory.queryStats({ limit: 100 });
    expect(r.entries[0].top).toHaveLength(10);
    // The 10 highest cpu_pct (49,48,...,40) sorted DESC.
    expect(r.entries[0].top[0].cpu_pct).toBe(49);
    expect(r.entries[0].top[9].cpu_pct).toBe(40);
  });

  it('queryStats filters by container_id (prefix or name) AND time range', async () => {
    const ts0 = '2026-06-11T15:00:00Z';
    const ts1 = '2026-06-11T15:05:00Z';
    const ts2 = '2026-06-11T15:10:00Z';
    for (const ts of [ts0, ts1, ts2]) {
      await statsHistory.recordSample(sampleSummary({
        ts,
        rows: [{ id: 'abc123def', name: 'web', cpu_pct: 10, mem_used_bytes: 0, mem_limit_bytes: 0, mem_pct: 0, net_rx_bytes_per_s: 0, net_tx_bytes_per_s: 0, blk_read_bytes_per_s: 0, blk_write_bytes_per_s: 0 }],
      }));
    }
    // Drill down by container id prefix.
    expect((await statsHistory.queryStats({ container_id: 'abc' })).total).toBe(3);
    // Drill down by name.
    expect((await statsHistory.queryStats({ container_id: 'web' })).total).toBe(3);
    // Drill down by something that doesn't exist.
    expect((await statsHistory.queryStats({ container_id: 'nope' })).total).toBe(0);
    // Time range.
    const r = await statsHistory.queryStats({ since: ts1 });
    expect(r.total).toBe(2);
  });

  it('queryStats returns entries in ASCENDING order by default (charts)', async () => {
    for (let i = 0; i < 5; i++) {
      await statsHistory.recordSample(sampleSummary({ ts: `2026-06-11T15:0${i}:00Z` }));
    }
    const r = await statsHistory.queryStats({ limit: 100 });
    for (let i = 1; i < r.entries.length; i++) {
      expect(Date.parse(r.entries[i].ts)).toBeGreaterThanOrEqual(Date.parse(r.entries[i - 1].ts));
    }
  });

  it('queryStats honours order:desc when requested', async () => {
    for (let i = 0; i < 5; i++) {
      await statsHistory.recordSample(sampleSummary({ ts: `2026-06-11T15:0${i}:00Z` }));
    }
    const r = await statsHistory.queryStats({ limit: 100, order: 'desc' });
    for (let i = 1; i < r.entries.length; i++) {
      expect(Date.parse(r.entries[i].ts)).toBeLessThanOrEqual(Date.parse(r.entries[i - 1].ts));
    }
  });

  it('topN: 0 writes a totals-only row (no per-container snapshot)', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`, name: `c${i}`, cpu_pct: i, mem_used_bytes: 0, mem_limit_bytes: 0,
      mem_pct: 0, net_rx_bytes_per_s: 0, net_tx_bytes_per_s: 0,
      blk_read_bytes_per_s: 0, blk_write_bytes_per_s: 0,
    }));
    await statsHistory.recordSample(sampleSummary({ rows }), { topN: 0 });
    const r = await statsHistory.queryStats({ limit: 100 });
    expect(r.entries[0].top).toEqual([]);
    // Totals still carry through — topN only affects the snapshot.
    expect(r.entries[0].container_count).toBe(1);
  });

  it('in-flight guard: overlapping ticks are skipped', async () => {
    let inflight = 0;
    let maxInflight = 0;
    let totalCalls = 0;
    // sampleFn is deliberately slow — 100ms — so when we fire
    // tick() three times back-to-back without awaiting, the second
    // and third see the in-flight flag set and bail.
    const slowSample = async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      totalCalls++;
      await new Promise((r) => setTimeout(r, 100));
      inflight--;
      return {
        sampled_at: new Date().toISOString(),
        container_count: 0,
        totals: {
          cpu_pct: 0, mem_used_bytes: 0, mem_limit_bytes: 0,
          net_rx_bytes_per_s: 0, net_tx_bytes_per_s: 0,
          blk_read_bytes_per_s: 0, blk_write_bytes_per_s: 0,
        },
        rows: [],
      };
    };
    const t = statsHistory._internals.tick;
    // Fire three concurrent ticks. Only the first runs end-to-end;
    // the other two should bail immediately.
    await Promise.all([t(slowSample), t(slowSample), t(slowSample)]);
    expect(maxInflight).toBe(1);
    expect(totalCalls).toBe(1);
    expect(statsHistory._internals.getSkippedTicks()).toBe(2);
  });
});

// ============================================================
// event-history reconnect: lastEventSec is used as `since` on reconnect
// ============================================================

describe('event-history reconnect uses lastEventSec as since', () => {
  it('recordEvent updates lastEventSec to the recorded event time', async () => {
    eventHistory._internals.resetForTests();
    expect(eventHistory._internals.getLastEventSec()).toBeNull();
    await eventHistory.recordEvent({
      Type: 'container', Action: 'start',
      Actor: { Attributes: {} },
      time: 1700000000,
    });
    // Updated to the recorded event's wall time, NOT 'now'. This
    // matters so reconnect can replay from exactly where we
    // stopped, not from the moment of the reconnect.
    expect(eventHistory._internals.getLastEventSec()).toBe(1700000000);
  });

  it('lastEventSec only advances, never goes backwards', async () => {
    eventHistory._internals.resetForTests();
    // Record an event from later first…
    await eventHistory.recordEvent({
      Type: 'container', Action: 'start',
      Actor: { Attributes: {} }, time: 1700000100,
    });
    // …then one from earlier (out-of-order delivery, rare but
    // possible with retries / reconnect replay). lastEventSec
    // should NOT regress.
    await eventHistory.recordEvent({
      Type: 'container', Action: 'die',
      Actor: { Attributes: {} }, time: 1700000050,
    });
    expect(eventHistory._internals.getLastEventSec()).toBe(1700000100);
  });
});

// ============================================================
// routes
// ============================================================

describe('GET /api/system/events/history', () => {
  it('viewer can query (read-only)', async () => {
    await eventHistory.recordEvent({ Type: 'container', Action: 'start', Actor: { Attributes: {} }, time: 1700000000 });
    const r = await request(buildApp())
      .get('/api/system/events/history')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body.entries.length).toBeGreaterThan(0);
  });

  it('honours the type + action filters', async () => {
    await eventHistory.recordEvent({ Type: 'container', Action: 'start', Actor: { Attributes: {} }, time: 1700000000 });
    await eventHistory.recordEvent({ Type: 'image', Action: 'pull', Actor: { Attributes: {} }, time: 1700000001 });
    const r = await request(buildApp())
      .get('/api/system/events/history?type=container')
      .set('Authorization', withRole('viewer'));
    expect(r.body.entries).toHaveLength(1);
    expect(r.body.entries[0].action).toBe('start');
  });
});

describe('GET /api/system/stats/history', () => {
  it('viewer can query (read-only); ascending order by default', async () => {
    for (let i = 0; i < 3; i++) {
      await statsHistory.recordSample({
        sampled_at: `2026-06-11T15:0${i}:00Z`,
        container_count: 1, totals: {
          cpu_pct: i, mem_used_bytes: 0, mem_limit_bytes: 0,
          net_rx_bytes_per_s: 0, net_tx_bytes_per_s: 0,
          blk_read_bytes_per_s: 0, blk_write_bytes_per_s: 0,
        }, rows: [],
      });
    }
    const r = await request(buildApp())
      .get('/api/system/stats/history')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body.entries).toHaveLength(3);
    expect(r.body.entries[0].totals.cpu_pct).toBe(0);
    expect(r.body.entries[2].totals.cpu_pct).toBe(2);
  });
});
