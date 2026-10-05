import { z } from 'zod';

/**
 * Process configuration, validated at start-up. Secrets arrive through environment variables that
 * the deployment populates from its secret manager. Optional provider sections evaluate to `null`
 * when unset; the corresponding capability is then reported as unavailable rather than faked.
 */
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const secret = (min = 32) => z.string().min(min, `must be at least ${min} characters`);

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  APP_BASE_URL: z.url(),
  DATABASE_URL_APP: z.string().min(1),
  DATABASE_POOL_MAX_APP: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(15_000),
  W360_ENCRYPTION_KEYS: z.string().min(1),
  W360_ENCRYPTION_PRIMARY_KEY_ID: z.string().min(1),
  W360_JOB_SIGNING_KEY: secret(),
  /**
   * Rotating the job signing key, one rotation at a time (ADR-135). NEXT: a key whose signatures
   * are accepted before any instance signs with it. PREVIOUS: the key being retired, still accepted
   * while the worker signs the queued jobs it signed again with W360_JOB_SIGNING_KEY.
   */
  W360_JOB_SIGNING_KEY_NEXT: secret().optional(),
  W360_JOB_SIGNING_KEY_PREVIOUS: secret().optional(),
  EMAIL_FROM: z.string().min(3).default('HyFib W360 <no-reply@localhost>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_SECURE: bool.optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  META_APP_ID: z
    .string()
    .regex(/^[0-9]{1,32}$/, 'expected a numeric Meta app id')
    .optional(),
  META_APP_SECRET: z.string().optional(),
  /** Previous app secret, accepted for webhook signatures only while a rotation is in progress. */
  META_APP_SECRET_PREVIOUS: z.string().optional(),
  /**
   * Graph API origin. Defaults to Meta's; overriding is allowed only for APP_ENV=local|test so that
   * automated tests can point at a local stand-in (never a production code path).
   */
  META_GRAPH_BASE_URL: z.url().optional(),
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'expected a Graph API version such as v23.0')
    .optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().optional(),
  RAZORPAY_KEY_ID: z
    .string()
    .regex(
      /^rzp_(test|live)_[A-Za-z0-9]{1,40}$/,
      'expected a Razorpay key id (rzp_test_… or rzp_live_…)',
    )
    .optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  /** Previous webhook secret, accepted while a rotation is in progress. */
  RAZORPAY_WEBHOOK_SECRET_PREVIOUS: z.string().optional(),
  /** Only after Razorpay confirms Recurring Payments (card mandates) for this merchant. */
  RAZORPAY_RECURRING_CARDS_ENABLED: bool.optional(),
  /**
   * Paying for plans with Razorpay Subscriptions (ADR-063): only after Razorpay activates
   * Subscriptions (and Flash Checkout) for this merchant.
   */
  RAZORPAY_SUBSCRIPTIONS_ENABLED: bool.optional(),
  /** API origin override, allowed only for APP_ENV=local|test (a test stand-in). */
  RAZORPAY_API_BASE_URL: z.url().optional(),
  /**
   * HyFib's Shopify app, used by companies to connect their own stores (P4-06b): the client id and
   * secret from the app's settings in Shopify, and the Admin API version the connector speaks.
   */
  SHOPIFY_CLIENT_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/, 'expected a Shopify client id')
    .optional(),
  SHOPIFY_CLIENT_SECRET: z.string().min(16, 'must be at least 16 characters').optional(),
  /** Previous client secret, accepted for signatures only while a rotation is in progress. */
  SHOPIFY_CLIENT_SECRET_PREVIOUS: z.string().min(16, 'must be at least 16 characters').optional(),
  SHOPIFY_API_VERSION: z
    .string()
    .regex(/^20[0-9]{2}-(01|04|07|10)$/, 'expected a Shopify API version such as 2026-07')
    .optional(),
  /**
   * Replaces `https://<shop>` with `<base>/<shop>` for every shop, allowed only for
   * APP_ENV=local|test so that automated tests can point at a local stand-in.
   */
  SHOPIFY_TEST_BASE_URL: z.url().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  /**
   * Lets the automation HTTP step call http:// and loopback addresses, for local test targets (the
   * web app accepts such steps and the worker's egress client connects to them). Refused outside
   * APP_ENV=local|test: never a production code path.
   */
  W360_EGRESS_ALLOW_LOOPBACK: bool.optional(),
});

