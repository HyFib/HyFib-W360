import { z } from 'zod';
import { notFound, type Clock, type Keyring } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  channelAccounts,
  contacts,
  conversations,
  desc,
  eq,
  isNotNull,
  messages,
  messagingSettings,
  whatsappAccounts,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { DEFAULT_MESSAGING_SETTINGS } from '../consent/service';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { credentialAad } from '../messaging/credentials';
import type { GraphClient } from '../messaging/graph';
import { SERVICE_WINDOW_MS, canSeeConversation } from '../messaging/outbound';
import { parseInput } from '../validation';

/**
 * Read receipts and typing indicators to customers (ADR-223, research M-045). A company that turns
 * them on marks the customer's latest message read in WhatsApp when a member opens a conversation
 * with unread messages, and shows the customer a typing indicator (which marks the message read
 * too) while a member who can reply writes in the composer. Off by default. The worker calls
 * Graph: the web tier only queues a signed job naming the message, and the job checks everything
 * again in the company's scope.
 */

/** The job kinds of the `message.read` queue. */
export const READ_RECEIPT_KIND = 'message.read';
export const TYPING_INDICATOR_KIND = 'message.typing';

export const readReceiptsSettingsSchema = z.object({ enabled: z.boolean() });

/** Whether the company turned read receipts on. */
export async function readReceiptsEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: messagingSettings.readReceipts })
    .from(messagingSettings)
    .where(eq(messagingSettings.tenantId, tenantId));
  return row?.enabled ?? false;
}

/** The conversation's latest message from the customer that WhatsApp named, if any. */
async function latestCustomerMessage(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'inbound'),
        isNotNull(messages.externalMessageId),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row?.id ?? null;
}

interface JobDeps {
  jobs: JobQueue;
  signer: JobSigner;
}

function queueJob(
  tx: Tx,
  deps: JobDeps,
  input: { tenantId: string; messageId: string; typing: boolean },
) {
  const kind = input.typing ? TYPING_INDICATOR_KIND : READ_RECEIPT_KIND;
  return deps.jobs.enqueue(
    tx,
    QUEUES.messageRead.name,
    deps.signer.sign({ kind, tenantId: input.tenantId, actorUserId: null, ref: input.messageId }),
    // One read receipt per message; one typing indicator per message while one is queued.
    { singletonKey: `${kind}:${input.messageId}` },
  );
}

/**
 * Queues a read receipt for the conversation's latest message from the customer, when the company
 * turned read receipts on; called in the transaction that marked the conversation read. Returns
 * whether one was queued.
 */
export async function queueReadReceipt(
  tx: Tx,
  deps: JobDeps,
  tenantId: string,
  conversationId: string,
): Promise<boolean> {
  if (!(await readReceiptsEnabled(tx, tenantId))) return false;
  const messageId = await latestCustomerMessage(tx, tenantId, conversationId);
  if (!messageId) return false;
  await queueJob(tx, deps, { tenantId, messageId, typing: false });
  return true;
}

export interface ReadReceiptsDeps extends JobDeps {
  db: Database;
  clock: Clock;
}

/** Why a typing indicator was not queued, or that it was. */
export type TypingOutcome = 'queued' | 'off' | 'window_closed' | 'channel_inactive' | 'no_message';

export function createReadReceiptsService(deps: ReadReceiptsDeps) {
  const { db, clock } = deps;
  return {
    async getSettings(ctx: TenantContext): Promise<{ enabled: boolean }> {
      assertCan(ctx, 'tenant.read');
      return db.run(
        ctx.scope,
        async (tx) => ({ enabled: await readReceiptsEnabled(tx, ctx.tenant.id) }),
        { accessMode: 'read only' },
      );
    },

    async updateSettings(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(readReceiptsSettingsSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const values = {
          readReceipts: data.enabled,
          updatedByUserId: ctx.user.id,
          updatedAt: clock.now(),
        };
        await tx
          .insert(messagingSettings)
          .values({
            tenantId: ctx.tenant.id,
            optOutKeywords: [...DEFAULT_MESSAGING_SETTINGS.optOutKeywords],
            marketingOptOutKeywords: [...DEFAULT_MESSAGING_SETTINGS.marketingOptOutKeywords],
            optInKeywords: [...DEFAULT_MESSAGING_SETTINGS.optInKeywords],
            requireMarketingOptIn: DEFAULT_MESSAGING_SETTINGS.requireMarketingOptIn,
            ...values,
          })
          .onConflictDoUpdate({ target: messagingSettings.tenantId, set: values });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'inbox.read_receipts_updated',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: { enabled: data.enabled },
          },
          meta,
        );
      });
    },

    /**
     * Queues a typing indicator for the conversation's latest message from the customer, for a
     * member who can reply and see the conversation, while its window is open on an active number
     * and the company turned read receipts on. Best effort: the composer calls it while the member
     * writes, at most every 20 seconds.
     */
    async showTyping(ctx: TenantContext, conversationId: string): Promise<TypingOutcome> {
      assertCan(ctx, 'inbox.reply');
      if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
      return db.run(ctx.scope, async (tx) => {
        const [conv] = await tx
          .select({
            assignedMembershipId: conversations.assignedMembershipId,
            lastInboundAt: conversations.lastInboundAt,
            channelStatus: channelAccounts.status,
          })
          .from(conversations)
          .innerJoin(
            channelAccounts,
            and(
              eq(channelAccounts.tenantId, conversations.tenantId),
              eq(channelAccounts.id, conversations.channelAccountId),
            ),
          )
          .where(
            and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)),
          );
        if (!conv || !canSeeConversation(ctx, conv.assignedMembershipId)) {
          throw notFound('Conversation');
        }
        if (!(await readReceiptsEnabled(tx, ctx.tenant.id))) return 'off';
        if (conv.channelStatus !== 'active') return 'channel_inactive';
        if (
          !conv.lastInboundAt ||
          clock.now().getTime() - conv.lastInboundAt.getTime() > SERVICE_WINDOW_MS
        ) {
          return 'window_closed';
        }
        const messageId = await latestCustomerMessage(tx, ctx.tenant.id, conversationId);
        if (!messageId) return 'no_message';
        await queueJob(tx, deps, { tenantId: ctx.tenant.id, messageId, typing: true });
        return 'queued';
      });
    },
  };
}

