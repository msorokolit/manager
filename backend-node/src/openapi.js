// Auto-generates the OpenAPI 3.1 document from the same TypeBox / JSON
// Schema fragments the routes use for validation. There's only one place to
// keep in sync: when you add a route, also add a path entry below.
//
// Each top-level schema imported here lives under components.schemas; routes
// reference them via `$ref: '#/components/schemas/<$id>'` so the spec stays
// readable and Swagger UI can group them in its "Schemas" pane.
import * as S from './schemas/index.js';
import { VERSION } from './config.js';

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
  S.VolumeBrowseEntry,
  S.VolumeBrowseListResponse,
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

function jsonResp(schema, description = 'OK') {
  return { description, content: { 'application/json': { schema: ref(schema) } } };
}
function jsonBody(schema, required = true, description = '') {
  return { required, description, content: { 'application/json': { schema: ref(schema) } } };
}
function streamResp(description, mediaType = 'application/x-ndjson') {
  return { description, content: { [mediaType]: { schema: { type: 'string' } } } };
}

const COMMON_RESPONSES = {
  400: jsonResp(S.ValidationError, 'Validation failed'),
  401: jsonResp(S.ErrorResponse, 'Missing or invalid bearer token'),
  403: jsonResp(S.ErrorResponse, 'Forbidden (admin role / destructive disabled)'),
  404: jsonResp(S.ErrorResponse, 'Resource not found'),
  502: jsonResp(S.ErrorResponse, 'Docker daemon error'),
  503: jsonResp(S.ErrorResponse, 'Docker daemon unreachable'),
};

const BEARER = [{ bearerAuth: [] }];

const parameter = (name, where, schema, opts = {}) => ({
  name,
  in: where,
  required: where === 'path' ? true : !!opts.required,
  schema,
  description: opts.description,
});

const PATH_NAME = parameter('name', 'path', { type: 'string' });
const PATH_ID = parameter('id', 'path', { type: 'string' });
const PATH_SERVICE = parameter('service', 'path', { type: 'string' });
const PATH_ACTION = parameter('action', 'path', { type: 'string', enum: S.SERVICE_ACTIONS });

const QUERY_TAIL = parameter('tail', 'query', { type: 'integer', default: 200, minimum: 1, maximum: 5000 });
const QUERY_FORCE = parameter('force', 'query', { type: 'boolean', default: false });
const QUERY_PATH = parameter('path', 'query', { type: 'string' });

function ok(schema) { return { 200: jsonResp(schema) }; }
function okWith(schema, extras = {}) { return { 200: jsonResp(schema), ...extras }; }

