// parseCompose: pre-write YAML validation for the stack create / update
// endpoints. Catches syntax / shape errors at the API boundary so we
// never persist an unparseable docker-compose.yml on disk.
import { describe, it, expect, vi } from 'vitest';

// Mock the heavy deps so the module loads cleanly under vitest.
vi.mock('../src/docker-client.js', () => ({
  getClient: () => ({}),
  dockerError: (e) => e,
}));

const { _internals } = await import('../src/routes/stacks.js');
const { parseCompose } = _internals;

describe('parseCompose', () => {
  it('accepts a minimal valid compose document', () => {
    expect(parseCompose('services:\n  web:\n    image: nginx:alpine\n')).toMatchObject({
      services: { web: { image: 'nginx:alpine' } },
    });
  });

  it('accepts a multi-service compose with ports + depends_on', () => {
    const doc = parseCompose(`services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
    depends_on:
      - cache
  cache:
    image: redis:alpine
`);
    expect(Object.keys(doc.services)).toEqual(['web', 'cache']);
  });

  it('accepts a top-level volumes-only document', () => {
    expect(parseCompose('volumes:\n  data: {}\n')).toMatchObject({ volumes: { data: {} } });
  });

  it('accepts compose with custom x-* extension keys', () => {
    expect(() => parseCompose('x-shared-env: &x\n  TZ: UTC\nservices:\n  a:\n    image: foo\n')).not.toThrow();
  });

  it('rejects empty / whitespace-only input', () => {
    expect(() => parseCompose('')).toThrow(/body is empty/);
    expect(() => parseCompose('   \n  \n')).toThrow(/body is empty/);
  });

  it('rejects malformed YAML and surfaces line/column', () => {
    let err;
    try { parseCompose('services:\n  web:\n    image: nginx\n   bad-indent: oops\n'); }
    catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message).toMatch(/YAML parse error/);
    expect(err.status).toBe(400);
  });

  it('rejects unterminated string', () => {
    expect(() => parseCompose('services:\n  web:\n    image: "unterminated\n')).toThrow(/YAML parse error/);
  });

  it('rejects an array at the root', () => {
    expect(() => parseCompose('- one\n- two\n')).toThrow(/root must be a mapping/);
  });

  it('rejects a scalar at the root', () => {
    expect(() => parseCompose('just-a-string\n')).toThrow(/root must be a mapping/);
  });

  it('rejects a document with no recognised top-level keys', () => {
    expect(() => parseCompose('random:\n  thing: 1\nother:\n  bits: 2\n')).toThrow(
      /no recognised top-level keys/,
    );
  });

  it('accepts a document whose ONLY recognised key is "version"', () => {
    // Old-style compose files just specify a version + services
    expect(() => parseCompose('version: "3.9"\nservices:\n  a:\n    image: foo\n')).not.toThrow();
  });

  it('does not execute YAML !!js/function tags (no code execution)', () => {
    // CORE_SCHEMA disables FAILSAFE/JS tags; an attacker can't sneak in
    // function tags hoping to trigger a custom constructor.
    expect(() => parseCompose('services:\n  a:\n    image: !!js/function foo\n')).toThrow();
  });

  it('attached HttpError carries status=400', () => {
    let err;
    try { parseCompose('[]'); } catch (e) { err = e; }
    expect(err.status).toBe(400);
  });
});
