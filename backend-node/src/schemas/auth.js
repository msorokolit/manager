import { Type } from '@sinclair/typebox';
import { StringEnum } from './_common.js';

export const LoginRequest = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 255 }),
    password: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { $id: 'LoginRequest', additionalProperties: false },
);

export const LoginResponse = Type.Object(
  {
    token: Type.String({ description: 'Signed JWT (HS256)' }),
    token_type: Type.Literal('bearer'),
    expires_in: Type.Integer({ minimum: 1 }),
    user: Type.String(),
    role: StringEnum(['admin', 'viewer']),
  },
  { $id: 'LoginResponse', additionalProperties: false },
);

export const MeResponse = Type.Object(
  {
    user: Type.String(),
    role: StringEnum(['admin', 'viewer']),
    // Session id (`jti` in JWT terms) — surfaced so the SPA can
    // highlight the caller's current row in the sessions pane without
    // a second round-trip.
    session_id: Type.String(),
  },
  { $id: 'MeResponse', additionalProperties: false },
);

/**
 * One row in the sessions pane. Mirrors the on-disk shape from
 * src/sessions.js plus a `current` flag the API tacks on for the
 * /sessions endpoint (lets the UI mark "this is you").
 */
export const SessionInfo = Type.Object(
  {
    id: Type.String({ description: 'Session id (UUID v4) — also embedded in the JWT as `jti`' }),
    user: Type.String(),
    role: StringEnum(['admin', 'viewer']),
    issued_at: Type.String({ description: 'ISO 8601: when the session was created (login time)' }),
    expires_at: Type.String({ description: 'ISO 8601: when the backing JWT expires' }),
    last_seen: Type.String({ description: 'ISO 8601: most recent activity on this session' }),
    source_ip: Type.Union([Type.String(), Type.Null()]),
    user_agent: Type.Union([Type.String(), Type.Null()]),
    current: Type.Optional(Type.Boolean({
      description: 'True when this is the session that issued the listing call (UI hint).',
    })),
  },
  { $id: 'SessionInfo', additionalProperties: false },
);

/** Common response for every revoke endpoint. */
export const SessionRevokeResponse = Type.Object(
  {
    revoked: Type.Integer({ minimum: 0, description: 'Count of session rows dropped (0 = no-op)' }),
  },
  { $id: 'SessionRevokeResponse', additionalProperties: false },
);
