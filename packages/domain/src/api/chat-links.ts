import { z } from 'zod';
import { AppError, notFound, type Clock } from '@w360/core';
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
import { recordSystemAudit } from '../audit';
import {
  CHAT_LINK_ID_CONSTRAINTS,
  chatLinkMessageSchema,
  chatLinkNameSchema,
  linkClicks30,
  linkConversations30,
  withFreshIds,
  writeCreateChatLink,
  writeSetChatLinkArchived,
  writeUpdateChatLink,
} from '../growth/service';
import { phoneDigits, prefilledText, waMeUrl } from '../growth/model';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiActor, assertScope, type ApiContext } from './context';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';
import { API_LIMITS } from './model';

/**
 * Chat links through the public API (ADR-299), read with `chat_links.read`: the short links and QR
 * codes that open a chat with one of the company's numbers with a message ready to send, as the
 * Growth pages list them, with their clicks and the conversations they started in the last 30 days.
 * Keys with `chat_links.write` create, change, archive and restore them (ADR-300) through the writes
 * the Growth pages use, recorded as the key's.
 */

export interface ChatLinksDeps {
  db: Database;
  /** HyFib's address, which the short links are on. */
  appBaseUrl: string;
}

/** What the writes need besides. */
export interface ChatLinkWritesDeps extends ChatLinksDeps {
  clock: Clock;
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
  /** Who added it: a member (never which) or a key, by its id. */
  createdBy: 'member' | 'api';
  createdByApiKeyId: string | null;
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
  version: z
    .number()
    .int()
    .min(1)
    .describe(
      'Moves on with every change; `PATCH /chat-links/{id}` takes it as `expectedVersion`.',
    ),
  createdBy: z
    .enum(['member', 'api'])
    .describe('Who added it: a member (never which) or a key, named by `createdByApiKeyId`.'),
  createdByApiKeyId: z.uuid().nullable(),
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

/** What `POST /chat-links` takes: a link as members add one under Growth → Chat links. */
export const apiCreateChatLinkSchema = z
  .object({
    name: chatLinkNameSchema.describe('The link’s name, as the Growth pages show it.'),
    channelId: z
      .uuid()
      .describe('The number the chat opens with: one of the company’s active numbers.'),
    message: chatLinkMessageSchema
      .default('')
      .describe('The message the chat opens with, ready for the customer to send; empty for none.'),
    includeRef: z
      .boolean()
      .default(true)
      .describe(
        'Whether the message carries the link’s reference, “(ref CODE)”, which counts the conversations it starts.',
      ),
  })
  .strict();

const LINK_CONTENT = ['name', 'channelId', 'message', 'includeRef'] as const;

/**
 * What `PATCH /chat-links/{id}` takes: what changes, those left out kept, or `archived` alone, from
 * the version given (any version when left out).
 */
export const apiUpdateChatLinkSchema = z
  .object({
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Change the link only at this `version`: a link changed since is refused with 409 (read it again).',
      ),
    name: chatLinkNameSchema.optional(),
    channelId: z.uuid().optional().describe('One of the company’s active numbers.'),
    message: chatLinkMessageSchema.optional(),
    includeRef: z.boolean().optional(),
    archived: z
      .boolean()
      .optional()
      .describe(
        '`true` archives the link (its short link, QR code and buttons then open nothing), `false` restores it; in a request of its own.',
      ),
  })
  .strict()
  .refine((change) => Object.keys(change).some((key) => key !== 'expectedVersion'), {
    message:
      'Give at least one change: `name`, `channelId`, `message`, `includeRef` or `archived`.',
  })
  .refine(
    (change) => change.archived === undefined || LINK_CONTENT.every((k) => change[k] === undefined),
    { message: 'Archive or restore a link in a request of its own.', path: ['archived'] },
  );

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
      createdByApiKeyId: chatLinks.createdByApiKeyId,
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
    createdBy: row.createdByApiKeyId ? 'api' : 'member',
    createdByApiKeyId: row.createdByApiKeyId,
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

/** One of the company's links as the API gives it, in the caller's transaction, or null. */
async function readLink(tx: Tx, tenantId: string, id: string, appBaseUrl: string) {
  const timezone = await companyTimezone(tx, tenantId);
  const [row] = await linkRows(
    tx,
    timezone,
    and(eq(chatLinks.tenantId, tenantId), eq(chatLinks.id, id)),
    1,
  );
  return row ? { link: toApiChatLink(row, appBaseUrl), timezone } : null;
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
      const read = await readLink(tx, ctx.tenant.id, id, deps.appBaseUrl);
      if (!read) throw notFound('Chat link');
      const days = await tx
        .select({ day: chatLinkClicks.day, clicks: chatLinkClicks.clicks })
        .from(chatLinkClicks)
        .where(
          and(
            eq(chatLinkClicks.tenantId, ctx.tenant.id),
            eq(chatLinkClicks.linkId, id),
            gte(chatLinkClicks.day, sql`(now() at time zone ${read.timezone})::date - 29`),
          ),
        )
        .orderBy(desc(chatLinkClicks.day));
      return { ...read.link, clicksByDay: days };
    },
    { accessMode: 'read only' },
  );
}

