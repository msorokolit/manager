// Session store + auth integration + revocation endpoints.
//
// Three layers under test:
//
//   1. The in-memory store (`src/sessions.js`)
//      - create/get/touch/revoke/revokeForUser/revokeAll
//      - expiry auto-drop on get()
//      - per-user concurrent cap (SESSIONS_MAX_PER_USER)
//      - disk persistence round-trip
//      - sweep
//
//   2. The auth middleware (`src/auth.js`)
//      - rejects a token whose jti is missing from the store
//        (the core revocation-works guarantee)
//      - rejects a token with no jti at all
//      - rejects a token whose claim shape doesn't match the session
//
//   3. The REST endpoints (routes/auth.js)
//      - /logout drops only the current session
//      - /logout-all drops every session for the caller (with optional
//        keep_current)
//      - /sessions lists own sessions, /sessions/all is admin-only
//      - /sessions/:id/revoke gated to owner OR admin
//      - /sessions/revoke-user/:u is admin-only
//      - /sessions/revoke-all is admin-only; spares caller by default
//
// Same hoisted-env-var pattern as audit.test.js — we point
// SESSIONS_FILE at a temp path before config.js freezes settings.

import {
  describe, it, expect, beforeAll, beforeEach, afterAll, vi,
} from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

const { SESSIONS_TMP_FILE, AUDIT_TMP_FILE } = vi.hoisted(() => {
  const tmp = process.env.TMPDIR || '/tmp';
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const sess = `${tmp.replace(/\/$/, '')}/sessions-${suffix}.json`;
  const aud = `${tmp.replace(/\/$/, '')}/sessions-audit-${suffix}.log`;
  process.env.SESSIONS_FILE = sess;
  // Flush quickly so persistence tests don't have to wait 30s.
  process.env.SESSIONS_PERSIST_INTERVAL_MS = '50';
  process.env.AUDIT_FILE = aud;
  process.env.AUDIT_ENABLED = 'true';
  process.env.AUDIT_MAX_BYTES = '0';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sessions';
  process.env.ADMIN_USER = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pw';
  process.env.VIEWER_USER = 'viewer';
  process.env.VIEWER_PASSWORD = 'viewer-pw';
  process.env.LOG_LEVEL = 'silent';
  return { SESSIONS_TMP_FILE: sess, AUDIT_TMP_FILE: aud };
});

// Mock docker-client so importing route modules doesn't try to dial
// a daemon. None of these tests touch Docker.
vi.mock('../src/docker-client.js', () => ({
  getClient: () => ({}),
  dockerError: (e) => ({ status: e.statusCode || 500, detail: e.message || 'docker error' }),
}));

const {
  createSession, getSession, touchSession,
  revokeSession, revokeForUser, revokeAll,
  listSessions, loadFromDisk, _internals: sessInternals,
} = await import('../src/sessions.js');
const { default: authApi } = await import('../src/routes/auth.js');
const { sendError } = await import('../src/util.js');
const { requestContext } = await import('../src/request-context.js');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(requestContext);
  app.use(authApi.basePath, authApi.router);
  app.use((err, _req, res, _next) => sendError(res, err));
  return app;
}

async function login(username, password) {
  const r = await request(buildApp())
    .post('/api/auth/login')
    .send({ username, password });
  return r;
}

async function loginAndBearer(username, password) {
  const r = await login(username, password);
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
  return { token: r.body.token, role: r.body.role, user: r.body.user, bearer: `Bearer ${r.body.token}` };
}

beforeAll(async () => {
  await fs.mkdir(path.dirname(SESSIONS_TMP_FILE), { recursive: true });
});
beforeEach(async () => {
  await sessInternals.drainForTests();
  sessInternals.resetForTests();
  await fs.rm(SESSIONS_TMP_FILE, { force: true });
  await fs.rm(AUDIT_TMP_FILE, { force: true });
});
afterAll(async () => {
  await fs.rm(SESSIONS_TMP_FILE, { force: true });
  await fs.rm(AUDIT_TMP_FILE, { force: true });
});

// ============================================================
// Layer 1: in-memory store + persistence
// ============================================================

