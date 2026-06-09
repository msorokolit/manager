// Volume management endpoints (file browser is in volume-browser.js).
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import { asyncHandler, boolQuery } from '../util.js';
import { createApiRouter } from '../route-builder.js';
import {
  CreateVolumeRequest,
  PassThroughObject,
  VolumeSummary,
} from '../schemas/index.js';

const r = createApiRouter('/api/volumes', { tag: 'volumes' });

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

const NameParam = Type.Object({ name: Type.String() }, { additionalProperties: false });
const RemoveQuery = Type.Object(
  { force: Type.Optional(Type.Boolean({ default: false })) },
  { additionalProperties: false },
);

r.get(
  '/',
  { summary: 'List volumes', responses: { 200: Type.Array(VolumeSummary) } },
  asyncHandler(async (_req, res) => {
    const list = await getClient().listVolumes();
    res.json((list.Volumes || []).map(summary));
  }),
);

r.post(
  '/',
  {
    summary: 'Create a volume',
    admin: true,
    body: CreateVolumeRequest,
    responses: { 200: VolumeSummary },
  },
  asyncHandler(async (req, res) => {
    const b = req.body;
    await getClient().createVolume({
      Name: b.name,
      Driver: b.driver,
      Labels: b.labels || {},
      DriverOpts: b.driver_opts || {},
    });
    res.json(summary(await getClient().getVolume(b.name).inspect()));
  }),
);

r.post(
  '/prune',
  { summary: 'Prune unused volumes', admin: true, responses: { 200: PassThroughObject } },
  asyncHandler(async (_req, res) => res.json(await getClient().pruneVolumes())),
);

r.get(
  '/:name',
  { summary: 'Inspect a volume', params: NameParam, responses: { 200: PassThroughObject } },
  asyncHandler(async (req, res) =>
    res.json(await getClient().getVolume(req.params.name).inspect()),
  ),
);

r.delete(
  '/:name',
  {
    summary: 'Remove a volume',
    admin: true,
    params: NameParam,
    query: RemoveQuery,
    responses: { 200: Type.Object({ removed: Type.String() }) },
  },
  asyncHandler(async (req, res) => {
    const force = boolQuery(req.query.force, false);
    await getClient().getVolume(req.params.name).remove({ force });
    res.json({ removed: req.params.name });
  }),
);

export default r;
