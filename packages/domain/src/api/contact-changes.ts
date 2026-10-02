import { z } from 'zod';
import { AppError, type Keyring } from '@w360/core';
import {
  and,
  asc,
  contactChanges,
  contacts,
  eq,
  outerColumn,
  sql,
  systemScope,
  type Database,
} from '@w360/db';
import { parseInput } from '../validation';
import { apiContactColumns, toApiContact, type ApiContact } from './contact-view';
import { assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * Following contact changes through the public API (ADR-114). Every transaction that changes how
 * the API describes a contact records the contact once (migration 0091); the feed reads each
 * contact once, at its latest change, in the order of the transactions that made the changes, and
 * only changes made by transactions below the snapshot's xmin. Every transaction below it has
 * finished, so what a page reads is final, and a change committed later always lies beyond the
 * page's cursor: following `nextCursor` misses no change and repeats only contacts changed again.
 */

export const apiContactChangesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z
      .string()
      .max(400)
      .optional()
      .describe('`nextCursor` from the previous page; none to start from the first change.'),
  })
  .strict();

export interface ApiContactChange {
  /** The contact's id. */
  id: string;
  erased: boolean;
  /** The contact as it is now; null once erased. */
  contact: ApiContact | null;
}

export interface ApiContactChangePage {
  data: ApiContactChange[];
  nextCursor: string;
  hasMore: boolean;
}

/** A place in a company's feed: after the change with this transaction and id. */
export interface ContactChangePosition {
  xact: string;
  id: string;
}

const START: ContactChangePosition = { xact: '0', id: '0' };
const POSITION_RE = /^(\d{1,20})\.(\d{1,19})$/;
const INVALID_CURSOR =
  'Invalid cursor: give the nextCursor of a page of this feed, or no cursor to start again from the first change.';

// A cursor is sealed to its company: a position is a database transaction id, which would show how
// busy the whole platform is, and another company's cursor must not open.
const cursorAad = (tenantId: string) => `contact-changes|tenant:${tenantId}`;

export function sealContactChangeCursor(
  keyring: Keyring,
  tenantId: string,
  at: ContactChangePosition,
): string {
  return Buffer.from(keyring.encrypt(`${at.xact}.${at.id}`, cursorAad(tenantId))).toString(
    'base64url',
  );
}

export function openContactChangeCursor(
  keyring: Keyring,
  tenantId: string,
  cursor: string | undefined,
): ContactChangePosition {
  if (cursor === undefined) return START;
  let position: string;
  try {
    position = keyring.decryptString(
      Buffer.from(cursor, 'base64url').toString('utf8'),
      cursorAad(tenantId),
    );
  } catch {
    // Tampered, another company's, or sealed with a key the platform no longer holds.
    throw new AppError('validation_failed', INVALID_CURSOR, {
      issues: [{ path: 'cursor', message: INVALID_CURSOR }],
    });
  }
  const match = POSITION_RE.exec(position);
  if (!match?.[1] || !match[2]) {
    throw new AppError('validation_failed', INVALID_CURSOR, {
      issues: [{ path: 'cursor', message: INVALID_CURSOR }],
    });
  }
  return { xact: match[1], id: match[2] };
}

export async function apiContactChanges(
  deps: { db: Database; keyring: Keyring },
  ctx: ApiContext,
  query: unknown,
): Promise<ApiContactChangePage> {
  assertScope(ctx, 'contacts.read');
  const q = parseInput(apiContactChangesQuerySchema, query);
  const from = openContactChangeCursor(deps.keyring, ctx.tenant.id, q.cursor);
  const finished = sql`pg_snapshot_xmin(pg_current_snapshot())`;
  const rows = await deps.db.run(
    ctx.scope,
    (tx) =>
      tx
        .select({
          ...apiContactColumns,
          changeId: sql<string>`${contactChanges.id}::text`,
          changeXact: sql<string>`${contactChanges.xact}::text`,
        })
        .from(contactChanges)
        .innerJoin(
          contacts,
          and(
            eq(contacts.tenantId, contactChanges.tenantId),
            eq(contacts.id, contactChanges.contactId),
          ),
        )
        .where(
          and(
            eq(contactChanges.tenantId, ctx.tenant.id),
            sql`(${contactChanges.xact}, ${contactChanges.id}) > (${from.xact}::xid8, ${from.id}::bigint)`,
            sql`${contactChanges.xact} < ${finished}`,
            // Each contact once, at its latest finished change.
            sql`not exists (select 1 from app.contact_changes later
              where later.tenant_id = ${outerColumn(contactChanges.tenantId)}
                and later.contact_id = ${outerColumn(contactChanges.contactId)}
                and (later.xact, later.id) > (${outerColumn(contactChanges.xact)}, ${outerColumn(contactChanges.id)})
                and later.xact < ${finished})`,
          ),
        )
        .orderBy(asc(contactChanges.xact), asc(contactChanges.id))
        .limit(q.limit + 1),
    { accessMode: 'read only' },
  );
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    data: page.map((r) => ({
      id: r.id,
      erased: r.erasedAt !== null,
      contact: r.erasedAt === null ? toApiContact(r) : null,
    })),
    nextCursor: sealContactChangeCursor(
      deps.keyring,
      ctx.tenant.id,
      last ? { xact: last.changeXact, id: last.changeId } : from,
    ),
    hasMore: rows.length > q.limit,
  };
}

/**
 * Deletes the changes a later change of the same contact replaced, reading at most `limit` changes
 * in order from where the last compaction stopped (the minute sweep); returns how many it deleted.
 */
export async function compactContactChanges(db: Database, limit = 5_000): Promise<number> {
  return db.run(systemScope, async (tx) => {
    const res = await tx.execute<{ deleted: number }>(
      sql`select ops.compact_contact_changes(${limit}) as deleted`,
    );
    return Number(res.rows[0]?.deleted ?? 0);
  });
}
