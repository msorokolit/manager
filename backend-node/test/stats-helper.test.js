// Unit tests for src/stats.js — the pure stats math helper.
//
// We feed it Docker stats payloads (captured from real daemons +
// synthesised edge cases) and check the human-meaningful numbers:
// CPU %, memory excluding cache, network throughput, block-I/O
// rate, per-CPU breakdown, pids.
//
// Two callers depend on this helper (the system summary endpoint
// and the SPA's live stats tab), so getting the math right matters
// more than route-level wiring.

import { describe, it, expect } from 'vitest';
import { computeStats, computeRate } from '../src/stats.js';

// A minimal sample with prev/curr CPU + memory + one net iface +
// blkio + pids. Numbers are chosen so the expected output is easy
// to verify by hand.
function makeSample({ cpu = 200, syscpu = 1000, cpus = 4,
  mem = 1024 * 1024 * 512, memCache = 1024 * 1024 * 128,
  memLimit = 1024 * 1024 * 1024,
  netRx = 1000, netTx = 500,
  blkR = 4096, blkW = 8192, pids = 12,
  prevCpu = 100, prevSyscpu = 500, percpu = null,
} = {}) {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: cpu, percpu_usage: percpu || [] },
      system_cpu_usage: syscpu,
      online_cpus: cpus,
    },
    precpu_stats: {
      cpu_usage: { total_usage: prevCpu, percpu_usage: percpu ? percpu.map((v) => Math.floor(v / 2)) : [] },
      system_cpu_usage: prevSyscpu,
    },
    memory_stats: {
      usage: mem,
      limit: memLimit,
      stats: { cache: memCache },
    },
    networks: { eth0: { rx_bytes: netRx, tx_bytes: netTx } },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'Read', value: blkR },
        { op: 'Write', value: blkW },
      ],
    },
    pids_stats: { current: pids },
  };
}

describe('computeStats — CPU%', () => {
  it('classic docker stats formula: cpu_delta / system_delta * cpus * 100', () => {
    const s = makeSample({ cpu: 200, prevCpu: 100, syscpu: 1000, prevSyscpu: 500, cpus: 4 });
    // cpu_delta=100, sys_delta=500, cpus=4 → 100/500 * 4 * 100 = 80%
    const r = computeStats(s);
    expect(r.cpu_pct).toBeCloseTo(80, 2);
  });

  it('returns 0 % when the deltas are zero (first sample / paused container)', () => {
    const s = makeSample({ cpu: 100, prevCpu: 100, syscpu: 500, prevSyscpu: 500 });
    expect(computeStats(s).cpu_pct).toBe(0);
  });

  it('returns 0 % when sys_delta is negative or zero (sample skew)', () => {
    const s = makeSample({ syscpu: 400, prevSyscpu: 500 }); // negative
    expect(computeStats(s).cpu_pct).toBe(0);
  });

  it('handles cgroupsv2 (no percpu_usage) by falling back to online_cpus', () => {
    const s = makeSample({ cpus: 8 });
    delete s.cpu_stats.cpu_usage.percpu_usage;
    delete s.precpu_stats.cpu_usage.percpu_usage;
    // cpu_delta=100, sys_delta=500, cpus=8 → 160%
    expect(computeStats(s).cpu_pct).toBeCloseTo(160, 2);
  });
});

describe('computeStats — per-CPU breakdown', () => {
  it('emits per-CPU percentages when percpu_usage is present (cgroupsv1)', () => {
    const s = makeSample({ percpu: [400, 400, 0, 200], cpus: 4 });
    // Each percpu is current; prev = floor(curr/2). Deltas = [200,200,0,100]
    // sys_delta = 500. cores = 4. So each = delta / 500 * 4 * 100
    // = [160, 160, 0, 80]
    const r = computeStats(s);
    expect(r.per_cpu_pct).toHaveLength(4);
    expect(r.per_cpu_pct[0]).toBeCloseTo(160, 1);
    expect(r.per_cpu_pct[1]).toBeCloseTo(160, 1);
    expect(r.per_cpu_pct[2]).toBe(0);
    expect(r.per_cpu_pct[3]).toBeCloseTo(80, 1);
  });

  it('returns an empty per-CPU array on cgroupsv2', () => {
    const s = makeSample();
    expect(computeStats(s).per_cpu_pct).toEqual([]);
  });
});

