import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  channelAccounts,
  commerceStoreCheckouts,
  commerceStoreMessageRules,
  commerceStoreMessages,
  commerceStoreOrders,
  commerceStores,
  desc,
  eq,
  gt,
  inArray,
  memberships,
  messageTemplates,
  messages,
  sql,
  users,
  type Database,
  type Tx,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, can, type TenantContext } from '../authz/context';
import { formatTimeOfDay, parseTimeOfDay } from '../campaigns/schedule';
import { renderPlaceholders, sendSpecFor } from '../templates/definition';
import { parseInput } from '../validation';
import {
  CART_EVENTS,
  STORE_MESSAGE_EVENTS,
  STORE_MESSAGE_EVENT_INFO,
  STORE_MESSAGE_LIMITS,
  delayRange,
  eventAvailable,
  isCartEvent,
  readStoreVariables,
  storeVariablesSchema,
  variablesFit,
  type StoreMessageEvent,
  type StoreMessageSkipReason,
  type StoreVariables,
} from './messages-model';
import { hasCustomerAccess, shopifyConsentSupported } from './model';

/**
 * Order messages for the web (P4-06c) and cart reminders (P4-06d): a store's message settings, one
 * rule per event, and what was sent. Seeing them needs `commerce.read` (customer names also
 * `contacts.read`); changing them needs `commerce.manage`, and a rule with a marketing template
 * also `campaigns.send`, as sending one by hand does. No rule can be switched on until a manager
 * confirms the store's customers opted in to WhatsApp messages (research M-175); cart reminders
 * need each customer's marketing opt-in as well.
 */

export interface StoreMessagesServiceDeps {
  db: Database;
  clock: Clock;
  /** The Shopify Admin API version HyFib uses (the store's consent needs 2026-07 or later). */
  shopifyApiVersion?: string | null;
}

const timeOfDay = z
  .string()
  .trim()
  .refine((v) => v === '' || parseTimeOfDay(v) !== null, 'Enter a time such as 09:00.');

const settingsSchema = z.object({
  storeId: z.uuid(),
  optIn: z.boolean(),
  windowStart: timeOfDay,
  windowEnd: timeOfDay,
  testOrders: z.boolean(),
});

const ruleSchema = z.object({
  storeId: z.uuid(),
  event: z.enum(STORE_MESSAGE_EVENTS),
  enabled: z.boolean(),
  channelAccountId: z.uuid().nullable(),
  templateId: z.uuid().nullable(),
  variables: storeVariablesSchema,
  delayMinutes: z.number().int().min(0).max(STORE_MESSAGE_LIMITS.maxDelayMinutes),
  confirmButton: z.number().int().min(0).max(9).nullable(),
  cancelButton: z.number().int().min(0).max(9).nullable(),
  /** The rule's version when the form was opened (0 when it had never been saved). */
  version: z.number().int().min(0),
});

const storeConsentSchema = z.object({ storeId: z.uuid(), useStoreConsent: z.boolean() });

const invalid = (path: string, message: string) =>
  new AppError('validation_failed', message, { issues: [{ path, message }] });

