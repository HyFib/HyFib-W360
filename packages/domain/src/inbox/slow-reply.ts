import { z } from 'zod';
import { clipText, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  asc,
  authorizedTenantScope,
  automationRuns,
  channelAccounts,
  contactIdentities,
  contacts,
  conversationTurns,
  conversations,
  eq,
  inArray,
  isNotNull,
  isNull,
  messages,
  messagingSettings,
  sendIntents,
  slowReplyMessages,
  sql,
  systemScope,
  tenants,
  type Database,
  type SlowReplySkipReason,
  type SlowReplyState,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { PLACEHOLDER_RE, renderText } from '../automations/graph';
import {
  DEFAULT_MESSAGING_SETTINGS,
  checkTemplateEligibility,
  type EligibilityBlock,
} from '../consent/service';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from '../messaging/events';
import { STATUS_RANK } from '../messaging/status';
import { parseInput } from '../validation';
import {
  calendarFor,
  loadBusinessCalendars,
  replanWaitingSlowReplies,
  type BusinessCalendar,
} from './business-hours';
import { replyDueAt } from './sla';

/**
 * The automatic reply when members are slow to answer (W-081, ADR-384). A company turns it on in
 * Settings → Inbox with a plain text and a delay. When a customer's reply turn has waited that long
 * without a member's reply (counted in business hours when they are on, as reply targets are: those
 * of the conversation's team when it has its own, ADR-389, else the company's), the worker's minute
 * sweep sends the text once in that turn, as a system message through the ordinary send pipeline
 * (message, send intent and `message.send` job in one transaction; the send worker checks the
 * window and the contact's consent again before the request leaves).
 *
 * It is never sent twice for a turn: `app.slow_reply_messages` holds one row per turn (unique),
 * written in the transaction that queues the message, under a lock on the conversation and the
 * turn, and a sent or skipped row never changes. It is sent only inside the 24-hour customer
 * service window, on an active number, to a contact with a WhatsApp id on that number's account who
 * accepts non-marketing messages (as CSAT questions are); never while an automation run handles the
 * conversation (no turn is open then) and never for a resolved conversation (a resolve ends the
 * turn). The message does not end the turn, so reply timers, overdue notices and reports still wait
 * for a member. Only waits that start after the reply was turned on get it.
 */

/** The text a company starts from. */
export const SLOW_REPLY_DEFAULTS = {
  text: 'Thank you for waiting. Our team has your message and will reply as soon as they can.',
  delayMinutes: 15,
} as const;
export const SLOW_REPLY_MAX_LENGTH = 1024;
/** The placeholders the text may hold: the contact's name and the company's (as automations). */
export const SLOW_REPLY_PLACEHOLDERS = ['name', 'company'] as const;
/** A text due longer ago than this when the sweep sees it (the worker was down) is not sent. */
export const SLOW_REPLY_LATE_LIMIT_MS = 3_600_000;
/** How long a turn the calendar never makes due (closed for a year) waits before another look. */
const NEVER_DUE_RECHECK_MS = 24 * 3_600_000;
const SERVICE_WINDOW_MS = 24 * 3_600_000;

/** The first placeholder other than {{name}} and {{company}}, or null. */
export function unknownSlowReplyPlaceholder(text: string): string | null {
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!(SLOW_REPLY_PLACEHOLDERS as readonly string[]).includes(name)) return match[0];
  }
  return null;
}

export const slowReplySettingsSchema = z.object({
  enabled: z.boolean(),
  text: z
    .string()
    .trim()
    .min(1, 'Write the automatic reply.')
    .max(SLOW_REPLY_MAX_LENGTH, `Use at most ${SLOW_REPLY_MAX_LENGTH} characters.`)
    .superRefine((text, ctx) => {
      const unknown = unknownSlowReplyPlaceholder(text);
      if (unknown) {
        ctx.addIssue({
          code: 'custom',
          message: `Unknown placeholder ${unknown}. Use {{name}} or {{company}}.`,
        });
      } else if (text.replace(PLACEHOLDER_RE, '').trim().length === 0) {
        // A text of placeholders alone could be empty (a contact without a name).
        ctx.addIssue({ code: 'custom', message: 'Write some words besides the placeholders.' });
      }
    }),
  delayMinutes: z.coerce
    .number()
    .int('Enter whole minutes.')
    .min(1, 'Enter at least 1 minute.')
    .max(1440, 'Enter at most 1440 minutes (24 hours).'),
});

