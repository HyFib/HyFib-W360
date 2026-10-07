import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  TEAM_ASSIGNMENT_MODES,
  and,
  asc,
  channelAccounts,
  conversations,
  eq,
  inArray,
  isUniqueViolation,
  memberAvailability,
  memberships,
  notInArray,
  or,
  sql,
  teamMembers,
  teams,
  users,
  type Database,
  type SQL,
  type TeamAssignmentMode,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { emitTenantEvent } from '../messaging/events';
import { parseInput } from '../validation';
import { INBOX_WORKER_ROLES, normalizeRoutingText, routeWaitingConversations } from './routing';
import { assertTeamAvailable } from '../plans/entitlements';

/**
 * Teams (routing groups), their members and numbers, and member availability. Managing teams needs
 * `inbox.supervise`; any member with inbox access can read team names for inbox filters. A member
 * sets their own availability with `inbox.reply`; `inbox.assign` may set anyone's.
 */
export const MAX_ROUTING_KEYWORDS = 20;
const MAX_KEYWORD_LENGTH = 40;

const optionalNumber = (max: number, message: string) =>
  z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.coerce.number().int(message).min(1, message).max(max, message).nullable(),
  );

const keywordsSchema = z
  .preprocess(
    (v) => (typeof v === 'string' ? v.split(/[,\n]/) : (v ?? [])),
    z.array(z.string().max(200, 'Keep each keyword under 40 characters.')),
  )
  .transform((raw, ctx) => {
    const seen = new Set<string>();
    for (const item of raw) {
      const keyword = normalizeRoutingText(item);
      if (!keyword) continue;
      if (keyword.length > MAX_KEYWORD_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          message: `Keep each keyword under ${MAX_KEYWORD_LENGTH} characters.`,
        });
        return z.NEVER;
      }
      seen.add(keyword);
    }
    if (seen.size > MAX_ROUTING_KEYWORDS) {
      ctx.addIssue({ code: 'custom', message: `Use at most ${MAX_ROUTING_KEYWORDS} keywords.` });
      return z.NEVER;
    }
    return [...seen];
  });

export const teamSchema = z.object({
  name: z.string().trim().min(1, 'Enter a team name.').max(80, 'Use at most 80 characters.'),
  description: z
    .string()
    .trim()
    .max(300, 'Use at most 300 characters.')
    .optional()
    .transform((v) => v || null),
  assignment: z.enum(TEAM_ASSIGNMENT_MODES).default('manual'),
  maxOpenPerMember: optionalNumber(500, 'Enter a limit from 1 to 500, or leave it empty.').default(
    null,
  ),
  routingKeywords: keywordsSchema.default([]),
  memberIds: z.array(z.uuid()).max(200).default([]),
  channelIds: z.array(z.uuid()).max(50).default([]),
});
export type TeamInput = z.input<typeof teamSchema>;

export const availabilitySchema = z.object({
  membershipId: z.uuid().optional(),
  available: z.boolean(),
});

export interface TeamView {
  id: string;
  name: string;
  description: string | null;
  assignment: TeamAssignmentMode;
  maxOpenPerMember: number | null;
  routingKeywords: string[];
  members: { membershipId: string; name: string; available: boolean }[];
  channelIds: string[];
  openConversations: number;
  unassignedConversations: number;
}

/** A team's settings, members and numbers, as Settings and the API give them (ADR-287). */
export type TeamSettings = z.output<typeof teamSchema>;

/** A team name another team of the company has, as a conflict; any other error as it is. */
export function teamNameError(error: unknown): unknown {
  return isUniqueViolation(error, 'teams_name_uq')
    ? new AppError('conflict', 'Another team already has this name. Choose a different name.')
    : error;
}

/**
 * The members a team has and routing gives conversations to: active, with a role that can read and
 * answer conversations. A member suspended or given another role stays in `team_members` but is no
 * team's member until they can answer conversations again; saving the team keeps their place
 * (`droppedTeamMembers`).
 */
const answersConversations = () =>
  and(
    eq(memberships.status, 'active'),
    sql`${memberships.roles} && ${sql.param([...INBOX_WORKER_ROLES])}::text[]`,
  );

/** Members who may join a team: those who answer conversations. */
async function checkMembers(tx: Tx, tenantId: string, memberIds: string[]) {
  if (memberIds.length === 0) return;
  const rows = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        inArray(memberships.id, memberIds),
        answersConversations(),
      ),
    );
  if (rows.length !== new Set(memberIds).size) {
    const message = 'Choose active members whose role can reply in the inbox.';
    throw new AppError('validation_failed', message, { issues: [{ path: 'memberIds', message }] });
  }
}

