// System-level endpoints: ping, info, version, df, events, events/stream,
// and (new) hardware discovery for accelerators / host devices.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import { asyncHandler, HttpError, intQuery, pipeNdjson, runBoundedParallel } from '../util.js';
import { createApiRouter, streamResponse } from '../route-builder.js';
import {
  PassThroughObject, PingResponse, DeviceDiscoveryResponse, SystemStatsSummaryResponse,
  EventHistoryQueryResponse, StatsHistoryQueryResponse,
} from '../schemas/index.js';
import { Opt, StringEnum } from '../schemas/_common.js';
import { logger } from '../logger.js';
import { computeRate } from '../stats.js';
import { settings } from '../config.js';
import { queryEvents } from '../event-history.js';
import { queryStats } from '../stats-history.js';

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

// ---------- Host /dev scanning ----------
//
// Docker's --device pass-through works on ANY character or block
// device the host has — GPUs, audio, USB, serial, TPM, V4L cameras,
// watchdog, ML accelerators (Coral / Hailo), AMD ROCm, …. The
// frontend lets the operator type any /dev path, but it's a much
// better UX to surface what's actually present on the host so they
// can pick from a list instead of guessing.
//
// We scan a curated set of well-known paths per category. The
// matcher is intentionally NOT a generic glob — it's a tiny dispatch
// table with three primitives:
//
//   single   : the literal path is itself a device file
//   prefix   : prefix*  → readdir of dirname, match filenames starting
//              with the basename minus the trailing '*'
//   dir      : the path is a directory; the entries below it (one
//              level OR recursive) are the devices
//
// No recursion outside the parent directory of the pattern; no shell
// out. The scanner runs from inside the manager container — if the
// container can't see a device on the host, we report 'absent' (the
// operator's fix is to bind-mount it or rerun the manager with
// --privileged / a specific --device, depending on policy).

const DEVICE_CATEGORIES = [
  {
    kind: 'gpu_amd', label: 'AMD GPU / ROCm',
    paths: [{ type: 'single', value: '/dev/kfd' }],
    hint: 'Mount /dev/kfd + the matching /dev/dri/renderD* for AMD ROCm workloads.',
  },
  {
    kind: 'audio', label: 'Audio',
    paths: [{ type: 'dir', value: '/dev/snd', recursive: true }],
    hint: 'Whole /dev/snd is the simplest pass-through for ALSA / PulseAudio inside a container.',
  },
  {
    kind: 'usb', label: 'USB',
    paths: [{ type: 'dir', value: '/dev/bus/usb', recursive: true }],
    hint: 'Pass /dev/bus/usb for broad USB access; pick a single bus/device path to scope tighter.',
  },
  {
    kind: 'serial', label: 'Serial / TTY',
    paths: [
      { type: 'prefix', value: '/dev/ttyUSB*' },
      { type: 'prefix', value: '/dev/ttyACM*' },
      { type: 'prefix', value: '/dev/ttyS*' },
    ],
    hint: 'Use perms `rw` for read/write or `r` for log-only. ttyUSB / ttyACM are USB serial adapters; ttyS* are physical ports.',
  },
  {
    kind: 'video', label: 'V4L2 cameras',
    paths: [{ type: 'prefix', value: '/dev/video*' }],
    hint: 'Each /dev/video* is one V4L2 endpoint; webcams typically expose 1–2 nodes per device.',
  },
  {
    kind: 'tpu', label: 'ML accelerators',
    paths: [
      { type: 'prefix', value: '/dev/apex_*' },  // Google Coral PCIe / M.2
      { type: 'prefix', value: '/dev/hailo*' },  // Hailo
      { type: 'prefix', value: '/dev/accel*' },  // generic Linux accelerator class
    ],
    hint: 'Edge ML accelerators (Coral apex_*, Hailo hailo*, generic accel*).',
  },
  {
    kind: 'tpm', label: 'TPM',
    paths: [
      { type: 'prefix', value: '/dev/tpm*' },
      { type: 'prefix', value: '/dev/tpmrm*' },
    ],
    hint: 'TPM device for attestation / sealed secrets workloads.',
  },
  {
    kind: 'watchdog', label: 'Watchdog',
    paths: [{ type: 'prefix', value: '/dev/watchdog*' }],
    hint: 'Hardware watchdog timer — typically passed to a system-management container.',
  },
];

/**
 * Tiny safe path-matcher. Returns an array of {path, kind?} from
 * scanning one pattern. Never throws — missing paths return [].
 *
 * For dir patterns with `recursive:true` we walk one extra level
 * (the only realistic case is /dev/bus/usb/<bus>/<device> and
 * /dev/snd/by-{id,path,…} symlinks). That's bounded — no unlimited
 * recursion, no symlink-following past the immediate read.
 */
