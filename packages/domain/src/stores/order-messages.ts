import { clipText, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  asc,
  channelAccounts,
  commerceStoreCheckouts,
  commerceStoreMessageRules,
  commerceStoreMessages,
  commerceStoreOrderItems,
  commerceStoreOrders,
  commerceStoreShipments,
  commerceStores,
  contactIdentities,
  conversations,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  messageTemplates,
  messages,
  or,
  sendIntents,
  sql,
  suppressions,
  systemScope,
  tenants,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { lockCampaignSends, marketingCapReached } from '../campaigns/frequency-cap';
import { sendingWindow } from '../campaigns/schedule';
import { checkTemplateEligibility } from '../consent/service';
import { phoneFromWaId, waRecipientFromPhone } from '../contacts/phone';
import { contactForPhone } from '../contacts/service';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from '../messaging/events';
import { STATUS_RANK } from '../messaging/status';
import { buildTemplateSend, linkButtons, sendSpecFor } from '../templates/definition';
import {
  STORE_MESSAGE_EVENT_INFO,
  STORE_MESSAGE_LIMITS,
  canStartAutomation,
  checkoutValues,
  codPayload,
  detectOrderEvents,
  detectShipmentEvents,
  isCartEvent,
  isShipmentEvent,
  orderValues,
  parseCodPayload,
  readStoreVariables,
  resolveStoreVariables,
  storeMessageSendAt,
  trackingUpdateDecision,
  currentTrackingRevision,
  type SavedOrderChange,
  type SendWindow,
  type StoreMessageEvent,
  type StoreMessageSkipReason,
  type StoreValues,
} from './messages-model';
import { shipmentTrackingKey } from './model';
import { startStoreAutomation } from './order-automations';
import { loadEntitlements } from '../plans/entitlements';

/**
 * Order messages (P4-06c, ADR-048): recording the events a read from a store reveals, and the
 * `commerce.store-message` job that turns one into a template message. Store messages are rows
 * (at most one per order and event; per shipment and event, and per shipment and tracking, for the
 * shipment events of ADR-413), so a repeated read, a repeated job or the sweep never sends twice;
 * the chat message then goes through the normal send pipeline (send intent, consent checked again
 * at dispatch, delivery statuses from Meta).
 */

export interface StoreMessageQueueDeps {
  jobs: JobQueue;
  signer: JobSigner;
}

export interface StoreMessageWorkerDeps extends StoreMessageQueueDeps {
  db: Database;
  clock: Clock;
}

type StoreRow = typeof commerceStores.$inferSelect;

export function sendWindowOf(
  store: Pick<StoreRow, 'sendWindowStart' | 'sendWindowEnd'>,
): SendWindow | null {
  return store.sendWindowStart !== null && store.sendWindowEnd !== null
    ? { start: store.sendWindowStart, end: store.sendWindowEnd }
    : null;
}

async function companyTimeZone(tx: Tx, tenantId: string): Promise<string> {
  const [row] = await tx
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row?.timezone ?? 'UTC';
}

/** The job that handles one store message at its send time (the sweep is the safety net). */
export async function enqueueStoreMessage(
  deps: StoreMessageQueueDeps,
  tx: Tx | null,
  tenantId: string,
  storeMessageId: string,
  sendAt: Date,
): Promise<void> {
  await deps.jobs.enqueue(
    tx,
    QUEUES.commerceStoreMessage.name,
    deps.signer.sign({
      kind: 'commerce.store-message',
      tenantId,
      actorUserId: null,
      ref: storeMessageId,
    }),
    { singletonKey: `store-message:${storeMessageId}:${sendAt.getTime()}`, startAfter: sendAt },
  );
}

/**
 * Records the messages that orders changed by a read call for, in the read's own transaction (so
 * the copy and its messages move together). Nothing happens while the store has no rule switched
 * on; an order that already has a message for an event gets no second one.
 */
export async function recordOrderEvents(
  tx: Tx,
  deps: StoreMessageQueueDeps,
  store: Pick<
    StoreRow,
    'id' | 'tenantId' | 'sendWindowStart' | 'sendWindowEnd' | 'messageTestOrders'
  >,
  changes: readonly SavedOrderChange[],
  now: Date,
): Promise<number> {
  if (changes.length === 0) return 0;
  const rules = (
    await tx
      .select({
        event: commerceStoreMessageRules.event,
        enabledAt: commerceStoreMessageRules.enabledAt,
        delayMinutes: commerceStoreMessageRules.delayMinutes,
      })
      .from(commerceStoreMessageRules)
      .where(
        and(
          eq(commerceStoreMessageRules.tenantId, store.tenantId),
          eq(commerceStoreMessageRules.storeId, store.id),
          eq(commerceStoreMessageRules.enabled, true),
        ),
      )
  ).flatMap((r) => (r.enabledAt ? [{ ...r, enabledAt: r.enabledAt }] : []));
  if (rules.length === 0) return 0;
  const timeZone = await companyTimeZone(tx, store.tenantId);
  const window = sendWindowOf(store);
  const delays = new Map(rules.map((r) => [r.event, r.delayMinutes]));
  const sendAt = (event: StoreMessageEvent, occurredAt: Date, skipped: boolean) =>
    skipped
      ? now
      : storeMessageSendAt({
          occurredAt,
          now,
          delayMinutes: delays.get(event) ?? 0,
          window,
          timeZone,
        });
  const rows: (typeof commerceStoreMessages.$inferInsert)[] = [];
  const shipmentRows: (typeof commerceStoreMessages.$inferInsert)[] = [];
  for (const change of changes) {
    // Shipment messages (ADR-413): about the shipment, which names the order.
    for (const shipment of change.shipments) {
      for (const event of detectShipmentEvents({
        change: shipment,
        rules,
        includeTestOrders: store.messageTestOrders,
        now,
      })) {
        shipmentRows.push({
          id: uuidv7(),
          tenantId: store.tenantId,
          storeId: store.id,
          shipmentId: shipment.shipmentId,
          dedupeKey: event.dedupeKey,
          event: event.event,
          state: event.skip ? 'skipped' : 'pending',
          skipReason: event.skip,
          occurredAt: event.occurredAt,
          sendAt: sendAt(event.event, event.occurredAt, event.skip !== null),
        });
      }
    }
    const found = detectOrderEvents({
      previous: change.previous,
      current: change.current,
      rules,
      includeTestOrders: store.messageTestOrders,
      now,
    });
    for (const event of found) {
      rows.push({
        id: uuidv7(),
        tenantId: store.tenantId,
        storeId: store.id,
        orderId: change.orderId,
        event: event.event,
        state: event.skip ? 'skipped' : 'pending',
        skipReason: event.skip,
        occurredAt: event.occurredAt,
        sendAt: sendAt(event.event, event.occurredAt, event.skip !== null),
      });
    }
  }
  const returned = {
    id: commerceStoreMessages.id,
    state: commerceStoreMessages.state,
    sendAt: commerceStoreMessages.sendAt,
  };
  const inserted = [
    ...(rows.length === 0
      ? []
      : await tx
          .insert(commerceStoreMessages)
          .values(rows)
          .onConflictDoNothing({
            target: [
              commerceStoreMessages.tenantId,
              commerceStoreMessages.orderId,
              commerceStoreMessages.event,
            ],
          })
          .returning(returned)),
    // A shipment delivered twice, or read twice at once, still gets one message per key.
    ...(shipmentRows.length === 0
      ? []
      : await tx
          .insert(commerceStoreMessages)
          .values(shipmentRows)
          .onConflictDoNothing({
            target: [
              commerceStoreMessages.tenantId,
              commerceStoreMessages.shipmentId,
              commerceStoreMessages.event,
              commerceStoreMessages.dedupeKey,
            ],
          })
          .returning(returned)),
  ];
  for (const row of inserted) {
    if (row.state === 'pending') {
      await enqueueStoreMessage(deps, tx, store.tenantId, row.id, row.sendAt);
    }
  }
  return inserted.length;
}

/**
 * Shopify orders in transit whose delivery is due to be checked again (SH-034): shipped within
 * the last days, not delivered or cancelled, last read long enough ago. Only while the store's
 * delivered message, or one of its shipment messages (ADR-413: a later shipment of a partly shipped
 * order, or a shipment's new tracking), is switched on.
 */
/** The rules that need orders in transit read again (see transitOrdersToCheck). */
export const TRANSIT_EVENTS = ['order_delivered', 'shipment_created', 'tracking_updated'] as const;

export async function transitOrdersToCheck(
  tx: Tx,
  store: Pick<StoreRow, 'id' | 'tenantId' | 'platform'>,
  now: Date,
): Promise<string[]> {
  if (store.platform !== 'shopify') return [];
  const [rule] = await tx
    .select({ id: commerceStoreMessageRules.id })
    .from(commerceStoreMessageRules)
    .where(
      and(
        eq(commerceStoreMessageRules.tenantId, store.tenantId),
        eq(commerceStoreMessageRules.storeId, store.id),
        inArray(commerceStoreMessageRules.event, [...TRANSIT_EVENTS]),
        eq(commerceStoreMessageRules.enabled, true),
      ),
    )
    .limit(1);
  if (!rule) return [];
  const rows = await tx
    .select({ externalId: commerceStoreOrders.externalId })
    .from(commerceStoreOrders)
    .where(
      and(
        eq(commerceStoreOrders.tenantId, store.tenantId),
        eq(commerceStoreOrders.storeId, store.id),
        isNotNull(commerceStoreOrders.shippedAt),
        isNull(commerceStoreOrders.deliveredAt),
        isNull(commerceStoreOrders.cancelledAt),
        isNull(commerceStoreOrders.deletedAt),
        gt(
          commerceStoreOrders.shippedAt,
          new Date(now.getTime() - STORE_MESSAGE_LIMITS.transitDays * 86_400_000),
        ),
        or(
          isNull(commerceStoreOrders.trackedAt),
          lt(
            commerceStoreOrders.trackedAt,
            new Date(now.getTime() - STORE_MESSAGE_LIMITS.transitRereadHours * 3_600_000),
          ),
        ),
      ),
    )
    .orderBy(sql`${commerceStoreOrders.trackedAt} asc nulls first`)
    .limit(STORE_MESSAGE_LIMITS.transitPerRun);
  return rows.map((r) => r.externalId);
}

/** Marks orders as checked for delivery (also those the store did not return). */
export async function markOrdersTracked(
  tx: Tx,
  store: Pick<StoreRow, 'id' | 'tenantId'>,
  externalIds: readonly string[],
  now: Date,
): Promise<void> {
  if (externalIds.length === 0) return;
  await tx
    .update(commerceStoreOrders)
    .set({ trackedAt: now })
    .where(
      and(
        eq(commerceStoreOrders.tenantId, store.tenantId),
        eq(commerceStoreOrders.storeId, store.id),
        sql`${commerceStoreOrders.externalId} = any(${sql.param([...externalIds])}::text[])`,
      ),
    );
}

export type StoreMessageOutcome =
  | { outcome: 'queued'; messageId: string }
  | { outcome: 'started'; runId: string }
  | { outcome: 'skipped'; reason: StoreMessageSkipReason }
  | { outcome: 'rescheduled'; sendAt: Date }
  | { outcome: 'not_due' | 'not_pending' };

/**
 * The `commerce.store-message` job. Under the store message's row lock it checks, in order, that
 * the store, its opt-in confirmation and the rule still stand, that it is inside the sending
 * window, that the order (or, for cart reminders, the checkout) can still be messaged about, that
 * the template and number can be used, that every variable has a value, that the customer may
 * receive the template (suppression, erasure, opt-out, marketing opt-in) and, for a marketing
 * template, that the company's marketing frequency cap is not reached. Then it creates the chat
 * message and hands it to the send pipeline. A rule that starts an automation (ADR-050) instead
 * starts the run after the same checks up to the order and its number (see startStoreAutomation).
 * Any failed check skips the message with its reason.
 */
export async function processStoreMessage(
  deps: StoreMessageWorkerDeps,
  scope: TenantScope,
  storeMessageId: string,
): Promise<StoreMessageOutcome> {
  const now = deps.clock.now();
  const tenantId = scope.tenantId;
  return deps.db.run(scope, async (tx): Promise<StoreMessageOutcome> => {
    const [row] = await tx
      .select()
      .from(commerceStoreMessages)
      .where(
        and(
          eq(commerceStoreMessages.tenantId, tenantId),
          eq(commerceStoreMessages.id, storeMessageId),
        ),
      )
      .for('update');
    if (!row || row.state !== 'pending') return { outcome: 'not_pending' };
    if (row.sendAt.getTime() > now.getTime()) return { outcome: 'not_due' };
    const skip = async (reason: StoreMessageSkipReason): Promise<StoreMessageOutcome> => {
      await tx
        .update(commerceStoreMessages)
        .set({ state: 'skipped', skipReason: reason })
        .where(
          and(eq(commerceStoreMessages.tenantId, tenantId), eq(commerceStoreMessages.id, row.id)),
        );
      return { outcome: 'skipped', reason };
    };
    const reschedule = async (sendAt: Date): Promise<StoreMessageOutcome> => {
      await tx
        .update(commerceStoreMessages)
        .set({ sendAt })
        .where(
          and(eq(commerceStoreMessages.tenantId, tenantId), eq(commerceStoreMessages.id, row.id)),
        );
      await enqueueStoreMessage(deps, tx, tenantId, row.id, sendAt);
      return { outcome: 'rescheduled', sendAt };
    };

    const [store] = await tx
      .select()
      .from(commerceStores)
      .where(and(eq(commerceStores.tenantId, tenantId), eq(commerceStores.id, row.storeId)));
    if (!store || store.state !== 'connected') return skip('store_disconnected');
    if (!store.messagesOptInAt) return skip('no_opt_in');
    // Order messages and cart reminders are part of commerce, which a plan may leave out.
    if (!(await loadEntitlements(tx, tenantId)).modules.has('commerce')) return skip('not_in_plan');
    const [rule] = await tx
      .select()
      .from(commerceStoreMessageRules)
      .where(
        and(
          eq(commerceStoreMessageRules.tenantId, tenantId),
          eq(commerceStoreMessageRules.storeId, store.id),
          eq(commerceStoreMessageRules.event, row.event),
        ),
      );
    // A rule switched off, or switched off and on again after the event, sends nothing about it.
    if (
      !rule?.enabled ||
      !rule.enabledAt ||
      rule.enabledAt.getTime() > row.occurredAt.getTime() ||
      !rule.channelAccountId ||
      (rule.action === 'automation'
        ? !rule.automationId || !canStartAutomation(row.event)
        : !rule.templateId)
    ) {
      return skip('rule_disabled');
    }
    const window = sendWindowOf(store);
    if (window) {
      const open = sendingWindow(
        now.getTime(),
        await companyTimeZone(tx, tenantId),
        window.start,
        window.end,
      );
      if (!open.open) return reschedule(open.opensAt);
    }

    const storeName = store.name ?? store.shopDomain ?? new URL(store.storeUrl).hostname;
    // A sent "Shipment sent" message records the tracking it carried (ADR-413).
    let carriedRevision = 0;
    const carried = () =>
      row.event === 'shipment_created' ? { trackingRevision: carriedRevision } : {};
    let phone: string | null;
    let customerName: string | null;
    let values: StoreValues;
    let subject: Record<string, string | null>;
    if (isCartEvent(row.event)) {
      const [checkout] = row.checkoutId
        ? await tx
            .select()
            .from(commerceStoreCheckouts)
            .where(
              and(
                eq(commerceStoreCheckouts.tenantId, tenantId),
                eq(commerceStoreCheckouts.id, row.checkoutId),
              ),
            )
        : [];
      if (!checkout) return skip('checkout_deleted');
      if (checkout.redactedAt) return skip('customer_erased');
      if (checkout.completedAt) return skip('checkout_completed');
      if (
        now.getTime() - row.occurredAt.getTime() >
        STORE_MESSAGE_LIMITS.cartLatenessHours * 3_600_000
      ) {
        return skip('cart_too_old');
      }
      if (row.event === 'cart_second_reminder') {
        const [first] = await tx
          .select({ state: commerceStoreMessages.state, sendAt: commerceStoreMessages.sendAt })
          .from(commerceStoreMessages)
          .where(
            and(
              eq(commerceStoreMessages.tenantId, tenantId),
              eq(commerceStoreMessages.checkoutId, checkout.id),
              eq(commerceStoreMessages.event, 'cart_reminder'),
            ),
          );
        // The first reminder still waiting (both moved to the same opening of the sending
        // window): the second waits for it.
        if (first?.state === 'pending') {
          return reschedule(new Date(Math.max(now.getTime(), first.sendAt.getTime()) + 5 * 60_000));
        }
        if (first?.state !== 'queued') return skip('first_reminder_not_sent');
      }
      phone = checkout.customerPhone;
      if (!phone) return skip('no_phone');
      // The customer bought after all: an order with the same number since the checkout began.
      const [ordered] = await tx
        .select({ id: commerceStoreOrders.id })
        .from(commerceStoreOrders)
        .where(
          and(
            eq(commerceStoreOrders.tenantId, tenantId),
            eq(commerceStoreOrders.storeId, store.id),
            eq(commerceStoreOrders.customerPhone, phone),
            gte(commerceStoreOrders.placedAt, checkout.remoteCreatedAt),
          ),
        )
        .limit(1);
      if (ordered) return skip('order_placed');
      customerName = checkout.customerName;
      values = {
        subject: 'checkout',
        values: checkoutValues({
          customerName: checkout.customerName,
          currency: checkout.currency,
          totalMinor: checkout.totalMinor,
          items: checkout.items,
          recoveryUrl: checkout.recoveryUrl,
          storeName,
        }),
      };
      subject = { checkoutId: checkout.id, checkoutName: checkout.name };
    } else {
      // A shipment message (ADR-413) is about the shipment, and through it about its order.
      const [shipment] =
        isShipmentEvent(row.event) && row.shipmentId
          ? await tx
              .select()
              .from(commerceStoreShipments)
              .where(
                and(
                  eq(commerceStoreShipments.tenantId, tenantId),
                  eq(commerceStoreShipments.id, row.shipmentId),
                ),
              )
          : [];
      const orderId = isShipmentEvent(row.event) ? (shipment?.orderId ?? null) : row.orderId;
      const [order] = orderId
        ? await tx
            .select()
            .from(commerceStoreOrders)
            .where(
              and(eq(commerceStoreOrders.tenantId, tenantId), eq(commerceStoreOrders.id, orderId)),
            )
        : [];
      if (!order || order.deletedAt) return skip('order_deleted');
      if (order.redactedAt) return skip('customer_erased');
      if (row.event !== 'order_cancelled' && order.status === 'cancelled') {
        return skip('order_cancelled');
      }
      if (shipment?.failed) return skip('shipment_cancelled');
      if (shipment) {
        // Which remembered tracking the shipment has now: what this message would carry.
        carriedRevision = currentTrackingRevision(
          shipment.trackingKeys,
          shipmentTrackingKey(shipment.trackingNumber, shipment.trackingUrl),
        );
      }
      if (row.event === 'tracking_updated' && shipment) {
        const [created] = await tx
          .select({
            state: commerceStoreMessages.state,
            trackingRevision: commerceStoreMessages.trackingRevision,
            sendAt: commerceStoreMessages.sendAt,
          })
          .from(commerceStoreMessages)
          .where(
            and(
              eq(commerceStoreMessages.tenantId, tenantId),
              eq(commerceStoreMessages.shipmentId, shipment.id),
              eq(commerceStoreMessages.event, 'shipment_created'),
            ),
          );
        const decision = trackingUpdateDecision({
          revision: Number(/^tracking:(\d+)$/.exec(row.dedupeKey ?? '')?.[1] ?? 0),
          currentRevision: carriedRevision,
          created: created ?? null,
        });
        if (decision === 'wait_for_created' && created) {
          return reschedule(
            new Date(Math.max(now.getTime(), created.sendAt.getTime()) + 5 * 60_000),
          );
        }
        if (decision === 'tracking_replaced' || decision === 'tracking_already_sent') {
          return skip(decision);
        }
      }
      phone = order.customerPhone;
      if (!phone) return skip('no_phone');
      const items = await tx
        .select({
          title: commerceStoreOrderItems.title,
          quantity: commerceStoreOrderItems.quantity,
        })
        .from(commerceStoreOrderItems)
        .where(
          and(
            eq(commerceStoreOrderItems.tenantId, tenantId),
            eq(commerceStoreOrderItems.orderId, order.id),
          ),
        )
        .orderBy(asc(commerceStoreOrderItems.position));
      customerName = order.customerName;
      values = {
        subject: 'order',
        values: orderValues({
          name: order.name,
          customerName: order.customerName,
          currency: order.currency,
          totalMinor: order.totalMinor,
          items,
          statusUrl: order.statusUrl,
          // A shipment message carries its own shipment's tracking, missing parts included.
          trackingNumber: shipment ? shipment.trackingNumber : order.trackingNumber,
          trackingCompany: shipment ? shipment.trackingCompany : order.trackingCompany,
          trackingUrl: shipment ? shipment.trackingUrl : order.trackingUrl,
          storeName,
        }),
      };
      subject = {
        orderId: order.id,
        orderName: order.name,
        ...(shipment ? { shipmentId: shipment.id } : {}),
      };
      if (rule.action === 'automation' && rule.automationId && canStartAutomation(row.event)) {
        const started = await startStoreAutomation(tx, deps, {
          tenantId,
          event: row.event,
          orderId: order.id,
          automationId: rule.automationId,
          channelAccountId: rule.channelAccountId,
          phone,
          customerName,
          now,
        });
        if (!started.ok) return skip(started.reason);
        await tx
          .update(commerceStoreMessages)
          .set({
            state: 'started',
            automationRunId: started.runId,
            contactId: started.contactId,
            ...carried(),
          })
          .where(
            and(eq(commerceStoreMessages.tenantId, tenantId), eq(commerceStoreMessages.id, row.id)),
          );
        return { outcome: 'started', runId: started.runId };
      }
    }
    if (!rule.templateId) return skip('rule_disabled');

    const [template] = await tx
      .select()
      .from(messageTemplates)
      .where(
        and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, rule.templateId)),
      );
    if (
      !template ||
      template.status !== 'approved' ||
      (template.category !== 'UTILITY' && template.category !== 'MARKETING')
    ) {
      return skip('template_unavailable');
    }
    // Cart reminders are marketing (M-176).
    if (isCartEvent(row.event) && template.category !== 'MARKETING') {
      return skip('not_marketing_template');
    }
    const spec = sendSpecFor(template.category, template.components);
    if (!spec.supported) return skip('template_unavailable');
    const [channel] = await tx
      .select({
        status: channelAccounts.status,
        whatsappAccountId: channelAccounts.whatsappAccountId,
      })
      .from(channelAccounts)
      .where(
        and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.id, rule.channelAccountId)),
      );
    if (
      !channel ||
      channel.status !== 'active' ||
      channel.whatsappAccountId !== template.whatsappAccountId
    ) {
      return skip('channel_unavailable');
    }
    const payloads = new Map<number, string>();
    if (row.event === 'cod_confirmation') {
      const buttons = spec.definition.buttons;
      if (
        rule.confirmButton === null ||
        rule.cancelButton === null ||
        buttons[rule.confirmButton]?.type !== 'QUICK_REPLY' ||
        buttons[rule.cancelButton]?.type !== 'QUICK_REPLY'
      ) {
        return skip('template_changed');
      }
      payloads.set(rule.confirmButton, codPayload(row.id, 'confirm'));
      payloads.set(rule.cancelButton, codPayload(row.id, 'cancel'));
    }
    const variables = readStoreVariables(rule.variables);
    if (variables.buttons.length !== spec.buttonParams) return skip('template_changed');
    const resolved = resolveStoreVariables(variables, values, linkButtons(spec.definition));
    if (!resolved.ok) return skip('missing_variable');
    if (
      resolved.params.header.length !== spec.headerParams ||
      resolved.params.body.length !== spec.bodyParams
    ) {
      return skip('template_changed');
    }

    // A suppressed number gets no contact created; the rest is the send-time consent check.
    const [suppressed] = await tx
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(and(eq(suppressions.tenantId, tenantId), eq(suppressions.phoneE164, phone)))
      .limit(1);
    if (suppressed) return skip('suppressed');
    const contactId = await contactForPhone(tx, tenantId, {
      phoneE164: phone,
      displayName: customerName,
      source: 'store',
    });
    const eligibility = await checkTemplateEligibility(tx, {
      tenantId,
      contactId,
      recipientPhones: [phone],
      category: template.category,
    });
    if (!eligibility.ok) return skip(eligibility.code);
    if (
      template.category === 'MARKETING' &&
      (await frequencyCapped(tx, tenantId, contactId, now))
    ) {
      return skip('frequency_capped');
    }
    const [identity] = await tx
      .select({ waId: contactIdentities.waId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.tenantId, tenantId),
          eq(contactIdentities.contactId, contactId),
          eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
          isNotNull(contactIdentities.waId),
        ),
      )
      .limit(1);
    const recipient = phoneFromWaId(identity?.waId) ?? phone;
    const built = buildTemplateSend(template, spec, resolved.params, {
      quickReplyPayloads: payloads,
    });

    // The thread: one created by this message starts resolved, like a campaign's; the customer's
    // reply opens it.
    await tx
      .insert(conversations)
      .values({
        id: uuidv7(),
        tenantId,
        channelAccountId: rule.channelAccountId,
        contactId,
        status: 'resolved',
        resolvedAt: now,
      })
      .onConflictDoNothing();
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, tenantId),
          eq(conversations.channelAccountId, rule.channelAccountId),
          eq(conversations.contactId, contactId),
        ),
      )
      .for('update');
    if (!conversation) throw new Error('Conversation upsert failed');
    const messageId = uuidv7();
    const intentId = uuidv7();
    await tx.insert(messages).values({
      id: messageId,
      tenantId,
      conversationId: conversation.id,
      channelAccountId: rule.channelAccountId,
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
        store: {
          id: store.id,
          name: storeName,
          event: row.event,
          label: STORE_MESSAGE_EVENT_INFO[row.event].label,
          ...subject,
        },
      },
      status: 'queued',
      statusRank: STATUS_RANK.queued,
      senderType: 'system',
      templateId: template.id,
    });
    await tx.insert(sendIntents).values({
      id: intentId,
      tenantId,
      messageId,
      channelAccountId: rule.channelAccountId,
      request: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waRecipientFromPhone(recipient),
        type: 'template',
        template: built.template,
      },
      actorUserId: null,
    });
    await tx
      .update(conversations)
      .set({
        lastMessageAt: now,
        lastMessagePreview: clipText(built.rendered.body, 200),
        version: sql`${conversations.version} + 1`,
      })
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversation.id)));
    await tx
      .update(commerceStoreMessages)
      .set({ state: 'queued', messageId, contactId, ...carried() })
      .where(
        and(eq(commerceStoreMessages.tenantId, tenantId), eq(commerceStoreMessages.id, row.id)),
      );
    await emitTenantEvent(tx, tenantId, {
      type: 'message.created',
      conversationId: conversation.id,
      payload: { messageId },
    });
    await deps.jobs.enqueue(
      tx,
      QUEUES.messageSend.name,
      deps.signer.sign({ kind: 'message.send', tenantId, actorUserId: null, ref: intentId }),
      { singletonKey: intentId, group: { id: rule.channelAccountId } },
    );
    return { outcome: 'queued', messageId };
  });
}

