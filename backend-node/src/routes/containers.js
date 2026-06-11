// Container management endpoints.
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import {
  asyncHandler,
  boolQuery,
  bulkErrorString,
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

  function memBytes(v) {
    if (v == null || v === '') return undefined;
    if (typeof v === 'number') return v;
    const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgtKMGT]?)([bB]?)$/);
    if (!m) return undefined;
    const n = parseFloat(m[1]);
    const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
    return Math.floor(n * (mult[m[2].toLowerCase()] || 1));
  }

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
export const _internals = { buildCreateOptions };

export default r;
