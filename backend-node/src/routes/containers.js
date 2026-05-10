// Container management endpoints.
import { Router } from 'express';
import { authenticate, requireAdmin } from '../auth.js';
import { getClient } from '../docker-client.js';
import {
  asyncHandler,
  boolQuery,
  intQuery,
  pipeNdjson,
  pipeRaw,
} from '../util.js';

const router = Router();
router.use(authenticate);

function portsObj(arr) {
  // dockerode list returns Ports: [{IP, PrivatePort, PublicPort, Type}]
  // Frontend expects { "80/tcp": [{HostIp, HostPort}] }
  const out = {};
  for (const p of arr || []) {
    const key = `${p.PrivatePort}/${p.Type || 'tcp'}`;
    if (!out[key]) out[key] = [];
    if (p.PublicPort) {
      out[key].push({
        HostIp: p.IP || '0.0.0.0',
        HostPort: String(p.PublicPort),
      });
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
    status: c.State, // "running" / "exited" / etc. - frontend expects this token
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

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const all = boolQuery(req.query.all, true);
    const list = await getClient().listContainers({ all });
    res.json(list.map(summary));
  }),
);

router.get(
  '/prune',
  asyncHandler(async (_req, res) => {
    res.json(await getClient().pruneContainers());
  }),
);

router.post(
  '/prune',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await getClient().pruneContainers());
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const c = getClient().getContainer(req.params.id);
    res.json(await c.inspect());
  }),
);

router.get(
  '/:id/logs',
  asyncHandler(async (req, res) => {
    const tail = intQuery(req.query.tail, 200, { min: 1, max: 50000 });
    const timestamps = boolQuery(req.query.timestamps, false);
    const c = getClient().getContainer(req.params.id);
    const buf = await c.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps,
      follow: false,
    });
    // dockerode returns a Buffer when follow:false
    res.json({ logs: Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf) });
  }),
);

router.get(
  '/:id/logs/stream',
  asyncHandler(async (req, res) => {
    const tail = intQuery(req.query.tail, 100, { min: 1, max: 50000 });
    const c = getClient().getContainer(req.params.id);
    const stream = await c.logs({
      stdout: true,
      stderr: true,
      tail,
      follow: true,
    });
    pipeRaw(stream, res);
  }),
);

router.get(
  '/:id/stats',
  asyncHandler(async (req, res) => {
    const c = getClient().getContainer(req.params.id);
    res.json(await c.stats({ stream: false }));
  }),
);

router.get(
  '/:id/stats/stream',
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

router.post(
  '/:id/start',
  requireAdmin,
  asyncHandler(async (req, res) => res.json(await action(req.params.id, 'start'))),
);
router.post(
  '/:id/stop',
  requireAdmin,
  asyncHandler(async (req, res) => res.json(await action(req.params.id, 'stop'))),
);
router.post(
  '/:id/restart',
  requireAdmin,
  asyncHandler(async (req, res) =>
    res.json(await action(req.params.id, 'restart')),
  ),
);
router.post(
  '/:id/pause',
  requireAdmin,
  asyncHandler(async (req, res) => res.json(await action(req.params.id, 'pause'))),
);
router.post(
  '/:id/unpause',
  requireAdmin,
  asyncHandler(async (req, res) =>
    res.json(await action(req.params.id, 'unpause')),
  ),
);
router.post(
  '/:id/kill',
  requireAdmin,
  asyncHandler(async (req, res) => res.json(await action(req.params.id, 'kill'))),
);

router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const force = boolQuery(req.query.force, false);
    const v = boolQuery(req.query.volumes, false);
    const c = getClient().getContainer(req.params.id);
    await c.remove({ force, v });
    res.json({ removed: req.params.id });
  }),
);