/**
 * Whether the contact already received the company's maximum of marketing templates in its
 * period, counted under the campaign runner's company lock so the two never race past the cap.
 * The store message's row is the only lock held here, so waiting for the company lock is safe.
 */
async function frequencyCapped(
  tx: Tx,
  tenantId: string,
  contactId: string,
  now: Date,
): Promise<boolean> {
  await lockCampaignSends(tx, tenantId, 'wait');
  return marketingCapReached(tx, tenantId, contactId, now);
}

/** Store messages whose send time has come, across active companies (the minute sweep). */
export async function findDueStoreMessages(
  db: Database,
  limit: number = STORE_MESSAGE_LIMITS.sweepBatch,
) {
  const res = await db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; message_id: string; send_at: Date | string }>(
        sql`select tenant_id, message_id, send_at from ops.commerce_store_messages_due(${limit})`,
      ),
    { accessMode: 'read only' },
  );
  return res.rows.map((r) => ({
    tenantId: r.tenant_id,
    storeMessageId: r.message_id,
    sendAt: new Date(r.send_at),
  }));
}

/**
 * A tap on a cash on delivery message's button (research M-178), recorded on the store message.
 * It counts only from that message's own conversation (so from its contact) and, when the reply
 * names the message it answers, only for that message; an older tap arriving late does not replace
 * a newer answer. Returns the answer, or null when the tap is not such an answer.
 */
