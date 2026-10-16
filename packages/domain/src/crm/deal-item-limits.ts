/**
 * The bounds of products on deals (ADR-375) and an item's total, in a module of their own that
 * imports nothing, so that what describes items (the API's reads, the deal webhook payloads,
 * ADR-395) needs none of the deal services.
 */

/** The most products a deal lists. */
export const MAX_DEAL_ITEMS = 50;
/** The most of one product an item counts. */
export const MAX_ITEM_QUANTITY = 100_000;

/** An item's total: its quantity times its unit price, exact. */
export function lineTotalMinor(item: { quantity: number; unitPriceMinor: number }): bigint {
  return BigInt(item.quantity) * BigInt(item.unitPriceMinor);
}
