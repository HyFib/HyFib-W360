import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock, type Keyring } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  channelAccounts,
  contactIdentities,
  conversations,
  desc,
  eq,
  inArray,
  isNull,
  messageStatusEvents,
  messages,
  or,
  sendIntents,
  sql,
  systemScope,
  whatsappAccounts,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from './events';
import type { GraphClient } from './graph';
import { takeToken } from './rate-limit';
import { STATUS_RANK, providerStatusToMessageStatus } from './status';

export const SERVICE_WINDOW_MS = 24 * 3600_000;

export const sendTextSchema = z.object({
  conversationId: z.uuid(),
  text: z
    .string()
    .trim()
    .min(1, 'Type a message')
    .max(4096, 'Messages are limited to 4096 characters'),
  clientKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
});

export function credentialAad(tenantId: string, whatsappAccountId: string): string {
  return `tenant:${tenantId}|whatsapp_account:${whatsappAccountId}`;
}

export interface OutboundDeps {
  db: Database;
  jobs: JobQueue;
  signer: JobSigner;
  clock: Clock;
}

/** Visibility rule shared by inbox reads and writes. */
export function canSeeConversation(
  ctx: TenantContext,
  assignedMembershipId: string | null,
): boolean {
  if (can(ctx, 'inbox.read_all')) return true;
  if (!can(ctx, 'inbox.read_assigned')) return false;
  return assignedMembershipId === null || assignedMembershipId === ctx.membership.id;
}

/**
 * Queues a free-form text reply. Idempotent per client key: resubmitting the same composer
 * submission returns the existing message instead of creating a duplicate.
 */
export async function queueTextMessage(deps: OutboundDeps, ctx: TenantContext, input: unknown) {
  assertCan(ctx, 'inbox.reply');
  const parsed = sendTextSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid message', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const data = parsed.data;
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    const [existing] = await tx
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(and(eq(messages.tenantId, ctx.tenant.id), eq(messages.clientKey, data.clientKey)));
    if (existing) return { messageId: existing.id, duplicate: true };

    // Lock the conversation row (serialises replies with assignment changes), then read its number.
    const [locked] = await tx
      .select({
        id: conversations.id,
        assignedMembershipId: conversations.assignedMembershipId,
        lastInboundAt: conversations.lastInboundAt,
        channelAccountId: conversations.channelAccountId,
        contactId: conversations.contactId,
      })
      .from(conversations)
      .where(
        and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, data.conversationId)),
      )
      .for('update');
    if (!locked || !canSeeConversation(ctx, locked.assignedMembershipId))
      throw notFound('Conversation');
    const [channel] = await tx
      .select({
        status: channelAccounts.status,
        whatsappAccountId: channelAccounts.whatsappAccountId,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenant.id),
          eq(channelAccounts.id, locked.channelAccountId),
        ),
      );
    if (!channel) throw notFound('Conversation');
    const conv = {
      ...locked,
      channelStatus: channel.status,
      whatsappAccountId: channel.whatsappAccountId,
    };
    if (conv.channelStatus !== 'active') {
      throw new AppError(
        'precondition_failed',
        'This WhatsApp number is not active. Reconnect it in Settings → Channels.',
      );
    }
    if (!conv.lastInboundAt || now.getTime() - conv.lastInboundAt.getTime() > SERVICE_WINDOW_MS) {
      throw new AppError(
        'precondition_failed',
        'The 24-hour customer service window has closed. Only approved templates can be sent now.',
      );
    }
    const [identity] = await tx
      .select({ waId: contactIdentities.waId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.tenantId, ctx.tenant.id),
          eq(contactIdentities.contactId, conv.contactId),
          eq(contactIdentities.whatsappAccountId, conv.whatsappAccountId),
        ),
      )
      .limit(1);
    if (!identity?.waId) {
      throw new AppError(
        'unsupported',
        'This contact is known only by a WhatsApp user id. Sending to user ids is not enabled until Meta’s request format is verified.',
      );
    }

    const messageId = uuidv7();
    const intentId = uuidv7();
    const request = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: identity.waId,
      type: 'text',
      text: { body: data.text, preview_url: false },
    };
    await tx.insert(messages).values({
      id: messageId,
      tenantId: ctx.tenant.id,
      conversationId: conv.id,
      channelAccountId: conv.channelAccountId,
      direction: 'outbound',
      type: 'text',
      content: { text: data.text },
      status: 'queued',
      statusRank: STATUS_RANK.queued,
      senderType: 'agent',
      senderMembershipId: ctx.membership.id,
      clientKey: data.clientKey,
    });
    await tx.insert(sendIntents).values({
      id: intentId,
      tenantId: ctx.tenant.id,
      messageId,
      channelAccountId: conv.channelAccountId,
      request,
      actorUserId: ctx.user.id,
    });
    const claim = conv.assignedMembershipId === null;
    await tx
      .update(conversations)
      .set({
        lastMessageAt: now,
        lastMessagePreview: data.text.slice(0, 200),
        unreadCount: 0,
        status: 'open',
        ...(claim ? { assignedMembershipId: ctx.membership.id } : {}),
        version: sql`${conversations.version} + 1`,
      })
      .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conv.id)));
    await emitTenantEvent(tx, ctx.tenant.id, {
      type: 'message.created',
      conversationId: conv.id,
      assignedMembershipId: claim ? ctx.membership.id : conv.assignedMembershipId,
      payload: { messageId },
    });
    await deps.jobs.enqueue(
      tx,
      QUEUES.messageSend.name,
      deps.signer.sign({
        kind: 'message.send',
        tenantId: ctx.tenant.id,
        actorUserId: ctx.user.id,
        ref: intentId,
      }),
      { singletonKey: intentId, group: { id: conv.channelAccountId } },
    );
    return { messageId, duplicate: false };
  });
}

