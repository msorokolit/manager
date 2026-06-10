// Rate limiting + per-user concurrency caps.
//
// Three layers, all opt-out via RATE_LIMIT_DISABLED=true:
//
//   - globalLimiter()          IP-keyed, generous, applied app-wide
//   - loginLimiter()           IP-keyed, tight (credential stuffing)
//   - expensiveConcurrency()   user-keyed, bounded simultaneous in-flight
//                              count for endpoints that move a lot of bytes
//                              (image pull, compose up/pull/down, stack
//                              create-with-deploy)
//
// All three return Express middleware. They all silently no-op if
// settings.rateLimitDisabled is true so tests can run un-throttled.

import rateLimit from 'express-rate-limit';
import { settings } from './config.js';

function noop() {
  return (_req, _res, next) => next();
}

/**
 * IP-keyed app-wide limiter. `opts` overrides are accepted for testing and
 * for routes that want a non-default budget.
 */
export function globalLimiter(opts = {}) {
  if (settings.rateLimitDisabled) return noop();
  return rateLimit({
    windowMs: opts.windowMs ?? 60 * 1000,
    limit: opts.limit ?? settings.rateLimitGlobalPerMin,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: opts.keyGenerator,
    message: { detail: 'Too many requests' },
  });
}

/** IP-keyed tight limiter intended for /api/auth/login. */
export function loginLimiter(opts = {}) {
  if (settings.rateLimitDisabled) return noop();
  return rateLimit({
    windowMs: opts.windowMs ?? 60 * 1000,
    limit: opts.limit ?? settings.rateLimitLoginPerMin,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: opts.keyGenerator,
    message: { detail: 'Too many login attempts; slow down.' },
    skipSuccessfulRequests: false,
  });
}

// ---------- Per-user concurrency cap ----------

const inFlight = new Map(); // user -> count

function userKey(req) {
  return (req.user && req.user.username) || req.ip || 'anon';
}

/**
 * Express middleware that limits the number of concurrent in-flight requests
 * per authenticated user across the routes it's attached to. Releases on
 * response finish OR client disconnect.
 *
 * Apply *after* `authenticate` so req.user is populated.
 */
export function expensiveConcurrency() {
  const cap = settings.expensiveConcurrencyPerUser;
  if (settings.rateLimitDisabled || cap <= 0) return noop();
  return (req, res, next) => {
    const key = userKey(req);
    const cur = inFlight.get(key) || 0;
    if (cur >= cap) {
      return res.status(429).json({
        detail: `Too many concurrent expensive requests (max ${cap})`,
      });
    }
    inFlight.set(key, cur + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const v = (inFlight.get(key) || 1) - 1;
      if (v <= 0) inFlight.delete(key);
      else inFlight.set(key, v);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

// Visible-for-testing: clear the in-flight map between tests.
export function _resetForTests() {
  inFlight.clear();
}
