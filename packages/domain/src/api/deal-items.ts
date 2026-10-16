import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  asc,
  commerceCatalogs,
  commerceProducts,
  crmDealItems,
  crmDeals,
  crmPipelines,
  eq,
  isNull,
  sql,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { addActivity, crmChangedBy } from '../crm/common';
import { lineTotalMinor, MAX_DEAL_ITEMS, MAX_ITEM_QUANTITY } from '../crm/deal-items';
import { MAX_DEAL_MINOR } from '../crm/money';
import type { OutboundDeps } from '../messaging/outbound';
import { parseInput } from '../validation';
import { apiActor, assertScope, type ApiContext } from './context';
import { assertCrmInPlan, invalidField, lockApiDeal } from './deals';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';
import { assertCommerceInPlan } from './orders';

/**
 * Products on deals through the public API (ADR-378), as members list them on the deal page
 * (ADR-375). A key reads them with `deals.read`; adds them with `deals.write` and `orders.read`, as
 * members need `crm.write` and `commerce.read`, from the company's connected catalogs, named by
 * content id as product messages name products (ADR-086), with a quantity and a unit price in the
 * minor units of the deal's currency; and removes them with `deals.write`. Each addition or removal
 * moves the deal's version on, is on its timeline naming the key, and is audited as the key. Like
 * members' changes of products, it sends no deal event (deal events report the deal's own details).
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

/** What `POST /deals/{id}/items` takes. */
export const apiAddDealItemSchema = z
  .object({
    retailerId: z
      .string({ error: 'Give the product’s content id.' })
      .min(1, 'Give the product’s content id.')
      .max(100, 'Content ids are limited to 100 characters.')
      .describe(
        'The product’s content id (its SKU), exactly as Commerce Manager shows it, in one of the company’s connected catalogs (Commerce → Catalogs), not removed at Meta.',
      ),
    catalogId: z
      .string()
      .regex(/^[0-9]{1,32}$/, 'Give the Meta catalog id (digits only).')
      .optional()
      .describe(
        'The Meta catalog the product is in; needed only when more than one of the company’s connected catalogs has the content id.',
      ),
    quantity: z
      .number({ error: 'Give a quantity from 1 to 100,000.' })
      .int('Give a quantity from 1 to 100,000.')
      .min(1, 'Give a quantity from 1 to 100,000.')
      .max(MAX_ITEM_QUANTITY, 'Give a quantity from 1 to 100,000.'),
    unitPriceMinor: z
      .number({ error: 'Give the price of one in the currency’s minor units.' })
      .int('Give the price of one in the currency’s minor units.')
      .min(0, 'Give the price of one in the currency’s minor units.')
      .max(MAX_DEAL_MINOR, 'Give the price of one in the currency’s minor units.')
      .describe(
        'The price of one, in the minor units of the deal’s pipeline currency (paise for INR), as members type it: the catalog’s price is never assumed.',
      ),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Add it only at this deal `version`: a deal changed since is refused with 409 (read it again).',
      ),
  })
  .strict();

/** What `DELETE /deals/{id}/items/{itemId}` takes in its query. */
export const apiRemoveDealItemQuerySchema = z
  .object({
    expectedVersion: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Remove it only at this deal `version`: a deal changed since is refused with 409 (read it again).',
      ),
  })
  .strict();

/**
 * A deal's items in the order they were added, with each product's content id and catalog, or the
 * one `itemId` names.
 */
async function readApiDealItems(
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
    // At most 100,000 times a deal's largest value: exact as a number (ADR-375 caps it there).
    totalMinor: Number(lineTotalMinor(row)),
    createdBy: row.createdByApiKeyId ? 'api' : 'member',
    createdByApiKeyId: row.createdByApiKeyId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The deal's products, in the order they were added (at most 50). Only reads. */
export async function apiListDealItems(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  dealId: string,
): Promise<ApiDealItem[]> {
  assertScope(ctx, 'deals.read');
  if (!z.uuid().safeParse(dealId).success) throw notFound('Deal');
  const items = await deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      const [deal] = await tx
        .select({ id: crmDeals.id })
        .from(crmDeals)
        .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, dealId)));
      return deal ? readApiDealItems(tx, ctx.tenant.id, deal.id) : null;
    },
    { accessMode: 'read only' },
  );
  if (!items) throw notFound('Deal');
  return items;
}

/**
 * The product a key names, by content id, in one of the company's catalogs, neither disconnected
 * nor removed at Meta; `catalogId` picks the catalog when two of them have the content id.
 */
async function catalogProduct(
  tx: Tx,
  tenantId: string,
  retailerId: string,
  catalogId: string | undefined,
) {
  const rows = await tx
    .select({ id: commerceProducts.id, name: commerceProducts.name })
    .from(commerceProducts)
    .innerJoin(
      commerceCatalogs,
      and(
        eq(commerceCatalogs.tenantId, commerceProducts.tenantId),
        eq(commerceCatalogs.id, commerceProducts.catalogId),
      ),
    )
    .where(
      and(
        eq(commerceProducts.tenantId, tenantId),
        eq(commerceProducts.retailerId, retailerId),
        isNull(commerceCatalogs.disconnectedAt),
        isNull(commerceProducts.removedAt),
        catalogId ? eq(commerceCatalogs.metaCatalogId, catalogId) : undefined,
      ),
    )
    .limit(2);
  const [product, other] = rows;
  if (!product) {
    throw invalidField(
      'retailerId',
      `No connected catalog of the company has this content id${catalogId ? ' in that catalog' : ''}.`,
    );
  }
  if (other) {
    throw invalidField(
      'catalogId',
      'More than one connected catalog of the company has this content id: name one with catalogId.',
    );
  }
  return product;
}

