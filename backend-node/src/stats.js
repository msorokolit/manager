// Stats math: turn a pair of Docker stats samples into the numbers
// people actually want — CPU%, memory excluding cache, network and
// block I/O rates in bytes-per-second.
//
// Kept as a pure function (no I/O, no dockerode handles) so we can
// unit-test it against captured Docker payloads and reuse it from
// both the per-container streaming endpoint's server-side aggregator
// and the new GET /api/system/stats/summary endpoint.
//
// Docker's stats JSON schema is documented at
// https://docs.docker.com/engine/api/v1.43/#tag/Container/operation/ContainerStats
// — the bits we use:
//   cpu_stats.cpu_usage.total_usage, .percpu_usage[]
//   cpu_stats.system_cpu_usage
//   cpu_stats.online_cpus
//   precpu_stats.{cpu_usage.total_usage, system_cpu_usage}
//   memory_stats.usage / .limit / .stats.cache (cgroups v1) or
//     .stats.inactive_file (cgroups v2)
//   networks[iface].{rx_bytes, tx_bytes}
//   blkio_stats.io_service_bytes_recursive[]  (cgroups v1)
//   pids_stats.current
//
// Two layouts coexist in the wild:
//   - cgroups v1: memory_stats.stats.cache
//   - cgroups v2: memory_stats.stats.inactive_file  (sometimes
//     `file` too; we subtract inactive_file which matches what
//     `docker stats` shows on cgroupsv2 hosts).
// We strip whichever's present so the "used" number matches what
// the operator sees in `docker stats`.

/**
 * Compute the human-meaningful numbers from a single Docker stats
 * sample.
 *
 * The sample is expected to already contain `precpu_stats` (the
 * sample N-1) — Docker's streaming endpoint always populates it
 * after the first frame. For a one-shot, we fetch two samples and
 * pass the second one here.
 *
 * Returns an object with safe zeros for missing fields rather than
 * NaN/undefined so JSON-encoded responses stay valid against our
 * schemas (minimum: 0).
 */
