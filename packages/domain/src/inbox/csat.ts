import { z } from 'zod';
import { uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  channelAccounts,
  contactIdentities,
  conversationCases,
  conversations,
  csatSurveys,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  messages,
  messagingSettings,
  sendIntents,
  type CsatSkipReason,
  type Database,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { DEFAULT_MESSAGING_SETTINGS, checkTemplateEligibility } from '../consent/service';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from '../messaging/events';
import { STATUS_RANK } from '../messaging/status';
import { parseInput } from '../validation';

/**
 * CSAT surveys. When a member resolves a conversation and CSAT is on, HyFib sends the customer a
 * rating question with three reply buttons (an interactive "button" message: at most three
 * buttons, titles up to 20 characters, ids up to 256; research M-157/M-158). Interactive messages
 * are free-form, so they go only inside the 24-hour customer service window, and only to contacts
 * who have not opted out of non-marketing messages. The customer's first tap on that message is
 * the answer; taps never reopen the conversation or start a reply turn.
 */
export const CSAT_DEFAULTS = {
  question: 'How would you rate the help you received today?',
  labels: ['Great', 'Okay', 'Poor'] as [string, string, string],
};
/** Button ids start with this prefix; the reply-turn trigger (migration 0009) recognises it. */
export const CSAT_BUTTON_PREFIX = 'w360csat:';
/** A conversation is asked at most once in this period. */
export const CSAT_COOLDOWN_MS = 24 * 3600_000;
const SERVICE_WINDOW_MS = 24 * 3600_000;
const BUTTON_ID_RE = /^w360csat:([0-9a-f-]{36}):([123])$/;

export const csatSettingsSchema = z.object({
  enabled: z.boolean(),
  question: z
    .string()
    .trim()
    .min(1, 'Write the question.')
    .max(1024, 'WhatsApp limits the question to 1024 characters.'),
  labels: z
    .array(
      z
        .string()
        .trim()
        .min(1, 'Every button needs a label.')
        .max(20, 'WhatsApp limits button labels to 20 characters.'),
    )
    .length(3)
    .refine(
      (labels) => new Set(labels.map((l) => l.toLowerCase())).size === labels.length,
      'Button labels must be different from each other.',
    ),
});

export interface CsatSettingsView {
  enabled: boolean;
  question: string;
  /** Best, middle, worst. */
  labels: [string, string, string];
}

export function csatButtonId(surveyId: string, score: 1 | 2 | 3): string {
  return `${CSAT_BUTTON_PREFIX}${surveyId}:${score}`;
}

export function parseCsatButtonId(id: string): { surveyId: string; score: 1 | 2 | 3 } | null {
  const m = BUTTON_ID_RE.exec(id);
  if (!m) return null;
  return { surveyId: m[1] as string, score: Number(m[2]) as 1 | 2 | 3 };
}

/** The Graph request for a survey: labels best first, scored 3, 2 and 1. */
export function buildCsatRequest(
  to: string,
  question: string,
  labels: readonly [string, string, string],
  surveyId: string,
) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: question },
      action: {
        buttons: labels.map((title, i) => ({
          type: 'reply',
          reply: { id: csatButtonId(surveyId, (3 - i) as 1 | 2 | 3), title },
        })),
      },
    },
  };
}

async function loadCsatSettings(tx: Tx, tenantId: string): Promise<CsatSettingsView> {
  const [row] = await tx
    .select({
      enabled: messagingSettings.csatEnabled,
      question: messagingSettings.csatQuestion,
      labels: messagingSettings.csatLabels,
    })
    .from(messagingSettings)
    .where(eq(messagingSettings.tenantId, tenantId));
  const labels =
    row?.labels && row.labels.length === 3
      ? (row.labels as [string, string, string])
      : CSAT_DEFAULTS.labels;
  return {
    enabled: row?.enabled === true,
    question: row?.question ?? CSAT_DEFAULTS.question,
    labels,
  };
}

export interface CsatDeps {
  jobs: JobQueue;
  signer: JobSigner;
  clock: Clock;
}

/**
 * Called inside the resolve transaction (conversation row locked, case already closed by the
 * trigger). Records a survey: either queued as an interactive message through the ordinary send
 * pipeline (policy is checked again at send time), or skipped with the reason.
 */
