import { z } from 'zod';
import { AppError, notFound } from '@w360/core';
import {
  and,
  asc,
  commerceOrderItems,
  commerceOrders,
  desc,
  eq,
  exactTimestamp,
  inArray,
  ORDER_STATUSES,
  sql,
  type OrderStatus,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { MEMBER_ORDER_TRANSITIONS, ORDER_REFERENCE_RE } from '../commerce/model';
import { writeLockedOrderStatus } from '../commerce/service';
import type { OutboundDeps } from '../messaging/outbound';
import { loadEntitlements } from '../plans/entitlements';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiActor, assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * WhatsApp orders through the public API (ADR-167): the carts customers send from the company's
 * WhatsApp catalog, as the Orders page shows them and as `order.received` webhooks describe them
 * (ADR-085), with the conversation, the contact and the number by id only. A key needs
 * `orders.read`, and the company's plan Commerce. Payment Links and Razorpay's payment ids are
 * never read; an erased contact's orders keep no note (erasure clears it). With `orders.write` a
 * key confirms, fulfils and cancels them as members do (ADR-168); payment stays with members and
 * Razorpay.
 */

export const apiOrderListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    status: z.enum(ORDER_STATUSES).optional().describe('Only orders in this status.'),
    contactId: z.uuid().optional().describe('Only the orders of this contact.'),
    conversationId: z.uuid().optional().describe('Only the orders sent in this conversation.'),
    reference: z
      .string()
      .regex(ORDER_REFERENCE_RE, 'Give an order’s reference, like K7M2QX9P.')
      .optional()
      .describe('Only the order with this reference, in capitals as members and customers see it.'),
    updatedSince: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        'Only orders changed at or after this time (received, a new status, or the note cleared when the contact was erased).',
      ),
  })
  .strict();

/** What `PATCH /orders/{id}` takes: the status to move the order to, from the one expected. */
export const apiUpdateOrderSchema = z
  .object({
    status: z
      .enum(['confirmed', 'fulfilled', 'cancelled'])
      .describe(
        'The status to move the order to, as members do: a received order is confirmed or cancelled, a confirmed one fulfilled or cancelled, a paid one fulfilled.',
      ),
    expectedStatus: z
      .enum(ORDER_STATUSES)
      .optional()
      .describe(
        'Move the order only from this status: one in another status is refused (409), unless it already has `status`.',
      ),
  })
  .strict();

export interface ApiOrderItem {
  retailerId: string;
  name: string | null;
  quantity: number;
  unitPriceMinor: number | null;
  currency: string | null;
}

export interface ApiOrder {
  id: string;
  reference: string;
  status: OrderStatus;
  statusChangedAt: string;
  conversationId: string;
  contactId: string;
  channelId: string;
  messageId: string;
  catalogId: string;
  currency: string | null;
  subtotalMinor: number | null;
  itemCount: number;
  droppedItems: number;
  customerNote: string | null;
  items: ApiOrderItem[];
  receivedAt: string;
  paidAt: string | null;
  updatedAt: string;
}

const orderColumns = {
  id: commerceOrders.id,
  reference: commerceOrders.reference,
  status: commerceOrders.status,
  statusChangedAt: commerceOrders.statusChangedAt,
  conversationId: commerceOrders.conversationId,
  contactId: commerceOrders.contactId,
  channelId: commerceOrders.channelAccountId,
  messageId: commerceOrders.messageId,
  catalogId: commerceOrders.metaCatalogId,
  currency: commerceOrders.currency,
  subtotalMinor: commerceOrders.subtotalMinor,
  itemCount: commerceOrders.itemCount,
  droppedItems: commerceOrders.droppedItems,
  customerNote: commerceOrders.customerNote,
  receivedAt: commerceOrders.receivedAt,
  paidAt: commerceOrders.paidAt,
  updatedAt: commerceOrders.updatedAt,
  cursorAt: exactTimestamp(commerceOrders.receivedAt),
};

