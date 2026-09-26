import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  RATE_CATEGORIES,
  asc,
  desc,
  eq,
  platformAuditEvents,
  rateCardPrefixes,
  rateCardPrices,
  rateCards,
  sql,
  type RateCategory,
} from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { CsvError, parseCsv } from '../contacts/csv';
import { MICROS_PER_UNIT } from '../campaigns/costs';
import type { PlatformActor } from './service';

/**
 * Provider rate cards (platform administration). Staff copy Meta's published rate card for one
 * currency into a CSV, one market per row:
 *
 *   market,calling_codes,marketing,utility,authentication,authentication_international,service
 *
 * `calling_codes` lists the market's country calling codes separated by spaces or semicolons
 * (the longest matching code wins when a number is priced); prices are per message in the card's
 * currency, with up to six decimals; an empty cell means no price for that category. Cards are
 * drafts until published and immutable afterwards (database triggers); corrections are a
 * withdrawal plus a new card. HyFib never ships prices of its own.
 */
export const RATE_CARD_LIMITS = { markets: 400, csvBytes: 200_000 } as const;

const createSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, like INR'),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Enter the date and time the rates apply from'),
  sourceUrl: z
    .string()
    .trim()
    .max(500)
    .regex(/^https:\/\/\S+$/, "Link to Meta's published rate card (https)"),
  notes: z.string().trim().max(1000).optional(),
  csv: z.string().min(1, 'Paste the rate card').max(RATE_CARD_LIMITS.csvBytes),
});

const reasonSchema = z.object({
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(2000),
});

export interface ParsedRateCard {
  markets: { market: string; prefixes: string[]; prices: Partial<Record<RateCategory, number>> }[];
}

/** Parses a price in major units (0 allowed) into micros, exactly. */
function priceMicros(text: string): number | null {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * MICROS_PER_UNIT + Number((m[2] ?? '').padEnd(6, '0') || '0');
}

export function parseRateCardCsv(text: string): ParsedRateCard {
  let header: string[];
  let body: string[][];
  try {
    const parsed = parseCsv(text, {
      maxBytes: RATE_CARD_LIMITS.csvBytes,
      maxRows: RATE_CARD_LIMITS.markets,
      maxColumns: 10,
      maxFieldLength: 400,
    });
    header = parsed.headers;
    body = parsed.rows;
  } catch (error) {
    if (error instanceof CsvError) throw new AppError('validation_failed', error.message);
    throw error;
  }
  const columns = header.map((h) => h.trim().toLowerCase());
  const at = (name: string) => columns.indexOf(name);
  if (at('market') < 0 || at('calling_codes') < 0)
    throw new AppError(
      'validation_failed',
      'The first row must name the columns, starting with market,calling_codes.',
    );
  const categories = RATE_CATEGORIES.filter((c) => at(c) >= 0);
  if (categories.length === 0)
    throw new AppError(
      'validation_failed',
      'Add at least one price column (marketing, utility, …).',
    );
  const seenMarkets = new Set<string>();
  const seenPrefixes = new Map<string, string>();
  const markets: ParsedRateCard['markets'] = [];
  for (const [i, row] of body.entries()) {
    const line = i + 2;
    if (row.every((cell) => !cell.trim())) continue;
    const market = (row[at('market')] ?? '').trim();
    if (!market || market.length > 80)
      throw new AppError(
        'validation_failed',
        `Row ${line}: enter the market name (up to 80 characters).`,
      );
    const key = market.toLowerCase();
    if (seenMarkets.has(key))
      throw new AppError('validation_failed', `Row ${line}: ${market} appears twice.`);
    seenMarkets.add(key);
    const prefixes = (row[at('calling_codes')] ?? '').split(/[\s;]+/).filter(Boolean);
    if (prefixes.length === 0)
      throw new AppError('validation_failed', `Row ${line}: list the calling codes of ${market}.`);
    for (const prefix of prefixes) {
      if (!/^[1-9][0-9]{0,5}$/.test(prefix))
        throw new AppError('validation_failed', `Row ${line}: “${prefix}” is not a calling code.`);
      const owner = seenPrefixes.get(prefix);
      if (owner)
        throw new AppError(
          'validation_failed',
          `Row ${line}: calling code ${prefix} is already used by ${owner}.`,
        );
      seenPrefixes.set(prefix, market);
    }
    const prices: Partial<Record<RateCategory, number>> = {};
    for (const category of categories) {
      const cell = (row[at(category)] ?? '').trim();
      if (!cell) continue;
      const micros = priceMicros(cell);
      if (micros === null)
        throw new AppError(
          'validation_failed',
          `Row ${line}: the ${category} price “${cell}” is not a number.`,
        );
      prices[category] = micros;
    }
    if (Object.keys(prices).length === 0)
      throw new AppError('validation_failed', `Row ${line}: ${market} has no price.`);
    markets.push({ market, prefixes, prices });
  }
  if (markets.length === 0)
    throw new AppError('validation_failed', 'The rate card has no markets.');
  return { markets };
}