describe('session store', () => {
  it('createSession returns a row with id, timestamps, source info', () => {
    const s = createSession({
      user: 'alice', role: 'admin', ttlSeconds: 60,
      sourceIp: '10.0.0.5', userAgent: 'Firefox',
    });
    expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(s).toMatchObject({
      user: 'alice', role: 'admin',
      source_ip: '10.0.0.5', user_agent: 'Firefox',
    });
    expect(Date.parse(s.expires_at) - Date.parse(s.issued_at)).toBeCloseTo(60_000, -2);
  });

  it('getSession returns null for unknown id', () => {
    expect(getSession('does-not-exist')).toBeNull();
    expect(getSession(null)).toBeNull();
    expect(getSession('')).toBeNull();
  });

  it('getSession drops a session whose expiry has passed', () => {
    const s = createSession({ user: 'a', role: 'admin', ttlSeconds: 0 });
    // ttl=0 → expires_at is `now`. After one ms, it's in the past.
    return new Promise((resolve) => setTimeout(() => {
      expect(getSession(s.id)).toBeNull();
      resolve();
    }, 10));
  });

  it('revokeSession returns true once, false on second call', () => {
    const s = createSession({ user: 'a', role: 'admin', ttlSeconds: 60 });
    expect(revokeSession(s.id)).toBe(true);
    expect(revokeSession(s.id)).toBe(false);
    expect(getSession(s.id)).toBeNull();
  });

  it('revokeForUser only touches that user\'s sessions', () => {
    createSession({ user: 'alice', role: 'admin', ttlSeconds: 60 });
    createSession({ user: 'alice', role: 'admin', ttlSeconds: 60 });
    const bobSess = createSession({ user: 'bob', role: 'viewer', ttlSeconds: 60 });
    expect(revokeForUser('alice')).toBe(2);
    expect(getSession(bobSess.id)).toBeTruthy();
  });

  it('revokeForUser({excludeId}) spares one of the user\'s sessions', () => {
    const keep = createSession({ user: 'a', role: 'admin', ttlSeconds: 60 });
    createSession({ user: 'a', role: 'admin', ttlSeconds: 60 });
    createSession({ user: 'a', role: 'admin', ttlSeconds: 60 });
    expect(revokeForUser('a', { excludeId: keep.id })).toBe(2);
    expect(getSession(keep.id)).toBeTruthy();
  });

  it('revokeAll drops every session; excludeId spares one', () => {
    const keep = createSession({ user: 'a', role: 'admin', ttlSeconds: 60 });
    createSession({ user: 'b', role: 'admin', ttlSeconds: 60 });
    createSession({ user: 'c', role: 'viewer', ttlSeconds: 60 });
    expect(revokeAll({ excludeId: keep.id })).toBe(2);
    expect(getSession(keep.id)).toBeTruthy();
    expect(listSessions()).toHaveLength(1);
  });

  it('listSessions sorts most-recent-active first', async () => {
    const s1 = createSession({ user: 'a', role: 'admin', ttlSeconds: 60 });
    await new Promise((r) => setTimeout(r, 10));
    const s2 = createSession({ user: 'a', role: 'admin', ttlSeconds: 60 });
    await new Promise((r) => setTimeout(r, 10));
    const s3 = createSession({ user: 'b', role: 'viewer', ttlSeconds: 60 });
    const sorted = listSessions();
    expect(sorted.map((x) => x.id)).toEqual([s3.id, s2.id, s1.id]);
  });

  it('touchSession is debounced — repeated calls within 5s don\'t bump last_seen', async () => {
    const s = createSession({ user: 'a', role: 'admin', ttlSeconds: 60 });
    const first = s.last_seen;
    await new Promise((r) => setTimeout(r, 10));
    touchSession(s.id);
    // Within the 5s debounce window — should be unchanged.
    expect(getSession(s.id).last_seen).toBe(first);
  });

  // (SESSIONS_MAX_PER_USER eviction behaviour lives in its own
  // test file — `test/sessions-cap.test.js` — because it requires the
  // env var set BEFORE config.js freezes the settings snapshot.)

  it('sweepExpired drops only past-expiry rows', () => {
    createSession({ user: 'live', role: 'admin', ttlSeconds: 60 });
    const dead = createSession({ user: 'dead', role: 'admin', ttlSeconds: -1 });
    expect(sessInternals.sweepExpired()).toBe(1);
    expect(getSession(dead.id)).toBeNull();
  });

  it('persistence round-trip: flushed sessions survive reload', async () => {
    const s = createSession({
      user: 'persisted', role: 'admin', ttlSeconds: 60,
      sourceIp: '1.2.3.4', userAgent: 'curl',
    });
    // Force an immediate flush + drain.
    await sessInternals.flushNow();
    await sessInternals.drainForTests();
    expect(existsSync(SESSIONS_TMP_FILE)).toBe(true);

    // Wipe the in-memory store and reload from disk.
    sessInternals.resetForTests();
    expect(getSession(s.id)).toBeNull();
    const loaded = await loadFromDisk();
    expect(loaded).toBe(1);
    const restored = getSession(s.id);
    expect(restored).toMatchObject({
      user: 'persisted', role: 'admin',
      source_ip: '1.2.3.4', user_agent: 'curl',
    });
  });

  it('persistence skips expired rows on reload', async () => {
    createSession({ user: 'live', role: 'admin', ttlSeconds: 60 });
    const dead = createSession({ user: 'dead', role: 'admin', ttlSeconds: 60 });
    // Manually expire `dead` and persist.
    sessInternals._map.get(dead.id).expires_at = new Date(Date.now() - 1000).toISOString();
    await sessInternals.flushNow();
    await sessInternals.drainForTests();

    sessInternals.resetForTests();
    const loaded = await loadFromDisk();
    expect(loaded).toBe(1); // only the live one
    expect(getSession(dead.id)).toBeNull();
  });

  it('persistence file has mode 0600', async () => {
    createSession({ user: 'a', role: 'admin', ttlSeconds: 60 });
    await sessInternals.flushNow();
    await sessInternals.drainForTests();
    const stat = await fs.stat(SESSIONS_TMP_FILE);
    // Lower 9 bits are the perm bits; we want exactly 0o600.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ============================================================
// Layer 2: auth middleware — revocation behaviour
// ============================================================

describe('auth middleware: session-aware', () => {
  it('valid bearer + valid session → 200', async () => {
    const { bearer } = await loginAndBearer('admin', 'admin-pw');
    const r = await request(buildApp())
      .get('/api/auth/me')
      .set('Authorization', bearer);
    expect(r.status).toBe(200);
  });

  it('valid bearer + revoked session → 401 with "Session revoked"', async () => {
    const { bearer, token } = await loginAndBearer('admin', 'admin-pw');
    // Decode the jti and revoke that session manually.
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    revokeSession(payload.jti);

    const r = await request(buildApp())
      .get('/api/auth/me')
      .set('Authorization', bearer);
    expect(r.status).toBe(401);
    expect(r.body.detail).toMatch(/revoked|expired/i);
  });

  it('rejects a token whose payload says one user but the session is for another', async () => {
    const a = createSession({ user: 'a', role: 'admin', ttlSeconds: 60 });
    // Sign a token claiming to be alice but pointing at a's session.
    const { signToken } = await import('../src/jwt.js');
    const { token } = signToken({ sub: 'alice', role: 'admin', jti: a.id }, 60);
    const r = await request(buildApp())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(401);
    expect(r.body.detail).toMatch(/mismatch/i);
  });

  it('rejects a token with no jti claim', async () => {
    const { signToken } = await import('../src/jwt.js');
    const { token } = signToken({ sub: 'admin', role: 'admin' }, 60); // no jti
    const r = await request(buildApp())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(401);
    expect(r.body.detail).toMatch(/jti/i);
  });
});

// ============================================================
// Layer 3: REST endpoints
// ============================================================

describe('POST /api/auth/login', () => {
  it('mints a session and a token whose jti points at it', async () => {
    const r = await login('admin', 'admin-pw');
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    // Decode the payload — the jti should be a session in the store.
    const payload = JSON.parse(Buffer.from(r.body.token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.jti).toBeTruthy();
    const s = getSession(payload.jti);
    expect(s).toMatchObject({ user: 'admin', role: 'admin' });
  });

  it('captures source_ip + user_agent on the session', async () => {
    const r = await request(buildApp())
      .post('/api/auth/login')
      .set('User-Agent', 'curl/8.0')
      .send({ username: 'admin', password: 'admin-pw' });
    expect(r.status).toBe(200);
    const payload = JSON.parse(Buffer.from(r.body.token.split('.')[1], 'base64url').toString('utf8'));
    const s = getSession(payload.jti);
    expect(s.user_agent).toBe('curl/8.0');
    // source_ip will be 127.0.0.1 / ::1 / similar in supertest.
    expect(typeof s.source_ip === 'string' || s.source_ip === null).toBe(true);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current session id alongside user + role', async () => {
    const { bearer, token } = await loginAndBearer('admin', 'admin-pw');
    const r = await request(buildApp())
      .get('/api/auth/me').set('Authorization', bearer);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(r.body).toEqual({ user: 'admin', role: 'admin', session_id: payload.jti });
  });
});

describe('POST /api/auth/logout', () => {
  it('drops only the current session; other sessions for the same user keep working', async () => {
    const a = await loginAndBearer('admin', 'admin-pw');
    const b = await loginAndBearer('admin', 'admin-pw');
    const r = await request(buildApp())
      .post('/api/auth/logout').set('Authorization', a.bearer);
    expect(r.status).toBe(200);
    expect(r.body.revoked).toBe(1);

    // a's token now rejected
    const aAfter = await request(buildApp()).get('/api/auth/me').set('Authorization', a.bearer);
    expect(aAfter.status).toBe(401);
    // b's token still good
    const bAfter = await request(buildApp()).get('/api/auth/me').set('Authorization', b.bearer);
    expect(bAfter.status).toBe(200);
  });
});

describe('POST /api/auth/logout-all', () => {
  it('revokes every session for the caller (including the calling one by default)', async () => {
    const a = await loginAndBearer('admin', 'admin-pw');
    await loginAndBearer('admin', 'admin-pw');
    await loginAndBearer('admin', 'admin-pw');
    expect(listSessions({ user: 'admin' })).toHaveLength(3);

    const r = await request(buildApp())
      .post('/api/auth/logout-all').set('Authorization', a.bearer);
    expect(r.body.revoked).toBe(3);
    expect(listSessions({ user: 'admin' })).toHaveLength(0);
  });

  it('keep_current=true spares the calling session', async () => {
    const a = await loginAndBearer('admin', 'admin-pw');
    await loginAndBearer('admin', 'admin-pw');
    const r = await request(buildApp())
      .post('/api/auth/logout-all?keep_current=true').set('Authorization', a.bearer);
    expect(r.body.revoked).toBe(1);
    const afterMe = await request(buildApp()).get('/api/auth/me').set('Authorization', a.bearer);
    expect(afterMe.status).toBe(200);
  });

  it('does NOT touch other users\' sessions', async () => {
    await loginAndBearer('admin', 'admin-pw');
    const viewer = await loginAndBearer('viewer', 'viewer-pw');
    const admin = await loginAndBearer('admin', 'admin-pw');
    await request(buildApp())
      .post('/api/auth/logout-all').set('Authorization', admin.bearer);
    const r = await request(buildApp()).get('/api/auth/me').set('Authorization', viewer.bearer);
    expect(r.status).toBe(200);
  });
});

describe('GET /api/auth/sessions', () => {
  it('returns only the caller\'s sessions with current=true marked', async () => {
    const a = await loginAndBearer('admin', 'admin-pw');
    await loginAndBearer('admin', 'admin-pw');
    await loginAndBearer('viewer', 'viewer-pw');
    const r = await request(buildApp())
      .get('/api/auth/sessions').set('Authorization', a.bearer);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2); // admin's two sessions
    const current = r.body.find((s) => s.current);
    expect(current).toBeTruthy();
    expect(current.user).toBe('admin');
  });
});

describe('GET /api/auth/sessions/all (admin)', () => {
  it('admin sees every session', async () => {
    const admin = await loginAndBearer('admin', 'admin-pw');
    await loginAndBearer('viewer', 'viewer-pw');
    const r = await request(buildApp())
      .get('/api/auth/sessions/all').set('Authorization', admin.bearer);
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThanOrEqual(2);
    expect(new Set(r.body.map((s) => s.user))).toEqual(new Set(['admin', 'viewer']));
  });

  it('viewer is forbidden', async () => {
    const viewer = await loginAndBearer('viewer', 'viewer-pw');
    const r = await request(buildApp())
      .get('/api/auth/sessions/all').set('Authorization', viewer.bearer);
    expect(r.status).toBe(403);
  });
});

describe('POST /api/auth/sessions/:id/revoke', () => {
  it('viewer can revoke their own session', async () => {
    const viewer = await loginAndBearer('viewer', 'viewer-pw');
    const payload = JSON.parse(Buffer.from(viewer.token.split('.')[1], 'base64url').toString('utf8'));
    const r = await request(buildApp())
      .post(`/api/auth/sessions/${payload.jti}/revoke`)
      .set('Authorization', viewer.bearer);
    expect(r.status).toBe(200);
    expect(r.body.revoked).toBe(1);
  });

  it('viewer CANNOT revoke another user\'s session (403)', async () => {
    const viewer = await loginAndBearer('viewer', 'viewer-pw');
    const admin = await loginAndBearer('admin', 'admin-pw');
    const adminPayload = JSON.parse(Buffer.from(admin.token.split('.')[1], 'base64url').toString('utf8'));
    const r = await request(buildApp())
      .post(`/api/auth/sessions/${adminPayload.jti}/revoke`)
      .set('Authorization', viewer.bearer);
    expect(r.status).toBe(403);
  });

  it('admin can revoke any session', async () => {
    const admin = await loginAndBearer('admin', 'admin-pw');
    const viewer = await loginAndBearer('viewer', 'viewer-pw');
    const viewerPayload = JSON.parse(Buffer.from(viewer.token.split('.')[1], 'base64url').toString('utf8'));
    const r = await request(buildApp())
      .post(`/api/auth/sessions/${viewerPayload.jti}/revoke`)
      .set('Authorization', admin.bearer);
    expect(r.status).toBe(200);
    // viewer's token is now dead
    const v = await request(buildApp()).get('/api/auth/me').set('Authorization', viewer.bearer);
    expect(v.status).toBe(401);
  });

  it('404 when the session id is unknown', async () => {
    const admin = await loginAndBearer('admin', 'admin-pw');
    const r = await request(buildApp())
      .post('/api/auth/sessions/00000000-0000-4000-8000-000000000000/revoke')
      .set('Authorization', admin.bearer);
    expect(r.status).toBe(404);
  });
});

describe('POST /api/auth/sessions/revoke-user/:username (admin)', () => {
  it('admin can revoke all sessions for a specific user', async () => {
    const admin = await loginAndBearer('admin', 'admin-pw');
    const v1 = await loginAndBearer('viewer', 'viewer-pw');
    const v2 = await loginAndBearer('viewer', 'viewer-pw');
    const r = await request(buildApp())
      .post('/api/auth/sessions/revoke-user/viewer')
      .set('Authorization', admin.bearer);
    expect(r.body.revoked).toBe(2);
    // viewer sessions are gone, admin's is fine.
    expect((await request(buildApp()).get('/api/auth/me').set('Authorization', v1.bearer)).status).toBe(401);
    expect((await request(buildApp()).get('/api/auth/me').set('Authorization', v2.bearer)).status).toBe(401);
    expect((await request(buildApp()).get('/api/auth/me').set('Authorization', admin.bearer)).status).toBe(200);
  });

  it('viewer is forbidden', async () => {
    const viewer = await loginAndBearer('viewer', 'viewer-pw');
    const r = await request(buildApp())
      .post('/api/auth/sessions/revoke-user/admin')
      .set('Authorization', viewer.bearer);
    expect(r.status).toBe(403);
  });
});

describe('POST /api/auth/sessions/revoke-all (admin)', () => {
  it('spares the caller\'s session by default; nukes everyone else', async () => {
    const admin = await loginAndBearer('admin', 'admin-pw');
    const v1 = await loginAndBearer('viewer', 'viewer-pw');
    await loginAndBearer('admin', 'admin-pw'); // another admin session
    const r = await request(buildApp())
      .post('/api/auth/sessions/revoke-all')
      .set('Authorization', admin.bearer);
    expect(r.body.revoked).toBeGreaterThanOrEqual(2);
    expect((await request(buildApp()).get('/api/auth/me').set('Authorization', admin.bearer)).status).toBe(200);
    expect((await request(buildApp()).get('/api/auth/me').set('Authorization', v1.bearer)).status).toBe(401);
  });

  it('include_self=true also kills the caller\'s session', async () => {
    const admin = await loginAndBearer('admin', 'admin-pw');
    await loginAndBearer('viewer', 'viewer-pw');
    await request(buildApp())
      .post('/api/auth/sessions/revoke-all?include_self=true')
      .set('Authorization', admin.bearer);
    expect((await request(buildApp()).get('/api/auth/me').set('Authorization', admin.bearer)).status).toBe(401);
    expect(listSessions()).toHaveLength(0);
  });

  it('viewer is forbidden', async () => {
    const viewer = await loginAndBearer('viewer', 'viewer-pw');
    const r = await request(buildApp())
      .post('/api/auth/sessions/revoke-all')
      .set('Authorization', viewer.bearer);
    expect(r.status).toBe(403);
  });
});
