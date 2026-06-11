// JWT-based authentication endpoints.
//
//   POST /api/auth/login              { username, password } -> { token, ... }
//   POST /api/auth/logout                                    -> { revoked: 1 }
//   POST /api/auth/logout-all                                -> { revoked: N }
//   GET  /api/auth/me                                        -> { user, role, session_id }
//   GET  /api/auth/sessions                                  -> [own sessions]
//
// Admin-only:
//   GET  /api/auth/sessions/all                              -> [all sessions]
//   POST /api/auth/sessions/:id/revoke                       -> { revoked: bool }
//   POST /api/auth/sessions/revoke-user/:username            -> { revoked: N }
//   POST /api/auth/sessions/revoke-all                       -> { revoked: N }

import { Type } from '@sinclair/typebox';
import { verifyCredentials } from '../auth.js';
import { signToken } from '../jwt.js';
import { settings } from '../config.js';
import { asyncHandler, HttpError } from '../util.js';
import { createApiRouter } from '../route-builder.js';
import {
  createSession,
  listSessions,
  revokeSession,
  revokeForUser,
  revokeAll,
} from '../sessions.js';
import {
  LoginRequest,
  LoginResponse,
  MeResponse,
  SessionInfo,
  SessionRevokeResponse,
} from '../schemas/index.js';

const r = createApiRouter('/api/auth', { tag: 'auth' });

// Annotate the returned session list so the SPA can highlight "this is
// your current session" without a separate /me round-trip.
function decorateForSelf(sessions, currentId) {
  return sessions.map((s) => ({ ...s, current: s.id === currentId }));
}

// ---------- login ----------

r.post(
  '/login',
  {
    summary: 'Exchange credentials for a JWT',
    description:
      'Mints a server-side session and embeds its id as the JWT `jti`. ' +
      'The session is what makes "log out" / "log out everywhere" / admin force-kick work.',
    auth: false,
    body: LoginRequest,
    responses: { 200: LoginResponse },
  },
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const user = verifyCredentials(username, password);
    if (!user) return res.status(401).json({ detail: 'Invalid credentials' });

    // Capture source IP + UA on session creation so the sessions pane
    // can show "Firefox on Linux from 10.0.0.5". `req.ip` honours the
    // trust-proxy setting wired in index.js.
    const session = createSession({
      user: user.username,
      role: user.role,
      sourceIp: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      ttlSeconds: settings.jwtTtlSeconds,
    });

    const { token, expires_in } = signToken(
      { sub: user.username, role: user.role, jti: session.id },
      settings.jwtTtlSeconds,
    );
    res.json({
      token,
      token_type: 'bearer',
      expires_in,
      user: user.username,
      role: user.role,
    });
  }),
);

// ---------- whoami ----------

r.get(
  '/me',
  {
    summary: 'Current user (validates the bearer token)',
    responses: { 200: MeResponse },
  },
  (req, res) => res.json({
    user: req.user.username,
    role: req.user.role,
    session_id: req.sessionId,
  }),
);

// ---------- logout (single session) ----------

r.post(
  '/logout',
  {
    summary: 'Revoke the session backing the current bearer token',
    description:
      'After this call, the same token will be rejected with 401 on its next use. ' +
      'The signature is still valid (we can\'t unsign a JWT) — the rejection happens ' +
      'because the session row is gone from the server-side store.',
    responses: { 200: SessionRevokeResponse },
  },
  asyncHandler(async (req, res) => {
    const ok = revokeSession(req.sessionId, 'self-logout');
    res.json({ revoked: ok ? 1 : 0 });
  }),
);

