// WebSocket origin policy — defence-in-depth against Cross-Site WebSocket
// Hijacking. The handshake is also gated by a one-shot ticket, so this
// is a second layer — but the cost is one header check and it removes
// "any page can open an exec WS to our server" from the threat model.
//
// Policy (mirrors the HTTP CORS layer):
//   - no Origin header                       → allow (curl, wscat,
//                                               server-to-server)
//   - Origin matches the request's own host  → allow (same-origin SPA)
//   - Origin is in settings.corsOrigins      → allow
//   - anything else                          → reject
//
// Lives in its own module so tests can import the helper without
// kicking off index.js's server.listen().
import { settings } from './config.js';

export function isAllowedWsOrigin(req, allowedOrigins = settings.corsOrigins) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;

  const host = req.headers && req.headers.host;
  if (host) {
    // Trust X-Forwarded-Proto from the first hop (Express has
    // `trust proxy 1` set in index.js) so deployments behind a TLS
    // terminating proxy compute the right "self" origin.
    const xfProto =
      typeof req.headers['x-forwarded-proto'] === 'string'
        ? req.headers['x-forwarded-proto'].split(',')[0].trim()
        : null;
    const proto =
      xfProto || (req.socket && req.socket.encrypted ? 'https' : 'http');
    if (origin === `${proto}://${host}`) return true;
  }

  return (allowedOrigins || []).includes(origin);
}
