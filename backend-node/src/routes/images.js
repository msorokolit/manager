// Image management endpoints.
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import { asyncHandler, boolQuery, HttpError, pipeNdjson } from '../util.js';
import { createApiRouter, streamResponse } from '../route-builder.js';
import {
  ImageIdParam,
  ImageSummary,
  PassThroughObject,
  PullRequest,
} from '../schemas/index.js';
import { validateParams } from '../validate.js';
import { getRegistryAuth } from './registries.js';

const r = createApiRouter('/api/images', { tag: 'images' });

// Image references can contain '/' (e.g. ai/llama3.2), which Express's `:id`
// placeholder won't capture in a single segment. Use a regex *route* but
// strip the leading slash and validate the captured ref against the schema
// before reaching the handler.
const IMAGE_REF_REGEX = /^\/((?!prune$|prune\/).+)$/;

function imageIdFromCapture(req, res, next) {
  // The Express regex route puts the capture in req.params[0]; copy it to
  // req.params.id so validateParams + handlers can use a normal name. We
  // also delete the numeric key so additionalProperties:false in
  // ImageIdParam doesn't reject it as an unknown field.
  if (req.params[0] != null) {
    req.params.id = req.params[0];
    delete req.params[0];
  }
  next();
}
const validateImageId = validateParams(ImageIdParam);

function summary(i) {
  return {
    id: i.Id,
    short_id: (i.Id || '').replace(/^sha256:/, '').slice(0, 12),
    tags: i.RepoTags || [],
    size: i.Size,
    created: i.Created ? new Date(i.Created * 1000).toISOString() : null,
    architecture: i.Architecture || null,
    os: i.Os || null,
    labels: i.Labels || {},
  };
}

const PruneQuery = Type.Object(
  { dangling_only: Type.Optional(Type.Boolean({ default: true })) },
  { additionalProperties: false },
);
const RemoveQuery = Type.Object(
  { force: Type.Optional(Type.Boolean({ default: false })) },
  { additionalProperties: false },
);
const IdParam = Type.Object({ id: Type.String() }, { additionalProperties: false });

r.get(
  '/',
  { summary: 'List images', responses: { 200: Type.Array(ImageSummary) } },
  asyncHandler(async (_req, res) => {
    const list = await getClient().listImages({ all: false });
    res.json(list.map(summary));
  }),
);

r.post(
  '/pull',
  {
    summary: 'Pull an image (NDJSON progress stream)',
    admin: true,
    destructive: true,
    expensive: true,
    body: PullRequest,
    responses: { 200: streamResponse('NDJSON pull progress') },
  },
  asyncHandler(async (req, res) => {
    const { repository, tag = null, registry = null } = req.body;
    let authconfig = null;
    if (registry) {
      authconfig = await getRegistryAuth(registry);
      if (!authconfig) {
        throw new HttpError(
          400,
          `Unknown registry '${registry}'. Add it under Registries first.`,
        );
      }
    }
    const docker = getClient();
    const ref = tag ? `${repository}:${tag}` : repository;
    const opts = authconfig ? { authconfig } : undefined;
    docker.pull(ref, opts, (err, stream) => {
      if (err) {
        if (!res.headersSent) res.status(502).json({ detail: err.message });
        return;
      }
      pipeNdjson(stream, res);
    });
  }),
);

r.post(
  '/prune',
  {
    summary: 'Prune images',
    admin: true,
    destructive: true,
    query: PruneQuery,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const danglingOnly = boolQuery(req.query.dangling_only, true);
    const filters = danglingOnly ? { dangling: ['true'] } : {};
    res.json(await getClient().pruneImages({ filters }));
  }),
);

// :id may contain '/' (e.g. ai/llama3.2 or library/nginx) so we use a regex
// route, but we run our normal schema validation on the captured value.
// The route-builder's middleware order is auth -> requireAdmin -> params ->
// query -> body, so we slot imageIdFromCapture + validateImageId in *before*
// any route handler runs.
r.get(
  IMAGE_REF_REGEX,
  {
    summary: 'Inspect an image',
    responses: { 200: PassThroughObject },
    extra: {
      openapiPath: '/api/images/{id}',
      openapiParams: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[A-Za-z0-9._:@/-]+$' },
        },
      ],
    },
  },
  imageIdFromCapture,
  validateImageId,
  asyncHandler(async (req, res) => {
    res.json(await getClient().getImage(req.params.id).inspect());
  }),
);

r.delete(
  IMAGE_REF_REGEX,
  {
    summary: 'Remove an image',
    admin: true,
    destructive: true,
    query: RemoveQuery,
    responses: { 200: Type.Object({ removed: Type.String() }) },
    extra: {
      openapiPath: '/api/images/{id}',
      openapiParams: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[A-Za-z0-9._:@/-]+$' },
        },
      ],
    },
  },
  imageIdFromCapture,
  validateImageId,
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const force = boolQuery(req.query.force, false);
    await getClient().getImage(id).remove({ force });
    res.json({ removed: id });
  }),
);

export default r;
