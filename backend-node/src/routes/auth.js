// JWT-based authentication endpoints.
//
//   POST /api/auth/login   { username, password } -> { token, ... }
//   GET  /api/auth/me      (Bearer)                 -> { user, role }
//
// The login route is intentionally rate-limited only by HTTP/network: in a
// production deployment, front this with a reverse proxy that throttles
// per-IP if needed. We keep verification timing-safe via verifyCredentials
// to avoid trivial username enumeration.
import { Router } from 'express';
import { authenticate, verifyCredentials } from '../auth.js';
import { signToken } from '../jwt.js';
import { settings } from '../config.js';
import { asyncHandler } from '../util.js';
import { validateBody } from '../validate.js';
import { LoginRequest } from '../schemas/index.js';

const router = Router();

router.post(
  '/login',
  validateBody(LoginRequest),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const user = verifyCredentials(username, password);
    if (!user) {
      return res.status(401).json({ detail: 'Invalid credentials' });
    }
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

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user.username, role: req.user.role });
});

export default router;
