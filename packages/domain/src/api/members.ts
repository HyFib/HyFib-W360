import { z } from 'zod';
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
import { INBOX_WORKER_ROLES } from '../inbox/routing';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { assertAnyScope, assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * The members and teams conversations can be given to (ADR-093), read with `conversations.read`: the
 * ids PATCH /conversations/{id} takes and the names to show them by. Members are the active ones
 * whose role reads and answers conversations, the members teams and routing take; nothing else about
 * them (no email or role) is given. Both lists are paged oldest first.
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
