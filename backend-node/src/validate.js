// Zod-backed request validation.
//
// Each route that accepts a body (or unusually structured query/params)
// declares a Zod schema and wraps itself with one of the middlewares below.
// On success, the parsed value replaces the raw input on the request, so
// downstream handlers can rely on the shape and types being exactly what the
// schema describes.
//
// On failure we return:
//
//   400 {
//     "detail": "Validation failed",
//     "errors": [{ "path": "ports.80/tcp", "message": "...", "code": "..." }]
//   }

import { z } from 'zod';

function formatErrors(err) {
  return err.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
    code: i.code,
  }));
}

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body == null ? {} : req.body);
    if (!result.success) {
      return res.status(400).json({
        detail: 'Validation failed',
        errors: formatErrors(result.error),
      });
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query == null ? {} : req.query);
    if (!result.success) {
      return res.status(400).json({
        detail: 'Validation failed',
        errors: formatErrors(result.error),
      });
    }
    // Don't mutate req.query (Express 5 makes it a getter); attach instead.
    req.validatedQuery = result.data;
    next();
  };
}

export function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params == null ? {} : req.params);
    if (!result.success) {
      return res.status(400).json({
        detail: 'Invalid path parameter',
        errors: formatErrors(result.error),
      });
    }
    req.params = result.data;
    next();
  };
}

// Convenience helper: makes a field accept value | null | undefined without
// the noisy `.nullable().optional()` repetition in the schemas themselves.
export const opt = (s) => s.nullable().optional();

export { z };
