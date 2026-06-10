// Auto-generates the OpenAPI 3.1 document from the operation registry that
// each route file populates via createApiRouter().
//
// Adding a route doesn't require touching this file: just declare the route
// in its routes/<resource>.js with a `summary`, `body`, `params`, `query`
// and `responses` and it shows up in /api/openapi.json + Swagger UI.
import * as S from './schemas/index.js';
import { VERSION } from './config.js';

// All schemas with $id are emitted under components.schemas; refs are used
// in path operations so the spec stays compact and Swagger UI can group them
// in its "Schemas" pane.
const COMPONENT_SCHEMAS = [
  S.ErrorResponse,
  S.ValidationError,
  S.LoginRequest,
  S.LoginResponse,
  S.MeResponse,
  S.HealthResponse,
  S.ConfigResponse,
  S.PingResponse,
  S.TicketResponse,
  S.CreateContainerRequest,
  S.ContainerSummary,
  S.PullRequest,
  S.ImageSummary,
  S.CreateNetworkRequest,
  S.ConnectRequest,
  S.DisconnectRequest,
  S.NetworkSummary,
  S.CreateVolumeRequest,
  S.VolumeSummary,
  S.VolumeUsage,
  S.VolumeBulkDeleteRequest,
  S.VolumeBulkResponse,
  S.VolumeBrowseEntry,
  S.VolumeBrowseListResponse,
  S.VolumeBrowseRenameRequest,
  S.VolumeBrowseChmodRequest,
  S.VolumeBrowseChownRequest,
  S.VolumeBrowseBulkChmodRequest,
  S.VolumeBrowseBulkChownRequest,
  S.VolumeBrowseBulkDeleteRequest,
  S.VolumeBrowseBulkResponse,
  S.VolumeBrowseSaveRequest,
  S.VolumeBrowseSaveResponse,
  S.VolumeBrowseViewResponse,
  S.CreateStackRequest,
  S.UpdateStackRequest,
  S.StackSummary,
  S.StackDetail,
  S.ValidateResponse,
  S.RegistryRequest,
  S.RegistryUpdateRequest,
  S.RegistryPublic,
];

function ref(schema) {
  if (schema && schema.$id) return { $ref: `#/components/schemas/${schema.$id}` };
  return schema;
}
function inlineSchema(schema) {
  if (!schema) return undefined;
  // Strip $id when inlining inside a path operation so it doesn't conflict
  // with the components/schemas entry.
  if (schema.$id) return ref(schema);
  return schema;
}
function jsonResp(schema, description = 'OK') {
  return { description, content: { 'application/json': { schema: inlineSchema(schema) } } };
}
function jsonBody(schema, description = '') {
  return { required: true, description, content: { 'application/json': { schema: inlineSchema(schema) } } };
}
function streamResp(description, contentType = 'application/x-ndjson') {
  return { description, content: { [contentType]: { schema: { type: 'string' } } } };
}

const ERR_400 = jsonResp(S.ValidationError, 'Validation failed');
const ERR_401 = jsonResp(S.ErrorResponse, 'Missing or invalid bearer token');
const ERR_403 = jsonResp(S.ErrorResponse, 'Forbidden (admin role / destructive disabled)');
const ERR_404 = jsonResp(S.ErrorResponse, 'Resource not found');
const ERR_502 = jsonResp(S.ErrorResponse, 'Docker daemon error');
const ERR_503 = jsonResp(S.ErrorResponse, 'Docker daemon unreachable');

function expressPathToOpenApi(p) {
  return p.replace(/:(\w+)/g, '{$1}');
}

function buildResponses(op) {
  const out = {};
  if (op.responses) {
    for (const [code, val] of Object.entries(op.responses)) {
      if (val == null) continue;
      if (val.kind === 'stream') {
        out[code] = streamResp(val.description || 'Stream', val.contentType || 'application/x-ndjson');
      } else if (val.kind === 'custom') {
        out[code] = val.definition;
      } else if (val.content) {
        out[code] = val;
      } else {
        out[code] = jsonResp(val);
      }
    }
  }
  if (!Object.keys(out).length) out['200'] = { description: 'OK' };
  if ((op.body || op.params || op.query) && !out['400']) out['400'] = ERR_400;
  if (op.auth !== false && !out['401']) out['401'] = ERR_401;
  if (op.admin && !out['403']) out['403'] = ERR_403;
  // Most routes touch the daemon, so always include 502/503 unless the route
  // explicitly opted out (404 isn't always raised).
  if (!out['502']) out['502'] = ERR_502;
  if (!out['503']) out['503'] = ERR_503;
  return out;
}

