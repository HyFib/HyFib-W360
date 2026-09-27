import { uuidv7 } from '@w360/core';
import {
  and,
  commerceCatalogs,
  commerceOrderItems,
  commerceOrders,
  commerceProducts,
  eq,
  inArray,
  isNull,
  type Tx,
} from '@w360/db';
import { newOrderReference, type ParsedOrder } from './model';

/**
 * Records an order a customer sent from their WhatsApp cart (research M-170), in the ingest
 * transaction right after its message row. Items are matched to the products HyFib last read from
 * the same catalog, so the order keeps the product names it had when it arrived. Amounts are the
 * ones in the order (converted to minor units); nothing here asks the customer for money.
 */
export async function recordOrder(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    contactId: string;
    channelAccountId: string;
    whatsappAccountId: string;
    messageId: string;
    order: ParsedOrder;
    receivedAt: Date;
  },
): Promise<{ orderId: string; reference: string }> {
  const { order } = input;
  const [catalog] = await tx
    .select({ id: commerceCatalogs.id })
    .from(commerceCatalogs)
    .where(
      and(
        eq(commerceCatalogs.tenantId, input.tenantId),
        eq(commerceCatalogs.whatsappAccountId, input.whatsappAccountId),
        eq(commerceCatalogs.metaCatalogId, order.catalogId),
      ),
    );
  const products = catalog
    ? await tx
        .select({
          id: commerceProducts.id,
          retailerId: commerceProducts.retailerId,
          name: commerceProducts.name,
        })
        .from(commerceProducts)
        .where(
          and(
            eq(commerceProducts.tenantId, input.tenantId),
            eq(commerceProducts.catalogId, catalog.id),
            inArray(
              commerceProducts.retailerId,
              order.items.map((i) => i.retailerId),
            ),
            isNull(commerceProducts.removedAt),
          ),
        )
    : [];
  const byRetailer = new Map(products.map((p) => [p.retailerId, p]));
  const orderId = uuidv7();
  // References are 40 random bits; a clash inside one company is retried with a new one.
  for (let attempt = 0; ; attempt += 1) {
    const reference = newOrderReference();
    const inserted = await tx
      .insert(commerceOrders)
      .values({
        id: orderId,
        tenantId: input.tenantId,
        reference,
        conversationId: input.conversationId,
        contactId: input.contactId,
        messageId: input.messageId,
        channelAccountId: input.channelAccountId,
        metaCatalogId: order.catalogId,
        currency: order.currency,
        subtotalMinor: order.subtotalMinor,
        itemCount: order.items.length,
        droppedItems: order.dropped,
        customerNote: order.note,
        receivedAt: input.receivedAt,
      })
      .onConflictDoNothing({ target: [commerceOrders.tenantId, commerceOrders.reference] })
      .returning({ id: commerceOrders.id });
    if (inserted.length === 0) {
      if (attempt < 4) continue;
      throw new Error('Could not choose a unique order reference');
    }
    await tx.insert(commerceOrderItems).values(
      order.items.map((item, i) => {
        const product = byRetailer.get(item.retailerId);
        return {
          id: uuidv7(),
          tenantId: input.tenantId,
          orderId,
          position: i + 1,
          retailerId: item.retailerId,
          productId: product?.id ?? null,
          name: product?.name ?? null,
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor,
          currency: item.currency,
        };
      }),
    );
    // Live updates come from the message's own event (emitted by ingestion).
    return { orderId, reference };
  }
}
