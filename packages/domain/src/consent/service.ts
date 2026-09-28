import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  consentEvents,
  contactConsents,
  contacts,
  desc,
  eq,
  inArray,
  lt,
  messagingSettings,
  or,
  suppressions,
  users,
  type ConsentPurpose,
  type ConsentSource,
  type Database,
  type SuppressionReason,
  type TemplateCategory,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { attributeCampaignOptOut } from '../campaigns/attribution';
import { recordAudit, type RequestMeta } from '../audit';
import { normalizePhone } from '../contacts/phone';
import { parseInput } from '../validation';
import {
  DEFAULT_MARKETING_OPT_OUT_KEYWORDS,
  DEFAULT_OPT_IN_KEYWORDS,
  DEFAULT_OPT_OUT_KEYWORDS,
  findKeywordConflict,
  matchConsentKeyword,
  parseKeywordList,
  type KeywordSettings,
} from './keywords';

/**
 * Consent and suppression. Purposes: `marketing` governs marketing templates; `utility` governs
 * utility and authentication templates. Every change is an append-only consent event with its
 * provenance; the current state per purpose is derived by a database trigger (later events win,
 * and an opt-out wins a tie).
 *
 * Enforcement happens when a template is queued (friendly errors) and again in the worker right
 * before dispatch (authoritative): an opt-out or suppression recorded before dispatch stops a queued
 * template. Replies inside the 24-hour customer service window answer a customer who wrote in and
 * are not blocked by consent state.
 */
export interface MessagingSettings extends KeywordSettings {
  requireMarketingOptIn: boolean;
  updatedAt: Date | null;
}

export const DEFAULT_MESSAGING_SETTINGS: MessagingSettings = {
  optOutKeywords: [...DEFAULT_OPT_OUT_KEYWORDS],
  marketingOptOutKeywords: [...DEFAULT_MARKETING_OPT_OUT_KEYWORDS],
  optInKeywords: [...DEFAULT_OPT_IN_KEYWORDS],
  requireMarketingOptIn: true,
  updatedAt: null,
};

export async function loadMessagingSettings(tx: Tx, tenantId: string): Promise<MessagingSettings> {
  const [row] = await tx
    .select()
    .from(messagingSettings)
    .where(eq(messagingSettings.tenantId, tenantId));
  if (!row) return DEFAULT_MESSAGING_SETTINGS;
  return {
    optOutKeywords: row.optOutKeywords,
    marketingOptOutKeywords: row.marketingOptOutKeywords,
    optInKeywords: row.optInKeywords,
    requireMarketingOptIn: row.requireMarketingOptIn,
    updatedAt: row.updatedAt,
  };
}

export interface ConsentEventInput {
  tenantId: string;
  contactId: string;
  purpose: ConsentPurpose;
  action: 'opt_in' | 'opt_out';
  source: ConsentSource;
  channelAccountId?: string | null;
  evidence?: Record<string, unknown>;
  actorType: 'user' | 'contact' | 'system' | 'provider' | 'api_key';
  actorId?: string | null;
  occurredAt: Date;
}

/** Opt-outs that can be a reaction to a campaign (not imports or erasure). */
const ATTRIBUTABLE_OPT_OUT_SOURCES: ReadonlySet<ConsentSource> = new Set<ConsentSource>([
  'keyword',
  'provider',
  'agent',
  'api',
]);

export async function recordConsentEvents(tx: Tx, events: ConsentEventInput[]): Promise<void> {
  if (events.length === 0) return;
  for (const e of events) {
    if (
      e.action === 'opt_out' &&
      e.purpose === 'marketing' &&
      ATTRIBUTABLE_OPT_OUT_SOURCES.has(e.source)
    ) {
      await attributeCampaignOptOut(tx, {
        tenantId: e.tenantId,
        contactId: e.contactId,
        at: e.occurredAt,
      });
    }
  }
  await tx.insert(consentEvents).values(
    events.map((e) => ({
      id: uuidv7(),
      tenantId: e.tenantId,
      contactId: e.contactId,
      purpose: e.purpose,
      action: e.action,
      source: e.source,
      channelAccountId: e.channelAccountId ?? null,
      evidence: e.evidence ?? {},
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      occurredAt: e.occurredAt,
    })),
  );
}

/**
 * Meta timestamps are whole seconds, while members' actions carry milliseconds. Within that second
 * the order is unknown, so a customer's opt-out is placed at the end of its second and an opt-in at
 * the start: inside the uncertainty an opt-out wins, like an exact tie does.
 */
export function providerConsentInstant(providerSecond: Date, action: 'opt_in' | 'opt_out'): Date {
  const start = Math.floor(providerSecond.getTime() / 1000) * 1000;
  return new Date(action === 'opt_out' ? start + 999 : start);
}

