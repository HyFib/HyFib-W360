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
  pgBossErrorContext,
  RazorpayClient,
  createAccountService,
  createApiKeysService,
  createWebhooksService,
  createApiWebhookEndpoints,
  createAutomationService,
  createCommerceService,
  createStoreService,
  createStoreMessagesService,
  createCrmService,
  createBillingService,
  createPlanRefundRequestsService,
  createRefundRequestsService,
  createBillingHistoryService,
  createBusinessHoursService,
  createCampaignsService,
  createCsatService,
  createGrowthService,
  createFlowsService,
  createReportEmailsService,
  createReportsService,
  createConsentService,
  createSetupChecklistService,
  createContactMergeService,
  createContactsService,
  createEmailPreferencesService,
  createInboxService,
  createPresenceService,
  createReceivedMediaService,
  createFileRepliesService,
  createOnboardingService,
  createPlanAdminService,
  createPlanAddOnsService,
  createPlanChangeService,
  createPlanChoicesService,
  createPriceListService,
  createPlanSubscriptionService,
  createPlansService,
  createPlatformService,
  createPlatformBillingService,
  createPlatformReconciliationService,
  createBillingUsageService,
  createPlatformOpsService,
  createAlertChannelService,
  pgBossQueueInspector,
  createRateCardsService,
  createSavedRepliesService,
  createConversationTagsService,
  createReadReceiptsService,
  createSegmentsService,
  createTeamsService,
  createTemplatesService,
  createTenancyService,
  createCompanyDeletionService,
  createWebRequestService,
  writeCompanyExport,
  type AccountService,
  type CompanyDeletionService,
  type RequestMeta,
  type TenantContext,
  type ApiKeysService,
  type WebhooksService,
  type ApiWebhookEndpoints,
  type AutomationService,
  type CommerceService,
  type CrmService,
  type BillingService,
  type BillingHistoryService,
  type PlanRefundRequestsService,
  type PlanAddOnsService,
  type PlanChangeService,
  type PriceListService,
  type PlanChoicesService,
  type RefundRequestsService,
  type BusinessHoursService,
  type CampaignNoticeDeps,
  type CampaignsService,
  type CsatService,
  type GrowthService,
  type ReportEmailsService,
  type ReportsService,
  type ConsentService,
  type SetupChecklistService,
  type ContactMergeService,
  type ContactsService,
  type EmailPreferencesService,
  type InboxService,
  type PresenceService,
  type ReceivedMediaService,
  type FileRepliesService,
  type JobQueue,
  type OnboardingService,
  type OutboundDeps,
  type PlanAdminService,
  type PlanSubscriptionService,
  type PlansService,
  type PlatformService,
  type PlatformBillingService,
  type PlatformReconciliationService,
  type BillingUsageService,
  type PlatformOpsService,
  type AlertChannelService,
  type RateCardsService,
  type SavedRepliesService,
  type ConversationTagsService,
  type ReadReceiptsService,
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
  /** The signed-in person's own account: their sign-in history (ADR-136). */
  account: AccountService;
  tenancy: TenancyService;
  /** Deleting the company after its grace period (Settings → Company data). */
  companyDeletion: CompanyDeletionService;
  /** Streams the company export through `write` (Settings → Company data). */
  companyExport: (
    ctx: TenantContext,
    write: (chunk: string) => Promise<void>,
    meta?: RequestMeta,
  ) => Promise<{ counts: Record<string, number> }>;
  platform: PlatformService;
  /** The platform operations console (/platform/ops): content-free facts and two audited repairs. */
  platformOps: PlatformOpsService;
  /** Operations → Alerts: the chat channel the operations alerts are posted to (ADR-338). */
  alertChannel: AlertChannelService;
  /** Companies' service credit for platform staff, and refunds of unused credit (ADR-058). */
  platformBilling: PlatformBillingService;
  /** Daily settlement reconciliation with Razorpay, for platform staff (ADR-059). */
  platformReconciliation: PlatformReconciliationService;
  /** Billing → Usage and rates: Meta's rates and this month's estimate (ADR-060). */
  billingUsage: BillingUsageService;
  inbox: InboxService;
  /** Members who have a conversation open (ADR-243). */
  presence: PresenceService;
  /** Files customers send, fetched from WhatsApp per request (ADR-216); null without Meta. */
  receivedMedia: ReceivedMediaService | null;
  /** Files members send from the inbox, uploaded to WhatsApp (ADR-218); null without Meta. */
  fileReplies: FileRepliesService | null;
  /** The Graph client for files: uploads through the API (ADR-219); null without Meta. */
  mediaGraph: GraphClient | null;
  emailPreferences: EmailPreferencesService;
  teams: TeamsService;
  businessHours: BusinessHoursService;
  savedReplies: SavedRepliesService;
  /** Tags members put on conversations (ADR-220). */
  conversationTags: ConversationTagsService;
  /** Read receipts and typing indicators to customers (ADR-223). */
  readReceipts: ReadReceiptsService;
  csat: CsatService;
  outbound: OutboundDeps;
  /** Emails to the members who can approve a campaign waiting for approval (ADR-204). */
  campaignNotices: CampaignNoticeDeps;
  contacts: ContactsService;
  /** Merging two contacts into one (ADR-224). */
  contactMerges: ContactMergeService;
  consent: ConsentService;
  /** The company's setup checklist (ADR-233). */
  setup: SetupChecklistService;
  templates: TemplatesService;
  segments: SegmentsService;
  campaigns: CampaignsService;
  rateCards: RateCardsService;
  /** The company's plan, its limits and usage (ADR-051). */
  plans: PlansService;
  /** The plan catalog and companies' plans (platform staff). */
  planAdmin: PlanAdminService;
  /** Company API keys for the public API (Settings → API keys). */
  apiKeys: ApiKeysService;
  /** Company webhook endpoints and their deliveries (Settings → Webhooks). */
  webhooks: WebhooksService;
  /** Webhook endpoints API keys add and manage (ADR-081). */
  apiWebhookEndpoints: ApiWebhookEndpoints;
  reports: ReportsService;
  reportEmails: ReportEmailsService;
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
  /** Paying for plans with Razorpay Subscriptions (ADR-063). */
  planPayments: PlanSubscriptionService;
  billingHistory: BillingHistoryService;
  /** Refunds of unused credit asked for by the company (ADR-073). */
  refundRequests: RefundRequestsService;
  planRefundRequests: PlanRefundRequestsService;
  /** Choosing the plan a company pays for (ADR-105). */
  planChoices: PlanChoicesService;
  /** A company choosing its add-ons (ADR-106). */
  planAddOns: PlanAddOnsService;
  /** What a paying company can change its plan to from the end of the paid period (ADR-109). */
  planChanges: PlanChangeService;
  /** The public price list of offered plan versions (ADR-107). */
  priceList: PriceListService;
  events: TenantEventHub;
  shutdown(): Promise<void>;
}