export async function queueCsatSurvey(
  tx: Tx,
  deps: CsatDeps | null,
  ctx: TenantContext,
  conversationId: string,
): Promise<{ surveyId: string; skipped: CsatSkipReason | null } | null> {
  const settings = await loadCsatSettings(tx, ctx.tenant.id);
  if (!settings.enabled) return null;
  if (!deps) throw new Error('CSAT surveys need the job queue to send messages');
  const now = deps.clock.now();
  const [conv] = await tx
    .select({
      id: conversations.id,
      contactId: conversations.contactId,
      channelAccountId: conversations.channelAccountId,
      assignedMembershipId: conversations.assignedMembershipId,
      lastInboundAt: conversations.lastInboundAt,
      channelStatus: channelAccounts.status,
      whatsappAccountId: channelAccounts.whatsappAccountId,
    })
    .from(conversations)
    .innerJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, conversations.tenantId),
        eq(channelAccounts.id, conversations.channelAccountId),
      ),
    )
    .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)));
  if (!conv) return null;
  const [closedCase] = await tx
    .select({ id: conversationCases.id })
    .from(conversationCases)
    .where(
      and(
        eq(conversationCases.tenantId, ctx.tenant.id),
        eq(conversationCases.conversationId, conv.id),
        isNotNull(conversationCases.resolvedAt),
      ),
    )
    .orderBy(desc(conversationCases.resolvedAt))
    .limit(1);

  let skip: CsatSkipReason | null = null;
  let waId: string | null = null;
  const [recent] = await tx
    .select({ id: csatSurveys.id })
    .from(csatSurveys)
    .where(
      and(
        eq(csatSurveys.tenantId, ctx.tenant.id),
        eq(csatSurveys.conversationId, conv.id),
        isNull(csatSurveys.skipReason),
        gt(csatSurveys.createdAt, new Date(now.getTime() - CSAT_COOLDOWN_MS)),
      ),
    )
    .limit(1);
  if (recent) skip = 'recently_surveyed';
  else if (conv.channelStatus !== 'active') skip = 'channel_inactive';
  else if (!conv.lastInboundAt || now.getTime() - conv.lastInboundAt.getTime() > SERVICE_WINDOW_MS)
    skip = 'window_closed';
  else {
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
    waId = identity?.waId ?? null;
    if (!waId) skip = 'no_phone';
    else {
      const eligibility = await checkTemplateEligibility(tx, {
        tenantId: ctx.tenant.id,
        contactId: conv.contactId,
        recipientPhones: [`+${waId}`],
        category: 'UTILITY',
      });
      if (!eligibility.ok) {
        skip =
          eligibility.code === 'contact_erased'
            ? 'contact_erased'
            : eligibility.code === 'suppressed'
              ? 'suppressed'
              : 'opted_out';
      }
    }
  }

  const surveyId = uuidv7();
  const base = {
    id: surveyId,
    tenantId: ctx.tenant.id,
    conversationId: conv.id,
    caseId: closedCase?.id ?? null,
    assignedMembershipId: conv.assignedMembershipId,
    resolvedByMembershipId: ctx.membership.id,
    createdAt: now,
  };
  if (skip || !waId) {
    await tx.insert(csatSurveys).values({ ...base, skipReason: skip ?? 'no_phone' });
    return { surveyId, skipped: skip ?? 'no_phone' };
  }

  const messageId = uuidv7();
  const intentId = uuidv7();
  await tx.insert(messages).values({
    id: messageId,
    tenantId: ctx.tenant.id,
    conversationId: conv.id,
    channelAccountId: conv.channelAccountId,
    direction: 'outbound',
    type: 'interactive',
    content: { csat: true, body: settings.question, buttons: [...settings.labels] },
    status: 'queued',
    statusRank: STATUS_RANK.queued,
    senderType: 'system',
    senderMembershipId: ctx.membership.id,
  });
  await tx.insert(sendIntents).values({
    id: intentId,
    tenantId: ctx.tenant.id,
    messageId,
    channelAccountId: conv.channelAccountId,
    request: buildCsatRequest(waId, settings.question, settings.labels, surveyId),
    actorUserId: ctx.user.id,
  });
  await tx.insert(csatSurveys).values({ ...base, messageId });
  await emitTenantEvent(tx, ctx.tenant.id, {
    type: 'message.created',
    conversationId: conv.id,
    assignedMembershipId: conv.assignedMembershipId,
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
  return { surveyId, skipped: null };
}

/** Whether an inbound interactive reply is a tap on a CSAT button (by its id prefix). */
export function isCsatTap(type: string, content: Record<string, unknown>): boolean {
  if (type !== 'interactive') return false;
  const reply = content.reply as { id?: unknown } | null | undefined;
  return typeof reply?.id === 'string' && reply.id.startsWith(CSAT_BUTTON_PREFIX);
}

/**
 * Records a customer's tap as the survey's answer when it is the first answer to a survey of this
 * conversation and the tap refers to the survey's own message (Meta's `context.id`). Anything else
 * is left as an ordinary stored message.
 */
export async function recordCsatAnswer(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    buttonId: string;
    contextExternalId: string | null;
    responseMessageId: string;
    answeredAt: Date;
  },
): Promise<'recorded' | 'ignored'> {
  const parsed = parseCsatButtonId(input.buttonId);
  if (!parsed || !input.contextExternalId) return 'ignored';
  const [match] = await tx
    .select({ id: csatSurveys.id })
    .from(csatSurveys)
    .innerJoin(
      messages,
      and(eq(messages.tenantId, csatSurveys.tenantId), eq(messages.id, csatSurveys.messageId)),
    )
    .where(
      and(
        eq(csatSurveys.tenantId, input.tenantId),
        eq(csatSurveys.id, parsed.surveyId),
        eq(csatSurveys.conversationId, input.conversationId),
        eq(messages.externalMessageId, input.contextExternalId),
      ),
    );
  if (!match) return 'ignored';
  // Lock the survey row so two concurrent taps cannot both be recorded as the first answer.
  const [survey] = await tx
    .select({ id: csatSurveys.id, answeredAt: csatSurveys.answeredAt })
    .from(csatSurveys)
    .where(and(eq(csatSurveys.tenantId, input.tenantId), eq(csatSurveys.id, match.id)))
    .for('update');
  if (!survey || survey.answeredAt) return 'ignored';
  await tx
    .update(csatSurveys)
    .set({
      score: parsed.score,
      answeredAt: input.answeredAt,
      responseMessageId: input.responseMessageId,
    })
    .where(and(eq(csatSurveys.tenantId, input.tenantId), eq(csatSurveys.id, survey.id)));
  return 'recorded';
}

