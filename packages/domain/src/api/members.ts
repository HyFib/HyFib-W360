import { z } from 'zod';
import { notFound } from '@w360/core';
import {
  and,
  asc,
  eq,
  exactTimestamp,
  memberAvailability,
  memberships,
  sql,
  teams,
  users,
  type TeamAssignmentMode,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { INBOX_WORKER_ROLES, routeWaitingConversations } from '../inbox/routing';
import { writeMemberAvailability } from '../inbox/teams';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiActor, assertAnyScope, assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * The members and teams conversations can be given to (ADR-093), read with `conversations.read`: the
 * ids PATCH /conversations/{id} takes and the names to show them by. Members are the active ones
 * whose role reads and answers conversations, the members teams and routing take; nothing else about
 * them (no email or role) is given. Both lists are paged oldest first. With `availability.write` a key
 * sets whether a member takes conversations (ADR-289).
 */

const page = {
  limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
  cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
};

export const apiMemberListQuerySchema = z.object(page).strict();
export const apiTeamListQuerySchema = z.object(page).strict();

export interface ApiMember {
  id: string;
  name: string;
  /** Whether the member takes conversations routing gives out now. */
  available: boolean;
  /** The teams the member belongs to, oldest membership first. */
  teamIds: string[];
}

export interface ApiTeam {
  id: string;
  name: string;
  /** `round_robin`: the team gives conversations without a member to its available members in turn. */
  assignment: TeamAssignmentMode;
}

export async function apiListMembers(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiMember[]; nextCursor: string | null }> {
  assertScope(ctx, 'conversations.read');
  const q = parseInput(apiMemberListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select({
          id: memberships.id,
          name: users.name,
          available: sql<boolean>`coalesce(${memberAvailability.available}, false)`,
          teamIds: sql<string[]>`coalesce((
            select array_agg(tm.team_id order by tm.created_at, tm.id) from app.team_members tm
             where tm.tenant_id = ${memberships.tenantId} and tm.membership_id = ${memberships.id}
          ), '{}')`,
          cursorAt: exactTimestamp(memberships.createdAt),
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .leftJoin(
          memberAvailability,
          and(
            eq(memberAvailability.tenantId, memberships.tenantId),
            eq(memberAvailability.membershipId, memberships.id),
          ),
        )
        .where(
          and(
            eq(memberships.tenantId, ctx.tenant.id),
            eq(memberships.status, 'active'),
            sql`${memberships.roles} && ${sql.param([...INBOX_WORKER_ROLES])}::text[]`,
            cursor
              ? sql`(${memberships.createdAt}, ${memberships.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(memberships.createdAt), asc(memberships.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map((r) => ({
          id: r.id,
          name: r.name,
          available: r.available,
          teamIds: r.teamIds,
        })),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

export async function apiListTeams(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiTeam[]; nextCursor: string | null }> {
  // Keys that manage teams (ADR-287) list them too.
  assertAnyScope(ctx, ['conversations.read', 'teams.manage']);
  const q = parseInput(apiTeamListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select({
          id: teams.id,
          name: teams.name,
          assignment: teams.assignment,
          cursorAt: exactTimestamp(teams.createdAt),
        })
        .from(teams)
        .where(
          and(
            eq(teams.tenantId, ctx.tenant.id),
            cursor
              ? sql`(${teams.createdAt}, ${teams.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(teams.createdAt), asc(teams.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map((r) => ({ id: r.id, name: r.name, assignment: r.assignment })),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** What `PATCH /members/{id}` takes (ADR-289): whether the member takes conversations. */
export const apiUpdateMemberSchema = z
  .object({
    available: z
      .boolean()
      .describe(
        '`true`: routing gives the member conversations of their round-robin teams; `false`: it gives them none. Their conversations stay with them either way.',
      ),
  })
  .strict();

/** A member's availability, as `PATCH /members/{id}` answers it. */
export interface ApiMemberAvailability {
  id: string;
  available: boolean;
  /** When the member's availability last changed; null when it was never set. */
  changedAt: string | null;
}

/**
 * Sets whether a member takes the conversations routing gives out, as members who assign
 * conversations do in Settings → Teams, through the same write, audited as the key; making a
 * member available routes waiting conversations again. A member already so is answered as they are,
 * with no audit entry, so a retry needs no `Idempotency-Key`.
 */
export async function apiUpdateMember(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  id: string,
  input: unknown,
): Promise<ApiMemberAvailability> {
  assertScope(ctx, 'availability.write');
  if (!z.uuid().safeParse(id).success) throw notFound('Member');
  const data = parseInput(apiUpdateMemberSchema, input);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    const result = await writeMemberAvailability(tx, ctx.tenant.id, id, data.available, now, {
      keepUnchanged: true,
    });
    if (result.changed) {
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'member.availability_changed',
          subjectType: 'membership',
          subjectId: id,
          correlationId: ctx.requestId,
          metadata: { available: data.available, source: 'api' },
        },
        apiActor(ctx),
      );
      // As Settings does when a member becomes available.
      if (data.available) await routeWaitingConversations(tx, ctx.tenant.id, 20);
    }
    return {
      id,
      available: data.available,
      changedAt: result.changedAt ? result.changedAt.toISOString() : null,
    };
  });
}
