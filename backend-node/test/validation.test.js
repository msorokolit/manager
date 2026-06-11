// Schema validation parity tests for the freshly-tightened schemas (C2, M4).
import { describe, it, expect, beforeAll } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as S from '../src/schemas/index.js';

let ajv;
beforeAll(() => {
  ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
  addFormats(ajv);
});

function valid(schema, data) {
  return ajv.compile(schema)(data);
}

describe('ImageIdParam (C2)', () => {
  it('accepts a sha256 digest', () => {
    expect(valid(S.ImageIdParam, { id: 'sha256:abcdef0123456789' })).toBe(true);
  });

  it('accepts a short hex id', () => {
    expect(valid(S.ImageIdParam, { id: 'abcdef012345' })).toBe(true);
  });

  it('accepts a canonical reference with namespace + tag', () => {
    expect(valid(S.ImageIdParam, { id: 'library/nginx:1.27-alpine' })).toBe(true);
  });

  it('accepts a registry host + port + repo + tag', () => {
    expect(valid(S.ImageIdParam, { id: 'ghcr.io/owner/repo:v1.2' })).toBe(true);
  });

  it('rejects path-traversal segments', () => {
    expect(valid(S.ImageIdParam, { id: '../etc/passwd' })).toBe(false);
  });

  it('rejects spaces and shell metachars', () => {
    expect(valid(S.ImageIdParam, { id: 'foo;rm -rf /' })).toBe(false);
    expect(valid(S.ImageIdParam, { id: 'foo bar' })).toBe(false);
    expect(valid(S.ImageIdParam, { id: '$(whoami)' })).toBe(false);
  });

  it('rejects empty / oversized', () => {
    expect(valid(S.ImageIdParam, { id: '' })).toBe(false);
    expect(valid(S.ImageIdParam, { id: 'a'.repeat(513) })).toBe(false);
  });
});