// ---------- logout-all (every session belonging to the caller) ----------
//
// Common use case: "I think my session leaked, sign me out of every
// device". Includes the current session by default — the caller is
// asked to re-login. If they pass `?keep_current=true`, we spare it.
r.post(
  '/logout-all',
  {
    summary: 'Revoke every session belonging to the caller',
    query: Type.Object(
      {
        keep_current: Type.Optional(Type.Boolean({
          default: false,
          description: 'When true, only OTHER sessions are revoked; the current bearer token keeps working.',
        })),
      },
      { additionalProperties: false },
    ),
    responses: { 200: SessionRevokeResponse },
  },
  asyncHandler(async (req, res) => {
    const keep = req.query.keep_current === 'true' || req.query.keep_current === true;
    const count = revokeForUser(req.user.username, {
      excludeId: keep ? req.sessionId : null,
      reason: keep ? 'self-logout-all (kept current)' : 'self-logout-all',
    });
    res.json({ revoked: count });
  }),
);

// ---------- list MY sessions ----------

r.get(
  '/sessions',
  {
    summary: 'List your own active sessions',
    responses: { 200: Type.Array(SessionInfo) },
  },
  (req, res) => {
    const rows = listSessions({ user: req.user.username });
    res.json(decorateForSelf(rows, req.sessionId));
  },
);

// ---------- admin: list ALL sessions ----------

r.get(
  '/sessions/all',
  {
    summary: 'List every active session (admin)',
    admin: true,
    responses: { 200: Type.Array(SessionInfo) },
  },
  (req, res) => {
    const rows = listSessions();
    res.json(decorateForSelf(rows, req.sessionId));
  },
);

// ---------- revoke a specific session by id ----------
//
// Callers can revoke:
//   - their own sessions, without admin
//   - anyone's session, with admin
// This is the pane on the user's own sessions page (kill a stale
// laptop) AND the admin override (kill a compromised account).
r.post(
  '/sessions/:id/revoke',
  {
    summary: 'Revoke one session by id (own session, or any session if admin)',
    params: Type.Object(
      { id: Type.String({ minLength: 1, maxLength: 64 }) },
      { additionalProperties: false },
    ),
    responses: { 200: SessionRevokeResponse },
  },
  asyncHandler(async (req, res) => {
    const target = listSessions().find((s) => s.id === req.params.id);
    if (!target) throw new HttpError(404, 'Session not found');
    // Non-admins can only revoke their own sessions. Admins can
    // revoke anyone's, including their own current one.
    if (req.user.role !== 'admin' && target.user !== req.user.username) {
      throw new HttpError(403, 'Cannot revoke another user\'s session');
    }
    const ok = revokeSession(req.params.id, target.user === req.user.username ? 'self' : 'admin');
    res.json({ revoked: ok ? 1 : 0 });
  }),
);

// ---------- admin: revoke all of one user's sessions ----------

r.post(
  '/sessions/revoke-user/:username',
  {
    summary: 'Revoke every session belonging to a specific user (admin)',
    admin: true,
    destructive: true,
    params: Type.Object(
      { username: Type.String({ minLength: 1, maxLength: 255 }) },
      { additionalProperties: false },
    ),
    responses: { 200: SessionRevokeResponse },
  },
  asyncHandler(async (req, res) => {
    const count = revokeForUser(req.params.username, { reason: 'admin' });
    res.json({ revoked: count });
  }),
);

// ---------- admin: revoke EVERY session (incident response) ----------
//
// The big red button: "we just rotated the daemon credentials and want
// every active operator forced through re-login right now". Spares
// the caller's current session by default so an admin doesn't lock
// themselves out mid-incident; pass `?include_self=true` to nuke
// everything including the calling token.
r.post(
  '/sessions/revoke-all',
  {
    summary: 'Revoke every active session across all users (admin; incident response)',
    admin: true,
    destructive: true,
    query: Type.Object(
      {
        include_self: Type.Optional(Type.Boolean({
          default: false,
          description: 'When true, the calling session is also revoked. Default spares it so the admin stays logged in.',
        })),
      },
      { additionalProperties: false },
    ),
    responses: { 200: SessionRevokeResponse },
  },
  asyncHandler(async (req, res) => {
    const includeSelf = req.query.include_self === 'true' || req.query.include_self === true;
    const count = revokeAll({
      excludeId: includeSelf ? null : req.sessionId,
      reason: includeSelf ? 'admin-all (including self)' : 'admin-all (spared self)',
    });
    res.json({ revoked: count });
  }),
);

export default r;
