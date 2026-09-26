import { PgBoss } from 'pg-boss';
import {
  Keyring,
  createLogger,
  loadWorkerConfig,
  smtpConfigFrom,
  systemClock,
  type Clock,
  type Logger,
  type WorkerConfig,
} from '@w360/core';
import { assertRuntimeRoleSafety, createDatabase, createPool, type Database } from '@w360/db';
import {
  JobSigner,
  PgBossJobQueue,
  SmtpEmailSender,
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

  return {
    config,
    logger,
    clock: systemClock,
    keyring,
    db,
    boss,
    jobs: new PgBossJobQueue(boss),
    signer: new JobSigner(config.W360_JOB_SIGNING_KEY),
    email: smtp ? new SmtpEmailSender(smtp) : null,
    async close() {
      await pool.end();
    },
  };
}
