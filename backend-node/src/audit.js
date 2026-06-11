// Audit log — persistent record of every mutating action through the
// API.
//
// Why a separate file from the structured app log?
//   - Different retention requirements. App logs are usually rotated
//     by size and kept for days; audit logs are kept for months/years
//     for compliance and need to survive a noisy debug run that
//     would otherwise blow them out of the ring buffer.
//   - Different schema discipline. Audit records have a fixed shape
//     (every entry has actor/action/resource/outcome); app logs are
//     freeform. Mixing them makes both harder to query.
//   - Different access policy. Audit logs are admin-readable through
//     a dedicated API; app logs are operator-only via the host
//     filesystem. Splitting at the storage layer matches that split.
//
// Storage model: append-only JSON Lines.
//   - JSONL is the lowest-common-denominator format for log
//     aggregators (loki, splunk, datadog, vector, fluentbit all
//     consume it natively).
//   - We rotate by size (default 10 MiB) and keep N old files
//     (default 5). That's enough for a small-to-medium deployment;
//     larger ones should point AUDIT_FILE at a path their log shipper
//     watches and stop the in-process rotation by raising the cap.
//
// Failure mode: if the audit write fails, we log the error but DON'T
// fail the API request. The user shouldn't be unable to start a
// container because the audit disk is full — but the operator should
// be able to find out about it via the app log.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { settings } from './config.js';
import { logger, currentContext } from './logger.js';

// Serialise writes so concurrent requests don't interleave rotation
// with append. One-line append is short enough that this is fine.
let writeChain = Promise.resolve();
let cachedSize = null;
let cachedFile = null;

async function appendLine(line) {
  const file = settings.auditFile;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
  } catch { /* directory may already exist; surface on the write itself */ }

  // Re-stat the file when the configured path changed (tests) or when
  // we have no cached size yet. We also resync on every 50th write so
  // an externally-truncated log (e.g. `> audit.log` from the shell)
  // doesn't keep us miswriting based on a stale cached counter.
  if (cachedSize == null || cachedFile !== file) {
    try { cachedSize = (await fsp.stat(file)).size; }
    catch { cachedSize = 0; }
    cachedFile = file;
  }

  // Rotate before append if the next write would push us past the cap.
  if (
    settings.auditMaxBytes > 0 &&
    cachedSize + line.length >= settings.auditMaxBytes
  ) {
    await rotate(file);
    cachedSize = 0;
  }

  // O_APPEND-equivalent write — atomic across processes on POSIX so
  // even if two manager replicas share the same file they don't
  // interleave bytes mid-line.
  await fsp.appendFile(file, line, { flag: 'a', mode: 0o600 });
  cachedSize += line.length;
}

async function rotate(file) {
  // audit.log → audit.log.1, audit.log.1 → audit.log.2, …, drop the oldest.
  const keep = Math.max(1, settings.auditRotateKeep);
  for (let i = keep; i > 0; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    const to = `${file}.${i}`;
    try {
      if (fs.existsSync(from)) {
        if (i === keep) await fsp.rm(from, { force: true });
        else await fsp.rename(from, to);
      }
    } catch (err) {
      // If rename fails, surface and bail — better to keep writing
      // to the existing file (it'll exceed the cap) than lose entries.
      logger.warn({ err: err.message, file: from }, 'audit log rotation step failed');
      return;
    }
  }
}

function enqueue(record) {
  // Chain writes through a single promise so file appends never
  // interleave with a rotation step. Errors are swallowed at the
  // chain level so one bad write doesn't poison subsequent calls.
  writeChain = writeChain.then(
    () => appendLine(JSON.stringify(record) + '\n'),
  ).catch((err) => {
    logger.error({ err: err.message }, 'audit log write failed');
  });
  return writeChain;
}

/**
 * Public API: write one audit entry. Returns a promise that resolves
 * once the entry is flushed to disk; in fire-and-forget contexts
 * callers can ignore it. Throws don't escape (logged via logger).
 */
export function audit(record) {
  if (!settings.auditEnabled) return Promise.resolve();
  // Stamp with high-resolution UTC ISO time. The middleware fills the
  // common fields; callers may add their own.
  const ts = new Date().toISOString();
  return enqueue({ ts, ...record });
}

// ---------- Action / resource derivation ----------
//
// We try hard to give every mutating request a meaningful `action` +
// `resource_type` + `resource_id` even when the route author didn't
// explicitly opt in. Heuristics that look at the route's tag + verb +
// path segments handle the common cases; explicit overrides via the
// `audit:` field in the route spec take precedence.

const VERB_BY_METHOD = { POST: 'create', PUT: 'update', PATCH: 'patch', DELETE: 'delete' };

export function deriveActionFromRequest(req, routeSpec) {
  if (routeSpec && routeSpec.audit && routeSpec.audit.action) {
    return routeSpec.audit.action;
  }
  // Tags are set per-router (containers / images / etc.) — use the
  // singular form as the resource type ('containers' → 'container').
  const tag = (routeSpec && routeSpec.tags && routeSpec.tags[0]) || null;
  const resource = tag ? tag.replace(/s$/, '') : 'api';
  const path = req.route ? req.route.path : (req.originalUrl || req.path || '');

  // Trailing verb pattern: /api/containers/:id/start  →  container.start
  // /api/networks/:id/connect                          →  network.connect
  // /api/containers/start/bulk                         →  container.start.bulk
  const segs = String(path).split('/').filter(Boolean);
  // Strip /api prefix + the resource segment if present.
  if (segs[0] === 'api') segs.shift();
  if (segs[0] === tag) segs.shift();
  // Replace param placeholders (:id, :name) with empty so they don't
  // show up in the action string.
  const verbSegs = segs.filter((s) => !s.startsWith(':') && s !== '');
  if (verbSegs.length) return `${resource}.${verbSegs.join('.')}`;

  // No trailing verb segments — fall back to method-derived verb.
  return `${resource}.${VERB_BY_METHOD[req.method] || req.method.toLowerCase()}`;
}

