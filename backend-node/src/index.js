// Entrypoint for the Docker Manager Node.js backend.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { WebSocketServer } from 'ws';

import { settings, VERSION } from './config.js';
import { sendError } from './util.js';
import { buildOpenApiSpec } from './openapi.js';
import { globalLimiter, loginLimiter } from './rate-limit.js';
import { logger } from './logger.js';
import { requestContext } from './request-context.js';

import authApi from './routes/auth.js';
import auditApi from './routes/audit.js';
import systemApi from './routes/system.js';
import containersApi from './routes/containers.js';
import imagesApi from './routes/images.js';
import networksApi from './routes/networks.js';
import volumesApi from './routes/volumes.js';
import volumeBrowserApi, {
  ensureBrowserImage,
} from './routes/volume-browser.js';
import { isAllowedWsOrigin } from './ws-origin.js';
import stacksApi from './routes/stacks.js';
import registriesApi from './routes/registries.js';
import execApi, { handleExecWebSocket } from './routes/exec.js';

// Every routes/* file exposes { basePath, router, operations } via
// createApiRouter. Listing them here is the only place index.js needs to know
// about new resource modules — both Express mounting and the OpenAPI spec
// flow from this list.
const apis = [
  authApi,
  auditApi,
  systemApi,
  containersApi,
  imagesApi,
  networksApi,
  volumesApi,
  volumeBrowserApi,
  stacksApi,
  registriesApi,
  execApi,
];

const app = express();

// Trust the first hop so Express handles X-Forwarded-* correctly when run
// behind a reverse proxy (Caddy / Traefik / nginx / an ingress).
app.set('trust proxy', 1);

// ---------- Per-request context (correlation ID + ALS) ----------
//
// Must be the very first middleware so the AsyncLocalStorage frame
// wraps every subsequent middleware + handler. Mints `req.requestId`,
// echoes `X-Request-Id` on the response, populates the ALS store the
// logger reads via its `mixin`.
app.use(requestContext);

// ---------- HTTP access log (morgan → pino) ----------
//
// One line per request, structured. We use a custom token set so the
// fields land as a single info-level log record. The body stream pipes
// trimmed lines straight into the pino logger so the access log shares
// the same destination + formatting as the application log — one
// stream out to journald / docker logs / a sidecar shipper.
//
// The format isn't morgan's `combined` — fields are pre-split because
// pino's structured output beats a unified text format for indexing.
morgan.token('id', (req) => req.requestId || '-');
morgan.token('user', (req) => (req.user && req.user.username) || '-');
morgan.token('role', (req) => (req.user && req.user.role) || '-');
// Slim format because every line lands inside the JSON wrapper from
// pino — including request_id from the ALS mixin is redundant but kept
// in the format string so the line stays self-describing if pino's
// transport is bypassed (e.g. when piping to stderr from a sidecar).
const morganFormat =
  ':id :remote-addr :user(:role) :method :url :status :res[content-length]b :response-time ms';
app.use(morgan(morganFormat, {
  // /api/health is hammered by docker healthchecks + kubernetes
  // liveness probes — skipping it keeps the access log readable.
  // Same for /api/system/events/stream which intentionally holds the
  // request open for minutes.
  skip: (req) => {
    if (req.path === '/api/health') return true;
    if (req.path === '/api/system/events/stream') return true;
    return false;
  },
  stream: {
    write: (msg) => logger.info({ kind: 'http' }, msg.trim()),
  },
}));

// ---------- Security headers (helmet) ----------
//
// Now that the SPA is bundled with webpack and served entirely from the same
// origin, the CSP is much stricter than it used to be: no third-party hosts,
// no script-src 'unsafe-inline'. We still allow style-src 'unsafe-inline'
// because the SPA uses inline `style="..."` attributes in a few places (e.g.
// the terminal modal), which the CSP spec includes under style-src.
// Operators with custom forks can extend any directive via the CSP_EXTRA_*
// env vars; CSP_DISABLED / HELMET_DISABLED are full escape hatches.
//
// upgradeInsecureRequests is intentionally NOT set: many deployments run
// plain HTTP behind a TLS-terminating reverse proxy, and forcing https in
// the page would break those.
if (!settings.helmetDisabled) {
  const helmetOpts = {
    // COEP=require-corp: every embedded resource has to opt into being
    // loaded by us via Cross-Origin-Resource-Policy. Re-enabled now that
    // the SPA is fully bundled with no CDN scripts; same-origin assets
    // automatically count as same-origin under our same-site CORP, and
    // the only "cross-origin"-looking resources we use are data: URIs
    // (favicon) which aren't subject to COEP. Swagger UI at /api/docs
    // does load cross-origin assets and opts out further down.
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    // Disable HSTS by default — a TLS-terminating proxy is a better place to
    // set Strict-Transport-Security with a deployment-appropriate max-age.
    strictTransportSecurity: false,
  };
  if (settings.cspDisabled) {
    helmetOpts.contentSecurityPolicy = false;
  } else {
    helmetOpts.contentSecurityPolicy = {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...settings.cspExtraScriptSrc],
        styleSrc: ["'self'", "'unsafe-inline'", ...settings.cspExtraStyleSrc],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...settings.cspExtraConnectSrc],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    };
  }
  app.use(helmet(helmetOpts));
}

