import { Type } from '@sinclair/typebox';
import { Opt, StringEnum } from './_common.js';

/**
 * One row in the SystemStatsSummaryResponse — a single container's
 * live resource snapshot derived from a stats sample.
 *
 * Bytes-per-second fields are RATES, not totals — we compute deltas
 * server-side between two consecutive stats samples so the SPA can
 * show throughput without having to remember the previous sample.
 */
export const ContainerStatsSummary = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    image: Opt(Type.String()),
    cpu_pct: Type.Number({ minimum: 0 }),
    mem_used_bytes: Type.Integer({ minimum: 0 }),
    mem_limit_bytes: Type.Integer({ minimum: 0 }),
    mem_pct: Type.Number({ minimum: 0 }),
    net_rx_bytes_per_s: Type.Number({ minimum: 0 }),
    net_tx_bytes_per_s: Type.Number({ minimum: 0 }),
    blk_read_bytes_per_s: Type.Number({ minimum: 0 }),
    blk_write_bytes_per_s: Type.Number({ minimum: 0 }),
    pids: Opt(Type.Integer({ minimum: 0 })),
  },
  { $id: 'ContainerStatsSummary', additionalProperties: false },
);

/**
 * GET /api/system/stats/summary — aggregate snapshot of every
 * running container's resource usage at one point in time.
 *
 * `sampled_at` is the server's wall-clock when the sample completed
 * (not the start) so the SPA can show "X seconds ago" honestly.
 * Failures sampling individual containers are silently dropped from
 * the result — they're recorded server-side but don't take down the
 * whole summary.
 *
 * `cached` tells the SPA whether the data came from the in-memory
 * cache (still <TTL old) or was freshly computed; useful for
 * debugging UI staleness without exposing the TTL.
 */
export const SystemStatsSummaryResponse = Type.Object(
  {
    sampled_at: Type.String({ format: 'date-time' }),
    cached: Type.Boolean(),
    container_count: Type.Integer({ minimum: 0 }),
    totals: Type.Object(
      {
        cpu_pct: Type.Number({ minimum: 0 }),
        mem_used_bytes: Type.Integer({ minimum: 0 }),
        mem_limit_bytes: Type.Integer({ minimum: 0 }),
        net_rx_bytes_per_s: Type.Number({ minimum: 0 }),
        net_tx_bytes_per_s: Type.Number({ minimum: 0 }),
        blk_read_bytes_per_s: Type.Number({ minimum: 0 }),
        blk_write_bytes_per_s: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    top_cpu: Type.Array(Type.Ref(ContainerStatsSummary)),
    top_memory: Type.Array(Type.Ref(ContainerStatsSummary)),
    rows: Type.Array(Type.Ref(ContainerStatsSummary)),
  },
  { $id: 'SystemStatsSummaryResponse', additionalProperties: false },
);

/**
 * One normalised entry in the persistent Docker events log.
 *
 * Schema is intentionally close to what Docker emits, with the
 * irregular bits (free-form Attributes blob) carried through as a
 * passthrough object so we don't lose drill-down detail (exit
 * codes, signals, healthcheck transitions).
 */
export const EventHistoryEntry = Type.Object(
  {
    ts: Type.String({ format: 'date-time' }),
    type: Type.String(),
    action: Type.String(),
    scope: Opt(Type.String()),
    actor_id: Opt(Type.Union([Type.String(), Type.Null()])),
    actor_name: Opt(Type.Union([Type.String(), Type.Null()])),
    image: Opt(Type.Union([Type.String(), Type.Null()])),
    // Docker event attributes are always primitives (names, image
    // refs, exit codes, signal numbers, healthcheck text). Locking
    // to a primitive union — instead of `Type.Any()` — gives us a
    // belt-and-braces guard against accidentally writing nested
    // structures we'd then have to escape for the SPA's <pre>
    // detail view, and prevents the recorder from being abused as
    // a generic blob store if anything ever feeds it user-tainted
    // attribute payloads.
    attributes: Opt(Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    )),
  },
  { $id: 'EventHistoryEntry', additionalProperties: false },
);

export const EventHistoryQueryResponse = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    returned: Type.Integer({ minimum: 0 }),
    has_more: Type.Boolean(),
    scanned: Opt(Type.Integer({ minimum: 0 })),
    truncated: Opt(Type.Boolean()),
    entries: Type.Array(Type.Ref(EventHistoryEntry)),
  },
  { $id: 'EventHistoryQueryResponse', additionalProperties: false },
);

/**
 * One sample in the persistent stats log. Mirrors
 * SystemStatsSummaryResponse but with a bounded `top[]` rather
 * than `top_cpu` + `top_memory` + `rows[]` (we slice to the top-N
 * heaviest on the way to disk so per-row size stays predictable).
 */
