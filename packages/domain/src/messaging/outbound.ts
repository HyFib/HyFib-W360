import { z } from 'zod';
import {
  AppError,
  clipText,
  forbidden,
  notFound,
  uuidv7,
  type Clock,
  type Keyring,
} from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  campaignRecipients,
  campaigns,
  channelAccounts,
  contactIdentities,
  contacts,
  conversations,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  mediaObjects,
  messageStatusEvents,
  messageTemplates,
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
import { endRunForHuman, signalRunOfBotMessage } from '../automations/runs';
import { recountedCounters } from '../campaigns/counters';
import {
  PROVIDER_MARKETING_OPT_OUT_CODE,
  checkTemplateEligibility,
  recordProviderMarketingOptOut,
} from '../consent/service';
import { phoneFromWaId, waRecipientFromPhone } from '../contacts/phone';
import { csatSendBlock } from '../inbox/csat';
import { slowReplySendBlock, slowReplyWaitEnded } from '../inbox/slow-reply';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import {
  buildTemplateSend,
  linkValuesProblem,
  sendSpecFor,
  templateParamsSchema,
} from '../templates/definition';
import { markTemplateFromSendError } from '../templates/service';
import { requestAccessCheck } from './access';
import { credentialAad } from './credentials';
import { emitTenantEvent } from './events';
import type { GraphClient } from './graph';
import { takeToken } from './rate-limit';
import { STATUS_RANK, providerStatusToMessageStatus } from './status';

/** Meta template send errors (M-063/M-094): template paused, template disabled. */
const TEMPLATE_PAUSED_CODE = 132015;
const TEMPLATE_DISABLED_CODE = 132016;

export const SERVICE_WINDOW_MS = 24 * 3600_000;

export const sendTextSchema = z.object({
  conversationId: z.uuid(),
  text: z
    .string()
    .trim()
    .min(1, 'Type a message')
    .max(4096, 'Messages are limited to 4096 characters'),
  clientKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  /**
   * The newest message the member had seen when writing. If another member replied after it, the
   * send is refused once so the member can read that reply first (collision warning).
   */
  afterMessageId: z.uuid().optional(),
});

export { credentialAad } from './credentials';

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
 * What a reply holds: the message's type and content, the type's part of the Graph message (such as
 * `{ text: … }` or `{ document: … }`) and the conversation's preview.
 */
export interface ReplyBody {
  type: 'text' | 'image' | 'video' | 'audio' | 'document';
  content: Record<string, unknown>;
  payload: Record<string, unknown>;
  preview: string;
  /** A file HyFib uploaded to WhatsApp for this reply (ADR-218), recorded as the message's media. */
  media?: { providerMediaId: string; mimeType: string; filename: string | null; sizeBytes: number };
}

/** The conversation a member replies in, if they can see it; locked when `lock`. */
async function replyConversation(
  tx: Tx,
  ctx: TenantContext,
  conversationId: string,
  lock: boolean,
) {
  const query = tx
    .select({
      id: conversations.id,
      assignedMembershipId: conversations.assignedMembershipId,
      lastInboundAt: conversations.lastInboundAt,
      channelAccountId: conversations.channelAccountId,
      contactId: conversations.contactId,
    })
    .from(conversations)
    .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)));
  // Locking serialises replies with assignment changes.
  const [row] = lock ? await query.for('update') : await query;
  if (!row || !canSeeConversation(ctx, row.assignedMembershipId)) throw notFound('Conversation');
  return row;
}

/**
 * Where a reply in the conversation goes, or why it cannot: the number must be active, the 24-hour
 * window open and the contact known by a WhatsApp number on the number's account.
 */