export type SendOutcome =
  | 'accepted'
  | 'failed'
  | 'canceled'
  | 'retry_scheduled'
  | 'unknown_outcome'
  | 'deferred'
  | 'not_claimable';

/**
 * `retryAt` tells the worker when to signal the intent again (retries and deferrals);
 * `channelAccountId` keeps the new signal in the number's fairness group.
 */
export interface SendResult {
  outcome: SendOutcome;
  retryAt?: Date;
  channelAccountId?: string;
}

export interface SendWorkerDeps {
  db: Database;
  keyring: Keyring;
  graph: GraphClient;
  clock: Clock;
  rate: { capacity: number; refillPerSecond: number };
}

const SEND_LEASE_MS = 60_000;
const MAX_ATTEMPTS = 12;

function backoffMs(attempt: number): number {
  const base = Math.min(15 * 60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

/**
 * Worker side of an outbound send. `scope` comes from `authorizeJob` (signature, company status,
 * actor membership verified). Policy is re-checked here, at send time, not only when queued.
 */
export async function processSendIntent(
  deps: SendWorkerDeps,
  scope: TenantScope,
  intentId: string,
): Promise<SendResult> {
  const now = deps.clock.now();
  const outcome = await deps.db.run(scope, async (tx) => {
    const [current] = await tx
      .select()
      .from(sendIntents)
      .where(and(eq(sendIntents.tenantId, scope.tenantId), eq(sendIntents.id, intentId)))
      .for('update');
    if (!current || (current.state !== 'queued' && current.state !== 'deferred'))
      return { kind: 'not_claimable' as const };
    if (current.nextAttemptAt > now) {
      return {
        kind: 'not_due' as const,
        retryAt: current.nextAttemptAt,
        channelAccountId: current.channelAccountId,
      };
    }
    await tx
      .update(sendIntents)
      .set({ state: 'sending', leaseUntil: new Date(now.getTime() + SEND_LEASE_MS), sentAt: null })
      .where(and(eq(sendIntents.tenantId, scope.tenantId), eq(sendIntents.id, intentId)));
    const [ctx] = await tx
      .select({
        messageStatus: messages.status,
        conversationId: messages.conversationId,
        channelStatus: channelAccounts.status,
        phoneNumberId: channelAccounts.phoneNumberId,
        whatsappAccountId: channelAccounts.whatsappAccountId,
        credential: whatsappAccounts.credentialCiphertext,
        lastInboundAt: conversations.lastInboundAt,
      })
      .from(messages)
      .innerJoin(
        channelAccounts,
        and(
          eq(channelAccounts.tenantId, messages.tenantId),
          eq(channelAccounts.id, messages.channelAccountId),
        ),
      )
      .innerJoin(
        whatsappAccounts,
        and(
          eq(whatsappAccounts.tenantId, channelAccounts.tenantId),
          eq(whatsappAccounts.id, channelAccounts.whatsappAccountId),
        ),
      )
      .innerJoin(
        conversations,
        and(
          eq(conversations.tenantId, messages.tenantId),
          eq(conversations.id, messages.conversationId),
        ),
      )
      .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.id, current.messageId)));
    if (!ctx) throw new Error('Send intent refers to a missing message');
    return { kind: 'claimed' as const, intent: current, ...ctx };
  });
  if (outcome.kind === 'not_due') {
    return {
      outcome: 'retry_scheduled',
      retryAt: outcome.retryAt,
      channelAccountId: outcome.channelAccountId,
    };
  }
  if (outcome.kind !== 'claimed') return { outcome: 'not_claimable' };
  const claimed = outcome;
  const { intent } = claimed;
  const attempt = intent.attempts + 1;

  const settle = async (
    intentUpdate: Partial<typeof sendIntents.$inferInsert>,
    messageUpdate: Partial<typeof messages.$inferInsert> | null,
    eventType: string,
    extra?: (tx: Tx) => Promise<void>,
  ) => {
    await deps.db.run(scope, async (tx) => {
      await tx
        .update(sendIntents)
        .set({ leaseUntil: null, ...intentUpdate })
        .where(and(eq(sendIntents.tenantId, scope.tenantId), eq(sendIntents.id, intentId)));
      if (messageUpdate) {
        await tx
          .update(messages)
          .set(messageUpdate)
          .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.id, intent.messageId)));
      }
      if (extra) await extra(tx);
      await emitTenantEvent(tx, scope.tenantId, {
        type: eventType,
        conversationId: claimed.conversationId,
        payload: { messageId: intent.messageId },
      });
    });
  };

  const fail = (code: string, reason: string) =>
    settle(
      {
        state: 'failed',
        resolvedAt: deps.clock.now(),
        lastErrorCode: code.slice(0, 32),
        lastError: reason.slice(0, 1000),
      },
      {
        status: 'failed',
        statusRank: STATUS_RANK.failed,
        statusAt: deps.clock.now(),
        errorCode: code.slice(0, 32),
        errorTitle: reason.slice(0, 500),
      },
      'message.status',
    );

  // Send-time policy checks.
  if (claimed.messageStatus === 'canceled') {
    await settle({ state: 'canceled', resolvedAt: deps.clock.now() }, null, 'message.status');
    return { outcome: 'canceled' };
  }
  if (claimed.channelStatus !== 'active') {
    const retryAt = new Date(deps.clock.now().getTime() + 5 * 60_000);
    await settle(
      {
        state: 'deferred',
        nextAttemptAt: retryAt,
        lastErrorCode: 'channel_inactive',
        lastError: 'Channel is not active',
      },
      null,
      'message.status',
    );
    return { outcome: 'deferred', retryAt, channelAccountId: intent.channelAccountId };
  }
  if (
    !claimed.lastInboundAt ||
    deps.clock.now().getTime() - claimed.lastInboundAt.getTime() > SERVICE_WINDOW_MS
  ) {
    await fail(
      'window_closed',
      'The 24-hour customer service window closed before the message could be sent.',
    );
    return { outcome: 'failed' };
  }
  if (!claimed.credential) {
    await fail('no_credential', 'The WhatsApp account has no stored credential; reconnect it.');
    return { outcome: 'failed' };
  }
  if (!(await takeToken(deps.db, `meta:pn:${claimed.phoneNumberId}`, deps.rate))) {
    const retryAt = new Date(deps.clock.now().getTime() + 1_000);
    await settle({ state: 'queued', nextAttemptAt: retryAt }, null, 'message.status');
    return { outcome: 'retry_scheduled', retryAt, channelAccountId: intent.channelAccountId };
  }

  // Record the dispatch before the request leaves: a crash after this point is an unknown outcome.
  await deps.db.run(scope, (tx) =>
    tx
      .update(sendIntents)
      .set({ sentAt: deps.clock.now(), attempts: attempt })
      .where(and(eq(sendIntents.tenantId, scope.tenantId), eq(sendIntents.id, intentId))),
  );
  const token = deps.keyring.decryptString(
    claimed.credential,
    credentialAad(scope.tenantId, claimed.whatsappAccountId),
  );
  const result = await deps.graph.sendMessage(claimed.phoneNumberId, token, intent.request);

  if (result.ok) {
    const wamid = result.data.messageId;
    await settle(
      { state: 'accepted', resolvedAt: deps.clock.now(), lastErrorCode: null, lastError: null },
      {
        externalMessageId: wamid,
        status: 'accepted',
        statusRank: STATUS_RANK.accepted,
        statusAt: deps.clock.now(),
      },
      'message.status',
      (tx) =>
        applyEarlyStatuses(tx, scope.tenantId, intent.messageId, intent.channelAccountId, wamid),
    );
    return { outcome: 'accepted' };
  }
  if (result.kind === 'unknown') {
    await settle(
      {
        state: 'unknown_outcome',
        resolvedAt: deps.clock.now(),
        lastErrorCode: 'unknown',
        lastError: `${result.title}${result.detail ? `: ${result.detail}` : ''}`,
      },
      {
        status: 'unknown_outcome',
        statusRank: STATUS_RANK.unknown_outcome,
        statusAt: deps.clock.now(),
      },
      'message.status',
    );
    return { outcome: 'unknown_outcome' };
  }
  if (result.kind === 'retryable' && attempt < MAX_ATTEMPTS) {
    const retryAt = new Date(deps.clock.now().getTime() + backoffMs(attempt));
    await settle(
      {
        state: 'queued',
        sentAt: null,
        nextAttemptAt: retryAt,
        lastErrorCode: String(result.code ?? result.httpStatus ?? 'retryable').slice(0, 32),
        lastError: result.title,
      },
      null,
      'message.status',
    );
    return { outcome: 'retry_scheduled', retryAt, channelAccountId: intent.channelAccountId };
  }
  if (result.kind === 'auth') {
    await deps.db.run(scope, (tx) =>
      tx
        .update(channelAccounts)
        .set({ status: 'needs_reconnect' })
        .where(
          and(
            eq(channelAccounts.tenantId, scope.tenantId),
            eq(channelAccounts.id, intent.channelAccountId),
          ),
        ),
    );
  }
  await fail(
    String(result.code ?? result.httpStatus ?? result.kind),
    result.detail ?? result.title,
  );
  return { outcome: 'failed' };
}