interface OrderRow {
  id: string;
  reference: string;
  status: OrderStatus;
  statusChangedAt: Date;
  conversationId: string;
  contactId: string;
  channelId: string;
  messageId: string;
  catalogId: string;
  currency: string | null;
  subtotalMinor: number | null;
  itemCount: number;
  droppedItems: number;
  customerNote: string | null;
  receivedAt: Date;
  paidAt: Date | null;
  updatedAt: Date;
}

const toApiOrder = (row: OrderRow, items: ApiOrderItem[]): ApiOrder => ({
  id: row.id,
  reference: row.reference,
  status: row.status,
  statusChangedAt: row.statusChangedAt.toISOString(),
  conversationId: row.conversationId,
  contactId: row.contactId,
  channelId: row.channelId,
  messageId: row.messageId,
  catalogId: row.catalogId,
  currency: row.currency,
  subtotalMinor: row.subtotalMinor,
  itemCount: row.itemCount,
  droppedItems: row.droppedItems,
  customerNote: row.customerNote,
  items,
  receivedAt: row.receivedAt.toISOString(),
  paidAt: row.paidAt?.toISOString() ?? null,
  updatedAt: row.updatedAt.toISOString(),
});

/** Orders are Commerce's: a plan without it reads none, as it sends no products (ADR-086). */
async function assertCommerceInPlan(tx: Tx, tenantId: string): Promise<void> {
  const entitlements = await loadEntitlements(tx, tenantId);
  if (!entitlements.modules.has('commerce')) {
    throw new AppError('forbidden', "Your company's plan does not include Commerce.", {
      details: { apiReason: 'not_in_plan' },
    });
  }
}

/**
 * The items of the given orders in cart order, by order. Items are written with their order and
 * never change, so a read beside the orders' needs no shared snapshot.
 */
async function itemsOf(
  tx: Tx,
  tenantId: string,
  orderIds: readonly string[],
): Promise<Map<string, ApiOrderItem[]>> {
  const items = new Map<string, ApiOrderItem[]>();
  if (orderIds.length === 0) return items;
  const rows = await tx
    .select({
      orderId: commerceOrderItems.orderId,
      retailerId: commerceOrderItems.retailerId,
      name: commerceOrderItems.name,
      quantity: commerceOrderItems.quantity,
      unitPriceMinor: commerceOrderItems.unitPriceMinor,
      currency: commerceOrderItems.currency,
    })
    .from(commerceOrderItems)
    .where(
      and(
        eq(commerceOrderItems.tenantId, tenantId),
        inArray(commerceOrderItems.orderId, [...orderIds]),
      ),
    )
    .orderBy(asc(commerceOrderItems.orderId), asc(commerceOrderItems.position));
  for (const { orderId, ...item } of rows) {
    const list = items.get(orderId);
    if (list) list.push(item);
    else items.set(orderId, [item]);
  }
  return items;
}

/**
 * The company's WhatsApp orders, newest first by when they were received, on exact keyset pages:
 * a page never skips or repeats an order. Only reads, so it records nothing.
 */
