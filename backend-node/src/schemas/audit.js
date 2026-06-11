// Audit log shapes. Kept in schemas/ so the OpenAPI generator picks
// them up alongside every other resource schema.
import { Type } from '@sinclair/typebox';
import { Opt, StringEnum } from './_common.js';

/**
 * One row in the audit log. `request_id` ties an entry back to the
 * application log line(s) for the same HTTP request — pino emits the
 * request_id in every log record by way of the AsyncLocalStorage mixin
 * in src/logger.js, so an operator can `grep` for it across both files
 * to reconstruct what happened.
 */
export const AuditEntry = Type.Object(
  {
    ts: Type.String({ description: 'ISO 8601 timestamp when the request finished' }),
    request_id: Opt(Type.String({ description: 'Correlation ID; matches X-Request-Id and the app log' })),
    actor: Opt(Type.Object({
      username: Type.String(),
      role: Type.String(),
    }, { additionalProperties: true })),
    source_ip: Opt(Type.String()),
    method: Type.String(),
    path: Type.String({ description: 'Original request URL (with any query string)' }),
    action: Type.String({ description: 'Derived dotted name, e.g. container.start or volume.delete.bulk' }),
    resource_type: Opt(Type.String({ description: 'Singular noun for the kind: container, image, volume, network, stack, registry' })),
    resource_id: Opt(Type.String({ description: 'Specific id/name when the request targets one resource; [N items] for bulks' })),
    outcome: StringEnum(['ok', 'error'], { description: 'ok = 2xx/3xx, error = 4xx/5xx' }),
    status: Type.Integer(),
    duration_ms: Type.Number(),
    error: Opt(Type.String({ description: 'Error detail when outcome=error (capped at 1024 chars)' })),
  },
  { $id: 'AuditEntry', additionalProperties: true },
);

export const AuditQueryResponse = Type.Object(
  {
    total: Type.Integer({ description: 'Filtered match count across all rotated files' }),
    returned: Type.Integer(),
    has_more: Type.Boolean(),
    entries: Type.Array(AuditEntry),
  },
  { $id: 'AuditQueryResponse', additionalProperties: false },
);
