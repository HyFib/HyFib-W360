import {
  and,
  desc,
  eq,
  lt,
  lte,
  rateCardPrefixes,
  rateCardPrices,
  rateCards,
  type RateCategory,
  type TemplateCategory,
  type Tx,
} from '@w360/db';

/**
 * Cost estimates from provider rate cards that platform administrators enter from Meta's
 * published rate cards (nothing is seeded or invented). Meta charges per delivered message by the
 * recipient's market and the message's pricing category (docs/research/meta-whatsapp.md M-065,
 * M-066); the market of a number is the rate card's longest matching calling-code prefix.
 *
 * Estimates use the list price (volume tier 0) and assume every message is charged, so they are
 * an upper bound: free windows (M-053, M-067, M-070) and volume tiers (M-074) are not applied.
 * Amounts are integers in millionths of the currency's major unit ("micros").
 */
export const MICROS_PER_UNIT = 1_000_000;

export interface RateTable {
  cardId: string;
  currency: string;
  effectiveFrom: Date;
  /** Longest prefixes first. */
  prefixes: { prefix: string; market: string }[];
  /** `${market}|${category}` → list price in micros. */
  prices: Map<string, number>;
}

export function rateCategoryFor(category: TemplateCategory): RateCategory {
  switch (category) {
    case 'MARKETING':
      return 'marketing';
    case 'UTILITY':
      return 'utility';
    case 'AUTHENTICATION':
      return 'authentication';
  }
}

/** The published card for `currency` in force at `at` (latest effective date not after it). */
export async function loadRateTable(tx: Tx, currency: string, at: Date): Promise<RateTable | null> {
  const [card] = await tx
    .select({
      id: rateCards.id,
      currency: rateCards.currency,
      effectiveFrom: rateCards.effectiveFrom,
    })
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
  return card ? rateTableFor(tx, card) : null;
}

/**
 * The published cards for `currency` in force at some point in [start, end), newest first: every
 * card taking effect inside the range plus the one in force at `start`.
 */
export async function loadRateTables(
  tx: Tx,
  currency: string,
  start: Date,
  end: Date,
): Promise<RateTable[]> {
  const cards = await tx
    .select({
      id: rateCards.id,
      currency: rateCards.currency,
      effectiveFrom: rateCards.effectiveFrom,
    })
    .from(rateCards)
    .where(
      and(
        eq(rateCards.status, 'published'),
        eq(rateCards.currency, currency),
        lt(rateCards.effectiveFrom, end),
      ),
    )
    .orderBy(desc(rateCards.effectiveFrom));
  const inRange: typeof cards = [];
  for (const card of cards) {
    inRange.push(card);
    if (card.effectiveFrom <= start) break;
  }
  const tables: RateTable[] = [];
  for (const card of inRange) tables.push(await rateTableFor(tx, card));
  return tables;
}

async function rateTableFor(
  tx: Tx,
  card: { id: string; currency: string; effectiveFrom: Date },
): Promise<RateTable> {
  const prefixes = await tx
    .select({ prefix: rateCardPrefixes.prefix, market: rateCardPrefixes.market })
    .from(rateCardPrefixes)
    .where(eq(rateCardPrefixes.rateCardId, card.id));
  const prices = await tx
    .select({
      market: rateCardPrices.market,
      category: rateCardPrices.category,
      priceMicros: rateCardPrices.priceMicros,
    })
    .from(rateCardPrices)
    .where(and(eq(rateCardPrices.rateCardId, card.id), eq(rateCardPrices.tierFrom, 0)));
  return {
    cardId: card.id,
    currency: card.currency,
    effectiveFrom: card.effectiveFrom,
    prefixes: prefixes.sort((a, b) => b.prefix.length - a.prefix.length),
    prices: new Map(prices.map((p) => [`${p.market}|${p.category}`, p.priceMicros])),
  };
}

/** Rate-card market of an E.164 number, or null when no prefix matches. */
export function marketFor(table: RateTable, phoneE164: string | null): string | null {
  if (!phoneE164?.startsWith('+')) return null;
  const digits = phoneE164.slice(1);
  return table.prefixes.find((p) => digits.startsWith(p.prefix))?.market ?? null;
}

export function priceFor(table: RateTable, market: string | null, category: RateCategory) {
  if (!market) return null;
  return table.prices.get(`${market}|${category}`) ?? null;
}

/** Decimal places of a currency's minor unit (ISO 4217 data in ICU; 2 when unknown). */
export function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Rounds micros to the currency's minor unit (half up), returning minor units. */
export function microsToMinor(micros: number, currency: string): number {
  const perMinor = MICROS_PER_UNIT / 10 ** minorDigits(currency);
  return Math.floor((micros + perMinor / 2) / perMinor);
}

/**
 * Parses a member-entered amount in major units ("2500", "2500.50") into micros, exactly (no
 * floating point). Returns null when the text is not a positive amount with at most six decimals.
 */
export function parseAmountToMicros(text: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  const micros = Number(m[1]) * MICROS_PER_UNIT + Number((m[2] ?? '').padEnd(6, '0') || '0');
  return micros > 0 ? micros : null;
}

/** Formats micros for display in `currency`, rounded to its minor unit. */
export function formatMicros(micros: number, currency: string, locale = 'en-IN'): string {
  const digits = minorDigits(currency);
  const minor = microsToMinor(micros, currency);
  const major = minor / 10 ** digits;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${major.toFixed(digits)} ${currency}`;
  }
}

/** Formats a unit price (which can be a fraction of a minor unit) with up to six decimals. */
export function formatUnitPrice(micros: number, currency: string): string {
  const whole = Math.floor(micros / MICROS_PER_UNIT);
  const fraction = String(micros % MICROS_PER_UNIT)
    .padStart(6, '0')
    .replace(/0+$/, '');
  const decimals = fraction.padEnd(minorDigits(currency), '0');
  return decimals ? `${whole}.${decimals} ${currency}` : `${whole} ${currency}`;
}
