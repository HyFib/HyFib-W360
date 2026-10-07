import { z } from 'zod';
import { and, asc, contactTags, conversationTags, eq, gt, sql, type Tx } from '@w360/db';
import { normalizeTag } from '../contacts/fields';
import type { OutboundDeps } from '../messaging/outbound';
import { parseInput } from '../validation';
import { assertScope, type ApiContext } from './context';
import { invalidField } from './deals';
import { API_LIMITS } from './model';

/**
 * The tags in use through the API (ADR-272): the company's contact tags with `contacts.read` and its
 * conversation tags with `conversations.read`, alphabetically, each with how many contacts or
 * conversations carry it when the page is read. They are the tags the API's filters (`tag`) and
 * changes (`addTags`, `removeTags`) take, and the contact tags webhook endpoints narrow by (ADR-267).
 * A page continues after the last tag of the page before, so paging never skips or repeats a tag
 * that stays in use; a tag first used meanwhile before the cursor is listed on the next pass.
 */

export const apiTagListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    prefix: z
      .string()
      .max(100)
      .optional()
      .describe(
        'Only the tags that start with this text, compared as tags are written (lower case, single spaces).',
      ),
  })
  .strict();

export interface ApiContactTag {
  tag: string;
  /** The contacts that have the tag when the page is read. */
  contacts: number;
}

export interface ApiConversationTag {
  tag: string;
  /** The conversations that have the tag when the page is read. */
  conversations: number;
}

/** A page's position: the last tag it listed, which tags are written so a cursor can be checked. */
export const encodeTagCursor = (tag: string) => Buffer.from(tag).toString('base64url');

export function decodeTagCursor(value: string | undefined): string | null {
  if (value === undefined) return null;
  const tag = Buffer.from(value, 'base64url').toString('utf8');
  const checked = normalizeTag(tag);
  if (!checked.ok || checked.tag !== tag) throw invalidField('cursor', 'Invalid cursor.');
  return tag;
}

/** The query as a page of tags reads it: the size, the tag to continue after and the prefix. */
export function apiTagListQuery(query: unknown): {
  limit: number;
  after: string | null;
  prefix: string | null;
} {
  const q = parseInput(apiTagListQuerySchema, query);
  let prefix: string | null = null;
  if (q.prefix !== undefined) {
    const checked = normalizeTag(q.prefix);
    if (!checked.ok) throw invalidField('prefix', checked.message);
    prefix = checked.tag;
  }
  return { limit: q.limit, after: decodeTagCursor(q.cursor), prefix };
}

type TagTable = typeof contactTags | typeof conversationTags;

/** One page of a tag table's tags in the company, alphabetically, with how many rows carry each. */
async function tagPage(
  tx: Tx,
  table: TagTable,
  tenantId: string,
  q: ReturnType<typeof apiTagListQuery>,
): Promise<{ rows: { tag: string; count: number }[]; nextCursor: string | null }> {
  const rows = await tx
    .select({ tag: table.tag, count: sql<number>`count(*)::int` })
    .from(table)
    .where(
      and(
        eq(table.tenantId, tenantId),
        q.after !== null ? gt(table.tag, q.after) : undefined,
        q.prefix !== null ? sql`starts_with(${table.tag}, ${q.prefix})` : undefined,
      ),
    )
    .groupBy(table.tag)
    .orderBy(asc(table.tag))
    .limit(q.limit + 1);
  const shown = rows.slice(0, q.limit);
  const last = shown.at(-1);
  return {
    rows: shown,
    nextCursor: rows.length > q.limit && last ? encodeTagCursor(last.tag) : null,
  };
}

/** GET /contact-tags: the tags on the company's contacts, alphabetically, with their contacts. */
export async function apiListContactTags(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiContactTag[]; nextCursor: string | null }> {
  assertScope(ctx, 'contacts.read');
  const q = apiTagListQuery(query);
  const page = await deps.db.run(ctx.scope, (tx) => tagPage(tx, contactTags, ctx.tenant.id, q), {
    accessMode: 'read only',
  });
  return {
    data: page.rows.map((r) => ({ tag: r.tag, contacts: r.count })),
    nextCursor: page.nextCursor,
  };
}

/** GET /conversation-tags: the tags on the company's conversations, alphabetically. */
export async function apiListConversationTags(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiConversationTag[]; nextCursor: string | null }> {
  assertScope(ctx, 'conversations.read');
  const q = apiTagListQuery(query);
  const page = await deps.db.run(
    ctx.scope,
    (tx) => tagPage(tx, conversationTags, ctx.tenant.id, q),
    { accessMode: 'read only' },
  );
  return {
    data: page.rows.map((r) => ({ tag: r.tag, conversations: r.count })),
    nextCursor: page.nextCursor,
  };
}