/** Applies status webhooks that arrived before the WAMID was recorded (orphans). */
async function applyEarlyStatuses(
  tx: Tx,
  tenantId: string,
  messageId: string,
  channelAccountId: string,
  wamid: string,
) {
  const early = await tx
    .select({
      status: messageStatusEvents.status,
      providerTimestamp: messageStatusEvents.providerTimestamp,
    })
    .from(messageStatusEvents)
    .where(
      and(
        eq(messageStatusEvents.tenantId, tenantId),
        eq(messageStatusEvents.channelAccountId, channelAccountId),
        eq(messageStatusEvents.externalMessageId, wamid),
      ),
    )
    .orderBy(desc(messageStatusEvents.providerTimestamp));
  let best: { status: ReturnType<typeof providerStatusToMessageStatus>; at: Date } | null = null;
  for (const e of early) {
    const s = providerStatusToMessageStatus(e.status);
    if (s && (!best?.status || STATUS_RANK[s] > STATUS_RANK[best.status]))
      best = { status: s, at: e.providerTimestamp };
  }
  if (best?.status && STATUS_RANK[best.status] > STATUS_RANK.accepted) {
    await tx
      .update(messages)
      .set({ status: best.status, statusRank: STATUS_RANK[best.status], statusAt: best.at })
      .where(and(eq(messages.tenantId, tenantId), eq(messages.id, messageId)));
  }
}

