import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadWebConfig,
  loadWorkerConfig,
  metaConfigFrom,
  razorpayConfigFrom,
  shopifyConfigFrom,
} from './config';

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

describe('empty values and Meta configuration', () => {
  const local = { ...base, APP_ENV: 'local', APP_BASE_URL: 'http://localhost:3000' };
  const meta = {
    META_APP_ID: '1234567890',
    META_APP_SECRET: 's'.repeat(32),
    META_GRAPH_API_VERSION: 'v26.0',
    META_WEBHOOK_VERIFY_TOKEN: 'verify-token',
  };

  it('treats empty variables as unset', () => {
    const config = loadWebConfig({ ...local, META_APP_ID: '', META_GRAPH_BASE_URL: '' });
    expect(config.META_APP_ID).toBeUndefined();
    expect(metaConfigFrom(config)).toBeNull();
  });

  it('accepts both secrets during rotation and defaults to the official Graph origin', () => {
    const config = metaConfigFrom(
      loadWebConfig({ ...local, ...meta, META_APP_SECRET_PREVIOUS: 'p'.repeat(32) }),
    );
    expect(config?.webhookSecrets).toEqual(['s'.repeat(32), 'p'.repeat(32)]);
    expect(config?.graphBaseUrl).toBe('https://graph.facebook.com');
  });

  it('allows a Graph stand-in only for local and test environments', () => {
    const graph = { META_GRAPH_BASE_URL: 'http://127.0.0.1:4010/' };
    expect(metaConfigFrom(loadWebConfig({ ...local, ...meta, ...graph }))?.graphBaseUrl).toBe(
      'http://127.0.0.1:4010',
    );
    const staging = loadWebConfig({
      ...base,
      ...meta,
      ...graph,
      APP_ENV: 'staging',
      APP_BASE_URL: 'https://staging.w360.example.net',
    });
    expect(() => metaConfigFrom(staging)).toThrow(/META_GRAPH_BASE_URL/);
  });
});

describe('Razorpay configuration', () => {
  const local = { ...base, APP_ENV: 'local', APP_BASE_URL: 'http://localhost:3000' };
  const razorpay = {
    RAZORPAY_KEY_ID: 'rzp_test_Abc123',
    RAZORPAY_KEY_SECRET: 'k'.repeat(24),
    RAZORPAY_WEBHOOK_SECRET: 'w'.repeat(24),
  };
  const production = { ...base, APP_ENV: 'production', APP_BASE_URL: 'https://w360.example.net' };

  it('is optional, and recurring card mandates and plan subscriptions stay off unless enabled', () => {
    expect(razorpayConfigFrom(loadWebConfig(local))).toBeNull();
    const config = razorpayConfigFrom(
      loadWebConfig({ ...local, ...razorpay, RAZORPAY_WEBHOOK_SECRET_PREVIOUS: 'o'.repeat(24) }),
    );
    expect(config).toMatchObject({
      mode: 'test',
      recurringCardsEnabled: false,
      subscriptionsEnabled: false,
      apiBaseUrl: 'https://api.razorpay.com',
      webhookSecrets: ['w'.repeat(24), 'o'.repeat(24)],
    });
    expect(
      razorpayConfigFrom(
        loadWebConfig({ ...local, ...razorpay, RAZORPAY_SUBSCRIPTIONS_ENABLED: 'true' }),
      ),
    ).toMatchObject({ recurringCardsEnabled: false, subscriptionsEnabled: true });
  });

  it('rejects malformed key ids and allows live keys only in production', () => {
    expect(() => loadWebConfig({ ...local, ...razorpay, RAZORPAY_KEY_ID: 'key_123' })).toThrow(
      ConfigError,
    );
    const live = { ...razorpay, RAZORPAY_KEY_ID: 'rzp_live_Abc123' };
    expect(() => razorpayConfigFrom(loadWebConfig({ ...local, ...live }))).toThrow(/live keys/);
    expect(razorpayConfigFrom(loadWebConfig({ ...production, ...live }))?.mode).toBe('live');
  });

  it('allows a Razorpay stand-in only for local and test environments', () => {
    const standIn = { RAZORPAY_API_BASE_URL: 'http://127.0.0.1:4020/' };
    expect(
      razorpayConfigFrom(loadWebConfig({ ...local, ...razorpay, ...standIn }))?.apiBaseUrl,
    ).toBe('http://127.0.0.1:4020');
    expect(() =>
      razorpayConfigFrom(loadWebConfig({ ...production, ...razorpay, ...standIn })),
    ).toThrow(/RAZORPAY_API_BASE_URL/);
  });
});

