// JSON Schema-backed request validation, powered by AJV.
//
// Schemas are TypeBox objects, which are themselves JSON Schema, so the same
// definition drives both runtime validation and the auto-generated OpenAPI
// document.
//
// On failure we return:
//
//   400 {
//     "detail": "Validation failed",
//     "errors": [{ "path": "ports.80/tcp", "message": "...", "code": "..." }]
//   }

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// Two AJV instances: one strict (for JSON request bodies) and one with type
// coercion enabled (for query strings and path params, where everything
// arrives as a string).
const ajv = new Ajv({
  allErrors: true,
  removeAdditional: false,
  useDefaults: true,
  coerceTypes: false,
  addUsedSchema: false,
  strict: false,
});
addFormats(ajv);

const ajvCoerce = new Ajv({
  allErrors: true,
  removeAdditional: false,
  useDefaults: true,
  // Query/params arrive as strings; coerce booleans, integers and numbers
  // back to their declared types so handlers can rely on them. 'array'
  // additionally turns a single-value string into a one-element array when
  // the schema asks for one.
  coerceTypes: 'array',
  addUsedSchema: false,
  strict: false,
});
addFormats(ajvCoerce);

// Validators reject directly with res.status(400).json(...) — they
// don't go through the central error middleware. So the audit
// middleware's captureError hook never fires from them. We thread a
// short summary through `res.locals.auditCaptureError` so the audit
// row for the failed request gets a useful `error` field.
function notifyAudit(res, summary) {
  if (res.locals && typeof res.locals.auditCaptureError === 'function') {
    try { res.locals.auditCaptureError(summary); } catch { /* never fail responding */ }
  }
}

function summariseErrors(errs) {
  if (!errs || !errs.length) return 'validation failed';
  const first = errs[0];
  const path = first.path || '<root>';
  return `validation failed: ${path}: ${first.message}` +
    (errs.length > 1 ? ` (+${errs.length - 1} more)` : '');
}

function jsonPointerToPath(pointer) {
  if (!pointer) return '';
  // "/users/0/email" -> "users.0.email"
  return pointer
    .replace(/^\//, '')
    .replace(/~1/g, '/')
    .replace(/~0/g, '~')
    .split('/')
    .join('.');
}

function formatError(err) {
  let path = jsonPointerToPath(err.instancePath || '');
  if (err.keyword === 'required' && err.params && err.params.missingProperty) {
    path = path
      ? `${path}.${err.params.missingProperty}`
      : err.params.missingProperty;
  } else if (
    err.keyword === 'additionalProperties' &&
    err.params &&
    err.params.additionalProperty
  ) {
    path = path
      ? `${path}.${err.params.additionalProperty}`
      : err.params.additionalProperty;
  }
  let message = err.message || 'invalid';
  if (err.keyword === 'additionalProperties' && err.params && err.params.additionalProperty) {
    message = `Unrecognized field '${err.params.additionalProperty}'`;
  }
  return { path, message, code: err.keyword };
}

function makeMiddleware(schema, accessor) {
  const validator = ajv.compile(schema);
  return (req, res, next) => {
    const data = accessor(req);
    const valid = validator(data == null ? {} : data);
    if (!valid) {
      return res.status(400).json({
        detail: 'Validation failed',
        errors: (validator.errors || []).map(formatError),
      });
    }
    next();
  };
}

export function validateBody(schema) {
  const validator = ajv.compile(schema);
  return (req, res, next) => {
    const data = req.body == null ? {} : req.body;
    if (!validator(data)) {
      const errs = (validator.errors || []).map(formatError);
      notifyAudit(res, summariseErrors(errs));
      return res.status(400).json({ detail: 'Validation failed', errors: errs });
    }
    req.body = data;
    next();
  };
}

export function validateQuery(schema) {
  const validator = ajvCoerce.compile(schema);
  return (req, res, next) => {
    // Clone so coercion doesn't mutate the underlying req.query (Express 5
    // makes that a getter). Strings on the wire become booleans/integers
    // here, matching the declared schema.
    const data = req.query == null ? {} : { ...req.query };
    if (!validator(data)) {
      const errs = (validator.errors || []).map(formatError);
      notifyAudit(res, summariseErrors(errs));
      return res.status(400).json({ detail: 'Validation failed', errors: errs });
    }
    req.validatedQuery = data;
    next();
  };
}

export function validateParams(schema) {
  const validator = ajvCoerce.compile(schema);
  return (req, res, next) => {
    const data = req.params == null ? {} : { ...req.params };
    if (!validator(data)) {
      const errs = (validator.errors || []).map(formatError);
      notifyAudit(res, summariseErrors(errs));
      return res.status(400).json({ detail: 'Invalid path parameter', errors: errs });
    }
    req.params = data;
    next();
  };
}
