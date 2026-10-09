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
  /**
   * Minutes a job may wait for a worker before the queue is late and platform staff are emailed
   * (ADR-096); `DEFAULT_MAX_WAIT_MINUTES` when not given. Longer only for queues of long jobs run
   * one or two at a time, where a burst of work waits by design.
   */
  maxWaitMinutes?: number;
}

/** A job normally starts within seconds; one waiting this long means the queue is not keeping up. */
export const DEFAULT_MAX_WAIT_MINUTES = 15;

/** Minutes a queue's jobs may wait before the queue is late (ADR-096). */
export const queueMaxWaitMinutes = (queue: QueueDefinition): number =>
  queue.maxWaitMinutes ?? DEFAULT_MAX_WAIT_MINUTES;

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
  /**
   * Sends the operations alerts' posts to the platform's chat channel (ADR-338): every minute, and
   * when an alert or a test post is queued; one queued and one active run. It claims the posts due
   * from the database, so its payload carries nothing it trusts; each post records its attempts.
   */
  alertPosts: {
    name: 'ops.alert-posts',
    policy: 'stately',
    retryLimit: 1,
    retryDelaySeconds: 30,
    retryBackoff: false,
    expireInSeconds: 300,
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
   * Asks Razorpay for a refund of a plan payment a platform owner requested (ADR-103), or checks one
   * Razorpay is processing. As for refunds of service credit, provider failures leave the request
   * due again for the minute sweep; the job itself retries only unexpected errors.
   */
  billingPlanPaymentRefund: {
    name: 'billing.plan-payment-refund',
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
    maxWaitMinutes: 60,
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
  /**
   * Deletes a template at Meta. A repeat is harmless, so it retries for 4 to 5 hours; a deletion
   * still pending after that is settled by the minute sweep (ADR-111).
   */
  templateDelete: {
    name: 'template.delete',
    policy: 'exclusive',
    retryLimit: 10,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 3600,
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
    maxWaitMinutes: 60,
  },
  /**
   * Checks a WhatsApp account's access with `debug_token` (ADR-137). A check that cannot be made is
   * recorded and the minute sweep signals the account again after 30 minutes, so only a failure of
   * the job itself is retried here.
   */
  whatsappAccessCheck: {
    name: 'whatsapp.access_check',
    policy: 'exclusive',
    retryLimit: 2,
    retryDelaySeconds: 60,
    retryBackoff: true,
    retryDelayMaxSeconds: 600,
    expireInSeconds: 120,
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
  /** The email to a member mentioned in a note who has not opened it (ADR-211), due later. */
  noteMention: {
    name: 'note.mention',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 600,
    expireInSeconds: 60,
    deadLetter: 'dead-letter',
    deleteAfterHours: 72,
  },
  /**
   * A read receipt (kind `message.read`) or a typing indicator (`message.typing`) for a customer's
   * message (ADR-223). Short-lived: a typing indicator is worth nothing a minute later.
   */
  messageRead: {
    name: 'message.read',
    policy: 'exclusive',
    retryLimit: 2,
    retryDelaySeconds: 5,
    retryBackoff: true,
    retryDelayMaxSeconds: 30,
    expireInSeconds: 60,
    deadLetter: 'dead-letter',
    deleteAfterHours: 24,
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
    maxWaitMinutes: 60,
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
  /**
   * Checks a company's Razorpay keys against Razorpay. A read, so it retries for 1.5 to 2 hours;
   * keys still being checked after that are settled by the minute sweep (ADR-111).
   */
  commerceAccount: {
    name: 'commerce.account',
    policy: 'exclusive',
    retryLimit: 8,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 1800,
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
    maxWaitMinutes: 60,
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
    maxWaitMinutes: 60,
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
  /**
   * The id of the key that signed the envelope (ADR-135), outside the signature so that releases
   * before it, which drop unknown fields, still verify it. Absent from envelopes signed before.
   */
  kid: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  sig: z.string().regex(/^[0-9a-f]{64}$/),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