/**
 * Applies a consent keyword found in an inbound message (called once per newly stored message, so
 * webhook replays never record it twice). Returns the matched action, if any.
 */
export async function applyInboundConsentKeyword(
  tx: Tx,
  input: {
    tenantId: string;
    contactId: string;
    channelAccountId: string;
    messageId: string;
    text: string | null;
    occurredAt: Date;
    settings: KeywordSettings;
  },
): Promise<'opt_out_all' | 'opt_out_marketing' | 'opt_in' | null> {
  const match = matchConsentKeyword(input.text, input.settings);
  if (!match) return null;
  const purposes: ConsentPurpose[] =
    match.action === 'opt_out_marketing' ? ['marketing'] : ['marketing', 'utility'];
  const action = match.action === 'opt_in' ? ('opt_in' as const) : ('opt_out' as const);
  await recordConsentEvents(
    tx,
    purposes.map((purpose) => ({
      tenantId: input.tenantId,
      contactId: input.contactId,
      purpose,
      action,
      source: 'keyword' as const,
      channelAccountId: input.channelAccountId,
      evidence: { messageId: input.messageId, keyword: match.keyword },
      actorType: 'contact' as const,
      occurredAt: providerConsentInstant(input.occurredAt, action),
    })),
  );
  return match.action;
}

/** Meta error 131050: the user has stopped marketing messages from this business. */
export const PROVIDER_MARKETING_OPT_OUT_CODE = 131050;

export async function recordProviderMarketingOptOut(
  tx: Tx,
  input: {
    tenantId: string;
    contactId: string;
    channelAccountId: string;
    externalMessageId: string | null;
    occurredAt: Date;
    /** True when `occurredAt` is a Meta timestamp (whole seconds). */
    providerTime: boolean;
  },
): Promise<void> {
  await recordConsentEvents(tx, [
    {
      tenantId: input.tenantId,
      contactId: input.contactId,
      purpose: 'marketing',
      action: 'opt_out',
      source: 'provider',
      channelAccountId: input.channelAccountId,
      evidence: {
        errorCode: PROVIDER_MARKETING_OPT_OUT_CODE,
        ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
      },
      actorType: 'provider',
      occurredAt: input.providerTime
        ? providerConsentInstant(input.occurredAt, 'opt_out')
        : input.occurredAt,
    },
  ]);
}

export type EligibilityBlock =
  'contact_erased' | 'suppressed' | 'opted_out' | 'no_marketing_opt_in';

export type Eligibility = { ok: true } | { ok: false; code: EligibilityBlock; message: string };

export const ELIGIBILITY_MESSAGES: Record<EligibilityBlock, string> = {
  contact_erased: 'This contact was erased.',
  suppressed: 'This number is on the company’s suppression list.',
  opted_out: 'This contact has opted out of these messages.',
  no_marketing_opt_in:
    'This contact has not opted in to marketing messages. Record their opt-in first, or change the company’s marketing consent setting.',
};

export function consentPurposeFor(category: TemplateCategory): ConsentPurpose {
  return category === 'MARKETING' ? 'marketing' : 'utility';
}

/**
 * Whether a business-initiated template of `category` may be sent to this contact now. Checked
 * inside the caller's transaction (the worker holds the send intent's row lock).
 */
export async function checkTemplateEligibility(
  tx: Tx,
  input: {
    tenantId: string;
    contactId: string;
    recipientPhones: readonly string[];
    category: TemplateCategory;
    settings?: MessagingSettings;
  },
): Promise<Eligibility> {
  const block = (code: EligibilityBlock): Eligibility => ({
    ok: false,
    code,
    message: ELIGIBILITY_MESSAGES[code],
  });
  const [contact] = await tx
    .select({ erasedAt: contacts.erasedAt, phone: contacts.phoneE164 })
    .from(contacts)
    .where(and(eq(contacts.tenantId, input.tenantId), eq(contacts.id, input.contactId)));
  if (!contact || contact.erasedAt) return block('contact_erased');
  const phones = [
    ...new Set([...input.recipientPhones, ...(contact.phone ? [contact.phone] : [])]),
  ];
  if (phones.length > 0) {
    const [suppressed] = await tx
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(
        and(eq(suppressions.tenantId, input.tenantId), inArray(suppressions.phoneE164, phones)),
      )
      .limit(1);
    if (suppressed) return block('suppressed');
  }
  const purpose = consentPurposeFor(input.category);
  const [state] = await tx
    .select({ status: contactConsents.status })
    .from(contactConsents)
    .where(
      and(
        eq(contactConsents.tenantId, input.tenantId),
        eq(contactConsents.contactId, input.contactId),
        eq(contactConsents.purpose, purpose),
      ),
    );
  if (state?.status === 'opted_out') return block('opted_out');
  if (purpose === 'marketing' && state?.status !== 'opted_in') {
    const settings = input.settings ?? (await loadMessagingSettings(tx, input.tenantId));
    if (settings.requireMarketingOptIn) return block('no_marketing_opt_in');
  }
  return { ok: true };
}

