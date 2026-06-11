// buildCreateOptions: verify the GPU + devices + runtime fields land
// in the right dockerode shape. This is the function that translates
// our JSON Schema-typed body into the daemon's PascalCase HostConfig.
//
// Pure unit tests — no daemon, no http, just the translation function.

import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-build-opts';
  process.env.LOG_LEVEL = 'silent';
});

// Stub the docker client so module load doesn't try to dial.
vi.mock('../src/docker-client.js', () => ({
  getClient: () => ({}),
  dockerError: (e) => ({ status: e.statusCode || 500, detail: e.message || 'docker error' }),
}));

const { _internals } = await import('../src/routes/containers.js');
const { buildCreateOptions, buildUpdateOptions, memBytes } = _internals;

describe('buildCreateOptions — devices', () => {
  it('translates host:container:perms strings into Devices entries', () => {
    const out = buildCreateOptions({
      image: 'nginx',
      devices: ['/dev/dri:/dev/dri:rwm', '/dev/snd:/dev/snd:rw', '/dev/usb/lp0'],
    });
    expect(out.HostConfig.Devices).toEqual([
      { PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' },
      { PathOnHost: '/dev/snd', PathInContainer: '/dev/snd', CgroupPermissions: 'rw' },
      // host-only string → container path mirrors host, perms default to 'rwm'
      { PathOnHost: '/dev/usb/lp0', PathInContainer: '/dev/usb/lp0', CgroupPermissions: 'rwm' },
    ]);
  });

  it('omits Devices when none are requested', () => {
    const out = buildCreateOptions({ image: 'nginx' });
    expect(out.HostConfig.Devices).toBeUndefined();
  });
});

describe('buildCreateOptions — GPUs (legacy gpus + new gpu_device_ids/capabilities)', () => {
  it('no GPU spec → no DeviceRequests', () => {
    const out = buildCreateOptions({ image: 'nginx' });
    expect(out.HostConfig.DeviceRequests).toBeUndefined();
  });

  it('legacy gpus: "all" → Count -1, default capabilities ["gpu"]', () => {
    const out = buildCreateOptions({ image: 'cuda', gpus: 'all' });
    expect(out.HostConfig.DeviceRequests).toEqual([
      { Count: -1, Capabilities: [['gpu']] },
    ]);
  });

  it('legacy gpus: N → Count N', () => {
    const out = buildCreateOptions({ image: 'cuda', gpus: 2 });
    expect(out.HostConfig.DeviceRequests).toEqual([
      { Count: 2, Capabilities: [['gpu']] },
    ]);
  });

  it('gpu_device_ids → DeviceIDs + Driver:"" (runtime default)', () => {
    const out = buildCreateOptions({
      image: 'cuda', gpu_device_ids: ['0', '1'],
    });
    expect(out.HostConfig.DeviceRequests).toEqual([
      { Driver: '', DeviceIDs: ['0', '1'], Capabilities: [['gpu']] },
    ]);
  });

  it('gpu_device_ids beats legacy gpus when both are provided (explicit > vague)', () => {
    const out = buildCreateOptions({
      image: 'cuda', gpus: 'all', gpu_device_ids: ['0'],
    });
    expect(out.HostConfig.DeviceRequests).toHaveLength(1);
    expect(out.HostConfig.DeviceRequests[0]).toMatchObject({ DeviceIDs: ['0'] });
    expect(out.HostConfig.DeviceRequests[0]).not.toHaveProperty('Count');
  });

  it('gpu_capabilities overrides the default ["gpu"] cap set', () => {
    const out = buildCreateOptions({
      image: 'cuda', gpus: 'all',
      gpu_capabilities: ['compute', 'utility', 'video'],
    });
    expect(out.HostConfig.DeviceRequests[0].Capabilities).toEqual([
      ['compute', 'utility', 'video'],
    ]);
  });

  it('gpu_capabilities works alongside gpu_device_ids too', () => {
    const out = buildCreateOptions({
      image: 'cuda',
      gpu_device_ids: ['GPU-aaaa-bbbb'],
      gpu_capabilities: ['compute'],
    });
    expect(out.HostConfig.DeviceRequests).toEqual([
      { Driver: '', DeviceIDs: ['GPU-aaaa-bbbb'], Capabilities: [['compute']] },
    ]);
  });
});

describe('buildCreateOptions — runtime', () => {
  it('passes runtime through to HostConfig.Runtime', () => {
    const out = buildCreateOptions({ image: 'cuda', runtime: 'nvidia' });
    expect(out.HostConfig.Runtime).toBe('nvidia');
  });

  it('omits Runtime when not specified (daemon picks DefaultRuntime)', () => {
    const out = buildCreateOptions({ image: 'cuda' });
    expect(out.HostConfig.Runtime).toBeUndefined();
  });
});

// ============================================================
// memBytes — used by both create and live-update paths
// ============================================================

describe('memBytes', () => {
  it('parses k / m / g / t suffixes (case-insensitive)', () => {
    expect(memBytes('512m')).toBe(512 * 1024 ** 2);
    expect(memBytes('1g')).toBe(1024 ** 3);
    expect(memBytes('2G')).toBe(2 * 1024 ** 3);
    expect(memBytes('1.5g')).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(memBytes('512')).toBe(512); // plain bytes
    expect(memBytes('1t')).toBe(1024 ** 4);
  });

  it('passes numbers through verbatim (already bytes)', () => {
    expect(memBytes(67108864)).toBe(67108864);
    expect(memBytes(0)).toBe(0);
  });

  it('returns undefined for empty / null / garbage so the field is skipped', () => {
    expect(memBytes(null)).toBeUndefined();
    expect(memBytes('')).toBeUndefined();
    expect(memBytes(undefined)).toBeUndefined();
    expect(memBytes('lol')).toBeUndefined();
    expect(memBytes('$(echo 100)')).toBeUndefined();
  });
});

// ============================================================
// buildUpdateOptions — live-update translation
// ============================================================

describe('buildUpdateOptions', () => {
  it('translates every supported knob to PascalCase', () => {
    const out = buildUpdateOptions({
      cpus: 1.5, cpu_shares: 1024, cpuset_cpus: '0-3',
      mem_limit: '512m', mem_reservation: '256m', memswap_limit: '1g',
      pids_limit: 200, blkio_weight: 500,
      restart_policy: 'unless-stopped',
    });
    expect(out).toEqual({
      NanoCpus: 1_500_000_000,
      CpuShares: 1024,
      CpusetCpus: '0-3',
      Memory: 512 * 1024 ** 2,
      MemoryReservation: 256 * 1024 ** 2,
      MemorySwap: 1024 ** 3,
      PidsLimit: 200,
      BlkioWeight: 500,
      RestartPolicy: { Name: 'unless-stopped' },
    });
  });

  it('omits unset fields (daemon then leaves them untouched)', () => {
    const out = buildUpdateOptions({ cpus: 2 });
    expect(out).toEqual({ NanoCpus: 2_000_000_000 });
    expect(out.Memory).toBeUndefined();
    expect(out.RestartPolicy).toBeUndefined();
  });

  it('honours memswap_limit: -1 as "unlimited" (Docker convention)', () => {
    const out = buildUpdateOptions({ memswap_limit: -1 });
    expect(out.MemorySwap).toBe(-1);
  });

  it('empty body → empty payload (the route turns this into a 400)', () => {
    expect(buildUpdateOptions({})).toEqual({});
  });
});
