// Container exec ticket endpoint. The actual WebSocket handling lives in
// `attachExecWebSocket` because it needs to hook the HTTP server's upgrade
// event rather than be expressed as an Express route.
import { Router } from 'express';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { authenticate } from '../auth.js';
import { settings } from '../config.js';
import { getClient } from '../docker-client.js';
import { asyncHandler, HttpError } from '../util.js';

const router = Router();

const TICKET_TTL_MS = 60_000;
const tickets = new Map(); // token -> { user, role, expires }

function gc() {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
}

router.post(
  '/ticket',
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      throw new HttpError(403, 'Exec requires admin role');
    }
    gc();
    const token = randomBytes(24).toString('base64url');
    tickets.set(token, {
      user: req.user.username,
      role: req.user.role,
      expires: Date.now() + TICKET_TTL_MS,
    });
    res.json({ ticket: token, expires_in: Math.floor(TICKET_TTL_MS / 1000) });
  }),
);

function consumeTicket(token) {
  gc();
  if (!token) return null;
  const rec = tickets.get(token);
  if (!rec) return null;
  tickets.delete(token);
  if (rec.expires < Date.now()) return null;
  return rec;
}

/**
 * Attach a path-matching WebSocket handler to a `ws.WebSocketServer` running
 * in `noServer` mode. Called from index.js's upgrade handler.
 */
export async function handleExecWebSocket(ws, req, params) {
  const url = new URL(req.url, 'http://x');
  const ticket = url.searchParams.get('ticket') || '';
  const cmd = url.searchParams.get('cmd') || settings.execDefaultShell;
  const cols = parseInt(url.searchParams.get('cols') || '80', 10) || 80;
  const rows = parseInt(url.searchParams.get('rows') || '24', 10) || 24;

  const rec = consumeTicket(ticket);
  if (!rec) return ws.close(4401, 'invalid ticket');
  if (rec.role !== 'admin') return ws.close(4403, 'admin required');

  let docker, container;
  try {
    docker = getClient();
    container = docker.getContainer(params.id);
    await container.inspect();
  } catch (err) {
    if (err.statusCode === 404) return ws.close(4404, 'container not found');
    return ws.close(4503, 'daemon unreachable');
  }

  const argv = cmd.includes(' ') ? ['sh', '-c', cmd] : [cmd];

  let exec, stream;
  try {
    exec = await container.exec({
      Cmd: argv,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    stream = await exec.start({ hijack: true, stdin: true });
    try {
      await exec.resize({ h: rows, w: cols });
    } catch {}
  } catch (err) {
    return ws.close(4500, (err.message || 'exec failed').slice(0, 120));
  }

  let closed = false;
  function shutdown() {
    if (closed) return;
    closed = true;
    try {
      stream.end();
    } catch {}
    try {
      stream.destroy();
    } catch {}
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      try {
        ws.close();
      } catch {}
    }
  }

  stream.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(chunk);
      } catch {}
    }
  });
  stream.on('end', shutdown);
  stream.on('error', shutdown);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      try {
        stream.write(data);
      } catch {}
      return;
    }
    const text = data.toString('utf8');
    if (text.startsWith('{')) {
      try {
        const obj = JSON.parse(text);
        if (obj.type === 'resize') {
          exec
            .resize({ h: parseInt(obj.rows, 10) || 24, w: parseInt(obj.cols, 10) || 80 })
            .catch(() => {});
          return;
        }
      } catch {}
    }
    try {
      stream.write(text);
    } catch {}
  });
  ws.on('close', shutdown);
  ws.on('error', shutdown);
}

export default router;
