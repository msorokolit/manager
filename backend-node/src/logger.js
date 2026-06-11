// Structured application logger + per-request context propagation.
//
// Built on pino (fast, schema-light JSON logger) with Node's
// `AsyncLocalStorage` so every log call anywhere in the request
// lifecycle automatically picks up request_id, actor, and source IP
// without anyone having to plumb `req` to every callsite.
//
// Why pino?
//   - JSON-by-default output works directly with log aggregators
//     (loki, elasticsearch, cloudwatch, datadog) — no parser needed.
//   - Very low overhead. Production-friendly without sampling tricks.
//   - `pino-pretty` is a separate dev dependency so production
//     containers don't pay the pretty-printing cost.
//
// Why AsyncLocalStorage?
//   - The alternative — passing `logger.child({req_id})` to every
//     internal function — turns into 100 plumbing diffs that nobody
//     gets right consistently. ALS makes it invisible: middleware
//     calls `runWithContext()` once per request, and every nested
//     await still finds the same context.
//
// Usage:
//   import { logger, runWithContext, currentContext } from './logger.js';
//   logger.info({ kind: 'pull' }, 'pulled image');
//   // → {"level":30,"time":...,"request_id":"abc","user":"admin",
//   //    "role":"admin","kind":"pull","msg":"pulled image"}

import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import { settings } from './config.js';

const als = new AsyncLocalStorage();

/**
 * Run `fn` with the given context attached to the async chain. All
 * `logger.*` calls inside (including from any nested awaits / Promise
 * continuations) will be automatically tagged with this context.
 */
export function runWithContext(ctx, fn) {
  return als.run(ctx, fn);
}

/**
 * Return the current request's context, or null when called outside
 * any request (e.g. from a CLI command or startup code).
 */
export function currentContext() {
  return als.getStore() || null;
}

/**
 * Update fields on the current context in place. Used by the auth
 * middleware to add `user`/`role` once the JWT has been validated.
 */
export function patchContext(patch) {
  const ctx = als.getStore();
  if (ctx) Object.assign(ctx, patch);
}

// In test environments we silence by default (set LOG_LEVEL=info/debug
// explicitly to see output). Production gets pretty-printing only when
// LOG_PRETTY=true is set; otherwise raw JSON.
const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST_WORKER_ID;
const level =
  settings.logLevel ||
  (isTest ? 'silent' : 'info');

const pinoOptions = {
  level,
  // mixin runs on every log call and merges its return value into the
  // emitted record. We use it to thread the request context through
  // automatically — no per-call .child() boilerplate.
  mixin() {
    const ctx = als.getStore();
    if (!ctx) return {};
    const out = {};
    if (ctx.requestId) out.request_id = ctx.requestId;
    if (ctx.user) {
      out.user = ctx.user.username;
      out.role = ctx.user.role;
    }
    if (ctx.sessionId) out.session_id = ctx.sessionId;
    if (ctx.sourceIp) out.source_ip = ctx.sourceIp;
    return out;
  },
  // Redact a small set of obvious secret keys defensively — operators
  // logging request bodies shouldn't accidentally leak credentials.
  redact: {
    paths: [
      'password', 'token', 'secret', 'authorization',
      '*.password', '*.token', '*.secret', '*.authorization',
      'req.headers.authorization', 'req.headers.cookie',
      'body.password', 'body.token', 'body.secret',
    ],
    censor: '[REDACTED]',
    remove: false,
  },
  base: { service: 'docker-manager' },
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Pretty-printing through pino-pretty transport. Only active when the
// operator opts in (typically local dev with `LOG_PRETTY=true npm start`).
if (settings.logPretty && !isTest) {
  pinoOptions.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname,service',
    },
  };
}

export const logger = pino(pinoOptions);

// Visible-for-testing only.
export const _internals = { als };