async function scanPattern(pat) {
  const out = [];
  try {
    if (pat.type === 'single') {
      if (existsSync(pat.value)) out.push(pat.value);
    } else if (pat.type === 'prefix') {
      // "/dev/ttyUSB*" → dir=/dev, prefix=ttyUSB
      const lastSlash = pat.value.lastIndexOf('/');
      const dir = pat.value.slice(0, lastSlash);
      const prefix = pat.value.slice(lastSlash + 1).replace(/\*$/, '');
      if (!existsSync(dir)) return out;
      const names = await fs.readdir(dir);
      for (const n of names) {
        if (n.startsWith(prefix)) out.push(`${dir}/${n}`);
      }
    } else if (pat.type === 'dir') {
      if (!existsSync(pat.value)) return out;
      const names = await fs.readdir(pat.value, { withFileTypes: true });
      for (const e of names) {
        const child = `${pat.value}/${e.name}`;
        if (e.isDirectory() && pat.recursive) {
          // One extra level — enough for /dev/bus/usb/<bus>/<dev>.
          try {
            const inner = await fs.readdir(child);
            for (const n of inner) out.push(`${child}/${n}`);
          } catch { /* unreadable subdir; skip */ }
        } else {
          out.push(child);
        }
      }
    }
  } catch (err) {
    // Permission denied / transient I/O error — best-effort, skip.
  }
  return out;
}

/**
 * Walk every device category. Returns
 *   [{kind, label, hint, available, devices: ["/dev/...", ...]}, ...]
 * with absent categories carrying available:false (so the SPA can
 * render greyed-out rows + a 'how to enable' hint, instead of just
 * hiding everything the operator might be looking for).
 */