// ---------- CORS ----------
//
// If CORS_ORIGINS is empty, no Access-Control-* headers are emitted (the SPA
// is served from the same origin as the API, so cross-origin browser requests
// shouldn't normally happen). When set, we enable credentialed CORS for the
// listed origins and reject everything else.
if (settings.corsOrigins.length) {
  app.use(
    cors({
      origin: (origin, cb) => {
        // Same-origin / curl / server-to-server: no Origin header. Always pass.
        if (!origin) return cb(null, true);
        if (settings.corsOrigins.includes(origin)) return cb(null, true);
        // Silent deny: omit ACAO headers so the browser rejects the response
        // (and refuses to send the real request after a failed preflight).
        return cb(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With'],
      exposedHeaders: ['Content-Disposition', 'Content-Length'],
      maxAge: 600,
    }),
  );
}

app.use(express.json({ limit: '10mb' }));

// Global IP-keyed rate limit (no-op when RATE_LIMIT_DISABLED=true). The
// login route adds a tighter, dedicated limiter on top of this further down.
app.use(globalLimiter());

// Meta endpoints
app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', version: VERSION }),
);

app.get('/api/config', (_req, res) => {
  // Cheap check: does the compose binary resolve?
  let composeAvailable = false;
  try {
    const r = spawnSync(settings.composeBin, ['version', '--short'], {
      timeout: 2000,
    });
    composeAvailable = r.status === 0;
  } catch {
    composeAvailable = false;
  }
  res.json({
    version: VERSION,
    allow_destructive: settings.allowDestructive,
    compose_available: composeAvailable,
    stacks_dir: settings.stacksDir,
    exec_default_shell: settings.execDefaultShell,
    browser_image: settings.browserImage,
    registries_file: settings.registriesFile,
    backend: 'node',
  });
});

// Aggregate route operations from every api module and build the OpenAPI
// spec dynamically — adding a route only requires touching its routes/*.js
// file; this section auto-discovers it.
const allOperations = apis.flatMap((a) => a.operations);
const openApiSpec = buildOpenApiSpec(allOperations);

// OpenAPI spec + Swagger UI — public so the spec is browseable without a token.
app.get('/api/openapi.json', (_req, res) => res.json(openApiSpec));
app.use(
  '/api/docs',
  // Swagger UI ships with an inline initializer and pulls a couple of its
  // own assets cross-origin; both of those are blocked by our default
  // CSP and COEP. Strip both headers for the docs sub-tree only — the
  // SPA proper keeps the strict policy.
  (req, res, next) => {
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Cross-Origin-Embedder-Policy');
    next();
  },
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'Docker Manager API',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  }),
);

// Mount every api module on its declared base path. Authentication is now
// per-route (via the route-builder middleware chain), so there's no longer a
// global authenticate middleware up here.
//
// /api/auth/login gets a tighter per-IP limiter on top of the global one to
// slow down credential stuffing. Mount it before the auth router so the
// limiter sees the request first.
app.use('/api/auth/login', loginLimiter());

for (const a of apis) {
  app.use(a.basePath, a.router);
}

// Static SPA serving (mirrors the FastAPI mount).
const staticDir = settings.staticDir;
if (existsSync(staticDir)) {
  app.use('/assets', express.static(staticDir, { fallthrough: true }));
  app.get('/', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  app.get(/^\/(?!api\/|assets\/).*/, async (req, res) => {
    if (req.method !== 'GET') return res.status(405).end();
    // Try to serve a real file under staticDir; fall back to index.html for the SPA.
    const candidate = path.join(staticDir, req.path);
    const base = path.resolve(staticDir);
    const resolved = path.resolve(candidate);
    if (resolved.startsWith(base + path.sep) || resolved === base) {
      try {
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch {
        /* fall through */
      }
    }
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

// 404 for unmatched API paths
app.use('/api', (_req, res) => res.status(404).json({ detail: 'Not Found' }));

// Central error handler.
//
// Every error worth logging (5xx, or unexpected throws) is recorded at
// the right level before being serialised to the client. 4xx errors
// are intentionally NOT logged — they're caller mistakes (validation,
// auth, not-found), not server-side problems, and they'd swamp the
// log otherwise. The audit trail still captures them via the per-route
// `auditMiddleware`.
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ detail: 'Request body too large' });
  }
  const status = err && err.status;
  if (!status || status >= 500) {
    logger.error(
      { err: err && (err.stack || err.message) || String(err), path: req.path, method: req.method },
      'request failed',
    );
  }
  sendError(res, err);
});

const server = http.createServer(app);

// WebSocket: /api/containers/:id/exec
const wss = new WebSocketServer({ noServer: true });
const EXEC_PATH = /^\/api\/containers\/([^/]+)\/exec\/?$/;

function rejectUpgrade(socket, status, reason) {
  // Write a minimal HTTP error response then close. ws's `handleUpgrade`
  // would respond with `Connection: close` but for non-handshakes we own
  // the socket directly. Keeping the response body short avoids tripping
  // strict clients that don't expect data after the status line.
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
      `Content-Length: 0\r\n` +
      `Connection: close\r\n\r\n`,
    );
  } catch { /* socket may already be dead */ }
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  const m = EXEC_PATH.exec(url.pathname);
  if (!m) return rejectUpgrade(socket, 404, 'Not Found');
  if (!isAllowedWsOrigin(req)) return rejectUpgrade(socket, 403, 'Forbidden');
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleExecWebSocket(ws, req, { id: m[1] }).catch((err) => {
      try {
        ws.close(4500, (err && err.message) || 'internal error');
      } catch {}
    });
  });
});

server.listen(settings.port, settings.host, () => {
  logger.info({
    host: settings.host,
    port: settings.port,
    version: VERSION,
    audit_enabled: settings.auditEnabled,
    audit_file: settings.auditEnabled ? settings.auditFile : null,
    log_level: logger.level,
  }, 'docker-manager listening');
  // Pre-pull the volume-browser image in the background so the first
  // browse request doesn't pay the docker-pull cost. Best-effort; if
  // it fails, the first per-op container will retry the pull.
  ensureBrowserImage(logger).catch(() => {});
});

// Graceful shutdown
function shutdown() {
  logger.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
