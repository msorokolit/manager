// Image management endpoints.
import { Router } from 'express';
import { authenticate, requireAdmin } from '../auth.js';
import { getClient } from '../docker-client.js';
import { asyncHandler, boolQuery, HttpError, pipeNdjson } from '../util.js';
import { validateBody } from '../validate.js';
import { PullRequest } from '../schemas/index.js';
import { getRegistryAuth } from './registries.js';

const router = Router();
router.use(authenticate);

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

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const list = await getClient().listImages({ all: false });
    res.json(list.map(summary));
  }),
);

router.post(
  '/pull',
  requireAdmin,
  validateBody(PullRequest),
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

router.post(
  '/prune',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const danglingOnly = boolQuery(req.query.dangling_only, true);
    const filters = danglingOnly ? { dangling: ['true'] } : {};
    res.json(await getClient().pruneImages({ filters }));
  }),
);

// :id may contain '/' (e.g. library/nginx); express 4 handles that with a
// regex param OR explicit (.*) capture.
router.get(
  /^\/((?!prune$).+)$/,
  asyncHandler(async (req, res) => {
    const id = req.params[0];
    res.json(await getClient().getImage(id).inspect());
  }),
);

router.delete(
  /^\/((?!prune$).+)$/,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = req.params[0];
    const force = boolQuery(req.query.force, false);
    await getClient().getImage(id).remove({ force });
    res.json({ removed: id });
  }),
);

export default router;
