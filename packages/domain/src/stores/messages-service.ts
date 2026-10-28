import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  automationRuns,
  automationVersions,
  automations,
  channelAccounts,
  commerceStoreCheckouts,
  commerceStoreMessageRules,
  commerceStoreMessages,
  commerceStoreOrders,
  commerceStoreShipments,
  commerceStores,
  desc,
  eq,
  gt,
  inArray,
  memberships,
  messageTemplates,
  messages,
  or,
  sql,
  users,
  type AutomationRunStatus,
  type Database,
  type StoreMessageState,
  type Tx,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, can, type TenantContext } from '../authz/context';
import { parseGraph, parseTrigger } from '../automations/graph';
import { formatTimeOfDay, parseTimeOfDay } from '../campaigns/schedule';
import { linkButtons, renderPlaceholders, sendSpecFor } from '../templates/definition';
import { parseInput } from '../validation';
import {
  CART_EVENTS,
  STORE_MESSAGE_EVENTS,
  STORE_MESSAGE_EVENT_INFO,
  STORE_MESSAGE_LIMITS,
  STORE_RULE_ACTIONS,
  canStartAutomation,
  delayRange,
  eventAvailable,
  isCartEvent,
  readStoreVariables,
  storeLinkProblem,
  storeVariablesSchema,
  variablesFit,
  type StoreMessageEvent,
  type StoreMessageSkipReason,
  type StoreRuleAction,
  type StoreVariables,
} from './messages-model';
import { hasCustomerAccess, hasShipmentAccess, shopifyConsentSupported } from './model';

/**
 * Order messages for the web (P4-06c) and cart reminders (P4-06d): a store's message settings, one
 * rule per event, and what was sent. Seeing them needs `commerce.read` (customer names also
 * `contacts.read`); changing them needs `commerce.manage`, and a rule with a marketing template
 * also `campaigns.send`, as sending one by hand does. No rule can be switched on until a manager
 * confirms the store's customers opted in to WhatsApp messages (research M-175); cart reminders
 * need each customer's marketing opt-in as well. A rule for an order event can start an automation
 * instead of sending a template (ADR-050), which also needs `automations.read`.
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
  /** Send the template (default) or start an automation (order events only). */
  action: z.enum(STORE_RULE_ACTIONS).default('template'),
  automationId: z.uuid().nullable().default(null),
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
  /** Website buttons whose link ends with a value, in the order a message fills them (ADR-229). */
  links: { index: number; text: string; url: string }[];
  /** Quick-reply buttons by their position among the template's buttons. */
  quickReplies: { index: number; text: string }[];
  preview: string;
}

