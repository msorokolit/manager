// Declarative route builder.
//
// Each route file calls createApiRouter(basePath, { tag }) and then declares
// its endpoints with r.get/post/put/delete. The builder:
//
//   1. Wires up the right middleware chain (authenticate, requireAdmin,
//      validateBody/Query/Params) from the per-route spec.
//   2. Mounts the handler on the underlying Express router.
//   3. Pushes a single canonical operation descriptor into r.operations,
//      which the OpenAPI generator consumes to assemble the spec.
//
// Usage:
//
//   import { createApiRouter } from '../route-builder.js';
//   import { LoginRequest, LoginResponse } from '../schemas/index.js';
//
//   const r = createApiRouter('/api/auth', { tag: 'auth' });
//
//   r.post('/login', {
//     summary: 'Exchange credentials for a JWT',
//     auth: false,                          // public route
//     body: LoginRequest,
//     responses: { 200: LoginResponse },    // 401 auto-injected
//   }, asyncHandler(async (req, res) => { /* ... */ }));
//
//   export default r;
//
// In index.js:
//
//   import authApi from './routes/auth.js';
//   const apis = [authApi, /* ... */];
//   for (const a of apis) app.use(a.basePath, a.router);
//   const operations = apis.flatMap((a) => a.operations);
//   const spec = buildOpenApiSpec(operations);

import { Router } from 'express';
import { authenticate, requireAdmin } from './auth.js';
import { validateBody, validateParams, validateQuery } from './validate.js';
import { expensiveConcurrency } from './rate-limit.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export function createApiRouter(basePath, defaults = {}) {
  if (typeof basePath !== 'string' || !basePath.startsWith('/')) {
    throw new Error('basePath must start with /');
  }
  const router = Router();
  const operations = [];

  function define(method, path, spec, ...handlers) {
    // Allow `r.get('/foo', handler)` (spec omitted) just like Express does.
    if (typeof spec === 'function') {
      handlers = [spec, ...handlers];
      spec = {};
    }
    spec = spec || {};
    if (!handlers.length) {
      throw new Error(`route ${method.toUpperCase()} ${path}: no handler`);
    }

    const auth = spec.auth !== false;
    const admin = !!spec.admin;
    const expensive = !!spec.expensive;
    const tags = spec.tags || (defaults.tag ? [defaults.tag] : []);

    const mws = [];
    if (auth) mws.push(authenticate);
    if (admin) mws.push(requireAdmin);
    // The concurrency cap is per-user, so authenticate must have run first.
    if (expensive) mws.push(expensiveConcurrency());
    if (spec.params) mws.push(validateParams(spec.params));
    if (spec.query) mws.push(validateQuery(spec.query));
    if (spec.body) mws.push(validateBody(spec.body));

    router[method](path, ...mws, ...handlers);

    operations.push({
      method,
      path,
      basePath,
      // Canonical Express path including the mount; e.g. /api/auth/login
      fullPath: basePath === '/' ? path : basePath + path,
      tags,
      auth,
      admin,
      expensive,
      summary: spec.summary,
      description: spec.description,
      body: spec.body,
      params: spec.params,
      query: spec.query,
      // `responses` is a map of statusCode -> schema | response-object | { kind:'stream',... }
      responses: spec.responses,
      // Free-form extras (request/response content types, examples, etc.)
      extra: spec.extra,
    });
  }

  const api = { basePath, router, operations };
  for (const m of METHODS) {
    api[m] = (path, spec, ...handlers) => define(m, path, spec, ...handlers);
  }
  return api;
}

/**
 * Convenience helper: a "stream" response indicator, since OpenAPI doesn't have
 * one and the routes that stream want a different content-type than JSON.
 */
export function streamResponse(description, contentType = 'application/x-ndjson') {
  return { kind: 'stream', description, contentType };
}

/**
 * Convenience helper: a custom response object (anything that should land in
 * the OpenAPI `responses` slot verbatim, such as a binary download).
 */
export function customResponse(definition) {
  return { kind: 'custom', definition };
}
