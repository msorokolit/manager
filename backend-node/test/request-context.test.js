// Per-request correlation ID + AsyncLocalStorage propagation.
//
// Three properties we test:
//   1. A request without an X-Request-Id header gets a freshly minted
//      UUID v4; the same id is echoed back on the response.
//   2. A request WITH a syntactically valid X-Request-Id is honoured —
//      our middleware passes it through verbatim so trace IDs from an
//      upstream proxy survive end-to-end.
//   3. A request with a malformed X-Request-Id is silently replaced
//      with a freshly minted one (no log injection vector via
//      newlines / shell metachars).
//   4. The ALS context populated by the middleware reaches a Promise
//      continuation `setImmediate`d from inside the handler — the
//      whole point of using ALS over per-call .child() loggers.
//
// We don't test pino's output here (the logger has its own tests in
// the integration suite) — request-context.js is a tiny middleware and
// stays isolated.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestContext } from '../src/request-context.js';
import { currentContext } from '../src/logger.js';

function buildApp(handler) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(requestContext);
  app.get('/probe', handler);
  return app;
}

describe('requestContext middleware', () => {
  it('mints a UUID v4 request id when no X-Request-Id header is supplied', async () => {
    const observed = { reqId: null, headerOut: null };
    const r = await request(buildApp((req, res) => {
      observed.reqId = req.requestId;
      res.json({ ok: true });
    })).get('/probe');
    expect(r.status).toBe(200);
    observed.headerOut = r.headers['x-request-id'];
    // UUID v4 shape (8-4-4-4-12 hex, version 4 nibble at the right spot).
    expect(observed.reqId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(observed.headerOut).toBe(observed.reqId);
  });

  it('honours a valid X-Request-Id from upstream', async () => {
    const upstreamId = 'trace-abc.def_123:42';
    const r = await request(buildApp((req, res) => {
      res.json({ id: req.requestId });
    }))
      .get('/probe')
      .set('X-Request-Id', upstreamId);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(upstreamId);
    expect(r.headers['x-request-id']).toBe(upstreamId);
  });

  it('rejects malformed X-Request-Id (shell-metachar / space / quote injection)', async () => {
    // The Node http client refuses to *send* headers containing
    // newlines / CR / NUL — that protection is upstream of us. What
    // CAN reach us is a header with spaces, dollar-paren, semicolons,
    // backticks, or other shell metacharacters. Our safelist rejects
    // those and replaces them with a freshly minted UUID.
    const malicious = 'abc def$(rm -rf /); echo;`whoami`';
    const r = await request(buildApp((req, res) => {
      res.json({ id: req.requestId });
    }))
      .get('/probe')
      .set('X-Request-Id', malicious);
    expect(r.status).toBe(200);
    expect(r.body.id).not.toBe(malicious);
    expect(r.body.id).toMatch(/^[0-9a-f]{8}-/);
  });

  it('rejects too-short X-Request-Id (< 8 chars)', async () => {
    const r = await request(buildApp((req, res) => {
      res.json({ id: req.requestId });
    }))
      .get('/probe')
      .set('X-Request-Id', 'short');
    expect(r.status).toBe(200);
    expect(r.body.id).not.toBe('short');
  });

  it('rejects too-long X-Request-Id (> 128 chars)', async () => {
    const huge = 'x'.repeat(129);
    const r = await request(buildApp((req, res) => {
      res.json({ id: req.requestId });
    }))
      .get('/probe')
      .set('X-Request-Id', huge);
    expect(r.body.id).not.toBe(huge);
  });

  it('AsyncLocalStorage context survives await + setImmediate boundaries', async () => {
    const observed = {};
    const r = await request(buildApp(async (req, res) => {
      observed.atTop = currentContext();
      await Promise.resolve();
      observed.afterAwait = currentContext();
      await new Promise((resolve) => setImmediate(resolve));
      observed.afterSetImmediate = currentContext();
      res.json({ ok: true });
    })).get('/probe').set('X-Request-Id', 'als-propagation-test');

    expect(r.status).toBe(200);
    expect(observed.atTop?.requestId).toBe('als-propagation-test');
    expect(observed.afterAwait?.requestId).toBe('als-propagation-test');
    expect(observed.afterSetImmediate?.requestId).toBe('als-propagation-test');
  });

  it('two concurrent requests get isolated contexts (no cross-contamination)', async () => {
    // Race two requests with different ids and observe each handler's
    // view of the context — they must see their own id, not the
    // other's.
    const captured = [];
    const app = buildApp(async (req, res) => {
      // Add a small async delay so the requests are guaranteed to
      // overlap inside the handler.
      await new Promise((r) => setTimeout(r, 5));
      captured.push({
        sentId: req.headers['x-request-id'],
        observedReqId: currentContext()?.requestId,
      });
      res.json({ ok: true });
    });
    await Promise.all([
      request(app).get('/probe').set('X-Request-Id', 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'),
      request(app).get('/probe').set('X-Request-Id', 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'),
    ]);
    for (const c of captured) {
      expect(c.sentId).toBe(c.observedReqId);
    }
  });
});
