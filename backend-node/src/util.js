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
  // Let the audit middleware see the original error before we serialize
  // it — the on('finish') hook can't read the response body, so we
  // hand it the message directly.
  if (res.locals && typeof res.locals.auditCaptureError === 'function') {
    try { res.locals.auditCaptureError(err); } catch { /* never fail responding */ }
  }
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

/**
 * Run an async `worker(item)` over `items` with bounded parallelism.
 * Results are returned in request order so the SPA's row-by-row report
 * lines up with the user's selection.
 *
 * Used by every bulk endpoint: containers (start/stop/rm/…), images,
 * stacks (up/down/rm), volumes (rm), networks (rm), registries (rm).
 * Centralising this here lets us tune the concurrency cap in one spot
 * and gives every endpoint the same predictable order semantics.
 */
export async function runBoundedParallel(items, worker, concurrency = 5) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const settled = await Promise.all(slice.map((it) => worker(it)));
    for (let j = 0; j < settled.length; j++) out[i + j] = settled[j];
  }
  return out;
}

/**
 * Map a dockerode error to a short, action-appropriate user-facing string.
 * Picks the daemon's `message` when available (it's usually descriptive
 * — "container is already paused", "Conflict, You cannot remove a
 * running container" etc.) and shortens it.
 */
export function bulkErrorString(err, fallback = 'unknown error') {
  if (!err) return fallback;
  if (err.statusCode === 404) return 'Not found';
  if (err.statusCode === 409) return err.message || 'Conflict';
  if (err.statusCode === 304) return 'Already in target state';
  if (err.statusCode === 500) return err.message || 'Daemon error';
  return err.message || fallback;
}

/**
 * Roll a per-item results array into the canonical bulk-response shape
 * the SPA expects. Every bulk endpoint emits exactly this envelope:
 *   { succeeded, failed, results: [{id|name, ok, error?}] }
 */
export function summariseBulk(results) {
  return {
    succeeded: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
    results,
  };
}
