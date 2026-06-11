// Runtime configuration loaded from environment variables.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function bool(env, name, fallback = false) {
  const v = env[name];
  if (v == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

function csv(env, name) {
  return (env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build a settings object from an env-like map. Pure function so tests can
 * call `settingsFromEnv({ JWT_TTL_SECONDS: '5' })` without re-importing the
 * module (the module-level `settings` snapshot is frozen at first load).
 */
export function settingsFromEnv(env = process.env) {
  const dataDir = env.DATA_DIR || '/data';
  return {
    adminUser: env.ADMIN_USER || 'admin',
    adminPassword: env.ADMIN_PASSWORD || 'admin',
    viewerUser: env.VIEWER_USER || null,
    viewerPassword: env.VIEWER_PASSWORD || null,
    dockerHost: env.DOCKER_HOST || null,
    allowDestructive: bool(env, 'ALLOW_DESTRUCTIVE', true),
    corsOrigins: csv(env, 'CORS_ORIGINS'),
    // Default points at the webpack-built bundle. Run `npm run build` in
    // frontend/ first, or set STATIC_DIR to a different directory.
    staticDir:
      env.STATIC_DIR ||
      path.resolve(__dirname, '..', '..', 'frontend', 'dist'),
    logTailDefault: parseInt(env.LOG_TAIL_DEFAULT || '200', 10),
    dataDir,
    stacksDir: env.STACKS_DIR || path.join(dataDir, 'stacks'),
    composeBin: env.COMPOSE_BIN || 'docker-compose',
    execDefaultShell: env.EXEC_DEFAULT_SHELL || '/bin/sh',
    registriesFile:
      env.REGISTRIES_FILE || path.join(dataDir, 'registries.json'),
    browserImage: env.BROWSER_IMAGE || 'python:3-alpine',
    port: parseInt(env.PORT || '8000', 10),
    host: env.HOST || '0.0.0.0',
    jwtSecret: env.JWT_SECRET || null,
    // 60s floor, 30d ceiling. Beyond that, rotate via a re-login or use a
    // real token-refresh story (out of scope for this auth model).
    jwtTtlSeconds: Math.min(
      60 * 60 * 24 * 30,
      Math.max(60, parseInt(env.JWT_TTL_SECONDS || '43200', 10)),
    ),
    // ---- Rate limiting (express-rate-limit) ----
    rateLimitDisabled: bool(env, 'RATE_LIMIT_DISABLED', false),
    // Global request budget per IP per minute. Generous because the SPA is
    // chatty (events stream, stats stream, dashboard refresh, etc).
    rateLimitGlobalPerMin: Math.max(
      10,
      parseInt(env.RATE_LIMIT_GLOBAL_PER_MIN || '600', 10),
    ),
    // Tight per-IP limit on /api/auth/login (credential stuffing).
    rateLimitLoginPerMin: Math.max(
      1,
      parseInt(env.RATE_LIMIT_LOGIN_PER_MIN || '10', 10),
    ),
    // Maximum simultaneous expensive operations per user (image pull,
    // compose up/pull/down). Set to 0 to disable the concurrency cap.
    expensiveConcurrencyPerUser: Math.max(
      0,
      parseInt(env.EXPENSIVE_CONCURRENCY_PER_USER || '2', 10),
    ),
    // ---- Subprocess streaming (compose etc.) ----
    // Wall-clock deadline (ms) for a streaming compose subprocess. Default
    // 30 minutes — long enough for a multi-GB image pull but bounded.
    composeDeadlineMs: Math.max(
      1000,
      parseInt(env.COMPOSE_DEADLINE_MS || String(30 * 60 * 1000), 10),
    ),
    // After SIGTERM, wait this long for graceful exit before SIGKILL.
    composeKillGraceMs: Math.max(
      100,
      parseInt(env.COMPOSE_KILL_GRACE_MS || '10000', 10),
    ),
    // ---- Logging + audit ----
    // Standard pino log levels: trace, debug, info, warn, error, fatal,
    // silent. Default `info` is right for production; bump to `debug`
    // for local troubleshooting.
    logLevel: env.LOG_LEVEL || null,
    // When true, output through pino-pretty (human-readable colour log
    // lines) instead of raw JSON. Off by default — production wants JSON
    // for log shippers.
    logPretty: bool(env, 'LOG_PRETTY', false),
    // Audit log: append-only JSONL record of every mutating action
    // through the API. Stored separately from the app log so it can be
    // retained / shipped independently.
    auditEnabled: bool(env, 'AUDIT_ENABLED', true),
    auditFile: env.AUDIT_FILE || path.join(dataDir, 'audit.log'),
    // In-process size-based rotation. Set to 0 to disable rotation
    // entirely (when a log shipper or external logrotate handles it).
    auditMaxBytes: Math.max(
      0,
      parseInt(env.AUDIT_MAX_BYTES || String(10 * 1024 * 1024), 10),
    ),
    auditRotateKeep: Math.max(
      1,
      parseInt(env.AUDIT_ROTATE_KEEP || '5', 10),
    ),
    // ---- Sessions (server-side store; see src/sessions.js) ----
    // Persistence file. The store flushes here on a debounce so a
    // restart doesn't sign every user out. Mode 0600 on every write.
    sessionsFile: env.SESSIONS_FILE || path.join(dataDir, 'sessions.json'),
    // How often the in-memory store flushes dirty rows to disk.
    // Higher = less I/O; lower = smaller "session lost on crash"
    // window. Default 30s splits the difference for an admin tool.
    sessionsPersistIntervalMs: Math.max(
      1000,
      parseInt(env.SESSIONS_PERSIST_INTERVAL_MS || '30000', 10),
    ),
    // Cap concurrent sessions per user; oldest is evicted when a new
    // login would exceed it. 0 = unlimited (the default). Set to 1
    // for environments that mandate a single active session per
    // principal (banks / SOC).
    sessionsMaxPerUser: Math.max(
      0,
      parseInt(env.SESSIONS_MAX_PER_USER || '0', 10),
    ),
    // ---- Volume-browser one-shot containers ----
    // Wall-clock cap on any single helper-container operation. A hung
    // python script or runaway recursive chmod would otherwise pin
    // the HTTP request open forever. 90s is generous for chmod -R on
    // a deep tree but bounded; 0 disables (not recommended).
    volumeBrowserOpTimeoutMs: Math.max(
      0,
      parseInt(env.VOLUME_BROWSER_OP_TIMEOUT_MS || '90000', 10),
    ),
    // Escape hatch: skip Memory / NanoCpus / PidsLimit on the per-op
    // container. Only useful on hosts where the root cgroup is in
    // "domain threaded" mode (nested CI VMs, some sandboxed runners),
    // which makes runc refuse to enter cgroup v2 with domain controllers
    // attached. The CapDrop: ALL stays applied so the container's
    // capability surface remains minimal even with this flag on.
    // Keep this OFF in production.
    volumeBrowserNoLimits: (env.VOLUME_BROWSER_NO_LIMITS || '').toLowerCase() === 'true',
    // ---- Security headers (helmet) ----
    helmetDisabled: bool(env, 'HELMET_DISABLED', false),
    cspDisabled: bool(env, 'CSP_DISABLED', false),
    cspExtraScriptSrc: csv(env, 'CSP_EXTRA_SCRIPT_SRC'),
    cspExtraStyleSrc: csv(env, 'CSP_EXTRA_STYLE_SRC'),
    cspExtraConnectSrc: csv(env, 'CSP_EXTRA_CONNECT_SRC'),
  };
}

/**
 * The frozen, process-wide settings snapshot. Loaded at module import time
 * from `process.env`. Tests that need to vary settings should call
 * settingsFromEnv() directly with their own env map.
 */
export const settings = Object.freeze(settingsFromEnv());

export const VERSION = '0.1.0';
