// Unit tests for the pure helpers in routes/volume-browser.js (no daemon).
// We can't unit-test runOnce / withScratchContainer without a live docker
// daemon, but we can fully cover the URL-level path safety + the JSON
// envelope parser, which are the two places we'd most regret a regression.
import { describe, it, expect, vi } from 'vitest';

// Stub the heavy deps so the module loads cleanly under vitest.
vi.mock('../src/docker-client.js', () => ({
  getClient: () => ({}),
  dockerError: (e) => e,
}));

const { _internals } = await import('../src/routes/volume-browser.js');
const { safePath, parseScriptResult } = _internals;

describe('safePath (URL-level normalization)', () => {
  it("maps empty / '/' to /target", () => {
    expect(safePath('')).toBe('/target');
    expect(safePath('/')).toBe('/target');
  });

  it('joins relative paths under /target', () => {
    expect(safePath('foo')).toBe('/target/foo');
    expect(safePath('/foo/bar')).toBe('/target/foo/bar');
    expect(safePath('foo/./bar')).toBe('/target/foo/bar');
  });

  it('rejects classic traversal', () => {
    expect(() => safePath('../etc/passwd')).toThrow(/Invalid path/);
    expect(() => safePath('/../etc/passwd')).toThrow(/Invalid path/);
    expect(() => safePath('foo/../../etc')).toThrow(/Invalid path/);
  });

  it('rejects "/target" sibling escapes (target-foo)', () => {
    // /target/../target-foo would normalize outside of /target/
    expect(() => safePath('/../target-foo')).toThrow(/Invalid path/);
  });
});

describe('parseScriptResult (script JSON envelope)', () => {
  it('returns the parsed object on success', () => {
    expect(parseScriptResult({ stdout: '{"ok":true,"x":1}' }, 'op')).toEqual({ ok: true, x: 1 });
  });

  it('trims surrounding whitespace', () => {
    expect(parseScriptResult({ stdout: '  {"ok":true}\n' }, 'op')).toEqual({ ok: true });
  });

  it('throws HttpError(400) on { error } payload', () => {
    expect(() => parseScriptResult({ stdout: '{"error":"escapes the volume root"}' }, 'op'))
      .toThrow(/escapes the volume root/);
  });

  it('throws HttpError(500) on empty stdout', () => {
    expect(() => parseScriptResult({ stdout: '', stderr: '' }, 'list'))
      .toThrow(/list produced no output/);
  });

  it('includes stderr tail when stdout is empty', () => {
    expect(() => parseScriptResult({ stdout: '', stderr: 'segfault\n' }, 'chmod'))
      .toThrow(/segfault/);
  });

  it('throws HttpError(500) on malformed JSON', () => {
    expect(() => parseScriptResult({ stdout: 'not json' }, 'view'))
      .toThrow(/view returned malformed JSON/);
  });
});
