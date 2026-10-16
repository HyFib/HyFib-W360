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
  type Database,
  type Tx,
} from '@w360/db';
import type { Clock } from '@w360/core';
import { assertCan, type TenantContext } from '../authz/context';
import { likePattern, parseInput } from '../validation';
import { addActivity, crmChangedBy, uuidSchema } from './common';
import { lockDealForChange } from './deals';
import { currencyDigits, MAX_DEAL_MINOR, parseAmountToMinor } from './money';

/**
 * Products on deals (ADR-375): products from the company's WhatsApp catalogs listed on a deal, each
 * with a quantity and a unit price in the deal's currency when it was added, its name kept as it
 * was then. Members who change deals and may see the catalogs add and remove them; anyone who reads
 * the CRM sees them on the deal.
 */

/** The most products a deal lists. */
export const MAX_DEAL_ITEMS = 50;
/** The most of one product an item counts. */
export const MAX_ITEM_QUANTITY = 100_000;

export interface DealItem {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  currency: string;
  createdAt: Date;
}

/** An item's total: its quantity times its unit price, exact. */
export function lineTotalMinor(item: { quantity: number; unitPriceMinor: number }): bigint {
  return BigInt(item.quantity) * BigInt(item.unitPriceMinor);
}

/**
 * The deal's items in all, in its currency: null when an item is in another currency (the deal
 * moved to a pipeline of another currency since) or the sum is beyond what a deal's value holds.
 */
export function dealItemsTotal(
  items: readonly { quantity: number; unitPriceMinor: number; currency: string }[],
  currency: string,
): { totalMinor: number | null; otherCurrency: boolean } {
  if (items.some((item) => item.currency !== currency)) {
    return { totalMinor: null, otherCurrency: true };
  }
  const sum = items.reduce((total, item) => total + lineTotalMinor(item), 0n);
  return {
    totalMinor: sum <= BigInt(MAX_DEAL_MINOR) ? Number(sum) : null,
    otherCurrency: false,
  };
}

export const addDealItemSchema = z.object({
  dealId: uuidSchema,
  expectedVersion: z.number().int().min(1),
  productId: uuidSchema,
  quantity: z.coerce
    .number({ error: 'Enter a quantity.' })
    .int('Enter a whole quantity.')
    .min(1, 'Enter a quantity of at least 1.')
    .max(MAX_ITEM_QUANTITY, `Quantities are limited to ${MAX_ITEM_QUANTITY.toLocaleString('en')}.`),
  unitPrice: z.string().trim().min(1, 'Enter a unit price.').max(40, 'Enter a shorter price.'),
});

export const removeDealItemSchema = z.object({
  dealId: uuidSchema,
  expectedVersion: z.number().int().min(1),
  itemId: uuidSchema,
});

const itemColumns = {
  id: crmDealItems.id,
  productId: crmDealItems.productId,
  name: crmDealItems.name,
  quantity: crmDealItems.quantity,
  unitPriceMinor: crmDealItems.unitPriceMinor,
  currency: crmDealItems.currency,
  createdAt: crmDealItems.createdAt,
};

/** A deal's items in the order they were added. */
export function loadDealItems(tx: Tx, tenantId: string, dealId: string): Promise<DealItem[]> {
  return tx
    .select(itemColumns)
    .from(crmDealItems)
    .where(and(eq(crmDealItems.tenantId, tenantId), eq(crmDealItems.dealId, dealId)))
    .orderBy(asc(crmDealItems.createdAt), asc(crmDealItems.id));
}

/** A unit price in the currency as members type it, exact; refused with the currency's rule. */
export function parseUnitPrice(text: string, currency: string): number {
  const minor = parseAmountToMinor(text, currency);
  // Null as well beyond what a deal's value holds.
  if (minor === null) {
    const digits = currencyDigits(currency);
    const message =
      digits === 0
        ? `Enter the unit price in ${currency} as a whole number.`
        : `Enter the unit price in ${currency} with at most ${digits} decimals.`;
    throw new AppError('validation_failed', message, { issues: [{ path: 'unitPrice', message }] });
  }
  return minor;
}

