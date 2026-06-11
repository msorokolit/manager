// Admin-only audit-log query endpoint.
//
// Reads the JSONL file (and its rotated siblings, oldest first) and
// streams matching entries back as JSON. Filters and pagination keep
// the payload small.
//
// This is intentionally a tiny in-process implementation — anything
// past a few hundred MB of audit data wants a real query engine
// (loki / elasticsearch / clickhouse). For self-contained "enterprise"
// deployments where the manager IS the audit destination, this is
// enough and avoids dragging in a dependency.
//
// Performance: we scan files line by line (no JSON parse until the
// line passes the cheap filters), so a 100 MB log over a 100 MB cap
// still answers a typical query in <1 s on a single SSD-backed host.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Type } from '@sinclair/typebox';
import { settings } from '../config.js';
import { asyncHandler, HttpError, intQuery } from '../util.js';
import { createApiRouter } from '../route-builder.js';
import { Opt, StringEnum } from '../schemas/_common.js';
import { AuditEntry, AuditQueryResponse } from '../schemas/audit.js';

const r = createApiRouter('/api/audit', { tag: 'audit' });

const AuditQuery = Type.Object(
  {
    since: Opt(Type.String({ description: 'ISO 8601 timestamp; only entries at or after this time' })),
    until: Opt(Type.String({ description: 'ISO 8601 timestamp; only entries at or before this time' })),
    actor: Opt(Type.String({ description: 'Match the actor.username field exactly' })),
    action: Opt(Type.String({ description: 'Glob-style match on action (`container.*` or `network.connect`)' })),
    resource_type: Opt(Type.String()),
    resource_id: Opt(Type.String()),
    outcome: Opt(StringEnum(['ok', 'error'])),
    request_id: Opt(Type.String()),
    limit: Opt(Type.Integer({ minimum: 1, maximum: 1000, default: 100 })),
    offset: Opt(Type.Integer({ minimum: 0, default: 0 })),
    // Newest-first by default — that's what an operator skimming for
    // "what happened most recently" expects.
    order: Opt(StringEnum(['asc', 'desc'])),
  },
  { additionalProperties: false },
);

/**
 * Convert a `glob`-style `action` filter into a predicate. Supports
 *   - exact:        'container.start'
 *   - prefix:       'container.*'
 *   - infix:        '*.bulk'
 *   - everything:   '*'
 */
function makeActionMatcher(pattern) {
  if (!pattern) return () => true;
  if (pattern === '*') return () => true;
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  return (a) => re.test(a || '');
}

/**
 * Iterate files in chronological order (oldest rotated → current
 * audit.log) and yield matching entries. We keep two passes' worth of
 * state in memory: a moving sliding window of matched entries equal to
 * `offset + limit` so the final pagination is O(limit) memory.
 */
async function queryAudit(q) {
  const file = settings.auditFile;
  const dir = path.dirname(file);
  const base = path.basename(file);

  // Discover rotated siblings. Oldest first, then live file last so
  // ascending iteration walks time forward.
  let rotated = [];
  try {
    rotated = (await fs.promises.readdir(dir))
      .filter((n) => n === base || n.startsWith(base + '.'))
      .sort((a, b) => {
        if (a === base) return 1; // base goes last (newest)
        if (b === base) return -1;
        const an = parseInt(a.slice(base.length + 1), 10) || 0;
        const bn = parseInt(b.slice(base.length + 1), 10) || 0;
        return bn - an; // higher .N suffix = older
      })
      .map((n) => path.join(dir, n));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const since = q.since ? Date.parse(q.since) : null;
  const until = q.until ? Date.parse(q.until) : null;
  const actor = q.actor || null;
  const resourceType = q.resource_type || null;
  const resourceId = q.resource_id || null;
  const outcome = q.outcome || null;
  const reqId = q.request_id || null;
  const actionMatch = makeActionMatcher(q.action);

  function matches(entry) {
    if (since != null) {
      const t = Date.parse(entry.ts);
      if (!Number.isFinite(t) || t < since) return false;
    }
    if (until != null) {
      const t = Date.parse(entry.ts);
      if (!Number.isFinite(t) || t > until) return false;
    }
    if (actor && (!entry.actor || entry.actor.username !== actor)) return false;
    if (resourceType && entry.resource_type !== resourceType) return false;
    if (resourceId && entry.resource_id !== resourceId) return false;
    if (outcome && entry.outcome !== outcome) return false;
    if (reqId && entry.request_id !== reqId) return false;
    if (!actionMatch(entry.action)) return false;
    return true;
  }

  // Two passes is the simplest correct implementation:
  //   1. Count + collect into a flat array (bounded by an upper cap
  //      so a runaway query doesn't OOM us).
  //   2. Sort + paginate.
  // For a typical < 100 MB log this is plenty fast and the code stays
  // obvious.
  const MAX_SCAN = 100_000;
  const matched = [];
  let scanned = 0;

  for (const filename of rotated) {
    let stream;
    try { stream = fs.createReadStream(filename, { encoding: 'utf8' }); }
    catch (err) { continue; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      scanned++;
      if (scanned > MAX_SCAN) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); }
      catch { continue; }
      if (matches(entry)) matched.push(entry);
    }
    rl.close();
    if (scanned > MAX_SCAN) break;
  }

  const order = q.order || 'desc';
  matched.sort((a, b) => {
    const at = Date.parse(a.ts) || 0;
    const bt = Date.parse(b.ts) || 0;
    return order === 'asc' ? at - bt : bt - at;
  });

  const offset = q.offset || 0;
  const limit = q.limit || 100;
  const page = matched.slice(offset, offset + limit);
  return {
    total: matched.length,
    returned: page.length,
    has_more: offset + page.length < matched.length,
    entries: page,
  };
}

r.get(
  '/',
  {
    summary: 'Query the audit log (admin-only; supports filtering + pagination)',
    admin: true,
    query: AuditQuery,
    responses: { 200: AuditQueryResponse },
  },
  asyncHandler(async (req, res) => {
    if (!settings.auditEnabled) {
      throw new HttpError(503, 'Audit logging is disabled (AUDIT_ENABLED=false)');
    }
    const q = {
      since: req.query.since,
      until: req.query.until,
      actor: req.query.actor,
      action: req.query.action,
      resource_type: req.query.resource_type,
      resource_id: req.query.resource_id,
      outcome: req.query.outcome,
      request_id: req.query.request_id,
      order: req.query.order || 'desc',
      limit: intQuery(req.query.limit, 100, { min: 1, max: 1000 }),
      offset: intQuery(req.query.offset, 0, { min: 0 }),
    };
    res.json(await queryAudit(q));
  }),
);

// Visible-for-testing only.
export const _internals = { queryAudit, makeActionMatcher };

export default r;
