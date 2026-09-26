import { AppError } from '@w360/core';
import { sql, tenantEvents, type Database, type TenantScope, type Tx } from '@w360/db';

/**
 * Durable per-company event log that drives live updates (SSE) and polling. Events carry ids and
 * routing hints only; clients re-fetch data through authorised endpoints.
 *
 * Ordering: rows are read by (txid, id) and only when txid is below the current snapshot's xmin,
 * i.e. every transaction that could still insert an earlier-ordered row has finished. A slow
 * committer therefore delays delivery but is never skipped.
 */
export interface TenantEventInput {
  type: string;
  conversationId?: string | null;
  assignedMembershipId?: string | null;
  payload?: Record<string, unknown>;
}

export interface TenantEventRow {
  cursor: string;
  type: string;
  conversationId: string | null;
  assignedMembershipId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Records an event. When the caller does not state the assignee of the event's conversation
 * (`assignedMembershipId` undefined), the current assignee is recorded so live-update streams can
 * route the event only to members allowed to see that conversation.
 */
export async function emitTenantEvent(
  tx: Tx,
  tenantId: string,
  event: TenantEventInput,
): Promise<void> {
  const assignee =
    event.assignedMembershipId !== undefined
      ? event.assignedMembershipId
      : event.conversationId
        ? sql`(select c.assigned_membership_id from app.conversations c
                where c.tenant_id = ${tenantId}::uuid and c.id = ${event.conversationId}::uuid)`
        : null;
  await tx.insert(tenantEvents).values({
    tenantId,
    type: event.type,
    conversationId: event.conversationId ?? null,
    assignedMembershipId: assignee,
    payload: event.payload ?? {},
  });
}

/**
 * Whether a member may receive an event. Events carry ids only, but conversation ids of threads a
 * member cannot open are still withheld.
 */
export function eventVisibleTo(
  access: { readAll: boolean; readAssigned: boolean; channelsRead: boolean; membershipId: string },
  event: Pick<TenantEventRow, 'type' | 'conversationId' | 'assignedMembershipId' | 'payload'>,
): boolean {
  if (event.type.startsWith('channel.')) return access.channelsRead;
  if (!event.conversationId) return true;
  if (access.readAll) return true;
  if (!access.readAssigned) return false;
  if (event.assignedMembershipId === null || event.assignedMembershipId === access.membershipId) {
    return true;
  }
  // A member who just lost a conversation is told so their list updates.
  return event.type === 'conversation.assigned' && event.payload.previous === access.membershipId;
}

export function encodeEventCursor(txid: string, id: string): string {
  return Buffer.from(`${txid}.${id}`).toString('base64url');
}

export function decodeEventCursor(cursor: string): { txid: string; id: string } {
  const [txid, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('.');
  if (!txid || !id || !/^\d{1,20}$/.test(txid) || !/^\d{1,20}$/.test(id)) {
    throw new AppError('validation_failed', 'Invalid event cursor.');
  }
  return { txid, id };
}

/** A cursor positioned "now": only events from transactions not yet finished will follow. */
export async function currentEventCursor(db: Database, scope: TenantScope): Promise<string> {
  return db.run(
    scope,
    async (tx) => {
      const res = await tx.execute<{ xmin: string }>(
        sql`select pg_snapshot_xmin(pg_current_snapshot())::text as xmin`,
      );
      return encodeEventCursor(res.rows[0]?.xmin ?? '0', '0');
    },
    { accessMode: 'read only' },
  );
}

export async function readTenantEvents(
  db: Database,
  scope: TenantScope,
  cursor: string,
  limit = 200,
): Promise<{ events: TenantEventRow[]; cursor: string }> {
  const from = decodeEventCursor(cursor);
  const bounded = Math.min(Math.max(limit, 1), 500);
  return db.run(
    scope,
    async (tx) => {
      const res = await tx.execute<{
        id: string;
        txid: string;
        type: string;
        conversation_id: string | null;
        assigned_membership_id: string | null;
        payload: Record<string, unknown>;
        created_at: Date;
      }>(sql`
        select id::text, txid::text, type, conversation_id, assigned_membership_id, payload, created_at
          from app.tenant_events
         where tenant_id = ${scope.tenantId}::uuid
           and (txid, id) > (${from.txid}::xid8, ${from.id}::bigint)
           and txid < pg_snapshot_xmin(pg_current_snapshot())
         order by txid, id
         limit ${bounded}`);
      const events = res.rows.map((r) => ({
        cursor: encodeEventCursor(r.txid, r.id),
        type: r.type,
        conversationId: r.conversation_id,
        assignedMembershipId: r.assigned_membership_id,
        payload: r.payload,
        createdAt: new Date(r.created_at).toISOString(),
      }));
      const last = events[events.length - 1];
      return { events, cursor: last ? last.cursor : cursor };
    },
    { accessMode: 'read only' },
  );
}
