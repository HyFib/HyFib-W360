import {
  and,
  asc,
  authorizedTenantScope,
  automationRuns,
  channelAccounts,
  conversations,
  eq,
  inArray,
  isNull,
  memberAvailability,
  memberships,
  sql,
  systemScope,
  teams,
  type Database,
  type TenantRole,
  type Tx,
} from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { recordSystemAudit } from '../audit';
import { emitTenantEvent } from '../messaging/events';
import { matchesKeyword } from './keywords';

/**
 * Conversation routing. A conversation starting a new case (created, or reopened after a resolve)
 * is placed in a team: the first team (by name) with a routing keyword in the customer's message,
 * otherwise the team its WhatsApp number starts conversations in. When that team assigns round
 * robin, the next available member below the team's limit of open conversations receives it.
 *
 * All routing in a company runs under one transaction-scoped advisory lock, so two routers can never
 * hand out the same turn or push a member past the limit. Assignments made by people are never
 * changed here, and a conversation that already has an assignee is left alone (a reopened
 * conversation stays with its previous assignee).
 */

/** Roles that can read and answer conversations, i.e. can receive routed conversations. */
export const INBOX_WORKER_ROLES: readonly TenantRole[] = (
  Object.keys(ROLE_PERMISSIONS) as TenantRole[]
).filter((role) => {
  const p = ROLE_PERMISSIONS[role];
  return p.has('inbox.reply') && (p.has('inbox.read_assigned') || p.has('inbox.read_all'));
});

export { matchesKeyword, normalizeRoutingText } from './keywords';

/**
 * Whether a member can be given conversations: active, with a role that reads and answers them (the
 * members teams take). The row is locked for share until the caller commits, so a change to the
 * member's status or roles made at the same time either waits and then releases what the caller
 * assigned (releaseMemberConversations), or comes first and is seen here.
 */
export async function lockAssignableMember(
  tx: Tx,
  tenantId: string,
  membershipId: string,
): Promise<boolean> {
  const [member] = await tx
    .select({ status: memberships.status, roles: memberships.roles })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)))
    .for('share');
  return (
    member?.status === 'active' && member.roles.some((role) => INBOX_WORKER_ROLES.includes(role))
  );
}

/** Whether the team is the company's; its row is kept from deletion until the caller commits. */
export async function lockTeam(tx: Tx, tenantId: string, teamId: string): Promise<boolean> {
  const [team] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId)))
    .for('key share');
  return team !== undefined;
}

/**
 * The next member in a team's rotation: the first eligible member after `last` in team order
 * (wrapping around), or the first eligible member when `last` is unknown.
 */
export function nextInRotation(
  teamOrder: readonly string[],
  eligible: ReadonlySet<string>,
  last: string | null,
): string | null {
  if (teamOrder.length === 0) return null;
  const start = last ? teamOrder.indexOf(last) + 1 : 0;
  for (let i = 0; i < teamOrder.length; i += 1) {
    const candidate = teamOrder[(start + i) % teamOrder.length] as string;
    if (eligible.has(candidate)) return candidate;
  }
  return null;
}

