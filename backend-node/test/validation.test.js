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
