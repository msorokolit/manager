// Shared TypeBox helpers + common response shapes.
import { Type } from '@sinclair/typebox';

/**
 * Make a field accept value | null | undefined.
 *
 * Mirrors the `opt()` helper we used with Zod so the per-route schemas read
 * the same way and the wire format is unchanged (the SPA tends to send
 * explicit `null` for "not set").
 */
export const Nullable = (T) => Type.Union([T, Type.Null()]);
export const Opt = (T) => Type.Optional(Nullable(T));

/**
 * Convenience wrapper for `{ type: 'string', enum: [...] }`. TypeBox's
 * `Type.Union([Literal('a'), Literal('b')])` produces a `oneOf` of consts
 * which Swagger UI renders less nicely, so we emit the canonical enum
 * keyword directly.
 */
export const StringEnum = (values, opts = {}) =>
  Type.Unsafe({ type: 'string', enum: values, ...opts });

export const ErrorResponse = Type.Object(
  {
    detail: Type.String({
      description: 'Human-readable error message',
    }),
  },
  {
    $id: 'ErrorResponse',
    description: 'Generic error envelope used across the API.',
    additionalProperties: true,
  },
);

const FieldError = Type.Object({
  path: Type.String({ description: 'Dotted path to the offending field, "" for root' }),
  message: Type.String(),
  code: Type.String({ description: 'AJV keyword that failed (e.g. "type", "required")' }),
});

export const ValidationError = Type.Object(
  {
    detail: Type.Literal('Validation failed'),
    errors: Type.Array(FieldError),
  },
  {
    $id: 'ValidationError',
    description: 'Returned with HTTP 400 when a request body or query fails JSON-schema validation.',
    additionalProperties: false,
  },
);