async function lockRouting(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`w360:inbox-route:${tenantId}`}, 0))`,
  );
}

/** Members of the team in rotation order, with whether each can take a conversation now. */
async function rotationCandidates(
  tx: Tx,
  tenantId: string,
  team: { id: string; maxOpenPerMember: number | null },
): Promise<{ order: string[]; eligible: Set<string> }> {
  const res = await tx.execute<{ membership_id: string; eligible: boolean }>(sql`
    select tm.membership_id,
           (m.status = 'active'
            and m.roles && ${sql.param([...INBOX_WORKER_ROLES])}::text[]
            and coalesce(a.available, false)
            and (${team.maxOpenPerMember}::int is null
                 or (select count(*) from app.conversations c
                      where c.tenant_id = tm.tenant_id and c.assigned_membership_id = tm.membership_id
                        and c.status in ('open', 'pending')) < ${team.maxOpenPerMember}::int)) as eligible
      from app.team_members tm
      join app.memberships m on m.tenant_id = tm.tenant_id and m.id = tm.membership_id
      left join app.member_availability a
        on a.tenant_id = tm.tenant_id and a.membership_id = tm.membership_id
     where tm.tenant_id = ${tenantId}::uuid and tm.team_id = ${team.id}::uuid
     order by tm.created_at, tm.id`);
  return {
    order: res.rows.map((r) => r.membership_id),
    eligible: new Set(res.rows.filter((r) => r.eligible).map((r) => r.membership_id)),
  };
}

export interface RouteOptions {
  /** The conversation starts a new case (created or reopened): keyword routing applies. */
  newCase: boolean;
  /** Text of the customer's message that started the case, for keyword routing. */
  text: string | null;
}

export interface RouteOutcome {
  teamId: string | null;
  assignedMembershipId: string | null;
  rule: 'keyword' | 'number' | null;
  changed: boolean;
}

/**
 * Routes one conversation inside the caller's company-scoped transaction. Safe to call repeatedly:
 * a resolved or assigned conversation is returned unchanged.
 */
export async function routeConversation(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  options: RouteOptions,
): Promise<RouteOutcome> {
  await lockRouting(tx, tenantId);
  const [conv] = await tx
    .select({
      id: conversations.id,
      status: conversations.status,
      assignedMembershipId: conversations.assignedMembershipId,
      teamId: conversations.teamId,
      channelAccountId: conversations.channelAccountId,
    })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
    .for('update');
  const unchanged = (rule: RouteOutcome['rule'] = null): RouteOutcome => ({
    teamId: conv?.teamId ?? null,
    assignedMembershipId: conv?.assignedMembershipId ?? null,
    rule,
    changed: false,
  });
  if (!conv || conv.status === 'resolved' || conv.assignedMembershipId) return unchanged();
  // An automation handling the conversation owns it until it ends or a person takes over; the run's
  // end routes it (automations/runs endRun).
  const [bot] = await tx
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.tenantId, tenantId),
        eq(automationRuns.conversationId, conv.id),
        inArray(automationRuns.status, ['running', 'waiting']),
      ),
    )
    .limit(1);
  if (bot) return unchanged();

  let teamId = conv.teamId;
  let rule: RouteOutcome['rule'] = null;
  if (options.newCase && options.text) {
    const text = options.text;
    const keyworded = await tx
      .select({ id: teams.id, keywords: teams.routingKeywords })
      .from(teams)
      .where(and(eq(teams.tenantId, tenantId), sql`cardinality(${teams.routingKeywords}) > 0`))
      .orderBy(asc(sql`lower(${teams.name})`), asc(teams.id));
    const hit = keyworded.find((t) => t.keywords.some((k) => matchesKeyword(text, k)));
    if (hit) {
      teamId = hit.id;
      rule = 'keyword';
    }
  }
  if (!teamId) {
    const [channel] = await tx
      .select({ defaultTeamId: channelAccounts.defaultTeamId })
      .from(channelAccounts)
      .where(
        and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.id, conv.channelAccountId)),
      );
    if (channel?.defaultTeamId) {
      teamId = channel.defaultTeamId;
      rule = 'number';
    }
  }

  let assignee: string | null = null;
  if (teamId) {
    const [team] = await tx
      .select({
        id: teams.id,
        assignment: teams.assignment,
        maxOpenPerMember: teams.maxOpenPerMember,
        lastAssignedMembershipId: teams.lastAssignedMembershipId,
      })
      .from(teams)
      .where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId)));
    if (!team) {
      teamId = conv.teamId;
      rule = null;
    } else if (team.assignment === 'round_robin') {
      const { order, eligible } = await rotationCandidates(tx, tenantId, team);
      assignee = nextInRotation(order, eligible, team.lastAssignedMembershipId);
    }
  }

  const teamChanged = teamId !== conv.teamId;
  if (!teamChanged && !assignee) return unchanged(rule);
  await tx
    .update(conversations)
    .set({
      ...(teamChanged ? { teamId } : {}),
      ...(assignee ? { assignedMembershipId: assignee } : {}),
      version: sql`${conversations.version} + 1`,
    })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conv.id)));
  if (assignee && teamId) {
    await tx
      .update(teams)
      .set({ lastAssignedMembershipId: assignee })
      .where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId)));
  }
  await emitTenantEvent(
    tx,
    tenantId,
    assignee
      ? {
          type: 'conversation.assigned',
          conversationId: conv.id,
          assignedMembershipId: assignee,
          payload: { previous: null, teamId },
        }
      : {
          type: 'conversation.team',
          conversationId: conv.id,
          assignedMembershipId: null,
          payload: { teamId },
        },
  );
  await recordSystemAudit(tx, tenantId, {
    action: 'conversation.routed',
    subjectType: 'conversation',
    subjectId: conv.id,
    metadata: { teamId, rule, assignedMembershipId: assignee },
  });
  return { teamId, assignedMembershipId: assignee, rule, changed: true };
}

/**
 * Routes up to `limit` unassigned open conversations of round-robin teams in one company, oldest
 * customer message first (after a member becomes available, and from the minute sweep).
 */
export async function routeWaitingConversations(
  tx: Tx,
  tenantId: string,
  limit: number,
): Promise<number> {
  const waiting = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(
      teams,
      and(
        eq(teams.tenantId, conversations.tenantId),
        eq(teams.id, conversations.teamId),
        eq(teams.assignment, 'round_robin'),
      ),
    )
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        sql`${conversations.status} in ('open', 'pending')`,
        isNull(conversations.assignedMembershipId),
        sql`not exists (select 1 from app.automation_runs r
                         where r.tenant_id = ${conversations.tenantId} and r.conversation_id = ${conversations.id}
                           and r.status in ('running', 'waiting'))`,
      ),
    )
    .orderBy(sql`${conversations.lastInboundAt} asc nulls last`, asc(conversations.id))
    .limit(limit);
  let assigned = 0;
  for (const row of waiting) {
    const outcome = await routeConversation(tx, tenantId, row.id, { newCase: false, text: null });
    if (outcome.assignedMembershipId && outcome.changed) assigned += 1;
  }
  return assigned;
}

/**
 * Returns a member's conversations to their team queues and marks them unavailable, when they are
 * suspended, removed, leave, or lose inbox access. Conversations of every status are released, so
 * a later reopening routes afresh instead of returning to someone who can no longer answer.
 */
export async function releaseMemberConversations(
  tx: Tx,
  tenantId: string,
  membershipId: string,
): Promise<number> {
  const released = await tx
    .update(conversations)
    .set({ assignedMembershipId: null, version: sql`${conversations.version} + 1` })
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.assignedMembershipId, membershipId),
      ),
    )
    .returning({ id: conversations.id, status: conversations.status });
  for (const row of released) {
    await emitTenantEvent(tx, tenantId, {
      type: 'conversation.assigned',
      conversationId: row.id,
      assignedMembershipId: null,
      payload: { previous: membershipId },
    });
  }
  await tx
    .update(memberAvailability)
    .set({ available: false, changedAt: sql`now()` })
    .where(
      and(
        eq(memberAvailability.tenantId, tenantId),
        eq(memberAvailability.membershipId, membershipId),
      ),
    );
  if (released.length > 0) {
    await recordSystemAudit(tx, tenantId, {
      action: 'member.conversations_released',
      subjectType: 'membership',
      subjectId: membershipId,
      metadata: {
        conversations: released.length,
        open: released.filter((r) => r.status !== 'resolved').length,
      },
    });
  }
  return released.length;
}

/**
 * Minute sweep: routes unassigned conversations of round-robin teams that have an available member
 * (after a member came back, a conversation was released, or a limit freed up). Company ids come
 * from the database (SECURITY DEFINER sweep query), never from a payload; each conversation is
 * routed in its own company-scoped transaction.
 */
export async function routeDueConversations(db: Database, limit = 200): Promise<number> {
  const due = await db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; conversation_id: string }>(
        sql`select tenant_id, conversation_id from ops.conversations_to_route(${limit})`,
      );
      return res.rows;
    },
    { accessMode: 'read only' },
  );
  let assigned = 0;
  for (const row of due) {
    const outcome = await db.run(authorizedTenantScope(row.tenant_id, null), (tx) =>
      routeConversation(tx, row.tenant_id, row.conversation_id, { newCase: false, text: null }),
    );
    if (outcome.changed && outcome.assignedMembershipId) assigned += 1;
  }
  return assigned;
}