/**
 * HyFib's limit on a company endpoint's answer to a flow request. Meta's own wait for the data
 * endpoint is not documented in our research; this leaves time for decryption and encryption.
 */
const FLOW_ENDPOINT_TIMEOUT_MS = 7_000;

async function init(): Promise<Runtime> {
  const config = getWebConfig();
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
  boss.on('error', (error: unknown) =>
    logger.error({ err: error, ...pgBossErrorContext(error) }, 'pg-boss error'),
  );
  await boss.start();

  const jobs = new PgBossJobQueue(boss);
  // During a job signing key rotation, the next or previous key is accepted too (ADR-135).
  const signer = new JobSigner(config.W360_JOB_SIGNING_KEY, {
    next: config.W360_JOB_SIGNING_KEY_NEXT,
    previous: config.W360_JOB_SIGNING_KEY_PREVIOUS,
  });
  const outbox = { keyring, jobs, signer };
  const auth = createAuth({ config, authPool, db, outbox, logger });

  const tenancy = createTenancyService({
    ...outbox,
    db,
    clock: systemClock,
    appBaseUrl: config.APP_BASE_URL,
    invitationTtlHours: config.INVITATION_TTL_HOURS,
  });
  const companyDeletion = createCompanyDeletionService({
    ...outbox,
    db,
    clock: systemClock,
    appBaseUrl: config.APP_BASE_URL,
  });
  const exportDeps = { ...outbox, db, clock: systemClock, appBaseUrl: config.APP_BASE_URL };
  const companyExport: Runtime['companyExport'] = (ctx, write, meta) =>
    writeCompanyExport(exportDeps, ctx, write, meta);
  const account = createAccountService({ db });
  const platform = createPlatformService({ db, platformDb, clock: systemClock });
  const platformOps = createPlatformOpsService({
    platformDb,
    queues: pgBossQueueInspector(boss),
    clock: systemClock,
    keyring,
    jobSigning: signer,
  });
  const alertChannel = createAlertChannelService({
    platformDb,
    keyring,
    jobs,
    signer,
    // http:// and loopback channels only where configuration allows them (local and test).
    egressPolicy: { allowLoopbackForTests: config.W360_EGRESS_ALLOW_LOOPBACK ?? false },
    appBaseUrl: config.APP_BASE_URL,
  });
  const platformBilling = createPlatformBillingService({ platformDb });
  const platformReconciliation = createPlatformReconciliationService({ platformDb });
  const billingUsage = createBillingUsageService({ db, clock: systemClock });
  const inbox = createInboxService({ db, clock: systemClock, jobs, signer });
  const presence = createPresenceService({ db, clock: systemClock });
  const emailPreferences = createEmailPreferencesService({ db });
  const teams = createTeamsService({ db, clock: systemClock });
  const businessHours = createBusinessHoursService({ db, clock: systemClock });
  const savedReplies = createSavedRepliesService({ db, clock: systemClock });
  const conversationTags = createConversationTagsService({ db });
  const readReceipts = createReadReceiptsService({ db, clock: systemClock, jobs, signer });
  const csat = createCsatService({ db, clock: systemClock });
  const outbound: OutboundDeps = { db, jobs, signer, clock: systemClock };
  const contacts = createContactsService({ db, clock: systemClock });
  const contactMerges = createContactMergeService({ db, clock: systemClock });
  const consent = createConsentService({ db, clock: systemClock });
  const setup = createSetupChecklistService({ db, clock: systemClock });
  const templates = createTemplatesService({ db, jobs, signer, clock: systemClock });
  const segments = createSegmentsService({ db, clock: systemClock });
  const campaignNotices: CampaignNoticeDeps = { outbox, appBaseUrl: config.APP_BASE_URL };
  const campaigns = createCampaignsService({
    db,
    jobs,
    signer,
    clock: systemClock,
    notices: campaignNotices,
  });
  const rateCards = createRateCardsService({ platformDb, clock: systemClock });
  const razorpay = razorpayConfigFrom(config);
  const razorpayClient = razorpay
    ? new RazorpayClient({
        baseUrl: razorpay.apiBaseUrl,
        keyId: razorpay.keyId,
        keySecret: razorpay.keySecret,
      })
    : null;
  const plans = createPlansService({ db, clock: systemClock });
  const planAdmin = createPlanAdminService({
    platformDb,
    clock: systemClock,
    razorpay: razorpayClient,
  });
  const apiKeys = createApiKeysService({ db, clock: systemClock });
  // http:// and loopback endpoints only where configuration allows them (local and test).
  const webhookEgress = { allowLoopbackForTests: config.W360_EGRESS_ALLOW_LOOPBACK ?? false };
  const webhooks = createWebhooksService({
    db,
    clock: systemClock,
    keyring,
    egressPolicy: webhookEgress,
  });
  const apiWebhookEndpoints = createApiWebhookEndpoints({
    ...outbox,
    db,
    clock: systemClock,
    egressPolicy: webhookEgress,
    appBaseUrl: config.APP_BASE_URL,
  });
  const reports = createReportsService({ db, clock: systemClock });
  const reportEmails = createReportEmailsService({ db, clock: systemClock });
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
  const mediaGraph = meta
    ? new GraphClient({ baseUrl: meta.graphBaseUrl, version: meta.graphApiVersion })
    : null;
  const receivedMedia = mediaGraph
    ? createReceivedMediaService({ db, keyring, graph: mediaGraph })
    : null;
  const fileReplies = mediaGraph
    ? createFileRepliesService({
        db,
        jobs,
        signer,
        clock: systemClock,
        keyring,
        graph: mediaGraph,
      })
    : null;
  const billing = createBillingService({
    db,
    clock: systemClock,
    razorpay: razorpayClient,
    razorpayConfig: razorpay,
    notices: { outbox, appBaseUrl: config.APP_BASE_URL },
  });
  const planPayments = createPlanSubscriptionService({
    db,
    clock: systemClock,
    razorpay: razorpayClient,
    razorpayConfig: razorpay,
    notices: { outbox, appBaseUrl: config.APP_BASE_URL },
  });
  const billingHistory = createBillingHistoryService({ db, clock: systemClock });
  const refundRequests = createRefundRequestsService({ db, clock: systemClock });
  const planRefundRequests = createPlanRefundRequestsService({ db, clock: systemClock });
  const planChoices = createPlanChoicesService({
    db,
    clock: systemClock,
    subscriptionsEnabled: Boolean(razorpayClient && razorpay?.subscriptionsEnabled),
  });
  const planAddOns = createPlanAddOnsService({
    db,
    clock: systemClock,
    subscriptionsEnabled: Boolean(razorpayClient && razorpay?.subscriptionsEnabled),
  });
  const planChanges = createPlanChangeService({
    db,
    clock: systemClock,
    subscriptionsEnabled: Boolean(razorpayClient && razorpay?.subscriptionsEnabled),
  });
  const priceList = createPriceListService({
    db,
    subscriptionsEnabled: Boolean(razorpayClient && razorpay?.subscriptionsEnabled),
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
    account,
    tenancy,
    companyDeletion,
    companyExport,
    platform,
    platformOps,
    alertChannel,
    platformBilling,
    platformReconciliation,
    billingUsage,
    inbox,
    presence,
    receivedMedia,
    fileReplies,
    mediaGraph,
    emailPreferences,
    teams,
    businessHours,
    savedReplies,
    conversationTags,
    readReceipts,
    csat,
    outbound,
    campaignNotices,
    contacts,
    contactMerges,
    consent,
    setup,
    templates,
    segments,
    campaigns,
    rateCards,
    plans,
    planAdmin,
    apiKeys,
    webhooks,
    apiWebhookEndpoints,
    reports,
    reportEmails,
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
    planPayments,
    billingHistory,
    refundRequests,
    planRefundRequests,
    planChoices,
    planAddOns,
    planChanges,
    priceList,
    events,
    async shutdown() {
      await events.close();
      await boss.stop({ graceful: true, timeout: 10_000 });
      await Promise.allSettled([appPool.end(), authPool.end(), platformPool.end()]);
    },
  };
}

const holder = globalThis as unknown as {
  __w360Runtime?: Promise<Runtime>;
  __w360WebConfig?: WebConfig;
};

/**
 * The web tier's configuration alone, read once per process: for the pages that need nothing else
 * (the API reference, ADR-152), which render without the database.
 */
export function getWebConfig(): WebConfig {
  holder.__w360WebConfig ??= loadWebConfig();
  return holder.__w360WebConfig;
}

export function getRuntime(): Promise<Runtime> {
  if (!holder.__w360Runtime) {
    holder.__w360Runtime = init().catch((error: unknown) => {
      holder.__w360Runtime = undefined;
      throw error;
    });
  }
  return holder.__w360Runtime;
}
