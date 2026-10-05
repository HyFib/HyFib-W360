import { z } from 'zod';
import { clipText, uuidv7 } from '@w360/core';
import {
  and,
  chatLinks,
  conversationSources,
  desc,
  eq,
  type ConversationSourceKind,
  type Tx,
} from '@w360/db';
import { findRefCode } from './model';

/**
 * Where conversations come from. A message from a click-to-WhatsApp ad carries a `referral` object
 * (research M-130); a message sent from a chat link carries the link's reference code. Each such
 * inbound message gets one source row. Only what identifies the source is kept: the ad click id
 * (`ctwa_clid`), image and video addresses and the ad's body are not stored.
 */

const referralSchema = z
  .object({
    source_type: z.string().optional(),
    source_id: z.string().optional(),
    source_url: z.string().optional(),
    headline: z.string().optional(),
  })
  .loose();

export interface AdReferral {
  sourceType: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  headline: string | null;
}

const clip = (value: string | undefined, max: number): string | null => {
  const text = value?.trim();
  return text ? clipText(text, max) : null;
};

/** The parts of a webhook referral object that identify the ad (null when it is not an object). */
export function parseAdReferral(raw: unknown): AdReferral | null {
  const parsed = referralSchema.safeParse(raw);
  if (!parsed.success) return null;
  const url = clip(parsed.data.source_url, 1000);
  return {
    sourceType: clip(parsed.data.source_type, 32),
    sourceId: clip(parsed.data.source_id, 128),
    // Only web addresses are kept (the inbox shows it as a link).
    sourceUrl: url && /^https?:\/\//i.test(url) ? url : null,
    headline: clip(parsed.data.headline, 200),
  };
}

/**
 * Records where an inbound message came from, in the ingest transaction: an ad referral, or else a
 * reference code of one of the company's links for the number the message arrived on.
 */
export async function recordConversationSource(
  tx: Tx,
  input: {
    tenantId: string;
    channelAccountId: string;
    conversationId: string;
    contactId: string;
    messageId: string;
    referral: unknown;
    text: string | null;
    occurredAt: Date;
  },
): Promise<ConversationSourceKind | null> {
  const base = {
    id: uuidv7(),
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    messageId: input.messageId,
    occurredAt: input.occurredAt,
  };
  const ad =
    input.referral === undefined || input.referral === null
      ? null
      : parseAdReferral(input.referral);
  if (ad) {
    await tx
      .insert(conversationSources)
      .values({
        ...base,
        kind: 'ad',
        adSourceType: ad.sourceType,
        adSourceId: ad.sourceId,
        adSourceUrl: ad.sourceUrl,
        adHeadline: ad.headline,
      })
      .onConflictDoNothing();
    return 'ad';
  }
  const code = input.text ? findRefCode(input.text) : null;
  if (!code) return null;
  const [link] = await tx
    .select({ id: chatLinks.id })
    .from(chatLinks)
    .where(
      and(
        eq(chatLinks.tenantId, input.tenantId),
        eq(chatLinks.refCode, code),
        // A code only counts on the number its link opens (another number's customers may type it).
        eq(chatLinks.channelAccountId, input.channelAccountId),
      ),
    );
  if (!link) return null;
  await tx
    .insert(conversationSources)
    .values({ ...base, kind: 'link', linkId: link.id })
    .onConflictDoNothing();
  return 'link';
}

export interface ConversationSourceView {
  kind: ConversationSourceKind;
  linkId: string | null;
  linkName: string | null;
  adHeadline: string | null;
  adSourceUrl: string | null;
  adSourceType: string | null;
  occurredAt: string;
}

/** The most recent source of a conversation (for the inbox). */
export async function latestConversationSource(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<ConversationSourceView | null> {
  const [row] = await tx
    .select({
      kind: conversationSources.kind,
      linkId: conversationSources.linkId,
      linkName: chatLinks.name,
      adHeadline: conversationSources.adHeadline,
      adSourceUrl: conversationSources.adSourceUrl,
      adSourceType: conversationSources.adSourceType,
      occurredAt: conversationSources.occurredAt,
    })
    .from(conversationSources)
    .leftJoin(
      chatLinks,
      and(
        eq(chatLinks.tenantId, conversationSources.tenantId),
        eq(chatLinks.id, conversationSources.linkId),
      ),
    )
    .where(
      and(
        eq(conversationSources.tenantId, tenantId),
        eq(conversationSources.conversationId, conversationId),
      ),
    )
    .orderBy(desc(conversationSources.occurredAt), desc(conversationSources.id))
    .limit(1);
  return row ? { ...row, occurredAt: row.occurredAt.toISOString() } : null;
}
