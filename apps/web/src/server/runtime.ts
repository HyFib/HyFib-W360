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
  shopifyConfigFrom,
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
  createAutomationService,
  createCommerceService,
  createStoreService,
  createStoreMessagesService,
  createCrmService,
  createBillingService,
  createBusinessHoursService,
  createCampaignsService,
  createCsatService,
  createGrowthService,
  createFlowsService,
  createReportsService,
  createConsentService,
  createContactsService,
  createInboxService,
  createOnboardingService,
  createPlanAdminService,
  createPlansService,
  createPlatformService,
  createRateCardsService,
  createSavedRepliesService,
  createSegmentsService,
  createTeamsService,
  createTemplatesService,
  createTenancyService,
  createWebRequestService,
  type AutomationService,
  type CommerceService,
  type CrmService,
  type BillingService,
  type BusinessHoursService,
  type CampaignsService,
  type CsatService,
  type GrowthService,
  type ReportsService,
  type ConsentService,
  type ContactsService,
  type InboxService,
  type JobQueue,
  type OnboardingService,
  type OutboundDeps,
  type PlanAdminService,
  type PlansService,
  type PlatformService,
  type RateCardsService,
  type SavedRepliesService,
  type SegmentsService,
  type TeamsService,
  type TemplatesService,
  type TenancyService,
  type WebRequestService,
  type FlowsService,
  type FlowEndpointDeps,
  type PaymentWebhookDeps,
  type StoreService,
  type StoreMessagesService,
  type StoreWebhookDeps,
} from '@w360/domain';
import { DEFAULT_EGRESS_POLICY, createEgressClient } from '@w360/core/egress';
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
  teams: TeamsService;
  businessHours: BusinessHoursService;
  savedReplies: SavedRepliesService;
  csat: CsatService;
  outbound: OutboundDeps;
  contacts: ContactsService;
  consent: ConsentService;
  templates: TemplatesService;
  segments: SegmentsService;
  campaigns: CampaignsService;
  rateCards: RateCardsService;
  /** The company's plan, its limits and usage (ADR-051). */
  plans: PlansService;
  /** The plan catalog and companies' plans (platform staff). */
  planAdmin: PlanAdminService;
  reports: ReportsService;
  automations: AutomationService;
  /** Domains and secrets for the automation HTTP step. */
  webRequests: WebRequestService;
  /** Click-to-chat links, QR codes, website widgets and conversation sources. */
  growth: GrowthService;
  /** WhatsApp Flows: drafts, Meta lifecycle (through the worker), keys, sending, answers. */
  flows: FlowsService;
  /** The Flows data endpoint (null until the Meta app is configured: requests cannot be verified). */
  flowEndpoint: FlowEndpointDeps | null;
  crm: CrmService;
  /** Catalogs, product messages, orders and Payment Links in the company's own Razorpay account. */
  commerce: CommerceService;
  /** Webhooks from companies' own Razorpay accounts (only signal a fetch of the link). */
  paymentWebhook: PaymentWebhookDeps;
  /** Companies' own Shopify and WooCommerce stores: connections, orders and products read. */
  stores: StoreService;
  /** Order messages: a store's message settings, rules per event and what was sent. */
  storeMessages: StoreMessagesService;
  /** Store webhooks (verified, deduplicated; they only signal what the worker reads). */
  storeWebhook: StoreWebhookDeps;
  /** Null until the Meta app is configured (WhatsApp connection is then reported unavailable). */
  meta: MetaConfig | null;
  onboarding: OnboardingService | null;
  /** Null until Razorpay is configured (card payments are then reported unavailable). */
  razorpay: RazorpayConfig | null;
  billing: BillingService;
  events: TenantEventHub;
  shutdown(): Promise<void>;
}

/**
 * HyFib's limit on a company endpoint's answer to a flow request. Meta's own wait for the data
 * endpoint is not documented in our research; this leaves time for decryption and encryption.
 */