export type ReadReceiptsService = ReturnType<typeof createReadReceiptsService>;

export interface SendReadReceiptDeps {
  db: Database;
  keyring: Keyring;
  graph: Pick<GraphClient, 'markRead'>;
}

/** What a read receipt or typing indicator job did. */
export type ReadReceiptOutcome =
  | 'sent'
  | 'off'
  | 'not_found'
  | 'contact_erased'
  | 'channel_inactive'
  | 'account_disconnected'
  | 'rejected';

/**
 * Sends a read receipt for a customer's message, with a typing indicator when `typing`, after
 * checking again in the company's scope: read receipts still on, the message the customer's, the
 * contact not erased, the number active and its account connected. A refusal from Meta is
 * returned ('rejected', with what Meta said, for the job log); a failure worth trying again
 * (Meta unavailable or slow) is thrown for a read receipt, so the job is retried, and returned for
 * a typing indicator, which would only show late.
 */
export async function sendReadReceipt(
  deps: SendReadReceiptDeps,
  scope: TenantScope,
  messageId: string,
  typing: boolean,
): Promise<{ outcome: ReadReceiptOutcome; detail?: string }> {
  const tenantId = scope.tenantId;
  if (!tenantId || !z.uuid().safeParse(messageId).success) return { outcome: 'not_found' };
  const target = await deps.db.run(
    scope,
    async (tx) => {
      if (!(await readReceiptsEnabled(tx, tenantId))) return { outcome: 'off' as const };
      const [row] = await tx
        .select({
          externalId: messages.externalMessageId,
          direction: messages.direction,
          erasedAt: contacts.erasedAt,
          channelStatus: channelAccounts.status,
          phoneNumberId: channelAccounts.phoneNumberId,
          whatsappAccountId: channelAccounts.whatsappAccountId,
          accountStatus: whatsappAccounts.status,
          credential: whatsappAccounts.credentialCiphertext,
        })
        .from(messages)
        .innerJoin(
          conversations,
          and(
            eq(conversations.tenantId, messages.tenantId),
            eq(conversations.id, messages.conversationId),
          ),
        )
        .innerJoin(
          contacts,
          and(
            eq(contacts.tenantId, conversations.tenantId),
            eq(contacts.id, conversations.contactId),
          ),
        )
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
        .where(and(eq(messages.tenantId, tenantId), eq(messages.id, messageId)));
      if (!row || row.direction !== 'inbound' || !row.externalId) {
        return { outcome: 'not_found' as const };
      }
      if (row.erasedAt) return { outcome: 'contact_erased' as const };
      if (row.channelStatus !== 'active') return { outcome: 'channel_inactive' as const };
      if (row.accountStatus !== 'connected' || !row.credential) {
        return { outcome: 'account_disconnected' as const };
      }
      return {
        outcome: 'send' as const,
        externalId: row.externalId,
        phoneNumberId: row.phoneNumberId,
        whatsappAccountId: row.whatsappAccountId,
        credential: row.credential,
      };
    },
    { accessMode: 'read only' },
  );
  if (target.outcome !== 'send') return { outcome: target.outcome };
  const token = deps.keyring.decryptString(
    target.credential,
    credentialAad(tenantId, target.whatsappAccountId),
  );
  const result = await deps.graph.markRead(target.phoneNumberId, token, {
    messageId: target.externalId,
    typing,
  });
  if (result.ok) return { outcome: 'sent' };
  const detail = result.detail ?? result.title;
  // Marking read again is harmless, so a request Meta may not have received is tried again too.
  if ((result.kind === 'retryable' || result.kind === 'unknown') && !typing) {
    throw new Error(`WhatsApp did not take the read receipt: ${detail}`);
  }
  return { outcome: 'rejected', detail };
}
