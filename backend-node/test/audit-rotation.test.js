// Audit log rotation — split out from audit.test.js because rotation
// requires the AUDIT_MAX_BYTES env var to be set BEFORE config.js
// loads, and the main audit suite needs rotation disabled to keep
// per-test entry counts deterministic.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

const { AUDIT_TMP_FILE } = vi.hoisted(() => {
  const tmp = process.env.TMPDIR || '/tmp';
  const suffix = `${process.pid}-rot-${Math.random().toString(36).slice(2)}`;
  const file = `${tmp.replace(/\/$/, '')}/audit-rotate-${suffix}.log`;
  process.env.AUDIT_FILE = file;
  process.env.AUDIT_ENABLED = 'true';
  process.env.AUDIT_MAX_BYTES = '500';   // small cap so we trigger rotation fast
  process.env.AUDIT_ROTATE_KEEP = '2';   // current + 1 rotated; 2nd rotation drops the oldest
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-audit-rot';
  process.env.LOG_LEVEL = 'silent';
  return { AUDIT_TMP_FILE: file };
});

const auditMod = await import('../src/audit.js');
const { audit, _internals } = auditMod;

beforeEach(async () => {
  await _internals.drainForTests();
  for (const f of [AUDIT_TMP_FILE, ...Array.from({ length: 10 }, (_, i) => `${AUDIT_TMP_FILE}.${i + 1}`)]) {
    await fs.rm(f, { force: true });
  }
  _internals.resetCacheForTests();
});
afterAll(async () => {
  for (const f of [AUDIT_TMP_FILE, ...Array.from({ length: 10 }, (_, i) => `${AUDIT_TMP_FILE}.${i + 1}`)]) {
    await fs.rm(f, { force: true });
  }
});

describe('audit log rotation', () => {
  it('rotates the live file when AUDIT_MAX_BYTES is reached', async () => {
    // ~250-byte payload per entry × several entries pushes past 500.
    for (let i = 0; i < 8; i++) {
      await audit({ action: 'test.rot', i, payload: 'x'.repeat(150) });
    }
    await _internals.drainForTests();
    expect(existsSync(AUDIT_TMP_FILE)).toBe(true);
    expect(existsSync(`${AUDIT_TMP_FILE}.1`)).toBe(true);
  });

  it('honours AUDIT_ROTATE_KEEP — older rotations are dropped', async () => {
    // Force many rotations.
    for (let i = 0; i < 30; i++) {
      await audit({ action: 'test.deep', i, payload: 'x'.repeat(150) });
    }
    await _internals.drainForTests();
    // KEEP=2 → audit.log (current) + audit.log.1; .2 and beyond must
    // never exist.
    expect(existsSync(AUDIT_TMP_FILE)).toBe(true);
    expect(existsSync(`${AUDIT_TMP_FILE}.2`)).toBe(false);
    expect(existsSync(`${AUDIT_TMP_FILE}.3`)).toBe(false);
  });

  it('the live file never exceeds 2× the cap (rotation happens before runaway growth)', async () => {
    for (let i = 0; i < 50; i++) {
      await audit({ action: 'test.cap', i, payload: 'x'.repeat(120) });
    }
    await _internals.drainForTests();
    const live = await fs.stat(AUDIT_TMP_FILE).then((s) => s.size);
    expect(live).toBeLessThan(500 * 2);
  });
});