/** Moves the deal's version on for a change of its products by the key, on its timeline. */
async function recordProductChange(
  tx: Tx,
  ctx: ApiContext,
  deal: { id: string; contactId: string; version: number },
  data: Record<string, unknown>,
  now: Date,
): Promise<number> {
  const version = deal.version + 1;
  await tx
    .update(crmDeals)
    .set({ version, ...crmChangedBy({ apiKeyId: ctx.key.id }) })
    .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, deal.id)));
  await addActivity(tx, {
    tenantId: ctx.tenant.id,
    contactId: deal.contactId,
    dealId: deal.id,
    actorMembershipId: null,
    kind: 'deal_updated',
    data: { fields: ['products'], ...data, apiKeyId: ctx.key.id },
    at: now,
  });
  await recordSystemAudit(
    tx,
    ctx.tenant.id,
    {
      action: 'crm.deal_updated',
      subjectType: 'crm_deal',
      subjectId: deal.id,
      correlationId: ctx.requestId,
      metadata: { changes: ['products'], source: 'api' },
    },
    apiActor(ctx),
  );
  return version;
}

const erasedConflict = () =>
  new AppError('conflict', 'The contact was erased, so this deal’s products can no longer change.');

/**
 * Adds a product to one of the company's deals, as members do on the deal page (ADR-375): from a
 * connected catalog, with its name as it is now, a quantity and a unit price in the minor units of
 * the deal's pipeline currency. Not on an erased contact's deal; a deal lists at most 50, and an
 * item's total fits a deal's value. With an Idempotency-Key a retry answers the first response.
 */
export async function apiAddDealItem(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  dealId: string,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'deals.write');
  assertScope(ctx, 'orders.read');
  if (!z.uuid().safeParse(dealId).success) throw notFound('Deal');
  const data = parseInput(apiAddDealItemSchema, input);
  const line = { quantity: data.quantity, unitPriceMinor: data.unitPriceMinor };
  if (lineTotalMinor(line) > BigInt(MAX_DEAL_MINOR)) {
    throw invalidField(
      'quantity',
      'The quantity times the unit price is more than a deal can be worth.',
    );
  }
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    // Claimed in the item's transaction, so a refused item leaves the key unused (ADR-052).
    let claimed: string | null = null;
    if (idempotency) {
      const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
      if ('replay' in claim) return claim.replay;
      claimed = claim.claimed;
    }
    await assertCrmInPlan(tx, ctx.tenant.id);
    await assertCommerceInPlan(tx, ctx.tenant.id);
    const locked = await lockApiDeal(tx, ctx.tenant.id, dealId, data.expectedVersion);
    if (!locked) throw notFound('Deal');
    const { deal, erased } = locked;
    if (erased) throw erasedConflict();
    const product = await catalogProduct(tx, ctx.tenant.id, data.retailerId, data.catalogId);
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(crmDealItems)
      .where(and(eq(crmDealItems.tenantId, ctx.tenant.id), eq(crmDealItems.dealId, deal.id)));
    if (count >= MAX_DEAL_ITEMS) {
      throw new AppError('validation_failed', `A deal lists at most ${MAX_DEAL_ITEMS} products.`);
    }
    const [pipeline] = await tx
      .select({ currency: crmPipelines.currency })
      .from(crmPipelines)
      .where(and(eq(crmPipelines.tenantId, ctx.tenant.id), eq(crmPipelines.id, deal.pipelineId)));
    if (!pipeline) throw notFound('Pipeline');
    const id = uuidv7();
    const name = product.name.slice(0, 500);
    await tx.insert(crmDealItems).values({
      id,
      tenantId: ctx.tenant.id,
      dealId: deal.id,
      productId: product.id,
      name,
      ...line,
      currency: pipeline.currency,
      createdByApiKeyId: ctx.key.id,
    });
    const dealVersion = await recordProductChange(tx, ctx, deal, { productAdded: name }, now);
    const [item] = await readApiDealItems(tx, ctx.tenant.id, deal.id, id);
    if (!item) throw notFound('Product on this deal');
    const response = { status: 201, body: { data: { ...item, dealVersion } } };
    if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
    return { ...response, replayed: false };
  });
}

/**
 * Removes a product from one of the company's deals, as members do on the deal page; not from an
 * erased contact's deal. A product already removed answers 404.
 */
export async function apiRemoveDealItem(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  dealId: string,
  itemId: string,
  query: unknown,
): Promise<{ id: string; deleted: true; dealVersion: number }> {
  assertScope(ctx, 'deals.write');
  if (!z.uuid().safeParse(dealId).success) throw notFound('Deal');
  if (!z.uuid().safeParse(itemId).success) throw notFound('Product on this deal');
  const q = parseInput(apiRemoveDealItemQuerySchema, query);
  const now = deps.clock.now();
  const removed = await deps.db.run(ctx.scope, async (tx) => {
    await assertCrmInPlan(tx, ctx.tenant.id);
    const locked = await lockApiDeal(tx, ctx.tenant.id, dealId, q.expectedVersion);
    if (!locked) return null;
    const { deal, erased } = locked;
    if (erased) throw erasedConflict();
    const [item] = await tx
      .delete(crmDealItems)
      .where(
        and(
          eq(crmDealItems.tenantId, ctx.tenant.id),
          eq(crmDealItems.dealId, deal.id),
          eq(crmDealItems.id, itemId),
        ),
      )
      .returning({ name: crmDealItems.name });
    if (!item) throw notFound('Product on this deal');
    const dealVersion = await recordProductChange(
      tx,
      ctx,
      deal,
      { productRemoved: item.name },
      now,
    );
    return { id: itemId, deleted: true as const, dealVersion };
  });
  if (!removed) throw notFound('Deal');
  return removed;
}
