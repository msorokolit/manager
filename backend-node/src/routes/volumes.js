// Volume management endpoints (the file-browser sidecar lives in volume-browser.js).
import { Router } from 'express';
import { authenticate, requireAdmin } from '../auth.js';
import { getClient } from '../docker-client.js';
import { asyncHandler, boolQuery, HttpError } from '../util.js';

const router = Router();
router.use(authenticate);

function summary(v) {
  return {
    name: v.Name,
    driver: v.Driver,
    mountpoint: v.Mountpoint,
    scope: v.Scope,
    created_at: v.CreatedAt,
    labels: v.Labels || {},
    options: v.Options || {},
  };
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const r = await getClient().listVolumes();
    res.json((r.Volumes || []).map(summary));
  }),
);

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.name) throw new HttpError(400, 'name is required');
    const v = await getClient().createVolume({
      Name: b.name,
      Driver: b.driver || 'local',
      Labels: b.labels || {},
      DriverOpts: b.driver_opts || {},
    });
    // dockerode's createVolume returns an object that has .inspect()
    const insp = await getClient().getVolume(b.name).inspect();
    res.json(summary(insp));
  }),
);

router.post(
  '/prune',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await getClient().pruneVolumes());
  }),
);

router.get(
  '/:name',
  asyncHandler(async (req, res) => {
    res.json(await getClient().getVolume(req.params.name).inspect());
  }),
);

router.delete(
  '/:name',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const force = boolQuery(req.query.force, false);
    await getClient().getVolume(req.params.name).remove({ force });
    res.json({ removed: req.params.name });
  }),
);

export default router;