async function replyRoute(
  tx: Tx,
  ctx: TenantContext,
  conv: Awaited<ReturnType<typeof replyConversation>>,
  now: Date,
) {
  const [channel] = await tx
    .select({
      status: channelAccounts.status,
      whatsappAccountId: channelAccounts.whatsappAccountId,
      phoneNumberId: channelAccounts.phoneNumberId,
    })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, ctx.tenant.id),
        eq(channelAccounts.id, conv.channelAccountId),
      ),
    );
  if (!channel) throw notFound('Conversation');
  if (channel.status !== 'active') {
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
  // A contact can have more than one identity on an account (one known by user id only, or two
  // after a merge, ADR-224): the reply goes to the number of the one WhatsApp updated last.
  const [identity] = await tx
    .select({ waId: contactIdentities.waId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.tenantId, ctx.tenant.id),
        eq(contactIdentities.contactId, conv.contactId),
        eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
        isNotNull(contactIdentities.waId),
      ),
    )
    .orderBy(desc(contactIdentities.updatedAt), desc(contactIdentities.id))
    .limit(1);
  if (!identity?.waId) {
    throw new AppError(
      'unsupported',
      'This contact is known only by a WhatsApp user id. Sending to user ids is not enabled until Meta’s request format is verified.',
    );
  }
  return {
    whatsappAccountId: channel.whatsappAccountId,
    phoneNumberId: channel.phoneNumberId,
    waId: identity.waId,
  };
}

/**
 * Checks, without writing, that the member could reply in the conversation now, and gives the
 * number and account a file for the reply is uploaded with (ADR-218). `queueReply` checks again.
 */
export async function prepareReply(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: TenantContext,
  conversationId: string,
) {
  assertCan(ctx, 'inbox.reply');
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const conv = await replyConversation(tx, ctx, conversationId, false);
      return replyRoute(tx, ctx, conv, deps.clock.now());
    },
    { accessMode: 'read only' },
  );
}

/**
 * Queues a member's reply in a conversation. Idempotent per client key: resubmitting the same
 * submission returns the existing message instead of creating a duplicate.
 */
export async function queueReply(
  deps: OutboundDeps,
  ctx: TenantContext,
  data: { conversationId: string; clientKey: string; afterMessageId?: string | undefined },
  body: ReplyBody,
) {
  assertCan(ctx, 'inbox.reply');
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    const [existing] = await tx
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(and(eq(messages.tenantId, ctx.tenant.id), eq(messages.clientKey, data.clientKey)));
    if (existing) return { messageId: existing.id, duplicate: true };

    const conv = await replyConversation(tx, ctx, data.conversationId, true);
    if (data.afterMessageId) {
      // Under the conversation lock, so two members replying at once cannot both miss the other.
      const collision = await tx.execute<{ name: string | null }>(sql`
        select u.name
          from app.messages m
          join app.messages seen on seen.tenant_id = m.tenant_id and seen.id = ${data.afterMessageId}::uuid
                                and seen.conversation_id = m.conversation_id
          left join app.memberships ms on ms.tenant_id = m.tenant_id and ms.id = m.sender_membership_id
          left join auth.users u on u.id = ms.user_id
         where m.tenant_id = ${ctx.tenant.id}::uuid and m.conversation_id = ${conv.id}::uuid
           and m.direction = 'outbound' and m.sender_type = 'agent'
           and m.sender_membership_id is distinct from ${ctx.membership.id}::uuid
           and (m.created_at, m.id) > (seen.created_at, seen.id)
         order by m.created_at desc
         limit 1`);
      const other = collision.rows[0];
      if (other) {
        throw new AppError(
          'conflict',
          `${other.name ?? 'Another member'} replied after you opened this conversation. Read the latest messages, then send again.`,
          { details: { collision: true } },
        );
      }
    }
    const route = await replyRoute(tx, ctx, conv, now);

    // A member's reply ends an automation handling the conversation, and bot messages not yet
    // handed to the sender are cancelled, so the bot and the member never answer at once.
    await endRunForHuman(tx, {
      tenantId: ctx.tenant.id,
      conversationId: conv.id,
      reason: 'agent_replied',
      actorMembershipId: ctx.membership.id,
      now,
    });
    const messageId = uuidv7();
    const intentId = uuidv7();
    const request = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: route.waId,
      type: body.type,
      ...body.payload,
    };
    await tx.insert(messages).values({
      id: messageId,
      tenantId: ctx.tenant.id,
      conversationId: conv.id,
      channelAccountId: conv.channelAccountId,
      direction: 'outbound',
      type: body.type,
      content: body.content,
      status: 'queued',
      statusRank: STATUS_RANK.queued,
      senderType: 'agent',
      senderMembershipId: ctx.membership.id,
      clientKey: data.clientKey,
    });
    if (body.media) {
      await tx.insert(mediaObjects).values({
        id: uuidv7(),
        tenantId: ctx.tenant.id,
        messageId,
        providerMediaId: body.media.providerMediaId,
        mimeType: body.media.mimeType,
        filename: body.media.filename,
        sizeBytes: body.media.sizeBytes,
      });
    }
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
        lastMessagePreview: clipText(body.preview, 200),
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
  return queueReply(deps, ctx, data, {
    type: 'text',
    content: { text: data.text },
    payload: { text: { body: data.text, preview_url: false } },
    preview: data.text,
  });
}