describe('Shopify app configuration', () => {
  const local = { ...base, APP_ENV: 'local', APP_BASE_URL: 'http://localhost:3000' };
  const production = { ...base, APP_ENV: 'production', APP_BASE_URL: 'https://w360.example.net' };
  const shopify = {
    SHOPIFY_CLIENT_ID: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    SHOPIFY_CLIENT_SECRET: 's'.repeat(32),
    SHOPIFY_API_VERSION: '2026-07',
  };

  it('is optional and needs the client id, secret and API version together', () => {
    expect(shopifyConfigFrom(loadWebConfig(local))).toBeNull();
    const { SHOPIFY_API_VERSION: _version, ...withoutVersion } = shopify;
    expect(shopifyConfigFrom(loadWebConfig({ ...local, ...withoutVersion }))).toBeNull();
    const config = shopifyConfigFrom(
      loadWebConfig({ ...production, ...shopify, SHOPIFY_CLIENT_SECRET_PREVIOUS: 'p'.repeat(32) }),
    );
    expect(config).toMatchObject({ apiVersion: '2026-07', testBaseUrl: null });
    expect(config?.secrets).toEqual(['s'.repeat(32), 'p'.repeat(32)]);
  });

  it('rejects malformed API versions and short secrets', () => {
    expect(() => loadWebConfig({ ...local, ...shopify, SHOPIFY_API_VERSION: '2026-05' })).toThrow(
      ConfigError,
    );
    expect(() => loadWebConfig({ ...local, ...shopify, SHOPIFY_CLIENT_SECRET: 'short' })).toThrow(
      ConfigError,
    );
  });

  it('allows a shop stand-in only for local and test environments', () => {
    const standIn = { SHOPIFY_TEST_BASE_URL: 'http://127.0.0.1:4030/' };
    expect(
      shopifyConfigFrom(loadWebConfig({ ...local, ...shopify, ...standIn }))?.testBaseUrl,
    ).toBe('http://127.0.0.1:4030');
    expect(() =>
      shopifyConfigFrom(loadWebConfig({ ...production, ...shopify, ...standIn })),
    ).toThrow(/SHOPIFY_TEST_BASE_URL/);
  });
});

describe('egress for local test targets', () => {
  it('is allowed only with APP_ENV=local or test', () => {
    const flag = { W360_EGRESS_ALLOW_LOOPBACK: 'true' };
    expect(
      loadWorkerConfig({ ...base, ...flag, APP_ENV: 'test', APP_BASE_URL: 'http://localhost:3000' })
        .W360_EGRESS_ALLOW_LOOPBACK,
    ).toBe(true);
    for (const APP_ENV of ['staging', 'production']) {
      expect(() =>
        loadWorkerConfig({ ...base, ...flag, APP_ENV, APP_BASE_URL: 'https://w360.example.net' }),
      ).toThrow(/W360_EGRESS_ALLOW_LOOPBACK/);
      expect(() =>
        loadWebConfig({ ...base, ...flag, APP_ENV, APP_BASE_URL: 'https://w360.example.net' }),
      ).toThrow(/W360_EGRESS_ALLOW_LOOPBACK/);
    }
  });
});