async function probeHostDevices() {
  const groups = [];
  for (const cat of DEVICE_CATEGORIES) {
    const found = new Set();
    for (const p of cat.paths) {
      for (const path of await scanPattern(p)) found.add(path);
    }
    groups.push({
      kind: cat.kind,
      label: cat.label,
      hint: cat.hint,
      available: found.size > 0,
      devices: [...found].sort(),
    });
  }
  return groups;
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

  const [nvidia, dri, hostDevices] = await Promise.all([
    probeNvidia(),
    probeDri(),
    probeHostDevices(),
  ]);

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
    // Categorised /dev scan — AMD ROCm, audio, USB, serial, V4L,
    // ML accelerators, TPM, watchdog. The Run dialog uses this to
    // populate a "Suggested devices" picker; the System tab renders
    // it as one panel per category.
    host_devices: hostDevices,
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

// ============================================================
// Live system resource summary — aggregated stats across containers
// ============================================================
//
// `docker stats` opens an N-second-long streaming connection per
// container. For a "top consumers" dashboard polling every few
// seconds, we want a SINGLE round-trip with bounded latency.
//
// Strategy:
//   1. listContainers(running)
//   2. For each, fan out (bounded concurrency 8) two stats samples
//      ~1s apart with `stream:false` — Docker doesn't compute the
//      delta for one-shot calls, so we collect two and compute it
//      ourselves via computeRate().
//   3. Sort, slice, return.
//
// We CACHE the result for SYSTEM_STATS_CACHE_TTL_MS (3s by default)
// because polling at 1-2s would otherwise saturate the daemon when
// there are many containers. Cached responses include a `cached:
// true` flag so the SPA can show staleness honestly if it ever
// matters.
//
// Per-container failures are isolated: we log + drop the failing
// container from the result rather than failing the whole endpoint.
const SYSTEM_STATS_CACHE_TTL_MS = 3000;
const SYSTEM_STATS_SAMPLE_GAP_MS = 1000;
const SYSTEM_STATS_CONCURRENCY = 8;

let statsCache = null;
let statsCacheAt = 0;

async function _sampleContainer(client, summary) {
  // dockerode's `stats({ stream: false })` returns a single sample
  // without precpu, so we hit the API twice and compute the rate
  // server-side. The two-sample gap also gives us a real network
  // throughput number rather than lifetime bytes.
  const c = client.getContainer(summary.Id);
  const t0 = Date.now();
  const a = await c.stats({ stream: false });
  await new Promise((r) => setTimeout(r, SYSTEM_STATS_SAMPLE_GAP_MS));
  const b = await c.stats({ stream: false });
  const dt = (Date.now() - t0) / 1000;
  const m = computeRate(a, b, dt);
  return {
    id: summary.Id,
    name: (summary.Names && summary.Names[0]) ? summary.Names[0].replace(/^\//, '') : summary.Id.slice(0, 12),
    image: summary.Image,
    cpu_pct: m.cpu_pct,
    mem_used_bytes: m.mem_used_bytes,
    mem_limit_bytes: m.mem_limit_bytes,
    mem_pct: m.mem_pct,
    net_rx_bytes_per_s: m.net_rx_bytes_per_s,
    net_tx_bytes_per_s: m.net_tx_bytes_per_s,
    blk_read_bytes_per_s: m.blk_read_bytes_per_s,
    blk_write_bytes_per_s: m.blk_write_bytes_per_s,
    pids: m.pids,
  };
}

async function buildStatsSummary(client) {
  const containers = await client.listContainers({ all: false });
  if (!containers.length) {
    return {
      sampled_at: new Date().toISOString(),
      cached: false,
      container_count: 0,
      totals: {
        cpu_pct: 0, mem_used_bytes: 0, mem_limit_bytes: 0,
        net_rx_bytes_per_s: 0, net_tx_bytes_per_s: 0,
        blk_read_bytes_per_s: 0, blk_write_bytes_per_s: 0,
      },
      top_cpu: [], top_memory: [], rows: [],
    };
  }

  const results = await runBoundedParallel(
    containers,
    async (summary) => {
      try { return await _sampleContainer(client, summary); }
      catch (err) {
        // Per-container failure is fine — could be a container that
        // exited between listContainers and our stats call. Log at
        // debug only so we don't spam logs every poll.
        logger.debug({ container_id: summary.Id, err: err.message }, 'stats summary: per-container sample failed');
        return null;
      }
    },
    SYSTEM_STATS_CONCURRENCY,
  );
  const rows = results.filter(Boolean);

  // Totals are SUMS across containers — useful for a host-wide
  // dashboard ("47 % of 8 cores in use", "12 GB / 16 GB").
  // mem_limit_bytes summed across containers can exceed host memory
  // if limits are over-provisioned; that's expected and matches
  // what `docker stats` shows.
  const totals = rows.reduce((acc, r) => ({
    cpu_pct: acc.cpu_pct + r.cpu_pct,
    mem_used_bytes: acc.mem_used_bytes + r.mem_used_bytes,
    mem_limit_bytes: acc.mem_limit_bytes + r.mem_limit_bytes,
    net_rx_bytes_per_s: acc.net_rx_bytes_per_s + r.net_rx_bytes_per_s,
    net_tx_bytes_per_s: acc.net_tx_bytes_per_s + r.net_tx_bytes_per_s,
    blk_read_bytes_per_s: acc.blk_read_bytes_per_s + r.blk_read_bytes_per_s,
    blk_write_bytes_per_s: acc.blk_write_bytes_per_s + r.blk_write_bytes_per_s,
  }), {
    cpu_pct: 0, mem_used_bytes: 0, mem_limit_bytes: 0,
    net_rx_bytes_per_s: 0, net_tx_bytes_per_s: 0,
    blk_read_bytes_per_s: 0, blk_write_bytes_per_s: 0,
  });

  return {
    sampled_at: new Date().toISOString(),
    cached: false,
    container_count: rows.length,
    totals,
    top_cpu: [...rows].sort((a, b) => b.cpu_pct - a.cpu_pct),
    top_memory: [...rows].sort((a, b) => b.mem_used_bytes - a.mem_used_bytes),
    rows,
  };
}

r.get(
  '/stats/summary',
  {
    summary: 'Aggregated live stats across all running containers (top consumers)',
    description:
      'Server-side aggregate of one stats sample per running container, cached for ' +
      `${SYSTEM_STATS_CACHE_TTL_MS / 1000}s. Returns totals, top_cpu (sorted desc), ` +
      'top_memory (sorted desc), and the full row set. Per-container sampling failures ' +
      'are silently dropped (logged at debug). Sampling fans out with bounded concurrency ' +
      `(${SYSTEM_STATS_CONCURRENCY}) and each container needs ~${SYSTEM_STATS_SAMPLE_GAP_MS}ms ` +
      'of sample gap to compute rates.',
    query: Type.Object(
      {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
      },
      { additionalProperties: false },
    ),
    responses: { 200: SystemStatsSummaryResponse },
  },
  asyncHandler(async (req, res) => {
    const limit = intQuery(req.query.limit, 10, { min: 1, max: 100 });
    let snapshot;
    if (statsCache && Date.now() - statsCacheAt < SYSTEM_STATS_CACHE_TTL_MS) {
      snapshot = { ...statsCache, cached: true };
    } else {
      snapshot = await buildStatsSummary(getClient());
      statsCache = snapshot;
      statsCacheAt = Date.now();
    }
    res.json({
      ...snapshot,
      top_cpu: snapshot.top_cpu.slice(0, limit),
      top_memory: snapshot.top_memory.slice(0, limit),
    });
  }),
);

// ============================================================
// Historical (persistent) monitoring queries
// ============================================================
//
// /events/history and /stats/history read from the JSONL files
// maintained by src/event-history.js and src/stats-history.js
// respectively. Both are read-only, both viewer-allowed (it's
// the same diagnostic data the live endpoints serve, just from
// disk instead of the daemon).
//
// The 503 paths exist so the SPA can render "history disabled"
// guidance instead of mysterious empty pages when an operator
// has turned the recorder off via env var.

const EventHistoryQuery = Type.Object(
  {
    since: Opt(Type.String({ description: 'ISO 8601 lower bound' })),
    until: Opt(Type.String({ description: 'ISO 8601 upper bound' })),
    // Docker event types: container | image | network | volume |
    // plugin | daemon | service | node | secret | config
    type: Opt(Type.String({ maxLength: 64 })),
    // Glob-style: 'start', 'container.die', '*' — matches the
    // audit query's action matcher.
    action: Opt(Type.String({ maxLength: 64 })),
    // Container ID prefix (short id works) OR name.
    actor_id: Opt(Type.String({ maxLength: 128 })),
    actor_name: Opt(Type.String({ maxLength: 256 })),
    limit: Opt(Type.Integer({ minimum: 1, maximum: 1000, default: 100 })),
    offset: Opt(Type.Integer({ minimum: 0, default: 0 })),
    order: Opt(StringEnum(['asc', 'desc'])),
  },
  { additionalProperties: false },
);

r.get(
  '/events/history',
  {
    summary: 'Past Docker events recorded by the manager (persistent JSONL store)',
    description:
      'Reads the manager\'s own persisted events file (and rotated siblings). Survives ' +
      'daemon restarts, unlike the daemon\'s own /events endpoint. 503 when the recorder ' +
      'is disabled (EVENTS_HISTORY_ENABLED=false).',
    query: EventHistoryQuery,
    responses: { 200: EventHistoryQueryResponse },
  },
  asyncHandler(async (req, res) => {
    if (!settings.eventsHistoryEnabled) {
      throw new HttpError(503, 'Events history is disabled (EVENTS_HISTORY_ENABLED=false)');
    }
    res.json(await queryEvents({
      since: req.query.since,
      until: req.query.until,
      type: req.query.type,
      action: req.query.action,
      actor_id: req.query.actor_id,
      actor_name: req.query.actor_name,
      limit: intQuery(req.query.limit, 100, { min: 1, max: 1000 }),
      offset: intQuery(req.query.offset, 0, { min: 0 }),
      order: req.query.order || 'desc',
    }));
  }),
);

const StatsHistoryQuery = Type.Object(
  {
    since: Opt(Type.String({ description: 'ISO 8601 lower bound' })),
    until: Opt(Type.String({ description: 'ISO 8601 upper bound' })),
    // Filter rows whose top[] snapshot includes a container with
    // this id prefix or this exact name. Drives the per-container
    // "View history" panel.
    container_id: Opt(Type.String({ maxLength: 256 })),
    limit: Opt(Type.Integer({ minimum: 1, maximum: 10000, default: 1000 })),
    offset: Opt(Type.Integer({ minimum: 0, default: 0 })),
    order: Opt(StringEnum(['asc', 'desc'])),
  },
  { additionalProperties: false },
);

r.get(
  '/stats/history',
  {
    summary: 'Past resource-usage samples (persistent JSONL store)',
    description:
      'Time-series snapshots of host + per-container resource usage, recorded at the ' +
      `interval set by STATS_HISTORY_INTERVAL_SEC. 503 when the sampler is disabled.`,
    query: StatsHistoryQuery,
    responses: { 200: StatsHistoryQueryResponse },
  },
  asyncHandler(async (req, res) => {
    if (!settings.statsHistoryEnabled) {
      throw new HttpError(503, 'Stats history is disabled (STATS_HISTORY_ENABLED=false)');
    }
    res.json(await queryStats({
      since: req.query.since,
      until: req.query.until,
      container_id: req.query.container_id,
      limit: intQuery(req.query.limit, 1000, { min: 1, max: 10000 }),
      offset: intQuery(req.query.offset, 0, { min: 0 }),
      // Time-series → ascending by default. Charts need oldest-
      // first to draw left-to-right; descending would force the
      // SPA to reverse the array every request.
      order: req.query.order || 'asc',
    }));
  }),
);

// Visible-for-testing only.
export const _internals = {
  discoverDevices,
  resetCacheForTests() {
    deviceCache = null; deviceCacheAt = 0;
    statsCache = null; statsCacheAt = 0;
  },
  buildStatsSummary,
  SYSTEM_STATS_SAMPLE_GAP_MS,
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
