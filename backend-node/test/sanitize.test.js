// dockerError sanitization (M1).
import { describe, it, expect } from 'vitest';
import { sanitizeDaemonMessage, dockerError } from '../src/docker-client.js';

describe('sanitizeDaemonMessage', () => {
  it('redacts absolute filesystem paths', () => {
    const out = sanitizeDaemonMessage(
      'failed to mount /var/lib/docker/overlay2/abcdef1234567890/diff: invalid argument',
    );
    expect(out).toContain('<path>');
    expect(out).not.toContain('/var/lib/docker');
  });

  it('redacts long hex hashes', () => {
    const out = sanitizeDaemonMessage(
      'no such image: 0123456789abcdef0123456789abcdef',
    );
    expect(out).toContain('<hash>');
    expect(out).not.toContain('0123456789abcdef');
  });

  it('keeps short tokens (port numbers, exit codes) intact', () => {
    const out = sanitizeDaemonMessage('container exited with code 137 on port 8080');
    expect(out).toContain('137');
    expect(out).toContain('8080');
  });

  it('caps to ~1 KB so a runaway message cannot fill the response', () => {
    const out = sanitizeDaemonMessage('x'.repeat(5_000));
    expect(out.length).toBeLessThanOrEqual(1024);
  });

  it('passes through nullish input untouched', () => {
    expect(sanitizeDaemonMessage(null)).toBe(null);
    expect(sanitizeDaemonMessage(undefined)).toBe(undefined);
  });
});

describe('dockerError mapping', () => {
  it('maps ECONNREFUSED to 503 with sanitized message', () => {
    const r = dockerError({
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED /var/run/docker.sock',
    });
    expect(r.status).toBe(503);
    expect(r.detail).toContain('<path>');
  });

  it('maps a 404 statusCode to 404', () => {
    const r = dockerError({ statusCode: 404, json: { message: 'no such image: foo' } });
    expect(r.status).toBe(404);
    expect(r.detail).toBe('no such image: foo');
  });

  it('maps a 500 statusCode to 502 (the daemon failed, we re-package as bad gateway)', () => {
    const r = dockerError({ statusCode: 500, message: 'something broke' });
    expect(r.status).toBe(502);
    expect(r.detail).toContain('something broke');
  });
});