/**
 * Recovery for intents whose worker died: a lease that expired before dispatch is re-queued; one
 * that expired after dispatch (sent_at set) becomes an unknown outcome, never an automatic resend.
 */
export async function recoverExpiredSend(
  db: Database,
  scope: TenantScope,
  intentId: string,
  clock: Clock,
): Promise<'requeued' | 'unknown_outcome' | 'untouched'> {
  return db.run(scope, async (tx) => {
    const [intent] = await tx
      .select()
      .from(sendIntents)
      .where(and(eq(sendIntents.tenantId, scope.tenantId), eq(sendIntents.id, intentId)))
      .for('update');
    if (
      !intent ||
      intent.state !== 'sending' ||
      !intent.leaseUntil ||
      intent.leaseUntil > clock.now()
    )
      return 'untouched';
    if (intent.sentAt === null) {
      await tx
        .update(sendIntents)
        .set({ state: 'queued', leaseUntil: null, nextAttemptAt: clock.now() })
        .where(and(eq(sendIntents.tenantId, scope.tenantId), eq(sendIntents.id, intentId)));
      return 'requeued';
    }
    await tx
      .update(sendIntents)
      .set({
        state: 'unknown_outcome',
        leaseUntil: null,
        resolvedAt: clock.now(),
        lastErrorCode: 'worker_lost',
        lastError: 'Worker stopped after dispatching the request',
      })
      .where(and(eq(sendIntents.tenantId, scope.tenantId), eq(sendIntents.id, intentId)));
    await tx
      .update(messages)
      .set({
        status: 'unknown_outcome',
        statusRank: STATUS_RANK.unknown_outcome,
        statusAt: clock.now(),
      })
      .where(
        and(
          eq(messages.tenantId, scope.tenantId),
          eq(messages.id, intent.messageId),
          or(
            eq(messages.status, 'queued'),
            eq(messages.status, 'sending'),
            isNull(messages.externalMessageId),
          ),
        ),
      );
    return 'unknown_outcome';
  });
}