/**
 * Adds a link as members do under Growth → Chat links (ADR-300), recorded as the key's: on one of
 * the company's active numbers, within the cap on open links, with a new reference and short link.
 * The audit log names the key. With an Idempotency-Key a retry answers the first response.
 */
export async function apiCreateChatLink(
  deps: ChatLinkWritesDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'chat_links.write');
  const data = parseInput(apiCreateChatLinkSchema, input);
  const now = deps.clock.now();
  return withFreshIds(
    () =>
      deps.db.run(ctx.scope, async (tx) => {
        // Claimed in the link's transaction, so a refused link leaves the key unused.
        let claimed: string | null = null;
        if (idempotency) {
          const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
          if ('replay' in claim) return claim.replay;
          claimed = claim.claimed;
        }
        const id = await writeCreateChatLink(
          tx,
          ctx.tenant.id,
          {
            name: data.name,
            channelAccountId: data.channelId,
            message: data.message,
            includeRef: data.includeRef,
          },
          { apiKeyId: ctx.key.id },
          'channelId',
        );
        await recordSystemAudit(
          tx,
          ctx.tenant.id,
          {
            action: 'growth.link_created',
            subjectType: 'chat_link',
            subjectId: id,
            correlationId: ctx.requestId,
            metadata: { name: data.name, source: 'api' },
          },
          apiActor(ctx),
        );
        const read = await readLink(tx, ctx.tenant.id, id, deps.appBaseUrl);
        if (!read) throw notFound('Chat link');
        const response = { status: 201, body: { data: read.link } };
        if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
        return { ...response, replayed: false };
      }),
    CHAT_LINK_ID_CONSTRAINTS,
  );
}

/**
 * Changes a link as members edit it, or archives or restores it (ADR-300), from the version given,
 * and answers it. An archived link is changed only once restored (409); a change that leaves the
 * link as it is writes nothing and is not audited, so a retry needs no key.
 */
export async function apiUpdateChatLink(
  deps: ChatLinkWritesDeps,
  ctx: ApiContext,
  id: string,
  input: unknown,
): Promise<ApiChatLink> {
  assertScope(ctx, 'chat_links.write');
  if (!z.uuid().safeParse(id).success) throw notFound('Chat link');
  const change = parseInput(apiUpdateChatLinkSchema, input);
  return deps.db.run(ctx.scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(chatLinks)
      .where(and(eq(chatLinks.tenantId, ctx.tenant.id), eq(chatLinks.id, id)))
      .for('update');
    if (!row) throw notFound('Chat link');
    if (change.expectedVersion !== undefined && change.expectedVersion !== row.version) {
      throw new AppError(
        'conflict',
        `The chat link changed since version ${change.expectedVersion}; its version is ${row.version}. Read it again.`,
      );
    }
    const fields = {
      name: change.name ?? row.name,
      channelAccountId: change.channelId ?? row.channelAccountId,
      message: change.message ?? row.message,
      includeRef: change.includeRef ?? row.includeRef,
    };
    let action: 'growth.link_updated' | 'growth.link_archived' | 'growth.link_restored' | null =
      null;
    if (change.archived !== undefined) {
      const archived = await writeSetChatLinkArchived(
        tx,
        ctx.tenant.id,
        row,
        change.archived,
        deps.clock.now(),
      );
      if (archived !== null) {
        action = change.archived ? 'growth.link_archived' : 'growth.link_restored';
      }
    } else if (
      fields.name !== row.name ||
      fields.channelAccountId !== row.channelAccountId ||
      fields.message !== row.message ||
      fields.includeRef !== row.includeRef
    ) {
      await writeUpdateChatLink(tx, ctx.tenant.id, row, fields, 'channelId');
      action = 'growth.link_updated';
    }
    if (action) {
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action,
          subjectType: 'chat_link',
          subjectId: row.id,
          correlationId: ctx.requestId,
          metadata: { name: fields.name, source: 'api' },
        },
        apiActor(ctx),
      );
    }
    const read = await readLink(tx, ctx.tenant.id, row.id, deps.appBaseUrl);
    if (!read) throw notFound('Chat link');
    return read.link;
  });
}