export function computeStats(sample, { intervalSeconds } = {}) {
  if (!sample || typeof sample !== 'object') {
    return _zero();
  }
  const cs = sample.cpu_stats || {};
  const ps = sample.precpu_stats || {};
  const ms = sample.memory_stats || {};

  // CPU %: classic `docker stats` formula.
  // cpu_delta / system_delta * online_cpus * 100
  const cpuDelta = (cs.cpu_usage?.total_usage || 0) - (ps.cpu_usage?.total_usage || 0);
  const sysDelta = (cs.system_cpu_usage || 0) - (ps.system_cpu_usage || 0);
  const onlineCpus = cs.online_cpus || (cs.cpu_usage?.percpu_usage || []).length || 1;
  let cpuPct = 0;
  if (sysDelta > 0 && cpuDelta > 0) cpuPct = (cpuDelta / sysDelta) * onlineCpus * 100;

  // Per-CPU breakdown (cgroups v1 only — v2 drops percpu_usage).
  const perCpuPct = [];
  const percpu = cs.cpu_usage?.percpu_usage;
  const prevPercpu = ps.cpu_usage?.percpu_usage;
  if (Array.isArray(percpu) && Array.isArray(prevPercpu) && sysDelta > 0) {
    for (let i = 0; i < percpu.length; i++) {
      const d = (percpu[i] || 0) - (prevPercpu[i] || 0);
      perCpuPct.push(d > 0 ? (d / sysDelta) * percpu.length * 100 : 0);
    }
  }

  // Memory: subtract cache/inactive_file so "used" matches what
  // `docker stats` shows (the in-flight RSS-ish number).
  const memTotal = ms.usage || 0;
  const memCache = (ms.stats?.cache != null)
    ? ms.stats.cache
    : (ms.stats?.inactive_file || 0);
  const memUsedBytes = Math.max(0, memTotal - memCache);
  const memLimitBytes = ms.limit || 0;
  const memPct = memLimitBytes > 0 ? (memUsedBytes / memLimitBytes) * 100 : 0;

  // Network: sum across all interfaces. For rates we need the
  // interval between samples — caller passes `intervalSeconds`. If
  // omitted (single sample, no rate), we return cumulative bytes
  // as the "rate" field with intervalSeconds=1, which matches what
  // most monitoring tools do for cold-start rows.
  let netRx = 0, netTx = 0;
  for (const v of Object.values(sample.networks || {})) {
    netRx += v.rx_bytes || 0;
    netTx += v.tx_bytes || 0;
  }
  // Block I/O: cgroups v1 puts byte counters in
  // blkio_stats.io_service_bytes_recursive; cgroups v2 leaves it
  // empty (Docker doesn't backfill). We accept either capitalised
  // op names because they vary across daemon versions.
  let blkR = 0, blkW = 0;
  for (const e of (sample.blkio_stats?.io_service_bytes_recursive || [])) {
    const op = (e.op || '').toLowerCase();
    if (op === 'read') blkR += e.value || 0;
    else if (op === 'write') blkW += e.value || 0;
  }

  const dt = intervalSeconds && intervalSeconds > 0 ? intervalSeconds : 1;
  return {
    cpu_pct: cpuPct,
    online_cpus: onlineCpus,
    per_cpu_pct: perCpuPct,
    mem_used_bytes: memUsedBytes,
    mem_limit_bytes: memLimitBytes,
    mem_pct: memPct,
    // These are absolute counters when intervalSeconds is omitted;
    // divide by dt to get rate. The summary endpoint always passes
    // intervalSeconds because it computes two samples per
    // container. Streaming consumers (SPA) divide client-side.
    net_rx_bytes_per_s: dt ? netRx / dt : 0,
    net_tx_bytes_per_s: dt ? netTx / dt : 0,
    blk_read_bytes_per_s: dt ? blkR / dt : 0,
    blk_write_bytes_per_s: dt ? blkW / dt : 0,
    pids: sample.pids_stats?.current,
  };
}

/**
 * Helper: turn two cumulative samples into RATES for the network
 * and block-I/O counters (which are monotonic). Caller passes both
 * samples; we subtract counters and divide by the timestamp delta.
 *
 * Used by the system summary endpoint which deliberately collects
 * two samples spaced ~1 second apart so it can show actual
 * throughput rather than lifetime totals.
 */
export function computeRate(prev, curr, intervalSeconds) {
  const a = computeStats(curr, { intervalSeconds: 1 });   // cumulative
  if (!prev || !intervalSeconds || intervalSeconds <= 0) return a;
  const b = computeStats(prev, { intervalSeconds: 1 });   // cumulative
  // Subtract the previous cumulative counters then divide by dt.
  const sub = (x, y) => Math.max(0, (x - y) / intervalSeconds);
  return {
    ...a,
    net_rx_bytes_per_s: sub(a.net_rx_bytes_per_s, b.net_rx_bytes_per_s),
    net_tx_bytes_per_s: sub(a.net_tx_bytes_per_s, b.net_tx_bytes_per_s),
    blk_read_bytes_per_s: sub(a.blk_read_bytes_per_s, b.blk_read_bytes_per_s),
    blk_write_bytes_per_s: sub(a.blk_write_bytes_per_s, b.blk_write_bytes_per_s),
  };
}

function _zero() {
  return {
    cpu_pct: 0,
    online_cpus: 1,
    per_cpu_pct: [],
    mem_used_bytes: 0,
    mem_limit_bytes: 0,
    mem_pct: 0,
    net_rx_bytes_per_s: 0,
    net_tx_bytes_per_s: 0,
    blk_read_bytes_per_s: 0,
    blk_write_bytes_per_s: 0,
    pids: undefined,
  };
}