async function checkChannels(tx: Tx, tenantId: string, channelIds: string[]) {
  if (channelIds.length === 0) return;
  const rows = await tx
    .select({ id: channelAccounts.id })
    .from(channelAccounts)
    .where(and(eq(channelAccounts.tenantId, tenantId), inArray(channelAccounts.id, channelIds)));
  if (rows.length !== new Set(channelIds).size) {
    const message = 'Choose WhatsApp numbers of this company.';
    throw new AppError('validation_failed', message, { issues: [{ path: 'channelIds', message }] });
  }
}

/**
 * The places in a team that saving it with the members `memberIds` takes away: those of members who
 * answer conversations and are not among them, and those of removed members. Members who cannot
 * answer conversations now (suspended, or given another role) are neither shown nor chosen, in
 * Settings or through the API, so they keep their place and are the team's again when they can.
 */
export function droppedTeamMembers(
  tenantId: string,
  teamId: string,
  memberIds: readonly string[],
): SQL | undefined {
  const gone = and(
    eq(memberships.tenantId, teamMembers.tenantId),
    eq(memberships.id, teamMembers.membershipId),
    or(answersConversations(), eq(memberships.status, 'removed')),
  );
  return and(
    eq(teamMembers.tenantId, tenantId),
    eq(teamMembers.teamId, teamId),
    memberIds.length ? notInArray(teamMembers.membershipId, [...memberIds]) : undefined,
    sql`exists (select 1 from ${memberships} where ${gone})`,
  );
}

async function syncMembersAndChannels(
  tx: Tx,
  tenantId: string,
  teamId: string,
  data: { memberIds: string[]; channelIds: string[] },
) {
  const memberIds = [...new Set(data.memberIds)];
  const channelIds = [...new Set(data.channelIds)];
  await tx.delete(teamMembers).where(droppedTeamMembers(tenantId, teamId, memberIds));
  if (memberIds.length) {
    await tx
      .insert(teamMembers)
      .values(memberIds.map((membershipId) => ({ id: uuidv7(), tenantId, teamId, membershipId })))
      .onConflictDoNothing();
  }
  await tx
    .update(channelAccounts)
    .set({ defaultTeamId: null })
    .where(
      and(
        eq(channelAccounts.tenantId, tenantId),
        eq(channelAccounts.defaultTeamId, teamId),
        ...(channelIds.length ? [notInArray(channelAccounts.id, channelIds)] : []),
      ),
    );
  if (channelIds.length) {
    await tx
      .update(channelAccounts)
      .set({ defaultTeamId: teamId })
      .where(and(eq(channelAccounts.tenantId, tenantId), inArray(channelAccounts.id, channelIds)));
  }
}

/**
 * Adds a team with its members and numbers within the plan's limit (Settings, and keys since
 * ADR-287). The caller audits it, then routes waiting conversations, and maps a name in use with
 * `teamNameError`.
 */
export async function writeCreateTeam(
  tx: Tx,
  tenantId: string,
  data: TeamSettings,
): Promise<{ teamId: string }> {
  const teamId = uuidv7();
  await assertTeamAvailable(tx, tenantId);
  await checkMembers(tx, tenantId, data.memberIds);
  await checkChannels(tx, tenantId, data.channelIds);
  await tx.insert(teams).values({
    id: teamId,
    tenantId,
    name: data.name,
    description: data.description,
    assignment: data.assignment,
    maxOpenPerMember: data.maxOpenPerMember,
    routingKeywords: data.routingKeywords,
  });
  await syncMembersAndChannels(tx, tenantId, teamId, data);
  return { teamId };
}

/**
 * Sets a team's settings, members and numbers, its row locked (Settings, and keys since ADR-287).
 * The caller audits it, then routes waiting conversations, and maps a name in use with
 * `teamNameError`.
 */
export async function writeUpdateTeam(
  tx: Tx,
  tenantId: string,
  teamId: string,
  data: TeamSettings,
): Promise<{ previousAssignment: TeamAssignmentMode }> {
  const [current] = await tx
    .select({ id: teams.id, assignment: teams.assignment })
    .from(teams)
    .where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId)))
    .for('update');
  if (!current) throw notFound('Team');
  await checkMembers(tx, tenantId, data.memberIds);
  await checkChannels(tx, tenantId, data.channelIds);
  await tx
    .update(teams)
    .set({
      name: data.name,
      description: data.description,
      assignment: data.assignment,
      maxOpenPerMember: data.maxOpenPerMember,
      routingKeywords: data.routingKeywords,
    })
    .where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId)));
  await syncMembersAndChannels(tx, tenantId, teamId, data);
  return { previousAssignment: current.assignment };
}

