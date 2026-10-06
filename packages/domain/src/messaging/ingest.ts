import { clipText, parseExternalJson, uuidv7, type Clock, type Keyring } from '@w360/core';
import {
  and,
  authorizedTenantScope,
  channelAccounts,
  contactIdentities,
  conversations,
  eq,
  lt,
  mediaObjects,
  messageStatusEvents,
  messages,
  or,
  sql,
  systemScope,
  webhookQuarantine,
  webhookReceipts,
  whatsappAccounts,
  type Database,
  type Tx,
} from '@w360/db';
import { dispatchInboundToAutomation } from '../automations/dispatch';
import { signalRunOfBotMessage } from '../automations/runs';
import { attributeCampaignReply } from '../campaigns/attribution';
import { contactForPhone } from '../contacts/service';
import { phoneFromWaId } from '../contacts/phone';
import {
  PROVIDER_MARKETING_OPT_OUT_CODE,
  applyInboundConsentKeyword,
  loadMessagingSettings,
  recordProviderMarketingOptOut,
  type MessagingSettings,
} from '../consent/service';
import { isCsatTap, recordCsatAnswer } from '../inbox/csat';
import { routeConversation, type RouteOptions } from '../inbox/routing';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from './events';
import {
  metaEnvelopeSchema,
  metaMessageSchema,
  metaMessagesValueSchema,
  metaStatusSchema,
  normaliseInboundContent,
  statusErrorsToStore,
  statusPricingToStore,
  type MetaContact,
  type MetaMessagesValue,
} from './meta-webhook';
import { receiptAad } from './receipts';
import { recordConversationSource } from '../growth/sources';
import { parseFlowCompletion, recordFlowCompletion } from '../flows/responses';
import type { ParsedOrder } from '../commerce/model';
import { recordOrder } from '../commerce/orders';
import { recordStoreMessageAnswer } from '../stores/order-messages';
import { STATUS_RANK, providerStatusToMessageStatus, shouldAdvance } from './status';

/**
 * Processes one stored Meta webhook receipt. Safe to run repeatedly and concurrently:
 * - a lease prevents two workers from processing the same receipt at once;
 * - messages are unique per (company, number, WAMID) and status events per
 *   (company, number, WAMID, status, timestamp), so replays are no-ops;
 * - the company is resolved only from verified asset bindings (phone number id and WABA id must
 *   both match); anything else is quarantined for platform review.
 */
export type ReceiptOutcome = 'processed' | 'quarantined' | 'ignored' | 'not_claimable';

export interface IngestDeps {
  db: Database;
  keyring: Keyring;
  clock: Clock;
  /** Automation runs are signalled in the ingestion transaction. */
  jobs: JobQueue;
  signer: JobSigner;
}

interface Summary {
  changes: number;
  messages: number;
  duplicateMessages: number;
  statuses: number;
  duplicateStatuses: number;
  orphanStatuses: number;
  consentKeywords: number;
  providerOptOuts: number;
  automationReplies: number;
  automationStarts: number;
  templateSyncRequests: number;
  quarantined: number;
  malformed: number;
  unhandledFields: Record<string, number>;
}

/**
 * Template webhook fields (M-034, M-036). Their payloads are documented only by third parties, so
 * they are used purely as a signal: the WABA's templates are re-read from the Graph API, which is
 * authoritative.
 */
export const TEMPLATE_WEBHOOK_FIELDS: ReadonlySet<string> = new Set([
  'message_template_status_update',
  'message_template_quality_update',
  'message_template_components_update',
  'template_category_update',
]);

const LEASE_MS = 2 * 60_000;
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

function epochToDate(value: string): Date {
  return new Date(Number(value) * 1000);
}