export function dealItemOperations(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;

  /** Bumps the deal's version and records the change on its timeline. */
  async function recordChange(
    tx: Tx,
    ctx: TenantContext,
    deal: { id: string; contactId: string; version: number },
    data: Record<string, unknown>,
  ) {
    const version = deal.version + 1;
    await tx
      .update(crmDeals)
      .set({ version, ...crmChangedBy('member') })
      .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, deal.id)));
    await addActivity(tx, {
      tenantId: ctx.tenant.id,
      contactId: deal.contactId,
      dealId: deal.id,
      actorMembershipId: ctx.membership.id,
      kind: 'deal_updated',
      data: { fields: ['products'], ...data },
      at: clock.now(),
    });
    return { version };
  }

  return {
    /** Products of the company's connected catalogs to add to a deal, by name or retailer id. */
    async dealProductOptions(ctx: TenantContext, query: string) {
      assertCan(ctx, 'crm.write');
      assertCan(ctx, 'commerce.read');
      const q = query.trim().slice(0, 100);
      const pattern = q ? likePattern(q) : null;
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: commerceProducts.id,
              name: commerceProducts.name,
              retailerId: commerceProducts.retailerId,
              priceText: commerceProducts.priceText,
              catalogName: commerceCatalogs.name,
            })
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
                eq(commerceProducts.tenantId, ctx.tenant.id),
                isNull(commerceProducts.removedAt),
                isNull(commerceCatalogs.disconnectedAt),
                pattern
                  ? sql`(${commerceProducts.name} ilike ${pattern} or ${commerceProducts.retailerId} ilike ${pattern})`
                  : undefined,
              ),
            )
            .orderBy(asc(commerceProducts.name), asc(commerceProducts.id))
            .limit(20),
        { accessMode: 'read only' },
      );
    },

    /**
     * Adds a product to a deal at the deal's version: from a connected catalog, not removed, with
     * its name as it is now, a quantity and a unit price in the deal's currency. An erased
     * contact's deal takes none; a deal lists at most 50, and an item's total fits a deal's value.
     */
    async addDealItem(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'crm.write');
      assertCan(ctx, 'commerce.read');
      const data = parseInput(addDealItemSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const { deal, erased } = await lockDealForChange(
          tx,
          ctx.tenant.id,
          data.dealId,
          data.expectedVersion,
        );
        if (erased) throw new AppError('conflict', 'This contact was erased.');
        const [product] = await tx
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
              eq(commerceProducts.tenantId, ctx.tenant.id),
              eq(commerceProducts.id, data.productId),
              isNull(commerceProducts.removedAt),
              isNull(commerceCatalogs.disconnectedAt),
            ),
          );
        if (!product) throw notFound('Product');
        const [{ count } = { count: 0 }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(crmDealItems)
          .where(and(eq(crmDealItems.tenantId, ctx.tenant.id), eq(crmDealItems.dealId, deal.id)));
        if (count >= MAX_DEAL_ITEMS) {
          throw new AppError(
            'validation_failed',
            `A deal lists at most ${MAX_DEAL_ITEMS} products.`,
          );
        }
        const [pipeline] = await tx
          .select({ currency: crmPipelines.currency })
          .from(crmPipelines)
          .where(
            and(eq(crmPipelines.tenantId, ctx.tenant.id), eq(crmPipelines.id, deal.pipelineId)),
          );
        if (!pipeline) throw notFound('Pipeline');
        const unitPriceMinor = parseUnitPrice(data.unitPrice, pipeline.currency);
        if (lineTotalMinor({ quantity: data.quantity, unitPriceMinor }) > BigInt(MAX_DEAL_MINOR)) {
          const message = 'The quantity times the unit price is more than a deal can be worth.';
          throw new AppError('validation_failed', message, {
            issues: [{ path: 'quantity', message }],
          });
        }
        const id = uuidv7();
        await tx.insert(crmDealItems).values({
          id,
          tenantId: ctx.tenant.id,
          dealId: deal.id,
          productId: product.id,
          name: product.name.slice(0, 500),
          quantity: data.quantity,
          unitPriceMinor,
          currency: pipeline.currency,
          createdByMembershipId: ctx.membership.id,
        });
        const { version } = await recordChange(tx, ctx, deal, {
          productAdded: product.name.slice(0, 500),
        });
        return { id, version };
      });
    },

    /** Removes an item from a deal at the deal's version. */
    async removeDealItem(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'crm.write');
      const data = parseInput(removeDealItemSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const { deal, erased } = await lockDealForChange(
          tx,
          ctx.tenant.id,
          data.dealId,
          data.expectedVersion,
        );
        if (erased) throw new AppError('conflict', 'This contact was erased.');
        const [removed] = await tx
          .delete(crmDealItems)
          .where(
            and(
              eq(crmDealItems.tenantId, ctx.tenant.id),
              eq(crmDealItems.dealId, deal.id),
              eq(crmDealItems.id, data.itemId),
            ),
          )
          .returning({ name: crmDealItems.name });
        if (!removed) throw notFound('Product on this deal');
        return recordChange(tx, ctx, deal, { productRemoved: removed.name });
      });
    },
  };
}