export interface SlowReplySettingsView {
  enabled: boolean;
  text: string;
  delayMinutes: number;
}

interface StoredSlowReply extends SlowReplySettingsView {
  /** When it was last turned on; null while off. */
  since: Date | null;
}

async function loadSlowReplySettings(tx: Tx, tenantId: string): Promise<StoredSlowReply> {
  const [row] = await tx
    .select({
      enabled: messagingSettings.slowReplyEnabled,
      text: messagingSettings.slowReplyText,
      delayMinutes: messagingSettings.slowReplyDelayMinutes,
      since: messagingSettings.slowReplySince,
    })
    .from(messagingSettings)
    .where(eq(messagingSettings.tenantId, tenantId));
  return {
    enabled: row?.enabled === true,
    text: row?.text ?? SLOW_REPLY_DEFAULTS.text,
    delayMinutes: row?.delayMinutes ?? SLOW_REPLY_DEFAULTS.delayMinutes,
    since: row?.since ?? null,
  };
}

/**
 * When the text is due for a turn that started at `startedAt`: `delayMinutes` later, counted in
 * business hours when the company uses them (`calendar`), otherwise in absolute time; null when
 * the calendar opens for less than the delay within a year.
 */
export function slowReplyDueAt(
  delayMinutes: number,
  calendar: BusinessCalendar | null,
  startedAt: Date,
): Date | null {
  return replyDueAt({ minutes: delayMinutes, calendar }, startedAt);
}

/**
 * What the sweep does with an open reply turn: `ignore` it (its text was sent or skipped already,
 * the conversation is gone or resolved, an automation run handles it, or the wait started before
 * the reply was turned on), `wait` until `dueAt` (not due yet; when the calendar never opens for
 * the delay within a year, a day from now), or handle it as `due`.
 */
export type SlowReplyPlan =
  { kind: 'ignore' } | { kind: 'wait'; dueAt: Date } | { kind: 'due'; dueAt: Date };

export function planSlowReply(input: {
  recorded: SlowReplyState | undefined;
  conversationStatus: string | undefined;
  automationActive: boolean;
  startedAt: Date;
  since: Date;
  delayMinutes: number;
  calendar: BusinessCalendar | null;
  now: Date;
}): SlowReplyPlan {
  if (input.recorded && input.recorded !== 'waiting') return { kind: 'ignore' };
  if (!input.conversationStatus || input.conversationStatus === 'resolved')
    return { kind: 'ignore' };
  if (input.automationActive || input.startedAt < input.since) return { kind: 'ignore' };
  const dueAt = slowReplyDueAt(input.delayMinutes, input.calendar, input.startedAt);
  if (!dueAt) return { kind: 'wait', dueAt: new Date(input.now.getTime() + NEVER_DUE_RECHECK_MS) };
  return dueAt > input.now ? { kind: 'wait', dueAt } : { kind: 'due', dueAt };
}

/**
 * What the sweep does with a turn whose text is due: why it is not sent, or `send`. Lateness counts
 * from the due time, or from the time a waiting row was put off to (`waitedUntil`) when that is
 * later: a row is only looked at again then, so a delay cut short or a calendar changed meanwhile
 * does not make it late.
 */
export function slowReplyOutcome(input: {
  dueAt: Date;
  waitedUntil?: Date | null;
  now: Date;
  channelStatus: string | null;
  lastInboundAt: Date | null;
}): 'send' | Extract<SlowReplySkipReason, 'too_late' | 'channel_inactive' | 'window_closed'> {
  const now = input.now.getTime();
  const lateFrom = Math.max(input.dueAt.getTime(), input.waitedUntil?.getTime() ?? 0);
  if (now - lateFrom > SLOW_REPLY_LATE_LIMIT_MS) return 'too_late';
  if (input.channelStatus !== 'active') return 'channel_inactive';
  if (!input.lastInboundAt || now - input.lastInboundAt.getTime() > SERVICE_WINDOW_MS)
    return 'window_closed';
  return 'send';
}

