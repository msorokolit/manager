// Per-user concurrent-session cap (SESSIONS_MAX_PER_USER). In its own
// file because the cap is read at module-load time from the frozen
// settings snapshot — we need to set the env var via vi.hoisted
// BEFORE any import runs.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || '/tmp';
  const suffix = `${process.pid}-cap-${Math.random().toString(36).slice(2)}`;
  process.env.SESSIONS_FILE = `${tmp.replace(/\/$/, '')}/sessions-cap-${suffix}.json`;
  process.env.SESSIONS_PERSIST_INTERVAL_MS = '999999'; // effectively disabled
  process.env.SESSIONS_MAX_PER_USER = '2';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sessions-cap';
  process.env.LOG_LEVEL = 'silent';
});

const {
  createSession, getSession, listSessions, _internals,
} = await import('../src/sessions.js');

beforeEach(() => {
  _internals.resetForTests();
});

describe('SESSIONS_MAX_PER_USER eviction', () => {
  it('caps a single user at the configured count, evicting oldest first', () => {
    const a = createSession({ user: 'alice', role: 'admin', ttlSeconds: 60 });
    const b = createSession({ user: 'alice', role: 'admin', ttlSeconds: 60 });
    const c = createSession({ user: 'alice', role: 'admin', ttlSeconds: 60 });

    // SESSIONS_MAX_PER_USER=2 → `a` (oldest) is evicted when `c` lands.
    expect(getSession(a.id)).toBeNull();
    expect(getSession(b.id)).toBeTruthy();
    expect(getSession(c.id)).toBeTruthy();
  });

  it('eviction is per-user, not global', () => {
    createSession({ user: 'alice', role: 'admin', ttlSeconds: 60 });
    createSession({ user: 'alice', role: 'admin', ttlSeconds: 60 });
    const bob = createSession({ user: 'bob', role: 'viewer', ttlSeconds: 60 });
    createSession({ user: 'alice', role: 'admin', ttlSeconds: 60 });
    // Bob is untouched even though Alice churns.
    expect(getSession(bob.id)).toBeTruthy();
    // Alice has 2 (the latest 2).
    expect(listSessions({ user: 'alice' })).toHaveLength(2);
  });
});