const webSchema = baseSchema.extend({
  DATABASE_URL_AUTH: z.string().min(1),
  DATABASE_URL_PLATFORM: z.string().min(1),
  DATABASE_POOL_MAX_AUTH: z.coerce.number().int().min(1).max(100).default(5),
  DATABASE_POOL_MAX_PLATFORM: z.coerce.number().int().min(1).max(20).default(2),
  BETTER_AUTH_SECRET: secret(),
  TRUSTED_ORIGINS: z.string().optional(),
  /** Comma-separated IPs/CIDRs of the load balancers in front of the app (for client IP resolution). */
  TRUSTED_PROXIES: z.string().optional(),
  INVITATION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(168),
  MFA_GRACE_PERIOD_HOURS: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 30)
    .default(72),
});

const workerSchema = baseSchema.extend({
  DATABASE_URL_PLATFORM: z.string().min(1),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /**
   * Outbound messages per second per business number, enforced across all workers. Meta's default
   * Cloud API throughput is higher (docs/research/meta-whatsapp.md); stay below it.
   */
  META_SEND_RATE_PER_SECOND: z.coerce.number().int().min(1).max(1000).default(20),
});

export type BaseConfig = z.infer<typeof baseSchema>;
export type WebConfig = z.infer<typeof webSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  // An empty value (`KEY=` in an env file) means "not set".
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const result = schema.safeParse(present);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** One job signing key rotation at a time, with keys that differ (ADR-135). */
function assertJobSigningKeys(config: BaseConfig): void {
  const key = config.W360_JOB_SIGNING_KEY;
  const next = config.W360_JOB_SIGNING_KEY_NEXT;
  const previous = config.W360_JOB_SIGNING_KEY_PREVIOUS;
  const problems: string[] = [];
  if (next !== undefined && previous !== undefined)
    problems.push(
      'W360_JOB_SIGNING_KEY_NEXT and W360_JOB_SIGNING_KEY_PREVIOUS cannot both be set (one rotation at a time)',
    );
  if (next === key)
    problems.push('W360_JOB_SIGNING_KEY_NEXT must differ from W360_JOB_SIGNING_KEY');
  if (previous === key)
    problems.push('W360_JOB_SIGNING_KEY_PREVIOUS must differ from W360_JOB_SIGNING_KEY');
  if (problems.length)
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
}