export function buildOpenApiSpec() {
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
        '(see `POST /api/exec/ticket`).',
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
    tags: [
      { name: 'meta' },
      { name: 'auth' },
      { name: 'system' },
      { name: 'containers' },
      { name: 'images' },
      { name: 'networks' },
      { name: 'volumes' },
      { name: 'volume-browser' },
      { name: 'stacks' },
      { name: 'registries' },
      { name: 'exec' },
    ],
    paths: {
      // ---------- meta ----------
      '/api/health': {
        get: {
          tags: ['meta'],
          summary: 'Liveness probe',
          security: [],
          responses: ok(S.HealthResponse),
        },
      },
      '/api/config': {
        get: {
          tags: ['meta'],
          summary: 'Public configuration / feature flags',
          security: [],
          responses: ok(S.ConfigResponse),
        },
      },

      // ---------- auth ----------
      '/api/auth/login': {
        post: {
          tags: ['auth'],
          summary: 'Exchange credentials for a JWT',
          security: [],
          requestBody: jsonBody(S.LoginRequest),
          responses: { 200: jsonResp(S.LoginResponse), 400: COMMON_RESPONSES[400], 401: COMMON_RESPONSES[401] },
        },
      },
      '/api/auth/me': {
        get: {
          tags: ['auth'],
          summary: 'Current user (validates the bearer token)',
          security: BEARER,
          responses: { 200: jsonResp(S.MeResponse), 401: COMMON_RESPONSES[401] },
        },
      },

      // ---------- system ----------
      '/api/system/ping': {
        get: { tags: ['system'], summary: 'Ping the Docker daemon', security: BEARER, responses: { 200: jsonResp(S.PingResponse), ...COMMON_RESPONSES } },
      },
      '/api/system/info': {
        get: { tags: ['system'], summary: 'docker info (raw)', security: BEARER, responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },
      '/api/system/version': {
        get: { tags: ['system'], summary: 'docker version (raw)', security: BEARER, responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },
      '/api/system/df': {
        get: { tags: ['system'], summary: 'Docker disk usage', security: BEARER, responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },
      '/api/system/events': {
        get: {
          tags: ['system'], summary: 'Recent docker events (bounded)', security: BEARER,
          parameters: [parameter('limit', 'query', { type: 'integer', default: 25, minimum: 1, maximum: 1000 })],
          responses: { 200: jsonResp({ type: 'array', items: { type: 'object', additionalProperties: true } }), ...COMMON_RESPONSES },
        },
      },
      '/api/system/events/stream': {
        get: {
          tags: ['system'], summary: 'Live docker events (NDJSON)', security: BEARER,
          responses: { 200: streamResp('NDJSON stream of docker event objects'), ...COMMON_RESPONSES },
        },
      },

      // ---------- containers ----------
      '/api/containers': {
        get: {
          tags: ['containers'], summary: 'List containers', security: BEARER,
          parameters: [parameter('all', 'query', { type: 'boolean', default: true })],
          responses: { 200: jsonResp({ type: 'array', items: ref(S.ContainerSummary) }), ...COMMON_RESPONSES },
        },
        post: {
          tags: ['containers'], summary: 'Create and start a container (admin)', security: BEARER,
          requestBody: jsonBody(S.CreateContainerRequest),
          responses: { 200: jsonResp(S.ContainerSummary), ...COMMON_RESPONSES },
        },
      },
      '/api/containers/prune': {
        post: { tags: ['containers'], summary: 'Prune stopped containers (admin)', security: BEARER, responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },
      '/api/containers/{id}': {
        get: { tags: ['containers'], summary: 'Inspect a container', security: BEARER, parameters: [PATH_ID], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
        delete: { tags: ['containers'], summary: 'Remove a container (admin)', security: BEARER, parameters: [PATH_ID, QUERY_FORCE, parameter('volumes', 'query', { type: 'boolean', default: false })], responses: { 200: jsonResp({ type: 'object' }), ...COMMON_RESPONSES } },
      },
      '/api/containers/{id}/start': { post: { tags: ['containers'], summary: 'Start (admin)', security: BEARER, parameters: [PATH_ID], responses: { 200: jsonResp(S.ContainerSummary), ...COMMON_RESPONSES } } },
      '/api/containers/{id}/stop': { post: { tags: ['containers'], summary: 'Stop (admin)', security: BEARER, parameters: [PATH_ID], responses: { 200: jsonResp(S.ContainerSummary), ...COMMON_RESPONSES } } },
      '/api/containers/{id}/restart': { post: { tags: ['containers'], summary: 'Restart (admin)', security: BEARER, parameters: [PATH_ID], responses: { 200: jsonResp(S.ContainerSummary), ...COMMON_RESPONSES } } },
      '/api/containers/{id}/pause': { post: { tags: ['containers'], summary: 'Pause (admin)', security: BEARER, parameters: [PATH_ID], responses: { 200: jsonResp(S.ContainerSummary), ...COMMON_RESPONSES } } },
      '/api/containers/{id}/unpause': { post: { tags: ['containers'], summary: 'Unpause (admin)', security: BEARER, parameters: [PATH_ID], responses: { 200: jsonResp(S.ContainerSummary), ...COMMON_RESPONSES } } },
      '/api/containers/{id}/kill': { post: { tags: ['containers'], summary: 'Kill (admin)', security: BEARER, parameters: [PATH_ID], responses: { 200: jsonResp(S.ContainerSummary), ...COMMON_RESPONSES } } },
      '/api/containers/{id}/logs': {
        get: {
          tags: ['containers'], summary: 'Tail logs (one-shot)', security: BEARER,
          parameters: [PATH_ID, QUERY_TAIL, parameter('timestamps', 'query', { type: 'boolean', default: false })],
          responses: { 200: jsonResp({ type: 'object', properties: { logs: { type: 'string' } }, required: ['logs'] }), ...COMMON_RESPONSES },
        },
      },
      '/api/containers/{id}/logs/stream': {
        get: { tags: ['containers'], summary: 'Follow logs (text stream)', security: BEARER, parameters: [PATH_ID, parameter('tail', 'query', { type: 'integer', default: 100 })], responses: { 200: streamResp('Raw container log bytes', 'text/plain'), ...COMMON_RESPONSES } },
      },
      '/api/containers/{id}/stats': {
        get: { tags: ['containers'], summary: 'One-shot stats sample', security: BEARER, parameters: [PATH_ID], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },
      '/api/containers/{id}/stats/stream': {
        get: { tags: ['containers'], summary: 'Live stats (NDJSON)', security: BEARER, parameters: [PATH_ID], responses: { 200: streamResp('NDJSON stream of stats samples'), ...COMMON_RESPONSES } },
      },

      // ---------- images ----------
      '/api/images': {
        get: { tags: ['images'], summary: 'List images', security: BEARER, responses: { 200: jsonResp({ type: 'array', items: ref(S.ImageSummary) }), ...COMMON_RESPONSES } },
      },
      '/api/images/pull': {
        post: { tags: ['images'], summary: 'Pull an image (admin, NDJSON progress stream)', security: BEARER, requestBody: jsonBody(S.PullRequest), responses: { 200: streamResp('NDJSON pull progress'), ...COMMON_RESPONSES } },
      },
      '/api/images/prune': {
        post: { tags: ['images'], summary: 'Prune images (admin)', security: BEARER, parameters: [parameter('dangling_only', 'query', { type: 'boolean', default: true })], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },
      '/api/images/{id}': {
        get: { tags: ['images'], summary: 'Inspect an image', security: BEARER, parameters: [PATH_ID], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
        delete: { tags: ['images'], summary: 'Remove an image (admin)', security: BEARER, parameters: [PATH_ID, QUERY_FORCE], responses: { 200: jsonResp({ type: 'object' }), ...COMMON_RESPONSES } },
      },

      // ---------- networks ----------
      '/api/networks': {
        get: { tags: ['networks'], summary: 'List networks', security: BEARER, responses: { 200: jsonResp({ type: 'array', items: ref(S.NetworkSummary) }), ...COMMON_RESPONSES } },
        post: { tags: ['networks'], summary: 'Create network (admin)', security: BEARER, requestBody: jsonBody(S.CreateNetworkRequest), responses: { 200: jsonResp(S.NetworkSummary), ...COMMON_RESPONSES } },
      },
      '/api/networks/prune': { post: { tags: ['networks'], summary: 'Prune unused networks (admin)', security: BEARER, responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } } },
      '/api/networks/{id}': {
        get: { tags: ['networks'], summary: 'Inspect a network', security: BEARER, parameters: [PATH_ID], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
        delete: { tags: ['networks'], summary: 'Remove a network (admin)', security: BEARER, parameters: [PATH_ID], responses: { 200: jsonResp({ type: 'object' }), ...COMMON_RESPONSES } },
      },
      '/api/networks/{id}/connect': {
        post: { tags: ['networks'], summary: 'Connect a container (admin)', security: BEARER, parameters: [PATH_ID], requestBody: jsonBody(S.ConnectRequest), responses: { 200: jsonResp({ type: 'object' }), ...COMMON_RESPONSES } },
      },
      '/api/networks/{id}/disconnect': {
        post: { tags: ['networks'], summary: 'Disconnect a container (admin)', security: BEARER, parameters: [PATH_ID], requestBody: jsonBody(S.DisconnectRequest), responses: { 200: jsonResp({ type: 'object' }), ...COMMON_RESPONSES } },
      },

      // ---------- volumes ----------
      '/api/volumes': {
        get: { tags: ['volumes'], summary: 'List volumes', security: BEARER, responses: { 200: jsonResp({ type: 'array', items: ref(S.VolumeSummary) }), ...COMMON_RESPONSES } },
        post: { tags: ['volumes'], summary: 'Create volume (admin)', security: BEARER, requestBody: jsonBody(S.CreateVolumeRequest), responses: { 200: jsonResp(S.VolumeSummary), ...COMMON_RESPONSES } },
      },
      '/api/volumes/prune': { post: { tags: ['volumes'], summary: 'Prune unused volumes (admin)', security: BEARER, responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } } },
      '/api/volumes/{name}': {
        get: { tags: ['volumes'], summary: 'Inspect a volume', security: BEARER, parameters: [PATH_NAME], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
        delete: { tags: ['volumes'], summary: 'Remove a volume (admin)', security: BEARER, parameters: [PATH_NAME, QUERY_FORCE], responses: { 200: jsonResp({ type: 'object' }), ...COMMON_RESPONSES } },
      },

      // ---------- volume-browser ----------
      '/api/volumes/{name}/browse/list': {
        get: { tags: ['volume-browser'], summary: 'List a directory inside a volume', security: BEARER, parameters: [PATH_NAME, QUERY_PATH], responses: { 200: jsonResp(S.VolumeBrowseListResponse), ...COMMON_RESPONSES } },
      },
      '/api/volumes/{name}/browse/file': {
        get: {
          tags: ['volume-browser'], summary: 'Download a file', security: BEARER,
          parameters: [PATH_NAME, { ...QUERY_PATH, required: true }],
          responses: { 200: { description: 'File bytes', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, ...COMMON_RESPONSES },
        },
        post: {
          tags: ['volume-browser'], summary: 'Upload a file (admin)', security: BEARER,
          parameters: [PATH_NAME, QUERY_PATH],
          requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } } } },
          responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES },
        },
        delete: { tags: ['volume-browser'], summary: 'Delete a file or directory (admin)', security: BEARER, parameters: [PATH_NAME, { ...QUERY_PATH, required: true }], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },
      '/api/volumes/{name}/browse/mkdir': {
        post: { tags: ['volume-browser'], summary: 'Make a directory (admin)', security: BEARER, parameters: [PATH_NAME, { ...QUERY_PATH, required: true }], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },
      '/api/volumes/{name}/browse/stop': {
        post: { tags: ['volume-browser'], summary: 'Stop the volume-browser sidecar (admin)', security: BEARER, parameters: [PATH_NAME], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },

      // ---------- stacks ----------
      '/api/stacks': {
        get: { tags: ['stacks'], summary: 'List stacks (managed + discovered)', security: BEARER, responses: { 200: jsonResp({ type: 'array', items: ref(S.StackSummary) }), ...COMMON_RESPONSES } },
        post: { tags: ['stacks'], summary: 'Create a stack (admin); streams compose stdout if deploy=true', security: BEARER, requestBody: jsonBody(S.CreateStackRequest), responses: { 200: streamResp('compose up -d stdout (text/plain) or {name, deployed:false}', 'text/plain'), ...COMMON_RESPONSES } },
      },
      '/api/stacks/{name}': {
        get: { tags: ['stacks'], summary: 'Get stack detail', security: BEARER, parameters: [PATH_NAME], responses: { 200: jsonResp(S.StackDetail), ...COMMON_RESPONSES } },
        put: { tags: ['stacks'], summary: 'Replace compose / env files (admin)', security: BEARER, parameters: [PATH_NAME], requestBody: jsonBody(S.UpdateStackRequest), responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
        delete: { tags: ['stacks'], summary: 'Tear down + remove a managed stack (admin)', security: BEARER, parameters: [PATH_NAME], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },
      '/api/stacks/{name}/up': { post: { tags: ['stacks'], summary: 'compose up -d (admin, streamed)', security: BEARER, parameters: [PATH_NAME], responses: { 200: streamResp('compose stdout', 'text/plain'), ...COMMON_RESPONSES } } },
      '/api/stacks/{name}/down': { post: { tags: ['stacks'], summary: 'compose down (admin, streamed)', security: BEARER, parameters: [PATH_NAME, parameter('volumes', 'query', { type: 'boolean', default: false })], responses: { 200: streamResp('compose stdout', 'text/plain'), ...COMMON_RESPONSES } } },
      '/api/stacks/{name}/restart': { post: { tags: ['stacks'], summary: 'compose restart (admin, streamed)', security: BEARER, parameters: [PATH_NAME], responses: { 200: streamResp('compose stdout', 'text/plain'), ...COMMON_RESPONSES } } },
      '/api/stacks/{name}/pull': { post: { tags: ['stacks'], summary: 'compose pull (admin, streamed)', security: BEARER, parameters: [PATH_NAME], responses: { 200: streamResp('compose stdout', 'text/plain'), ...COMMON_RESPONSES } } },
      '/api/stacks/{name}/logs': { get: { tags: ['stacks'], summary: 'compose logs (streamed)', security: BEARER, parameters: [PATH_NAME, QUERY_TAIL], responses: { 200: streamResp('compose logs', 'text/plain'), ...COMMON_RESPONSES } } },
      '/api/stacks/{name}/validate': { post: { tags: ['stacks'], summary: 'compose config -q', security: BEARER, parameters: [PATH_NAME], responses: { 200: jsonResp(S.ValidateResponse), ...COMMON_RESPONSES } } },
      '/api/stacks/{name}/services/{service}/{action}': {
        post: {
          tags: ['stacks'], summary: 'Per-service compose action (admin, streamed)', security: BEARER,
          parameters: [PATH_NAME, PATH_SERVICE, PATH_ACTION],
          responses: { 200: streamResp('compose stdout', 'text/plain'), ...COMMON_RESPONSES },
        },
      },
      '/api/stacks/{name}/services/{service}/logs': {
        get: { tags: ['stacks'], summary: 'Per-service compose logs (streamed)', security: BEARER, parameters: [PATH_NAME, PATH_SERVICE, QUERY_TAIL], responses: { 200: streamResp('compose logs', 'text/plain'), ...COMMON_RESPONSES } },
      },

      // ---------- registries ----------
      '/api/registries': {
        get: { tags: ['registries'], summary: 'List stored registry credentials', security: BEARER, responses: { 200: jsonResp({ type: 'array', items: ref(S.RegistryPublic) }), ...COMMON_RESPONSES } },
        post: { tags: ['registries'], summary: 'Add or replace a registry (admin)', security: BEARER, requestBody: jsonBody(S.RegistryRequest), responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },
      '/api/registries/{name}': {
        put: { tags: ['registries'], summary: 'Add or replace by path (admin)', security: BEARER, parameters: [PATH_NAME], requestBody: jsonBody(S.RegistryUpdateRequest), responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
        delete: { tags: ['registries'], summary: 'Delete a registry (admin)', security: BEARER, parameters: [PATH_NAME], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },
      '/api/registries/{name}/test': {
        post: { tags: ['registries'], summary: 'Test login against the saved credentials (admin)', security: BEARER, parameters: [PATH_NAME], responses: { 200: jsonResp(S.PassThroughObject), ...COMMON_RESPONSES } },
      },

      // ---------- exec ----------
      '/api/exec/ticket': {
        post: {
          tags: ['exec'],
          summary: 'Mint a one-shot 60s WebSocket ticket (admin)',
          description:
            'Returns a token that authorises a single connection to the WebSocket exec ' +
            'endpoint. Tickets cannot be replayed and expire after 60s.',
          security: BEARER,
          responses: { 200: jsonResp(S.TicketResponse), 401: COMMON_RESPONSES[401], 403: COMMON_RESPONSES[403] },
        },
      },
    },
    // The exec WebSocket isn't an HTTP path, but we document it under
    // x-webhooks so consumers see it in the spec. Swagger UI v5 doesn't
    // render this section, but it's useful for spec readers.
    'x-websockets': {
      '/api/containers/{id}/exec': {
        method: 'WS',
        summary: 'Bidirectional terminal stream (admin only, ticket-gated)',
        parameters: [
          PATH_ID,
          parameter('ticket', 'query', { type: 'string' }, { description: 'One-shot token from POST /api/exec/ticket' }),
          parameter('cmd', 'query', { type: 'string', default: '/bin/sh' }),
          parameter('cols', 'query', { type: 'integer', default: 80 }),
          parameter('rows', 'query', { type: 'integer', default: 24 }),
        ],
      },
    },
  };
}