export const sendTemplateSchema = z.object({
  contactId: z.uuid(),
  channelAccountId: z.uuid(),
  templateId: z.uuid(),
  params: templateParamsSchema,
  clientKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
});

async function lockConversationFor(
  tx: Tx,
  tenantId: string,
  channelAccountId: string,
  contactId: string,
) {
  await tx
    .insert(conversations)
    .values({ id: uuidv7(), tenantId, channelAccountId, contactId })
    .onConflictDoNothing();
  const [row] = await tx
    .select({
      id: conversations.id,
      assignedMembershipId: conversations.assignedMembershipId,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.channelAccountId, channelAccountId),
        eq(conversations.contactId, contactId),
      ),
    )
    .for('update');
  if (!row) throw new Error('Conversation upsert failed');
  return row;
}

/**
 * Queues an approved template to one contact (business-initiated; allowed outside the 24-hour
 * window). Utility templates need `inbox.reply` or `campaigns.send`; marketing templates need
 * `campaigns.send`. Consent and suppression are checked now and again right before dispatch.
 * Idempotent per client key.
 */
export async function queueTemplateMessage(deps: OutboundDeps, ctx: TenantContext, input: unknown) {
  const parsed = sendTemplateSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid message', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const data = parsed.data;
  if (!can(ctx, 'inbox.reply') && !can(ctx, 'campaigns.send')) assertCan(ctx, 'inbox.reply');
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.tenantId, ctx.tenant.id), eq(messages.clientKey, data.clientKey)));
    if (existing) return { messageId: existing.id, duplicate: true };

    const [template] = await tx
      .select()
      .from(messageTemplates)
      .where(
        and(eq(messageTemplates.tenantId, ctx.tenant.id), eq(messageTemplates.id, data.templateId)),
      );
    if (!template) throw notFound('Template');
    if (template.category === 'MARKETING' && !can(ctx, 'campaigns.send')) {
      throw forbidden('Sending marketing templates needs the campaign sending permission.');
    }
    if (template.status !== 'approved') {
      throw new AppError('precondition_failed', 'Only templates approved by Meta can be sent.');
    }
    const spec = sendSpecFor(template.category, template.components);
    if (!spec.supported) throw new AppError('unsupported', spec.reason);
    if (
      data.params.header.length !== spec.headerParams ||
      data.params.body.length !== spec.bodyParams ||
      data.params.buttons.length !== spec.buttonParams
    ) {
      throw new AppError('validation_failed', 'Fill in every variable of the template.');
    }
    const linkProblem = linkValuesProblem(spec.definition, data.params.buttons);
    if (linkProblem) {
      throw new AppError('validation_failed', linkProblem.message, {
        issues: [{ path: `params.buttons.${linkProblem.index}`, message: linkProblem.message }],
      });
    }

    const [channel] = await tx
      .select({
        status: channelAccounts.status,
        whatsappAccountId: channelAccounts.whatsappAccountId,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenant.id),
          eq(channelAccounts.id, data.channelAccountId),
        ),
      );
    if (!channel) throw notFound('WhatsApp number');
    if (channel.whatsappAccountId !== template.whatsappAccountId) {
      throw new AppError(
        'validation_failed',
        'This template belongs to another WhatsApp account than the chosen number.',
      );
    }
    if (channel.status !== 'active') {
      throw new AppError(
        'precondition_failed',
        'This WhatsApp number is not active. Reconnect it in Settings → Channels.',
      );
    }

    const [contact] = await tx
      .select({ id: contacts.id, phone: contacts.phoneE164, erasedAt: contacts.erasedAt })
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, data.contactId)));
    if (!contact) throw notFound('Contact');
    const [identity] = await tx
      .select({ waId: contactIdentities.waId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.tenantId, ctx.tenant.id),
          eq(contactIdentities.contactId, contact.id),
          eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
          sql`${contactIdentities.waId} is not null`,
        ),
      )
      .orderBy(desc(contactIdentities.updatedAt), desc(contactIdentities.id))
      .limit(1);
    const recipientPhone = phoneFromWaId(identity?.waId) ?? contact.phone;
    if (!recipientPhone) {
      throw new AppError('precondition_failed', 'This contact has no phone number to send to.');
    }
    const eligibility = await checkTemplateEligibility(tx, {
      tenantId: ctx.tenant.id,
      contactId: contact.id,
      recipientPhones: [recipientPhone],
      category: template.category,
    });
    if (!eligibility.ok) throw new AppError('precondition_failed', eligibility.message);

    const conv = await lockConversationFor(tx, ctx.tenant.id, data.channelAccountId, contact.id);
    if (!can(ctx, 'campaigns.send') && !canSeeConversation(ctx, conv.assignedMembershipId)) {
      throw notFound('Contact');
    }
    await endRunForHuman(tx, {
      tenantId: ctx.tenant.id,
      conversationId: conv.id,
      reason: 'agent_replied',
      actorMembershipId: ctx.membership.id,
      now,
    });
    const built = buildTemplateSend(template, spec, data.params);
    const messageId = uuidv7();
    const intentId = uuidv7();
    const request = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waRecipientFromPhone(recipientPhone),
      type: 'template',
      template: built.template,
    };
    await tx.insert(messages).values({
      id: messageId,
      tenantId: ctx.tenant.id,
      conversationId: conv.id,
      channelAccountId: data.channelAccountId,
      direction: 'outbound',
      type: 'template',
      content: {
        template: {
          id: template.id,
          name: template.name,
          language: template.language,
          category: template.category,
        },
        rendered: built.rendered,
      },
      status: 'queued',
      statusRank: STATUS_RANK.queued,
      senderType: 'agent',
      senderMembershipId: ctx.membership.id,
      clientKey: data.clientKey,
      templateId: template.id,
    });
    await tx.insert(sendIntents).values({
      id: intentId,
      tenantId: ctx.tenant.id,
      messageId,
      channelAccountId: data.channelAccountId,
      request,
      actorUserId: ctx.user.id,
    });
    // An agent who starts a thread takes it; campaign senders without inbox access do not.
    const claim = conv.assignedMembershipId === null && can(ctx, 'inbox.reply');
    await tx
      .update(conversations)
      .set({
        lastMessageAt: now,
        lastMessagePreview: clipText(built.rendered.body, 200),
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
      { singletonKey: intentId, group: { id: data.channelAccountId } },
    );
    return { messageId, conversationId: conv.id, duplicate: false };
  });
}

