import { PgBoss } from 'pg-boss';
import {
  Keyring,
  createLogger,
  loadWorkerConfig,
  metaConfigFrom,
  razorpayConfigFrom,
  smtpConfigFrom,
  systemClock,
  type Clock,
  type Logger,
  type MetaConfig,
  type RazorpayConfig,
  type WorkerConfig,
} from '@w360/core';
import { assertRuntimeRoleSafety, createDatabase, createPool, type Database } from '@w360/db';
import {
  GraphClient,
  JobSigner,
  PgBossJobQueue,
  RazorpayClient,
  SmtpEmailSender,
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
  notices: BillingNoticeDeps;
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
  boss.on('error', (error: unknown) => logger.error({ err: error }, 'pg-boss error'));
  boss.on('warning', (warning: unknown) => logger.warn({ warning }, 'pg-boss warning'));

  const smtp = smtpConfigFrom(config);
  if (!smtp) logger.warn('SMTP is not configured: email jobs stay queued until it is.');
  const meta = metaConfigFrom(config);
  if (!meta) logger.warn('Meta is not configured: WhatsApp jobs stay queued until it is.');
  const razorpayConfig = razorpayConfigFrom(config);
  if (!razorpayConfig)
    logger.warn('Razorpay is not configured: billing jobs stay queued until it is.');
  const jobs = new PgBossJobQueue(boss);
  const signer = new JobSigner(config.W360_JOB_SIGNING_KEY);

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
    notices: { outbox: { keyring, jobs, signer }, appBaseUrl: config.APP_BASE_URL },
    async close() {
      await pool.end();
    },
  };
}
