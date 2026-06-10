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
        is_binary: true,
        truncated: false,
      }),
    ).toBe(true);
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
      read_only: false,
    })).toBe(true);
  });

  it('VolumeSummary accepts populated stack + used_by + size + read_only', () => {
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
      read_only: true,
    })).toBe(true);
  });

  it('VolumeSummary rejects used_by entries missing fields', () => {
    // (VolumeUsage is registered as part of VolumeSummary; we exercise
    // its constraints through the parent rather than re-registering.)
    expect(valid(S.VolumeSummary, {
      name: 'v', driver: 'local', mountpoint: '/p', scope: 'local',
      labels: {}, options: {}, in_use: true, read_only: false,
      used_by: [{ container_id: 'x', container_name: 'y', mount_path: '/z' /* missing rw */ }],
    })).toBe(false);
  });

  it('VolumeBulkDeleteRequest enforces min/max items', () => {
    expect(valid(S.VolumeBulkDeleteRequest, { names: ['a'] })).toBe(true);
    expect(valid(S.VolumeBulkDeleteRequest, { names: ['a', 'b'], force: true })).toBe(true);
    expect(valid(S.VolumeBulkDeleteRequest, { names: [] })).toBe(false);
    const tooMany = Array.from({ length: 1001 }, (_, i) => `v${i}`);
    expect(valid(S.VolumeBulkDeleteRequest, { names: tooMany })).toBe(false);
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
