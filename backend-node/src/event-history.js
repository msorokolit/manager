// Persistent Docker events recorder.
//
// Docker's events endpoint only retains entries since the daemon
// last started. If you want "what containers died at 03:42 AM" you
// need to subscribe BEFORE 03:42 and persist the stream somewhere
// the daemon can't blow away on restart. That's this module.
//
// Architecture
//   start(client) — opens dockerode.getEvents() and pipes each
//                   parsed event through normalise() → appendLine.
//                   Auto-reconnects on stream end / error with
//                   exponential backoff (1s, 2s, 4s, … capped at
//                   60s) so transient daemon hiccups don't lose
//                   future events permanently.
//   stop()        — graceful shutdown for tests + SIGTERM.
//   queryEvents() — historical query with filters + pagination.
//
// Normalisation
//   Docker events have a free-form schema that varies by version.
//   We flatten the bits that matter for an operator's "what
//   happened" question:
//     ts             — ISO8601 (we re-stamp; daemon's `time`
//                       is seconds since epoch as a number)
//     type           — 'container' | 'image' | 'network' | 'volume'
//                       | 'plugin' | 'daemon' | 'service' | ...
//     action         — 'start' | 'die' | 'create' | 'destroy' | ...
//     scope          — 'local' | 'swarm'
//     actor_id       — Actor.ID (container id, image name+tag, ...)
//     actor_name     — Actor.Attributes.name (container name)
//                       or Actor.Attributes.image (image events)
//     image          — Actor.Attributes.image (container events)
//     attributes     — full Actor.Attributes for the drill-down
//                       modal (includes exitCode, signal, …)

import { settings } from './config.js';
import { logger } from './logger.js';
import { appendLine, queryLines, createStore } from './jsonl-store.js';

let store = null;
let currentStream = null;
let stopping = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
// Last successfully-recorded event timestamp (Unix nanoseconds
// preferred, falling back to seconds). On reconnect we pass this
// as `since` so the daemon replays events we missed during the
// outage. Without this, every reconnect creates a coverage hole
// the size of the backoff window — up to 60s of activity lost
// per cycle.
let lastEventSec = null;
// In-flight write count — the data handler counts pending writes
// and pauses the docker stream when the backlog exceeds the
// threshold. Resumes on the chain draining. Protects against
// slow-disk / paused-fs scenarios where writes pile up faster
// than they flush.
let pendingWrites = 0;
const PENDING_WRITE_PAUSE_THRESHOLD = 1000;

function getStore() {
  // Lazy so test envs that override settings via vi.hoisted get a
  // store pointing at the test-supplied path, not the boot-time
  // default.
  if (!store || store.file !== settings.eventsHistoryFile) {
    store = createStore({
      file: settings.eventsHistoryFile,
      maxBytes: settings.eventsHistoryMaxBytes,
      rotateKeep: settings.eventsHistoryRotateKeep,
    });
  }
  return store;
}

/**
 * Normalise a raw Docker event payload into our stable schema.
 * Exported for tests; the recorder calls this internally.
 */
export function normaliseEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const actor = raw.Actor || {};
  const attrs = actor.Attributes || {};
  // Docker emits `time` in seconds + `timeNano` in nanoseconds. We
  // prefer timeNano for resolution but fall back to time (or `now`
  // when neither is present — happens on older daemons).
  let tsMs;
  if (raw.timeNano) tsMs = Math.floor(raw.timeNano / 1e6);
  else if (raw.time) tsMs = raw.time * 1000;
  else tsMs = Date.now();
  return {
    ts: new Date(tsMs).toISOString(),
    type: raw.Type || raw.type || 'unknown',
    action: raw.Action || raw.status || 'unknown',
    scope: raw.scope || 'local',
    actor_id: actor.ID || raw.id || null,
    actor_name: attrs.name || null,
    image: attrs.image || null,
    // Keep the full attributes blob for the drill-down view —
    // exitCode, signal, healthcheck status, etc. live here.
    attributes: attrs,
  };
}

/**
 * Public: append one normalised event. Used by start() but also
 * exposed for tests that want to seed the store deterministically
 * without spinning up dockerode.
 *
 * Side-effects beyond the obvious:
 *   - Updates lastEventSec so a subsequent reconnect can resume
 *     with `since` instead of leaving a coverage hole.
 *   - Increments pendingWrites for the backpressure governor;
 *     decrements when the write resolves.
 */
export function recordEvent(event) {
  if (!settings.eventsHistoryEnabled) return Promise.resolve();
  const norm = normaliseEvent(event);
  if (!norm) return Promise.resolve();
  // Remember the most recent event time we ACCEPTED for storage;
  // reconnect uses this as a `since` filter. Add 1 second so we
  // don't replay the last seen event verbatim (Docker's `since`
  // is inclusive). The 1-second granularity is fine — Docker
  // events at sub-second resolution within the same reconnect
  // window are extraordinarily rare, and a 1s gap is far better
  // than a 60s one.
  const tsSec = Math.floor(Date.parse(norm.ts) / 1000);
  if (Number.isFinite(tsSec) && (lastEventSec == null || tsSec > lastEventSec)) {
    lastEventSec = tsSec;
  }
  pendingWrites++;
  const p = appendLine(getStore(), JSON.stringify(norm) + '\n', {
    onWriteError: (err) => logger.warn({ err: err.message }, 'event-history: write failed'),
  });
  p.finally(() => {
    pendingWrites--;
    // Resume the stream if we paused it for backpressure and the
    // backlog has drained.
    if (currentStream && currentStream.isPaused && currentStream.isPaused() && pendingWrites < PENDING_WRITE_PAUSE_THRESHOLD / 2) {
      try { currentStream.resume(); } catch {}
    }
  });
  return p;
}