export const updateMessagingSettingsSchema = z.object({
  optOutKeywords: z.string().max(2000),
  marketingOptOutKeywords: z.string().max(2000),
  optInKeywords: z.string().max(2000),
  requireMarketingOptIn: z.boolean(),
});

export const recordConsentSchema = z.object({
  contactId: z.uuid(),
  purpose: z.enum(['marketing', 'utility']),
  action: z.enum(['opt_in', 'opt_out']),
  note: z.string().trim().max(500).optional(),
});

export const addSuppressionSchema = z.object({
  phone: z.string().max(40),
  reason: z.enum(['manual', 'complaint', 'legal']),
  note: z.string().trim().max(500).optional(),
});

export interface SuppressionRow {
  id: string;
  phoneE164: string;
  reason: SuppressionReason;
  note: string | null;
  createdByName: string | null;
  createdAt: Date;
}

export function createConsentService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;
  return {
    async getSettings(ctx: TenantContext): Promise<MessagingSettings> {
      assertCan(ctx, 'contacts.read');
      return db.run(ctx.scope, (tx) => loadMessagingSettings(tx, ctx.tenant.id), {
        accessMode: 'read only',
      });
    },

    async updateSettings(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(updateMessagingSettingsSchema, input);
      const lists = [
        parseKeywordList(data.optOutKeywords, 'Opt-out keywords'),
        parseKeywordList(data.marketingOptOutKeywords, 'Marketing opt-out keywords'),
        parseKeywordList(data.optInKeywords, 'Opt-in keywords'),
      ] as const;
      for (const list of lists) if (!list.ok) throw new AppError('validation_failed', list.message);
      const [optOut, marketingOptOut, optIn] = lists.map((l) => (l.ok ? l.keywords : []));
      if (!optOut || optOut.length === 0) {
        throw new AppError(
          'validation_failed',
          'Keep at least one opt-out keyword so customers can always stop messages.',
        );
      }
      const next = {
        optOutKeywords: optOut,
        marketingOptOutKeywords: marketingOptOut ?? [],
        optInKeywords: optIn ?? [],
      };
      const conflict = findKeywordConflict(next);
      if (conflict) throw new AppError('validation_failed', conflict);
      await db.run(ctx.scope, async (tx) => {
        await tx
          .insert(messagingSettings)
          .values({
            tenantId: ctx.tenant.id,
            ...next,
            requireMarketingOptIn: data.requireMarketingOptIn,
            updatedByUserId: ctx.user.id,
          })
          .onConflictDoUpdate({
            target: messagingSettings.tenantId,
            set: {
              ...next,
              requireMarketingOptIn: data.requireMarketingOptIn,
              updatedByUserId: ctx.user.id,
              updatedAt: clock.now(),
            },
          });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'messaging_settings.updated',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: {
              requireMarketingOptIn: data.requireMarketingOptIn,
              keywordCounts: {
                optOut: next.optOutKeywords.length,
                marketingOptOut: next.marketingOptOutKeywords.length,
                optIn: next.optInKeywords.length,
              },
            },
          },
          meta,
        );
      });
    },

    /** Records consent stated to a member (for example by phone or in person), with a note. */
    async recordConsent(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'contacts.write');
      const data = parseInput(recordConsentSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const [contact] = await tx
          .select({ id: contacts.id, erasedAt: contacts.erasedAt })
          .from(contacts)
          .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, data.contactId)));
        if (!contact) throw notFound('Contact');
        if (contact.erasedAt) throw new AppError('conflict', 'This contact was erased.');
        await recordConsentEvents(tx, [
          {
            tenantId: ctx.tenant.id,
            contactId: data.contactId,
            purpose: data.purpose,
            action: data.action,
            source: 'agent',
            evidence: data.note ? { note: data.note } : {},
            actorType: 'user',
            actorId: ctx.user.id,
            occurredAt: clock.now(),
          },
        ]);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'consent.recorded',
            subjectType: 'contact',
            subjectId: data.contactId,
            metadata: { purpose: data.purpose, consentAction: data.action },
          },
          meta,
        );
      });
    },

    async listSuppressions(
      ctx: TenantContext,
      input: { cursor?: string; limit?: number } = {},
    ): Promise<{ items: SuppressionRow[]; nextCursor: string | null }> {
      assertCan(ctx, 'contacts.read');
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      const after = input.cursor && /^[0-9a-f-]{36}$/.test(input.cursor) ? input.cursor : null;
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: suppressions.id,
              phoneE164: suppressions.phoneE164,
              reason: suppressions.reason,
              note: suppressions.note,
              createdByName: users.name,
              createdAt: suppressions.createdAt,
            })
            .from(suppressions)
            .leftJoin(users, eq(users.id, suppressions.createdByUserId))
            .where(
              and(
                eq(suppressions.tenantId, ctx.tenant.id),
                after ? lt(suppressions.id, after) : undefined,
              ),
            )
            .orderBy(desc(suppressions.id))
            .limit(limit + 1),
        { accessMode: 'read only' },
      );
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null,
      };
    },

    async addSuppression(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'contacts.write');
      const data = parseInput(addSuppressionSchema, input);
      const phone = normalizePhone(data.phone, { kind: 'explicit' });
      if (!phone.ok) throw new AppError('validation_failed', phone.message);
      return db.run(ctx.scope, async (tx) => {
        const [row] = await tx
          .insert(suppressions)
          .values({
            id: uuidv7(),
            tenantId: ctx.tenant.id,
            phoneE164: phone.e164,
            reason: data.reason,
            note: data.note || null,
            createdByUserId: ctx.user.id,
          })
          .onConflictDoNothing()
          .returning({ id: suppressions.id });
        if (!row) throw new AppError('conflict', 'This number is already on the suppression list.');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'suppression.added',
            subjectType: 'suppression',
            subjectId: row.id,
            metadata: { reason: data.reason },
          },
          meta,
        );
        return { id: row.id, phoneE164: phone.e164 };
      });
    },

    /** Removing a number lets the company message it again, so it needs settings permission. */
    async removeSuppression(ctx: TenantContext, suppressionId: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      if (!z.uuid().safeParse(suppressionId).success) throw notFound('Suppression');
      await db.run(ctx.scope, async (tx) => {
        const [row] = await tx
          .delete(suppressions)
          .where(and(eq(suppressions.tenantId, ctx.tenant.id), eq(suppressions.id, suppressionId)))
          .returning({ id: suppressions.id, reason: suppressions.reason });
        if (!row) throw notFound('Suppression');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'suppression.removed',
            subjectType: 'suppression',
            subjectId: row.id,
            metadata: { reason: row.reason },
          },
          meta,
        );
      });
    },

    /** Current state per purpose and the most recent events for one contact. */
    async consentForContact(ctx: TenantContext, contactId: string) {
      assertCan(ctx, 'contacts.read');
      if (!z.uuid().safeParse(contactId).success) throw notFound('Contact');
      return db.run(
        ctx.scope,
        async (tx) => {
          const state = await tx
            .select({
              purpose: contactConsents.purpose,
              status: contactConsents.status,
              occurredAt: contactConsents.occurredAt,
            })
            .from(contactConsents)
            .where(
              and(
                eq(contactConsents.tenantId, ctx.tenant.id),
                eq(contactConsents.contactId, contactId),
              ),
            );
          const history = await tx
            .select({
              id: consentEvents.id,
              purpose: consentEvents.purpose,
              action: consentEvents.action,
              source: consentEvents.source,
              actorType: consentEvents.actorType,
              actorName: users.name,
              evidence: consentEvents.evidence,
              occurredAt: consentEvents.occurredAt,
            })
            .from(consentEvents)
            .leftJoin(
              users,
              and(eq(consentEvents.actorType, 'user'), eq(users.id, consentEvents.actorId)),
            )
            .where(
              and(
                eq(consentEvents.tenantId, ctx.tenant.id),
                eq(consentEvents.contactId, contactId),
              ),
            )
            .orderBy(desc(consentEvents.occurredAt), desc(consentEvents.id))
            .limit(50);
          return {
            marketing: state.find((s) => s.purpose === 'marketing') ?? null,
            utility: state.find((s) => s.purpose === 'utility') ?? null,
            history,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** Suppression entries for a set of numbers (contact pages show whether a number is blocked). */
    async suppressionsFor(ctx: TenantContext, phones: string[]) {
      assertCan(ctx, 'contacts.read');
      if (phones.length === 0) return [];
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: suppressions.id,
              phoneE164: suppressions.phoneE164,
              reason: suppressions.reason,
              createdAt: suppressions.createdAt,
            })
            .from(suppressions)
            .where(
              and(
                eq(suppressions.tenantId, ctx.tenant.id),
                or(...phones.map((p) => eq(suppressions.phoneE164, p))),
              ),
            )
            .orderBy(asc(suppressions.createdAt)),
        { accessMode: 'read only' },
      );
    },
  };
}

export type ConsentService = ReturnType<typeof createConsentService>;
