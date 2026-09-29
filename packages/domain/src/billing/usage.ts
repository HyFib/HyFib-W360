import type { Clock } from '@w360/core';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  lte,
  messagingSettings,
  RATE_CATEGORIES,
  rateCardPrices,
  rateCards,
  type Database,
  type RateCategory,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { formatUnitPrice } from '../campaigns/costs';
import { resolvePeriod, type ReportPeriod } from '../reports/period';
import { estimateMetaCharges, type CostReport } from '../reports/service';

/**
 * Billing → Usage and rates (ADR-060): the Meta rate card in force for the company's billing
 * currency, the next published card with what it changes, and this month's estimated Meta charges.
 * Read-only: Meta bills the company directly (ADR-011), so nothing here is stored or posted to the
 * ledger, and every amount is an estimate at list prices (ADR-028).
 */

/** A published rate card as a company sees it: list prices (volume tier 0) by market and category. */
export interface RateCardView {
  id: string;
  currency: string;
  effectiveFrom: Date;
  /** Where platform staff copied the card from (Meta's published rate card page). */
  sourceUrl: string;
  notes: string | null;
  /** Markets with at least one price, alphabetically. */
  markets: string[];
  /** `${market}|${category}` → list price in micros. */
  prices: Map<string, number>;
}

/** A price the next card changes, adds or no longer lists (null: not priced on that card). */
export interface RateChange {
  market: string;
  category: RateCategory;
  currentMicros: number | null;
  nextMicros: number | null;
}

export interface CategoryCharge {
  category: RateCategory;
  count: number;
  micros: number;
}

export interface UsageAndRates {
  /** The billing currency chosen in Settings → Messaging; null when none is chosen. */
  currency: string | null;
  generatedAt: Date;
  /** The published card in force now for the currency. */
  current: RateCardView | null;
  /** The published card taking effect next (the earliest effective time after now). */
  next: RateCardView | null;
  /** What the next card changes compared with the current one; empty without both cards. */
  changes: RateChange[];
  /** This month so far, in the company's time zone. */
  period: ReportPeriod;
  charges: CostReport;
  byCategory: CategoryCharge[];
}

export const RATE_CATEGORY_LABELS: Record<RateCategory, string> = {
  marketing: 'Marketing',
  utility: 'Utility',
  authentication: 'Authentication',
  authentication_international: 'Authentication (international)',
  service: 'Service',
};

export const priceKey = (market: string, category: RateCategory) => `${market}|${category}`;

/** Prices that differ between two cards, market by market in the order of the categories. */
export function compareRateCards(current: RateCardView, next: RateCardView): RateChange[] {
  const markets = [...new Set([...current.markets, ...next.markets])].sort((a, b) =>
    a.localeCompare(b),
  );
  const changes: RateChange[] = [];
  for (const market of markets) {
    for (const category of RATE_CATEGORIES) {
      const currentMicros = current.prices.get(priceKey(market, category)) ?? null;
      const nextMicros = next.prices.get(priceKey(market, category)) ?? null;
      if (currentMicros !== nextMicros)
        changes.push({ market, category, currentMicros, nextMicros });
    }
  }
  return changes;
}

/**
 * How a price changes, as the changes table shows it: a new price, a price no longer listed, or the
 * difference with its percentage (none from a price of zero). Uses a real minus sign.
 */
export function formatRateChange(change: RateChange, currency: string): string {
  const { currentMicros: from, nextMicros: to } = change;
  if (from === null) return 'New price';
  if (to === null) return 'No longer priced';
  const sign = to > from ? '+' : '−';
  const amount = `${sign}${formatUnitPrice(Math.abs(to - from), currency)}`;
  if (from === 0) return amount;
  return `${amount} (${sign}${((Math.abs(to - from) / from) * 100).toFixed(1)}%)`;
}

