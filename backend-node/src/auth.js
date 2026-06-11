// JWT bearer auth with two roles: admin (full) and viewer (read-only).
//
// `verifyCredentials` is exposed for the /api/auth/login endpoint; everywhere
// else the bearer middleware (`authenticate`) is what protects routes.
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { settings } from './config.js';
import { verifyToken } from './jwt.js';
import { patchContext } from './logger.js';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function unauthorized(res, detail = 'Authentication required') {
  // Thread the rejection reason into the audit row when one is being
  // collected for this request (the audit middleware sets
  // `res.locals.auditCaptureError` on relevant routes). Quiet no-op
  // for routes that aren't being audited.
  if (res.locals && typeof res.locals.auditCaptureError === 'function') {
    try { res.locals.auditCaptureError(detail); } catch {}
  }
  return res.status(401).json({ detail });
}

function forbidden(res, detail) {
  if (res.locals && typeof res.locals.auditCaptureError === 'function') {
    try { res.locals.auditCaptureError(detail); } catch {}
  }
  return res.status(403).json({ detail });
}

/**
 * Match a username/password pair against the configured admin / viewer
 * accounts. Returns a User object (`{username, role}`) or null. Used only
 * by the login endpoint.
 */
export function verifyCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (!username || !password) return null;
  if (
    safeEqual(username, settings.adminUser) &&
    safeEqual(password, settings.adminPassword)
  ) {
    return { username, role: 'admin' };
  }
  if (
    settings.viewerUser &&
    settings.viewerPassword &&
    safeEqual(username, settings.viewerUser) &&
    safeEqual(password, settings.viewerPassword)
  ) {
    return { username, role: 'viewer' };
  }
  return null;
}

/**
 * Pull a Bearer token off a request and validate it. Returns a User on
 * success or null on any failure.
 */
export function parseBearer(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  const claims = verifyToken(token);
  if (!claims || !claims.sub || !claims.role) return null;
  return { username: claims.sub, role: claims.role };
}

export function authenticate(req, res, next) {
  const user = parseBearer(req);
  if (!user) return unauthorized(res, 'Invalid or missing bearer token');
  req.user = user;
  // Tag the request's ALS context so every downstream log line and the
  // morgan access-log line include the authenticated user/role.
  patchContext({ user });
  next();
}

/**
 * Require the caller to be the admin role.
 *
 * `requireAdmin` checks ONLY the role. Whether the operation is also
 * gated by `ALLOW_DESTRUCTIVE` is a separate, opt-in concern handled by
 * `requireDestructive` below — and tagged per-route via `destructive: true`
 * in the route spec. This split lets operators run with
 * `ALLOW_DESTRUCTIVE=false` while still permitting non-destructive
 * admin work like editing volume files or creating networks.
 */
export function requireAdmin(req, res, next) {
  if (!req.user) return unauthorized(res);
  if (req.user.role !== 'admin') {
    return forbidden(res, 'Admin role required for this action');
  }
  next();
}

/**
 * Refuse routes tagged `destructive: true` when ALLOW_DESTRUCTIVE is
 * off. Intended for Docker state-changing operations that can't be
 * easily undone: volume remove / prune, container kill / remove,
 * image / network / system prune, stack down, etc. NOT applied to
 * filesystem mutations inside a volume (chmod, edit, mkdir, …) — for
 * those, admin role is the only gate.
 */
export function requireDestructive(req, res, next) {
  if (!settings.allowDestructive) {
    return forbidden(res, 'Destructive actions are disabled (ALLOW_DESTRUCTIVE=false)');
  }
  next();
}