/** Why a contact may not be sent the text, from the consent check (as CSAT questions). */
export function slowReplyConsentSkip(code: EligibilityBlock): SlowReplySkipReason {
  return code === 'contact_erased'
    ? 'contact_erased'
    : code === 'suppressed'
      ? 'suppressed'
      : 'opted_out';
}

/** The text for one customer: {{name}} is their name (empty without one), {{company}} the company's. */
export function renderSlowReply(
  text: string,
  values: { contactName: string | null; companyName: string },
): string {
  return renderText(text, { ...values, variables: {} });
}

/** The Graph request of the text: plain, without link previews. */
export function buildSlowReplyRequest(to: string, body: string) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body, preview_url: false },
  };
}

export interface SlowReplyDeps {
  db: Database;
  clock: Clock;
  jobs: JobQueue;
  signer: JobSigner;
}

export interface SlowReplySweep {
  sent: number;
  /** Turns business hours put off. */
  waiting: number;
  skipped: number;
  /** Companies whose turns could not be worked through; the next sweep tries them again. */
  failed: { tenantId: string; error: unknown }[];
}

/** Sends the automatic reply to customers who have waited past the company's delay (see above). */
export async function sendSlowReplies(deps: SlowReplyDeps, limit = 200): Promise<SlowReplySweep> {
  const now = deps.clock.now();
  const rows = await deps.db.run(
    systemScope,
    async (tx) =>
      (
        await tx.execute<{ tenant_id: string; turn_id: string }>(
          sql`select tenant_id, turn_id from ops.slow_reply_turns(${now.toISOString()}::timestamptz, ${limit})`,
        )
      ).rows,
    { accessMode: 'read only' },
  );
  const byTenant = new Map<string, string[]>();
  for (const row of rows) {
    const turns = byTenant.get(row.tenant_id) ?? [];
    turns.push(row.turn_id);
    byTenant.set(row.tenant_id, turns);
  }
  const sweep: SlowReplySweep = { sent: 0, waiting: 0, skipped: 0, failed: [] };
  for (const [tenantId, turnIds] of byTenant) {
    try {
      // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
      const outcome = await deps.db.run(authorizedTenantScope(tenantId, null), (tx) =>
        sendCompanySlowReplies(deps, tx, tenantId, turnIds, now),
      );
      sweep.sent += outcome.sent;
      sweep.waiting += outcome.waiting;
      sweep.skipped += outcome.skipped;
    } catch (error) {
      sweep.failed.push({ tenantId, error });
    }
  }
  return sweep;
}

type CompanyOutcome = Omit<SlowReplySweep, 'failed'>;

