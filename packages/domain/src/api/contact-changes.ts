import { z } from 'zod';
import type { Keyring } from '@w360/core';
import {
  and,
  asc,
  contactChanges,
  contactMerges,
  contacts,
  eq,
  inArray,
  outerColumn,
  sql,
  systemScope,
  type Database,
} from '@w360/db';
import { parseInput } from '../validation';
import { openChangeCursor, sealChangeCursor, type ChangePosition } from './change-cursors';
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
 *
 * A merged contact is deleted with its changes, and the merge records a change of the contact kept
 * (migration 0150, ADR-225): each contact read names the contacts merged into it, so a reader
 * learns of a merge when it reads the kept contact at that change or a later one.
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
  /**
   * The contacts merged into this one, oldest merge first, those merged into a contact merged into
   * it later included (ADR-225): they no longer exist.
   */
  mergedContactIds: string[];
}

export interface ApiContactChangePage {
  data: ApiContactChange[];
  nextCursor: string;
  hasMore: boolean;
}

/** A place in the company's feed: after the change with this transaction and id. */
export type ContactChangePosition = ChangePosition;

/** A cursor sealed to the company and to this feed (ADR-114). */
export const sealContactChangeCursor = (
  keyring: Keyring,
  tenantId: string,
  at: ContactChangePosition,
): string => sealChangeCursor(keyring, 'contact-changes', tenantId, at);

export const openContactChangeCursor = (
  keyring: Keyring,
  tenantId: string,
  cursor: string | undefined,
): ContactChangePosition => openChangeCursor(keyring, 'contact-changes', tenantId, cursor);

export async function apiContactChanges(
  deps: { db: Database; keyring: Keyring },
  ctx: ApiContext,
  query: unknown,
): Promise<ApiContactChangePage> {
  assertScope(ctx, 'contacts.read');
  const q = parseInput(apiContactChangesQuerySchema, query);
  const from = openContactChangeCursor(deps.keyring, ctx.tenant.id, q.cursor);
  const finished = sql`pg_snapshot_xmin(pg_current_snapshot())`;
  const { rows, merges } = await deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
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
        .limit(q.limit + 1);
      // In the same snapshot as the page, so a merge it read is listed.
      const ids = rows.slice(0, q.limit).map((r) => r.id);
      const merges =
        ids.length === 0
          ? []
          : await tx
              .select({
                keptContactId: contactMerges.keptContactId,
                mergedContactId: contactMerges.mergedContactId,
              })
              .from(contactMerges)
              .where(
                and(
                  eq(contactMerges.tenantId, ctx.tenant.id),
                  inArray(contactMerges.keptContactId, ids),
                ),
              )
              .orderBy(asc(contactMerges.mergedAt), asc(contactMerges.mergedContactId));
      return { rows, merges };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const mergedInto = new Map<string, string[]>();
  for (const m of merges) {
    mergedInto.set(m.keptContactId, [
      ...(mergedInto.get(m.keptContactId) ?? []),
      m.mergedContactId,
    ]);
  }
  return {
    data: page.map((r) => ({
      id: r.id,
      erased: r.erasedAt !== null,
      contact: r.erasedAt === null ? toApiContact(r) : null,
      mergedContactIds: mergedInto.get(r.id) ?? [],
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
