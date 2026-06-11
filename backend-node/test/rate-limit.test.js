// Rate limiting (C1) — IP-keyed limiters and the per-user concurrency cap.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import request from 'supertest';
import {
  globalLimiter,
  loginLimiter,
  expensiveConcurrency,
  _resetForTests,
} from '../src/rate-limit.js';

beforeEach(() => _resetForTests());

describe('globalLimiter', () => {
  it('caps requests once the budget is exceeded', async () => {
    const app = express();
    // Force a single shared key so the test isn't dependent on the host's
    // IP-detection quirks (IPv4 vs IPv6 loopback).
    app.use(globalLimiter({ limit: 3, keyGenerator: () => 'k' }));
    app.get('/p', (_req, res) => res.json({ ok: true }));
    const agent = request(app);

    for (let i = 0; i < 3; i++) {
      const r = await agent.get('/p');
      expect(r.status).toBe(200);
    }
    const blocked = await agent.get('/p');
    expect(blocked.status).toBe(429);
    expect(blocked.body.detail).toMatch(/too many/i);
  });

  it('emits standard RateLimit headers on every response', async () => {
    const app = express();
    app.use(globalLimiter({ limit: 5, keyGenerator: () => 'k' }));
    app.get('/p', (_req, res) => res.json({ ok: true }));
    const r = await request(app).get('/p');
    expect(r.status).toBe(200);
    // draft-7 emits a single combined `RateLimit` header (e.g.
    // "limit=5, remaining=4, reset=60"); other drafts split it. Accept
    // either shape.
    const combined = r.headers['ratelimit'];
    const limitHeader = r.headers['ratelimit-limit'];
    expect(combined || limitHeader).toBeTruthy();
  });
});

describe('loginLimiter', () => {
  it('blocks after the configured login attempt budget', async () => {
    const app = express();
    app.use(express.json());
    app.use(loginLimiter({ limit: 2, keyGenerator: () => 'k' }));
    app.post('/login', (_req, res) => res.status(401).json({ detail: 'nope' }));
    const agent = request(app);

    const a = await agent.post('/login').send({});
    const b = await agent.post('/login').send({});
    const c = await agent.post('/login').send({});
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(c.status).toBe(429);
  });
});

describe('expensiveConcurrency (per-user cap)', () => {
  // Build an app where each request blocks until the test releases it. Real
  // HTTP client (not supertest) so we can hold requests in flight without
  // awaiting them.
  function makeServer() {
    const releasers = [];
    const app = express();
    app.use((req, _res, next) => {
      req.user = { username: req.get('X-User') || 'anon', role: 'admin' };
      next();
    });
    app.get('/long', expensiveConcurrency(), (_req, res) => {
      releasers.push(() => res.json({ ok: true }));
    });
    return new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({
          base: `http://127.0.0.1:${port}`,
          releasers,
          close: () =>
            new Promise((r) => {
              server.closeAllConnections && server.closeAllConnections();
              server.close(r);
            }),
        });
      });
    });
  }

  /** Fire a request, return a promise resolving to {status, body}. */
  function fetchJson(base, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${base}/long`,
        { method: 'GET', headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              body: (() => {
                try { return JSON.parse(Buffer.concat(chunks).toString()); }
                catch { return Buffer.concat(chunks).toString(); }
              })(),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  /** Fire a request and return the underlying http.ClientRequest so the
   *  caller can abort it. The promise still resolves on response. */
  function fetchJsonAbortable(base, headers = {}) {
    let clientReq;
    const promise = new Promise((resolve, reject) => {
      clientReq = http.request(
        `${base}/long`,
        { method: 'GET', headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        },
      );
      clientReq.on('error', (err) => {
        // ECONNRESET on abort is expected; not a test failure.
        if (err.code === 'ECONNRESET' || err.code === 'ABORTED') resolve({ aborted: true });
        else reject(err);
      });
      clientReq.end();
    });
    return { promise, abort: () => clientReq.destroy() };
  }

  it('rejects the (N+1)th in-flight request for the same user with 429', async () => {
    const srv = await makeServer();
    try {
      // EXPENSIVE_CONCURRENCY_PER_USER defaults to 2; fire two long-runners
      // for alice and don't await them.
      const p1 = fetchJson(srv.base, { 'X-User': 'alice' });
      const p2 = fetchJson(srv.base, { 'X-User': 'alice' });
      await new Promise((r) => setTimeout(r, 50));
      expect(srv.releasers.length).toBe(2);

      // Third one for alice must 429 immediately (handler is never reached,
      // so releasers stays at 2).
      const blocked = await fetchJson(srv.base, { 'X-User': 'alice' });
      expect(blocked.status).toBe(429);
      expect(blocked.body.detail).toMatch(/too many concurrent/i);
      expect(srv.releasers.length).toBe(2);

      // Release the held requests so the test can join.
      srv.releasers.forEach((fn) => fn());
      const results = await Promise.all([p1, p2]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
    } finally {
      await srv.close();
    }
  });

  it('caps are scoped per user — bob is unaffected by alice', async () => {
    const srv = await makeServer();
    try {
      const p1 = fetchJson(srv.base, { 'X-User': 'alice' });
      const p2 = fetchJson(srv.base, { 'X-User': 'alice' });
      await new Promise((r) => setTimeout(r, 50));
      const pBob = fetchJson(srv.base, { 'X-User': 'bob' });
      await new Promise((r) => setTimeout(r, 50));
      expect(srv.releasers.length).toBe(3);

      srv.releasers.forEach((fn) => fn());
      const results = await Promise.all([p1, p2, pBob]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    } finally {
      await srv.close();
    }
  });

  it('frees the slot when the client disconnects mid-request', async () => {
    const srv = await makeServer();
    try {
      // 2 in-flight, then verify the cap.
      const p1 = fetchJson(srv.base, { 'X-User': 'alice' });
      const ab = fetchJsonAbortable(srv.base, { 'X-User': 'alice' });
      await new Promise((r) => setTimeout(r, 50));
      expect(srv.releasers.length).toBe(2);

      const blocked = await fetchJson(srv.base, { 'X-User': 'alice' });
      expect(blocked.status).toBe(429);

      // Abort the second slot; res 'close' should fire on the server,
      // releasing the slot.
      ab.abort();
      await ab.promise;
      await new Promise((r) => setTimeout(r, 50));

      // Now alice can take a slot again.
      const after = fetchJson(srv.base, { 'X-User': 'alice' });
      await new Promise((r) => setTimeout(r, 50));
      expect(srv.releasers.length).toBe(3);

      // Release everyone still hanging.
      srv.releasers.forEach((fn) => fn());
      const [r1, rAfter] = await Promise.all([p1, after]);
      expect(r1.status).toBe(200);
      expect(rAfter.status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});
