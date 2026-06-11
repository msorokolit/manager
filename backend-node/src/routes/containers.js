// Container management endpoints.
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import {
  asyncHandler,
  boolQuery,
  bulkErrorString,
  HttpError,
  intQuery,
  pipeNdjson,
  pipeRaw,
  runBoundedParallel,
  summariseBulk,
} from '../util.js';
import { createApiRouter, streamResponse, customResponse } from '../route-builder.js';
import {
  BulkResponse,
  ContainerBulkRemoveRequest,
  ContainerBulkSimpleRequest,
  ContainerBulkStopRequest,
  ContainerLiveUpdateRequest,
  ContainerRenameRequest,
  ContainerSummary,
  CreateContainerRequest,
  PassThroughObject,
} from '../schemas/index.js';

const r = createApiRouter('/api/containers', { tag: 'containers' });

function portsObj(arr) {
  const out = {};
  for (const p of arr || []) {
    const key = `${p.PrivatePort}/${p.Type || 'tcp'}`;
    if (!out[key]) out[key] = [];
    if (p.PublicPort) {
      out[key].push({ HostIp: p.IP || '0.0.0.0', HostPort: String(p.PublicPort) });
    }
  }
  return out;
}

function summary(c) {
  return {
    id: c.Id,
    short_id: c.Id.slice(0, 12),
    name: ((c.Names && c.Names[0]) || '').replace(/^\//, ''),
    image: c.Image,
    status: c.State,
    state: c.State,
    health: null,
    started_at: null,
    created: new Date(c.Created * 1000).toISOString(),
    restart_policy: null,
    command: c.Command,
    labels: c.Labels || {},
    ports: portsObj(c.Ports),
    networks: Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {}),
  };
}

function summaryFromInspect(attrs) {
  const ns = attrs.NetworkSettings || {};
  const cfg = attrs.Config || {};
  const host = attrs.HostConfig || {};
  const state = attrs.State || {};
  return {
    id: attrs.Id,
    short_id: (attrs.Id || '').slice(0, 12),
    name: (attrs.Name || '').replace(/^\//, ''),
    image: cfg.Image,
    status: state.Status,
    state: state.Status,
    health: (state.Health || {}).Status || null,
    started_at: state.StartedAt,
    created: attrs.Created,
    restart_policy: (host.RestartPolicy || {}).Name,
    command: cfg.Cmd,
    labels: cfg.Labels || {},
    ports: ns.Ports || {},
    networks: Object.keys(ns.Networks || {}),
  };
}

const ListQuery = Type.Object(
  { all: Type.Optional(Type.Boolean({ default: true })) },
  { additionalProperties: false },
);
const IdParam = Type.Object({ id: Type.String() }, { additionalProperties: false });

r.get(
  '/',
  {
    summary: 'List containers',
    query: ListQuery,
    responses: { 200: Type.Array(ContainerSummary) },
  },
  asyncHandler(async (req, res) => {
    const all = boolQuery(req.query.all, true);
    const list = await getClient().listContainers({ all });
    res.json(list.map(summary));
  }),
);

r.get(
  '/prune',
  {
    summary: 'Prune stopped containers (alias of POST /prune)',
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (_req, res) => res.json(await getClient().pruneContainers())),
);

r.post(
  '/prune',
  {
    summary: 'Prune stopped containers',
    admin: true,
    destructive: true,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (_req, res) => res.json(await getClient().pruneContainers())),
);

r.post(
  '/',
  {
    summary: 'Create and start a container',
    admin: true,
    destructive: true,
    body: CreateContainerRequest,
    responses: { 200: ContainerSummary },
  },
  asyncHandler(async (req, res) => {
    const body = req.body;
    const docker = getClient();
    if (body.pull) {
      await new Promise((resolve, reject) => {
        docker.pull(body.image, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
        });
      });
    }
    const opts = buildCreateOptions(body);
    const c = await docker.createContainer(opts);
    await c.start();
    res.json(summaryFromInspect(await c.inspect()));
  }),
);

r.get(
  '/:id',
  {
    summary: 'Inspect a container',
    params: IdParam,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) =>
    res.json(await getClient().getContainer(req.params.id).inspect()),
  ),
);

const LogsQuery = Type.Object(
  {
    tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, default: 200 })),
    timestamps: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);