describe('Volume browser schemas', () => {
  function isValidEntry(payload) {
    return valid(S.VolumeBrowseEntry, payload);
  }
  function isValidList(payload) {
    return valid(S.VolumeBrowseListResponse, payload);
  }
  function isValidRename(payload) {
    return valid(S.VolumeBrowseRenameRequest, payload);
  }
  function isValidView(payload) {
    return valid(S.VolumeBrowseViewResponse, payload);
  }

  const baseEntry = {
    name: 'foo.txt',
    is_dir: false,
    is_link: false,
    size: 1024,
    mode: 0o100644,
    mode_str: '-rw-r--r--',
    mtime: 1_700_000_000,
    uid: 0,
    gid: 0,
    user: 'root',
    group: 'root',
  };

  it('VolumeBrowseEntry accepts a fully-populated entry', () => {
    expect(isValidEntry(baseEntry)).toBe(true);
  });

  it('VolumeBrowseEntry accepts a symlink with link_target', () => {
    expect(isValidEntry({ ...baseEntry, is_link: true, link_target: '/etc/hostname' })).toBe(true);
  });

  it('VolumeBrowseEntry rejects unknown fields (strict)', () => {
    expect(isValidEntry({ ...baseEntry, sneaky: 'value' })).toBe(false);
  });

  it('VolumeBrowseEntry rejects when mode_str is missing', () => {
    const { mode_str, ...withoutPerms } = baseEntry;
    expect(isValidEntry(withoutPerms)).toBe(false);
  });

  it('VolumeBrowseListResponse requires total + entries', () => {
    expect(isValidList({ path: '/', total: 0, entries: [] })).toBe(true);
    expect(isValidList({ path: '/', entries: [] })).toBe(false);
    expect(isValidList({ path: '/', total: 1, entries: [baseEntry] })).toBe(true);
  });

  it('VolumeBrowseRenameRequest requires both ends', () => {
    expect(isValidRename({ from: '/a.txt', to: '/b.txt' })).toBe(true);
    expect(isValidRename({ from: '/a.txt' })).toBe(false);
    expect(isValidRename({ from: '', to: '/b.txt' })).toBe(false);
  });

  it('VolumeBrowseViewResponse: text shape', () => {
    expect(
      isValidView({
        path: '/foo.txt',
        size: 7,
        mtime: 1781040000.5,
        is_binary: false,
        truncated: false,
        encoding: 'utf-8',
        content: 'hello\n',
      }),
    ).toBe(true);
  });

  it('VolumeBrowseViewResponse: binary shape (no content/encoding)', () => {
    expect(
      isValidView({
        path: '/foo.bin',
        size: 12_000,
        mtime: 1781040000.5,
        is_binary: true,
        truncated: false,
      }),
    ).toBe(true);
  });

  it('VolumeBrowseViewResponse: requires mtime (for optimistic-concurrency token)', () => {
    expect(
      isValidView({
        path: '/foo.txt', size: 7, is_binary: false, truncated: false,
        encoding: 'utf-8', content: 'hi',
      }),
    ).toBe(false);
  });

  it('VolumeBrowseChmodRequest accepts canonical octal modes', () => {
    const isValidChmod = (p) => valid(S.VolumeBrowseChmodRequest, p);
    expect(isValidChmod({ path: '/foo', mode: '0644' })).toBe(true);
    expect(isValidChmod({ path: '/foo', mode: '755' })).toBe(true);
    expect(isValidChmod({ path: '/foo', mode: '0700' })).toBe(true);
    expect(isValidChmod({ path: '/foo', mode: '644', recursive: true })).toBe(true);
  });

  it('VolumeBrowseChmodRequest rejects garbage modes', () => {
    const isValidChmod = (p) => valid(S.VolumeBrowseChmodRequest, p);
    expect(isValidChmod({ path: '/foo', mode: 'u+x' })).toBe(false);
    expect(isValidChmod({ path: '/foo', mode: '988' })).toBe(false);
    expect(isValidChmod({ path: '/foo', mode: '0xff' })).toBe(false);
    expect(isValidChmod({ path: '/foo', mode: '' })).toBe(false);
    expect(isValidChmod({ path: '/foo', mode: '1234567' })).toBe(false);
  });

  it('VolumeBrowseChmodRequest requires both path and mode', () => {
    const isValidChmod = (p) => valid(S.VolumeBrowseChmodRequest, p);
    expect(isValidChmod({ mode: '0644' })).toBe(false);
    expect(isValidChmod({ path: '/foo' })).toBe(false);
    expect(isValidChmod({ path: '', mode: '0644' })).toBe(false);
  });

  it('VolumeBrowseChmodRequest rejects unknown fields', () => {
    const isValidChmod = (p) => valid(S.VolumeBrowseChmodRequest, p);
    expect(isValidChmod({ path: '/foo', mode: '0644', sneaky: 1 })).toBe(false);
  });

  it('VolumeBrowseBulkChmodRequest accepts a typical multi-select payload', () => {
    expect(valid(S.VolumeBrowseBulkChmodRequest, {
      paths: ['/a.txt', '/b.txt', '/sub/c.txt'],
      mode: '0644',
    })).toBe(true);
    expect(valid(S.VolumeBrowseBulkChmodRequest, {
      paths: ['/a'], mode: '0755', recursive: true,
    })).toBe(true);
  });

  it('VolumeBrowseBulkChmodRequest rejects empty paths array', () => {
    expect(valid(S.VolumeBrowseBulkChmodRequest, { paths: [], mode: '0644' })).toBe(false);
  });

  it('VolumeBrowseBulkChmodRequest enforces maxItems', () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => `/f${i}`);
    expect(valid(S.VolumeBrowseBulkChmodRequest, { paths: tooMany, mode: '0644' })).toBe(false);
  });

  it('VolumeBrowseBulkChmodRequest rejects garbage mode', () => {
    expect(valid(S.VolumeBrowseBulkChmodRequest, {
      paths: ['/a'], mode: 'u+x',
    })).toBe(false);
  });

  it('VolumeBrowseBulkDeleteRequest accepts a typical payload', () => {
    expect(valid(S.VolumeBrowseBulkDeleteRequest, {
      paths: ['/a.txt', '/b.txt'],
    })).toBe(true);
  });

  it('VolumeBrowseBulkDeleteRequest rejects empty and over-large lists', () => {
    expect(valid(S.VolumeBrowseBulkDeleteRequest, { paths: [] })).toBe(false);
    const tooMany = Array.from({ length: 1001 }, (_, i) => `/f${i}`);
    expect(valid(S.VolumeBrowseBulkDeleteRequest, { paths: tooMany })).toBe(false);
  });

  it('VolumeBrowseBulkResponse has the expected shape', () => {
    expect(valid(S.VolumeBrowseBulkResponse, {
      succeeded: 2, failed: 1,
      results: [
        { path: '/a', ok: true },
        { path: '/b', ok: true },
        { path: '/c', ok: false, error: 'nope' },
      ],
    })).toBe(true);
  });

  // ---------- Chown ----------

  it('VolumeBrowseChownRequest accepts uid only / gid only / both', () => {
    const v = (p) => valid(S.VolumeBrowseChownRequest, p);
    expect(v({ path: '/a', uid: 0 })).toBe(true);
    expect(v({ path: '/a', gid: 0 })).toBe(true);
    expect(v({ path: '/a', uid: 1000, gid: 1000 })).toBe(true);
    expect(v({ path: '/a', uid: 1000, gid: 1000, recursive: true })).toBe(true);
    expect(v({ path: '/a', uid: -1, gid: 100 })).toBe(true);   // -1 = "leave unchanged"
  });

  it('VolumeBrowseChownRequest rejects negative ids other than -1', () => {
    const v = (p) => valid(S.VolumeBrowseChownRequest, p);
    expect(v({ path: '/a', uid: -2 })).toBe(false);
    expect(v({ path: '/a', gid: -100 })).toBe(false);
  });

  it('VolumeBrowseChownRequest rejects unknown fields + missing path', () => {
    const v = (p) => valid(S.VolumeBrowseChownRequest, p);
    expect(v({ uid: 0 })).toBe(false);
    expect(v({ path: '/a', uid: 0, sneaky: 1 })).toBe(false);
  });

  it('VolumeBrowseBulkChownRequest accepts typical multi-select', () => {
    const v = (p) => valid(S.VolumeBrowseBulkChownRequest, p);
    expect(v({ paths: ['/a', '/b'], uid: 1000, gid: 1000 })).toBe(true);
    expect(v({ paths: ['/a'], gid: 100, recursive: true })).toBe(true);
  });

  it('VolumeBrowseBulkChownRequest enforces minItems + maxItems', () => {
    const v = (p) => valid(S.VolumeBrowseBulkChownRequest, p);
    expect(v({ paths: [], uid: 0 })).toBe(false);
    const tooMany = Array.from({ length: 1001 }, (_, i) => `/f${i}`);
    expect(v({ paths: tooMany, uid: 0 })).toBe(false);
  });

  // ---------- Save (editor) ----------

  it('VolumeBrowseSaveRequest accepts content alone', () => {
    expect(valid(S.VolumeBrowseSaveRequest, { content: 'hello\nworld\n' })).toBe(true);
  });

  it('VolumeBrowseSaveRequest accepts if_mtime + mode', () => {
    expect(valid(S.VolumeBrowseSaveRequest, {
      content: '', if_mtime: 1700000000.123, mode: '0644',
    })).toBe(true);
  });

  it('VolumeBrowseSaveRequest requires content', () => {
    expect(valid(S.VolumeBrowseSaveRequest, { if_mtime: 1 })).toBe(false);
  });

  it('VolumeBrowseSaveRequest rejects garbage mode', () => {
    expect(valid(S.VolumeBrowseSaveRequest, { content: '', mode: 'u+x' })).toBe(false);
  });

  it('VolumeBrowseSaveResponse has the expected shape', () => {
    expect(valid(S.VolumeBrowseSaveResponse, {
      saved: true, path: '/foo.txt', size: 42, mtime: 1781040000.5,
    })).toBe(true);
  });

  // ---------- Tier 1 / 2 enrichment ----------

  it('VolumeSummary accepts the enriched shape with empty usage / null size', () => {
    expect(valid(S.VolumeSummary, {
      name: 'v1', driver: 'local', mountpoint: '/p', scope: 'local',
      labels: {}, options: {},
      in_use: false, used_by: [],
    })).toBe(true);
  });

  it('VolumeSummary accepts populated stack + used_by with mixed rw/ro mounts + size', () => {
    expect(valid(S.VolumeSummary, {
      name: 'v1', driver: 'local', mountpoint: '/p', scope: 'local',
      created_at: '2026-06-10T10:00:00Z',
      labels: { 'com.docker.compose.project': 'demo' },
      options: {},
      stack: 'demo',
      in_use: true,
      used_by: [
        { container_id: 'abc', container_name: 'demo-web-1', mount_path: '/v', rw: true },
        { container_id: 'def', container_name: 'demo-backup-1', mount_path: '/src', rw: false },
      ],
      size_bytes: 12345,
    })).toBe(true);
  });

  it('VolumeSummary rejects used_by entries missing the rw mode', () => {
    // (VolumeUsage is registered as part of VolumeSummary; we exercise
    // its constraints through the parent rather than re-registering.)
    expect(valid(S.VolumeSummary, {
      name: 'v', driver: 'local', mountpoint: '/p', scope: 'local',
      labels: {}, options: {}, in_use: true,
      used_by: [{ container_id: 'x', container_name: 'y', mount_path: '/z' /* missing rw */ }],
    })).toBe(false);
  });

  // #10: VolumeDetail = VolumeSummary fields + raw payload.
  it('VolumeDetail requires both the summary shape AND a raw field', () => {
    const summary = {
      name: 'v', driver: 'local', mountpoint: '/p', scope: 'local',
      labels: {}, options: {}, in_use: false, used_by: [],
    };
    expect(valid(S.VolumeDetail, { ...summary, raw: { Name: 'v', Driver: 'local' } })).toBe(true);
    expect(valid(S.VolumeDetail, summary)).toBe(false); // missing raw
  });

  // #19: list query schema accepts the new sort params with enum bounds.
  it('VolumeBrowseListQuery accepts sort/order/dirs_first', () => {
    const q = (p) => valid(S.VolumeBrowseListQuery, p);
    expect(q({})).toBe(true);
    expect(q({ path: '/', limit: 100, offset: 0, sort: 'name', order: 'asc' })).toBe(true);
    expect(q({ sort: 'size', order: 'desc' })).toBe(true);
    expect(q({ sort: 'mtime', order: 'asc', dirs_first: false })).toBe(true);
    expect(q({ sort: 'bogus' })).toBe(false);
    expect(q({ order: 'sideways' })).toBe(false);
  });

  it('VolumeBulkDeleteRequest enforces min/max items', () => {
    expect(valid(S.VolumeBulkDeleteRequest, { names: ['a'] })).toBe(true);
    expect(valid(S.VolumeBulkDeleteRequest, { names: ['a', 'b'], force: true })).toBe(true);
    expect(valid(S.VolumeBulkDeleteRequest, { names: [] })).toBe(false);
    const tooMany = Array.from({ length: 1001 }, (_, i) => `v${i}`);
    expect(valid(S.VolumeBulkDeleteRequest, { names: tooMany })).toBe(false);
  });

  // #31: CreateVolumeRequest validation (was untested).
  it('CreateVolumeRequest accepts a minimal payload', () => {
    expect(valid(S.CreateVolumeRequest, { name: 'my-vol' })).toBe(true);
  });

  it('CreateVolumeRequest accepts all fields', () => {
    expect(valid(S.CreateVolumeRequest, {
      name: 'vol-1', driver: 'local',
      labels: { 'com.example.tier': 'prod' },
      driver_opts: { type: 'nfs', o: 'addr=1.2.3.4,rw', device: ':/exports/data' },
    })).toBe(true);
  });

  it('CreateVolumeRequest rejects names that do not match the regex', () => {
    expect(valid(S.CreateVolumeRequest, { name: '' })).toBe(false);
    expect(valid(S.CreateVolumeRequest, { name: '-leading-dash' })).toBe(false);
    expect(valid(S.CreateVolumeRequest, { name: 'has space' })).toBe(false);
    expect(valid(S.CreateVolumeRequest, { name: 'has/slash' })).toBe(false);
    expect(valid(S.CreateVolumeRequest, { name: 'has:colon' })).toBe(false);
    expect(valid(S.CreateVolumeRequest, { name: 'has\\backslash' })).toBe(false);
  });

  it('CreateVolumeRequest accepts the underscore / hyphen / dot triplet', () => {
    expect(valid(S.CreateVolumeRequest, { name: 'a_b-c.d' })).toBe(true);
    expect(valid(S.CreateVolumeRequest, { name: '1starts-with-digit' })).toBe(true);
  });

  it('CreateVolumeRequest enforces 255-char name limit', () => {
    expect(valid(S.CreateVolumeRequest, { name: 'a'.repeat(255) })).toBe(true);
    expect(valid(S.CreateVolumeRequest, { name: 'a'.repeat(256) })).toBe(false);
  });

  it('CreateVolumeRequest enforces 64-char driver limit', () => {
    expect(valid(S.CreateVolumeRequest, { name: 'v', driver: 'a'.repeat(64) })).toBe(true);
    expect(valid(S.CreateVolumeRequest, { name: 'v', driver: 'a'.repeat(65) })).toBe(false);
  });

  it('CreateVolumeRequest rejects non-string label values', () => {
    expect(valid(S.CreateVolumeRequest, {
      name: 'v', labels: { ok: 'fine', bad: 42 },
    })).toBe(false);
  });

  it('CreateVolumeRequest rejects unknown top-level fields', () => {
    expect(valid(S.CreateVolumeRequest, {
      name: 'v', sneaky: 'value',
    })).toBe(false);
  });

  it('VolumeBulkResponse has the expected shape', () => {
    expect(valid(S.VolumeBulkResponse, {
      succeeded: 2, failed: 1,
      results: [
        { name: 'v1', ok: true },
        { name: 'v2', ok: true },
        { name: 'v3', ok: false, error: 'in use' },
      ],
    })).toBe(true);
  });

  // #20: combined Permissions schemas.
  it('VolumeBrowsePermissionsRequest accepts mode only, chown only, and both', () => {
    const v = (p) => valid(S.VolumeBrowsePermissionsRequest, p);
    expect(v({ path: '/a', mode: '0644' })).toBe(true);
    expect(v({ path: '/a', uid: 1000 })).toBe(true);
    expect(v({ path: '/a', gid: 1000 })).toBe(true);
    expect(v({ path: '/a', uid: 1000, gid: 1000 })).toBe(true);
    expect(v({ path: '/a', mode: '0755', uid: 0, gid: 0, recursive: true })).toBe(true);
    expect(v({ path: '/a', uid: -1, gid: 100 })).toBe(true);
  });

  it('VolumeBrowsePermissionsRequest rejects unknown / malformed fields', () => {
    const v = (p) => valid(S.VolumeBrowsePermissionsRequest, p);
    expect(v({ path: '/a', mode: 'u+x' })).toBe(false);
    expect(v({ path: '/a', uid: -2 })).toBe(false);
    expect(v({ path: '/a', mode: '0644', sneaky: 1 })).toBe(false);
  });

  it('VolumeBrowseBulkPermissionsRequest enforces minItems + maxItems', () => {
    const v = (p) => valid(S.VolumeBrowseBulkPermissionsRequest, p);
    expect(v({ paths: ['/a'], mode: '0644' })).toBe(true);
    expect(v({ paths: [], mode: '0644' })).toBe(false);
    const tooMany = Array.from({ length: 501 }, (_, i) => `/f${i}`);
    expect(v({ paths: tooMany, mode: '0644' })).toBe(false);
  });
});

