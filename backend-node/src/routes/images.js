// Image management endpoints.
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import { asyncHandler, boolQuery, HttpError, pipeNdjson } from '../util.js';
import { createApiRouter, streamResponse } from '../route-builder.js';
import { ImageSummary, PassThroughObject, PullRequest } from '../schemas/index.js';
import { getRegistryAuth } from './registries.js';

const r = createApiRouter('/api/images', { tag: 'images' });

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
    query: PruneQuery,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const danglingOnly = boolQuery(req.query.dangling_only, true);
    const filters = danglingOnly ? { dangling: ['true'] } : {};
    res.json(await getClient().pruneImages({ filters }));
  }),
);

// :id may contain '/' (e.g. library/nginx); express 4 needs a regex param.
r.get(
  /^\/((?!prune$).+)$/,
  {
    summary: 'Inspect an image',
    responses: { 200: PassThroughObject },
    // The regex param doesn't translate to OpenAPI; document as /api/images/{id}.
    extra: { openapiPath: '/api/images/{id}', openapiParams: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
  },
  asyncHandler(async (req, res) => {
    res.json(await getClient().getImage(req.params[0]).inspect());
  }),
);

r.delete(
  /^\/((?!prune$).+)$/,
  {
    summary: 'Remove an image',
    admin: true,
    query: RemoveQuery,
    responses: { 200: Type.Object({ removed: Type.String() }) },
    extra: { openapiPath: '/api/images/{id}', openapiParams: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
  },
  asyncHandler(async (req, res) => {
    const id = req.params[0];
    const force = boolQuery(req.query.force, false);
    await getClient().getImage(id).remove({ force });
    res.json({ removed: id });
  }),
);

export default r;