/**
 * Resolves an unknown outcome by an explicit human decision: either the message is known to have
 * arrived (mark accepted without resending) or the member chooses to send again, accepting the
 * risk of a duplicate. Nothing is resent automatically.
 */
export async function resolveUnknownOutcome(
  deps: OutboundDeps,
  ctx: TenantContext,
  input: { messageId: string; decision: 'mark_sent' | 'resend' },
): Promise<void> {
  assertCan(ctx, 'inbox.reply');
  if (!z.uuid().safeParse(input.messageId).success) throw notFound('Message');
  await deps.db.run(ctx.scope, async (tx) => {
    const [intent] = await tx
      .select({ intentId: sendIntents.id, state: sendIntents.state })
      .from(sendIntents)
      .where(
        and(eq(sendIntents.tenantId, ctx.tenant.id), eq(sendIntents.messageId, input.messageId)),
      )
      .for('update');
    const [context] = intent
      ? await tx
          .select({
            conversationId: messages.conversationId,
            channelAccountId: messages.channelAccountId,
            assigned: conversations.assignedMembershipId,
          })
          .from(messages)
          .innerJoin(
            conversations,
            and(
              eq(conversations.tenantId, messages.tenantId),
              eq(conversations.id, messages.conversationId),
            ),
          )
          .where(and(eq(messages.tenantId, ctx.tenant.id), eq(messages.id, input.messageId)))
      : [];
    if (!intent || !context || !canSeeConversation(ctx, context.assigned))
      throw notFound('Message');
    const row = { ...intent, ...context };
    if (row.state !== 'unknown_outcome')
      throw new AppError('conflict', 'This message is no longer in an unknown state.');
    if (input.decision === 'mark_sent') {
      await tx
        .update(sendIntents)
        .set({
          state: 'accepted',
          resolvedAt: deps.clock.now(),
          lastErrorCode: 'manual_confirmation',
        })
        .where(and(eq(sendIntents.tenantId, ctx.tenant.id), eq(sendIntents.id, row.intentId)));
      await tx
        .update(messages)
        .set({ status: 'sent', statusRank: STATUS_RANK.sent, statusAt: deps.clock.now() })
        .where(and(eq(messages.tenantId, ctx.tenant.id), eq(messages.id, input.messageId)));
    } else {
      await tx
        .update(sendIntents)
        .set({
          state: 'queued',
          sentAt: null,
          nextAttemptAt: deps.clock.now(),
          lastErrorCode: 'manual_resend',
        })
        .where(and(eq(sendIntents.tenantId, ctx.tenant.id), eq(sendIntents.id, row.intentId)));
      await tx
        .update(messages)
        .set({ status: 'queued', statusRank: STATUS_RANK.queued, statusAt: deps.clock.now() })
        .where(and(eq(messages.tenantId, ctx.tenant.id), eq(messages.id, input.messageId)));
      await deps.jobs.enqueue(
        tx,
        QUEUES.messageSend.name,
        deps.signer.sign({
          kind: 'message.send',
          tenantId: ctx.tenant.id,
          actorUserId: ctx.user.id,
          ref: row.intentId,
        }),
        {
          singletonKey: `${row.intentId}:resend:${Date.now()}`,
          group: { id: row.channelAccountId },
        },
      );
    }
    await emitTenantEvent(tx, ctx.tenant.id, {
      type: 'message.status',
      conversationId: row.conversationId,
      payload: { messageId: input.messageId },
    });
  });
}