const FLOW_ENDPOINT_TIMEOUT_MS = 7_000;

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
  const inbox = createInboxService({ db, clock: systemClock, jobs, signer });
  const teams = createTeamsService({ db, clock: systemClock });
  const businessHours = createBusinessHoursService({ db, clock: systemClock });
  const savedReplies = createSavedRepliesService({ db, clock: systemClock });
  const csat = createCsatService({ db, clock: systemClock });
  const outbound: OutboundDeps = { db, jobs, signer, clock: systemClock };
  const contacts = createContactsService({ db, clock: systemClock });
  const consent = createConsentService({ db, clock: systemClock });
  const templates = createTemplatesService({ db, jobs, signer, clock: systemClock });
  const segments = createSegmentsService({ db, clock: systemClock });
  const campaigns = createCampaignsService({ db, jobs, signer, clock: systemClock });
  const rateCards = createRateCardsService({ platformDb, clock: systemClock });
  const plans = createPlansService({ db, clock: systemClock });
  const planAdmin = createPlanAdminService({ platformDb, clock: systemClock });
  const reports = createReportsService({ db, clock: systemClock });
  const automations = createAutomationService({
    db,
    clock: systemClock,
    jobs,
    signer,
    // http:// test targets, only where configuration allows loopback egress (local and test).
    allowInsecureHttp: config.W360_EGRESS_ALLOW_LOOPBACK ?? false,
  });
  const webRequests = createWebRequestService({ db, clock: systemClock, keyring });
  const growth = createGrowthService({ db, clock: systemClock });
  const flows = createFlowsService({
    db,
    clock: systemClock,
    jobs,
    signer,
    appBaseUrl: config.APP_BASE_URL,
    allowInsecureHttp: config.W360_EGRESS_ALLOW_LOOPBACK ?? false,
  });
  const crm = createCrmService({ db, clock: systemClock, jobs, signer });
  const commerce = createCommerceService({
    db,
    clock: systemClock,
    jobs,
    signer,
    keyring,
    appBaseUrl: config.APP_BASE_URL,
    // Live keys move real money: only in production (like HyFib's own Razorpay keys).
    allowLiveKeys: config.APP_ENV === 'production',
  });
  const paymentWebhook: PaymentWebhookDeps = { db, keyring, clock: systemClock, jobs, signer };
  const shopify = shopifyConfigFrom(config);
  const stores = createStoreService({
    db,
    clock: systemClock,
    jobs,
    signer,
    keyring,
    appBaseUrl: config.APP_BASE_URL,
    shopify,
    // http:// store addresses only where configuration allows loopback egress (local and test).
    allowHttpStores: config.W360_EGRESS_ALLOW_LOOPBACK ?? false,
  });
  const storeMessages = createStoreMessagesService({
    db,
    clock: systemClock,
    shopifyApiVersion: shopify?.apiVersion ?? null,
  });
  const storeWebhook: StoreWebhookDeps = {
    db,
    keyring,
    clock: systemClock,
    jobs,
    signer,
    shopifySecrets: shopify?.secrets ?? null,
  };
  const meta = metaConfigFrom(config);
  // The Flows data endpoint forwards to companies' endpoints while WhatsApp waits, so it has its
  // own egress client with a shorter time limit (the only addresses chosen by companies that the
  // web tier calls; its other requests go to the fixed Meta and Razorpay origins).
  const flowEndpoint: FlowEndpointDeps | null = meta
    ? {
        db,
        keyring,
        clock: systemClock,
        appSecrets: meta.webhookSecrets,
        egress: createEgressClient({
          ...DEFAULT_EGRESS_POLICY,
          timeoutMs: FLOW_ENDPOINT_TIMEOUT_MS,
          allowLoopbackForTests: config.W360_EGRESS_ALLOW_LOOPBACK ?? false,
        }),
      }
    : null;
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
    teams,
    businessHours,
    savedReplies,
    csat,
    outbound,
    contacts,
    consent,
    templates,
    segments,
    campaigns,
    rateCards,
    plans,
    planAdmin,
    reports,
    automations,
    webRequests,
    growth,
    flows,
    flowEndpoint,
    crm,
    commerce,
    paymentWebhook,
    stores,
    storeMessages,
    storeWebhook,
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
