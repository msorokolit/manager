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

/**
 * Shared path-param schema for `:name` routes (#35).
 *
 * Both `routes/volumes.js` and `routes/volume-browser.js` previously
 * defined the same inline `Type.Object({ name: Type.String() })`. The
 * shared definition keeps them in sync and gives the OpenAPI generator
 * one canonical parameter to reference.
 */
export const NameParam = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 255 }) },
  { additionalProperties: false },
);

// ---------- Bulk action plumbing ----------
//
// Every bulk endpoint in the API speaks the same shape:
//   request:  { ids: [...], ...options }       OR    { names: [...] }
//   response: { succeeded: N, failed: N, results: [...] }
//
// `results[i]` is one entry per request id/name with `ok: boolean` and
// `error?: string` on failure. The whole batch returns 200 even if
// every item failed — the client renders the per-item report.
//
// The helpers below build per-resource request schemas with bounded
// caps that match the rest of the API (max 500 items per batch, same as
// the volume/network bulks).

const MAX_BULK_ITEMS = 500;

export const BulkIdsRequest = Type.Object(
  {
    ids: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), {
      minItems: 1, maxItems: MAX_BULK_ITEMS,
    }),
  },
  { $id: 'BulkIdsRequest', additionalProperties: false },
);

export const BulkNamesRequest = Type.Object(
  {
    names: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), {
      minItems: 1, maxItems: MAX_BULK_ITEMS,
    }),
  },
  { $id: 'BulkNamesRequest', additionalProperties: false },
);

export const BulkResult = Type.Object(
  {
    // `id` is filled for resources keyed by ID (containers, images,
    // networks); `name` is filled for resources keyed by name
    // (volumes, stacks, registries). Exactly one is present per row.
    id: Opt(Type.String()),
    name: Opt(Type.String()),
    ok: Type.Boolean(),
    error: Opt(Type.String()),
  },
  { $id: 'BulkResult', additionalProperties: false },
);

export const BulkResponse = Type.Object(
  {
    succeeded: Type.Integer(),
    failed: Type.Integer(),
    results: Type.Array(BulkResult),
  },
  { $id: 'BulkResponse', additionalProperties: false },
);

// ---- Container bulks (per-action since options diverge) ----
//
// start/restart/pause/unpause/kill: ids only.
// stop: optional `timeout` (seconds to wait before SIGKILL — matches
//       docker stop -t).
// remove: optional `force` (running containers) + `volumes` (also remove
//         anonymous volumes attached to those containers).
export const ContainerBulkSimpleRequest = BulkIdsRequest;

export const ContainerBulkStopRequest = Type.Object(
  {
    ids: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), {
      minItems: 1, maxItems: MAX_BULK_ITEMS,
    }),
    timeout: Type.Optional(Type.Integer({ minimum: 0, maximum: 600, default: 10 })),
  },
  { $id: 'ContainerBulkStopRequest', additionalProperties: false },
);

export const ContainerBulkRemoveRequest = Type.Object(
  {
    ids: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), {
      minItems: 1, maxItems: MAX_BULK_ITEMS,
    }),
    force: Type.Optional(Type.Boolean({ default: false })),
    volumes: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'ContainerBulkRemoveRequest', additionalProperties: false },
);

// ---- Image bulk remove ----
export const ImageBulkRemoveRequest = Type.Object(
  {
    ids: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      minItems: 1, maxItems: MAX_BULK_ITEMS,
    }),
    force: Type.Optional(Type.Boolean({ default: false })),
    // `noprune` mirrors Docker's --no-prune flag (don't delete untagged
    // parent images). Default false so the bulk default matches the
    // user's intuition ("clean up the layers too").
    noprune: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'ImageBulkRemoveRequest', additionalProperties: false },
);

// ---- Stack bulk action ----
//
// `volumes` only meaningful for down/remove. Stacks are keyed by name.
export const StackBulkRequest = Type.Object(
  {
    names: Type.Array(Type.String({ minLength: 1, maxLength: 63 }), {
      minItems: 1, maxItems: MAX_BULK_ITEMS,
    }),
    volumes: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'StackBulkRequest', additionalProperties: false },
);

// ---- Registry bulk remove ----
export const RegistryBulkDeleteRequest = BulkNamesRequest;
