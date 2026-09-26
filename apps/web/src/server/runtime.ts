import 'server-only';
import type { BlockList } from 'node:net';
import { PgBoss } from 'pg-boss';
import {
  Keyring,
  createLogger,
  loadWebConfig,
  metaConfigFrom,
  parseTrustedProxies,
  razorpayConfigFrom,
  systemClock,
  type Clock,
  type Logger,
  type MetaConfig,
  type RazorpayConfig,
  type WebConfig,
} from '@w360/core';
import { assertRuntimeRoleSafety, createDatabase, createPool, type Database } from '@w360/db';
import { createPlatformDatabase } from '@w360/db/platform';
import {
  GraphClient,
  JobSigner,
  PgBossJobQueue,
  RazorpayClient,
  createBillingService,
  createConsentService,
  createContactsService,
  createInboxService,
  createOnboardingService,
  createPlatformService,
  createTemplatesService,
  createTenancyService,
  type BillingService,
  type ConsentService,
  type ContactsService,
  type InboxService,
  type JobQueue,
  type OnboardingService,
  type OutboundDeps,
  type PlatformService,
  type TemplatesService,
  type TenancyService,
} from '@w360/domain';
import { createAuth, type Auth } from './auth';
import { createTenantEventHub, type TenantEventHub } from './event-hub';

/**
 * Process-wide dependencies for the web tier, created lazily on first use so that `next build`
 * never needs runtime secrets. One instance per server process (cached on globalThis so that
 * development hot reloads do not leak pools).
 */
export interface Runtime {
  config: WebConfig;
  logger: Logger;
  clock: Clock;
  /** Our own load balancers (TRUSTED_PROXIES), used to resolve client addresses for audit. */
  trustedProxies: BlockList | null;
  keyring: Keyring;
  db: Database;
  jobs: JobQueue;
  signer: JobSigner;
  auth: Auth;
  tenancy: TenancyService;
  platform: PlatformService;
  inbox: InboxService;
  outbound: OutboundDeps;
  contacts: ContactsService;
  consent: ConsentService;
  templates: TemplatesService;
  /** Null until the Meta app is configured (WhatsApp connection is then reported unavailable). */
  meta: MetaConfig | null;
  onboarding: OnboardingService | null;
  /** Null until Razorpay is configured (card payments are then reported unavailable). */
  razorpay: RazorpayConfig | null;
  billing: BillingService;
  events: TenantEventHub;
  shutdown(): Promise<void>;
}

async function init(): Promise<Runtime> {
  const config = loadWebConfig();
  const logger = createLogger({ name: 'w360-web', level: config.LOG_LEVEL });
  const trustedProxies = parseTrustedProxies(config.TRUSTED_PROXIES);
  const keyring = Keyring.fromEnv(
    config.W360_ENCRYPTION_KEYS,
    config.W360_ENCRYPTION_PRIMARY_KEY_ID,
  );

  const appPool = createPool({
    connectionString: config.DATABASE_URL_APP,
    max: config.DATABASE_POOL_MAX_APP,
    applicationName: 'w360-web',
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
  });
  const authPool = createPool({
    connectionString: config.DATABASE_URL_AUTH,
    max: config.DATABASE_POOL_MAX_AUTH,
    applicationName: 'w360-web-auth',
  });
  const platformPool = createPool({
    connectionString: config.DATABASE_URL_PLATFORM,
    max: config.DATABASE_POOL_MAX_PLATFORM,
    applicationName: 'w360-web-platform',
  });

  const strict = config.NODE_ENV === 'production';
  for (const pool of [appPool, authPool, platformPool]) {
    await assertRuntimeRoleSafety(pool, { strict, warn: (m) => logger.warn(m) });
  }

  const db = createDatabase(appPool);
  const platformDb = createPlatformDatabase(platformPool);

  // Producer-only pg-boss instance: no maintenance, no schema changes, no scheduling.
  const boss = new PgBoss({
    connectionString: config.DATABASE_URL_APP,
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    max: 2,
    application_name: 'w360-web-jobs',
  });
  boss.on('error', (error: unknown) => logger.error({ err: error }, 'pg-boss error'));
  await boss.start();

  const jobs = new PgBossJobQueue(boss);
  const signer = new JobSigner(config.W360_JOB_SIGNING_KEY);
  const outbox = { keyring, jobs, signer };
  const auth = createAuth({ config, authPool, db, outbox, logger });

  const tenancy = createTenancyService({
    ...outbox,
    db,
    clock: systemClock,
    appBaseUrl: config.APP_BASE_URL,
    invitationTtlHours: config.INVITATION_TTL_HOURS,
  });
  const platform = createPlatformService({ db, platformDb, clock: systemClock });
  const inbox = createInboxService({ db, clock: systemClock });
  const outbound: OutboundDeps = { db, jobs, signer, clock: systemClock };
  const contacts = createContactsService({ db, clock: systemClock });
  const consent = createConsentService({ db, clock: systemClock });
  const templates = createTemplatesService({ db, jobs, signer, clock: systemClock });
  const meta = metaConfigFrom(config);
  const onboarding = meta
    ? createOnboardingService({
        db,
        keyring,
        jobs,
        signer,
        clock: systemClock,
        graph: new GraphClient({ baseUrl: meta.graphBaseUrl, version: meta.graphApiVersion }),
        meta,
      })
    : null;
  const razorpay = razorpayConfigFrom(config);
  const billing = createBillingService({
    db,
    clock: systemClock,
    razorpay: razorpay
      ? new RazorpayClient({
          baseUrl: razorpay.apiBaseUrl,
          keyId: razorpay.keyId,
          keySecret: razorpay.keySecret,
        })
      : null,
    razorpayConfig: razorpay,
    notices: { outbox, appBaseUrl: config.APP_BASE_URL },
  });
  const events = createTenantEventHub({ connectionString: config.DATABASE_URL_APP, logger });

  logger.info({ env: config.APP_ENV }, 'web runtime initialised');

  return {
    config,
    logger,
    clock: systemClock,
    trustedProxies,
    keyring,
    db,
    jobs,
    signer,
    auth,
    tenancy,
    platform,
    inbox,
    outbound,
    contacts,
    consent,
    templates,
    meta,
    onboarding,
    razorpay,
    billing,
    events,
    async shutdown() {
      await events.close();
      await boss.stop({ graceful: true, timeout: 10_000 });
      await Promise.allSettled([appPool.end(), authPool.end(), platformPool.end()]);
    },
  };
}

const holder = globalThis as unknown as { __w360Runtime?: Promise<Runtime> };

export function getRuntime(): Promise<Runtime> {
  if (!holder.__w360Runtime) {
    holder.__w360Runtime = init().catch((error: unknown) => {
      holder.__w360Runtime = undefined;
      throw error;
    });
  }
  return holder.__w360Runtime;
}
