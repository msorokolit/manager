// JWT_TTL_SECONDS bounds (L2): 60s floor, 30-day ceiling.
import { describe, it, expect } from 'vitest';
import { settingsFromEnv } from '../src/config.js';

describe('JWT_TTL_SECONDS bounds', () => {
  it('falls back to 12h when unset', () => {
    expect(settingsFromEnv({}).jwtTtlSeconds).toBe(60 * 60 * 12);
  });

  it('clamps absurdly low values to the 60s floor', () => {
    expect(settingsFromEnv({ JWT_TTL_SECONDS: '5' }).jwtTtlSeconds).toBe(60);
  });

  it('clamps absurdly high values to the 30-day ceiling', () => {
    expect(
      settingsFromEnv({ JWT_TTL_SECONDS: '999999999' }).jwtTtlSeconds,
    ).toBe(60 * 60 * 24 * 30);
  });

  it('accepts a value inside the band', () => {
    expect(settingsFromEnv({ JWT_TTL_SECONDS: '3600' }).jwtTtlSeconds).toBe(
      3600,
    );
  });
});

describe('CSV settings parse stably', () => {
  it('CORS_ORIGINS', () => {
    const s = settingsFromEnv({
      CORS_ORIGINS: 'https://a.example, https://b.example,, ',
    });
    expect(s.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('empty CORS_ORIGINS yields []', () => {
    expect(settingsFromEnv({}).corsOrigins).toEqual([]);
  });
});

describe('Compose deadlines (H1)', () => {
  it('defaults to 30 minutes', () => {
    expect(settingsFromEnv({}).composeDeadlineMs).toBe(30 * 60 * 1000);
  });

  it('honours an override', () => {
    expect(settingsFromEnv({ COMPOSE_DEADLINE_MS: '60000' }).composeDeadlineMs).toBe(60_000);
  });

  it('clamps absurd lows to a 1s floor', () => {
    expect(settingsFromEnv({ COMPOSE_DEADLINE_MS: '0' }).composeDeadlineMs).toBe(1000);
  });
});

describe('Volume browser reaper settings', () => {
  it('default TTL is 10 minutes', () => {
    expect(settingsFromEnv({}).volumeBrowserTtlMs).toBe(10 * 60 * 1000);
  });

  it('VOLUME_BROWSER_TTL_MS=0 disables the reaper', () => {
    expect(settingsFromEnv({ VOLUME_BROWSER_TTL_MS: '0' }).volumeBrowserTtlMs).toBe(0);
  });

  it('honours TTL and reap-interval overrides', () => {
    const s = settingsFromEnv({
      VOLUME_BROWSER_TTL_MS: '90000',
      VOLUME_BROWSER_REAP_INTERVAL_MS: '15000',
    });
    expect(s.volumeBrowserTtlMs).toBe(90_000);
    expect(s.volumeBrowserReapIntervalMs).toBe(15_000);
  });

  it('reap-interval has a 1s floor', () => {
    expect(
      settingsFromEnv({ VOLUME_BROWSER_REAP_INTERVAL_MS: '100' }).volumeBrowserReapIntervalMs,
    ).toBe(1000);
  });

  it('TTL rejects negatives and clamps to 0', () => {
    expect(settingsFromEnv({ VOLUME_BROWSER_TTL_MS: '-9999' }).volumeBrowserTtlMs).toBe(0);
  });
});

describe('Rate-limit settings', () => {
  it('apply sensible defaults', () => {
    const s = settingsFromEnv({});
    expect(s.rateLimitDisabled).toBe(false);
    expect(s.rateLimitGlobalPerMin).toBe(600);
    expect(s.rateLimitLoginPerMin).toBe(10);
    expect(s.expensiveConcurrencyPerUser).toBe(2);
  });

  it('honour overrides + floors', () => {
    const s = settingsFromEnv({
      RATE_LIMIT_DISABLED: 'true',
      RATE_LIMIT_GLOBAL_PER_MIN: '1', // < floor of 10
      RATE_LIMIT_LOGIN_PER_MIN: '5',
    });
    expect(s.rateLimitDisabled).toBe(true);
    expect(s.rateLimitGlobalPerMin).toBe(10);
    expect(s.rateLimitLoginPerMin).toBe(5);
  });
});
