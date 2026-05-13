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
