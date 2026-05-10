// HTTP Basic auth with two roles: admin (full) and viewer (read-only).
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { settings } from './config.js';

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

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Basic realm="Docker Manager"');
  return res.status(401).json({ detail: 'Invalid credentials' });
}

/**
 * Parse Basic credentials from a request and return either a `User` or null.
 * Used both by the Express middleware and the WebSocket-ticket endpoint.
 */
export function parseBasic(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || !h.startsWith('Basic ')) return null;
  let decoded;
  try {
    decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);

  if (
    safeEqual(user, settings.adminUser) &&
    safeEqual(pass, settings.adminPassword)
  ) {
    return { username: user, role: 'admin' };
  }
  if (
    settings.viewerUser &&
    settings.viewerPassword &&
    safeEqual(user, settings.viewerUser) &&
    safeEqual(pass, settings.viewerPassword)
  ) {
    return { username: user, role: 'viewer' };
  }
  return null;
}

export function authenticate(req, res, next) {
  const user = parseBasic(req);
  if (!user) return unauthorized(res);
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return unauthorized(res);
  if (req.user.role !== 'admin') {
    return res.status(403).json({ detail: 'Admin role required for this action' });
  }
  if (!settings.allowDestructive) {
    return res
      .status(403)
      .json({ detail: 'Destructive actions are disabled (ALLOW_DESTRUCTIVE=false)' });
  }
  next();
}