export function createRateCardsService(deps: { platformDb: PlatformDatabase; clock: Clock }) {
  const { platformDb } = deps;

  const audit = (
    actor: PlatformActor,
    action: string,
    metadata: Record<string, unknown>,
    reason: string | null = null,
  ) => ({
    id: uuidv7(),
    actorUserId: actor.userId,
    action,
    reason,
    result: 'success' as const,
    correlationId: actor.correlationId,
    metadata,
  });

  return {
    async listRateCards(actor: PlatformActor) {
      return platformDb.run(actor.userId, (tx) =>
        tx
          .select({
            id: rateCards.id,
            currency: rateCards.currency,
            effectiveFrom: rateCards.effectiveFrom,
            status: rateCards.status,
            sourceUrl: rateCards.sourceUrl,
            createdAt: rateCards.createdAt,
            markets: sql<number>`(select count(distinct p.market)::int from ops.rate_card_prices p where p.rate_card_id = ${rateCards.id})`,
          })
          .from(rateCards)
          .orderBy(
            asc(rateCards.currency),
            desc(rateCards.effectiveFrom),
            desc(rateCards.createdAt),
          ),
      );
    },

    async getRateCard(actor: PlatformActor, id: string) {
      if (!z.uuid().safeParse(id).success) throw notFound('Rate card');
      return platformDb.run(actor.userId, async (tx) => {
        const [card] = await tx.select().from(rateCards).where(eq(rateCards.id, id));
        if (!card) throw notFound('Rate card');
        const prefixes = await tx
          .select({ prefix: rateCardPrefixes.prefix, market: rateCardPrefixes.market })
          .from(rateCardPrefixes)
          .where(eq(rateCardPrefixes.rateCardId, id))
          .orderBy(asc(rateCardPrefixes.market), asc(rateCardPrefixes.prefix));
        const prices = await tx
          .select({
            market: rateCardPrices.market,
            category: rateCardPrices.category,
            tierFrom: rateCardPrices.tierFrom,
            priceMicros: rateCardPrices.priceMicros,
          })
          .from(rateCardPrices)
          .where(eq(rateCardPrices.rateCardId, id))
          .orderBy(asc(rateCardPrices.market), asc(rateCardPrices.category));
        return { card, prefixes, prices };
      });
    },

    async createRateCard(actor: PlatformActor, input: unknown) {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success)
        throw new AppError(
          'validation_failed',
          parsed.error.issues[0]?.message ?? 'Invalid rate card',
        );
      const data = parsed.data;
      const effectiveFrom = new Date(`${data.effectiveFrom}:00Z`);
      if (Number.isNaN(effectiveFrom.getTime()))
        throw new AppError('validation_failed', 'Enter the date and time the rates apply from.');
      const card = parseRateCardCsv(data.csv);
      const id = uuidv7();
      await platformDb.run(actor.userId, async (tx) => {
        await tx.insert(rateCards).values({
          id,
          currency: data.currency,
          effectiveFrom,
          sourceUrl: data.sourceUrl,
          notes: data.notes || null,
          createdByUserId: actor.userId,
        });
        await tx
          .insert(rateCardPrefixes)
          .values(
            card.markets.flatMap((m) =>
              m.prefixes.map((prefix) => ({ rateCardId: id, prefix, market: m.market })),
            ),
          );
        await tx.insert(rateCardPrices).values(
          card.markets.flatMap((m) =>
            Object.entries(m.prices).map(([category, priceMicros]) => ({
              rateCardId: id,
              market: m.market,
              category: category as RateCategory,
              tierFrom: 0,
              priceMicros,
            })),
          ),
        );
        await tx.insert(platformAuditEvents).values(
          audit(actor, 'platform.rate_card_created', {
            rateCardId: id,
            currency: data.currency,
            effectiveFrom: effectiveFrom.toISOString(),
            markets: card.markets.length,
          }),
        );
      });
      return { id };
    },

    async publishRateCard(actor: PlatformActor, id: string) {
      if (!z.uuid().safeParse(id).success) throw notFound('Rate card');
      await platformDb.run(actor.userId, async (tx) => {
        const [card] = await tx
          .select({
            status: rateCards.status,
            currency: rateCards.currency,
            effectiveFrom: rateCards.effectiveFrom,
          })
          .from(rateCards)
          .where(eq(rateCards.id, id))
          .for('update');
        if (!card) throw notFound('Rate card');
        if (card.status !== 'draft')
          throw new AppError('conflict', 'Only draft rate cards can be published.');
        const [clash] = await tx
          .select({ id: rateCards.id })
          .from(rateCards)
          .where(
            sql`${rateCards.status} = 'published' and ${rateCards.currency} = ${card.currency}
                and ${rateCards.effectiveFrom} = ${card.effectiveFrom.toISOString()}::timestamptz`,
          );
        if (clash)
          throw new AppError(
            'conflict',
            'A published card already applies from that moment. Withdraw it first.',
          );
        await tx
          .update(rateCards)
          .set({
            status: 'published',
            publishedByUserId: actor.userId,
            publishedAt: deps.clock.now(),
          })
          .where(eq(rateCards.id, id));
        await tx
          .insert(platformAuditEvents)
          .values(audit(actor, 'platform.rate_card_published', { rateCardId: id }));
      });
    },

    async withdrawRateCard(actor: PlatformActor, id: string, input: unknown) {
      if (!z.uuid().safeParse(id).success) throw notFound('Rate card');
      const parsed = reasonSchema.safeParse(input);
      if (!parsed.success)
        throw new AppError('validation_failed', parsed.error.issues[0]?.message ?? 'Give a reason');
      await platformDb.run(actor.userId, async (tx) => {
        const [card] = await tx
          .select({ status: rateCards.status })
          .from(rateCards)
          .where(eq(rateCards.id, id))
          .for('update');
        if (!card) throw notFound('Rate card');
        if (card.status === 'withdrawn') return;
        await tx
          .update(rateCards)
          .set({
            status: 'withdrawn',
            withdrawnByUserId: actor.userId,
            withdrawnAt: deps.clock.now(),
          })
          .where(eq(rateCards.id, id));
        await tx
          .insert(platformAuditEvents)
          .values(
            audit(actor, 'platform.rate_card_withdrawn', { rateCardId: id }, parsed.data.reason),
          );
      });
    },
  };
}

export type RateCardsService = ReturnType<typeof createRateCardsService>;
