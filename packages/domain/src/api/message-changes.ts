import { z } from 'zod';
import type { Keyring } from '@w360/core';
import {
  and,
  asc,
  contacts,
  conversations,
  eq,
  messageChanges,
  messages,
  sql,
  type Database,
} from '@w360/db';
import { answeredJoin, answeredMessages } from '../messaging/reply-context';
import { parseInput } from '../validation';
import { openChangeCursor, sealChangeCursor } from './change-cursors';
import { assertScope, type ApiContext } from './context';
import { feedMessageColumns, toApiFeedMessage, type ApiFeedMessage } from './conversations';
import { API_LIMITS } from './model';

/**
 * Following messages through the public API (ADR-116). Every transaction that changes how the API
 * describes a message (received or created, its status, status time or error changed, its contact
 * erased) moves the message's one row in `app.message_changes` to itself (migration 0093); the feed
 * reads the messages in the order of those transactions, and only those below the snapshot's xmin.
 * Every transaction below it has finished, so what a page reads is final, and a change committed
 * later always lies beyond the page's cursor: following `nextCursor` misses no change and repeats
 * only messages changed again.
 */

export const apiMessageChangesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z
      .string()
      .max(400)
      .optional()
      .describe('`nextCursor` from the previous page; none to start from the first change.'),
  })
  .strict();

export interface ApiMessageChange {
  /** The message's id. */
  id: string;
  /** Its contact was erased: nothing of the message is shown. */
  erased: boolean;
  /** The message as it is now, as GET /messages gives it; null once its contact is erased. */
  message: ApiFeedMessage | null;
}

export interface ApiMessageChangePage {
  data: ApiMessageChange[];
  nextCursor: string;
  hasMore: boolean;
}

export async function apiMessageChanges(
  deps: { db: Database; keyring: Keyring },
  ctx: ApiContext,
  query: unknown,
): Promise<ApiMessageChangePage> {
  assertScope(ctx, 'conversations.read');
  const q = parseInput(apiMessageChangesQuerySchema, query);
  const from = openChangeCursor(deps.keyring, 'message-changes', ctx.tenant.id, q.cursor);
  const rows = await deps.db.run(
    ctx.scope,
    (tx) =>
      tx
        .select({
          ...feedMessageColumns,
          erasedAt: contacts.erasedAt,
          changeId: sql<string>`${messageChanges.id}::text`,
          changeXact: sql<string>`${messageChanges.xact}::text`,
        })
        .from(messageChanges)
        .innerJoin(
          messages,
          and(
            eq(messages.tenantId, messageChanges.tenantId),
            eq(messages.id, messageChanges.messageId),
          ),
        )
        .innerJoin(
          conversations,
          and(
            eq(conversations.tenantId, messages.tenantId),
            eq(conversations.id, messages.conversationId),
          ),
        )
        .innerJoin(
          contacts,
          and(
            eq(contacts.tenantId, conversations.tenantId),
            eq(contacts.id, conversations.contactId),
          ),
        )
        .leftJoin(answeredMessages, answeredJoin())
        .where(
          and(
            eq(messageChanges.tenantId, ctx.tenant.id),
            sql`(${messageChanges.xact}, ${messageChanges.id}) > (${from.xact}::xid8, ${from.id}::bigint)`,
            sql`${messageChanges.xact} < pg_snapshot_xmin(pg_current_snapshot())`,
          ),
        )
        .orderBy(asc(messageChanges.xact), asc(messageChanges.id))
        .limit(q.limit + 1),
    { accessMode: 'read only' },
  );
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    data: page.map((r) => ({
      id: r.id,
      erased: r.erasedAt !== null,
      message: r.erasedAt === null ? toApiFeedMessage(r) : null,
    })),
    nextCursor: sealChangeCursor(
      deps.keyring,
      'message-changes',
      ctx.tenant.id,
      last ? { xact: last.changeXact, id: last.changeId } : from,
    ),
    hasMore: rows.length > q.limit,
  };
}
