// Server-side session store.
//
// Why we have one at all
// ----------------------
// Plain JWTs are stateless: once signed, valid until `exp`. No
// revocation, no "sign me out everywhere", no admin "kill that
// compromised token", no list of who's logged in. Fine for a toy.
// Not fine for an enterprise admin tool that holds credentials for
// the host Docker daemon.
//
// Adding a thin store on top closes the gap without going full
// refresh-token-OAuth complexity:
//
//   - Every login mints a session row (UUID v4 → JWT jti).
//   - The auth middleware looks up the jti on every request and
//     rejects 401 'Session revoked' when missing. One Map.get per
//     request — negligible.
//   - Logout / revoke = drop the row. Token's signature still verifies,
//     but the store check fails and the request is rejected.
//   - Admin can list ALL sessions and revoke one / all-for-a-user /
//     all globally (incident response: 'we just rotated the daemon
//     credentials, kick everyone out').
//
// Storage
// -------
// In-memory `Map<sessionId, Session>` for the hot path, periodically
// flushed to disk so sessions survive a restart. Writes are debounced
// (we don't fsync on every request) and atomic (tmp + rename, mode
// 0600).
//
// This is *not* designed for multi-replica deployments. For that you
// want Redis or a shared DB and a fresh adapter (drop a different
// implementation behind this module's exports). The single-replica
// in-memory pattern is the right fit for ~99% of self-hosted ops
// installations.
//
// Concurrency
// -----------
// Map ops are sync; the persist step takes a chain-lock so two flushes
// can't write the same file at once. The auth middleware runs the
// touch synchronously; the persist debouncer picks the changes up on
// its next tick.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { settings } from './config.js';
import { logger } from './logger.js';

// Map<sessionId, Session>
//
// A `Session` is the plain-object shape we serialise to JSON; no
// instance methods. That keeps the disk format trivial to inspect and
// (very importantly) makes restoring on startup a no-op `JSON.parse`.
const sessions = new Map();

// Set of session ids changed since the last persist tick. Lets us skip
// the disk write entirely when nothing happened.
let dirty = new Set();
let persistTimer = null;
let persistChain = Promise.resolve();
let lastSweep = 0;

/**
 * Create a session, return the full record. Caller embeds `id` in the
 * JWT payload as `jti` so the auth middleware can look it up.
 *
 *   ttlSeconds — used to compute `expires_at`; should match the JWT
 *                `exp` so the two times line up.
 */
export function createSession({ user, role, sourceIp = null, userAgent = null, ttlSeconds }) {
  if (!user || !role) throw new Error('createSession: user + role required');
  const id = randomUUID();
  const now = Date.now();
  const session = {
    id,
    user,
    role,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
    source_ip: sourceIp || null,
    user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
    last_seen: new Date(now).toISOString(),
  };

  // Enforce per-user concurrent-session cap by evicting the oldest
  // surviving session(s) when the user already has too many. Most
  // operators want this off (cap=0). Banks / SOC environments tend
  // to enforce 1 active session per principal.
  if (settings.sessionsMaxPerUser > 0) {
    const owned = [...sessions.values()]
      .filter((s) => s.user === user)
      .sort((a, b) => Date.parse(a.last_seen) - Date.parse(b.last_seen));
    while (owned.length >= settings.sessionsMaxPerUser) {
      const oldest = owned.shift();
      sessions.delete(oldest.id);
      dirty.add(oldest.id);
      logger.info(
        { kind: 'session', event: 'evicted_for_cap', user, session_id: oldest.id },
        'evicted oldest session to honour SESSIONS_MAX_PER_USER',
      );
    }
  }

  sessions.set(id, session);
  dirty.add(id);
  scheduleFlush();
  logger.info(
    { kind: 'session', event: 'created', session_id: id, user, role, source_ip: sourceIp },
    'session created',
  );
  return session;
}

/**
 * Look up a session by id. Returns null if missing OR if the recorded
 * expiry has passed (in which case the row is dropped — keeps the
 * store from growing unbounded between sweeps).
 */
export function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.parse(s.expires_at) <= Date.now()) {
    sessions.delete(id);
    dirty.add(id);
    scheduleFlush();
    return null;
  }
  return s;
}

/**
 * Update `last_seen` for a session — called from the auth middleware
 * on every successful request. We don't update on every call (one
 * write per request would spam the persist timer); instead we only
 * mark dirty if the timestamp moved by ≥ 5 seconds. Good enough
 * resolution for "show me when this session was last active".
 */
export function touchSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  const now = Date.now();
  if (now - Date.parse(s.last_seen) < 5000) return;
  s.last_seen = new Date(now).toISOString();
  dirty.add(id);
  scheduleFlush();

  // Piggyback opportunistic sweep on touch (cheaper than a separate
  // setInterval, and bounded — at most one sweep per hour, only fires
  // when there's actual traffic).
  if (now - lastSweep > 60 * 60 * 1000) sweepExpired();
}

