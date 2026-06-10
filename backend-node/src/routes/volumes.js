// Volume management endpoints (file browser is in volume-browser.js).
//
// We enrich the daemon's volume list with three things Portainer ships
// out of the box but Docker's /volumes API doesn't carry:
//   - which containers are using the volume right now, and in what mode
//     (each used_by entry carries the kernel mount mode as `rw`)
//   - the owning compose project (via the com.docker.compose.project label)
//   - on-disk size (via /system/df, best-effort: it's slow on huge hosts)
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import { asyncHandler, boolQuery, HttpError } from '../util.js';
import { createApiRouter } from '../route-builder.js';
import {
  CreateVolumeRequest,
  NameParam,
  PassThroughObject,
  VolumeBulkDeleteRequest,
  VolumeBulkResponse,
  VolumeDetail,
  VolumeSummary,
} from '../schemas/index.js';

const r = createApiRouter('/api/volumes', { tag: 'volumes' });

const STACK_LABEL = 'com.docker.compose.project';

// Build a {volume_name -> [{container_id, container_name, mount_path, rw}]}
// map from a single listContainers(all) call. We do this once per /volumes
// request rather than per-volume to keep the cost bounded.
export function indexUsage(containers) {
  const out = new Map();
  for (const c of containers || []) {
    for (const m of c.Mounts || []) {
      if (m.Type !== 'volume' || !m.Name) continue;
      const list = out.get(m.Name) || [];
      list.push({
        container_id: c.Id,
        // Prefer the shortest non-empty name when a container has aliases —
        // that's usually the human-recognisable one (`web-1` over a long
        // randomly-suffixed alias).
        container_name: pickContainerName(c.Names),
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

function pickContainerName(names) {
  if (!Array.isArray(names) || names.length === 0) return '';
  const cleaned = names
    .map((n) => (n || '').replace(/^\//, ''))
    .filter(Boolean);
  if (cleaned.length === 0) return '';
  // Shortest first; ties broken by alphabetical so the result is stable.
  cleaned.sort((a, b) => (a.length - b.length) || a.localeCompare(b));
  return cleaned[0];
}

// /system/df is the only Engine endpoint that reports per-volume disk
// usage. It walks the volume tree, which can be very slow on hosts with
// big volumes — that's why Docker's own `docker volume ls` doesn't show
// it by default. We make the call best-effort and ship null sizes if
// it fails / times out, so the volume list is always responsive.
export async function diskUsageMap(logger = console) {
  try {
    const df = await getClient().df();
    const out = new Map();
    for (const v of df.Volumes || []) {
      const sz = (v.UsageData && typeof v.UsageData.Size === 'number') ? v.UsageData.Size : -1;
      out.set(v.Name, sz);
    }
    return out;
  } catch (err) {
    // Don't fail the whole list — but DO surface the problem so operators
    // can distinguish "slow" from "broken" without inspecting access logs.
    if (logger && logger.warn) {
      logger.warn(`[volumes] /system/df failed: ${err.message || err}`);
    }
    return new Map();
  }
}

export function enrich(v, { usage, sizes }) {
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
  };
}

// `NameParam` is shared with volume-browser via schemas/_common.js (#35).
const ListQuery = Type.Object(
  {
    // Skip the slow /system/df call when the caller doesn't care about
    // sizes (e.g. background polling). Defaults true so the list view
    // gets sizes by default; the SPA passes `?sizes=false` on background
    // refreshes (#14) and a Sizes button to opt in.
    sizes: Type.Optional(Type.Boolean({ default: true })),
  },
  { additionalProperties: false },
);
const RemoveQuery = Type.Object(
  {
    // Default is FALSE — Docker's volume rm refuses to delete a volume
    // that's currently mounted by any container. Set `?force=true` to
    // force-remove anyway; the SPA prompts a second confirm before
    // sending this (#1: was silently always-true previously).
    force: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);

r.get(
  '/',
  {
    summary: 'List volumes (enriched: usage with per-container rw/ro mode, stack owner, size)',
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
    // 201 Created — REST convention, not 200 (#11). The body is a
    // minimal VolumeSummary echo so the SPA can prepend the row
    // optimistically (#28) without paying the full enrichment cost
    // (#15: previously we re-ran listContainers + df after every
    // create just to compute fields a brand-new volume can't have).
    responses: { 201: VolumeSummary },
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
    // A volume that was just created can't possibly be in use yet, and
    // /system/df on a 0-byte volume returns 0 — skip both queries and
    // synthesise the empty enrichment in-process.
    try {
      const v = await docker.getVolume(b.name).inspect();
      res.status(201).json(enrich(v, { usage: new Map(), sizes: new Map() }));
    } catch (err) {
      // If the post-create inspect fails, the volume nonetheless exists.
      // Best-effort: tell the client what we created so they don't retry
      // and trip an "already exists" conflict. The full row will appear
      // on the next list refresh.
      res.status(201).json({
        name: b.name,
        driver: b.driver || 'local',
        mountpoint: '',
        scope: 'local',
        labels: b.labels || {},
        options: b.driver_opts || {},
        in_use: false,
        used_by: [],
      });
    }
  }),
);

r.post(
  '/prune',
  {
    summary: 'Prune unused volumes',
    admin: true,
    destructive: true,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (_req, res) => res.json(await getClient().pruneVolumes())),
);

/**
 * Bulk delete (multi-select on the volume list).
 *
 * Per-volume failures (in-use, not-found, daemon error) come back in
 * `results` so the UI can render a row-by-row report. We never fail
 * the whole request because one volume was busy.
 *
 * #16: deletes run with bounded parallelism (max 5 in flight) so a
 * 100-volume bulk doesn't take a minute end-to-end against a slow
 * daemon — but we still don't fan out so wide that we overwhelm it.
 */
r.post(
  '/delete/bulk',
  {
    summary: 'Delete many volumes at once (multi-select)',
    admin: true,
    destructive: true,
    body: VolumeBulkDeleteRequest,
    responses: { 200: VolumeBulkResponse },
  },
  asyncHandler(async (req, res) => {
    const force = !!req.body.force;
    const names = req.body.names;

    async function deleteOne(name) {
      const item = { name };
      try {
        await getClient().getVolume(name).remove({ force });
        item.ok = true;
      } catch (err) {
        item.ok = false;
        if (err.statusCode === 404) item.error = 'Not found';
        else if (err.statusCode === 409) {
          item.error = 'Volume is in use (retry with `"force": true` in the request body once nothing is mounting it)';
        } else item.error = err.message || 'unknown error';
      }
      return item;
    }

    // Bounded parallelism: chunk the work and resolve each chunk before
    // the next. Preserves request order in the results.
    const CONCURRENCY = 5;
    const results = new Array(names.length);
    for (let i = 0; i < names.length; i += CONCURRENCY) {
      const slice = names.slice(i, i + CONCURRENCY);
      const out = await Promise.all(slice.map(deleteOne));
      for (let j = 0; j < out.length; j++) results[i + j] = out[j];
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
    summary: 'Inspect a volume (normalised VolumeDetail shape)',
    params: NameParam,
    // #10: dedicated typed response instead of `PassThroughObject`.
    // Same enrichment as the list, plus the raw Docker inspect under
    // a `raw` key for the Raw tab.
    responses: { 200: VolumeDetail },
  },
  asyncHandler(async (req, res) => {
    const docker = getClient();
    let v;
    try {
      v = await docker.getVolume(req.params.name).inspect();
    } catch (err) {
      if (err.statusCode === 404) throw new HttpError(404, 'Volume not found');
      throw err;
    }
    const containers = await docker.listContainers({ all: true });
    const usage = indexUsage(containers);
    const summary = enrich(v, { usage, sizes: new Map() });
    res.json({ ...summary, raw: v });
  }),
);

r.delete(
  '/:name',
  {
    summary: 'Remove a volume (force=false by default; opt-in to remove an in-use volume)',
    admin: true,
    destructive: true,
    params: NameParam,
    query: RemoveQuery,
    responses: { 200: Type.Object({ removed: Type.String() }) },
  },
  asyncHandler(async (req, res) => {
    // #1: force defaults to false so an admin click can't silently
    // destroy a production volume that some container is using.
    const force = boolQuery(req.query.force, false);
    try {
      await getClient().getVolume(req.params.name).remove({ force });
    } catch (err) {
      // Surface the "in use" daemon error as 409 with a helpful detail,
      // not a generic 500. Frontend uses 409 to show the "Force remove?"
      // secondary confirm.
      if (err.statusCode === 409) {
        throw new HttpError(409, 'Volume is in use — retry with ?force=true to remove it anyway');
      }
      if (err.statusCode === 404) throw new HttpError(404, 'Volume not found');
      throw err;
    }
    res.json({ removed: req.params.name });
  }),
);

export default r;