async function sendCompanySlowReplies(
  deps: SlowReplyDeps,
  tx: Tx,
  tenantId: string,
  turnIds: readonly string[],
  now: Date,
): Promise<CompanyOutcome> {
  const outcome: CompanyOutcome = { sent: 0, waiting: 0, skipped: 0 };
  const settings = await loadSlowReplySettings(tx, tenantId);
  if (!settings.enabled || !settings.since) return outcome;
  const [company] = await tx
    .select({ name: tenants.name, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!company) return outcome;
  // The company's calendar and its teams' own (ADR-389), loaded once for the sweep.
  const calendars = await loadBusinessCalendars(tx, tenantId, company.timezone);

  // Lock the conversations, then the turns: the order a member's reply, a resolve and the start of
  // an automation run take them (each ends the turn), so each either waits for this or is seen.
  // Conversations another transaction holds (a member's reply, a campaign batch) are skipped and
  // looked at in the next sweep: the sweep never waits on a conversation lock, so it cannot deadlock
  // with updates that take many conversations in another order.
  const candidates = await tx
    .select({ conversationId: conversationTurns.conversationId })
    .from(conversationTurns)
    .where(
      and(eq(conversationTurns.tenantId, tenantId), inArray(conversationTurns.id, [...turnIds])),
    );
  const conversationIds = [...new Set(candidates.map((c) => c.conversationId))].sort();
  if (conversationIds.length === 0) return outcome;
  const convs = new Map(
    (
      await tx
        .select({
          id: conversations.id,
          status: conversations.status,
          contactId: conversations.contactId,
          channelAccountId: conversations.channelAccountId,
          assignedMembershipId: conversations.assignedMembershipId,
          teamId: conversations.teamId,
          lastInboundAt: conversations.lastInboundAt,
        })
        .from(conversations)
        .where(
          and(eq(conversations.tenantId, tenantId), inArray(conversations.id, conversationIds)),
        )
        .orderBy(asc(conversations.id))
        .for('update', { skipLocked: true })
    ).map((c) => [c.id, c]),
  );
  if (convs.size === 0) return outcome;
  const turns = await tx
    .select({
      id: conversationTurns.id,
      conversationId: conversationTurns.conversationId,
      startedAt: conversationTurns.startedAt,
    })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.tenantId, tenantId),
        inArray(conversationTurns.id, [...turnIds]),
        inArray(conversationTurns.conversationId, [...convs.keys()]),
        isNull(conversationTurns.endedAt),
      ),
    )
    .orderBy(asc(conversationTurns.id))
    .for('update');
  if (turns.length === 0) return outcome;
  const rows = new Map(
    (
      await tx
        .select({
          turnId: slowReplyMessages.turnId,
          state: slowReplyMessages.state,
          dueAt: slowReplyMessages.dueAt,
        })
        .from(slowReplyMessages)
        .where(
          and(
            eq(slowReplyMessages.tenantId, tenantId),
            inArray(
              slowReplyMessages.turnId,
              turns.map((t) => t.id),
            ),
          ),
        )
    ).map((r) => [r.turnId, r]),
  );
  const recorded = new Map([...rows].map(([turnId, r]) => [turnId, r.state]));
  const running = new Set(
    (
      await tx
        .select({ conversationId: automationRuns.conversationId })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.tenantId, tenantId),
            inArray(automationRuns.conversationId, conversationIds),
            inArray(automationRuns.status, ['running', 'waiting']),
          ),
        )
    ).map((r) => r.conversationId),
  );

  const record = async (
    turnId: string,
    values:
      | { state: 'waiting'; dueAt: Date }
      | { state: 'sent'; dueAt: Date; messageId: string }
      | { state: 'skipped'; dueAt: Date; skipReason: SlowReplySkipReason },
  ) => {
    const row = {
      state: values.state,
      dueAt: values.dueAt,
      messageId: values.state === 'sent' ? values.messageId : null,
      skipReason: values.state === 'skipped' ? values.skipReason : null,
      updatedAt: now,
    };
    if (recorded.has(turnId)) {
      await tx
        .update(slowReplyMessages)
        .set(row)
        .where(and(eq(slowReplyMessages.tenantId, tenantId), eq(slowReplyMessages.turnId, turnId)));
    } else {
      await tx.insert(slowReplyMessages).values({ id: uuidv7(), tenantId, turnId, ...row });
    }
  };
  const skip = async (turnId: string, dueAt: Date, skipReason: SlowReplySkipReason) => {
    await record(turnId, { state: 'skipped', dueAt, skipReason });
    outcome.skipped += 1;
  };

  for (const turn of turns) {
    const conv = convs.get(turn.conversationId);
    const plan = planSlowReply({
      recorded: recorded.get(turn.id),
      conversationStatus: conv?.status,
      automationActive: running.has(turn.conversationId),
      startedAt: turn.startedAt,
      since: settings.since,
      delayMinutes: settings.delayMinutes,
      // The business hours of the conversation's team when it has its own, else the company's.
      calendar: conv ? calendarFor(calendars, conv.teamId) : null,
      now,
    });
    if (plan.kind === 'ignore' || !conv) continue;
    if (plan.kind === 'wait') {
      await record(turn.id, { state: 'waiting', dueAt: plan.dueAt });
      outcome.waiting += 1;
      continue;
    }
    const { dueAt } = plan;
    const [channel] = await tx
      .select({
        status: channelAccounts.status,
        whatsappAccountId: channelAccounts.whatsappAccountId,
      })
      .from(channelAccounts)
      .where(
        and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.id, conv.channelAccountId)),
      );
    const waiting = rows.get(turn.id);
    const decision = slowReplyOutcome({
      dueAt,
      waitedUntil: waiting?.state === 'waiting' ? waiting.dueAt : null,
      now,
      channelStatus: channel?.status ?? null,
      lastInboundAt: conv.lastInboundAt,
    });
    if (decision !== 'send' || !channel) {
      await skip(turn.id, dueAt, decision === 'send' ? 'channel_inactive' : decision);
      continue;
    }
    const [contact] = await tx
      .select({ name: contacts.displayName, erasedAt: contacts.erasedAt })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, conv.contactId)));
    // Erasure removes the contact's identities, so it is told apart before they are looked up.
    if (!contact || contact.erasedAt) {
      await skip(turn.id, dueAt, 'contact_erased');
      continue;
    }
    const [identity] = await tx
      .select({ waId: contactIdentities.waId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.tenantId, tenantId),
          eq(contactIdentities.contactId, conv.contactId),
          eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
          isNotNull(contactIdentities.waId),
        ),
      )
      .limit(1);
    const waId = identity?.waId ?? null;
    if (!waId) {
      await skip(turn.id, dueAt, 'no_phone');
      continue;
    }
    const eligibility = await checkTemplateEligibility(tx, {
      tenantId,
      contactId: conv.contactId,
      recipientPhones: [`+${waId}`],
      category: 'UTILITY',
    });
    if (!eligibility.ok) {
      await skip(turn.id, dueAt, slowReplyConsentSkip(eligibility.code));
      continue;
    }
    const body = renderSlowReply(settings.text, {
      contactName: contact.name,
      companyName: company.name,
    });
    const messageId = uuidv7();
    const intentId = uuidv7();
    await tx.insert(messages).values({
      id: messageId,
      tenantId,
      conversationId: conv.id,
      channelAccountId: conv.channelAccountId,
      direction: 'outbound',
      type: 'text',
      content: { text: body, slowReply: true },
      status: 'queued',
      statusRank: STATUS_RANK.queued,
      senderType: 'system',
      senderMembershipId: null,
    });
    await tx.insert(sendIntents).values({
      id: intentId,
      tenantId,
      messageId,
      channelAccountId: conv.channelAccountId,
      request: buildSlowReplyRequest(waId, body),
      actorUserId: null,
    });
    await record(turn.id, { state: 'sent', dueAt, messageId });
    await tx
      .update(conversations)
      .set({ lastMessageAt: now, lastMessagePreview: clipText(body, 200) })
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conv.id)));
    await emitTenantEvent(tx, tenantId, {
      type: 'message.created',
      conversationId: conv.id,
      assignedMembershipId: conv.assignedMembershipId,
      payload: { messageId },
    });
    await deps.jobs.enqueue(
      tx,
      QUEUES.messageSend.name,
      deps.signer.sign({ kind: 'message.send', tenantId, actorUserId: null, ref: intentId }),
      { singletonKey: intentId, group: { id: conv.channelAccountId } },
    );
    outcome.sent += 1;
  }
  return outcome;
}