/** Drop one session. Returns true if it existed. */
export function revokeSession(id, reason = 'manual') {
  if (!sessions.has(id)) return false;
  sessions.delete(id);
  dirty.add(id);
  scheduleFlush();
  logger.info(
    { kind: 'session', event: 'revoked', session_id: id, reason },
    'session revoked',
  );
  return true;
}

/**
 * Revoke every session belonging to `user`. Returns the count revoked.
 * `excludeId` lets callers spare one session (e.g. "log me out
 * everywhere EXCEPT here").
 */
export function revokeForUser(user, { excludeId = null, reason = 'user' } = {}) {
  let count = 0;
  for (const [id, s] of sessions) {
    if (s.user !== user) continue;
    if (excludeId && id === excludeId) continue;
    sessions.delete(id);
    dirty.add(id);
    count++;
  }
  if (count) {
    scheduleFlush();
    logger.info(
      { kind: 'session', event: 'revoked_for_user', user, count, reason },
      'sessions revoked for user',
    );
  }
  return count;
}

/**
 * Nuke everything. Use case: incident response after a credential
 * leak ('kick everyone, rotate JWT_SECRET, force re-login'). Returns
 * the count of sessions revoked.
 */
export function revokeAll({ reason = 'admin', excludeId = null } = {}) {
  let count = 0;
  for (const id of [...sessions.keys()]) {
    if (excludeId && id === excludeId) continue;
    sessions.delete(id);
    dirty.add(id);
    count++;
  }
  if (count) {
    scheduleFlush();
    logger.warn(
      { kind: 'session', event: 'revoked_all', count, reason },
      'ALL sessions revoked',
    );
  }
  return count;
}

/**
 * Return active sessions, optionally filtered by user. The returned
 * objects are clones — callers may mutate them (e.g. to mark "this is
 * your current session" before returning over the wire) without
 * corrupting the store.
 */
export function listSessions({ user = null } = {}) {
  const out = [];
  for (const s of sessions.values()) {
    if (user && s.user !== user) continue;
    out.push({ ...s });
  }
  // Stable order: most recently active first. Matches the UX of every
  // "active sessions" pane on every other auth system.
  out.sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen));
  return out;
}

/** Drop any sessions whose `expires_at` has passed. */
export function sweepExpired() {
  const now = Date.now();
  let count = 0;
  for (const [id, s] of sessions) {
    if (Date.parse(s.expires_at) <= now) {
      sessions.delete(id);
      dirty.add(id);
      count++;
    }
  }
  lastSweep = now;
  if (count) {
    scheduleFlush();
    logger.debug({ kind: 'session', event: 'sweep', dropped: count }, 'expired sessions swept');
  }
  return count;
}

// ---------- Disk persistence ----------
//
// Whenever the store is mutated, we mark dirty + schedule a flush at
// most once per `sessionsPersistIntervalMs`. The flush is atomic
// (tmp file + rename, mode 0600) and lock-serialised so two concurrent
// flushes can't write the same file.

function scheduleFlush() {
  if (persistTimer || !settings.sessionsFile) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!dirty.size) return;
    flushNow();
  }, settings.sessionsPersistIntervalMs);
  // Don't block process exit on the timer.
  persistTimer.unref && persistTimer.unref();
}

function flushNow() {
  const snapshot = [...sessions.values()];
  dirty = new Set();
  persistChain = persistChain.then(async () => {
    const file = settings.sessionsFile;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ sessions: snapshot }, null, 0));
      // chmod before rename so the final file already has 0600 on the
      // very first byte readable through it.
      try { await fs.chmod(tmp, 0o600); } catch {}
      await fs.rename(tmp, file);
    } catch (err) {
      logger.error(
        { err: err.message || String(err), file },
        'session persistence failed',
      );
    }
  }).catch(() => {});
  return persistChain;
}

/**
 * Load sessions from disk on startup. Drops any rows whose expiry has
 * passed so we don't restore zombie sessions. Returns the count loaded.
 */
export async function loadFromDisk() {
  const file = settings.sessionsFile;
  if (!file || !existsSync(file)) return 0;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    const rows = (data && Array.isArray(data.sessions)) ? data.sessions : [];
    const now = Date.now();
    let loaded = 0;
    for (const s of rows) {
      if (!s.id || !s.expires_at) continue;
      if (Date.parse(s.expires_at) <= now) continue;
      sessions.set(s.id, s);
      loaded++;
    }
    logger.info({ kind: 'session', event: 'loaded', count: loaded }, 'sessions restored from disk');
    return loaded;
  } catch (err) {
    logger.warn(
      { err: err.message || String(err), file },
      'failed to load sessions file (starting empty)',
    );
    return 0;
  }
}

// Visible-for-testing only.
export const _internals = {
  _map: sessions,
  flushNow,
  resetForTests() {
    sessions.clear();
    dirty = new Set();
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    persistChain = Promise.resolve();
    lastSweep = 0;
  },
  drainForTests() { return persistChain.catch(() => {}); },
  sweepExpired,
};
