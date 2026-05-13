// Shared helpers.
import { dockerError } from './docker-client.js';

export class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Wrap an async route handler so thrown errors propagate to the central
 * error middleware (Express 4 doesn't auto-catch async rejections).
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function sendError(res, err) {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    return res.status(err.status).json({ detail: err.detail });
  }
  const mapped = dockerError(err);
  res.status(mapped.status).json({ detail: mapped.detail });
}

/**
 * Write a chunk to `res`, applying back-pressure: if the kernel send buffer
 * is full, pause every source in `sources` until 'drain' fires. This
 * prevents the Node process from buffering an unbounded amount of data when
 * a client reads slower than the server can produce.
 *
 * Returns true if the chunk was accepted synchronously, false if a pause
 * was needed (callers can use this to bail early on closed connections).
 */
export function writeWithBackpressure(res, chunk, sources = []) {
  if (res.writableEnded || res.destroyed) return false;
  const ok = res.write(chunk);
  if (!ok) {
    for (const s of sources) {
      try {
        s.pause && s.pause();
      } catch {}
    }
    res.once('drain', () => {
      for (const s of sources) {
        try {
          s.resume && s.resume();
        } catch {}
      }
    });
  }
  return ok;
}

/** Stream NDJSON lines from a Readable that emits raw bytes. */
export function pipeNdjson(stream, res) {
  res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length) writeWithBackpressure(res, line + '\n', [stream]);
    }
  });
  stream.on('end', () => {
    if (buf.length) writeWithBackpressure(res, buf + '\n', [stream]);
    res.end();
  });
  stream.on('error', (err) => {
    try {
      res.write(JSON.stringify({ error: err.message }) + '\n');
    } catch {}
    res.end();
  });
  res.on('close', () => {
    try {
      stream.destroy();
    } catch {}
  });
}

/** Stream raw bytes from a Readable to the response (for log/stats follow). */
export function pipeRaw(stream, res, contentType = 'text/plain; charset=utf-8') {
  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'no-store');
  stream.on('data', (chunk) => writeWithBackpressure(res, chunk, [stream]));
  stream.on('end', () => res.end());
  stream.on('error', () => res.end());
  res.on('close', () => {
    try {
      stream.destroy();
    } catch {}
  });
}

/** Parse a port from req.query as an int with default + bounds. */
export function intQuery(v, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function boolQuery(v, fallback = false) {
  if (v == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