export async function recordStoreMessageAnswer(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    payload: unknown;
    contextExternalId: string | null;
    messageId: string;
    answeredAt: Date;
  },
): Promise<'confirmed' | 'cancelled' | null> {
  const parsed = parseCodPayload(input.payload);
  if (!parsed) return null;
  const [row] = await tx
    .select({
      id: commerceStoreMessages.id,
      messageId: commerceStoreMessages.messageId,
      answeredAt: commerceStoreMessages.answeredAt,
    })
    .from(commerceStoreMessages)
    .where(
      and(
        eq(commerceStoreMessages.tenantId, input.tenantId),
        eq(commerceStoreMessages.id, parsed.storeMessageId),
        eq(commerceStoreMessages.event, 'cod_confirmation'),
        eq(commerceStoreMessages.state, 'queued'),
      ),
    )
    .for('update');
  if (!row?.messageId) return null;
  const [sent] = await tx
    .select({
      conversationId: messages.conversationId,
      externalMessageId: messages.externalMessageId,
    })
    .from(messages)
    .where(and(eq(messages.tenantId, input.tenantId), eq(messages.id, row.messageId)));
  if (
    !sent ||
    sent.conversationId !== input.conversationId ||
    (input.contextExternalId !== null &&
      sent.externalMessageId !== null &&
      input.contextExternalId !== sent.externalMessageId)
  ) {
    return null;
  }
  if (!row.answeredAt || row.answeredAt.getTime() <= input.answeredAt.getTime()) {
    await tx
      .update(commerceStoreMessages)
      .set({
        answer: parsed.answer,
        answeredAt: input.answeredAt,
        answerMessageId: input.messageId,
      })
      .where(
        and(
          eq(commerceStoreMessages.tenantId, input.tenantId),
          eq(commerceStoreMessages.id, row.id),
        ),
      );
  }
  return parsed.answer;
}
