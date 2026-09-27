import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  channelAccounts,
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
  STORE_MESSAGE_EVENTS,
  STORE_MESSAGE_EVENT_INFO,
  STORE_MESSAGE_LIMITS,
  eventAvailable,
  readStoreVariables,
  storeVariablesSchema,
  type StoreMessageEvent,
  type StoreMessageSkipReason,
  type StoreVariables,
} from './messages-model';

/**
 * Order messages for the web (P4-06c): a store's message settings, one rule per event, and what was
 * sent. Seeing them needs `commerce.read` (customer names also `contacts.read`); changing them needs
 * `commerce.manage`, and a rule with a marketing template also `campaigns.send`, as sending one by
 * hand does. No rule can be switched on until a manager confirms the store's customers opted in to
 * WhatsApp messages (research M-175).
 */

export interface StoreMessagesServiceDeps {
  db: Database;
  clock: Clock;
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

const invalid = (path: string, message: string) =>
  new AppError('validation_failed', message, { issues: [{ path, message }] });

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
              delayMinutes: rule?.delayMinutes ?? 0,
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
              customerName: commerceStoreOrders.customerName,
              messageStatus: messages.status,
              errorTitle: messages.errorTitle,
              conversationId: messages.conversationId,
            })
            .from(commerceStoreMessages)
            .innerJoin(
              commerceStoreOrders,
              and(
                eq(commerceStoreOrders.tenantId, commerceStoreMessages.tenantId),
                eq(commerceStoreOrders.id, commerceStoreMessages.orderId),
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
            customerName: customers ? r.customerName : null,
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
          return {
            store: {
              ...store,
              sendWindowStart:
                store.sendWindowStart === null ? '' : formatTimeOfDay(store.sendWindowStart),
              sendWindowEnd:
                store.sendWindowEnd === null ? '' : formatTimeOfDay(store.sendWindowEnd),
            },
            timezone: ctx.tenant.timezone,
            rules,
            channels,
            templates,
            counts,
            recent: recent.slice(0, 50),
            canManage: can(ctx, 'commerce.manage'),
          };
        },
        { accessMode: 'read only' },
      );
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