/**
 * Whether a queued automatic reply's wait ended before it could be sent: a member answered, the
 * conversation was resolved or an automation took it over (each ends the reply turn). The send
 * pipeline then cancels it rather than deliver it after the answer, for example once a number that
 * was reconnecting is active again. False for any other message.
 */
export async function slowReplyWaitEnded(
  tx: Tx,
  input: { tenantId: string; messageId: string },
): Promise<boolean> {
  const [row] = await tx
    .select({ endedAt: conversationTurns.endedAt, status: conversations.status })
    .from(slowReplyMessages)
    .innerJoin(
      conversationTurns,
      and(
        eq(conversationTurns.tenantId, slowReplyMessages.tenantId),
        eq(conversationTurns.id, slowReplyMessages.turnId),
      ),
    )
    .innerJoin(
      conversations,
      and(
        eq(conversations.tenantId, conversationTurns.tenantId),
        eq(conversations.id, conversationTurns.conversationId),
      ),
    )
    .where(
      and(
        eq(slowReplyMessages.tenantId, input.tenantId),
        eq(slowReplyMessages.messageId, input.messageId),
      ),
    );
  return row !== undefined && (row.endedAt !== null || row.status === 'resolved');
}

/**
 * Send-time check of a queued automatic reply: the contact may have opted out, been suppressed or
 * erased since it was queued. Null for any other message.
 */
