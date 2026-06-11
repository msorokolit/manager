// Per-request context middleware.
//
// Responsibilities:
//   1. Mint (or honour) a correlation ID for every incoming request.
//   2. Echo it back on the response as `X-Request-Id`.
//   3. Run the rest of the request inside an AsyncLocalStorage context so
//      logger calls anywhere downstream automatically pick up
//      `request_id`, `source_ip`, and (once auth has run) the user.
//
// Why honour an incoming header? When the manager runs behind a
// reverse proxy (nginx, traefik, an L7 load balancer), the operator
// usually wants the proxy's already-generated trace ID propagated end
// to end. We accept it if it looks safe (alphanumeric+`-_:.`, ≤128
// chars) and mint our own UUID v4 otherwise. The constraint stops a
// hostile client from injecting newlines / shell metacharacters into
// our log lines.

import { randomUUID } from 'node:crypto';
import { runWithContext } from './logger.js';

// Allow URL-safe-base64 + dashes/dots/colons (e.g. W3C traceparent
// format `00-<trace-id>-<span-id>-<flags>` fits). Cap length so a
// malicious upstream can't bloat every log line with megabytes of
// header content.
const ID_RE = /^[a-zA-Z0-9._:-]{8,128}$/;

export function requestContext(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const reqId = typeof incoming === 'string' && ID_RE.test(incoming)
    ? incoming
    : randomUUID();

  // Make the id reachable from anywhere — both via the Express request
  // (for callers that already have `req`) and via AsyncLocalStorage
  // (for everything else, including handlers that do `await` chains).
  req.requestId = reqId;
  res.setHeader('X-Request-Id', reqId);

  // Source IP: prefer Express's resolved `req.ip` (which already
  // honours `trust proxy` set in index.js). Fall back to the raw
  // socket address for transports where it's not populated.
  const sourceIp = req.ip || (req.socket && req.socket.remoteAddress) || null;

  // The user is added later by the auth middleware via patchContext().
  const ctx = { requestId: reqId, sourceIp, user: null };

  runWithContext(ctx, () => next());
}
