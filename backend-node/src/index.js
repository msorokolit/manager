// FastAPI-equivalent entrypoint for the Docker Manager Node.js backend.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';

import { settings, VERSION } from './config.js';
import { sendError } from './util.js';

import systemRouter from './routes/system.js';
import containersRouter from './routes/containers.js';
import imagesRouter from './routes/images.js';
import networksRouter from './routes/networks.js';
import volumesRouter from './routes/volumes.js';
import volumeBrowserRouter from './routes/volume-browser.js';
import stacksRouter from './routes/stacks.js';
import registriesRouter from './routes/registries.js';
import execRouter, { handleExecWebSocket } from './routes/exec.js';

const app = express();

if (settings.corsOrigins.length) {
  // Lightweight inline CORS — avoids an extra dep.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && settings.corsOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.set(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Requested-With',
      );
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
}

app.use(express.json({ limit: '10mb' }));

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

// Resource routers — base paths intentionally match the Python backend.
app.use('/api/system', systemRouter);
app.use('/api/containers', containersRouter);
app.use('/api/images', imagesRouter);
app.use('/api/networks', networksRouter);
app.use('/api/volumes', volumesRouter);
app.use('/api/volumes', volumeBrowserRouter); // mount on the same base; routes don't collide
app.use('/api/stacks', stacksRouter);
app.use('/api/registries', registriesRouter);
app.use('/api/exec', execRouter);

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
