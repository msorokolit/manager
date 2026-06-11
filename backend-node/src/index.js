// Entrypoint for the Docker Manager Node.js backend.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { WebSocketServer } from 'ws';

import { settings, VERSION } from './config.js';
import { sendError } from './util.js';
import { buildOpenApiSpec } from './openapi.js';
import { globalLimiter, loginLimiter } from './rate-limit.js';

import authApi from './routes/auth.js';
import systemApi from './routes/system.js';
import containersApi from './routes/containers.js';
import imagesApi from './routes/images.js';
import networksApi from './routes/networks.js';
import volumesApi from './routes/volumes.js';
import volumeBrowserApi from './routes/volume-browser.js';
import stacksApi from './routes/stacks.js';
import registriesApi from './routes/registries.js';
import execApi, { handleExecWebSocket } from './routes/exec.js';

// Every routes/* file exposes { basePath, router, operations } via
// createApiRouter. Listing them here is the only place index.js needs to know
// about new resource modules — both Express mounting and the OpenAPI spec
// flow from this list.
const apis = [
  authApi,
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
    crossOriginEmbedderPolicy: false,
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
  // Tighten CSP slightly for the docs page so the inline initializer Swagger
  // UI ships with isn't blocked.
  (req, res, next) => {
    res.removeHeader('Content-Security-Policy');
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

// Central error handler
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ detail: 'Request body too large' });
  }
  sendError(res, err);
});

const server = http.createServer(app);

// WebSocket: /api/containers/:id/exec
const wss = new WebSocketServer({ noServer: true });
const EXEC_PATH = /^\/api\/containers\/([^/]+)\/exec\/?$/;

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    return socket.destroy();
  }
  const m = EXEC_PATH.exec(url.pathname);
  if (!m) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleExecWebSocket(ws, req, { id: m[1] }).catch((err) => {
      try {
        ws.close(4500, (err && err.message) || 'internal error');
      } catch {}
    });
  });
});

server.listen(settings.port, settings.host, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[docker-manager] listening on http://${settings.host}:${settings.port} (backend=node, version=${VERSION})`,
  );
});

// Graceful shutdown
function shutdown() {
  // eslint-disable-next-line no-console
  console.log('[docker-manager] shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