r.get(
  '/:id/logs',
  {
    summary: 'Tail logs (one-shot)',
    params: IdParam,
    query: LogsQuery,
    responses: { 200: Type.Object({ logs: Type.String() }) },
  },
  asyncHandler(async (req, res) => {
    const tail = intQuery(req.query.tail, 200, { min: 1, max: 50000 });
    const timestamps = boolQuery(req.query.timestamps, false);
    const c = getClient().getContainer(req.params.id);
    const buf = await c.logs({ stdout: true, stderr: true, tail, timestamps, follow: false });
    res.json({ logs: Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf) });
  }),
);

r.get(
  '/:id/logs/stream',
  {
    summary: 'Follow logs (text stream)',
    params: IdParam,
    query: Type.Object(
      { tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, default: 100 })) },
      { additionalProperties: false },
    ),
    responses: { 200: streamResponse('Raw container log bytes', 'text/plain') },
  },
  asyncHandler(async (req, res) => {
    const tail = intQuery(req.query.tail, 100, { min: 1, max: 50000 });
    const c = getClient().getContainer(req.params.id);
    const stream = await c.logs({ stdout: true, stderr: true, tail, follow: true });
    pipeRaw(stream, res);
  }),
);

r.get(
  '/:id/stats',
  {
    summary: 'One-shot stats sample',
    params: IdParam,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) =>
    res.json(await getClient().getContainer(req.params.id).stats({ stream: false })),
  ),
);

r.get(
  '/:id/stats/stream',
  {
    summary: 'Live stats (NDJSON)',
    params: IdParam,
    responses: { 200: streamResponse('NDJSON stream of stats samples') },
  },
  asyncHandler(async (req, res) => {
    const c = getClient().getContainer(req.params.id);
    const stream = await c.stats({ stream: true });
    pipeNdjson(stream, res);
  }),
);

async function action(id, name) {
  const c = getClient().getContainer(id);
  await c[name]();
  return summaryFromInspect(await c.inspect());
}

for (const verb of ['start', 'stop', 'restart', 'pause', 'unpause', 'kill']) {
  r.post(
    `/:id/${verb}`,
    {
      summary: `${verb[0].toUpperCase()}${verb.slice(1)}`,
      admin: true,
    destructive: true,
      params: IdParam,
      responses: { 200: ContainerSummary },
    },
    asyncHandler(async (req, res) => res.json(await action(req.params.id, verb))),
  );
}

