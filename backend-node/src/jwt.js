// Tiny wrapper around jsonwebtoken with a single HS256 signing key.
//
// In production set JWT_SECRET to a long random string so tokens survive
// restarts. If unset, a random secret is generated on startup and a warning
// is logged — convenient for local dev, but every restart invalidates
// outstanding sessions and forces operators to re-login.
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { settings } from './config.js';

const ALG = 'HS256';

let secret = settings.jwtSecret;
if (!secret) {
  secret = randomBytes(32).toString('base64url');
  // Lazy-import the logger to avoid a startup-order cycle (config →
  // logger → pino transports, all imported eagerly). Falling back to
  // console.warn keeps the warning visible even if the logger module
  // hasn't fully initialised yet.
  try {
    const { logger } = await import('./logger.js');
    logger.warn(
      'JWT_SECRET is not set; generated an ephemeral one. ' +
        'Sessions will be invalidated on every restart. ' +
        'Set JWT_SECRET in production.',
    );
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      '[docker-manager] JWT_SECRET is not set; generated an ephemeral one. ' +
        'Set JWT_SECRET in production.',
    );
  }
}

/**
 * Sign a payload as a JWT with `expiresIn` seconds.
 * Returns { token, expires_in } so callers can echo the TTL to clients.
 */
export function signToken(payload, ttlSeconds = settings.jwtTtlSeconds) {
  const token = jwt.sign(payload, secret, {
    algorithm: ALG,
    expiresIn: ttlSeconds,
  });
  return { token, expires_in: ttlSeconds };
}

/**
 * Verify a JWT. Returns the decoded claims object on success, or null on
 * any failure (bad signature, expired, malformed, wrong algorithm).
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    return jwt.verify(token, secret, { algorithms: [ALG] });
  } catch {
    return null;
  }
}