export async function processMetaWebhookReceipt(
  deps: IngestDeps,
  receiptId: string,
): Promise<ReceiptOutcome> {
  const now = deps.clock.now();
  const claimed = await deps.db.run(systemScope, async (tx) => {
    const rows = await tx
      .update(webhookReceipts)
      .set({
        status: 'processing',
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        attempts: sql`${webhookReceipts.attempts} + 1`,
      })
      .where(
        and(
          eq(webhookReceipts.id, receiptId),
          eq(webhookReceipts.provider, 'meta_whatsapp'),
          or(
            eq(webhookReceipts.status, 'pending'),
            eq(webhookReceipts.status, 'failed'),
            and(eq(webhookReceipts.status, 'processing'), lt(webhookReceipts.leaseUntil, now)),
          ),
        ),
      )
      .returning();
    return rows[0];
  });
  if (!claimed) return 'not_claimable';

  // Quarantine entries are written with the receipt's outcome, in one transaction, so the
  // operations console never lists an entry whose receipt is still being processed (it could not
  // offer the retry yet).
  const quarantined: {
    reason: 'unknown_asset' | 'asset_mismatch' | 'malformed' | 'unsupported_object';
    externalIds: Record<string, unknown>;
  }[] = [];
  const quarantine = (
    reason: (typeof quarantined)[number]['reason'],
    externalIds: Record<string, unknown>,
  ) => {
    quarantined.push({ reason, externalIds });
  };
  const finish = async (
    status: 'processed' | 'quarantined' | 'ignored',
    summary: Summary | Record<string, unknown>,
  ) => {
    await deps.db.run(systemScope, async (tx) => {
      if (quarantined.length > 0) {
        await tx
          .insert(webhookQuarantine)
          .values(
            quarantined.map((q) => ({
              id: uuidv7(),
              receiptId,
              provider: 'meta_whatsapp' as const,
              reason: q.reason,
              externalIds: q.externalIds,
            })),
          )
          .onConflictDoNothing();
      }
      await tx
        .update(webhookReceipts)
        .set({
          status,
          summary: summary as Record<string, unknown>,
          processedAt: deps.clock.now(),
          leaseUntil: null,
          lastError: null,
        })
        .where(eq(webhookReceipts.id, receiptId));
    });
  };

  try {
    let envelopeJson: unknown;
    try {
      if (!claimed.bodyCiphertext) throw new Error('body erased');
      // A NUL character in a message would fail the whole receipt where it is stored (ADR-130).
      envelopeJson = parseExternalJson(
        deps.keyring.decryptString(claimed.bodyCiphertext, receiptAad(claimed.id)),
      );
    } catch {
      quarantine('malformed', {});
      await finish('quarantined', { error: 'unreadable body' });
      return 'quarantined';
    }
    const envelope = metaEnvelopeSchema.safeParse(envelopeJson);
    if (!envelope.success) {
      quarantine('malformed', {});
      await finish('quarantined', { error: 'invalid envelope' });
      return 'quarantined';
    }
    if (envelope.data.object !== 'whatsapp_business_account') {
      await finish('ignored', { object: envelope.data.object.slice(0, 64) });
      return 'ignored';
    }

    const summary: Summary = {
      changes: 0,
      messages: 0,
      duplicateMessages: 0,
      statuses: 0,
      duplicateStatuses: 0,
      orphanStatuses: 0,
      consentKeywords: 0,
      providerOptOuts: 0,
      automationReplies: 0,
      automationStarts: 0,
      templateSyncRequests: 0,
      quarantined: 0,
      malformed: 0,
      unhandledFields: {},
    };

    for (const entry of envelope.data.entry) {
      for (const change of entry.changes) {
        summary.changes += 1;
        if (TEMPLATE_WEBHOOK_FIELDS.has(change.field)) {
          const requested = await requestTemplateSync(deps, entry.id);
          if (requested) summary.templateSyncRequests += 1;
          else {
            summary.quarantined += 1;
            quarantine('unknown_asset', { waba: entry.id, field: change.field });
          }
          continue;
        }
        if (change.field !== 'messages') {
          summary.unhandledFields[change.field] = (summary.unhandledFields[change.field] ?? 0) + 1;
          continue;
        }
        const value = metaMessagesValueSchema.safeParse(change.value);
        if (!value.success) {
          summary.malformed += 1;
          summary.quarantined += 1;
          quarantine('malformed', { waba: entry.id });
          continue;
        }
        const phoneNumberId = value.data.metadata.phone_number_id;
        const binding = await deps.db.run(
          systemScope,
          async (tx) => {
            const res = await tx.execute<{
              tenant_id: string;
              internal_id: string;
              parent_external_id: string | null;
            }>(
              sql`select * from ops.resolve_provider_asset('meta_whatsapp', 'phone_number', ${phoneNumberId})`,
            );
            return res.rows[0] ?? null;
          },
          { accessMode: 'read only' },
        );
        if (!binding) {
          summary.quarantined += 1;
          quarantine('unknown_asset', { waba: entry.id, phoneNumberId });
          continue;
        }
        if (binding.parent_external_id !== entry.id) {
          summary.quarantined += 1;
          quarantine('asset_mismatch', { waba: entry.id, phoneNumberId });
          continue;
        }
        await deps.db.run(authorizedTenantScope(binding.tenant_id, null), (tx) =>
          ingestMessagesChange(tx, deps, {
            tenantId: binding.tenant_id,
            channelAccountId: binding.internal_id,
            value: value.data,
            receiptId,
            summary,
          }),
        );
      }
    }

    const outcome =
      summary.changes > 0 && summary.quarantined === summary.changes ? 'quarantined' : 'processed';
    await finish(outcome, summary);
    return outcome;
  } catch (error) {
    await deps.db.run(systemScope, (tx) =>
      tx
        .update(webhookReceipts)
        .set({
          status: 'failed',
          leaseUntil: null,
          lastError: error instanceof Error ? error.message.slice(0, 1000) : 'processing failed',
        })
        .where(eq(webhookReceipts.id, receiptId)),
    );
    throw error;
  }
}