/**
 * Deletes a team (Settings, and keys since ADR-287): its conversations leave the team first, their
 * assignees kept, in routing's lock order (conversation, team). Null when the company has no such
 * team. The caller audits it.
 */
export async function writeDeleteTeam(
  tx: Tx,
  tenantId: string,
  teamId: string,
): Promise<{ name: string; conversations: number } | null> {
  // Conversations first, then the team: the same lock order as routing (conversation, team).
  const moved = await tx
    .update(conversations)
    .set({ teamId: null })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.teamId, teamId)))
    .returning({ id: conversations.id });
  const [deleted] = await tx
    .delete(teams)
    .where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId)))
    .returning({ name: teams.name });
  return deleted ? { name: deleted.name, conversations: moved.length } : null;
}

/**
 * One team's settings with its members (those who answer conversations) and its numbers by id
 * (ADR-287), or null; with `lock`, its row is locked for update first, so a change read from it is
 * not lost.
 */
export async function readTeamSettings(
  tx: Tx,
  tenantId: string,
  teamId: string,
  options: { lock?: boolean } = {},
): Promise<(TeamSettings & { id: string; createdAt: Date; updatedAt: Date }) | null> {
  const query = tx
    .select({
      id: teams.id,
      name: teams.name,
      description: teams.description,
      assignment: teams.assignment,
      maxOpenPerMember: teams.maxOpenPerMember,
      routingKeywords: teams.routingKeywords,
      createdAt: teams.createdAt,
      updatedAt: teams.updatedAt,
    })
    .from(teams)
    .where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId)));
  const [team] = options.lock ? await query.for('update') : await query;
  if (!team) return null;
  const members = await tx
    .select({ membershipId: teamMembers.membershipId })
    .from(teamMembers)
    .innerJoin(
      memberships,
      and(
        eq(memberships.tenantId, teamMembers.tenantId),
        eq(memberships.id, teamMembers.membershipId),
      ),
    )
    .where(
      and(
        eq(teamMembers.tenantId, tenantId),
        eq(teamMembers.teamId, teamId),
        answersConversations(),
      ),
    )
    .orderBy(asc(teamMembers.createdAt), asc(teamMembers.membershipId));
  const channels = await tx
    .select({ id: channelAccounts.id })
    .from(channelAccounts)
    .where(and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.defaultTeamId, teamId)))
    .orderBy(asc(channelAccounts.id));
  return {
    ...team,
    memberIds: members.map((m) => m.membershipId),
    channelIds: channels.map((c) => c.id),
  };
}

/**
 * Sets whether a member takes the conversations routing gives out (Settings and the inbox, and keys
 * since ADR-289). The member's row is locked for share, so a suspension or a change of role at the
 * same time either waits and then marks them unavailable again, or comes first and is seen here:
 * only a member who can answer conversations is made available. With `keepUnchanged`, a member
 * already so is left as they are (`changed` false). The caller audits the change, then routes
 * waiting conversations when it made the member available.
 */
export async function writeMemberAvailability(
  tx: Tx,
  tenantId: string,
  membershipId: string,
  available: boolean,
  now: Date,
  options: { keepUnchanged?: boolean } = {},
): Promise<{ changed: boolean; changedAt: Date | null }> {
  const [target] = await tx
    .select({ status: memberships.status, roles: memberships.roles })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)))
    .for('share');
  if (!target) throw notFound('Member');
  if (
    available &&
    (target.status !== 'active' || !target.roles.some((r) => INBOX_WORKER_ROLES.includes(r)))
  ) {
    throw new AppError(
      'validation_failed',
      'Only active members whose role can reply in the inbox can take conversations.',
    );
  }
  if (options.keepUnchanged) {
    const [current] = await tx
      .select({ available: memberAvailability.available, changedAt: memberAvailability.changedAt })
      .from(memberAvailability)
      .where(
        and(
          eq(memberAvailability.tenantId, tenantId),
          eq(memberAvailability.membershipId, membershipId),
        ),
      )
      .for('update');
    // A member who never set it is unavailable.
    if ((current?.available ?? false) === available) {
      return { changed: false, changedAt: current?.changedAt ?? null };
    }
  }
  await tx
    .insert(memberAvailability)
    .values({ id: uuidv7(), tenantId, membershipId, available, changedAt: now })
    .onConflictDoUpdate({
      target: [memberAvailability.tenantId, memberAvailability.membershipId],
      set: { available, changedAt: now },
    });
  await emitTenantEvent(tx, tenantId, {
    type: 'member.availability',
    payload: { membershipId, available },
  });
  return { changed: true, changedAt: now };
}