export interface StoreMessageRuleView {
  event: StoreMessageEvent;
  label: string;
  description: string;
  available: boolean;
  /** Whether this event's rule may start an automation (ADR-050). */
  automationAllowed: boolean;
  enabled: boolean;
  enabledAt: Date | null;
  action: StoreRuleAction;
  automationId: string | null;
  automationName: string | null;
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

/** An automation a rule can start: its live version starts from order messages. */
export interface StoreAutomationOption {
  id: string;
  name: string;
  status: 'active' | 'paused';
}

/**
 * How the report groups messages: waiting, handed to WhatsApp, Meta's statuses, and automations
 * started (their messages are the run's own).
 */
export type StoreMessageStatus =
  'waiting' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'started';

export function storeMessageStatus(
  state: StoreMessageState,
  messageStatus: string | null,
): StoreMessageStatus {
  if (state === 'pending') return 'waiting';
  if (state === 'skipped') return 'skipped';
  if (state === 'started') return 'started';
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

/**
 * The automation run a store message started (ADR-050): the automation's name and the run's
 * status, and the run's id for members who can open it (`automations.read`).
 */
export interface StoreMessageRunStart {
  automationName: string | null;
  runStatus: AutomationRunStatus | null;
  runId: string | null;
}

function runStart(
  r: { runId: string | null; runStatus: AutomationRunStatus | null; automationName: string | null },
  runsReader: boolean,
): StoreMessageRunStart | null {
  if (!r.runId) return null;
  return {
    automationName: r.automationName,
    runStatus: r.runStatus,
    runId: runsReader ? r.runId : null,
  };
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
        links: linkButtons(spec.definition),
        quickReplies: spec.definition.buttons.flatMap((b, index) =>
          b.type === 'QUICK_REPLY' ? [{ index, text: b.text }] : [],
        ),
        preview: renderPlaceholders(spec.definition).body,
      });
    }
    return options;
  }

  /**
   * The company's automations with whether their live version starts from order messages, for the
   * rules' automation choice and their problems (ADR-050).
   */
  async function automationRows(tx: Tx, ctx: TenantContext) {
    const rows = await tx
      .select({
        id: automations.id,
        name: automations.name,
        status: automations.status,
        trigger: automationVersions.trigger,
      })
      .from(automations)
      .leftJoin(
        automationVersions,
        and(
          eq(automationVersions.tenantId, automations.tenantId),
          eq(automationVersions.id, automations.activeVersionId),
        ),
      )
      .where(eq(automations.tenantId, ctx.tenant.id))
      .orderBy(asc(sql`lower(${automations.name})`), asc(automations.id));
    return rows.map((r) => {
      const trigger = r.trigger === null ? null : parseTrigger(r.trigger);
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        startsFromOrders: trigger?.ok === true && trigger.trigger.type === 'store_event',
      };
    });
  }

  /**
   * Checks the automation a rule is to start (ADR-050): active, with a live version that starts
   * from order messages and allows the rule's number, whose templates exist and belong to the
   * number's WhatsApp account. A marketing template among them needs `campaigns.send`, as choosing
   * one for a rule does.
   */
  async function checkAutomationRule(
    tx: Tx,
    ctx: TenantContext,
    data: z.infer<typeof ruleSchema>,
  ): Promise<void> {
    if (!data.channelAccountId) throw invalid('channelAccountId', 'Choose the WhatsApp number.');
    if (!data.automationId) throw invalid('automationId', 'Choose an automation.');
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
    const [automation] = await tx
      .select({ status: automations.status, activeVersionId: automations.activeVersionId })
      .from(automations)
      .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, data.automationId)));
    if (!automation) throw invalid('automationId', 'Choose an automation.');
    if (automation.status !== 'active' || !automation.activeVersionId) {
      throw invalid('automationId', 'Publish the automation and keep it active first.');
    }
    const [version] = await tx
      .select({
        trigger: automationVersions.trigger,
        graph: automationVersions.graph,
        channelAccountId: automationVersions.channelAccountId,
      })
      .from(automationVersions)
      .where(
        and(
          eq(automationVersions.tenantId, ctx.tenant.id),
          eq(automationVersions.id, automation.activeVersionId),
        ),
      );
    const trigger = parseTrigger(version?.trigger);
    const graph = parseGraph(version?.graph);
    if (!version || !trigger.ok || trigger.trigger.type !== 'store_event' || !graph.ok) {
      throw invalid(
        'automationId',
        'The live version of this automation does not start from order messages. Change its trigger and publish it again.',
      );
    }
    if (version.channelAccountId && version.channelAccountId !== data.channelAccountId) {
      throw invalid('channelAccountId', 'This automation runs only on another WhatsApp number.');
    }
    const templateIds = [
      ...new Set(
        graph.graph.nodes.flatMap((n) =>
          n.type === 'send_template' || n.type === 'ask_template' ? [n.templateId] : [],
        ),
      ),
    ];
    if (templateIds.length === 0) return;
    const used = await tx
      .select({
        whatsappAccountId: messageTemplates.whatsappAccountId,
        category: messageTemplates.category,
      })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.tenantId, ctx.tenant.id),
          inArray(messageTemplates.id, templateIds),
        ),
      );
    if (used.length !== templateIds.length) {
      throw invalid(
        'automationId',
        'A template of this automation no longer exists. Fix the automation and publish it again.',
      );
    }
    if (used.some((t) => t.whatsappAccountId !== channel.whatsappAccountId)) {
      throw invalid(
        'automationId',
        'The automation’s templates belong to another WhatsApp account than this number.',
      );
    }
    if (used.some((t) => t.category === 'MARKETING') && !can(ctx, 'campaigns.send')) {
      throw new AppError(
        'forbidden',
        'This automation sends marketing templates, which needs the campaign sending permission.',
      );
    }
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
      data.variables.body.length !== spec.bodyParams ||
      data.variables.buttons.length !== spec.buttonParams
    ) {
      throw invalid('variables', 'Choose a value for every template variable.');
    }
    const linkProblem = storeLinkProblem(data.variables, linkButtons(spec.definition));
    if (linkProblem) throw invalid('variables', linkProblem);
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
          const automationList = await automationRows(tx, ctx);
          const rules: StoreMessageRuleView[] = STORE_MESSAGE_EVENTS.map((event) => {
            const rule = saved.find((r) => r.event === event);
            const info = STORE_MESSAGE_EVENT_INFO[event];
            const template = templates.find((t) => t.id === rule?.templateId);
            const channel = channels.find((c) => c.id === rule?.channelAccountId);
            const automation = automationList.find((a) => a.id === rule?.automationId);
            let problem: string | null = null;
            if (rule?.enabled) {
              if (rule.action === 'automation') {
                if (automation?.status !== 'active' || !automation.startsFromOrders)
                  problem =
                    'The automation is paused or archived, or its live version no longer starts from order messages.';
              } else if (!template) {
                problem = 'The template is no longer approved or cannot be sent.';
              }
              if (problem === null && channel?.status !== 'active')
                problem = 'The WhatsApp number is not active.';
              else if (problem === null && store.state !== 'connected')
                problem = 'The store is not connected.';
            }
            return {
              event,
              label: info.label,
              description: info.description,
              available: eventAvailable(store.platform, event),
              automationAllowed: canStartAutomation(event),
              enabled: rule?.enabled ?? false,
              enabledAt: rule?.enabledAt ?? null,
              action: rule?.action ?? 'template',
              automationId: rule?.automationId ?? null,
              automationName: automation?.name ?? null,
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
              conversationId: sql<
                string | null
              >`coalesce(${messages.conversationId}, ${automationRuns.conversationId})`,
              runId: automationRuns.id,
              runStatus: automationRuns.status,
              automationName: automations.name,
            })
            .from(commerceStoreMessages)
            .leftJoin(
              automationRuns,
              and(
                eq(automationRuns.tenantId, commerceStoreMessages.tenantId),
                eq(automationRuns.id, commerceStoreMessages.automationRunId),
              ),
            )
            .leftJoin(
              automations,
              and(
                eq(automations.tenantId, automationRuns.tenantId),
                eq(automations.id, automationRuns.automationId),
              ),
            )
            // A shipment message's order is its shipment's (ADR-413).
            .leftJoin(
              commerceStoreShipments,
              and(
                eq(commerceStoreShipments.tenantId, commerceStoreMessages.tenantId),
                eq(commerceStoreShipments.id, commerceStoreMessages.shipmentId),
              ),
            )
            .leftJoin(
              commerceStoreOrders,
              and(
                eq(commerceStoreOrders.tenantId, commerceStoreMessages.tenantId),
                eq(
                  commerceStoreOrders.id,
                  sql`coalesce(${commerceStoreMessages.orderId}, ${commerceStoreShipments.orderId})`,
                ),
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
          const runsReader = can(ctx, 'automations.read');
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
            automation: runStart(r, runsReader),
          }));
          const counts: Record<StoreMessageStatus, number> = {
            waiting: 0,
            sending: 0,
            sent: 0,
            delivered: 0,
            read: 0,
            failed: 0,
            skipped: 0,
            started: 0,
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
              shipmentAccess: hasShipmentAccess(grantedScopes),
              storeConsentBy: consentBy?.name ?? null,
              consentSupported: shopifyConsentSupported(deps.shopifyApiVersion),
            },
            cart,
            timezone: ctx.tenant.timezone,
            rules,
            channels,
            templates,
            automations: runsReader
              ? automationList.flatMap((a): StoreAutomationOption[] =>
                  a.startsFromOrders && (a.status === 'active' || a.status === 'paused')
                    ? [{ id: a.id, name: a.name, status: a.status }]
                    : [],
                )
              : [],
            canChooseAutomations: runsReader,
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
      // A rule that sends its template keeps no automation.
      if (data.action === 'template') data.automationId = null;
      if (data.action === 'automation') {
        if (!canStartAutomation(data.event)) {
          throw invalid('action', 'This message cannot start an automation.');
        }
        if (!can(ctx, 'automations.read')) {
          throw new AppError(
            'forbidden',
            'Choosing an automation needs permission to see automations.',
          );
        }
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
        if (data.automationId) {
          const [automation] = await tx
            .select({ id: automations.id })
            .from(automations)
            .where(
              and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, data.automationId)),
            );
          if (!automation) throw invalid('automationId', 'Choose an automation.');
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
          if (data.action === 'automation') await checkAutomationRule(tx, ctx, data);
          else ({ category } = await checkEnabledRule(tx, ctx, data));
        }
        // A rule applies from the second it is switched on (stores give whole seconds, so an
        // order placed in that second counts); editing an enabled rule keeps that time.
        const switchedOn = new Date(Math.floor(now.getTime() / 1000) * 1000);
        const values = {
          enabled: data.enabled,
          enabledAt: data.enabled ? (existing?.enabled ? existing.enabledAt : switchedOn) : null,
          action: data.action,
          automationId: data.automationId,
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
              ...(data.action === 'automation'
                ? { action: data.action, automationId: data.automationId }
                : {}),
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
              conversationId: sql<
                string | null
              >`coalesce(${messages.conversationId}, ${automationRuns.conversationId})`,
              runId: automationRuns.id,
              runStatus: automationRuns.status,
              automationName: automations.name,
            })
            .from(commerceStoreMessages)
            .leftJoin(
              messages,
              and(
                eq(messages.tenantId, commerceStoreMessages.tenantId),
                eq(messages.id, commerceStoreMessages.messageId),
              ),
            )
            .leftJoin(
              automationRuns,
              and(
                eq(automationRuns.tenantId, commerceStoreMessages.tenantId),
                eq(automationRuns.id, commerceStoreMessages.automationRunId),
              ),
            )
            .leftJoin(
              automations,
              and(
                eq(automations.tenantId, automationRuns.tenantId),
                eq(automations.id, automationRuns.automationId),
              ),
            )
            // The order's shipment messages too (ADR-413).
            .leftJoin(
              commerceStoreShipments,
              and(
                eq(commerceStoreShipments.tenantId, commerceStoreMessages.tenantId),
                eq(commerceStoreShipments.id, commerceStoreMessages.shipmentId),
              ),
            )
            .where(
              and(
                eq(commerceStoreMessages.tenantId, ctx.tenant.id),
                or(eq(commerceStoreMessages.orderId, id), eq(commerceStoreShipments.orderId, id)),
              ),
            )
            .orderBy(asc(commerceStoreMessages.createdAt));
          const runsReader = can(ctx, 'automations.read');
          return rows.map(({ runId, runStatus, automationName, ...r }) => ({
            ...r,
            label: STORE_MESSAGE_EVENT_INFO[r.event].label,
            status: storeMessageStatus(r.state, r.messageStatus),
            skipReason: r.skipReason as StoreMessageSkipReason | null,
            automation: runStart({ runId, runStatus, automationName }, runsReader),
          }));
        },
        { accessMode: 'read only' },
      );
    },
  };
}

export type StoreMessagesService = ReturnType<typeof createStoreMessagesService>;
