import { z } from 'zod';
import { and, asc, commerceCatalogs, commerceProducts, crmDealItems, eq, type Tx } from '@w360/db';
import { lineTotalMinor, MAX_DEAL_ITEMS, MAX_ITEM_QUANTITY } from '../crm/deal-item-limits';

/**
 * A product on a deal in the API's words (ADR-378), shared by `GET /deals/{id}/items` and the deal
 * webhook payloads' `deal.items` (ADR-395), so both describe and read items the same way. It
 * imports none of the deal services, so the webhook payloads can use it.
 */

/** One product on a deal, as `GET /deals/{id}/items` gives it. */
export interface ApiDealItem {
  id: string;
  /** The product's content id (its SKU) in its catalog, as product messages name it. */
  retailerId: string;
  /** The catalog it is in, by Meta's id. */
  catalogId: string;
  /** The product's name when it was added: a later rename or removal in the catalog keeps it. */
  name: string;
  quantity: number;
  /** The price of one, in the minor units of `currency`. */
  unitPriceMinor: number;
  /** The deal's pipeline currency when it was added. */
  currency: string;
  /** Quantity times unit price, exact, in the minor units of `currency`. */
  totalMinor: number;
  /** Who added it: a member (never which) or a key (`createdByApiKeyId`). */
  createdBy: 'member' | 'api';
  createdByApiKeyId: string | null;
  createdAt: string;
}

/** One product on a CRM deal, as GET /deals/{id}/items gives it (ADR-378). */
export const apiDealItemSchema = z.object({
  id: z
    .uuid()
    .describe('The product’s line on the deal, which DELETE /deals/{id}/items/{itemId} takes.'),
  retailerId: z
    .string()
    .describe('The product’s content id (its SKU) in its catalog, as product messages name it.'),
  catalogId: z.string().describe('The Meta catalog the product is in.'),
  name: z
    .string()
    .describe(
      'The product’s name when it was added: a later rename or removal in the catalog keeps it.',
    ),
  quantity: z.number().int().min(1).max(MAX_ITEM_QUANTITY),
  unitPriceMinor: z
    .number()
    .int()
    .min(0)
    .describe('The price of one, in the minor units of `currency` (paise for INR).'),
  currency: z
    .string()
    .describe(
      'The deal’s pipeline currency when the product was added: one added before the deal moved to a pipeline of another currency keeps its own.',
    ),
  totalMinor: z
    .number()
    .int()
    .min(0)
    .describe('`quantity` times `unitPriceMinor`, exact, in the minor units of `currency`.'),
  createdBy: z
    .enum(['member', 'api'])
    .describe('Who added it: a member (member, never which member) or an API key (api).'),
  createdByApiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that added it, when createdBy is api; null otherwise.'),
  createdAt: z.iso.datetime().describe('When it was added.'),
});

/** A deal's products as a list of at most `MAX_DEAL_ITEMS` (ADR-375), in the order they were added. */
export const apiDealItemsSchema = z.array(apiDealItemSchema).max(MAX_DEAL_ITEMS);

/**
 * A deal's items in the order they were added, with each product's content id and catalog, or the
 * one `itemId` names.
 */
export async function readApiDealItems(
  tx: Tx,
  tenantId: string,
  dealId: string,
  itemId?: string,
): Promise<ApiDealItem[]> {
  const rows = await tx
    .select({
      id: crmDealItems.id,
      retailerId: commerceProducts.retailerId,
      catalogId: commerceCatalogs.metaCatalogId,
      name: crmDealItems.name,
      quantity: crmDealItems.quantity,
      unitPriceMinor: crmDealItems.unitPriceMinor,
      currency: crmDealItems.currency,
      createdByApiKeyId: crmDealItems.createdByApiKeyId,
      createdAt: crmDealItems.createdAt,
    })
    .from(crmDealItems)
    .innerJoin(
      commerceProducts,
      and(
        eq(commerceProducts.tenantId, crmDealItems.tenantId),
        eq(commerceProducts.id, crmDealItems.productId),
      ),
    )
    .innerJoin(
      commerceCatalogs,
      and(
        eq(commerceCatalogs.tenantId, commerceProducts.tenantId),
        eq(commerceCatalogs.id, commerceProducts.catalogId),
      ),
    )
    .where(
      and(
        eq(crmDealItems.tenantId, tenantId),
        eq(crmDealItems.dealId, dealId),
        itemId ? eq(crmDealItems.id, itemId) : undefined,
      ),
    )
    .orderBy(asc(crmDealItems.createdAt), asc(crmDealItems.id));
  return rows.map(toApiDealItem);
}

/** An item row as the API gives it. */
export function toApiDealItem(row: {
  id: string;
  retailerId: string;
  catalogId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  currency: string;
  createdByApiKeyId: string | null;
  createdAt: Date;
}): ApiDealItem {
  return {
    id: row.id,
    retailerId: row.retailerId,
    catalogId: row.catalogId,
    name: row.name,
    quantity: row.quantity,
    unitPriceMinor: row.unitPriceMinor,
    currency: row.currency,
    // At most a deal's largest value (MAX_DEAL_MINOR, 10^15), which both paths that add an item
    // check (ADR-375, ADR-378): below Number.MAX_SAFE_INTEGER, so exact as a number.
    totalMinor: Number(lineTotalMinor(row)),
    createdBy: row.createdByApiKeyId ? 'api' : 'member',
    createdByApiKeyId: row.createdByApiKeyId,
    createdAt: row.createdAt.toISOString(),
  };
}
