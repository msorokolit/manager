// WebSocket origin policy: defence-in-depth against Cross-Site WebSocket
// Hijacking. The handshake is also gated by a one-shot ticket, so this
// is a second layer — but the cost is one header check and it removes
// "any page can open an exec WS to our server" from the threat model.
import { describe, it, expect } from 'vitest';
import { isAllowedWsOrigin } from '../src/ws-origin.js';

function fakeReq({ origin, host = 'manager.example.com:8080', encrypted = false, xfProto } = {}) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (host !== undefined) headers.host = host;
  if (xfProto !== undefined) headers['x-forwarded-proto'] = xfProto;
  return { headers, socket: { encrypted } };
}

describe('isAllowedWsOrigin', () => {
  it('allows when no Origin header (non-browser clients: curl, wscat)', () => {
    expect(isAllowedWsOrigin(fakeReq({ origin: undefined }), [])).toBe(true);
  });

  it('allows same-origin over HTTP', () => {
    expect(isAllowedWsOrigin(fakeReq({ origin: 'http://manager.example.com:8080' }), [])).toBe(true);
  });

  it('allows same-origin over HTTPS (req.socket.encrypted=true)', () => {
    expect(isAllowedWsOrigin(
      fakeReq({ origin: 'https://manager.example.com:8080', encrypted: true }),
      [],
    )).toBe(true);
  });

  it('respects X-Forwarded-Proto when set (TLS-terminating proxy in front)', () => {
    // Inner connection is plain HTTP from the proxy → us, but the user
    // sees https://. Origin reflects what the user sees.
    expect(isAllowedWsOrigin(
      fakeReq({ origin: 'https://manager.example.com:8080', xfProto: 'https' }),
      [],
    )).toBe(true);
  });

  it('handles X-Forwarded-Proto with multiple hops (takes first)', () => {
    expect(isAllowedWsOrigin(
      fakeReq({ origin: 'https://manager.example.com:8080', xfProto: 'https, http' }),
      [],
    )).toBe(true);
  });

  it('allows an explicitly-listed CORS origin', () => {
    expect(isAllowedWsOrigin(
      fakeReq({ origin: 'https://ops.corp.example' }),
      ['https://ops.corp.example'],
    )).toBe(true);
  });

  it('rejects a different origin not in CORS list', () => {
    expect(isAllowedWsOrigin(
      fakeReq({ origin: 'https://evil.example' }),
      ['https://ops.corp.example'],
    )).toBe(false);
  });

  it('rejects a subdomain mismatch', () => {
    // attacker.manager.example.com is not the same origin as manager.example.com
    expect(isAllowedWsOrigin(
      fakeReq({ origin: 'http://attacker.manager.example.com:8080' }),
      [],
    )).toBe(false);
  });

  it('rejects scheme mismatch (https origin against http server)', () => {
    // No TLS, no XF-Proto, but Origin claims https — refuse rather than
    // guess. Server-side, "http" is what we are; "https" is something else.
    expect(isAllowedWsOrigin(
      fakeReq({ origin: 'https://manager.example.com:8080' }),
      [],
    )).toBe(false);
  });

  it('rejects port mismatch', () => {
    expect(isAllowedWsOrigin(
      fakeReq({ origin: 'http://manager.example.com:9999', host: 'manager.example.com:8080' }),
      [],
    )).toBe(false);
  });

  it('rejects the classic null Origin (sandboxed iframe / file://)', () => {
    expect(isAllowedWsOrigin(fakeReq({ origin: 'null' }), [])).toBe(false);
  });
});