describe('CreateContainerRequest mem fields (M4)', () => {
  function isValid(payload) {
    return valid(S.CreateContainerRequest, { image: 'nginx', ...payload });
  }

  it('accepts canonical sizes', () => {
    expect(isValid({ mem_limit: '512m' })).toBe(true);
    expect(isValid({ mem_limit: '1.5g' })).toBe(true);
    expect(isValid({ mem_limit: '2G' })).toBe(true);
    expect(isValid({ mem_limit: '64' })).toBe(true);
    expect(isValid({ mem_limit: 67108864 })).toBe(true);
  });

  it('rejects garbage in mem_limit', () => {
    expect(isValid({ mem_limit: 'oops' })).toBe(false);
    expect(isValid({ mem_limit: '5x' })).toBe(false);
    expect(isValid({ mem_limit: '$(rm -rf)' })).toBe(false);
  });

  it('memswap_limit accepts -1 for "unlimited"', () => {
    expect(isValid({ memswap_limit: -1 })).toBe(true);
    expect(isValid({ memswap_limit: '256m' })).toBe(true);
  });

  it('shm_size validates the same pattern', () => {
    expect(isValid({ shm_size: '64m' })).toBe(true);
    expect(isValid({ shm_size: 'lol' })).toBe(false);
  });
});