/** Send-time check for a CSAT message (the contact may have opted out since it was queued). */
export async function csatSendBlock(
  tx: Tx,
  input: { tenantId: string; messageId: string; contactId: string; recipient: string | null },
): Promise<{ code: string; message: string } | null> {
  const [survey] = await tx
    .select({ id: csatSurveys.id })
    .from(csatSurveys)
    .where(
      and(eq(csatSurveys.tenantId, input.tenantId), eq(csatSurveys.messageId, input.messageId)),
    );
  if (!survey) return null;
  const eligibility = await checkTemplateEligibility(tx, {
    tenantId: input.tenantId,
    contactId: input.contactId,
    recipientPhones: input.recipient ? [input.recipient] : [],
    category: 'UTILITY',
  });
  return eligibility.ok ? null : { code: eligibility.code, message: eligibility.message };
}

export function createCsatService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;
  return {
    async getCsatSettings(ctx: TenantContext): Promise<CsatSettingsView> {
      assertCan(ctx, 'tenant.read');
      return db.run(ctx.scope, (tx) => loadCsatSettings(tx, ctx.tenant.id), {
        accessMode: 'read only',
      });
    },

    async updateCsatSettings(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(csatSettingsSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const now = clock.now();
        const values = {
          csatEnabled: data.enabled,
          csatQuestion: data.question,
          csatLabels: data.labels,
          updatedByUserId: ctx.user.id,
          updatedAt: now,
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
            action: 'inbox.csat_settings_updated',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: { enabled: data.enabled },
          },
          meta,
        );
      });
    },
  };
}

export type CsatService = ReturnType<typeof createCsatService>;

/** Latest survey of a conversation, for the thread view. */
export async function latestCsatSurvey(tx: Tx, tenantId: string, conversationId: string) {
  const [row] = await tx
    .select({
      id: csatSurveys.id,
      skipReason: csatSurveys.skipReason,
      score: csatSurveys.score,
      answeredAt: csatSurveys.answeredAt,
      createdAt: csatSurveys.createdAt,
      messageStatus: messages.status,
    })
    .from(csatSurveys)
    .leftJoin(
      messages,
      and(eq(messages.tenantId, csatSurveys.tenantId), eq(messages.id, csatSurveys.messageId)),
    )
    .where(and(eq(csatSurveys.tenantId, tenantId), eq(csatSurveys.conversationId, conversationId)))
    .orderBy(desc(csatSurveys.createdAt))
    .limit(1);
  return row ?? null;
}