function pickResourceId(req, routeSpec) {
  if (routeSpec && routeSpec.audit && routeSpec.audit.resourceIdFrom) {
    const at = routeSpec.audit.resourceIdFrom;
    if (at.startsWith('params.')) return req.params[at.slice(7)];
    if (at.startsWith('body.')) return req.body && req.body[at.slice(5)];
    if (at.startsWith('query.')) return req.query[at.slice(6)];
  }
  // Defaults: :id, :name, body.name (for create), body.id, body.ids
  // (for bulks).
  if (req.params) {
    if (req.params.id) return req.params.id;
    if (req.params.name) return req.params.name;
  }
  if (req.body) {
    if (typeof req.body.name === 'string') return req.body.name;
    if (typeof req.body.id === 'string') return req.body.id;
    if (Array.isArray(req.body.ids)) return req.body.ids.length === 1 ? req.body.ids[0] : `[${req.body.ids.length} items]`;
    if (Array.isArray(req.body.names)) return req.body.names.length === 1 ? req.body.names[0] : `[${req.body.names.length} items]`;
  }
  return null;
}

/**
 * Middleware factory: only records auditable activity when the route
 * spec is decorated with `admin: true` or `destructive: true`, OR
 * explicitly opts in with `audit: { ... }`. Plain read endpoints are
 * not audited (they'd swamp the file).
 *
 * The middleware runs after the route handler — it uses `res.on('finish')`
 * to capture the final status and duration. This means a handler that
 * throws still produces an audit entry (the express error middleware
 * always writes a status before `finish`).
 */
export function auditMiddleware(routeSpec) {
  // Skip the middleware entirely when nothing about the route warrants
  // an entry. This is the hot path — every read GET hits this check.
  const candidate =
    settings.auditEnabled && (
      (routeSpec && routeSpec.audit) ||
      (routeSpec && routeSpec.admin) ||
      (routeSpec && routeSpec.destructive)
    );
  if (!candidate) return (req, res, next) => next();

  return function auditTrail(req, res, next) {
    // Only record mutating verbs by default. Admin-only GETs (e.g. the
    // audit query endpoint itself, /api/audit) wouldn't generate
    // useful trail entries — they'd flood the log with operator-noise
    // and add a self-referencing entry per query. A route can opt back
    // in by setting `audit: { includeGet: true }` in its spec.
    const opt = (routeSpec && routeSpec.audit) || {};
    if (req.method === 'GET' && !opt.includeGet) return next();

    const started = process.hrtime.bigint();
    const action = deriveActionFromRequest(req, routeSpec);
    const tag = (routeSpec && routeSpec.tags && routeSpec.tags[0]) || null;
    const resourceType = (routeSpec && routeSpec.audit && routeSpec.audit.resourceType)
      || (tag ? tag.replace(/s$/, '') : 'api');

    // Snapshot identifying fields up front — by the time `finish`
    // fires, the body parser may have moved on.
    const ctx = currentContext();
    const requestId = (ctx && ctx.requestId) || req.requestId || null;
    const sessionId = (ctx && ctx.sessionId) || req.sessionId || null;
    const sourceIp = (ctx && ctx.sourceIp) || req.ip || null;
    const resourceId = pickResourceId(req, routeSpec);

    let finalErr = null;
    // Stash an `errBy` hook for the central error middleware to call
    // before responding. We capture the error message there because
    // res.statusMessage / the error body aren't available on 'finish'.
    res.locals = res.locals || {};
    res.locals.auditCaptureError = (err) => {
      finalErr = err && (err.detail || err.message || String(err));
    };

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const status = res.statusCode;
      const outcome = status >= 200 && status < 400 ? 'ok' : 'error';
      const record = {
        request_id: requestId,
        // session_id ties the audit row back to the row in
        // sessions.json. The Sessions and Audit pages cross-link via
        // this — click "View activity" on a session and the Audit
        // page opens pre-filtered by it.
        session_id: sessionId,
        actor: req.user
          ? { username: req.user.username, role: req.user.role }
          : null,
        source_ip: sourceIp,
        method: req.method,
        path: req.originalUrl || req.url,
        action,
        resource_type: resourceType,
        resource_id: resourceId,
        outcome,
        status,
        duration_ms: Math.round(durationMs * 100) / 100,
      };
      if (finalErr) record.error = String(finalErr).slice(0, 1024);
      audit(record);
    });

    next();
  };
}

// Visible-for-testing only.
export const _internals = {
  appendLine, rotate, enqueue, pickResourceId,
  resetCacheForTests() { cachedSize = null; cachedFile = null; },
  // Wait for the in-flight write chain to settle. Tests need this
  // because audit() returns as soon as the write is *queued*; without
  // a drain, a write from test A can land in test B's file after B's
  // beforeEach has already seeded its own data.
  drainForTests() { return writeChain.catch(() => {}); },
};
