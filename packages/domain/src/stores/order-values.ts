import {
  and,
  asc,
  commerceStoreOrderItems,
  commerceStoreOrders,
  commerceStores,
  eq,
  type Tx,
} from '@w360/db';
import type { OrderPlaceholderValues } from '../automations/graph';
import { orderValues } from './messages-model';

/**
 * The values {{order.<field>}} stands for in a run started by order messages (ADR-050), read from
 * the store copy when a step runs. A deleted or redacted order has none (null).
 */
export async function orderPlaceholderValues(
  tx: Tx,
  tenantId: string,
  orderId: string,
): Promise<OrderPlaceholderValues | null> {
  const [row] = await tx
    .select({ order: commerceStoreOrders, store: commerceStores })
    .from(commerceStoreOrders)
    .innerJoin(
      commerceStores,
      and(
        eq(commerceStores.tenantId, commerceStoreOrders.tenantId),
        eq(commerceStores.id, commerceStoreOrders.storeId),
      ),
    )
    .where(and(eq(commerceStoreOrders.tenantId, tenantId), eq(commerceStoreOrders.id, orderId)));
  if (!row || row.order.deletedAt || row.order.redactedAt) return null;
  const { order, store } = row;
  const items = await tx
    .select({ title: commerceStoreOrderItems.title, quantity: commerceStoreOrderItems.quantity })
    .from(commerceStoreOrderItems)
    .where(
      and(
        eq(commerceStoreOrderItems.tenantId, tenantId),
        eq(commerceStoreOrderItems.orderId, order.id),
      ),
    )
    .orderBy(asc(commerceStoreOrderItems.position));
  const values = orderValues({
    name: order.name,
    customerName: order.customerName,
    currency: order.currency,
    totalMinor: order.totalMinor,
    items,
    statusUrl: order.statusUrl,
    trackingNumber: order.trackingNumber,
    trackingCompany: order.trackingCompany,
    trackingUrl: order.trackingUrl,
    storeName: store.name ?? store.shopDomain ?? new URL(store.storeUrl).hostname,
  });
  return {
    number: values.order_name,
    customer_name: values.customer_name,
    total: values.order_total,
    items: values.items_summary,
    status_url: values.status_url,
    tracking_number: values.tracking_number,
    carrier: values.tracking_company,
    tracking_url: values.tracking_url,
    store: values.store_name,
  };
}
