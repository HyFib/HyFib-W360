import { z } from 'zod';

/**
 * Durable job queues shared by web (producers) and worker (consumers). Queues are created at
 * deploy time by the migration command (owner role); runtime roles only enqueue and process.
 *
 * Every payload is wrapped in a signed envelope (see @w360/domain jobs/envelope). A tenant id in a
 * payload is never trusted on its own: workers verify the signature, then load the referenced
 * row under that tenant's RLS scope, so a forged or mismatched tenant id finds nothing.
 */
export interface QueueDefinition {
  name: string;
  /**
   * 'exclusive': at most one created/retry/active job per singletonKey (used as a wake-up signal
   * for a durable row, so duplicate signals collapse). 'stately': at most one queued and one active
   * job per singletonKey, so a signal that arrives while a job runs queues one successor.
   * 'standard': no key uniqueness.
   */
  policy: 'standard' | 'exclusive' | 'stately';
  retryLimit: number;
  retryDelaySeconds: number;
  retryBackoff: boolean;
  retryDelayMaxSeconds?: number;
  expireInSeconds: number;
  deadLetter?: string;
  /** Hours to keep completed jobs for diagnostics. */
  deleteAfterHours: number;
}

export const QUEUES = {
  emailSend: {
    name: 'email.send',
    policy: 'exclusive',
    retryLimit: 8,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 3600,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
    deleteAfterHours: 72,
  },
  outboxSweep: {
    name: 'ops.outbox-sweep',
    policy: 'exclusive',
    retryLimit: 1,
    retryDelaySeconds: 30,
    retryBackoff: false,
    expireInSeconds: 120,
    deleteAfterHours: 24,
  },
  webhookProcess: {
    name: 'webhook.process',
    policy: 'exclusive',
    retryLimit: 10,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retryDelayMaxSeconds: 1800,
    expireInSeconds: 300,
    deadLetter: 'dead-letter',
    deleteAfterHours: 72,
  },
  messageSend: {
    name: 'message.send',
    policy: 'exclusive',
    retryLimit: 12,
    retryDelaySeconds: 5,
    retryBackoff: true,
    retryDelayMaxSeconds: 900,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
    deleteAfterHours: 72,
  },
  channelOnboard: {
    name: 'channel.onboard',
    policy: 'exclusive',
    retryLimit: 8,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 3600,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
    deleteAfterHours: 168,
  },
  messagingSweep: {
    name: 'ops.messaging-sweep',
    policy: 'exclusive',
    retryLimit: 1,
    retryDelaySeconds: 30,
    retryBackoff: false,
    expireInSeconds: 120,
    deleteAfterHours: 24,
  },
  billingEventProcess: {
    name: 'billing.event-process',
    policy: 'exclusive',
    retryLimit: 10,
    retryDelaySeconds: 15,
    retryBackoff: true,
    retryDelayMaxSeconds: 1800,
    expireInSeconds: 300,
    deadLetter: 'dead-letter',
    deleteAfterHours: 168,
  },
  autoRecharge: {
    name: 'billing.auto-recharge',
    policy: 'exclusive',
    retryLimit: 0,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 300,
    deadLetter: 'dead-letter',
    deleteAfterHours: 168,
  },
  /**
   * Asks Razorpay for a refund a platform owner requested (ADR-058), or checks one Razorpay is
   * processing. Provider failures leave the request due again for the minute sweep; the job itself
   * retries only unexpected errors.
   */
  billingCreditRefund: {
    name: 'billing.credit-refund',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 60,
    retryBackoff: true,
    retryDelayMaxSeconds: 1800,
    expireInSeconds: 300,
    deadLetter: 'dead-letter',
    deleteAfterHours: 168,
  },
  /**
   * One attempt at a day's settlement reconciliation (ADR-059). The run row is the source of truth:
   * Razorpay failures leave it due again for the minute sweep, and a job that dies leaves its lease
   * to expire, so the job itself retries only once.
   */
  billingSettlementRecon: {
    name: 'billing.settlement-recon',
    policy: 'exclusive',
    retryLimit: 1,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 900,
    deadLetter: 'dead-letter',
    deleteAfterHours: 168,
  },
  billingSweep: {
    name: 'ops.billing-sweep',
    policy: 'exclusive',
    retryLimit: 1,
    retryDelaySeconds: 30,
    retryBackoff: false,
    expireInSeconds: 240,
    deleteAfterHours: 24,
  },
  templateSubmit: {
    name: 'template.submit',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 900,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
    deleteAfterHours: 168,
  },
  templateDelete: {
    name: 'template.delete',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 900,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
    deleteAfterHours: 168,
  },
  templateSync: {
    name: 'template.sync',
    policy: 'exclusive',
    retryLimit: 3,
    retryDelaySeconds: 60,
    retryBackoff: true,
    retryDelayMaxSeconds: 900,
    expireInSeconds: 300,
    deadLetter: 'dead-letter',
    deleteAfterHours: 72,
  },
  campaignRun: {
    name: 'campaign.run',
    policy: 'exclusive',
    retryLimit: 3,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retryDelayMaxSeconds: 120,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
    deleteAfterHours: 24,
  },
  automationRun: {
    name: 'automation.run',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 5,
    retryBackoff: true,
    retryDelayMaxSeconds: 300,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
    deleteAfterHours: 72,
  },
  /**
   * Makes one automation HTTP call. Retrying the job is safe: only a queued call is ever claimed
   * and sent, so a retry after the claim never sends the request twice.
   */
  automationHttp: {
    name: 'automation.http',
    policy: 'exclusive',
    retryLimit: 3,
    retryDelaySeconds: 5,
    retryBackoff: true,
    retryDelayMaxSeconds: 60,
    expireInSeconds: 60,
    deadLetter: 'dead-letter',
    deleteAfterHours: 72,
  },
  /**
   * Delivers a company's due webhook deliveries (ADR-053). Woken by the capture triggers' notifications
   * and by the minute sweep; one queued and one active job per company. Each attempt is recorded on
   * its delivery, so a retried job never repeats a finished delivery.
   */
  webhookDeliver: {
    name: 'webhook.deliver',
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retryDelayMaxSeconds: 60,
    expireInSeconds: 300,
    deadLetter: 'dead-letter',
    deleteAfterHours: 24,
  },
  crmReminder: {
    name: 'crm.reminder',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 600,
    expireInSeconds: 60,
    deadLetter: 'dead-letter',
    deleteAfterHours: 72,
  },
  /** One operation on a WhatsApp flow at Meta (create, upload, publish, deprecate, delete, refresh). */
  flowSync: {
    name: 'flow.sync',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 900,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
    deleteAfterHours: 168,
  },
  /** Generates, uploads and checks a WhatsApp account's flow encryption key. */
  flowKeys: {
    name: 'flow.keys',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 900,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
    deleteAfterHours: 168,
  },
  /** Reads a WhatsApp account's catalogs and their products from Meta (reads only). */
  commerceSync: {
    name: 'commerce.sync',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 900,
    expireInSeconds: 300,
    deadLetter: 'dead-letter',
    deleteAfterHours: 168,
  },
  /** Advances one Payment Link at Razorpay: create it once, cancel it, or fetch its status. */
  commerceLink: {
    name: 'commerce.link',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 900,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
    deleteAfterHours: 168,
  },
  /** Checks a company's Razorpay keys against Razorpay. */
  commerceAccount: {
    name: 'commerce.account',
    policy: 'exclusive',
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 300,
    expireInSeconds: 60,
    deadLetter: 'dead-letter',
    deleteAfterHours: 72,
  },
  /**
   * One store's work under a lease on its row: finishing a connection, reading what webhooks
   * signalled, the incremental read, webhook checks and removal (store connectors).
   */
  commerceStore: {
    name: 'commerce.store',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 900,
    expireInSeconds: 300,
    deadLetter: 'dead-letter',
    deleteAfterHours: 72,
  },
  /**
   * One order message at its send time: checks the rule, the order, the template and the
   * customer's consent, then queues the chat message (order messages). The row is the source of
   * truth; the minute sweep signals any message whose job was lost.
   */
  commerceStoreMessage: {
    name: 'commerce.store-message',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 900,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
    deleteAfterHours: 72,
  },
  /**
   * Deletes a company whose 14-day grace period has ended (ADR-055): cleans up at providers,
   * deletes its rows a batch per transaction and leaves a tombstone. A run stops after a few
   * minutes of work; the next signal (a retry or the minute billing sweep) continues from where it
   * stopped, because every step is recorded in the database.
   */
  tenantDelete: {
    name: 'tenant.delete',
    policy: 'exclusive',
    retryLimit: 10,
    retryDelaySeconds: 60,
    retryBackoff: true,
    retryDelayMaxSeconds: 1800,
    expireInSeconds: 900,
    deadLetter: 'dead-letter',
    deleteAfterHours: 24 * 7,
  },
  // Jobs that failed all their retries. The worker records each one in ops.dead_letters (ADR-054);
  // a recording that fails is retried, and the job stays in pg-boss for its retention either way.
  deadLetter: {
    name: 'dead-letter',
    policy: 'standard',
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 600,
    expireInSeconds: 60,
    deleteAfterHours: 24 * 30,
  },
} as const satisfies Record<string, QueueDefinition>;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]['name'];

export const ALL_QUEUES: QueueDefinition[] = Object.values(QUEUES);

/** Signed envelope carried in every job's data. */
export const jobEnvelopeSchema = z.object({
  v: z.literal(1),
  kind: z.string().min(1).max(64),
  tenantId: z.uuid().nullable(),
  actorUserId: z.string().min(1).max(200).nullable(),
  ref: z.string().min(1).max(200),
  issuedAt: z.number().int().positive(),
  sig: z.string().regex(/^[0-9a-f]{64}$/),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