export async function slowReplySendBlock(
  tx: Tx,
  input: { tenantId: string; messageId: string; contactId: string; recipient: string | null },
): Promise<{ code: string; message: string } | null> {
  const [row] = await tx
    .select({ id: slowReplyMessages.id })
    .from(slowReplyMessages)
    .where(
      and(
        eq(slowReplyMessages.tenantId, input.tenantId),
        eq(slowReplyMessages.messageId, input.messageId),
      ),
    );
  if (!row) return null;
  const eligibility = await checkTemplateEligibility(tx, {
    tenantId: input.tenantId,
    contactId: input.contactId,
    recipientPhones: input.recipient ? [input.recipient] : [],
    category: 'UTILITY',
  });
  return eligibility.ok ? null : { code: eligibility.code, message: eligibility.message };
}

/**
 * What a save does to `slow_reply_since`: `keep` it while the reply stays on, `start` it (the
 * database's time, as reply turns') when the reply is turned on, `clear` it when turned off.
 */
export function slowReplySinceChange(
  current: { enabled: boolean; since: Date | null },
  enabled: boolean,
): 'keep' | 'start' | 'clear' {
  if (!enabled) return 'clear';
  return current.enabled && current.since ? 'keep' : 'start';
}

export function createSlowReplyService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;
  return {
    async getSlowReplySettings(ctx: TenantContext): Promise<SlowReplySettingsView> {
      assertCan(ctx, 'tenant.read');
      return db.run(
        ctx.scope,
        async (tx) => {
          const { enabled, text, delayMinutes } = await loadSlowReplySettings(tx, ctx.tenant.id);
          return { enabled, text, delayMinutes };
        },
        { accessMode: 'read only' },
      );
    },

    async updateSlowReplySettings(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      // Turning the reply off needs no valid text or delay: invalid ones keep the stored values.
      const { enabled } = parseInput(z.object({ enabled: z.boolean() }), input);
      const data =
        enabled || slowReplySettingsSchema.safeParse(input).success
          ? parseInput(slowReplySettingsSchema, input)
          : null;
      await db.run(ctx.scope, async (tx) => {
        const now = clock.now();
        // Locked, so two saves agree on when the reply was turned on.
        const [current] = await tx
          .select({
            enabled: messagingSettings.slowReplyEnabled,
            since: messagingSettings.slowReplySince,
            text: messagingSettings.slowReplyText,
            delayMinutes: messagingSettings.slowReplyDelayMinutes,
          })
          .from(messagingSettings)
          .where(eq(messagingSettings.tenantId, ctx.tenant.id))
          .for('update');
        const change = slowReplySinceChange(current ?? { enabled: false, since: null }, enabled);
        const delayMinutes =
          data?.delayMinutes ?? current?.delayMinutes ?? SLOW_REPLY_DEFAULTS.delayMinutes;
        const values = {
          slowReplyEnabled: enabled,
          slowReplyText: data?.text ?? current?.text ?? SLOW_REPLY_DEFAULTS.text,
          slowReplyDelayMinutes: delayMinutes,
          slowReplySince:
            change === 'keep' ? (current?.since ?? null) : change === 'start' ? sql`now()` : null,
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
        // A changed delay can make a waiting reply due earlier or later: plan it again.
        await replanWaitingSlowReplies(tx, ctx.tenant.id);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'inbox.slow_reply_updated',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: { enabled, delayMinutes },
          },
          meta,
        );
      });
    },
  };
}

export type SlowReplyService = ReturnType<typeof createSlowReplyService>;