// ---------- Bulk action plumbing (shared shapes + per-resource) ----------
describe('Bulk action schemas', () => {
  it('BulkIdsRequest enforces minItems 1 and maxItems 500', () => {
    const v = (p) => valid(S.BulkIdsRequest, p);
    expect(v({ ids: ['one'] })).toBe(true);
    expect(v({ ids: [] })).toBe(false);
    expect(v({ ids: Array(501).fill('x') })).toBe(false);
    expect(v({})).toBe(false);
    expect(v({ ids: ['a'], sneaky: 1 })).toBe(false);
  });

  it('BulkNamesRequest mirrors BulkIdsRequest with a different field', () => {
    const v = (p) => valid(S.BulkNamesRequest, p);
    expect(v({ names: ['one'] })).toBe(true);
    expect(v({ names: [] })).toBe(false);
  });

  it('BulkResult accepts either id or name', () => {
    const v = (p) => valid(S.BulkResult, p);
    expect(v({ id: 'cid', ok: true })).toBe(true);
    expect(v({ name: 'my-stack', ok: false, error: 'oops' })).toBe(true);
    // additionalProperties:false rejects extras
    expect(v({ id: 'cid', ok: true, surprise: 1 })).toBe(false);
  });

  it('BulkResponse summary shape', () => {
    const v = (p) => valid(S.BulkResponse, p);
    expect(v({ succeeded: 2, failed: 0, results: [{ id: 'a', ok: true }, { id: 'b', ok: true }] })).toBe(true);
    expect(v({ succeeded: 0, failed: 1, results: [{ id: 'a', ok: false, error: 'x' }] })).toBe(true);
    expect(v({ succeeded: 1, failed: 0 })).toBe(false); // missing results
  });

  // ---- Containers ----
  it('ContainerBulkStopRequest: ids required + optional bounded timeout', () => {
    const v = (p) => valid(S.ContainerBulkStopRequest, p);
    expect(v({ ids: ['c1'] })).toBe(true);
    expect(v({ ids: ['c1'], timeout: 10 })).toBe(true);
    expect(v({ ids: ['c1'], timeout: 0 })).toBe(true);
    expect(v({ ids: ['c1'], timeout: 600 })).toBe(true);
    expect(v({ ids: ['c1'], timeout: 601 })).toBe(false);
    expect(v({ ids: ['c1'], timeout: -1 })).toBe(false);
    expect(v({ ids: ['c1'], timeout: 'soon' })).toBe(false);
  });

  it('ContainerBulkRemoveRequest: force + volumes optional booleans', () => {
    const v = (p) => valid(S.ContainerBulkRemoveRequest, p);
    expect(v({ ids: ['c1'] })).toBe(true);
    expect(v({ ids: ['c1'], force: true, volumes: false })).toBe(true);
    expect(v({ ids: ['c1'], force: 'yes' })).toBe(false);
    expect(v({ ids: ['c1'], surprise: 1 })).toBe(false);
  });

  // ---- Images ----
  it('ImageBulkRemoveRequest: long refs accepted up to 512 chars; force + noprune optional', () => {
    const v = (p) => valid(S.ImageBulkRemoveRequest, p);
    expect(v({ ids: ['nginx:1.27'] })).toBe(true);
    expect(v({ ids: ['nginx:1.27'], force: true, noprune: true })).toBe(true);
    // 512-char ref accepted (sha256:<64 hex> + tag etc.)
    expect(v({ ids: ['a'.repeat(512)] })).toBe(true);
    expect(v({ ids: ['a'.repeat(513)] })).toBe(false);
  });

  // ---- Stacks ----
  it('StackBulkRequest: names + optional volumes; name length cap 63 (compose project naming)', () => {
    const v = (p) => valid(S.StackBulkRequest, p);
    expect(v({ names: ['my-app'] })).toBe(true);
    expect(v({ names: ['my-app'], volumes: true })).toBe(true);
    expect(v({ names: ['a'.repeat(63)] })).toBe(true);
    expect(v({ names: ['a'.repeat(64)] })).toBe(false);
    expect(v({ names: [] })).toBe(false);
  });

  // ---- Registries ----
  it('RegistryBulkDeleteRequest = BulkNamesRequest', () => {
    expect(valid(S.RegistryBulkDeleteRequest, { names: ['ghcr-prod'] })).toBe(true);
    expect(valid(S.RegistryBulkDeleteRequest, { names: [] })).toBe(false);
  });
});

