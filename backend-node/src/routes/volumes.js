// Volume management endpoints (file browser is in volume-browser.js).
//
// We enrich the daemon's volume list with three things Portainer ships
// out of the box but Docker's /volumes API doesn't carry:
//   - which containers are using the volume right now, and in what mode
//   - the owning compose project (via the com.docker.compose.project label)
//   - on-disk size (via /system/df, best-effort: it's slow on huge hosts)
//
// And one Portainer-equivalent feature: the `com.docker.manager.readonly`
// label, set at volume create time, that disables every write operation
// in the file manager. Labels are immutable in Docker (no PATCH endpoint
// for them), so flipping read-only on an existing volume requires a
// delete + recreate-with-label cycle. That's the same contract the
// `com.docker.compose.*` labels work under.
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import { asyncHandler, boolQuery } from '../util.js';
import { createApiRouter } from '../route-builder.js';
import {
  CreateVolumeRequest,
  PassThroughObject,
  VolumeBulkDeleteRequest,
  VolumeBulkResponse,
  VolumeSummary,
} from '../schemas/index.js';

const r = createApiRouter('/api/volumes', { tag: 'volumes' });

const READONLY_LABEL = 'com.docker.manager.readonly';
const STACK_LABEL = 'com.docker.compose.project';

/** True iff the volume's native labels mark it read-only. */
export function isVolumeReadOnly(labels) {
  return (labels || {})[READONLY_LABEL] === 'true';
}

// Build a {volume_name -> [{container_id, container_name, mount_path, rw}]}
// map from a single listContainers(all) call. We do this once per /volumes
// request rather than per-volume to keep the cost bounded.
function indexUsage(containers) {
  const out = new Map();
  for (const c of containers || []) {
    for (const m of c.Mounts || []) {
      if (m.Type !== 'volume' || !m.Name) continue;
      const list = out.get(m.Name) || [];
      list.push({
        container_id: c.Id,
        container_name: (c.Names && c.Names[0] || '').replace(/^\//, ''),
        mount_path: m.Destination || '',
        // The Engine reports `RW: true|false`. Default to `true` (the
        // Docker default) if the field is absent.
        rw: m.RW !== false,
      });
      out.set(m.Name, list);
    }
  }
  return out;
}

// /system/df is the only Engine endpoint that reports per-volume disk
// usage. It walks the volume tree, which can be very slow on hosts with
// big volumes — that's why Docker's own `docker volume ls` doesn't show
// it by default. We make the call best-effort and ship null sizes if
// it fails / times out, so the volume list is always responsive.
async function diskUsageMap() {
  try {
    const df = await getClient().df();
    const out = new Map();
    for (const v of df.Volumes || []) {
      const sz = (v.UsageData && typeof v.UsageData.Size === 'number') ? v.UsageData.Size : -1;
      out.set(v.Name, sz);
    }
    return out;
  } catch {
    return new Map();
  }
}

function enrich(v, { usage, sizes }) {
  const labels = v.Labels || {};
  const used = usage.get(v.Name) || [];
  const sz = sizes.has(v.Name) ? sizes.get(v.Name) : null;
  return {
    name: v.Name,
    driver: v.Driver,
    mountpoint: v.Mountpoint,
    scope: v.Scope,
    created_at: v.CreatedAt,
    labels,
    options: v.Options || {},
    stack: labels[STACK_LABEL] || null,
    in_use: used.length > 0,
    used_by: used,
    size_bytes: sz,
    read_only: isVolumeReadOnly(labels),
  };
}

const NameParam = Type.Object({ name: Type.String() }, { additionalProperties: false });
const ListQuery = Type.Object(
  {
    // Skip the slow /system/df call when the caller doesn't care about
    // sizes (e.g. background polling). Defaults true so the list view
    // gets sizes by default.
    sizes: Type.Optional(Type.Boolean({ default: true })),
  },
  { additionalProperties: false },
);
const RemoveQuery = Type.Object(
  { force: Type.Optional(Type.Boolean({ default: false })) },
  { additionalProperties: false },
);

r.get(
  '/',
  {
    summary: 'List volumes (enriched: usage, stack owner, size, read-only marker)',
    query: ListQuery,
    responses: { 200: Type.Array(VolumeSummary) },
  },
  asyncHandler(async (req, res) => {
    const wantSizes = boolQuery(req.query.sizes, true);
    const docker = getClient();
    const [list, containers, sizes] = await Promise.all([
      docker.listVolumes(),
      docker.listContainers({ all: true }),
      wantSizes ? diskUsageMap() : Promise.resolve(new Map()),
    ]);
    const usage = indexUsage(containers);
    res.json((list.Volumes || []).map((v) => enrich(v, { usage, sizes })));
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
    const docker = getClient();
    await docker.createVolume({
      Name: b.name,
      Driver: b.driver,
      Labels: b.labels || {},
      DriverOpts: b.driver_opts || {},
    });
    // Echo the enriched shape so the SPA can drop it straight into the
    // table without a follow-up /list call.
    const v = await docker.getVolume(b.name).inspect();
    const [containers, sizes] = await Promise.all([
      docker.listContainers({ all: true }),
      diskUsageMap(),
    ]);
    res.json(enrich(v, { usage: indexUsage(containers), sizes }));
  }),
);

r.post(
  '/prune',
  { summary: 'Prune unused volumes', admin: true, responses: { 200: PassThroughObject } },
  asyncHandler(async (_req, res) => res.json(await getClient().pruneVolumes())),
);

/**
 * Bulk delete (multi-select on the volume list).
 *
 * Per-volume failures (in-use, not-found, daemon error) come back in
 * `results` so the UI can render a row-by-row report. We never fail
 * the whole request because one volume was busy.
 */
r.post(
  '/delete/bulk',
  {
    summary: 'Delete many volumes at once (multi-select)',
    admin: true,
    body: VolumeBulkDeleteRequest,
    responses: { 200: VolumeBulkResponse },
  },
  asyncHandler(async (req, res) => {
    const force = !!req.body.force;
    const results = [];
    for (const name of req.body.names) {
      const item = { name };
      try {
        await getClient().getVolume(name).remove({ force });
        item.ok = true;
      } catch (err) {
        item.ok = false;
        if (err.statusCode === 404) item.error = 'Not found';
        else if (err.statusCode === 409) item.error = 'Volume is in use (try ?force=true once nothing is mounting it)';
        else item.error = err.message || 'unknown error';
      }
      results.push(item);
    }
    res.json({
      succeeded: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok).length,
      results,
    });
  }),
);

r.get(
  '/:name',
  {
    summary: 'Inspect a volume (enriched with usage, stack, read-only marker)',
    params: NameParam,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const docker = getClient();
    const [v, containers] = await Promise.all([
      docker.getVolume(req.params.name).inspect(),
      docker.listContainers({ all: true }),
    ]);
    const labels = v.Labels || {};
    const usage = indexUsage(containers);
    res.json({
      ...v,
      UsedBy: usage.get(req.params.name) || [],
      InUse: (usage.get(req.params.name) || []).length > 0,
      ReadOnly: isVolumeReadOnly(labels),
      Stack: labels[STACK_LABEL] || null,
    });
  }),
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
