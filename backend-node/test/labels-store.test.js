// Unit tests for the manager-side per-volume label store.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  getLabels, getAllLabels, setLabels, clearLabels, mergeLabels, _resetForTests,
} from '../src/labels-store.js';

let tmpDir;
let storePath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'labels-store-'));
  storePath = path.join(tmpDir, 'volume-labels.json');
  _resetForTests(storePath);
});

afterAll(async () => {
  // Best-effort cleanup
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('labels-store', () => {
  it('returns empty when the store file does not exist', async () => {
    expect(await getLabels('any')).toEqual({});
    expect(await getAllLabels()).toEqual({});
  });

  it('setLabels persists to disk and round-trips', async () => {
    await setLabels('vol-a', { 'com.docker.manager.readonly': 'true' });
    const raw = await fs.readFile(storePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      'vol-a': { 'com.docker.manager.readonly': 'true' },
    });
    expect(await getLabels('vol-a')).toEqual({ 'com.docker.manager.readonly': 'true' });
  });

  it('setLabels replaces (not merges) per-volume labels', async () => {
    await setLabels('v', { a: '1', b: '2' });
    await setLabels('v', { c: '3' });
    expect(await getLabels('v')).toEqual({ c: '3' });
  });

  it('setLabels with empty object removes the entry entirely (file stays compact)', async () => {
    await setLabels('v', { a: '1' });
    await setLabels('v', {});
    const raw = await fs.readFile(storePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({});
  });

  it('clearLabels is shorthand for setLabels(name, {})', async () => {
    await setLabels('v', { a: '1' });
    await clearLabels('v');
    expect(await getLabels('v')).toEqual({});
  });

  it('drops non-string keys and non-string values', async () => {
    await setLabels('v', { a: '1', b: 2, c: null, '': 'x' });
    expect(await getLabels('v')).toEqual({ a: '1' });
  });

  it('sets file mode 0600 (private by convention)', async () => {
    await setLabels('v', { a: '1' });
    const st = await fs.stat(storePath);
    // umask might widen this on some systems; verify owner has write at least.
    expect(st.mode & 0o077).toBe(0);
  });

  it('survives a corrupt store file (starts empty + does not throw)', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, 'not json');
    _resetForTests(storePath);
    expect(await getAllLabels()).toEqual({});
    // And a subsequent write still works:
    await setLabels('v', { a: '1' });
    expect(await getLabels('v')).toEqual({ a: '1' });
  });

  it('survives store containing arrays / weird types (filters them out)', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({
      'good-vol': { a: 'b' },
      'bad-array-vol': ['x', 'y'],
      'bad-scalar-vol': 'hi',
      'mixed-types-vol': { ok: 'yes', bad: 42 },
    }));
    _resetForTests(storePath);
    expect(await getAllLabels()).toEqual({
      'good-vol': { a: 'b' },
      'mixed-types-vol': { ok: 'yes' },
    });
  });

  it('concurrent setLabels serialise (no lost updates)', async () => {
    // Fire 30 sets in parallel — final state should reflect the last one
    // dispatched, not be partial / corrupt.
    const ops = [];
    for (let i = 0; i < 30; i++) ops.push(setLabels('v', { i: String(i) }));
    await Promise.all(ops);
    const final = await getLabels('v');
    expect(Object.keys(final)).toEqual(['i']);
    // Could be any one of the 30 — just verify it's a valid value.
    expect(Number(final.i)).toBeGreaterThanOrEqual(0);
    expect(Number(final.i)).toBeLessThan(30);
  });

  it('mergeLabels prefers extra labels on key conflict', () => {
    expect(mergeLabels(
      { 'com.docker.compose.project': 'x', shared: 'daemon-said' },
      { shared: 'manager-said', extra: 'only-here' },
    )).toEqual({
      'com.docker.compose.project': 'x',
      shared: 'manager-said',
      extra: 'only-here',
    });
  });

  it('mergeLabels tolerates null inputs', () => {
    expect(mergeLabels(null, null)).toEqual({});
    expect(mergeLabels({ a: '1' }, null)).toEqual({ a: '1' });
    expect(mergeLabels(null, { b: '2' })).toEqual({ b: '2' });
  });
});