describe('computeStats — memory ex-cache', () => {
  it('subtracts memory_stats.stats.cache (cgroupsv1)', () => {
    const s = makeSample({ mem: 1_000_000, memCache: 200_000, memLimit: 2_000_000 });
    const r = computeStats(s);
    expect(r.mem_used_bytes).toBe(800_000);
    expect(r.mem_limit_bytes).toBe(2_000_000);
    expect(r.mem_pct).toBeCloseTo(40, 2);
  });

  it('subtracts memory_stats.stats.inactive_file when cache is missing (cgroupsv2)', () => {
    const s = makeSample({ mem: 1_000_000, memLimit: 2_000_000 });
    delete s.memory_stats.stats.cache;
    s.memory_stats.stats.inactive_file = 300_000;
    expect(computeStats(s).mem_used_bytes).toBe(700_000);
  });

  it('mem_pct is 0 when limit is 0 (containers with no memory limit set)', () => {
    const s = makeSample({ memLimit: 0 });
    expect(computeStats(s).mem_pct).toBe(0);
  });

  it('never goes negative when cache > usage (rare but observed in the wild)', () => {
    const s = makeSample({ mem: 100, memCache: 500 });
    expect(computeStats(s).mem_used_bytes).toBe(0);
  });
});

describe('computeStats — network + block I/O', () => {
  it('sums across all network interfaces', () => {
    const s = makeSample({ netRx: 1000, netTx: 500 });
    s.networks.eth1 = { rx_bytes: 2000, tx_bytes: 100 };
    s.networks.docker0 = { rx_bytes: 50, tx_bytes: 25 };
    const r = computeStats(s);
    expect(r.net_rx_bytes_per_s).toBe(3050);
    expect(r.net_tx_bytes_per_s).toBe(625);
  });

  it('accepts both capitalised and lowercase op names for blkio', () => {
    const s = makeSample();
    s.blkio_stats.io_service_bytes_recursive = [
      { op: 'read', value: 100 },
      { op: 'WRITE', value: 200 }, // unexpected casing
      { op: 'Read', value: 50 },
      { op: 'sync', value: 999 },  // unrelated op
    ];
    const r = computeStats(s);
    expect(r.blk_read_bytes_per_s).toBe(150);  // 100 + 50, case-insensitive
    expect(r.blk_write_bytes_per_s).toBe(200); // 'WRITE' (uppercase) IS matched
    // Re-check that 'sync' (unrelated op) doesn't get counted.
    expect(r.blk_read_bytes_per_s + r.blk_write_bytes_per_s).toBe(350);
    expect(r.blk_read_bytes_per_s + r.blk_write_bytes_per_s).not.toBe(1349);
  });

  it('zeros all network / blkio fields when missing (cgroupsv2 hosts often drop blkio)', () => {
    const s = makeSample();
    delete s.networks;
    delete s.blkio_stats;
    const r = computeStats(s);
    expect(r.net_rx_bytes_per_s).toBe(0);
    expect(r.blk_read_bytes_per_s).toBe(0);
  });
});

describe('computeStats — defensive zeros', () => {
  it('handles a completely empty sample without throwing', () => {
    const r = computeStats({});
    expect(r.cpu_pct).toBe(0);
    expect(r.mem_used_bytes).toBe(0);
    expect(r.net_rx_bytes_per_s).toBe(0);
  });

  it('handles null/undefined sample without throwing', () => {
    expect(computeStats(null).cpu_pct).toBe(0);
    expect(computeStats(undefined).cpu_pct).toBe(0);
  });
});

describe('computeRate — server-side aggregation', () => {
  it('computes net + blkio RATES from two cumulative samples', () => {
    const a = makeSample({ netRx: 1000, netTx: 500, blkR: 4096, blkW: 8192 });
    const b = makeSample({ netRx: 3000, netTx: 1500, blkR: 8192, blkW: 16384 });
    // Over 2s: rx_delta=2000/2=1000 B/s, tx=500, blkR=2048, blkW=4096
    const r = computeRate(a, b, 2);
    expect(r.net_rx_bytes_per_s).toBe(1000);
    expect(r.net_tx_bytes_per_s).toBe(500);
    expect(r.blk_read_bytes_per_s).toBe(2048);
    expect(r.blk_write_bytes_per_s).toBe(4096);
  });

  it('clamps negative deltas to 0 (counter reset on container restart)', () => {
    const a = makeSample({ netRx: 5000 });
    const b = makeSample({ netRx: 1000 }); // counter went BACKWARDS
    expect(computeRate(a, b, 1).net_rx_bytes_per_s).toBe(0);
  });

  it('falls back to single-sample (cumulative) behavior when prev is missing', () => {
    const a = makeSample({ netRx: 5000 });
    const r = computeRate(null, a, 0);
    expect(r.net_rx_bytes_per_s).toBe(5000); // cumulative, no rate division
  });

  it('CPU% comes from the LATER sample (uses its precpu_stats internally)', () => {
    const earlier = makeSample({ cpu: 100, prevCpu: 50, syscpu: 500, prevSyscpu: 250 });
    const later = makeSample({ cpu: 400, prevCpu: 200, syscpu: 2000, prevSyscpu: 1000 });
    const r = computeRate(earlier, later, 2);
    // later: cpu_delta=200, sys_delta=1000, cpus=4 → 80%
    expect(r.cpu_pct).toBeCloseTo(80, 1);
  });
});
