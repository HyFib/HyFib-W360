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
  EMAIL_FROM: z.string().min(3).default('HyFib W360 <no-reply@localhost>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_SECURE: bool.optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'expected a Graph API version such as v23.0')
    .optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_RECURRING_CARDS_ENABLED: bool.optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
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
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** Production safety rules that cannot be expressed per-field. */
function isLoopbackUrl(value: string): boolean {
  const host = new URL(value).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function assertProductionSafety(config: BaseConfig & { BETTER_AUTH_SECRET?: string }): void {
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
  assertProductionSafety(config);
  return config;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const config = parse(workerSchema, env);
  assertProductionSafety(config);
  return config;
}

export interface MetaConfig {
  appId: string;
  appSecret: string;
  graphApiVersion: string;
  webhookVerifyToken: string;
  embeddedSignupConfigId: string | null;
}

/** Returns Meta configuration only when all mandatory values are present. */
export function metaConfigFrom(config: BaseConfig): MetaConfig | null {
  const { META_APP_ID, META_APP_SECRET, META_GRAPH_API_VERSION, META_WEBHOOK_VERIFY_TOKEN } =
    config;
  if (!META_APP_ID || !META_APP_SECRET || !META_GRAPH_API_VERSION || !META_WEBHOOK_VERIFY_TOKEN)
    return null;
  return {
    appId: META_APP_ID,
    appSecret: META_APP_SECRET,
    graphApiVersion: META_GRAPH_API_VERSION,
    webhookVerifyToken: META_WEBHOOK_VERIFY_TOKEN,
    embeddedSignupConfigId: config.META_EMBEDDED_SIGNUP_CONFIG_ID ?? null,
  };
}

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  recurringCardsEnabled: boolean;
}

export function razorpayConfigFrom(config: BaseConfig): RazorpayConfig | null {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = config;
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET || !RAZORPAY_WEBHOOK_SECRET) return null;
  return {
    keyId: RAZORPAY_KEY_ID,
    keySecret: RAZORPAY_KEY_SECRET,
    webhookSecret: RAZORPAY_WEBHOOK_SECRET,
    recurringCardsEnabled: config.RAZORPAY_RECURRING_CARDS_ENABLED ?? false,
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
