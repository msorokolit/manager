// Unit test for the volume-browser idle-sidecar reaper. We stub the dockerode
// client and the settings module so the test doesn't need a live daemon and
// can mutate the TTL between cases — what we're actually checking is the
// bookkeeping: entries past the TTL get removed from lastAccess; fresh ones
// are preserved; a 404 from the daemon is swallowed; non-404 errors are
// logged but don't stop the sweep.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mutable settings stand-in for the real (Object.freeze'd) config.
const mockSettings = {
  volumeBrowserTtlMs: 60_000,
  browserImage: 'python:3-alpine',
  volumeBrowserReapIntervalMs: 60_000,
};
vi.mock('../src/config.js', () => ({
  settings: mockSettings,
  settingsFromEnv: () => mockSettings,
  VERSION: 'test',
}));

// Replace dockerode's getClient with a mock. dockerError just rethrows.
const removeMock = vi.fn();
const getContainerMock = vi.fn(() => ({ remove: removeMock }));
vi.mock('../src/docker-client.js', () => ({
  getClient: () => ({ getContainer: getContainerMock }),
  dockerError: (e) => e,
}));

const { _internals } = await import('../src/routes/volume-browser.js');

describe('volume-browser reaper', () => {
  beforeEach(() => {
    _internals.lastAccess.clear();
    removeMock.mockReset();
    removeMock.mockResolvedValue({});
    getContainerMock.mockClear();
    mockSettings.volumeBrowserTtlMs = 60_000;
  });

  it('does nothing when TTL is 0 (reaper disabled)', async () => {
    mockSettings.volumeBrowserTtlMs = 0;
    _internals.lastAccess.set('vol-a', 0); // ancient
    const removed = await _internals.reapOnce(Date.now());
    expect(removed).toBe(0);
    expect(_internals.lastAccess.has('vol-a')).toBe(true);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('removes idle sidecars and keeps fresh ones', async () => {
    const now = 1_000_000;
    _internals.lastAccess.set('idle-vol', now - 120_000); // 2 min old, TTL 60s
    _internals.lastAccess.set('fresh-vol', now - 10_000); // 10s old
    const removed = await _internals.reapOnce(now);
    expect(removed).toBe(1);
    expect(_internals.lastAccess.has('idle-vol')).toBe(false);
    expect(_internals.lastAccess.has('fresh-vol')).toBe(true);
    expect(getContainerMock).toHaveBeenCalledWith(_internals.browserName('idle-vol'));
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith({ force: true });
  });

  it('swallows 404 from the daemon (already gone) and still drops the entry', async () => {
    const now = 2_000_000;
    _internals.lastAccess.set('orphan', now - 120_000);
    removeMock.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { statusCode: 404 }),
    );
    const removed = await _internals.reapOnce(now);
    expect(removed).toBe(0); // 404 counted as "already gone", not removed
    expect(_internals.lastAccess.has('orphan')).toBe(false);
  });

  it('logs but continues past non-404 errors and still drops the entry', async () => {
    const now = 3_000_000;
    _internals.lastAccess.set('flaky', now - 120_000);
    _internals.lastAccess.set('other', now - 120_000);
    removeMock
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }))
      .mockResolvedValueOnce({});
    const logs = [];
    const removed = await _internals.reapOnce(now, (m) => logs.push(m));
    expect(removed).toBe(1);
    expect(_internals.lastAccess.has('flaky')).toBe(false);
    expect(_internals.lastAccess.has('other')).toBe(false);
    expect(logs.some((m) => m.includes('failed to remove'))).toBe(true);
  });
});