const RemoveQuery = Type.Object(
  {
    force: Type.Optional(Type.Boolean({ default: false })),
    volumes: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);

r.delete(
  '/:id',
  {
    summary: 'Remove a container',
    admin: true,
    destructive: true,
    params: IdParam,
    query: RemoveQuery,
    responses: { 200: Type.Object({ removed: Type.String() }) },
  },
  asyncHandler(async (req, res) => {
    const force = boolQuery(req.query.force, false);
    const v = boolQuery(req.query.volumes, false);
    const c = getClient().getContainer(req.params.id);
    await c.remove({ force, v });
    res.json({ removed: req.params.id });
  }),
);

// ---------- Live update (cgroup knobs only) ----------
//
// Docker's `update` endpoint is the ONLY way to change container
// settings without recreating. It's narrow on purpose: CPU shares,
// CPU quota, cpuset, memory limits, restart policy, blkio weight,
// pids limit. Anything else (image, env, ports, volumes, devices,
// network) needs the recreate flow below.
//
// We reject empty bodies — calling /update with no changes is
// almost always a bug in the caller (forgot to pass the form) and
// would otherwise return 200 with no effect.
r.post(
  '/:id/update',
  {
    summary: 'Live-update cgroup-style runtime knobs (no restart, no recreate)',
    description:
      'Wraps Docker\'s `update` endpoint. Use this when you want to change CPU / memory ' +
      'limits or the restart policy on a running container without losing its id, logs, ' +
      'or uptime. For anything else (image, env, ports, volumes, devices, network) use ' +
      '/recreate instead.',
    admin: true,
    destructive: true,
    params: IdParam,
    body: ContainerLiveUpdateRequest,
    responses: { 200: ContainerSummary },
  },
  asyncHandler(async (req, res) => {
    const opts = buildUpdateOptions(req.body);
    if (!Object.keys(opts).length) {
      // 400, not silent 200 — the caller forgot the body. Saves a
      // round-trip of head-scratching.
      throw new HttpError(400, 'No live-update fields supplied (every field is optional but at least one must be set)');
    }
    const c = getClient().getContainer(req.params.id);
    try {
      await c.update(opts);
    } catch (err) {
      if (err.statusCode === 404) throw new HttpError(404, 'Container not found');
      throw err;
    }
    res.json(summaryFromInspect(await c.inspect()));
  }),
);

// ---------- Rename ----------
//
// One of the two truly-in-place container mutations Docker supports.
// No restart, no recreate, no id change — just the name. Useful for
// fixing typos and for distinguishing temp containers ('redis' →
// 'redis-prod') after the fact.
r.post(
  '/:id/rename',
  {
    summary: 'Rename a container in place (no restart, no recreate)',
    admin: true,
    destructive: true,
    params: IdParam,
    body: ContainerRenameRequest,
    responses: { 200: ContainerSummary },
  },
  asyncHandler(async (req, res) => {
    const c = getClient().getContainer(req.params.id);
    try {
      await c.rename({ name: req.body.name });
    } catch (err) {
      if (err.statusCode === 404) throw new HttpError(404, 'Container not found');
      if (err.statusCode === 409) {
        throw new HttpError(409, `Name '${req.body.name}' is already taken by another container`);
      }
      throw err;
    }
    res.json(summaryFromInspect(await c.inspect()));
  }),
);

// ---------- Recreate with new settings ----------
//
// The "Portainer-style edit": stop the existing container, remove it
// (preserving named volumes), create a new one with the supplied
// CreateContainerRequest body, and start it. Streams plain-text
// progress so the operator sees each step.
//
// Honest trade-offs (also surfaced in the SPA's confirm dialog):
//   - The container id CHANGES (new dockerode handle).
//   - Logs from the old container are lost — Docker drops them with
//     the container.
//   - Stats and uptime reset to 0.
//   - If `create` fails after `remove` succeeded, the original is
//     GONE. We surface the failure clearly so the operator can rerun
//     with the same body via the SPA's Recreate dialog (which keeps
//     the form populated).
//
// Compose-managed containers are refused with 409: editing them
// out-of-band would diverge from the compose file, and the next
// `compose up` would silently recreate them from compose anyway.
// The error message tells the user to edit the stack instead.
r.post(
  '/:id/recreate',
  {
    summary: 'Recreate a container with new settings (stop \u2192 rm \u2192 create \u2192 start, streamed)',
    description:
      'Use when /update isn\'t enough — i.e. when changing image, env vars, ports, volumes, ' +
      'devices, GPUs, network membership, or anything else outside the cgroup knob set. ' +
      'Refuses containers managed by docker-compose (use the Stacks editor instead).',
    admin: true,
    destructive: true,
    expensive: true,
    params: IdParam,
    body: CreateContainerRequest,
    responses: { 200: streamResponse('Plain-text progress + final new container id', 'text/plain') },
  },
  asyncHandler(async (req, res) => {
    const docker = getClient();
    const sourceId = req.params.id;
    let source;
    try { source = await docker.getContainer(sourceId).inspect(); }
    catch (err) {
      if (err.statusCode === 404) throw new HttpError(404, 'Container not found');
      throw err;
    }
    // Compose guard. The label is added by every compose version we
    // care about (v1 + v2 + buildx-compose). Refuse rather than
    // silently break the operator's stack workflow.
    const composeProject = source.Config && source.Config.Labels
      && source.Config.Labels['com.docker.compose.project'];
    if (composeProject) {
      throw new HttpError(
        409,
        `Container is managed by compose project '${composeProject}'. ` +
        'Edit the stack file instead — recreating here would diverge from the compose definition ' +
        'and be overwritten on the next `compose up`.',
      );
    }
    const oldName = (source.Name || '').replace(/^\//, '');
    const wasRunning = !!(source.State && source.State.Running);
    // Default: keep the original name. The dialog can override by
    // passing body.name, but the SPA defaults to oldName so identity
    // stays stable for downstream references (compose service refs,
    // links, scripts grepping for the name).
    const newBody = { ...req.body };
    if (!newBody.name) newBody.name = oldName;

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    const log = (s) => { try { res.write(s + '\n'); } catch {} };

    log(`[recreate] source: ${oldName} (${sourceId.slice(0, 12)}), running=${wasRunning}`);
    if (wasRunning) {
      log('[recreate] stopping…');
      try {
        await docker.getContainer(sourceId).stop({ t: 10 });
        log('[recreate] stopped');
      } catch (err) {
        if (err.statusCode === 304) log('[recreate] already stopped');
        else {
          log(`[recreate] ERROR stopping: ${err.message}`);
          res.end();
          return;
        }
      }
    }

    log('[recreate] removing source container (named volumes preserved)…');
    try {
      await docker.getContainer(sourceId).remove({ force: !wasRunning ? false : true, v: false });
      log('[recreate] removed');
    } catch (err) {
      log(`[recreate] ERROR removing: ${err.message}`);
      log('[recreate] aborting — original container may still exist');
      res.end();
      return;
    }

    log(`[recreate] creating new container with name '${newBody.name}'…`);
    let newContainer;
    try {
      // Optional image pull (matches POST /api/containers semantics).
      if (newBody.pull) {
        log(`[recreate] pulling ${newBody.image}…`);
        await new Promise((resolve, reject) => {
          docker.pull(newBody.image, (err, stream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
          });
        });
      }
      newContainer = await docker.createContainer(buildCreateOptions(newBody));
      log(`[recreate] created ${newContainer.id.slice(0, 12)}`);
    } catch (err) {
      // The dangerous failure: original is gone, new failed. Spell
      // out exactly what to do — the SPA's recreate dialog keeps the
      // form populated for retry.
      log(`[recreate] ERROR creating: ${err.message}`);
      log('[recreate] ORIGINAL CONTAINER IS GONE. Re-run with the same body to retry create.');
      res.end();
      return;
    }

    log('[recreate] starting new container…');
    try {
      await newContainer.start();
      log(`[recreate] started ${newContainer.id.slice(0, 12)}`);
    } catch (err) {
      log(`[recreate] ERROR starting: ${err.message}`);
      log(`[recreate] new container exists (id=${newContainer.id.slice(0, 12)}) but failed to start`);
      res.end();
      return;
    }

    log(`[recreate] OK new_id=${newContainer.id}`);
    res.end();
  }),
);

// ---------- Bulk action endpoints ----------
//
// One endpoint per verb so the request body is precisely typed (stop
// has `timeout`, remove has `force`+`volumes`, the rest take ids only).
// All run with bounded parallelism (5 in flight) and return a per-item
// report — never fail the batch because one container was already in
// the target state.
//
// 304 Not Modified from the daemon ("already running" / "already
// stopped") is treated as success: bulk operators usually want
// "make sure these are running" semantics, not "fail if any were
// already running".
async function runBulkAction(ids, verb, perContainer = () => undefined) {
  return runBoundedParallel(ids, async (id) => {
    try {
      const c = getClient().getContainer(id);
      const args = perContainer(id);
      if (args === undefined) await c[verb]();
      else await c[verb](args);
      return { id, ok: true };
    } catch (err) {
      // 304 = "already in target state" — bulk "start all" should not
      // count already-running containers as failures.
      if (err.statusCode === 304) return { id, ok: true };
      return { id, ok: false, error: bulkErrorString(err) };
    }
  });
}

for (const verb of ['start', 'restart', 'pause', 'unpause', 'kill']) {
  r.post(
    `/${verb}/bulk`,
    {
      summary: `Bulk ${verb} containers (multi-select)`,
      admin: true,
      destructive: true,
      body: ContainerBulkSimpleRequest,
      responses: { 200: BulkResponse },
    },
    asyncHandler(async (req, res) => {
      const out = await runBulkAction(req.body.ids, verb);
      res.json(summariseBulk(out));
    }),
  );
}

r.post(
  '/stop/bulk',
  {
    summary: 'Bulk stop containers (multi-select; optional timeout before SIGKILL)',
    admin: true,
    destructive: true,
    body: ContainerBulkStopRequest,
    responses: { 200: BulkResponse },
  },
  asyncHandler(async (req, res) => {
    const t = req.body.timeout == null ? undefined : Number(req.body.timeout);
    // dockerode signature: stop({ t: seconds }). undefined → daemon default.
    const out = await runBulkAction(req.body.ids, 'stop', () =>
      t === undefined ? undefined : { t },
    );
    res.json(summariseBulk(out));
  }),
);

r.post(
  '/remove/bulk',
  {
    summary: 'Bulk remove containers (multi-select; force + remove-anonymous-volumes flags)',
    admin: true,
    destructive: true,
    body: ContainerBulkRemoveRequest,
    responses: { 200: BulkResponse },
  },
  asyncHandler(async (req, res) => {
    const force = !!req.body.force;
    const v = !!req.body.volumes;
    const out = await runBoundedParallel(req.body.ids, async (id) => {
      try {
        await getClient().getContainer(id).remove({ force, v });
        return { id, ok: true };
      } catch (err) {
        if (err.statusCode === 404) return { id, ok: false, error: 'Not found' };
        if (err.statusCode === 409) {
          return {
            id, ok: false,
            error: 'Container is running — pass force:true to remove it anyway',
          };
        }
        return { id, ok: false, error: bulkErrorString(err) };
      }
    });
    res.json(summariseBulk(out));
  }),
);

/**
 * Parse a memory-size string ('256m', '1g', '512') or pass through a
 * plain byte count. Returns undefined for null/empty/garbage so the
 * caller can skip the field entirely (Docker treats `undefined` as
 * 'leave at current value').
 *
 * Extracted from buildCreateOptions so buildUpdateOptions (and tests)
 * can reuse it without duplicating the regex.
 */
export function memBytes(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return v;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgtKMGT]?)([bB]?)$/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Math.floor(n * (mult[m[2].toLowerCase()] || 1));
}