/**
 * Marks a WABA's templates for re-sync (the template sweep performs it). The WABA is resolved only
 * through its verified asset binding.
 */
async function requestTemplateSync(deps: IngestDeps, wabaExternalId: string): Promise<boolean> {
  const binding = await deps.db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; internal_id: string }>(
        sql`select * from ops.resolve_provider_asset('meta_whatsapp', 'waba', ${wabaExternalId})`,
      );
      return res.rows[0] ?? null;
    },
    { accessMode: 'read only' },
  );
  if (!binding) return false;
  await deps.db.run(authorizedTenantScope(binding.tenant_id, null), (tx) =>
    tx
      .update(whatsappAccounts)
      .set({ templatesSyncRequestedAt: deps.clock.now() })
      .where(
        and(
          eq(whatsappAccounts.tenantId, binding.tenant_id),
          eq(whatsappAccounts.id, binding.internal_id),
        ),
      ),
  );
  return true;
}

/** The text a consent keyword can be matched against, per inbound message type. */
function consentText(type: string, content: Record<string, unknown>): string | null {
  if (type === 'text') return typeof content.text === 'string' ? content.text : null;
  if (type === 'button') {
    if (typeof content.text === 'string') return content.text;
    return typeof content.payload === 'string' ? content.payload : null;
  }
  if (type === 'interactive') {
    const reply = content.reply as { title?: unknown } | null | undefined;
    return typeof reply?.title === 'string' ? reply.title : null;
  }
  return null;
}

interface ChangeContext {
  tenantId: string;
  channelAccountId: string;
  value: MetaMessagesValue;
  receiptId: string;
  summary: Summary;
}

