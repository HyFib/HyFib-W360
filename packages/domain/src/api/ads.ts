import { z } from 'zod';
import type { Database } from '@w360/db';
import { readAdSources, type AdSourceView } from '../growth/service';
import { parseInput } from '../validation';
import { assertScope, type ApiContext } from './context';

/**
 * The click-to-WhatsApp ads customers wrote from, through the public API (ADR-302), read with
 * `ads.read`: the ads that started conversations in the last 30 days, as Growth → Ads lists them, by
 * the page's reader. HyFib keeps only what identifies an ad (ADR-044): never the ad click id.
 */

/** An ad as the API gives it. */
export interface ApiAd {
  /** Meta's id for the ad or post the customer wrote from, as Meta sent it. */
  id: string | null;
  /** Meta's type for it (`ad` or `post`, as Meta sent it). */
  type: string | null;
  headline: string | null;
  /** Its web address (http or https only; others are not kept). */
  url: string | null;
  /** The conversations it started, and the customers' messages that came from it. */
  last30Days: { conversations: number; messages: number };
  /** When the latest message from it arrived. */
  lastMessageAt: string;
}

/** An ad as the API gives it, for the OpenAPI document. */
export const apiAdSchema = z.object({
  id: z
    .string()
    .nullable()
    .describe('Meta’s id for the ad or post the customer wrote from, as Meta sent it.'),
  type: z.string().nullable().describe('Meta’s type for it, as Meta sent it (`ad` or `post`).'),
  headline: z.string().nullable().describe('The ad’s headline, as Meta sent it.'),
  url: z
    .string()
    .nullable()
    .describe('The ad’s web address, as Meta sent it (http or https only; others are not kept).'),
  last30Days: z
    .object({
      conversations: z
        .number()
        .int()
        .describe('The conversations whose customer wrote from the ad in the last 30 days.'),
      messages: z
        .number()
        .int()
        .describe('The customers’ messages that came from the ad in the last 30 days.'),
    })
    .describe('As Growth → Ads counts them.'),
  lastMessageAt: z.iso.datetime().describe('When the latest message from the ad arrived.'),
});

/** GET /ads takes no parameters: the page lists the last 30 days. */
export const apiAdListQuerySchema = z.object({}).strict();

const toApiAd = (ad: AdSourceView): ApiAd => ({
  id: ad.sourceId,
  type: ad.sourceType,
  headline: ad.headline,
  url: ad.sourceUrl,
  last30Days: { conversations: ad.conversations, messages: ad.messages },
  lastMessageAt: ad.lastAt,
});

/** The ads customers wrote from in the last 30 days, those that started the most conversations first. */
export async function apiListAds(
  deps: { db: Database },
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiAd[] }> {
  assertScope(ctx, 'ads.read');
  parseInput(apiAdListQuerySchema, query);
  const ads = await deps.db.run(ctx.scope, (tx) => readAdSources(tx, ctx.tenant.id), {
    accessMode: 'read only',
  });
  return { data: ads.map(toApiAd) };
}
