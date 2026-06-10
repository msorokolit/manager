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
      return res.status(400).json({
        detail: 'Validation failed',
        errors: (validator.errors || []).map(formatError),
      });
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
      return res.status(400).json({
        detail: 'Validation failed',
        errors: (validator.errors || []).map(formatError),
      });
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
      return res.status(400).json({
        detail: 'Invalid path parameter',
        errors: (validator.errors || []).map(formatError),
      });
    }
    req.params = data;
    next();
  };
}
