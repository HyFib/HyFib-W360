import { z } from 'zod';
import { notFound } from '@w360/core';
import {
  and,
  channelAccounts,
  chatLinkClicks,
  chatLinks,
  desc,
  eq,
  exactTimestamp,
  gte,
  isNotNull,
  isNull,
  sql,
  tenants,
  type Database,
  type Tx,
} from '@w360/db';
import { linkClicks30, linkConversations30 } from '../growth/service';
import { phoneDigits, prefilledText, waMeUrl } from '../growth/model';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * Chat links through the public API (ADR-299), read with `chat_links.read`: the short links and QR
 * codes that open a chat with one of the company's numbers with a message ready to send, as the
 * Growth pages list them, with their clicks and the conversations they started in the last 30 days.
 */

export interface ChatLinksDeps {
  db: Database;
  /** HyFib's address, which the short links are on. */
  appBaseUrl: string;
}

/** A chat link as the API gives it. */
export interface ApiChatLink {
  id: string;
  name: string;
  /** The message the chat opens with, without the reference. */
  message: string;
  /** Added to the message as "(ref CODE)" when `includeRef` is true, so conversations count. */
  refCode: string;
  includeRef: boolean;
  /** HyFib's short link (also in the QR code): it counts the click and opens WhatsApp. */
  shortUrl: string;
  /** The wa.me address the short link opens; null while the number has no phone number. */
  waMeUrl: string | null;
  /** The number the chat opens with, and whether it is active (an inactive one opens nothing). */
  channel: { id: string; phone: string | null; active: boolean };
  archived: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Clicks on the company's last 30 days, today included, and the conversations the link started
   * in the last 30 days (null when the link adds no reference, so none are counted).
   */
  last30Days: { clicks: number; conversations: number | null };
}

/** A chat link with its clicks per day. */
export interface ApiChatLinkDetail extends ApiChatLink {
  /** The days of the last 30 with clicks, in the company's time zone, newest first. */
  clicksByDay: { day: string; clicks: number }[];
}

/** A chat link, as the OpenAPI document describes it. */
export const apiChatLinkSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  message: z.string().describe('The message the chat opens with, without the reference.'),
  refCode: z
    .string()
    .describe(
      'Added to the message as “(ref CODE)” when `includeRef` is true: a conversation counts for the link when the customer’s message carries it on the link’s number.',
    ),
  includeRef: z.boolean(),
  shortUrl: z
    .string()
    .describe(
      'HyFib’s short link, which the QR code opens too: it counts the click and opens WhatsApp, and opens nothing while the link is archived or its number inactive.',
    ),
  waMeUrl: z
    .string()
    .nullable()
    .describe('The wa.me address the short link opens; null while the number has no phone number.'),
  channel: z
    .object({ id: z.uuid(), phone: z.string().nullable(), active: z.boolean() })
    .describe('The number the chat opens with; an inactive one opens nothing.'),
  archived: z.boolean(),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  last30Days: z.object({
    clicks: z
      .number()
      .int()
      .min(0)
      .describe(
        'Opens of the short link and QR code on the company’s last 30 days, today included, repeated clicks and automated visits too.',
      ),
    conversations: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        'Conversations the link started in the last 30 days; null when it adds no reference, so none are counted.',
      ),
  }),
});

/** A chat link with its clicks per day, as the OpenAPI document describes it. */
export const apiChatLinkDetailSchema = apiChatLinkSchema.extend({
  clicksByDay: z
    .array(z.object({ day: z.iso.date(), clicks: z.number().int().min(1) }))
    .describe('The days of the last 30 with clicks, in the company’s time zone, newest first.'),
});

/** What `GET /chat-links` takes. */
export const apiChatLinkListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    archived: z
      .enum(['true', 'false'])
      .optional()
      .describe('`true`: only archived links; otherwise only those in use.'),
  })
  .strict();

async function companyTimezone(tx: Tx, tenantId: string): Promise<string> {
  const [company] = await tx
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!company) throw notFound('Company');
  return company.timezone;
}