export const StatsHistoryEntry = Type.Object(
  {
    ts: Type.String({ format: 'date-time' }),
    container_count: Type.Integer({ minimum: 0 }),
    totals: Type.Object(
      {
        cpu_pct: Type.Number({ minimum: 0 }),
        mem_used_bytes: Type.Integer({ minimum: 0 }),
        mem_limit_bytes: Type.Integer({ minimum: 0 }),
        net_rx_bytes_per_s: Type.Number({ minimum: 0 }),
        net_tx_bytes_per_s: Type.Number({ minimum: 0 }),
        blk_read_bytes_per_s: Type.Number({ minimum: 0 }),
        blk_write_bytes_per_s: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    top: Type.Array(Type.Ref(ContainerStatsSummary)),
  },
  { $id: 'StatsHistoryEntry', additionalProperties: false },
);

export const StatsHistoryQueryResponse = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    returned: Type.Integer({ minimum: 0 }),
    has_more: Type.Boolean(),
    scanned: Opt(Type.Integer({ minimum: 0 })),
    truncated: Opt(Type.Boolean()),
    entries: Type.Array(Type.Ref(StatsHistoryEntry)),
  },
  { $id: 'StatsHistoryQueryResponse', additionalProperties: false },
);

export const PingResponse = Type.Object(
  {
    ok: Type.Boolean(),
    user: Type.String(),
    role: StringEnum(['admin', 'viewer']),
  },
  { $id: 'PingResponse', additionalProperties: false },
);

export const HealthResponse = Type.Object(
  {
    status: Type.Literal('ok'),
    version: Type.String(),
  },
  { $id: 'HealthResponse', additionalProperties: false },
);

export const ConfigResponse = Type.Object(
  {
    version: Type.String(),
    allow_destructive: Type.Boolean(),
    compose_available: Type.Boolean(),
    stacks_dir: Type.String(),
    exec_default_shell: Type.String(),
    browser_image: Type.String(),
    registries_file: Type.String(),
    backend: Type.Literal('node'),
  },
  { $id: 'ConfigResponse', additionalProperties: true },
);

export const TicketResponse = Type.Object(
  {
    ticket: Type.String(),
    expires_in: Type.Integer({ minimum: 1 }),
  },
  { $id: 'TicketResponse', additionalProperties: false },
);

// ---------- Accelerator + device discovery ----------

/** One row in `docker info` Runtimes. `runc` ships with the daemon;
 *  `nvidia`, `crun`, `kata-runtime` etc. land via OCI runtime plugins. */
export const RuntimeInfo = Type.Object(
  {
    name: Type.String(),
    path: Opt(Type.String()),
    status: Opt(Type.Object({}, { additionalProperties: true })),
  },
  { $id: 'RuntimeInfo', additionalProperties: true },
);

/** One NVIDIA GPU as reported by `nvidia-smi`. Fields may be null
 *  when smi output is shorter than expected (older driver versions). */
export const NvidiaGpu = Type.Object(
  {
    index: Type.String({ description: 'GPU index (e.g. "0", "1")' }),
    uuid: Opt(Type.String()),
    name: Opt(Type.String()),
    memory_mb: Opt(Type.Integer()),
    driver_version: Opt(Type.String()),
  },
  { $id: 'NvidiaGpu', additionalProperties: false },
);

/**
 * One row in the "host devices" categorised scan. Each kind covers a
 * common pass-through use case; `devices` is the list of `/dev/...`
 * paths found, `hint` explains in one line how the operator typically
 * uses the category. When the category exists on the host but the
 * manager container can't see it, `available` is false and `devices`
 * is empty — surfaced rather than hidden so the operator knows there
 * IS such a thing as "TPM pass-through" they could enable.
 */
export const HostDeviceGroup = Type.Object(
  {
    kind: StringEnum([
      'gpu_amd', 'audio', 'usb', 'serial', 'video', 'tpu', 'tpm', 'watchdog',
    ]),
    label: Type.String(),
    hint: Opt(Type.String()),
    available: Type.Boolean(),
    devices: Type.Array(Type.String()),
  },
  { $id: 'HostDeviceGroup', additionalProperties: false },
);

export const DeviceDiscoveryResponse = Type.Object(
  {
    runtimes: Type.Array(RuntimeInfo),
    default_runtime: Type.String(),
    gpu_runtime: Opt(Type.String({
      description: 'Suggested runtime for GPU workloads (typically "nvidia" when present, else null).',
    })),
    nvidia: Type.Object(
      {
        available: Type.Boolean(),
        note: Opt(Type.String({
          description: 'Why GPUs could not be enumerated (e.g. nvidia-smi absent, manager container can\'t see /dev/nvidia*).',
        })),
        gpus: Opt(Type.Array(NvidiaGpu)),
      },
      { additionalProperties: false },
    ),
    dri: Type.Object(
      {
        available: Type.Boolean(),
        note: Opt(Type.String()),
        devices: Opt(Type.Array(Type.String(), {
          description: 'Discovered /dev/dri/* device paths (Intel/AMD VAAPI).',
        })),
      },
      { additionalProperties: false },
    ),
    /** Curated /dev scan, grouped by category. See HostDeviceGroup. */
    host_devices: Type.Array(HostDeviceGroup, {
      description: 'Categorised scan of common pass-through devices (AMD ROCm, audio, USB, serial, V4L, ML accelerators, TPM, watchdog).',
    }),
    discovered_at: Type.String({ description: 'ISO timestamp; results are cached for 30s.' }),
  },
  { $id: 'DeviceDiscoveryResponse', additionalProperties: false },
);