// ---------- Networks (Portainer-parity) ----------

describe('Network schemas', () => {
  it('CreateNetworkRequest accepts a minimal payload', () => {
    expect(valid(S.CreateNetworkRequest, { name: 'my-net' })).toBe(true);
  });

  it('CreateNetworkRequest accepts a full payload (driver + IPAM + opts + labels)', () => {
    expect(valid(S.CreateNetworkRequest, {
      name: 'tier-1',
      driver: 'macvlan',
      internal: true,
      attachable: false,
      enable_ipv6: true,
      driver_opts: { parent: 'eth0' },
      ipam: {
        driver: 'default',
        options: { foo: 'bar' },
        config: [
          { subnet: '172.20.0.0/16', gateway: '172.20.0.1', ip_range: '172.20.10.0/24',
            aux_addresses: { router: '172.20.0.1' } },
          { subnet: '2001:db8::/64', gateway: '2001:db8::1' },
        ],
      },
      labels: { owner: 'team-a' },
    })).toBe(true);
  });

  it('CreateNetworkRequest rejects bad names', () => {
    expect(valid(S.CreateNetworkRequest, { name: '' })).toBe(false);
    expect(valid(S.CreateNetworkRequest, { name: '-leading-dash' })).toBe(false);
    expect(valid(S.CreateNetworkRequest, { name: 'has space' })).toBe(false);
    expect(valid(S.CreateNetworkRequest, { name: 'has/slash' })).toBe(false);
    expect(valid(S.CreateNetworkRequest, { name: 'a'.repeat(256) })).toBe(false);
  });

  it('CreateNetworkRequest enforces additionalProperties: false', () => {
    expect(valid(S.CreateNetworkRequest, { name: 'n', sneaky: 1 })).toBe(false);
  });

  it('CreateNetworkRequest enforces IPAM config maxItems', () => {
    expect(valid(S.CreateNetworkRequest, {
      name: 'n',
      ipam: { config: Array.from({ length: 17 }, () => ({ subnet: '10.0.0.0/24' })) },
    })).toBe(false);
  });

  it('ConnectRequest accepts a MAC address', () => {
    expect(valid(S.ConnectRequest, { container: 'cid', mac_address: '02:42:ac:11:00:02' })).toBe(true);
    expect(valid(S.ConnectRequest, { container: 'cid', mac_address: '02-42-AC-11-00-02' })).toBe(true);
  });

  it('ConnectRequest rejects malformed MAC addresses', () => {
    expect(valid(S.ConnectRequest, { container: 'cid', mac_address: 'not-a-mac' })).toBe(false);
    expect(valid(S.ConnectRequest, { container: 'cid', mac_address: '02:42:ac:11:00' })).toBe(false);
    expect(valid(S.ConnectRequest, { container: 'cid', mac_address: '02:42:ac:11:00:zz' })).toBe(false);
  });

  it('ConnectRequest accepts full payload (aliases, IPv4/6, links, driver_opts)', () => {
    expect(valid(S.ConnectRequest, {
      container: 'cid',
      aliases: ['db', 'primary'],
      ipv4_address: '172.20.0.10',
      ipv6_address: '2001:db8::10',
      mac_address: '02:42:ac:11:00:02',
      links: ['cache:redis'],
      driver_opts: { foo: 'bar' },
    })).toBe(true);
  });

  it('DisconnectRequest defaults force to false', () => {
    expect(valid(S.DisconnectRequest, { container: 'cid' })).toBe(true);
    expect(valid(S.DisconnectRequest, { container: 'cid', force: true })).toBe(true);
  });

  it('NetworkSummary requires the new enriched fields', () => {
    const ok = {
      id: 'abc', short_id: 'abc',
      name: 'n', driver: 'bridge', scope: 'local',
      internal: false, attachable: true, enable_ipv6: false,
      stack: null, system: false, ipam_driver: 'default',
      subnets: [], gateways: [], in_use: false, containers_count: 0, used_by: [],
      labels: {},
    };
    expect(valid(S.NetworkSummary, ok)).toBe(true);
    // Drop a required field — should fail.
    const bad = { ...ok }; delete bad.system;
    expect(valid(S.NetworkSummary, bad)).toBe(false);
    // additionalProperties: false rejects extras.
    expect(valid(S.NetworkSummary, { ...ok, surprise: 1 })).toBe(false);
  });

  it('NetworkSummary rejects used_by entries missing fields', () => {
    const base = {
      id: 'abc', short_id: 'abc', name: 'n', driver: 'bridge', scope: 'local',
      internal: false, attachable: true, enable_ipv6: false,
      stack: null, system: false, ipam_driver: 'default',
      subnets: [], gateways: [], in_use: true, containers_count: 1, labels: {},
    };
    // Missing container_name + aliases on the usage entry.
    expect(valid(S.NetworkSummary, {
      ...base, used_by: [{ container_id: 'cid' }],
    })).toBe(false);
    expect(valid(S.NetworkSummary, {
      ...base,
      used_by: [{
        container_id: 'cid', container_name: 'web-1',
        ipv4: '172.20.0.2', ipv6: null, mac: '02:42:ac:11:00:02', aliases: ['web'],
      }],
    })).toBe(true);
  });

  it('NetworkDetail = NetworkSummary fields + ipam/options/raw', () => {
    const summary = {
      id: 'abc', short_id: 'abc', name: 'n', driver: 'bridge', scope: 'local',
      internal: false, attachable: true, enable_ipv6: false,
      stack: null, system: false, ipam_driver: 'default',
      subnets: [], gateways: [], in_use: false, containers_count: 0, used_by: [],
      labels: {},
    };
    expect(valid(S.NetworkDetail, { ...summary, ipam: { driver: 'default' }, options: {}, raw: { Name: 'n' } })).toBe(true);
    expect(valid(S.NetworkDetail, summary)).toBe(false); // missing ipam/options/raw
  });

  it('NetworkBulkDeleteRequest enforces minItems / maxItems', () => {
    expect(valid(S.NetworkBulkDeleteRequest, { ids: ['a'] })).toBe(true);
    expect(valid(S.NetworkBulkDeleteRequest, { ids: [] })).toBe(false);
    expect(valid(S.NetworkBulkDeleteRequest, {
      ids: Array.from({ length: 501 }, (_, i) => `n${i}`),
    })).toBe(false);
  });
});
