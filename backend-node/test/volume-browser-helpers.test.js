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
const { safePath, parseScriptResult, errorStatusFor, contentDispositionFor } = _internals;

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

  // #32: additional edge cases the original test set didn't cover.
  it('collapses repeated slashes (trailing slash preserved by posix.normalize)', () => {
    // Posix `normalize` keeps a trailing slash if the input had one,
    // and "/" is the volume root which we already normalise to '/target'.
    expect(safePath('//foo//bar//')).toBe('/target/foo/bar/');
    expect(safePath('///')).toBe('/target');
  });

  it('passes through "." segments harmlessly', () => {
    expect(safePath('./foo/./bar/.')).toBe('/target/foo/bar');
  });

  it('accepts very long paths up to 4 KB (Linux PATH_MAX-ish)', () => {
    // 800 nested segments of 4 chars each = ~3.2KB. The schema caps
    // path length above us; this just confirms safePath itself doesn't
    // explode on long input.
    const deep = Array.from({ length: 800 }, (_, i) => `s${i}`).join('/');
    expect(safePath(deep)).toBe('/target/' + deep);
  });

  it('does NOT URL-decode (callers must hand us the decoded path)', () => {
    // The Express layer decodes the query string for us; safePath
    // should treat %2e%2e as literal characters, NOT as ".." — otherwise
    // an attacker could double-encode their way past us.
    expect(safePath('%2e%2e/secrets')).toBe('/target/%2e%2e/secrets');
  });

  it('treats backslash as a literal name component (Linux fs)', () => {
    expect(safePath('foo\\bar')).toBe('/target/foo\\bar');
  });

  it('rejects trailing-..-traversal even with many segments', () => {
    expect(() => safePath('a/b/c/d/../../../../../etc/passwd')).toThrow(/Invalid path/);
  });

  it('handles paths with embedded null bytes (rejects as part of safety check downstream)', () => {
    // safePath itself just normalises — NUL handling is the script's job.
    // What matters is that we don't crash, and the resulting path stays
    // under /target.
    const out = safePath('foo\0bar');
    expect(out.startsWith('/target/')).toBe(true);
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

describe('errorStatusFor (#12 — script error → HTTP status)', () => {
  it('maps "Not found" to 404', () => {
    expect(errorStatusFor('Not found')).toBe(404);
    expect(errorStatusFor('No such file or directory: /foo')).toBe(404);
    expect(errorStatusFor('Parent directory does not exist')).toBe(404);
  });

  it('maps "Destination already exists" to 409', () => {
    expect(errorStatusFor('Destination already exists')).toBe(409);
    expect(errorStatusFor('[Errno 17] File exists: /foo')).toBe(409);
  });

  it('maps safety / refusal errors to 400', () => {
    expect(errorStatusFor('Path escapes the volume root')).toBe(400);
    expect(errorStatusFor('Source escapes the volume root')).toBe(400);
    expect(errorStatusFor('Refusing to delete the volume root')).toBe(400);
    expect(errorStatusFor('Refusing to edit through a symlink')).toBe(400);
    expect(errorStatusFor('Not a regular file')).toBe(400);
    expect(errorStatusFor('Not a directory')).toBe(400);
  });

  it('falls back to 400 for unknown messages', () => {
    expect(errorStatusFor('something unexpected went wrong')).toBe(400);
    expect(errorStatusFor('')).toBe(400);
    expect(errorStatusFor(null)).toBe(400);
  });

  it('threads through parseScriptResult (status comes from err.status)', () => {
    let captured = null;
    try { parseScriptResult({ stdout: '{"error":"Not found"}' }, 'view'); }
    catch (e) { captured = e; }
    expect(captured.status).toBe(404);

    try { parseScriptResult({ stdout: '{"error":"Destination already exists"}' }, 'rename'); }
    catch (e) { captured = e; }
    expect(captured.status).toBe(409);
  });
});

describe('contentDispositionFor (#19 — RFC 5987 safe filename encoding)', () => {
  it('emits both filename= and filename*= for plain ASCII', () => {
    const h = contentDispositionFor('hello.txt');
    expect(h).toMatch(/^attachment; filename="hello\.txt"; filename\*=UTF-8''hello\.txt$/);
  });

  it('strips backslashes (path separators) and escapes quotes in the legacy filename', () => {
    // Backslash is a path separator on Windows and a quoting char in
    // header values — we replace it with _ during sanitisation so it
    // can't reach either filename slot. Quotes that survive are escaped.
    const h = contentDispositionFor('weird"name\\.txt');
    expect(h).toContain('filename="weird\\"name_.txt"');
  });

  it('strips control chars + slashes from both forms', () => {
    const h = contentDispositionFor('a/b\\c\x00\x1fd.txt');
    expect(h).toContain('filename="a_b_c__d.txt"');
    expect(h).toContain("filename*=UTF-8''a_b_c__d.txt");
  });

  it('percent-encodes UTF-8 for filename*=', () => {
    const h = contentDispositionFor('résumé.pdf');
    expect(h).toMatch(/filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
    // Legacy form has UTF-8 chars replaced with _
    expect(h).toMatch(/filename="r_sum_\.pdf"/);
  });

  it('truncates absurdly long names', () => {
    const long = 'a'.repeat(2000) + '.txt';
    const h = contentDispositionFor(long);
    // 240-char cap from contentDispositionFor — well under most header
    // length limits.
    expect(h.length).toBeLessThan(1200);
  });

  it('falls back to "download" for null/empty', () => {
    expect(contentDispositionFor('')).toMatch(/filename="download"/);
    expect(contentDispositionFor(null)).toMatch(/filename="download"/);
    expect(contentDispositionFor(undefined)).toMatch(/filename="download"/);
  });
});