/** Intents the sweeper must look at: lost signals (overdue queued/deferred) and expired leases. */
export async function findStaleSendIntents(
  db: Database,
  limit = 200,
): Promise<
  { tenantId: string; id: string; actorUserId: string | null; channelAccountId: string }[]
> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{
        tenant_id: string;
        id: string;
        actor_user_id: string | null;
        channel_account_id: string;
      }>(
        sql`select tenant_id, id, actor_user_id, channel_account_id from ops.stale_send_intents(${limit})`,
      );
      return res.rows.map((r) => ({
        tenantId: r.tenant_id,
        id: r.id,
        actorUserId: r.actor_user_id,
        channelAccountId: r.channel_account_id,
      }));
    },
    { accessMode: 'read only' },
  );
}

/**
 * Stops an intent that must not be sent any more (company suspended, sender removed). The message
 * is marked failed with a reason the agent can see; nothing is sent.
 */
export async function cancelSendIntent(
  db: Database,
  scope: TenantScope,
  intentId: string,
  reason: { code: 'company_suspended' | 'sender_removed'; message: string },
  clock: Clock,
): Promise<boolean> {
  return db.run(scope, async (tx) => {
    const [intent] = await tx
      .update(sendIntents)
      .set({
        state: 'canceled',
        leaseUntil: null,
        resolvedAt: clock.now(),
        lastErrorCode: reason.code,
        lastError: reason.message,
      })
      .where(
        and(
          eq(sendIntents.tenantId, scope.tenantId),
          eq(sendIntents.id, intentId),
          inArray(sendIntents.state, ['queued', 'deferred']),
        ),
      )
      .returning({ messageId: sendIntents.messageId });
    if (!intent) return false;
    const [message] = await tx
      .update(messages)
      .set({
        status: 'failed',
        statusRank: STATUS_RANK.failed,
        statusAt: clock.now(),
        errorCode: reason.code,
        errorTitle: reason.message,
      })
      .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.id, intent.messageId)))
      .returning({ conversationId: messages.conversationId });
    await emitTenantEvent(tx, scope.tenantId, {
      type: 'message.status',
      conversationId: message?.conversationId ?? null,
      payload: { messageId: intent.messageId },
    });
    return true;
  });
}