/** Production safety rules that cannot be expressed per-field. */
function isLoopbackUrl(value: string): boolean {
  const host = new URL(value).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function assertProductionSafety(config: BaseConfig & { BETTER_AUTH_SECRET?: string }): void {
  if (
    config.W360_EGRESS_ALLOW_LOOPBACK &&
    config.APP_ENV !== 'local' &&
    config.APP_ENV !== 'test'
  ) {
    throw new ConfigError(
      'Unsafe configuration:\n  - W360_EGRESS_ALLOW_LOOPBACK is only allowed with APP_ENV=local or test',
    );
  }
  // Real environments always serve over https, whatever the build mode: cookie security and
  // provider callbacks are derived from this origin.
  if (
    (config.APP_ENV === 'staging' || config.APP_ENV === 'production') &&
    !config.APP_BASE_URL.startsWith('https://')
  ) {
    throw new ConfigError(
      `Unsafe configuration:\n  - APP_BASE_URL must use https in ${config.APP_ENV}`,
    );
  }
  if (config.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (config.APP_ENV === 'local')
    problems.push('APP_ENV=local is not allowed with a production build');
  if (config.APP_ENV === 'test') {
    // Production builds under test (CI end-to-end runs) must stay on loopback so this mode can
    // never serve real users.
    if (!isLoopbackUrl(config.APP_BASE_URL))
      problems.push('APP_ENV=test requires a loopback APP_BASE_URL');
  } else if (!config.APP_BASE_URL.startsWith('https://')) {
    problems.push('APP_BASE_URL must use https');
  }
  const weak = /(changeme|dev-only|example|insecure)/i;
  for (const [key, value] of Object.entries({
    W360_JOB_SIGNING_KEY: config.W360_JOB_SIGNING_KEY,
    W360_JOB_SIGNING_KEY_NEXT: config.W360_JOB_SIGNING_KEY_NEXT,
    W360_JOB_SIGNING_KEY_PREVIOUS: config.W360_JOB_SIGNING_KEY_PREVIOUS,
    BETTER_AUTH_SECRET: config.BETTER_AUTH_SECRET,
    W360_ENCRYPTION_KEYS: config.W360_ENCRYPTION_KEYS,
  })) {
    if (value && weak.test(value)) problems.push(`${key} looks like a development placeholder`);
  }
  if (!config.SMTP_HOST) problems.push('SMTP_HOST is required in production');
  if (problems.length)
    throw new ConfigError(`Unsafe production configuration:\n  - ${problems.join('\n  - ')}`);
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const config = parse(webSchema, env);
  assertJobSigningKeys(config);
  assertProductionSafety(config);
  return config;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const config = parse(workerSchema, env);
  assertJobSigningKeys(config);
  assertProductionSafety(config);
  return config;
}

export interface MetaConfig {
  appId: string;
  appSecret: string;
  /** Secrets accepted for webhook signatures: current first, then the previous during rotation. */
  webhookSecrets: string[];
  graphApiVersion: string;
  graphBaseUrl: string;
  webhookVerifyToken: string;
  embeddedSignupConfigId: string | null;
}

export const META_GRAPH_ORIGIN = 'https://graph.facebook.com';

/** Returns Meta configuration only when all mandatory values are present. */
export function metaConfigFrom(config: BaseConfig): MetaConfig | null {
  const { META_APP_ID, META_APP_SECRET, META_GRAPH_API_VERSION, META_WEBHOOK_VERIFY_TOKEN } =
    config;
  if (!META_APP_ID || !META_APP_SECRET || !META_GRAPH_API_VERSION || !META_WEBHOOK_VERIFY_TOKEN)
    return null;
  const graphBaseUrl = (config.META_GRAPH_BASE_URL ?? META_GRAPH_ORIGIN).replace(/\/$/, '');
  if (
    graphBaseUrl !== META_GRAPH_ORIGIN &&
    config.APP_ENV !== 'local' &&
    config.APP_ENV !== 'test'
  ) {
    throw new ConfigError(`META_GRAPH_BASE_URL must be ${META_GRAPH_ORIGIN} in ${config.APP_ENV}`);
  }
  return {
    appId: META_APP_ID,
    appSecret: META_APP_SECRET,
    webhookSecrets: [META_APP_SECRET, config.META_APP_SECRET_PREVIOUS].filter((v): v is string =>
      Boolean(v),
    ),
    graphApiVersion: META_GRAPH_API_VERSION,
    graphBaseUrl,
    webhookVerifyToken: META_WEBHOOK_VERIFY_TOKEN,
    embeddedSignupConfigId: config.META_EMBEDDED_SIGNUP_CONFIG_ID ?? null,
  };
}

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  /** Webhook secrets accepted for signatures: current first, then the previous during rotation. */
  webhookSecrets: string[];
  recurringCardsEnabled: boolean;
  /** Companies may pay for their plan through a Razorpay subscription (ADR-063). */
  subscriptionsEnabled: boolean;
  apiBaseUrl: string;
  /** Live keys move real money; test keys only simulate payments. */
  mode: 'test' | 'live';
}

export const RAZORPAY_API_ORIGIN = 'https://api.razorpay.com';

/**
 * Razorpay's API origin: the official one, or a test stand-in only with APP_ENV=local|test. Used for
 * HyFib's own account and for companies' accounts (Payment Links for their orders).
 */
export function razorpayApiBaseUrl(config: BaseConfig): string {
  const apiBaseUrl = (config.RAZORPAY_API_BASE_URL ?? RAZORPAY_API_ORIGIN).replace(/\/$/, '');
  if (
    apiBaseUrl !== RAZORPAY_API_ORIGIN &&
    config.APP_ENV !== 'local' &&
    config.APP_ENV !== 'test'
  ) {
    throw new ConfigError(
      `RAZORPAY_API_BASE_URL must be ${RAZORPAY_API_ORIGIN} in ${config.APP_ENV}`,
    );
  }
  return apiBaseUrl;
}

export function razorpayConfigFrom(config: BaseConfig): RazorpayConfig | null {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = config;
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET || !RAZORPAY_WEBHOOK_SECRET) return null;
  const apiBaseUrl = razorpayApiBaseUrl(config);
  const mode = RAZORPAY_KEY_ID.startsWith('rzp_live_') ? 'live' : 'test';
  if (mode === 'live' && config.APP_ENV !== 'production') {
    throw new ConfigError('Razorpay live keys are allowed only with APP_ENV=production');
  }
  return {
    keyId: RAZORPAY_KEY_ID,
    keySecret: RAZORPAY_KEY_SECRET,
    webhookSecrets: [RAZORPAY_WEBHOOK_SECRET, config.RAZORPAY_WEBHOOK_SECRET_PREVIOUS].filter(
      (v): v is string => Boolean(v),
    ),
    recurringCardsEnabled: config.RAZORPAY_RECURRING_CARDS_ENABLED ?? false,
    subscriptionsEnabled: config.RAZORPAY_SUBSCRIPTIONS_ENABLED ?? false,
    apiBaseUrl,
    mode,
  };
}

