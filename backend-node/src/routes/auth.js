// JWT-based authentication endpoints.
//
//   POST /api/auth/login   { username, password } -> { token, ... }
//   GET  /api/auth/me      (Bearer)                 -> { user, role }
import { verifyCredentials } from '../auth.js';
import { signToken } from '../jwt.js';
import { settings } from '../config.js';
import { asyncHandler } from '../util.js';
import { createApiRouter } from '../route-builder.js';
import { LoginRequest, LoginResponse, MeResponse } from '../schemas/index.js';

const r = createApiRouter('/api/auth', { tag: 'auth' });

r.post(
  '/login',
  {
    summary: 'Exchange credentials for a JWT',
    description:
      'The token is signed with HS256 and expires in JWT_TTL_SECONDS (default 12h).',
    auth: false,
    body: LoginRequest,
    responses: { 200: LoginResponse },
  },
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const user = verifyCredentials(username, password);
    if (!user) return res.status(401).json({ detail: 'Invalid credentials' });
    const { token, expires_in } = signToken(
      { sub: user.username, role: user.role },
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

r.get(
  '/me',
  {
    summary: 'Current user (validates the bearer token)',
    responses: { 200: MeResponse },
  },
  (req, res) => res.json({ user: req.user.username, role: req.user.role }),
);

export default r;
