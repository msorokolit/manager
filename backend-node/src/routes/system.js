// System-level endpoints: ping, info, version, df, events, events/stream,
// and (new) hardware discovery for accelerators / host devices.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import { asyncHandler, intQuery, pipeNdjson } from '../util.js';
import { createApiRouter, streamResponse } from '../route-builder.js';
import { PassThroughObject, PingResponse, DeviceDiscoveryResponse } from '../schemas/index.js';
import { logger } from '../logger.js';

const r = createApiRouter('/api/system', { tag: 'system' });

r.get(
  '/ping',
  {
    summary: 'Ping the Docker daemon',
    responses: { 200: PingResponse },
  },
  asyncHandler(async (req, res) => {
    await getClient().ping();
    res.json({ ok: true, user: req.user.username, role: req.user.role });
  }),
);

r.get(
  '/info',
  { summary: 'docker info (raw)', responses: { 200: PassThroughObject } },
  asyncHandler(async (_req, res) => res.json(await getClient().info())),
);

r.get(
  '/version',
  { summary: 'docker version (raw)', responses: { 200: PassThroughObject } },
  asyncHandler(async (_req, res) => res.json(await getClient().version())),
);

r.get(
  '/df',
  { summary: 'Docker disk usage', responses: { 200: PassThroughObject } },
  asyncHandler(async (_req, res) => res.json(await getClient().df())),
);

const EventsQuery = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 1000, default: 25 }),
    ),
  },
  { additionalProperties: false },
);

r.get(
  '/events',
  {
    summary: 'Recent docker events (bounded)',
    query: EventsQuery,
    responses: { 200: Type.Array(PassThroughObject) },
  },
  asyncHandler(async (req, res) => {
    const limit = intQuery(req.query.limit, 25, { min: 1, max: 1000 });
    const end = Math.floor(Date.now() / 1000);
    const start = end - 60 * 60;
    const out = [];
    const stream = await getClient().getEvents({ since: start, until: end });
    let buf = '';
    await new Promise((resolve) => {
      const finish = () => {
        try { stream.destroy(); } catch {}
        resolve();
      };
      stream.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try { out.push(JSON.parse(line)); } catch {}
          if (out.length >= limit) return finish();
        }
      });
      stream.on('end', resolve);
      stream.on('error', resolve);
      setTimeout(finish, 1500);
    });
    res.json(out);
  }),
);

// ---------- Accelerator + device discovery ----------
//
// Surfaces what GPUs / accelerators / host devices the operator can
// expose to a container, with no manual `nvidia-smi`-from-the-shell
// step. Three sources of truth, in order of trustworthiness:
//
//   1. Runtimes — read from `docker info`. Authoritative for which
//      runtimes the daemon knows about (`runc`, `nvidia`, `crun`, …)
//      and which is the default. Cheap, always works.
//
//   2. GPUs — best-effort via `nvidia-smi -L --query-gpu=…`. Works
//      when the manager container has nvidia-smi available AND can
//      see the host's GPUs. May return nothing in two cases:
//      (a) the host has no NVIDIA GPUs, or
//      (b) the host has GPUs but the manager container can't see
//          them (no nvidia runtime + no /dev/nvidia* bind-mount in
//          THIS container). Case (b) is the common one for default
//          installs. The response carries `gpu_detection.note` so
//          the SPA can tell the user "GPUs may exist on the host
//          but I can't enumerate them from inside this container".
//
//   3. /dev/dri — Intel / AMD VAAPI devices. Existence-check via
//      filesystem; if /dev/dri exists we list its entries.
//
// The whole thing is cached for 30s — operators may poll this from
// the SPA's System tab and we don't want to spawn nvidia-smi every
// few seconds.

const DEVICE_CACHE_TTL_MS = 30_000;
let deviceCache = null;
let deviceCacheAt = 0;

/**
 * Run a small command, capture its stdout (≤ 64 KB) with a bounded
 * timeout. Resolves to { stdout, stderr, code } or null when the
 * binary isn't on PATH. Never rejects — callers treat null/failure
 * as "this signal isn't available".
 */