// Build the dockerode createContainer payload from our rich JSON schema.
function buildCreateOptions(req) {
  const o = req || {};
  if (!o.image) {
    const e = new Error('image is required');
    e.statusCode = 400;
    throw e;
  }

  const env = o.env
    ? Object.entries(o.env).map(([k, v]) => `${k}=${v}`)
    : undefined;

  const cmd = Array.isArray(o.command)
    ? o.command
    : typeof o.command === 'string' && o.command.length
      ? o.command.split(/\s+/)
      : undefined;
  const entrypoint = Array.isArray(o.entrypoint)
    ? o.entrypoint
    : typeof o.entrypoint === 'string' && o.entrypoint.length
      ? o.entrypoint.split(/\s+/)
      : undefined;

  // Ports: { "80/tcp": 8080 } -> ExposedPorts + PortBindings
  const exposedPorts = {};
  const portBindings = {};
  for (const [containerPort, host] of Object.entries(o.ports || {})) {
    exposedPorts[containerPort] = {};
    portBindings[containerPort] = [
      {
        HostIp: '',
        HostPort: host == null ? '' : String(host),
      },
    ];
  }

  // Volumes: { "/host": {bind: "/container", mode: "rw"} } -> Binds
  const binds = [];
  for (const [src, spec] of Object.entries(o.volumes || {})) {
    if (spec && typeof spec === 'object' && spec.bind) {
      binds.push(`${src}:${spec.bind}${spec.mode ? ':' + spec.mode : ''}`);
    }
  }

  // tmpfs: { "/run": "size=64m" }
  const tmpfs = o.tmpfs || undefined;

  // Devices: ["/host:/container[:rwm]"]
  const devices = (o.devices || []).map((s) => {
    const parts = s.split(':');
    return {
      PathOnHost: parts[0],
      PathInContainer: parts[1] || parts[0],
      CgroupPermissions: parts[2] || 'rwm',
    };
  });

  // Healthcheck
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

  // Log config
  let logConfig;
  if (o.log_driver) {
    logConfig = {
      Type: o.log_driver,
      Config: o.log_opts || {},
    };
  }

  // Restart policy
  const restartPolicy = o.restart_policy
    ? { Name: o.restart_policy }
    : undefined;

  // ExtraHosts: { "db": "10.0.0.5" } -> ["db:10.0.0.5"]
  const extraHosts = o.extra_hosts
    ? Object.entries(o.extra_hosts).map(([h, ip]) => `${h}:${ip}`)
    : undefined;

  // Ulimits
  const ulimits = (o.ulimits || []).map((u) => ({
    Name: u.name,
    Soft: u.soft,
    Hard: u.hard,
  }));

  // GPUs
  const deviceRequests = [];
  if (o.gpus !== undefined && o.gpus !== null && o.gpus !== '' && o.gpus !== 0) {
    const count =
      String(o.gpus).toLowerCase() === 'all' || Number(o.gpus) === -1
        ? -1
        : Number(o.gpus);
    deviceRequests.push({ Count: count, Capabilities: [['gpu']] });
  }

  // Networking
  const endpointsConfig = {};
  if (o.network) endpointsConfig[o.network] = {};

  // Memory parsing helper
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
    StopTimeout:
      o.stop_grace_period != null ? Number(o.stop_grace_period) : undefined,
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
      NanoCpus:
        o.cpus != null && o.cpus !== ''
          ? Math.floor(Number(o.cpus) * 1_000_000_000)
          : undefined,
      CpuShares: o.cpu_shares != null ? Number(o.cpu_shares) : undefined,
      CpusetCpus: o.cpuset_cpus || undefined,
      Memory: memBytes(o.mem_limit),
      MemoryReservation: memBytes(o.mem_reservation),
      MemorySwap: memBytes(o.memswap_limit),
      PidsLimit: o.pids_limit != null ? Number(o.pids_limit) : undefined,
      ShmSize: memBytes(o.shm_size),
    },
    NetworkingConfig: Object.keys(endpointsConfig).length
      ? { EndpointsConfig: endpointsConfig }
      : undefined,
  };

  // Strip undefined to keep payload clean.
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

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const docker = getClient();
    if (body.pull) {
      // Pull synchronously before create.
      await new Promise((resolve, reject) => {
        docker.pull(body.image, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
        });
      });
    }
    const opts = buildCreateOptions(body);
    const c = await docker.createContainer(opts);
    if (body.detach !== false) {
      await c.start();
      res.json(summaryFromInspect(await c.inspect()));
    } else {
      // Synchronous run: not really supported via dockerode the same way; start
      // and return what we have.
      await c.start();
      res.json(summaryFromInspect(await c.inspect()));
    }
  }),
);

export default router;
