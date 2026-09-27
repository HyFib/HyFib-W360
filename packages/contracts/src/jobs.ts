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
   * for a durable row, so duplicate signals collapse). 'standard': no key uniqueness.
   */
  policy: 'standard' | 'exclusive';
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
  deadLetter: {
    name: 'dead-letter',
    policy: 'standard',
    retryLimit: 0,
    retryDelaySeconds: 0,
    retryBackoff: false,
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