/**
 * Records the WhatsApp id Meta resolved a template recipient to, so the customer's replies join
 * this contact even when that id differs from the number we sent to.
 */
async function linkIdentityFromSend(
  tx: Tx,
  input: { tenantId: string; whatsappAccountId: string; contactId: string; waId: string },
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${input.tenantId}|${input.whatsappAccountId}|w:${input.waId}`}, 7361))`,
  );
  await tx
    .insert(contactIdentities)
    .values({
      id: uuidv7(),
      tenantId: input.tenantId,
      contactId: input.contactId,
      whatsappAccountId: input.whatsappAccountId,
      waId: input.waId,
    })
    .onConflictDoNothing();
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
  /** An automation run waiting for a bot message is signalled when its send is settled. */
  jobs: JobQueue;
  signer: JobSigner;
}

/** Intent states after which a send will not change any more (an automation may move on). */
const SETTLED_STATES: ReadonlySet<string> = new Set([
  'accepted',
  'failed',
  'canceled',
  'unknown_outcome',
]);

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
        contactId: conversations.contactId,
        messageType: messages.type,
        templateId: messages.templateId,
        campaignId: messages.campaignId,
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
    // A campaign message waits for its campaign: once the campaign is paused or cancelled (for
    // example a send that went back to the queue after a retryable error), it is not sent.
    if (ctx.campaignId) {
      const [campaign] = await tx
        .select({ status: campaigns.status })
        .from(campaigns)
        .where(and(eq(campaigns.tenantId, scope.tenantId), eq(campaigns.id, ctx.campaignId)));
      if (campaign?.status === 'paused' || campaign?.status === 'canceled') {
        const paused = campaign.status === 'paused';
        const code = paused ? 'campaign_paused' : 'campaign_canceled';
        const reason = paused
          ? 'Not sent: the campaign was paused.'
          : 'Not sent: the campaign was cancelled.';
        await tx
          .update(sendIntents)
          .set({
            state: 'canceled',
            leaseUntil: null,
            resolvedAt: now,
            lastErrorCode: code,
            lastError: reason,
          })
          .where(and(eq(sendIntents.tenantId, scope.tenantId), eq(sendIntents.id, intentId)));
        await tx
          .update(messages)
          .set({
            status: 'canceled',
            statusRank: STATUS_RANK.canceled,
            statusAt: now,
            errorCode: code,
            errorTitle: reason,
          })
          .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.id, current.messageId)));
        // A paused campaign sends this recipient again when resumed (counters are recomputed then).
        await tx
          .update(campaignRecipients)
          .set(
            paused
              ? {
                  state: 'pending',
                  messageId: null,
                  queuedAt: null,
                  market: null,
                  estimatedCostMicros: null,
                }
              : { state: 'canceled' },
          )
          .where(
            and(
              eq(campaignRecipients.tenantId, scope.tenantId),
              eq(campaignRecipients.messageId, current.messageId),
            ),
          );
        await emitTenantEvent(tx, scope.tenantId, {
          type: 'message.status',
          conversationId: ctx.conversationId,
          payload: { messageId: current.messageId },
        });
        return { kind: 'campaign_stopped' as const };
      }
    }
    // The automatic reply when members are slow (ADR-384) is cancelled once its wait ended (a
    // member answered, the conversation was resolved or an automation took it over), so a send
    // put off meanwhile (a number reconnecting, a retry) never reaches the customer after the answer.
    if (
      ctx.messageType === 'text' &&
      (await slowReplyWaitEnded(tx, { tenantId: scope.tenantId, messageId: current.messageId }))
    ) {
      const code = 'slow_reply_answered';
      const reason = 'Not sent: the customer was answered, or their wait ended, first.';
      await tx
        .update(sendIntents)
        .set({
          state: 'canceled',
          leaseUntil: null,
          resolvedAt: now,
          lastErrorCode: code,
          lastError: reason,
        })
        .where(and(eq(sendIntents.tenantId, scope.tenantId), eq(sendIntents.id, intentId)));
      await tx
        .update(messages)
        .set({
          status: 'canceled',
          statusRank: STATUS_RANK.canceled,
          statusAt: now,
          errorCode: code,
          errorTitle: reason,
        })
        .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.id, current.messageId)));
      await emitTenantEvent(tx, scope.tenantId, {
        type: 'message.status',
        conversationId: ctx.conversationId,
        payload: { messageId: current.messageId },
      });
      return { kind: 'slow_reply_canceled' as const };
    }
    // Business-initiated templates: re-check the template and the contact's consent now, under
    // the intent's row lock, so an opt-out recorded after queueing still stops the send.
    let blocked: { code: string; message: string } | null = null;
    if (ctx.messageType === 'template' && ctx.templateId) {
      const [template] = await tx
        .select({ status: messageTemplates.status, category: messageTemplates.category })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.tenantId, scope.tenantId),
            eq(messageTemplates.id, ctx.templateId),
          ),
        );
      if (!template || template.status !== 'approved') {
        blocked = {
          code: 'template_not_approved',
          message: `The template is ${template?.status ?? 'missing'}; the message was not sent.`,
        };
      } else {
        const to = (current.request as { to?: unknown }).to;
        const recipient = typeof to === 'string' ? phoneFromWaId(to) : null;
        const eligibility = await checkTemplateEligibility(tx, {
          tenantId: scope.tenantId,
          contactId: ctx.contactId,
          recipientPhones: recipient ? [recipient] : [],
          category: template.category,
        });
        if (!eligibility.ok) blocked = { code: eligibility.code, message: eligibility.message };
      }
    }
    // A CSAT survey (interactive message) is sent only while the contact still accepts
    // non-marketing messages; an opt-out after the resolve stops it here.
    if (!blocked && ctx.messageType === 'interactive') {
      const to = (current.request as { to?: unknown }).to;
      blocked = await csatSendBlock(tx, {
        tenantId: scope.tenantId,
        messageId: current.messageId,
        contactId: ctx.contactId,
        recipient: typeof to === 'string' ? phoneFromWaId(to) : null,
      });
    }
    // The automatic reply when members are slow (ADR-384), likewise: an opt-out, a suppression or
    // an erasure after it was queued stops it here.
    if (!blocked && ctx.messageType === 'text') {
      const to = (current.request as { to?: unknown }).to;
      blocked = await slowReplySendBlock(tx, {
        tenantId: scope.tenantId,
        messageId: current.messageId,
        contactId: ctx.contactId,
        recipient: typeof to === 'string' ? phoneFromWaId(to) : null,
      });
    }
    return { kind: 'claimed' as const, intent: current, ...ctx, blocked };
  });
  if (outcome.kind === 'not_due') {
    return {
      outcome: 'retry_scheduled',
      retryAt: outcome.retryAt,
      channelAccountId: outcome.channelAccountId,
    };
  }
  if (outcome.kind === 'campaign_stopped' || outcome.kind === 'slow_reply_canceled') {
    return { outcome: 'canceled' };
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
      if (intentUpdate.state && SETTLED_STATES.has(intentUpdate.state)) {
        await signalRunOfBotMessage(deps, tx, {
          tenantId: scope.tenantId,
          messageId: intent.messageId,
          key: `s:${intent.messageId}:${intentUpdate.state}`,
        });
      }
    });
  };

  const fail = (code: string, reason: string, extra?: (tx: Tx) => Promise<void>) =>
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
      extra,
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
  if (claimed.blocked) {
    await fail(claimed.blocked.code, claimed.blocked.message);
    return { outcome: 'failed' };
  }
  const isTemplate = claimed.messageType === 'template';
  if (
    !isTemplate &&
    (!claimed.lastInboundAt ||
      deps.clock.now().getTime() - claimed.lastInboundAt.getTime() > SERVICE_WINDOW_MS)
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
      async (tx) => {
        await applyEarlyStatuses(
          tx,
          scope.tenantId,
          intent.messageId,
          intent.channelAccountId,
          wamid,
        );
        if (isTemplate && result.data.waId) {
          await linkIdentityFromSend(tx, {
            tenantId: scope.tenantId,
            whatsappAccountId: claimed.whatsappAccountId,
            contactId: claimed.contactId,
            waId: result.data.waId,
          });
        }
      },
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
    await deps.db.run(scope, async (tx) => {
      await tx
        .update(channelAccounts)
        .set({ status: 'needs_reconnect' })
        .where(
          and(
            eq(channelAccounts.tenantId, scope.tenantId),
            eq(channelAccounts.id, intent.channelAccountId),
          ),
        );
      // Meta refused the token: check the account's access at once (ADR-137).
      await requestAccessCheck(tx, scope.tenantId, claimed.whatsappAccountId, deps.clock.now());
    });
  }
  const code = result.code;
  await fail(
    String(code ?? result.httpStatus ?? result.kind),
    result.detail ?? result.title,
    async (tx) => {
      const at = deps.clock.now();
      if (code === PROVIDER_MARKETING_OPT_OUT_CODE) {
        await recordProviderMarketingOptOut(tx, {
          tenantId: scope.tenantId,
          contactId: claimed.contactId,
          channelAccountId: intent.channelAccountId,
          externalMessageId: null,
          occurredAt: at,
          providerTime: false,
        });
      }
      if (
        claimed.templateId &&
        (code === TEMPLATE_PAUSED_CODE || code === TEMPLATE_DISABLED_CODE)
      ) {
        await markTemplateFromSendError(
          tx,
          scope.tenantId,
          claimed.templateId,
          code === TEMPLATE_PAUSED_CODE ? 'paused' : 'disabled',
          at,
        );
      }
    },
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
  deps: { db: Database; clock: Clock; jobs: JobQueue; signer: JobSigner },
  scope: TenantScope,
  intentId: string,
): Promise<'requeued' | 'unknown_outcome' | 'untouched'> {
  const { db, clock } = deps;
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
    await signalRunOfBotMessage(deps, tx, {
      tenantId: scope.tenantId,
      messageId: intent.messageId,
      key: `s:${intent.messageId}:unknown_outcome`,
    });
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
 * Stops an intent that must not be sent any more (company suspended, sender removed); nothing is
 * sent. A member's message is marked failed with a reason the agent can see; a campaign message is
 * cancelled and its recipient returned to the campaign (see below).
 */
export async function cancelSendIntent(
  db: Database,
  scope: TenantScope,
  intentId: string,
  reason: { code: 'company_suspended' | 'sender_removed'; message: string },
  clock: Clock,
): Promise<boolean> {
  return db.run(scope, async (tx) => {
    const [target] = await tx
      .select({ messageId: sendIntents.messageId, campaignId: messages.campaignId })
      .from(sendIntents)
      .innerJoin(
        messages,
        and(eq(messages.tenantId, sendIntents.tenantId), eq(messages.id, sendIntents.messageId)),
      )
      .where(and(eq(sendIntents.tenantId, scope.tenantId), eq(sendIntents.id, intentId)));
    if (!target) return false;
    // A campaign send locks its campaign first, in the runner's order, so a concurrent tick or
    // pause cannot deadlock with this cancellation.
    const [campaign] = target.campaignId
      ? await tx
          .select({ status: campaigns.status })
          .from(campaigns)
          .where(and(eq(campaigns.tenantId, scope.tenantId), eq(campaigns.id, target.campaignId)))
          .for('update')
      : [];
    const now = clock.now();
    const [intent] = await tx
      .update(sendIntents)
      .set({
        state: 'canceled',
        leaseUntil: null,
        resolvedAt: now,
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
        // A campaign message never left, so it is cancelled and its recipient sent again later; a
        // member's message is shown as failed with the reason.
        status: campaign ? 'canceled' : 'failed',
        statusRank: campaign ? STATUS_RANK.canceled : STATUS_RANK.failed,
        statusAt: now,
        errorCode: reason.code,
        errorTitle: reason.message,
      })
      .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.id, intent.messageId)))
      .returning({ conversationId: messages.conversationId });
    if (campaign && target.campaignId) {
      // The recipient goes back to pending, so the campaign sends it when it runs again (another
      // member resumes it, or the company is reactivated) unless its deadline expires it first. A
      // finished or cancelled campaign will not run again, so the recipient is cancelled.
      const ended = campaign.status === 'completed' || campaign.status === 'canceled';
      await tx
        .update(campaignRecipients)
        .set(
          ended
            ? { state: 'canceled' }
            : {
                state: 'pending',
                messageId: null,
                queuedAt: null,
                market: null,
                estimatedCostMicros: null,
              },
        )
        .where(
          and(
            eq(campaignRecipients.tenantId, scope.tenantId),
            eq(campaignRecipients.messageId, intent.messageId),
          ),
        );
      await tx
        .update(campaigns)
        .set(recountedCounters(scope.tenantId, target.campaignId))
        .where(and(eq(campaigns.tenantId, scope.tenantId), eq(campaigns.id, target.campaignId)));
    }
    await emitTenantEvent(tx, scope.tenantId, {
      type: 'message.status',
      conversationId: message?.conversationId ?? null,
      payload: { messageId: intent.messageId },
    });
    return true;
  });
}