/**
 * Translate our snake_case live-update body into the dockerode
 * .update() payload. Fields the user didn't include are left as
 * undefined so the daemon leaves them untouched.
 *
 * The daemon's update endpoint REQUIRES at least one field; we
 * surface that as a 400 in the route, not here.
 */
export function buildUpdateOptions(o) {
  const out = {};
  if (o.cpus != null && o.cpus !== '') out.NanoCpus = Math.floor(Number(o.cpus) * 1_000_000_000);
  if (o.cpu_shares != null) out.CpuShares = Number(o.cpu_shares);
  if (o.cpuset_cpus) out.CpusetCpus = o.cpuset_cpus;
  const mem = memBytes(o.mem_limit);
  if (mem !== undefined) out.Memory = mem;
  const memR = memBytes(o.mem_reservation);
  if (memR !== undefined) out.MemoryReservation = memR;
  const memSwap = memBytes(o.memswap_limit);
  if (memSwap !== undefined) out.MemorySwap = memSwap;
  if (o.pids_limit != null) out.PidsLimit = Number(o.pids_limit);
  if (o.blkio_weight != null) out.BlkioWeight = Number(o.blkio_weight);
  if (o.restart_policy) out.RestartPolicy = { Name: o.restart_policy };
  return out;
}

// Build the dockerode createContainer payload from our rich JSON schema.
function buildCreateOptions(o) {
  const env = o.env ? Object.entries(o.env).map(([k, v]) => `${k}=${v}`) : undefined;
  const cmd = Array.isArray(o.command) ? o.command : typeof o.command === 'string' && o.command.length ? o.command.split(/\s+/) : undefined;
  const entrypoint = Array.isArray(o.entrypoint) ? o.entrypoint : typeof o.entrypoint === 'string' && o.entrypoint.length ? o.entrypoint.split(/\s+/) : undefined;

  const exposedPorts = {};
  const portBindings = {};
  for (const [containerPort, host] of Object.entries(o.ports || {})) {
    exposedPorts[containerPort] = {};
    portBindings[containerPort] = [{ HostIp: '', HostPort: host == null ? '' : String(host) }];
  }

  const binds = [];
  for (const [src, spec] of Object.entries(o.volumes || {})) {
    if (spec && typeof spec === 'object' && spec.bind) {
      binds.push(`${src}:${spec.bind}${spec.mode ? ':' + spec.mode : ''}`);
    }
  }

  const tmpfs = o.tmpfs || undefined;
  const devices = (o.devices || []).map((s) => {
    const parts = s.split(':');
    return { PathOnHost: parts[0], PathInContainer: parts[1] || parts[0], CgroupPermissions: parts[2] || 'rwm' };
  });

  let healthcheck;
  if (o.healthcheck) {
    const hc = o.healthcheck;
    let test = hc.test;
    if (typeof test === 'string') test = ['CMD-SHELL', test];
    healthcheck = {
      Test: test || undefined,
      Interval: hc.interval || undefined,
      Timeout: hc.timeout || undefined,
      Retries: hc.retries || undefined,
      StartPeriod: hc.start_period || undefined,
    };
  }
  let logConfig;
  if (o.log_driver) logConfig = { Type: o.log_driver, Config: o.log_opts || {} };
  const restartPolicy = o.restart_policy ? { Name: o.restart_policy } : undefined;
  const extraHosts = o.extra_hosts ? Object.entries(o.extra_hosts).map(([h, ip]) => `${h}:${ip}`) : undefined;
  const ulimits = (o.ulimits || []).map((u) => ({ Name: u.name, Soft: u.soft, Hard: u.hard }));

  // ---- GPU device requests ----
  //
  // Three input shapes, in increasing order of specificity:
  //
  //   gpu_device_ids: ["0", "GPU-…"]   →  Capabilities + DeviceIDs
  //   gpus: 'all' | N                  →  Capabilities + Count (legacy)
  //   neither                          →  no DeviceRequests entry
  //
  // gpu_device_ids wins when both are set — explicit > vague.
  // gpu_capabilities defaults to ["gpu"] (the docker CLI default for
  // `--gpus`) when not supplied; the runtime then picks the
  // NVIDIA-style ["compute","utility"] under the hood. Operators who
  // need NVENC/NVDEC pass ["video"] etc explicitly.
  const deviceRequests = [];
  const caps = (o.gpu_capabilities && o.gpu_capabilities.length)
    ? o.gpu_capabilities
    : ['gpu'];
  if (Array.isArray(o.gpu_device_ids) && o.gpu_device_ids.length) {
    deviceRequests.push({
      Driver: '',  // empty = runtime default (nvidia when present)
      DeviceIDs: o.gpu_device_ids.map(String),
      Capabilities: [caps],
    });
  } else if (o.gpus !== undefined && o.gpus !== null && o.gpus !== '' && o.gpus !== 0) {
    const count = String(o.gpus).toLowerCase() === 'all' || Number(o.gpus) === -1
      ? -1
      : Number(o.gpus);
    deviceRequests.push({ Count: count, Capabilities: [caps] });
  }
  const endpointsConfig = {};
  if (o.network) endpointsConfig[o.network] = {};

  const create = {
    Image: o.image,
    name: o.name || undefined,
    Cmd: cmd,
    Entrypoint: entrypoint,
    Env: env,
    User: o.user || undefined,
    WorkingDir: o.working_dir || undefined,
    Hostname: o.hostname || undefined,
    Domainname: o.domainname || undefined,
    StopSignal: o.stop_signal || undefined,
    StopTimeout: o.stop_grace_period != null ? Number(o.stop_grace_period) : undefined,
    Tty: o.tty,
    OpenStdin: o.stdin_open,
    Labels: o.labels || undefined,
    ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
    Healthcheck: healthcheck,
    MacAddress: o.mac_address || undefined,
    HostConfig: {
      Binds: binds.length ? binds : undefined,
      PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
      RestartPolicy: restartPolicy,
      NetworkMode: o.network_mode || undefined,
      Tmpfs: tmpfs,
      Devices: devices.length ? devices : undefined,
      Dns: o.dns,
      DnsSearch: o.dns_search,
      DnsOptions: o.dns_opt,
      ExtraHosts: extraHosts,
      Privileged: o.privileged,
      ReadonlyRootfs: o.read_only,
      AutoRemove: o.auto_remove,
      Init: o.init,
      Sysctls: o.sysctls,
      CapAdd: o.cap_add,
      CapDrop: o.cap_drop,
      SecurityOpt: o.security_opt,
      Ulimits: ulimits.length ? ulimits : undefined,
      LogConfig: logConfig,
      DeviceRequests: deviceRequests.length ? deviceRequests : undefined,
      // Alternate OCI runtime (`nvidia`, `crun`, `kata-runtime`, …).
      // Undefined → daemon picks DefaultRuntime (typically `runc`).
      // The daemon validates against `docker info` runtimes; an
      // unknown name returns 400 from the create call.
      Runtime: o.runtime || undefined,
      NanoCpus: o.cpus != null && o.cpus !== '' ? Math.floor(Number(o.cpus) * 1_000_000_000) : undefined,
      CpuShares: o.cpu_shares != null ? Number(o.cpu_shares) : undefined,
      CpusetCpus: o.cpuset_cpus || undefined,
      Memory: memBytes(o.mem_limit),
      MemoryReservation: memBytes(o.mem_reservation),
      MemorySwap: memBytes(o.memswap_limit),
      PidsLimit: o.pids_limit != null ? Number(o.pids_limit) : undefined,
      ShmSize: memBytes(o.shm_size),
    },
    NetworkingConfig: Object.keys(endpointsConfig).length ? { EndpointsConfig: endpointsConfig } : undefined,
  };
  function clean(obj) {
    if (Array.isArray(obj)) return obj;
    if (!obj || typeof obj !== 'object') return obj;
    for (const k of Object.keys(obj)) {
      if (obj[k] === undefined) delete obj[k];
      else if (obj[k] && typeof obj[k] === 'object') clean(obj[k]);
    }
    return obj;
  }
  return clean(create);
}

// Visible-for-testing only.
export const _internals = { buildCreateOptions, buildUpdateOptions, memBytes };

export default r;