function buildParameters(op) {
  // Allow explicit override via op.extra.openapiParams (used when the route
  // uses an Express regex path like /^\/((?!prune$).+)$/ where the path-name
  // can't be derived from the route definition).
  if (op.extra && Array.isArray(op.extra.openapiParams)) {
    return op.extra.openapiParams;
  }
  const params = [];
  if (op.params && op.params.properties) {
    for (const [name, schema] of Object.entries(op.params.properties)) {
      params.push({ name, in: 'path', required: true, schema });
    }
  }
  if (op.query && op.query.properties) {
    const required = op.query.required || [];
    for (const [name, schema] of Object.entries(op.query.properties)) {
      params.push({
        name,
        in: 'query',
        required: required.includes(name),
        schema,
      });
    }
  }
  return params;
}

function pathFor(op) {
  if (op.extra && op.extra.openapiPath) return op.extra.openapiPath;
  const raw = op.fullPath;
  // Skip routes whose Express path is a regex (no sensible OpenAPI mapping
  // unless the route declares extra.openapiPath).
  if (raw instanceof RegExp) return null;
  if (typeof raw !== 'string') return null;
  return expressPathToOpenApi(raw);
}

export function buildOpenApiSpec(operations, opts = {}) {
  const paths = {};
  const tagSet = new Set();
  for (const op of operations) {
    const p = pathFor(op);
    if (!p) continue;
    paths[p] = paths[p] || {};
    const operation = {
      tags: op.tags && op.tags.length ? op.tags : undefined,
      summary: op.summary,
      description: op.description,
      security: op.auth === false ? [] : [{ bearerAuth: [] }],
      parameters: buildParameters(op),
      requestBody: op.extra && op.extra.requestBody
        ? op.extra.requestBody
        : op.body
          ? jsonBody(op.body)
          : undefined,
      responses: buildResponses(op),
    };
    // Strip empty-array parameters / undefined fields so the spec stays clean.
    if (operation.parameters && operation.parameters.length === 0) {
      delete operation.parameters;
    }
    for (const k of Object.keys(operation)) {
      if (operation[k] === undefined) delete operation[k];
    }
    paths[p][op.method] = operation;
    for (const t of op.tags || []) tagSet.add(t);
  }

  // Always include the public meta endpoints — they aren't part of any
  // resource router but are always there.
  if (!paths['/api/health']) {
    paths['/api/health'] = {
      get: {
        tags: ['meta'], summary: 'Liveness probe', security: [],
        responses: { 200: jsonResp(S.HealthResponse) },
      },
    };
    tagSet.add('meta');
  }
  if (!paths['/api/config']) {
    paths['/api/config'] = {
      get: {
        tags: ['meta'], summary: 'Public configuration / feature flags', security: [],
        responses: { 200: jsonResp(S.ConfigResponse) },
      },
    };
    tagSet.add('meta');
  }

  // Stable tag order for the UI: meta first, then alphabetical.
  const tags = ['meta', ...[...tagSet].filter((t) => t !== 'meta').sort()].map(
    (name) => ({ name }),
  );

  return {
    openapi: '3.1.0',
    info: {
      title: 'Docker Manager API',
      version: VERSION,
      description:
        'Web UI + JSON API for managing enterprise systems running on Docker. ' +
        'Containers, images, networks, volumes (with file browser), compose stacks ' +
        '(with per-service controls), registry credentials, live observability ' +
        'streams, and an in-browser TTY (over WebSocket).\n\n' +
        'Authentication: `POST /api/auth/login` exchanges a username + password ' +
        'for an HS256 JWT, sent as `Authorization: Bearer <token>` on every ' +
        'subsequent request. The WebSocket exec endpoint uses a one-shot ticket ' +
        '(see `POST /api/exec/ticket`).\n\n' +
        'This document is **auto-generated** from the same TypeBox / JSON Schema ' +
        'fragments the runtime uses for validation — there is no hand-maintained ' +
        'OpenAPI definition.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: Object.fromEntries(
        COMPONENT_SCHEMAS.filter((s) => s && s.$id).map((s) => {
          const { $id, ...rest } = s;
          return [$id, rest];
        }),
      ),
    },
    tags,
    paths,
    // The exec WebSocket isn't an HTTP path. Document it under x-websockets
    // so spec consumers see it.
    'x-websockets': {
      '/api/containers/{id}/exec': {
        method: 'WS',
        summary: 'Bidirectional terminal stream (admin only, ticket-gated)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ticket', in: 'query', required: true, schema: { type: 'string' }, description: 'One-shot token from POST /api/exec/ticket' },
          { name: 'cmd', in: 'query', schema: { type: 'string', default: '/bin/sh' } },
          { name: 'cols', in: 'query', schema: { type: 'integer', default: 80 } },
          { name: 'rows', in: 'query', schema: { type: 'integer', default: 24 } },
        ],
      },
    },
  };
}