export function createTeamsService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;

  return {
    /**
     * Teams with their members (those who answer conversations), numbers and queue sizes (names and
     * ids only; any inbox member).
     */
    async listTeams(ctx: TenantContext): Promise<TeamView[]> {
      assertCan(ctx, 'tenant.read');
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({
              id: teams.id,
              name: teams.name,
              description: teams.description,
              assignment: teams.assignment,
              maxOpenPerMember: teams.maxOpenPerMember,
              routingKeywords: teams.routingKeywords,
            })
            .from(teams)
            .where(eq(teams.tenantId, ctx.tenant.id))
            .orderBy(asc(sql`lower(${teams.name})`), asc(teams.id));
          if (rows.length === 0) return [];
          const ids = rows.map((r) => r.id);
          const members = await tx
            .select({
              teamId: teamMembers.teamId,
              membershipId: teamMembers.membershipId,
              name: users.name,
              available: memberAvailability.available,
            })
            .from(teamMembers)
            .innerJoin(
              memberships,
              and(
                eq(memberships.tenantId, teamMembers.tenantId),
                eq(memberships.id, teamMembers.membershipId),
              ),
            )
            .innerJoin(users, eq(users.id, memberships.userId))
            .leftJoin(
              memberAvailability,
              and(
                eq(memberAvailability.tenantId, teamMembers.tenantId),
                eq(memberAvailability.membershipId, teamMembers.membershipId),
              ),
            )
            .where(
              and(
                eq(teamMembers.tenantId, ctx.tenant.id),
                inArray(teamMembers.teamId, ids),
                answersConversations(),
              ),
            )
            .orderBy(asc(users.name));
          const channels = await tx
            .select({ id: channelAccounts.id, teamId: channelAccounts.defaultTeamId })
            .from(channelAccounts)
            .where(
              and(
                eq(channelAccounts.tenantId, ctx.tenant.id),
                inArray(channelAccounts.defaultTeamId, ids),
              ),
            );
          const counts = await tx
            .select({
              teamId: conversations.teamId,
              open: sql<number>`count(*)::int`,
              unassigned: sql<number>`count(*) filter (where ${conversations.assignedMembershipId} is null)::int`,
            })
            .from(conversations)
            .where(
              and(
                eq(conversations.tenantId, ctx.tenant.id),
                inArray(conversations.teamId, ids),
                sql`${conversations.status} in ('open', 'pending')`,
              ),
            )
            .groupBy(conversations.teamId);
          return rows.map((t) => {
            const count = counts.find((c) => c.teamId === t.id);
            return {
              ...t,
              members: members
                .filter((m) => m.teamId === t.id)
                .map((m) => ({
                  membershipId: m.membershipId,
                  name: m.name,
                  available: m.available === true,
                })),
              channelIds: channels.filter((c) => c.teamId === t.id).map((c) => c.id),
              openConversations: count?.open ?? 0,
              unassignedConversations: count?.unassigned ?? 0,
            };
          });
        },
        { accessMode: 'read only' },
      );
    },

    async createTeam(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ teamId: string; routed: number }> {
      assertCan(ctx, 'inbox.supervise');
      const data = parseInput(teamSchema, input);
      try {
        return await db.run(ctx.scope, async (tx) => {
          const { teamId } = await writeCreateTeam(tx, ctx.tenant.id, data);
          await recordAudit(
            tx,
            ctx,
            {
              action: 'team.created',
              subjectType: 'team',
              subjectId: teamId,
              metadata: {
                assignment: data.assignment,
                maxOpenPerMember: data.maxOpenPerMember,
                members: data.memberIds.length,
                channels: data.channelIds.length,
                keywords: data.routingKeywords.length,
              },
            },
            meta,
          );
          const routed = await routeWaitingConversations(tx, ctx.tenant.id, 50);
          return { teamId, routed };
        });
      } catch (error) {
        throw teamNameError(error);
      }
    },

    async updateTeam(
      ctx: TenantContext,
      teamId: string,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ routed: number }> {
      assertCan(ctx, 'inbox.supervise');
      if (!z.uuid().safeParse(teamId).success) throw notFound('Team');
      const data = parseInput(teamSchema, input);
      try {
        return await db.run(ctx.scope, async (tx) => {
          const { previousAssignment } = await writeUpdateTeam(tx, ctx.tenant.id, teamId, data);
          await recordAudit(
            tx,
            ctx,
            {
              action: 'team.updated',
              subjectType: 'team',
              subjectId: teamId,
              metadata: {
                assignment: { from: previousAssignment, to: data.assignment },
                maxOpenPerMember: data.maxOpenPerMember,
                members: data.memberIds.length,
                channels: data.channelIds.length,
                keywords: data.routingKeywords.length,
              },
            },
            meta,
          );
          const routed = await routeWaitingConversations(tx, ctx.tenant.id, 50);
          return { routed };
        });
      } catch (error) {
        throw teamNameError(error);
      }
    },

    /** Deletes a team: its conversations leave the team (assignees are kept). */
    async deleteTeam(ctx: TenantContext, teamId: string, meta: RequestMeta = {}): Promise<void> {
      assertCan(ctx, 'inbox.supervise');
      if (!z.uuid().safeParse(teamId).success) throw notFound('Team');
      await db.run(ctx.scope, async (tx) => {
        const deleted = await writeDeleteTeam(tx, ctx.tenant.id, teamId);
        if (!deleted) throw notFound('Team');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'team.deleted',
            subjectType: 'team',
            subjectId: teamId,
            metadata: { conversations: deleted.conversations },
          },
          meta,
        );
      });
    },

    /** Whether the current member takes new conversations automatically. */
    async getAvailability(ctx: TenantContext): Promise<boolean> {
      const [row] = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ available: memberAvailability.available })
            .from(memberAvailability)
            .where(
              and(
                eq(memberAvailability.tenantId, ctx.tenant.id),
                eq(memberAvailability.membershipId, ctx.membership.id),
              ),
            ),
        { accessMode: 'read only' },
      );
      return row?.available === true;
    },

    /**
     * Sets a member's availability (their own with `inbox.reply`, anyone's with `inbox.assign`).
     * Becoming available routes waiting conversations of round-robin teams straight away.
     */
    async setAvailability(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ routed: number }> {
      const data = parseInput(availabilitySchema, input);
      const membershipId = data.membershipId ?? ctx.membership.id;
      const self = membershipId === ctx.membership.id;
      assertCan(ctx, self ? 'inbox.reply' : 'inbox.assign');
      return db.run(ctx.scope, async (tx) => {
        await writeMemberAvailability(tx, ctx.tenant.id, membershipId, data.available, clock.now());
        if (!self) {
          await recordAudit(
            tx,
            ctx,
            {
              action: 'member.availability_changed',
              subjectType: 'membership',
              subjectId: membershipId,
              metadata: { available: data.available },
            },
            meta,
          );
        }
        const routed = data.available ? await routeWaitingConversations(tx, ctx.tenant.id, 20) : 0;
        return { routed };
      });
    },

    /** Company numbers for team and inbox pickers (ids, labels and status only). */
    async channelOptions(
      ctx: TenantContext,
    ): Promise<{ id: string; label: string; status: string }[]> {
      assertCan(ctx, 'channels.read');
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: channelAccounts.id,
              displayPhoneNumber: channelAccounts.displayPhoneNumber,
              verifiedName: channelAccounts.verifiedName,
              status: channelAccounts.status,
            })
            .from(channelAccounts)
            .where(eq(channelAccounts.tenantId, ctx.tenant.id))
            .orderBy(asc(channelAccounts.createdAt)),
        { accessMode: 'read only' },
      );
      return rows.map((r) => ({
        id: r.id,
        label:
          [r.displayPhoneNumber, r.verifiedName].filter(Boolean).join(' · ') || 'WhatsApp number',
        status: r.status,
      }));
    },

    /** Active members who can join teams (their role can read and answer conversations). */
    async teamMemberOptions(
      ctx: TenantContext,
    ): Promise<{ membershipId: string; name: string; available: boolean }[]> {
      assertCan(ctx, 'members.read');
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              membershipId: memberships.id,
              name: users.name,
              available: memberAvailability.available,
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
              ),
            )
            .orderBy(asc(users.name)),
        { accessMode: 'read only' },
      );
      return rows.map((r) => ({ ...r, available: r.available === true }));
    },

    /** Team names for inbox filters and pickers. */
    async teamOptions(ctx: TenantContext): Promise<{ id: string; name: string }[]> {
      if (!can(ctx, 'inbox.read_all') && !can(ctx, 'inbox.read_assigned'))
        assertCan(ctx, 'inbox.read_assigned');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ id: teams.id, name: teams.name })
            .from(teams)
            .where(eq(teams.tenantId, ctx.tenant.id))
            .orderBy(asc(sql`lower(${teams.name})`), asc(teams.id)),
        { accessMode: 'read only' },
      );
    },
  };
}

export type TeamsService = ReturnType<typeof createTeamsService>;
