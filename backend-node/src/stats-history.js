// Persistent resource-usage sampler.
//
// Records one snapshot per interval (default 30s) into a JSONL
// file. Each row is the totals from buildStatsSummary() plus a
// small "top N" snapshot of the heaviest containers at that
// moment. The SPA's History → Resources tab queries this file to
// draw past charts the live monitoring couldn't capture because
// the user wasn't looking.
//
// Why not just Prometheus?
//   Many teams DO export to Prometheus for metrics — and this
//   manager doesn't try to replace that. But for a small to
//   medium deployment, the operator wants a "what happened last
//   night" view that doesn't require a separate stack. This is
//   that view.
//
// Storage estimate at defaults:
//   30 s interval, ~5 KB/row (totals + top-20 snapshot)
//   ≈ 14 MB / day → ~17 days at 50 MB cap × 5 keep
//
// Quitting / restart behaviour
//   stop() is idempotent and resets state. The sampler is started
//   from src/index.js after server.listen so a startup failure
//   doesn't prevent the HTTP server itself from coming up.

import { settings } from './config.js';
import { logger } from './logger.js';
import { appendLine, queryLines, createStore } from './jsonl-store.js';

let store = null;
let intervalHandle = null;
let stopping = false;
// Single-flight guard: a tick takes ~1s × ⌈N/8⌉ + sample gap.
// On a host with 200 containers a single tick can run ~25s. If
// the next setInterval fires before we finish, two buildStatsSummary
// calls would hit the daemon in parallel AND write duplicate rows.
// We just skip the overlapping tick.
let tickInflight = false;
let skippedTicks = 0;

function getStore() {
  if (!store || store.file !== settings.statsHistoryFile) {
    store = createStore({
      file: settings.statsHistoryFile,
      maxBytes: settings.statsHistoryMaxBytes,
      rotateKeep: settings.statsHistoryRotateKeep,
    });
  }
  return store;
}

/**
 * Public: record one sample. Used by the sampler tick, but also
 * exposed so tests can seed the store deterministically.
 *
 * The row shape mirrors the SystemStatsSummaryResponse, except
 * `rows[]` is sliced to `top_n` of the heaviest containers (by
 * cpu_pct) — bounding the on-disk row size to something
 * predictable.
 */
export function recordSample(summary, { topN = settings.statsHistoryTopN } = {}) {
  if (!settings.statsHistoryEnabled) return Promise.resolve();
  if (!summary) return Promise.resolve();
  const row = {
    ts: summary.sampled_at || new Date().toISOString(),
    container_count: summary.container_count || 0,
    totals: summary.totals || {
      cpu_pct: 0, mem_used_bytes: 0, mem_limit_bytes: 0,
      net_rx_bytes_per_s: 0, net_tx_bytes_per_s: 0,
      blk_read_bytes_per_s: 0, blk_write_bytes_per_s: 0,
    },
    // Slice to topN by cpu_pct so the row size stays bounded. On a
    // host with 200 containers we don't want a 50 KB row every 30s.
    top: (summary.rows || [])
      .slice()
      .sort((a, b) => b.cpu_pct - a.cpu_pct)
      .slice(0, topN),
  };
  return appendLine(getStore(), JSON.stringify(row) + '\n', {
    onWriteError: (err) => logger.warn({ err: err.message }, 'stats-history: write failed'),
  });
}

/**
 * Start the periodic sampler. `sampleFn` is injected so tests
 * (and the production wiring) decide what to call — production
 * passes buildStatsSummary; tests pass a stub.
 *
 * Idempotent: re-calling start() while already running is a no-op.
 */
export function start(sampleFn) {
  if (!settings.statsHistoryEnabled) {
    logger.info('stats-history: disabled (STATS_HISTORY_ENABLED=false)');
    return;
  }
  if (intervalHandle) return;
  stopping = false;
  const intervalMs = settings.statsHistoryIntervalSec * 1000;
  logger.info({
    file: settings.statsHistoryFile,
    interval_sec: settings.statsHistoryIntervalSec,
    top_n: settings.statsHistoryTopN,
  }, 'stats-history: sampler started');
  // Fire once immediately so a fresh dashboard isn't blank for
  // the first 30 seconds after server start.
  _tick(sampleFn);
  intervalHandle = setInterval(() => _tick(sampleFn), intervalMs);
}

async function _tick(sampleFn) {
  if (stopping) return;
  if (tickInflight) {
    // Previous tick still running — skip this one. Log every 10th
    // skip so a persistently-overlapping sampler is visible without
    // log spam every interval.
    skippedTicks++;
    if (skippedTicks % 10 === 1) {
      logger.warn({
        skipped_ticks: skippedTicks,
        interval_sec: settings.statsHistoryIntervalSec,
      }, 'stats-history: previous tick still running; interval may be too aggressive');
    }
    return;
  }
  tickInflight = true;
  try {
    const summary = await sampleFn();
    await recordSample(summary);
  } catch (err) {
    // A single sample failure shouldn't kill the sampler — usually
    // it's a transient daemon hiccup. Log + carry on.
    logger.warn({ err: err.message }, 'stats-history: sample tick failed');
  } finally {
    tickInflight = false;
  }
}

/** Graceful shutdown (SIGTERM hook + tests). Idempotent. */
export function stop() {
  stopping = true;
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  // tickInflight may stay true if a tick was mid-flight; that's
  // fine, the in-progress sample will write its row and complete.
  // resetForTests clears the flag for clean test isolation.
}

/**
 * Historical query — reads JSONL file(s) and returns filtered +
 * paginated entries. Supports filtering by `container_id` (matches
 * if the row's `top` snapshot includes a container with that id)
 * for drill-down from the per-container History view.
 */
export async function queryStats(q = {}) {
  const since = q.since ? Date.parse(q.since) : null;
  const until = q.until ? Date.parse(q.until) : null;
  const containerId = q.container_id || null;

  function matches(e) {
    if (since != null) { const t = Date.parse(e.ts); if (!Number.isFinite(t) || t < since) return false; }
    if (until != null) { const t = Date.parse(e.ts); if (!Number.isFinite(t) || t > until) return false; }
    if (containerId) {
      const hit = (e.top || []).some((c) => (c.id || '').startsWith(containerId) || c.name === containerId);
      if (!hit) return false;
    }
    return true;
  }
  return queryLines(settings.statsHistoryFile, matches, {
    limit: q.limit, offset: q.offset, order: q.order || 'asc',
    // Time-series charts almost always want ascending order.
  });
}

// Visible-for-testing only.
export const _internals = {
  getStore,
  getSkippedTicks: () => skippedTicks,
  getTickInflight: () => tickInflight,
  tick: _tick,                    // exposed so tests can drive ticks deterministically
  resetForTests() {
    stopping = false;
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
    tickInflight = false;
    skippedTicks = 0;
    store = null;
  },
};