/** The priced estimate added up by pricing category, most expensive first. */
export function chargesByCategory(charges: CostReport): CategoryCharge[] {
  const totals = new Map<RateCategory, CategoryCharge>();
  for (const line of charges.lines) {
    const total = totals.get(line.category) ?? { category: line.category, count: 0, micros: 0 };
    total.count += line.count;
    total.micros += line.micros;
    totals.set(line.category, total);
  }
  return [...totals.values()].sort(
    (a, b) =>
      b.micros - a.micros ||
      RATE_CATEGORIES.indexOf(a.category) - RATE_CATEGORIES.indexOf(b.category),
  );
}

type CardRow = {
  id: string;
  currency: string;
  effectiveFrom: Date;
  sourceUrl: string;
  notes: string | null;
};

/** A published card with its list prices (volume tier 0). */
export async function rateCardWithPrices(tx: Tx, card: CardRow): Promise<RateCardView> {
  const rows = await tx
    .select({
      market: rateCardPrices.market,
      category: rateCardPrices.category,
      priceMicros: rateCardPrices.priceMicros,
    })
    .from(rateCardPrices)
    .where(and(eq(rateCardPrices.rateCardId, card.id), eq(rateCardPrices.tierFrom, 0)));
  return {
    ...card,
    markets: [...new Set(rows.map((r) => r.market))].sort((a, b) => a.localeCompare(b)),
    prices: new Map(rows.map((r) => [priceKey(r.market, r.category), r.priceMicros])),
  };
}

const cardColumns = {
  id: rateCards.id,
  currency: rateCards.currency,
  effectiveFrom: rateCards.effectiveFrom,
  sourceUrl: rateCards.sourceUrl,
  notes: rateCards.notes,
};

/** The published card for `currency` in force at `at` (the latest effective time not after it). */
export async function rateCardInForce(
  tx: Tx,
  currency: string,
  at: Date,
): Promise<RateCardView | null> {
  const [card] = await tx
    .select(cardColumns)
    .from(rateCards)
    .where(
      and(
        eq(rateCards.status, 'published'),
        eq(rateCards.currency, currency),
        lte(rateCards.effectiveFrom, at),
      ),
    )
    .orderBy(desc(rateCards.effectiveFrom))
    .limit(1);
  return card ? rateCardWithPrices(tx, card) : null;
}

/** The published card for `currency` taking effect next after `at`. */
async function nextCard(tx: Tx, currency: string, at: Date): Promise<RateCardView | null> {
  const [card] = await tx
    .select(cardColumns)
    .from(rateCards)
    .where(
      and(
        eq(rateCards.status, 'published'),
        eq(rateCards.currency, currency),
        gt(rateCards.effectiveFrom, at),
      ),
    )
    .orderBy(asc(rateCards.effectiveFrom))
    .limit(1);
  return card ? rateCardWithPrices(tx, card) : null;
}

export interface BillingUsageDeps {
  db: Database;
  clock: Clock;
}

export function createBillingUsageService(deps: BillingUsageDeps) {
  const { db, clock } = deps;
  return {
    /** Billing → Usage and rates, for members who can read billing (ADR-060). */
    async usageAndRates(ctx: TenantContext): Promise<UsageAndRates> {
      assertCan(ctx, 'billing.read');
      const now = clock.now();
      const period = resolvePeriod({ preset: 'this_month' }, ctx.tenant.timezone, now);
      return db.run(
        ctx.scope,
        async (tx) => {
          const [settings] = await tx
            .select({ costCurrency: messagingSettings.costCurrency })
            .from(messagingSettings)
            .where(eq(messagingSettings.tenantId, ctx.tenant.id));
          const currency = settings?.costCurrency ?? null;
          const current = currency ? await rateCardInForce(tx, currency, now) : null;
          const next = currency ? await nextCard(tx, currency, now) : null;
          const charges = await estimateMetaCharges(tx, ctx.tenant.id, period, currency);
          return {
            currency,
            generatedAt: now,
            current,
            next,
            changes: current && next ? compareRateCards(current, next) : [],
            period,
            charges,
            byCategory: chargesByCategory(charges),
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
  };
}

export type BillingUsageService = ReturnType<typeof createBillingUsageService>;
