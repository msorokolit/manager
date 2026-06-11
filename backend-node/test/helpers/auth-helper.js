// Shared test helpers for the auth + sessions story.
//
// After sessions shipped, the auth middleware requires every JWT to
// carry a `jti` that matches a row in the server-side session store.
// `withRole(role)` does both steps — creates a fresh session for the
// given role + mints a JWT whose payload includes the session id.
//
// Centralising this so the four route-integration test files all
// agree on the shape (and pick up changes in one place if the auth
// model evolves).
import { createSession, _internals as sessionsInternals } from '../../src/sessions.js';
import { signToken } from '../../src/jwt.js';

/**
 * Mint a valid Authorization header for the given role.
 * The created session is registered in the in-memory store so the
 * auth middleware's jti lookup succeeds.
 *
 * Optionally pass `username` to differentiate two sessions of the
 * same role (useful when testing "user A can't revoke user B's
 * session").
 */
export function withRole(role, username = role) {
  const session = createSession({
    user: username,
    role,
    ttlSeconds: 3600,
    sourceIp: '127.0.0.1',
    userAgent: 'vitest',
  });
  const { token } = signToken({ sub: username, role, jti: session.id }, 3600);
  return `Bearer ${token}`;
}

/**
 * Per-test reset so a session created in test A doesn't leak into
 * test B (e.g. via getSession() returning a stale row). Call in
 * each test file's beforeEach.
 */
export function resetSessions() {
  sessionsInternals.resetForTests();
}