export async function apiListOrders(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiOrder[]; nextCursor: string | null }> {
  assertScope(ctx, 'orders.read');
  const q = parseInput(apiOrderListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCommerceInPlan(tx, ctx.tenant.id);
      const rows = await tx
        .select(orderColumns)
        .from(commerceOrders)
        .where(
          and(
            eq(commerceOrders.tenantId, ctx.tenant.id),
            q.status ? eq(commerceOrders.status, q.status) : undefined,
            q.contactId ? eq(commerceOrders.contactId, q.contactId) : undefined,
            q.conversationId ? eq(commerceOrders.conversationId, q.conversationId) : undefined,
            q.reference ? eq(commerceOrders.reference, q.reference) : undefined,
            q.updatedSince
              ? sql`${commerceOrders.updatedAt} >= ${q.updatedSince}::timestamptz`
              : undefined,
            cursor
              ? sql`(${commerceOrders.receivedAt}, ${commerceOrders.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(commerceOrders.receivedAt), desc(commerceOrders.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      const items = await itemsOf(
        tx,
        ctx.tenant.id,
        shown.map((row) => row.id),
      );
      return {
        data: shown.map((row) => toApiOrder(row, items.get(row.id) ?? [])),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** One of the company's orders with its items, or null when it has none with this id. */
async function readApiOrder(tx: Tx, tenantId: string, orderId: string): Promise<ApiOrder | null> {
  const [row] = await tx
    .select(orderColumns)
    .from(commerceOrders)
    .where(and(eq(commerceOrders.tenantId, tenantId), eq(commerceOrders.id, orderId)));
  if (!row) return null;
  const items = await itemsOf(tx, tenantId, [row.id]);
  return toApiOrder(row, items.get(row.id) ?? []);
}

/** One of the company's WhatsApp orders, with its items. */
export async function apiGetOrder(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  orderId: string,
): Promise<ApiOrder> {
  assertScope(ctx, 'orders.read');
  if (!z.uuid().safeParse(orderId).success) throw notFound('Order');
  const order = await deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCommerceInPlan(tx, ctx.tenant.id);
      return readApiOrder(tx, ctx.tenant.id, orderId);
    },
    { accessMode: 'read only' },
  );
  if (!order) throw notFound('Order');
  return order;
}

/** A refusal that names the order's status, as `status` gives it. */
const orderStatusRefusal = (message: string, status: OrderStatus) =>
  new AppError('conflict', `${message} This order's status is ${status}.`);

/**
 * Moves one of the company's orders on as members do on the order page (ADR-168), in one
 * transaction with the order's row locked: a received order is confirmed or cancelled, a confirmed
 * one fulfilled or cancelled, a paid one fulfilled, through the write members' changes use, so the
 * order's version moves on and the `order.status_changed` webhook event is captured. An order that
 * already has the status asked for is answered as it is, whatever `expectedStatus` says, so a retry
 * changes nothing; any other move, or an order not in `expectedStatus`, is refused with 409, naming
 * its status. Payment statuses come only from Razorpay, and an order waiting for payment is moved
 * by members, who cancel its Payment Link first.
 */
export async function apiUpdateOrder(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  orderId: string,
  input: unknown,
): Promise<ApiOrder> {
  assertScope(ctx, 'orders.write');
  if (!z.uuid().safeParse(orderId).success) throw notFound('Order');
  const data = parseInput(apiUpdateOrderSchema, input);
  const order = await deps.db.run(ctx.scope, async (tx) => {
    await assertCommerceInPlan(tx, ctx.tenant.id);
    const [current] = await tx
      .select({
        id: commerceOrders.id,
        reference: commerceOrders.reference,
        status: commerceOrders.status,
        version: commerceOrders.version,
      })
      .from(commerceOrders)
      .where(and(eq(commerceOrders.tenantId, ctx.tenant.id), eq(commerceOrders.id, orderId)))
      .for('update');
    if (!current) return null;
    if (current.status !== data.status) {
      if (data.expectedStatus && data.expectedStatus !== current.status) {
        throw orderStatusRefusal(
          `The order is not ${data.expectedStatus}, so it was not changed.`,
          current.status,
        );
      }
      if (!MEMBER_ORDER_TRANSITIONS[current.status].includes(data.status)) {
        throw orderStatusRefusal(
          current.status === 'awaiting_payment'
            ? 'An order waiting for payment is not changed through the API: members cancel its Payment Link in the app first.'
            : `The order cannot move to ${data.status} from its status.`,
          current.status,
        );
      }
      await writeLockedOrderStatus(tx, ctx.tenant.id, current, data.status, deps.clock.now(), {
        apiKeyId: ctx.key.id,
      });
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'commerce.order_status_changed',
          subjectType: 'commerce_order',
          subjectId: current.id,
          metadata: {
            reference: current.reference,
            from: current.status,
            to: data.status,
            source: 'api',
          },
          correlationId: ctx.requestId,
        },
        apiActor(ctx),
      );
    }
    return readApiOrder(tx, ctx.tenant.id, orderId);
  });
  if (!order) throw notFound('Order');
  return order;
}