export interface ShopifyConfig {
  clientId: string;
  clientSecret: string;
  /** Secrets accepted for signatures: current first, then the previous during rotation. */
  secrets: string[];
  apiVersion: string;
  /** Test stand-in base (APP_ENV=local|test only); null means each shop's own https origin. */
  testBaseUrl: string | null;
}

/** Returns HyFib's Shopify app configuration only when all mandatory values are present. */
export function shopifyConfigFrom(config: BaseConfig): ShopifyConfig | null {
  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_API_VERSION } = config;
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_API_VERSION) return null;
  const testBaseUrl = config.SHOPIFY_TEST_BASE_URL?.replace(/\/$/, '') ?? null;
  if (testBaseUrl && config.APP_ENV !== 'local' && config.APP_ENV !== 'test') {
    throw new ConfigError(`SHOPIFY_TEST_BASE_URL is not allowed in ${config.APP_ENV}`);
  }
  return {
    clientId: SHOPIFY_CLIENT_ID,
    clientSecret: SHOPIFY_CLIENT_SECRET,
    secrets: [SHOPIFY_CLIENT_SECRET, config.SHOPIFY_CLIENT_SECRET_PREVIOUS].filter(
      (v): v is string => Boolean(v),
    ),
    apiVersion: SHOPIFY_API_VERSION,
    testBaseUrl,
  };
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
}

export function smtpConfigFrom(config: BaseConfig): SmtpConfig | null {
  if (!config.SMTP_HOST) return null;
  return {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT ?? 587,
    secure: config.SMTP_SECURE ?? false,
    user: config.SMTP_USER ?? null,
    password: config.SMTP_PASSWORD ?? null,
    from: config.EMAIL_FROM,
  };
}

export interface S3Config {
  endpoint: string | null;
  region: string;
  bucket: string;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  forcePathStyle: boolean;
}

export function s3ConfigFrom(config: BaseConfig): S3Config | null {
  if (!config.S3_BUCKET || !config.S3_REGION) return null;
  return {
    endpoint: config.S3_ENDPOINT ?? null,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID ?? null,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY ?? null,
    forcePathStyle: config.S3_FORCE_PATH_STYLE ?? false,
  };
}
