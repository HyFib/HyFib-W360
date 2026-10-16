import { PgBoss } from 'pg-boss';
import {
  Keyring,
  createLogger,
  loadWorkerConfig,
  metaConfigFrom,
  razorpayApiBaseUrl,
  razorpayConfigFrom,
  shopifyConfigFrom,
  smtpConfigFrom,
  systemClock,
  type Clock,
  type Logger,
  type MetaConfig,
  type RazorpayConfig,
  type ShopifyConfig,
  type WorkerConfig,
} from '@w360/core';
import {
  DEFAULT_EGRESS_POLICY,
  createEgressClient,
  type EgressClient,
  type EgressPolicy,
} from '@w360/core/egress';
import { assertRuntimeRoleSafety, createDatabase, createPool, type Database } from '@w360/db';
import {
  GraphClient,
  JobSigner,
  PgBossJobQueue,
  pgBossErrorContext,
  RazorpayClient,
  SmtpEmailSender,
  WebhookOAuthTokenCache,
  webhookEgressPolicy,
  type BillingNoticeDeps,
  type EmailSender,
  type JobQueue,
} from '@w360/domain';

export interface WorkerRuntime {
  config: WorkerConfig;
  logger: Logger;
  clock: Clock;
  keyring: Keyring;
  db: Database;
  boss: PgBoss;
  jobs: JobQueue;
  signer: JobSigner;
  email: EmailSender | null;
  /** Null until the Meta app is configured; WhatsApp jobs then wait (retry) instead of failing. */
  meta: MetaConfig | null;
  graph: GraphClient | null;
  sendRate: { capacity: number; refillPerSecond: number };
  /** Null until Razorpay is configured; billing jobs then wait (retry) instead of failing. */
  razorpayConfig: RazorpayConfig | null;
  razorpay: RazorpayClient | null;
  /** Razorpay's API origin for companies' own accounts (Payment Links), even without HyFib's keys. */
  razorpayBaseUrl: string;
  notices: BillingNoticeDeps;
  /** The only client for company-chosen addresses (automation HTTP steps): see core/egress. */
  egress: EgressClient;
  egressPolicy: EgressPolicy;
  /**
   * Egress for webhook deliveries (ADR-395): the same policy, with request bodies up to
   * `WEBHOOK_LIMITS.requestBytes` (`webhookEgressPolicy`), so a deal event listing its products is
   * sent; every other caller keeps the policy's 64 KiB.
   */
  webhookEgress: EgressClient;
  /**
   * Egress for companies' stores (Shopify shops, WooCommerce sites): the same address checks, with
   * larger responses (order pages) and a longer deadline.
   */
  storeEgress: EgressClient;
  /**
   * Egress for the operations alerts' chat channel (ADR-338): the same address checks, its own
   * client, so the posts never wait for name lookups of companies' traffic.
   */
  alertEgress: EgressClient;
  /** HyFib's Shopify app; null until configured (Shopify stores then cannot connect or sync). */
  shopify: ShopifyConfig | null;
  /**
   * The OAuth access tokens webhook deliveries send (ADR-173), kept in this process's memory only,
   * across jobs.
   */
  webhookOAuthTokens: WebhookOAuthTokenCache;
  close(): Promise<void>;
}

export async function createWorkerRuntime(): Promise<WorkerRuntime> {
  const config = loadWorkerConfig();
  const logger = createLogger({ name: 'w360-worker', level: config.LOG_LEVEL });
  const keyring = Keyring.fromEnv(
    config.W360_ENCRYPTION_KEYS,
    config.W360_ENCRYPTION_PRIMARY_KEY_ID,
  );
  const pool = createPool({
    connectionString: config.DATABASE_URL_APP,
    max: config.DATABASE_POOL_MAX_APP,
    applicationName: 'w360-worker',
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
  });
  await assertRuntimeRoleSafety(pool, {
    strict: config.NODE_ENV === 'production',
    warn: (m) => logger.warn(m),
  });
  const db = createDatabase(pool);

  const boss = new PgBoss({
    connectionString: config.DATABASE_URL_APP,
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    // Maintenance (expiry, retention) and cron scheduling run in workers; index rebuilds and
    // partition management need owner rights and are run by operators (docs/RUNBOOKS.md).
    supervise: true,
    schedule: true,
    reindex: false,
    persistQueueStats: false,
    max: Math.max(4, config.WORKER_CONCURRENCY + 2),
    application_name: 'w360-worker-jobs',
  });
  boss.on('error', (error: unknown) =>
    logger.error({ err: error, ...pgBossErrorContext(error) }, 'pg-boss error'),
  );
  boss.on('warning', (warning: unknown) => logger.warn({ warning }, 'pg-boss warning'));

  const smtp = smtpConfigFrom(config);
  if (!smtp) logger.warn('SMTP is not configured: email jobs stay queued until it is.');
  const meta = metaConfigFrom(config);
  if (!meta) logger.warn('Meta is not configured: WhatsApp jobs stay queued until it is.');
  const razorpayConfig = razorpayConfigFrom(config);
  if (!razorpayConfig)
    logger.warn('Razorpay is not configured: billing jobs stay queued until it is.');
  const jobs = new PgBossJobQueue(boss);
  // During a job signing key rotation, the next or previous key is accepted too (ADR-135).
  const signer = new JobSigner(config.W360_JOB_SIGNING_KEY, {
    next: config.W360_JOB_SIGNING_KEY_NEXT,
    previous: config.W360_JOB_SIGNING_KEY_PREVIOUS,
  });
  const egressPolicy: EgressPolicy = {
    ...DEFAULT_EGRESS_POLICY,
    // Only for local test targets; configuration refuses it outside APP_ENV=local|test.
    allowLoopbackForTests: config.W360_EGRESS_ALLOW_LOOPBACK ?? false,
  };
  if (egressPolicy.allowLoopbackForTests) {
    logger.warn('Egress to http:// and loopback addresses is allowed (local test targets only).');
  }
  const shopify = shopifyConfigFrom(config);
  if (!shopify) logger.warn('Shopify is not configured: Shopify stores cannot connect or sync.');

  return {
    config,
    logger,
    clock: systemClock,
    keyring,
    db,
    boss,
    jobs,
    signer,
    email: smtp ? new SmtpEmailSender(smtp) : null,
    meta,
    graph: meta
      ? new GraphClient({ baseUrl: meta.graphBaseUrl, version: meta.graphApiVersion })
      : null,
    sendRate: {
      capacity: config.META_SEND_RATE_PER_SECOND,
      refillPerSecond: config.META_SEND_RATE_PER_SECOND,
    },
    razorpayConfig,
    razorpay: razorpayConfig
      ? new RazorpayClient({
          baseUrl: razorpayConfig.apiBaseUrl,
          keyId: razorpayConfig.keyId,
          keySecret: razorpayConfig.keySecret,
        })
      : null,
    razorpayBaseUrl: razorpayApiBaseUrl(config),
    notices: { outbox: { keyring, jobs, signer }, appBaseUrl: config.APP_BASE_URL },
    egress: createEgressClient(egressPolicy),
    egressPolicy,
    webhookEgress: createEgressClient(webhookEgressPolicy(egressPolicy)),
    storeEgress: createEgressClient({
      ...egressPolicy,
      timeoutMs: 30_000,
      maxResponseBytes: 4 * 1024 * 1024,
    }),
    alertEgress: createEgressClient(egressPolicy),
    shopify,
    webhookOAuthTokens: new WebhookOAuthTokenCache(),
    async close() {
      await pool.end();
    },
  };
}