/** The links matching `where`, newest first, with what the API gives of each. */
function linkRows(tx: Tx, timezone: string, where: ReturnType<typeof and>, limit: number) {
  return tx
    .select({
      id: chatLinks.id,
      name: chatLinks.name,
      message: chatLinks.message,
      refCode: chatLinks.refCode,
      includeRef: chatLinks.includeRef,
      slug: chatLinks.slug,
      channelId: chatLinks.channelAccountId,
      channelStatus: channelAccounts.status,
      phone: channelAccounts.displayPhoneNumber,
      archivedAt: chatLinks.archivedAt,
      version: chatLinks.version,
      createdAt: chatLinks.createdAt,
      updatedAt: chatLinks.updatedAt,
      cursorAt: exactTimestamp(chatLinks.createdAt),
      clicks: linkClicks30(timezone),
      conversations: linkConversations30(),
    })
    .from(chatLinks)
    .innerJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, chatLinks.tenantId),
        eq(channelAccounts.id, chatLinks.channelAccountId),
      ),
    )
    .where(where)
    .orderBy(desc(chatLinks.createdAt), desc(chatLinks.id))
    .limit(limit);
}

type LinkRow = Awaited<ReturnType<typeof linkRows>>[number];

function toApiChatLink(row: LinkRow, appBaseUrl: string): ApiChatLink {
  const phone = phoneDigits(row.phone);
  return {
    id: row.id,
    name: row.name,
    message: row.message,
    refCode: row.refCode,
    includeRef: row.includeRef,
    shortUrl: `${appBaseUrl.replace(/\/$/, '')}/l/${row.slug}`,
    waMeUrl: phone ? waMeUrl(phone, prefilledText(row.message, row.refCode, row.includeRef)) : null,
    channel: { id: row.channelId, phone: row.phone, active: row.channelStatus === 'active' },
    archived: row.archivedAt !== null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    last30Days: { clicks: row.clicks, conversations: row.includeRef ? row.conversations : null },
  };
}

/**
 * The company's chat links in use, or archived ones when asked, newest first on exact pages, with
 * their clicks and the conversations they started in the last 30 days. Reading works while the
 * company is suspended, as the Growth pages do.
 */
export async function apiListChatLinks(
  deps: ChatLinksDeps,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiChatLink[]; nextCursor: string | null }> {
  assertScope(ctx, 'chat_links.read');
  const q = parseInput(apiChatLinkListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const timezone = await companyTimezone(tx, ctx.tenant.id);
      const rows = await linkRows(
        tx,
        timezone,
        and(
          eq(chatLinks.tenantId, ctx.tenant.id),
          q.archived === 'true' ? isNotNull(chatLinks.archivedAt) : isNull(chatLinks.archivedAt),
          cursor
            ? sql`(${chatLinks.createdAt}, ${chatLinks.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
        q.limit + 1,
      );
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map((row) => toApiChatLink(row, deps.appBaseUrl)),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** One chat link, archived or not, with the days of the last 30 it was clicked on. */
export async function apiGetChatLink(
  deps: ChatLinksDeps,
  ctx: ApiContext,
  id: string,
): Promise<ApiChatLinkDetail> {
  assertScope(ctx, 'chat_links.read');
  if (!z.uuid().safeParse(id).success) throw notFound('Chat link');
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const timezone = await companyTimezone(tx, ctx.tenant.id);
      const [row] = await linkRows(
        tx,
        timezone,
        and(eq(chatLinks.tenantId, ctx.tenant.id), eq(chatLinks.id, id)),
        1,
      );
      if (!row) throw notFound('Chat link');
      const days = await tx
        .select({ day: chatLinkClicks.day, clicks: chatLinkClicks.clicks })
        .from(chatLinkClicks)
        .where(
          and(
            eq(chatLinkClicks.tenantId, ctx.tenant.id),
            eq(chatLinkClicks.linkId, id),
            gte(chatLinkClicks.day, sql`(now() at time zone ${timezone})::date - 29`),
          ),
        )
        .orderBy(desc(chatLinkClicks.day));
      return { ...toApiChatLink(row, deps.appBaseUrl), clicksByDay: days };
    },
    { accessMode: 'read only' },
  );
}