function runCmd(bin, args, { timeoutMs = 1500, maxBytes = 64 * 1024 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return resolve(null); }
    let stdout = '', stderr = '', truncated = false;
    let killed = false;
    const t = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    t.unref && t.unref();
    proc.stdout.on('data', (c) => {
      if (truncated) return;
      stdout += c.toString('utf8');
      if (stdout.length > maxBytes) { stdout = stdout.slice(0, maxBytes); truncated = true; }
    });
    proc.stderr.on('data', (c) => { if (stderr.length < 4096) stderr += c.toString('utf8'); });
    proc.on('error', (err) => {
      clearTimeout(t);
      // ENOENT = not on PATH; treat as 'binary absent', not 'failed'.
      if (err && err.code === 'ENOENT') return resolve(null);
      resolve({ stdout, stderr, code: -1, error: err.message });
    });
    proc.on('close', (code) => {
      clearTimeout(t);
      if (killed) return resolve({ stdout, stderr, code: -1, error: 'timeout' });
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Probe NVIDIA GPUs via `nvidia-smi`. Returns `{available, note?, gpus}`
 * where `gpus` is an array of `{index, uuid, name, memory_mb, driver_version}`
 * (any number of fields may be null if the smi version is old or output
 * is unexpected). Works only when the manager container has nvidia-smi
 * on PATH AND can read /dev/nvidia*; otherwise returns available:false
 * with a hint.
 */
async function probeNvidia() {
  const r = await runCmd('nvidia-smi', [
    '--query-gpu=index,uuid,name,memory.total,driver_version',
    '--format=csv,noheader,nounits',
  ]);
  if (r == null) {
    return {
      available: false,
      note: 'nvidia-smi not installed in the manager container — install nvidia-utils + bind /dev/nvidia* (or run the manager with --runtime=nvidia) to enumerate GPUs',
    };
  }
  if (r.code !== 0) {
    return {
      available: false,
      note: `nvidia-smi returned ${r.code}${r.error ? ` (${r.error})` : ''}; host may have no NVIDIA GPUs or the driver isn't loaded`,
    };
  }
  const gpus = r.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const parts = line.split(',').map((s) => s.trim());
    const mem = parseInt(parts[3], 10);
    return {
      index: parts[0],
      uuid: parts[1] || null,
      name: parts[2] || null,
      memory_mb: Number.isFinite(mem) ? mem : null,
      driver_version: parts[4] || null,
    };
  });
  return { available: true, gpus };
}

async function probeDri() {
  if (!existsSync('/dev/dri')) {
    return { available: false, note: '/dev/dri not present on the manager container' };
  }
  try {
    const entries = await fs.readdir('/dev/dri');
    return {
      available: true,
      devices: entries.sort().map((name) => `/dev/dri/${name}`),
    };
  } catch (err) {
    return { available: false, note: `/dev/dri exists but unreadable: ${err.message}` };
  }
}

async function discoverDevices() {
  const docker = getClient();
  // Runtimes come from `docker info`. We pull the whole info blob
  // because we already need it elsewhere; here we only surface the
  // shape the SPA needs.
  let info = null;
  try { info = await docker.info(); }
  catch (err) {
    logger.warn({ err: err.message }, 'docker info failed during device discovery');
  }

  const rawRuntimes = (info && info.Runtimes) || {};
  const runtimes = Object.entries(rawRuntimes).map(([name, def]) => ({
    name,
    path: (def && def.path) || null,
    status: (def && def.status) || null,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const defaultRuntime = (info && info.DefaultRuntime) || 'runc';

  const [nvidia, dri] = await Promise.all([probeNvidia(), probeDri()]);

  return {
    runtimes,
    default_runtime: defaultRuntime,
    // gpu_runtime tells the SPA which runtime to suggest for GPU
    // workloads. nvidia is the obvious one; fall back to whatever
    // non-default is present (e.g. some hosts ship `nvidia-cdi`).
    gpu_runtime: runtimes.find((r) => /nvidia/i.test(r.name))?.name
      || runtimes.find((r) => r.name !== 'runc' && r.name !== defaultRuntime)?.name
      || null,
    nvidia,
    dri,
    // Per-call timestamp lets callers see staleness if the cache TTL
    // changes; cheap and helpful for support.
    discovered_at: new Date().toISOString(),
  };
}

r.get(
  '/devices',
  {
    summary: 'Host accelerator + device discovery (runtimes, GPUs, /dev/dri)',
    description:
      'Best-effort enumeration of what GPUs / runtimes / devices the operator can expose to a container. ' +
      'Cached for 30s. Useful as the data source for the Run-container dialog\'s GPU + Devices panels.',
    responses: { 200: DeviceDiscoveryResponse },
  },
  asyncHandler(async (_req, res) => {
    if (deviceCache && Date.now() - deviceCacheAt < DEVICE_CACHE_TTL_MS) {
      return res.json(deviceCache);
    }
    deviceCache = await discoverDevices();
    deviceCacheAt = Date.now();
    res.json(deviceCache);
  }),
);

// Visible-for-testing only.
export const _internals = {
  discoverDevices,
  resetCacheForTests() { deviceCache = null; deviceCacheAt = 0; },
};

r.get(
  '/events/stream',
  {
    summary: 'Live docker events (NDJSON)',
    responses: { 200: streamResponse('NDJSON stream of docker event objects') },
  },
  asyncHandler(async (_req, res) => {
    const stream = await getClient().getEvents();
    pipeNdjson(stream, res);
  }),
);

export default r;
