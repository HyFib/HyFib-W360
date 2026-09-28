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
  sql,
  teamMembers,
  teams,
  users,
  type Database,
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

export function createTeamsService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;

  /** Members who may join a team: active, with a role that can read and answer conversations. */
  async function checkMembers(tx: Tx, tenantId: string, memberIds: string[]) {
    if (memberIds.length === 0) return;
    const rows = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          inArray(memberships.id, memberIds),
          eq(memberships.status, 'active'),
          sql`${memberships.roles} && ${sql.param([...INBOX_WORKER_ROLES])}::text[]`,
        ),
      );
    if (rows.length !== new Set(memberIds).size) {
      throw new AppError(
        'validation_failed',
        'Choose active members whose role can reply in the inbox.',
      );
    }
  }

  async function checkChannels(tx: Tx, tenantId: string, channelIds: string[]) {
    if (channelIds.length === 0) return;
    const rows = await tx
      .select({ id: channelAccounts.id })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.tenantId, tenantId), inArray(channelAccounts.id, channelIds)));
    if (rows.length !== new Set(channelIds).size) {
      throw new AppError('validation_failed', 'Choose WhatsApp numbers of this company.');
    }
  }

  async function syncMembersAndChannels(
    tx: Tx,
    tenantId: string,
    teamId: string,
    data: { memberIds: string[]; channelIds: string[] },
  ) {
    const memberIds = [...new Set(data.memberIds)];
    const channelIds = [...new Set(data.channelIds)];
    await tx
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.tenantId, tenantId),
          eq(teamMembers.teamId, teamId),
          ...(memberIds.length ? [notInArray(teamMembers.membershipId, memberIds)] : []),
        ),
      );
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
        .where(
          and(eq(channelAccounts.tenantId, tenantId), inArray(channelAccounts.id, channelIds)),
        );
    }
  }

  const duplicateName = () =>
    new AppError('conflict', 'Another team already has this name. Choose a different name.');

  return {
    /** Teams with members, numbers and queue sizes (names and ids only; any inbox member). */
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
              status: memberships.status,
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
            .where(and(eq(teamMembers.tenantId, ctx.tenant.id), inArray(teamMembers.teamId, ids)))
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
                .filter((m) => m.teamId === t.id && m.status === 'active')
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
      const teamId = uuidv7();
      try {
        return await db.run(ctx.scope, async (tx) => {
          await assertTeamAvailable(tx, ctx.tenant.id);
          await checkMembers(tx, ctx.tenant.id, data.memberIds);
          await checkChannels(tx, ctx.tenant.id, data.channelIds);
          await tx.insert(teams).values({
            id: teamId,
            tenantId: ctx.tenant.id,
            name: data.name,
            description: data.description,
            assignment: data.assignment,
            maxOpenPerMember: data.maxOpenPerMember,
            routingKeywords: data.routingKeywords,
          });
          await syncMembersAndChannels(tx, ctx.tenant.id, teamId, data);
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
        if (isUniqueViolation(error, 'teams_name_uq')) throw duplicateName();
        throw error;
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
          const [current] = await tx
            .select({ id: teams.id, assignment: teams.assignment })
            .from(teams)
            .where(and(eq(teams.tenantId, ctx.tenant.id), eq(teams.id, teamId)))
            .for('update');
          if (!current) throw notFound('Team');
          await checkMembers(tx, ctx.tenant.id, data.memberIds);
          await checkChannels(tx, ctx.tenant.id, data.channelIds);
          await tx
            .update(teams)
            .set({
              name: data.name,
              description: data.description,
              assignment: data.assignment,
              maxOpenPerMember: data.maxOpenPerMember,
              routingKeywords: data.routingKeywords,
            })
            .where(and(eq(teams.tenantId, ctx.tenant.id), eq(teams.id, teamId)));
          await syncMembersAndChannels(tx, ctx.tenant.id, teamId, data);
          await recordAudit(
            tx,
            ctx,
            {
              action: 'team.updated',
              subjectType: 'team',
              subjectId: teamId,
              metadata: {
                assignment: { from: current.assignment, to: data.assignment },
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
        if (isUniqueViolation(error, 'teams_name_uq')) throw duplicateName();
        throw error;
      }
    },

    /** Deletes a team: its conversations leave the team (assignees are kept). */
    async deleteTeam(ctx: TenantContext, teamId: string, meta: RequestMeta = {}): Promise<void> {
      assertCan(ctx, 'inbox.supervise');
      if (!z.uuid().safeParse(teamId).success) throw notFound('Team');
      await db.run(ctx.scope, async (tx) => {
        // Conversations first, then the team: the same lock order as routing (conversation, team).
        const moved = await tx
          .update(conversations)
          .set({ teamId: null })
          .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.teamId, teamId)))
          .returning({ id: conversations.id });
        const [deleted] = await tx
          .delete(teams)
          .where(and(eq(teams.tenantId, ctx.tenant.id), eq(teams.id, teamId)))
          .returning({ name: teams.name });
        if (!deleted) throw notFound('Team');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'team.deleted',
            subjectType: 'team',
            subjectId: teamId,
            metadata: { conversations: moved.length },
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
        const [target] = await tx
          .select({ id: memberships.id, status: memberships.status, roles: memberships.roles })
          .from(memberships)
          .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.id, membershipId)));
        if (!target) throw notFound('Member');
        if (
          data.available &&
          (target.status !== 'active' || !target.roles.some((r) => INBOX_WORKER_ROLES.includes(r)))
        ) {
          throw new AppError(
            'validation_failed',
            'Only active members whose role can reply in the inbox can take conversations.',
          );
        }
        const now = clock.now();
        await tx
          .insert(memberAvailability)
          .values({
            id: uuidv7(),
            tenantId: ctx.tenant.id,
            membershipId,
            available: data.available,
            changedAt: now,
          })
          .onConflictDoUpdate({
            target: [memberAvailability.tenantId, memberAvailability.membershipId],
            set: { available: data.available, changedAt: now },
          });
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: 'member.availability',
          payload: { membershipId, available: data.available },
        });
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