/**
 * Start the persistent recorder. Idempotent — calling twice is a
 * no-op so the boot sequence doesn't accidentally open two
 * subscribers if a restart hook fires twice.
 *
 * Auto-reconnect uses exponential backoff capped at 60s, so a
 * down-and-back daemon recovers within a minute without us spam-
 * reconnecting at full speed.
 */
export async function start(client) {
  if (!settings.eventsHistoryEnabled) {
    logger.info('event-history: disabled (EVENTS_HISTORY_ENABLED=false)');
    return;
  }
  if (currentStream) return; // already running
  stopping = false;
  await _connect(client);
}

async function _connect(client) {
  try {
    // On first connect, no `since` — track from the moment the
    // recorder started. On reconnects, replay from one second after
    // the last successfully-recorded event so we cover the outage
    // window. Docker's daemon retains events back to its own start,
    // so this works as long as the daemon itself didn't restart
    // during the gap (in which case there are no events to replay).
    const opts = lastEventSec ? { since: lastEventSec + 1 } : {};
    currentStream = await client.getEvents(opts);
    reconnectAttempt = 0;
    logger.info({
      file: settings.eventsHistoryFile,
      since: opts.since || null,
    }, 'event-history: subscribed to docker events');
  } catch (err) {
    logger.warn({ err: err.message }, 'event-history: subscribe failed, will retry');
    _scheduleReconnect(client);
    return;
  }

  let buf = '';
  currentStream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    // Docker emits one JSON object per line (no NDJSON wrapper).
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try { recordEvent(JSON.parse(line)); }
      catch (err) { logger.debug({ err: err.message, line }, 'event-history: parse failed'); }
    }
    // Backpressure: if the write chain has fallen behind, pause
    // the docker stream so it stops shovelling events into the
    // node heap. Resume in recordEvent's finally hook once the
    // backlog drains. A noisy host with 100 containers and per-
    // second health checks can otherwise OOM us on a slow disk.
    if (pendingWrites >= PENDING_WRITE_PAUSE_THRESHOLD && currentStream && !currentStream.isPaused?.()) {
      try { currentStream.pause(); } catch {}
      logger.warn({ pending: pendingWrites }, 'event-history: pausing stream — write backlog');
    }
  });
  currentStream.on('error', (err) => {
    logger.warn({ err: err.message }, 'event-history: stream error, will reconnect');
    currentStream = null;
    _scheduleReconnect(client);
  });
  currentStream.on('end', () => {
    if (stopping) return;
    logger.info('event-history: stream ended, reconnecting');
    currentStream = null;
    _scheduleReconnect(client);
  });
}

function _scheduleReconnect(client) {
  if (stopping) return;
  reconnectAttempt = Math.min(reconnectAttempt + 1, 6); // 1,2,4,8,16,32,60
  const ms = Math.min(60_000, 1000 * Math.pow(2, reconnectAttempt - 1));
  reconnectTimer = setTimeout(() => _connect(client), ms);
}

/** Graceful shutdown. Used by SIGTERM hook + tests. */
export function stop() {
  stopping = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (currentStream) {
    try { currentStream.destroy(); } catch {}
    currentStream = null;
  }
}

/**
 * Historical query — reads JSONL file(s) and returns filtered +
 * paginated entries. Filter set mirrors the audit query for
 * consistency; see GET /api/system/events/history for the public
 * shape.
 */
export async function queryEvents(q = {}) {
  const since = q.since ? Date.parse(q.since) : null;
  const until = q.until ? Date.parse(q.until) : null;
  const type = q.type || null;
  const actorIdPrefix = q.actor_id || null;       // prefix match (short ids ok)
  const actorName = q.actor_name || null;
  const action = q.action || null;
  // Action supports glob like the audit query (start, container.*, *.die).
  const actionMatch = _glob(action);

  function matches(e) {
    if (since != null) { const t = Date.parse(e.ts); if (!Number.isFinite(t) || t < since) return false; }
    if (until != null) { const t = Date.parse(e.ts); if (!Number.isFinite(t) || t > until) return false; }
    if (type && e.type !== type) return false;
    if (actorIdPrefix && !(e.actor_id || '').startsWith(actorIdPrefix)) return false;
    if (actorName && e.actor_name !== actorName) return false;
    if (action && !actionMatch(e.action)) return false;
    return true;
  }
  return queryLines(settings.eventsHistoryFile, matches, {
    limit: q.limit, offset: q.offset, order: q.order || 'desc',
  });
}

function _glob(pattern) {
  if (!pattern || pattern === '*') return () => true;
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  return (s) => re.test(s || '');
}

// Visible-for-testing only.
export const _internals = {
  getStore,
  getLastEventSec: () => lastEventSec,
  getPendingWrites: () => pendingWrites,
  setLastEventSecForTests: (v) => { lastEventSec = v; },
  resetForTests() {
    stopping = false;
    if (currentStream) try { currentStream.destroy(); } catch {}
    currentStream = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempt = 0;
    lastEventSec = null;
    pendingWrites = 0;
    store = null;
  },
};
