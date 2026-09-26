import { describe, expect, it } from 'vitest';
import { ConfigError, loadWebConfig } from './config';

const base = {
  DATABASE_URL_APP: 'postgres://app@localhost/w360',
  DATABASE_URL_AUTH: 'postgres://auth@localhost/w360',
  DATABASE_URL_PLATFORM: 'postgres://platform@localhost/w360',
  W360_ENCRYPTION_KEYS: 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  W360_ENCRYPTION_PRIMARY_KEY_ID: 'k1',
  W360_JOB_SIGNING_KEY: 'a'.repeat(64),
  BETTER_AUTH_SECRET: 'b'.repeat(64),
  SMTP_HOST: 'smtp.internal',
};

describe('web configuration safety', () => {
  it('accepts a local development origin over http', () => {
    const config = loadWebConfig({
      ...base,
      APP_ENV: 'local',
      NODE_ENV: 'development',
      APP_BASE_URL: 'http://localhost:3000',
    });
    expect(config.APP_ENV).toBe('local');
  });

  it('requires https for staging and production even outside a production build', () => {
    for (const APP_ENV of ['staging', 'production']) {
      for (const NODE_ENV of ['development', 'production']) {
        expect(() =>
          loadWebConfig({ ...base, APP_ENV, NODE_ENV, APP_BASE_URL: 'http://w360.example.net' }),
        ).toThrow(ConfigError);
      }
    }
  });

  it('keeps production builds under APP_ENV=test on loopback', () => {
    expect(() =>
      loadWebConfig({
        ...base,
        APP_ENV: 'test',
        NODE_ENV: 'production',
        APP_BASE_URL: 'http://w360.example.net',
      }),
    ).toThrow(/loopback/);
    expect(
      loadWebConfig({
        ...base,
        APP_ENV: 'test',
        NODE_ENV: 'production',
        APP_BASE_URL: 'http://localhost:3000',
      }).APP_ENV,
    ).toBe('test');
  });

  it('refuses APP_ENV=local in a production build', () => {
    expect(() =>
      loadWebConfig({
        ...base,
        APP_ENV: 'local',
        NODE_ENV: 'production',
        APP_BASE_URL: 'https://w360.example.net',
      }),
    ).toThrow(/APP_ENV=local/);
  });
});