/** Minutes as the rule forms say them: "30 minutes", "4 hours", "3 days". */
function minutesText(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minutes`;
}

export interface StoreMessageTemplateOption {
  id: string;
  name: string;
  language: string;
  category: 'UTILITY' | 'MARKETING';
  whatsappAccountId: string;
  headerParams: number;
  bodyParams: number;
  /** Quick-reply buttons by their position among the template's buttons. */
  quickReplies: { index: number; text: string }[];
  preview: string;
}

export interface StoreMessageRuleView {
  event: StoreMessageEvent;
  label: string;
  description: string;
  available: boolean;
  enabled: boolean;
  enabledAt: Date | null;
  channelAccountId: string | null;
  templateId: string | null;
  variables: StoreVariables;
  delayMinutes: number;
  confirmButton: number | null;
  cancelButton: number | null;
  version: number;
  /** What would stop an enabled rule from sending now (checked again for every message). */
  problem: string | null;
}

/** How the report groups messages: waiting, handed to WhatsApp, and Meta's statuses. */
export type StoreMessageStatus =
  'waiting' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';

export function storeMessageStatus(
  state: 'pending' | 'queued' | 'skipped',
  messageStatus: string | null,
): StoreMessageStatus {
  if (state === 'pending') return 'waiting';
  if (state === 'skipped') return 'skipped';
  switch (messageStatus) {
    // Accepted by the Cloud API; Meta's own `sent` status may follow.
    case 'accepted':
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
    case 'played':
      return 'read';
    case 'failed':
    case 'canceled':
    case 'unknown_outcome':
      return 'failed';
    default:
      return 'sending';
  }
}

export function createStoreMessagesService(deps: StoreMessagesServiceDeps) {
  const { db } = deps;

  const lockStore = async (tx: Tx, ctx: TenantContext, storeId: string) => {
    const [store] = await tx
      .select()
      .from(commerceStores)
      .where(and(eq(commerceStores.tenantId, ctx.tenant.id), eq(commerceStores.id, storeId)))
      .for('update');
    if (!store) throw notFound('Store not found.');
    return store;
  };

  /** Approved utility and marketing templates HyFib can send, for the given WhatsApp accounts. */
  async function templateOptions(
    tx: Tx,
    ctx: TenantContext,
    whatsappAccountIds: string[],
  ): Promise<StoreMessageTemplateOption[]> {
    if (whatsappAccountIds.length === 0) return [];
    const rows = await tx
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.tenantId, ctx.tenant.id),
          eq(messageTemplates.status, 'approved'),
          inArray(messageTemplates.category, ['UTILITY', 'MARKETING']),
          inArray(messageTemplates.whatsappAccountId, whatsappAccountIds),
        ),
      )
      .orderBy(asc(messageTemplates.name), asc(messageTemplates.language));
    const options: StoreMessageTemplateOption[] = [];
    for (const t of rows) {
      const spec = sendSpecFor(t.category, t.components);
      if (!spec.supported || t.category === 'AUTHENTICATION') continue;
      options.push({
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        whatsappAccountId: t.whatsappAccountId,
        headerParams: spec.headerParams,
        bodyParams: spec.bodyParams,
        quickReplies: spec.definition.buttons.flatMap((b, index) =>
          b.type === 'QUICK_REPLY' ? [{ index, text: b.text }] : [],
        ),
        preview: renderPlaceholders(spec.definition).body,
      });
    }
    return options;
  }

  /**
   * Checks a rule that is to be switched on against its template and number. Returns the template
   * (for the audit entry) or throws the member-facing problem.
   */
  async function checkEnabledRule(
    tx: Tx,
    ctx: TenantContext,
    data: z.infer<typeof ruleSchema>,
  ): Promise<{ category: string }> {
    if (!data.channelAccountId) throw invalid('channelAccountId', 'Choose the WhatsApp number.');
    if (!data.templateId) throw invalid('templateId', 'Choose an approved template.');
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
    if (!channel) throw invalid('channelAccountId', 'Choose the WhatsApp number.');
    if (channel.status !== 'active') {
      throw invalid('channelAccountId', 'This WhatsApp number is not active.');
    }
    const [template] = await tx
      .select()
      .from(messageTemplates)
      .where(
        and(eq(messageTemplates.tenantId, ctx.tenant.id), eq(messageTemplates.id, data.templateId)),
      );
    if (!template) throw invalid('templateId', 'Choose an approved template.');
    if (template.whatsappAccountId !== channel.whatsappAccountId) {
      throw invalid(
        'templateId',
        'This template belongs to another WhatsApp account than the chosen number.',
      );
    }
    if (template.status !== 'approved') {
      throw invalid('templateId', 'Only templates approved by Meta can be used.');
    }
    if (template.category !== 'UTILITY' && template.category !== 'MARKETING') {
      throw invalid('templateId', 'Choose a utility or marketing template.');
    }
    if (isCartEvent(data.event) && template.category !== 'MARKETING') {
      throw invalid(
        'templateId',
        'Cart reminders are marketing messages: choose an approved marketing template.',
      );
    }
    if (template.category === 'MARKETING' && !can(ctx, 'campaigns.send')) {
      throw new AppError(
        'forbidden',
        'Using a marketing template needs the campaign sending permission.',
      );
    }
    const spec = sendSpecFor(template.category, template.components);
    if (!spec.supported) throw invalid('templateId', spec.reason);
    if (
      data.variables.header.length !== spec.headerParams ||
      data.variables.body.length !== spec.bodyParams
    ) {
      throw invalid('variables', 'Choose a value for every template variable.');
    }
    if (data.event === 'cod_confirmation') {
      const buttons = spec.definition.buttons;
      if (
        data.confirmButton === null ||
        data.cancelButton === null ||
        data.confirmButton === data.cancelButton ||
        buttons[data.confirmButton]?.type !== 'QUICK_REPLY' ||
        buttons[data.cancelButton]?.type !== 'QUICK_REPLY'
      ) {
        throw invalid(
          'confirmButton',
          'Choose which of the template’s quick reply buttons confirms the order and which cancels it.',
        );
      }
    }
    return { category: template.category };
  }

  /**
   * Cart reminders of the last 30 days (ADR-049): reminders sent (handed to WhatsApp, leaving out
   * those WhatsApp failed, cancelled or never confirmed), checkouts recovered (completed after one
   * of those reminders) and their value per currency.
   */
  async function cartReport(tx: Tx, ctx: TenantContext, storeId: string, since: Date) {
    const res = await tx.execute<{
      sent: number;
      recovered: number;
      currency: string | null;
      value: string | null;
    }>(sql`
      with reminders as (
        select m.checkout_id, msg.created_at
          from app.commerce_store_messages m
          join app.messages msg on msg.tenant_id = m.tenant_id and msg.id = m.message_id
         where m.tenant_id = ${ctx.tenant.id} and m.store_id = ${storeId}
           and m.checkout_id is not null and m.state = 'queued'
           and msg.status not in ('failed', 'canceled', 'unknown_outcome')
           and m.created_at > ${since.toISOString()}::timestamptz
      ),
      sent as (
        select checkout_id, min(created_at) as first_sent from reminders group by checkout_id
      ),
      recovered as (
        select k.id, k.currency, k.total_minor
          from sent s
          join app.commerce_store_checkouts k on k.tenant_id = ${ctx.tenant.id} and k.id = s.checkout_id
         where k.completed_at is not null and k.completed_at > s.first_sent
      )
      select (select count(*)::int from reminders) as sent,
             (select count(*)::int from recovered) as recovered,
             r.currency, sum(r.total_minor)::text as value
        from (select 1) one
        left join recovered r on true
       group by r.currency`);
    const rows = res.rows;
    return {
      sent: rows[0]?.sent ?? 0,
      recovered: rows[0]?.recovered ?? 0,
      value: rows
        .filter((r) => r.currency !== null && r.value !== null)
        .map((r) => ({ currency: r.currency as string, totalMinor: Number(r.value) })),
    };
  }

  return {
    /**
     * A store's Messages page: its settings, one rule per event, the numbers and templates a rule
     * can use, and the last 30 days of messages.
     */
    async storeMessages(ctx: TenantContext, storeId: string) {
      assertCan(ctx, 'commerce.read');
      const { id } = parseInput(z.object({ id: z.uuid() }), { id: storeId });
      const now = deps.clock.now();
      return db.run(
        ctx.scope,
        async (tx) => {
          const [store] = await tx
            .select({
              id: commerceStores.id,
              platform: commerceStores.platform,
              name: commerceStores.name,
              shopDomain: commerceStores.shopDomain,
              storeUrl: commerceStores.storeUrl,
              state: commerceStores.state,
              messagesOptInAt: commerceStores.messagesOptInAt,
              optInBy: sql<string | null>`coalesce(${memberships.displayName}, ${users.name})`,
              sendWindowStart: commerceStores.sendWindowStart,
              sendWindowEnd: commerceStores.sendWindowEnd,
              messageTestOrders: commerceStores.messageTestOrders,
              grantedScopes: commerceStores.grantedScopes,
              customerAccessRequestedAt: commerceStores.customerAccessRequestedAt,
              accessError: commerceStores.accessError,
              storeConsentAt: commerceStores.storeConsentAt,
              checkoutsReadAt: commerceStores.checkoutsReadAt,
              checkoutsError: commerceStores.checkoutsError,
              detailsWithheld: commerceStores.detailsWithheld,
            })
            .from(commerceStores)
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, commerceStores.tenantId),
                eq(memberships.id, commerceStores.messagesOptInMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .where(and(eq(commerceStores.tenantId, ctx.tenant.id), eq(commerceStores.id, id)));
          if (!store) throw notFound('Store not found.');
          const [consentBy] = store.storeConsentAt
            ? await tx
                .select({
                  name: sql<string | null>`coalesce(${memberships.displayName}, ${users.name})`,
                })
                .from(commerceStores)
                .innerJoin(
                  memberships,
                  and(
                    eq(memberships.tenantId, commerceStores.tenantId),
                    eq(memberships.id, commerceStores.storeConsentMembershipId),
                  ),
                )
                .leftJoin(users, eq(users.id, memberships.userId))
                .where(and(eq(commerceStores.tenantId, ctx.tenant.id), eq(commerceStores.id, id)))
            : [];
          const channels = await tx
            .select({
              id: channelAccounts.id,
              whatsappAccountId: channelAccounts.whatsappAccountId,
              displayPhoneNumber: channelAccounts.displayPhoneNumber,
              verifiedName: channelAccounts.verifiedName,
              status: channelAccounts.status,
            })
            .from(channelAccounts)
            .where(eq(channelAccounts.tenantId, ctx.tenant.id))
            .orderBy(asc(channelAccounts.createdAt));
          const templates = await templateOptions(tx, ctx, [
            ...new Set(channels.map((c) => c.whatsappAccountId)),
          ]);
          const saved = await tx
            .select()
            .from(commerceStoreMessageRules)
            .where(
              and(
                eq(commerceStoreMessageRules.tenantId, ctx.tenant.id),
                eq(commerceStoreMessageRules.storeId, id),
              ),
            );
          const rules: StoreMessageRuleView[] = STORE_MESSAGE_EVENTS.map((event) => {
            const rule = saved.find((r) => r.event === event);
            const info = STORE_MESSAGE_EVENT_INFO[event];
            const template = templates.find((t) => t.id === rule?.templateId);
            const channel = channels.find((c) => c.id === rule?.channelAccountId);
            let problem: string | null = null;
            if (rule?.enabled) {
              if (!template) problem = 'The template is no longer approved or cannot be sent.';
              else if (channel?.status !== 'active') problem = 'The WhatsApp number is not active.';
              else if (store.state !== 'connected') problem = 'The store is not connected.';
            }
            return {
              event,
              label: info.label,
              description: info.description,
              available: eventAvailable(store.platform, event),
              enabled: rule?.enabled ?? false,
              enabledAt: rule?.enabledAt ?? null,
              channelAccountId: rule?.channelAccountId ?? null,
              templateId: rule?.templateId ?? null,
              variables: readStoreVariables(rule?.variables),
              delayMinutes: rule?.delayMinutes ?? delayRange(event).min,
              confirmButton: rule?.confirmButton ?? null,
              cancelButton: rule?.cancelButton ?? null,
              version: rule?.version ?? 0,
              problem,
            };
          });
          const since = new Date(now.getTime() - 30 * 86_400_000);
          const recentRows = await tx
            .select({
              id: commerceStoreMessages.id,
              event: commerceStoreMessages.event,
              state: commerceStoreMessages.state,
              skipReason: commerceStoreMessages.skipReason,
              occurredAt: commerceStoreMessages.occurredAt,
              sendAt: commerceStoreMessages.sendAt,
              answer: commerceStoreMessages.answer,
              answeredAt: commerceStoreMessages.answeredAt,
              createdAt: commerceStoreMessages.createdAt,
              orderId: commerceStoreOrders.id,
              orderName: commerceStoreOrders.name,
              orderCustomerName: commerceStoreOrders.customerName,
              checkoutId: commerceStoreCheckouts.id,
              checkoutName: commerceStoreCheckouts.name,
              checkoutExternalId: commerceStoreCheckouts.externalId,
              checkoutCustomerName: commerceStoreCheckouts.customerName,
              messageStatus: messages.status,
              errorTitle: messages.errorTitle,
              conversationId: messages.conversationId,
            })
            .from(commerceStoreMessages)
            .leftJoin(
              commerceStoreOrders,
              and(
                eq(commerceStoreOrders.tenantId, commerceStoreMessages.tenantId),
                eq(commerceStoreOrders.id, commerceStoreMessages.orderId),
              ),
            )
            .leftJoin(
              commerceStoreCheckouts,
              and(
                eq(commerceStoreCheckouts.tenantId, commerceStoreMessages.tenantId),
                eq(commerceStoreCheckouts.id, commerceStoreMessages.checkoutId),
              ),
            )
            .leftJoin(
              messages,
              and(
                eq(messages.tenantId, commerceStoreMessages.tenantId),
                eq(messages.id, commerceStoreMessages.messageId),
              ),
            )
            .where(
              and(
                eq(commerceStoreMessages.tenantId, ctx.tenant.id),
                eq(commerceStoreMessages.storeId, id),
                gt(commerceStoreMessages.createdAt, since),
              ),
            )
            .orderBy(desc(commerceStoreMessages.createdAt), desc(commerceStoreMessages.id))
            .limit(500);
          const customers = can(ctx, 'contacts.read');
          const recent = recentRows.map((r) => ({
            id: r.id,
            event: r.event,
            label: STORE_MESSAGE_EVENT_INFO[r.event].label,
            status: storeMessageStatus(r.state, r.messageStatus),
            skipReason: r.skipReason as StoreMessageSkipReason | null,
            errorTitle: r.errorTitle,
            occurredAt: r.occurredAt,
            sendAt: r.sendAt,
            answer: r.answer,
            answeredAt: r.answeredAt,
            createdAt: r.createdAt,
            orderId: r.orderId,
            orderName: r.orderName,
            checkoutId: r.checkoutId,
            checkoutName:
              r.checkoutId === null ? null : (r.checkoutName ?? `Checkout ${r.checkoutExternalId}`),
            customerName: customers ? (r.orderCustomerName ?? r.checkoutCustomerName) : null,
            conversationId: customers ? r.conversationId : null,
          }));
          const counts: Record<StoreMessageStatus, number> = {
            waiting: 0,
            sending: 0,
            sent: 0,
            delivered: 0,
            read: 0,
            failed: 0,
            skipped: 0,
          };
          for (const r of recent) counts[r.status] += 1;
          const cart = store.platform === 'shopify' ? await cartReport(tx, ctx, id, since) : null;
          const { grantedScopes, ...shown } = store;
          return {
            store: {
              ...shown,
              sendWindowStart:
                store.sendWindowStart === null ? '' : formatTimeOfDay(store.sendWindowStart),
              sendWindowEnd:
                store.sendWindowEnd === null ? '' : formatTimeOfDay(store.sendWindowEnd),
              customerAccess: hasCustomerAccess(grantedScopes),
              storeConsentBy: consentBy?.name ?? null,
              consentSupported: shopifyConsentSupported(deps.shopifyApiVersion),
            },
            cart,
            timezone: ctx.tenant.timezone,
            rules,
            channels,
            templates,
            counts,
            recent: recent.slice(0, 50),
            canManage: can(ctx, 'commerce.manage'),
            canManageConsent: can(ctx, 'commerce.manage') && can(ctx, 'contacts.write'),
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * Turns the use of the WhatsApp consent the store records on or off (ADR-049). Turning it on
     * needs customer access in Shopify and an API version that has the consent; while it is on,
     * checkout reads record that consent as consent events. Consent recorded already stays.
     */
    async saveStoreConsent(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      // It writes consent records for the company's contacts.
      assertCan(ctx, 'contacts.write');
      const data = parseInput(storeConsentSchema, input);
      const now = deps.clock.now();
      return db.run(ctx.scope, async (tx) => {
        const store = await lockStore(tx, ctx, data.storeId);
        if (store.platform !== 'shopify') {
          throw invalid('useStoreConsent', 'Only Shopify stores record WhatsApp consent.');
        }
        if (data.useStoreConsent) {
          if (store.state !== 'connected') {
            throw invalid('useStoreConsent', 'Only a connected store can be read.');
          }
          if (!shopifyConsentSupported(deps.shopifyApiVersion)) {
            throw invalid(
              'useStoreConsent',
              'HyFib uses a Shopify API version without WhatsApp consent (2026-07 or later is needed).',
            );
          }
          if (!hasCustomerAccess(store.grantedScopes)) {
            throw invalid(
              'useStoreConsent',
              'First allow HyFib to read the store’s customers in Shopify.',
            );
          }
        }
        const on = store.storeConsentAt !== null;
        if (on !== data.useStoreConsent) {
          await tx
            .update(commerceStores)
            .set(
              data.useStoreConsent
                ? { storeConsentAt: now, storeConsentMembershipId: ctx.membership.id }
                : { storeConsentAt: null, storeConsentMembershipId: null },
            )
            .where(
              and(eq(commerceStores.tenantId, ctx.tenant.id), eq(commerceStores.id, store.id)),
            );
          await recordAudit(
            tx,
            ctx,
            {
              action: 'commerce.store_consent_saved',
              subjectType: 'commerce_store',
              subjectId: store.id,
              metadata: { useStoreConsent: data.useStoreConsent },
            },
            meta,
          );
        }
        return { ok: true as const };
      });
    },

    /**
     * Saves a store's message settings. Withdrawing the opt-in confirmation switches every rule
     * off (messages still waiting are then not sent).
     */
    async saveMessageSettings(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      const data = parseInput(settingsSchema, input);
      const start = data.windowStart ? parseTimeOfDay(data.windowStart) : null;
      const end = data.windowEnd ? parseTimeOfDay(data.windowEnd) : null;
      if ((start === null) !== (end === null)) {
        throw invalid('windowEnd', 'Enter both times, or neither to send at any time.');
      }
      if (start !== null && start === end) {
        throw invalid('windowEnd', 'The window must end at another time than it starts.');
      }
      const now = deps.clock.now();
      return db.run(ctx.scope, async (tx) => {
        const store = await lockStore(tx, ctx, data.storeId);
        const optInChanged = data.optIn !== (store.messagesOptInAt !== null);
        await tx
          .update(commerceStores)
          .set({
            ...(optInChanged
              ? data.optIn
                ? { messagesOptInAt: now, messagesOptInMembershipId: ctx.membership.id }
                : { messagesOptInAt: null, messagesOptInMembershipId: null }
              : {}),
            sendWindowStart: start,
            sendWindowEnd: end,
            messageTestOrders: data.testOrders,
            version: store.version + 1,
          })
          .where(and(eq(commerceStores.tenantId, ctx.tenant.id), eq(commerceStores.id, store.id)));
        if (optInChanged && !data.optIn) {
          await tx
            .update(commerceStoreMessageRules)
            .set({
              enabled: false,
              enabledAt: null,
              version: sql`${commerceStoreMessageRules.version} + 1`,
              updatedByMembershipId: ctx.membership.id,
            })
            .where(
              and(
                eq(commerceStoreMessageRules.tenantId, ctx.tenant.id),
                eq(commerceStoreMessageRules.storeId, store.id),
                eq(commerceStoreMessageRules.enabled, true),
              ),
            );
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.store_message_settings_saved',
            subjectType: 'commerce_store',
            subjectId: store.id,
            metadata: {
              optIn: data.optIn,
              ...(optInChanged ? { optInChanged: true } : {}),
              window: start === null ? null : `${data.windowStart}-${data.windowEnd}`,
              testOrders: data.testOrders,
            },
          },
          meta,
        );
        return { ok: true as const };
      });
    },

    /**
     * Saves one event's rule. Switching it on needs the opt-in confirmation, a connected store, an
     * active number and an approved template that HyFib can fill completely; it then applies only
     * to what happens from now on.
     */
    async saveMessageRule(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      const data = parseInput(ruleSchema, input);
      if (
        data.event !== 'cod_confirmation' &&
        (data.confirmButton !== null || data.cancelButton !== null)
      ) {
        throw invalid('confirmButton', 'Only the cash on delivery message uses buttons.');
      }
      const range = delayRange(data.event);
      if (data.delayMinutes < range.min || data.delayMinutes > range.max) {
        throw invalid(
          'delayMinutes',
          `Wait between ${minutesText(range.min)} and ${minutesText(range.max)}.`,
        );
      }
      if (!variablesFit(data.event, data.variables)) {
        throw invalid('variables', 'Choose values this message can fill.');
      }
      const now = deps.clock.now();
      return db.run(ctx.scope, async (tx) => {
        const store = await lockStore(tx, ctx, data.storeId);
        if (!eventAvailable(store.platform, data.event)) {
          throw invalid('event', 'This message is not available for this kind of store.');
        }
        const [existing] = await tx
          .select()
          .from(commerceStoreMessageRules)
          .where(
            and(
              eq(commerceStoreMessageRules.tenantId, ctx.tenant.id),
              eq(commerceStoreMessageRules.storeId, store.id),
              eq(commerceStoreMessageRules.event, data.event),
            ),
          )
          .for('update');
        if ((existing?.version ?? 0) !== data.version) {
          throw new AppError(
            'conflict',
            'Someone else changed this message meanwhile. Reload the page and try again.',
          );
        }
        let category: string | null = null;
        // The two cart reminders: the second follows the first, later.
        const cartRules = isCartEvent(data.event)
          ? await tx
              .select()
              .from(commerceStoreMessageRules)
              .where(
                and(
                  eq(commerceStoreMessageRules.tenantId, ctx.tenant.id),
                  eq(commerceStoreMessageRules.storeId, store.id),
                  inArray(commerceStoreMessageRules.event, [...CART_EVENTS]),
                ),
              )
              .for('update')
          : [];
        const first = cartRules.find((r) => r.event === 'cart_reminder');
        const second = cartRules.find((r) => r.event === 'cart_second_reminder');
        if (data.enabled) {
          if (!store.messagesOptInAt) {
            throw invalid(
              'enabled',
              'First confirm that this store’s customers agreed to receive WhatsApp messages.',
            );
          }
          if (store.state !== 'connected') {
            throw invalid('enabled', 'Only a connected store can send messages.');
          }
          if (data.event === 'cart_second_reminder') {
            if (!first?.enabled) {
              throw invalid('enabled', 'Switch the first cart reminder on first.');
            }
            if (data.delayMinutes <= first.delayMinutes) {
              throw invalid(
                'delayMinutes',
                'The second reminder has to come later than the first one.',
              );
            }
          }
          if (
            data.event === 'cart_reminder' &&
            second?.enabled &&
            data.delayMinutes >= second.delayMinutes
          ) {
            throw invalid('delayMinutes', 'The first reminder has to come before the second one.');
          }
          ({ category } = await checkEnabledRule(tx, ctx, data));
        }
        // A rule applies from the second it is switched on (stores give whole seconds, so an
        // order placed in that second counts); editing an enabled rule keeps that time.
        const switchedOn = new Date(Math.floor(now.getTime() / 1000) * 1000);
        const values = {
          enabled: data.enabled,
          enabledAt: data.enabled ? (existing?.enabled ? existing.enabledAt : switchedOn) : null,
          channelAccountId: data.channelAccountId,
          templateId: data.templateId,
          variables: data.variables,
          delayMinutes: data.delayMinutes,
          confirmButton: data.event === 'cod_confirmation' ? data.confirmButton : null,
          cancelButton: data.event === 'cod_confirmation' ? data.cancelButton : null,
          updatedByMembershipId: ctx.membership.id,
        };
        if (existing) {
          await tx
            .update(commerceStoreMessageRules)
            .set({ ...values, version: existing.version + 1 })
            .where(
              and(
                eq(commerceStoreMessageRules.tenantId, ctx.tenant.id),
                eq(commerceStoreMessageRules.id, existing.id),
              ),
            );
        } else {
          await tx.insert(commerceStoreMessageRules).values({
            id: uuidv7(),
            tenantId: ctx.tenant.id,
            storeId: store.id,
            event: data.event,
            ...values,
          });
        }
        // Switching the first cart reminder off switches the second off too.
        const secondOff =
          data.event === 'cart_reminder' && !data.enabled && second?.enabled === true;
        if (secondOff && second) {
          await tx
            .update(commerceStoreMessageRules)
            .set({
              enabled: false,
              enabledAt: null,
              version: second.version + 1,
              updatedByMembershipId: ctx.membership.id,
            })
            .where(
              and(
                eq(commerceStoreMessageRules.tenantId, ctx.tenant.id),
                eq(commerceStoreMessageRules.id, second.id),
              ),
            );
        }
        if (isCartEvent(data.event)) {
          // Checkouts are read while a cart reminder is on, from the moment the first went on.
          const wasOn = cartRules.some((r) => r.enabled);
          const nowOn =
            data.enabled ||
            cartRules.some((r) => r.enabled && r.event !== data.event && !secondOff);
          if (nowOn && !wasOn) {
            await tx
              .update(commerceStores)
              .set({
                checkoutsCursor: switchedOn,
                checkoutsPage: null,
                checkoutsReadAt: now,
                checkoutsError: null,
              })
              .where(
                and(eq(commerceStores.tenantId, ctx.tenant.id), eq(commerceStores.id, store.id)),
              );
          } else if (!nowOn && wasOn) {
            await tx
              .update(commerceStores)
              .set({ checkoutsReadAt: null, checkoutsPage: null, checkoutsError: null })
              .where(
                and(eq(commerceStores.tenantId, ctx.tenant.id), eq(commerceStores.id, store.id)),
              );
          }
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.store_message_rule_saved',
            subjectType: 'commerce_store',
            subjectId: store.id,
            metadata: {
              event: data.event,
              enabled: data.enabled,
              templateId: data.templateId,
              channelAccountId: data.channelAccountId,
              ...(category ? { category } : {}),
              delayMinutes: data.delayMinutes,
              ...(secondOff ? { secondReminderSwitchedOff: true } : {}),
            },
          },
          meta,
        );
        return { ok: true as const };
      });
    },

    /** The messages about one order (the order page). */
    async orderMessages(ctx: TenantContext, orderId: string) {
      assertCan(ctx, 'commerce.read');
      assertCan(ctx, 'contacts.read');
      const { id } = parseInput(z.object({ id: z.uuid() }), { id: orderId });
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({
              id: commerceStoreMessages.id,
              event: commerceStoreMessages.event,
              state: commerceStoreMessages.state,
              skipReason: commerceStoreMessages.skipReason,
              occurredAt: commerceStoreMessages.occurredAt,
              sendAt: commerceStoreMessages.sendAt,
              answer: commerceStoreMessages.answer,
              answeredAt: commerceStoreMessages.answeredAt,
              messageStatus: messages.status,
              errorTitle: messages.errorTitle,
              conversationId: messages.conversationId,
            })
            .from(commerceStoreMessages)
            .leftJoin(
              messages,
              and(
                eq(messages.tenantId, commerceStoreMessages.tenantId),
                eq(messages.id, commerceStoreMessages.messageId),
              ),
            )
            .where(
              and(
                eq(commerceStoreMessages.tenantId, ctx.tenant.id),
                eq(commerceStoreMessages.orderId, id),
              ),
            )
            .orderBy(asc(commerceStoreMessages.createdAt));
          return rows.map((r) => ({
            ...r,
            label: STORE_MESSAGE_EVENT_INFO[r.event].label,
            status: storeMessageStatus(r.state, r.messageStatus),
            skipReason: r.skipReason as StoreMessageSkipReason | null,
          }));
        },
        { accessMode: 'read only' },
      );
    },
  };
}

export type StoreMessagesService = ReturnType<typeof createStoreMessagesService>;