async function ingestMessagesChange(
  tx: Tx,
  deps: Pick<IngestDeps, 'jobs' | 'signer' | 'clock'>,
  ctx: ChangeContext,
): Promise<void> {
  const [channel] = await tx
    .select({ id: channelAccounts.id, whatsappAccountId: channelAccounts.whatsappAccountId })
    .from(channelAccounts)
    .where(
      and(eq(channelAccounts.tenantId, ctx.tenantId), eq(channelAccounts.id, ctx.channelAccountId)),
    );
  if (!channel) throw new Error('Asset binding refers to a missing channel account');

  let settings: MessagingSettings | null = null;
  const contactList = ctx.value.contacts ?? [];
  const findContact = (from: string | undefined): MetaContact | undefined =>
    contactList.find((c) => (from && (c.wa_id === from || c.user_id === from)) || false) ??
    (contactList.length === 1 ? contactList[0] : undefined);

  // Conversations to route once every message of this change is stored (routing takes the
  // company's routing lock last, after the conversation row locks taken below).
  const toRoute = new Map<string, RouteOptions>();
  for (const raw of ctx.value.messages ?? []) {
    const parsed = metaMessageSchema.safeParse(raw);
    if (!parsed.success) {
      ctx.summary.malformed += 1;
      continue;
    }
    const m = parsed.data;
    const info = findContact(m.from);
    const waId = info?.wa_id ?? (m.from && /^[0-9]{6,20}$/.test(m.from) ? m.from : undefined);
    const bsuid = info?.user_id ?? (m.from && !/^[0-9]+$/.test(m.from) ? m.from : undefined);
    if (!waId && !bsuid) {
      ctx.summary.malformed += 1;
      continue;
    }
    const contactId = await upsertIdentity(tx, ctx.tenantId, channel.whatsappAccountId, {
      bsuid,
      parentBsuid: info?.parent_user_id,
      waId,
      profileName: info?.profile?.name,
    });
    const conversation = await upsertConversation(tx, ctx.tenantId, channel.id, contactId);
    const { type, content, preview } = normaliseInboundContent(m);
    const providerAt = epochToDate(m.timestamp);
    const messageId = uuidv7();
    const inserted = await tx
      .insert(messages)
      .values({
        id: messageId,
        tenantId: ctx.tenantId,
        conversationId: conversation.id,
        channelAccountId: channel.id,
        direction: 'inbound',
        externalMessageId: m.id,
        type,
        content,
        status: 'received',
        statusRank: STATUS_RANK.received,
        senderType: 'contact',
        contextExternalId: m.context?.id ?? null,
        // The ad referral is not stored raw (it carries the ad click id); its source is recorded below.
        providerTimestamp: providerAt,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (inserted.length === 0) {
      ctx.summary.duplicateMessages += 1;
      continue;
    }
    ctx.summary.messages += 1;

    if (MEDIA_TYPES.has(type) && typeof content.id === 'string') {
      await tx.insert(mediaObjects).values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        messageId,
        providerMediaId: content.id,
        mimeType: typeof content.mime_type === 'string' ? content.mime_type : null,
        sha256: typeof content.sha256 === 'string' ? content.sha256 : null,
        filename: typeof content.filename === 'string' ? content.filename : null,
      });
    }
    if (type === 'system')
      await applyIdentityChange(tx, ctx.tenantId, channel.whatsappAccountId, content);
    if (type !== 'system' && type !== 'reaction') {
      // Where the conversation came from: a click-to-WhatsApp ad or one of the company's links.
      await recordConversationSource(tx, {
        tenantId: ctx.tenantId,
        channelAccountId: channel.id,
        conversationId: conversation.id,
        contactId,
        messageId,
        referral: m.referral,
        text: type === 'text' && typeof content.text === 'string' ? content.text : null,
        occurredAt: providerAt,
      });
    }

    // A completed flow: its answers are stored and applied to the contact (flows/responses.ts).
    const flowCompletion =
      type === 'interactive' && content.interactiveType === 'nfm_reply'
        ? parseFlowCompletion((m as Record<string, unknown>).interactive)
        : null;
    if (flowCompletion) {
      await recordFlowCompletion(tx, {
        tenantId: ctx.tenantId,
        conversationId: conversation.id,
        contactId,
        messageId,
        completion: flowCompletion,
        receivedAt: providerAt,
      });
    }

    // An order from the customer's cart (research M-170) is recorded with its items and amounts.
    const order =
      type === 'order' && typeof content.order === 'object' && content.order !== null
        ? (content.order as ParsedOrder)
        : null;
    if (order) {
      await recordOrder(tx, {
        tenantId: ctx.tenantId,
        conversationId: conversation.id,
        contactId,
        channelAccountId: channel.id,
        whatsappAccountId: channel.whatsappAccountId,
        messageId,
        order,
        receivedAt: providerAt,
      });
    }

    // A tap on a CSAT button answers the survey: it is not a new question, so it neither reopens
    // the conversation nor counts as unread, a keyword, a campaign reply or a routing trigger.
    const csatTap = isCsatTap(type, content);
    if (csatTap) {
      const reply = content.reply as { id: string };
      await recordCsatAnswer(tx, {
        tenantId: ctx.tenantId,
        conversationId: conversation.id,
        buttonId: reply.id,
        contextExternalId: m.context?.id ?? null,
        responseMessageId: messageId,
        answeredAt: providerAt,
      });
    }
    // A tap on a cash on delivery message's button answers it (order messages). Like a survey
    // answer it is not a keyword, a campaign reply or an automation trigger; a confirmation stays
    // quiet, while a cancellation reopens the conversation for the team, who cancel the order in
    // the store (HyFib does not write to stores).
    const codAnswer =
      type === 'button'
        ? await recordStoreMessageAnswer(tx, {
            tenantId: ctx.tenantId,
            conversationId: conversation.id,
            payload: content.payload,
            contextExternalId: m.context?.id ?? null,
            messageId,
            answeredAt: providerAt,
          })
        : null;
    const answerTap = csatTap || codAnswer !== null;
    const quietTap = csatTap || codAnswer === 'confirmed';
    const keywordText = answerTap ? null : consentText(type, content);
    let consent: Awaited<ReturnType<typeof applyInboundConsentKeyword>> = null;
    if (keywordText) {
      settings ??= await loadMessagingSettings(tx, ctx.tenantId);
      const matched = await applyInboundConsentKeyword(tx, {
        tenantId: ctx.tenantId,
        contactId,
        channelAccountId: channel.id,
        messageId,
        text: keywordText,
        occurredAt: providerAt,
        settings,
      });
      consent = matched;
      if (matched) ctx.summary.consentKeywords += 1;
    }

    if (type !== 'system' && type !== 'reaction' && !answerTap) {
      await attributeCampaignReply(tx, {
        tenantId: ctx.tenantId,
        contactId,
        channelAccountId: channel.id,
        at: providerAt,
      });
    }

    const newer = !conversation.lastMessageAt || providerAt >= conversation.lastMessageAt;
    const reopened = conversation.status === 'resolved' && !quietTap;
    await tx
      .update(conversations)
      .set({
        ...(quietTap ? {} : { unreadCount: sql`${conversations.unreadCount} + 1` }),
        lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${providerAt.toISOString()}::timestamptz)`,
        ...(newer ? { lastMessageAt: providerAt, lastMessagePreview: clipText(preview, 200) } : {}),
        ...(reopened
          ? {
              status: 'open' as const,
              resolvedAt: null,
              version: sql`${conversations.version} + 1`,
            }
          : {}),
      })
      .where(and(eq(conversations.tenantId, ctx.tenantId), eq(conversations.id, conversation.id)));
    await emitTenantEvent(tx, ctx.tenantId, {
      type: 'message.received',
      conversationId: conversation.id,
      assignedMembershipId: conversation.assignedMembershipId,
      payload: { messageId, reopened },
    });
    if (type !== 'system' && type !== 'reaction' && !quietTap) {
      const newCase = conversation.created || reopened;
      // Automations first: a waiting run receives the reply, or a matching automation starts.
      // Routing (below) leaves a conversation alone while a run is active. A completed form or an
      // answer to an order message is not an answer to a bot question and starts no automation.
      if (!flowCompletion && !order && !answerTap) {
        const dispatched = await dispatchInboundToAutomation(tx, deps, {
          tenantId: ctx.tenantId,
          conversationId: conversation.id,
          channelAccountId: channel.id,
          contactId,
          assignedMembershipId: conversation.assignedMembershipId,
          messageId,
          text: keywordText,
          newCase,
          consent,
        });
        if (dispatched === 'delivered') ctx.summary.automationReplies += 1;
        if (dispatched === 'started') ctx.summary.automationStarts += 1;
      }
      const queued = toRoute.get(conversation.id);
      if (!queued || (newCase && !queued.newCase)) {
        toRoute.set(conversation.id, { newCase, text: newCase ? keywordText : null });
      }
    }
  }
  for (const [conversationId, options] of toRoute) {
    await routeConversation(tx, ctx.tenantId, conversationId, options);
  }

  for (const raw of ctx.value.statuses ?? []) {
    const parsed = metaStatusSchema.safeParse(raw);
    if (!parsed.success) {
      ctx.summary.malformed += 1;
      continue;
    }
    const s = parsed.data;
    const providerAt = epochToDate(s.timestamp);
    const [message] = await tx
      .select({
        id: messages.id,
        status: messages.status,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          eq(messages.channelAccountId, channel.id),
          eq(messages.externalMessageId, s.id),
        ),
      )
      .for('update');
    const firstError = s.errors?.[0];
    // Errors and pricing within what their columns hold, so one status never fails its receipt.
    const pricing = statusPricingToStore(s.pricing);
    const inserted = await tx
      .insert(messageStatusEvents)
      .values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        channelAccountId: channel.id,
        messageId: message?.id ?? null,
        externalMessageId: s.id,
        status: s.status.slice(0, 32),
        providerTimestamp: providerAt,
        recipientWaId: s.recipient_id && /^[0-9]+$/.test(s.recipient_id) ? s.recipient_id : null,
        recipientBsuid: s.recipient_user_id ?? null,
        errors: statusErrorsToStore(s.errors),
        pricing,
        receiptId: ctx.receiptId,
      })
      .onConflictDoNothing()
      .returning({ id: messageStatusEvents.id });
    if (inserted.length === 0) {
      ctx.summary.duplicateStatuses += 1;
      continue;
    }
    ctx.summary.statuses += 1;
    if (!message) {
      // The WAMID is not (yet) known: the send worker applies these when it records the WAMID.
      ctx.summary.orphanStatuses += 1;
      continue;
    }
    const next = providerStatusToMessageStatus(s.status);
    if (next && shouldAdvance(message.status, next)) {
      await tx
        .update(messages)
        .set({
          status: next,
          statusRank: STATUS_RANK[next],
          statusAt: providerAt,
          ...(next === 'failed'
            ? {
                errorCode:
                  firstError?.code !== undefined ? String(firstError.code).slice(0, 32) : null,
                errorTitle:
                  firstError?.title?.slice(0, 500) ?? firstError?.message?.slice(0, 500) ?? null,
              }
            : {}),
          ...(pricing ? { pricing } : {}),
        })
        .where(and(eq(messages.tenantId, ctx.tenantId), eq(messages.id, message.id)));
      await emitTenantEvent(tx, ctx.tenantId, {
        type: 'message.status',
        conversationId: message.conversationId,
        payload: { messageId: message.id, status: next },
      });
      // A bot message that failed after Meta accepted it ends its (still active) run.
      if (next === 'failed') {
        await signalRunOfBotMessage(deps, tx, {
          tenantId: ctx.tenantId,
          messageId: message.id,
          key: `f:${message.id}`,
        });
      }
    }
    // After the status update, so attribution never credits the failing message itself: 131050
    // means the customer had already stopped marketing messages before this one.
    if (
      s.status === 'failed' &&
      s.errors?.some((e) => Number(e.code) === PROVIDER_MARKETING_OPT_OUT_CODE)
    ) {
      const [thread] = await tx
        .select({ contactId: conversations.contactId })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, ctx.tenantId),
            eq(conversations.id, message.conversationId),
          ),
        );
      if (thread) {
        await recordProviderMarketingOptOut(tx, {
          tenantId: ctx.tenantId,
          contactId: thread.contactId,
          channelAccountId: channel.id,
          externalMessageId: s.id,
          occurredAt: providerAt,
          providerTime: true,
        });
        ctx.summary.providerOptOuts += 1;
      }
    }
  }
}

async function upsertIdentity(
  tx: Tx,
  tenantId: string,
  whatsappAccountId: string,
  info: {
    bsuid: string | undefined;
    parentBsuid: string | undefined;
    waId: string | undefined;
    profileName: string | undefined;
  },
): Promise<string> {
  const key = info.bsuid ? `b:${info.bsuid}` : `w:${info.waId}`;
  // Serialise creation of the same identity across concurrent receipts.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}|${whatsappAccountId}|${key}`}, 7361))`,
  );
  const byBsuid = info.bsuid
    ? await tx
        .select()
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.tenantId, tenantId),
            eq(contactIdentities.whatsappAccountId, whatsappAccountId),
            eq(contactIdentities.bsuid, info.bsuid),
          ),
        )
    : [];
  const byWaId =
    !byBsuid[0] && info.waId
      ? await tx
          .select()
          .from(contactIdentities)
          .where(
            and(
              eq(contactIdentities.tenantId, tenantId),
              eq(contactIdentities.whatsappAccountId, whatsappAccountId),
              eq(contactIdentities.waId, info.waId),
            ),
          )
      : [];
  const existing = byBsuid[0] ?? byWaId[0];
  if (existing) {
    const updates: Partial<typeof contactIdentities.$inferInsert> = {};
    if (info.bsuid && !existing.bsuid) updates.bsuid = info.bsuid;
    if (info.parentBsuid && existing.parentBsuid !== info.parentBsuid)
      updates.parentBsuid = info.parentBsuid;
    // Another identity can hold the number: one recorded by the number before WhatsApp named the
    // customer by user id, which may belong to another contact or, after a merge (ADR-224), to the
    // same one. That identity keeps it (taking it would break the unique index and fail the whole
    // receipt); the message joins the contact of the identity its user id names.
    if (info.waId && !existing.waId) {
      const [holder] = await tx
        .select({ id: contactIdentities.id })
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.tenantId, tenantId),
            eq(contactIdentities.whatsappAccountId, whatsappAccountId),
            eq(contactIdentities.waId, info.waId),
          ),
        )
        .limit(1);
      if (!holder) updates.waId = info.waId;
    }
    if (info.profileName && existing.profileName !== info.profileName)
      updates.profileName = clipText(info.profileName, 200);
    if (Object.keys(updates).length > 0) {
      await tx
        .update(contactIdentities)
        .set(updates)
        .where(
          and(eq(contactIdentities.tenantId, tenantId), eq(contactIdentities.id, existing.id)),
        );
    }
    return existing.contactId;
  }
  // A new identity joins the contact that already has this number (manual entry, import or
  // another company number), so one person is one contact.
  const contactId = await contactForPhone(tx, tenantId, {
    phoneE164: phoneFromWaId(info.waId),
    displayName: info.profileName ? clipText(info.profileName, 200) : null,
    source: 'whatsapp',
  });
  await tx.insert(contactIdentities).values({
    id: uuidv7(),
    tenantId,
    contactId,
    whatsappAccountId,
    bsuid: info.bsuid ?? null,
    parentBsuid: info.parentBsuid ?? null,
    waId: info.waId ?? null,
    profileName: info.profileName ? clipText(info.profileName, 200) : null,
  });
  return contactId;
}

async function upsertConversation(
  tx: Tx,
  tenantId: string,
  channelAccountId: string,
  contactId: string,
) {
  const inserted = await tx
    .insert(conversations)
    .values({ id: uuidv7(), tenantId, channelAccountId, contactId })
    .onConflictDoNothing()
    .returning({ id: conversations.id });
  const [row] = await tx
    .select({
      id: conversations.id,
      status: conversations.status,
      assignedMembershipId: conversations.assignedMembershipId,
      lastMessageAt: conversations.lastMessageAt,
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
  return { ...row, created: inserted.length > 0 };
}

/** `user_changed_user_id` / `user_changed_number` system messages update the stored identity. */
async function applyIdentityChange(
  tx: Tx,
  tenantId: string,
  whatsappAccountId: string,
  content: Record<string, unknown>,
) {
  const previous = typeof content.previous_user_id === 'string' ? content.previous_user_id : null;
  const next = typeof content.user_id === 'string' ? content.user_id : null;
  if (previous && next && previous !== next) {
    await tx
      .update(contactIdentities)
      .set({
        bsuid: next,
        parentBsuid: typeof content.parent_user_id === 'string' ? content.parent_user_id : null,
      })
      .where(
        and(
          eq(contactIdentities.tenantId, tenantId),
          eq(contactIdentities.whatsappAccountId, whatsappAccountId),
          eq(contactIdentities.bsuid, previous),
        ),
      );
  }
  const newWaId =
    typeof content.new_wa_id === 'string' && /^[0-9]{6,20}$/.test(content.new_wa_id)
      ? content.new_wa_id
      : null;
  const oldWaId = typeof content.wa_id === 'string' ? content.wa_id : null;
  if (newWaId && oldWaId && newWaId !== oldWaId) {
    await tx
      .update(contactIdentities)
      .set({ waId: newWaId })
      .where(
        and(
          eq(contactIdentities.tenantId, tenantId),
          eq(contactIdentities.whatsappAccountId, whatsappAccountId),
          eq(contactIdentities.waId, oldWaId),
        ),
      );
  }
}
