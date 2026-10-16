import { z } from 'zod';
import { notFound } from '@w360/core';
import { TEAM_ASSIGNMENT_MODES, type TeamAssignmentMode, type Tx } from '@w360/db';
import { recordSystemAudit } from '../audit';
import { MAX_RANGES_PER_DAY, parseTime, type BusinessInterval } from '../inbox/business-hours';
import {
  MAX_ROUTING_KEYWORDS,
  readTeamSettings,
  sameTeamHours,
  teamHoursAudit,
  teamNameError,
  teamSchema,
  writeCreateTeam,
  writeDeleteTeam,
  writeUpdateTeam,
  type TeamSettings,
} from '../inbox/teams';
import { routeWaitingConversations } from '../inbox/routing';
import { toApiDays, type ApiTimeRange } from './business-hours';
import type { OutboundDeps } from '../messaging/outbound';
import { parseInput } from '../validation';
import { apiActor, assertAnyScope, assertScope, type ApiContext } from './context';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';

/**
 * Managing teams through the public API (ADR-287), with `teams.manage`: reading a team's settings,
 * adding teams, changing their settings, members and numbers, and deleting them, through the writes
 * Settings → Teams uses, so the plan's limit, the members routing may give conversations to and the
 * company's numbers are checked as there, audited as done by the key.
 */

/** A team's settings, members and numbers, as `GET /teams/{id}` gives them. */
export interface ApiTeamSettings {
  id: string;
  name: string;
  description: string | null;
  /** `round_robin`: the team gives conversations without a member to its available members in turn. */
  assignment: TeamAssignmentMode;
  /** The open conversations round robin gives a member at most; null for no limit. */
  maxOpenPerMember: number | null;
  /** Words in a customer's first message that route the conversation to the team. */
  routingKeywords: string[];
  /** The team's own first-response target in minutes (ADR-377); null uses the company's. */
  firstResponseTargetMinutes: number | null;
  /**
   * The team's own weekly schedule (ADR-389): seven days, Monday first, each with its opening
   * ranges in the company's time zone; null uses the company's business hours.
   */
  businessHours: ApiTimeRange[][] | null;
  /** The team's active members, as GET /members lists them, in the order they joined. */
  memberIds: string[];
  /** The WhatsApp numbers whose new conversations go to the team, as GET /channels lists them. */
  channelIds: string[];
  createdAt: string;
  updatedAt: string;
}

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a team name.')
  .max(80, 'Use at most 80 characters.')
  .describe('Unique among the company’s teams, ignoring case; up to 80 characters.');
const descriptionSchema = z
  .string()
  .trim()
  .max(300, 'Use at most 300 characters.')
  .nullable()
  .describe('What the team handles, up to 300 characters; null or empty for none.');
const assignmentSchema = z
  .enum(TEAM_ASSIGNMENT_MODES)
  .describe(
    '`manual`: members pick conversations up; `round_robin`: the team gives conversations without a member to its available members in turn.',
  );
const targetSchema = z
  .number()
  .int('Enter a reply target from 1 to 1,440 minutes, or null.')
  .min(1, 'Enter a reply target from 1 to 1,440 minutes, or null.')
  .max(1440, 'Enter a reply target from 1 to 1,440 minutes, or null.')
  .nullable()
  .describe(
    'The team’s own first-response target in minutes: customers waiting in its conversations are due a reply within it (in business hours when they are on) instead of the company’s target; null uses the company’s.',
  );
const timeSchema = z
  .string()
  .max(5)
  .refine(
    (text) => parseTime(text) !== null,
    'Write times as HH:MM, like 09:00; 24:00 is midnight.',
  )
  .describe('HH:MM in the company’s time zone; 24:00 closes at midnight.');
const businessHoursSchema = z
  .array(
    z
      .array(z.object({ opens: timeSchema, closes: timeSchema }).strict())
      .max(MAX_RANGES_PER_DAY, `Use at most ${MAX_RANGES_PER_DAY} time ranges a day.`),
  )
  .length(7, 'Give seven days, Monday first.')
  .nullable()
  .describe(
    `The team’s own weekly schedule: seven days, Monday first, each with up to ${MAX_RANGES_PER_DAY} opening ranges that do not overlap (an empty list closes the day), at least one in the week. While the company’s business hours are on (GET /business-hours), the team’s conversations count reply targets and the automatic reply’s delay in these hours instead of the company’s; the company’s closed days and time zone apply. Null uses the company’s business hours.`,
  );
const maxOpenSchema = z
  .number()
  .int('Enter a limit from 1 to 500, or null.')
  .min(1, 'Enter a limit from 1 to 500, or null.')
  .max(500, 'Enter a limit from 1 to 500, or null.')
  .nullable()
  .describe(
    'With round robin, the open conversations a member is given at most; null for no limit.',
  );
const keywordsSchema = z
  .array(z.string().max(200, 'Keep each keyword under 40 characters.'))
  .max(MAX_ROUTING_KEYWORDS * 10, `Use at most ${MAX_ROUTING_KEYWORDS} keywords.`)
  .describe(
    `Up to ${MAX_ROUTING_KEYWORDS} keywords of up to 40 characters, matched in a customer’s first message to route the conversation to the team; kept lowercased without repeats, as Settings keeps them.`,
  );
const memberIdsSchema = z
  .array(z.uuid())
  .max(200)
  .describe(
    'The team’s members: active members whose role answers conversations, as GET /members lists them. Replaces the team’s list; members who cannot answer conversations now (suspended, or given another role) are not in it and keep their place, back in the team when they can again.',
  );
const channelIdsSchema = z
  .array(z.uuid())
  .max(50)
  .describe(
    'The company’s WhatsApp numbers (GET /channels) whose new conversations go to the team; a number is in one team at most, so naming it here takes it from another. Replaces the team’s list.',
  );

/** What `POST /teams` takes: a team as members add one in Settings → Teams. */
export const apiCreateTeamSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional(),
    assignment: assignmentSchema.optional(),
    maxOpenPerMember: maxOpenSchema.optional(),
    routingKeywords: keywordsSchema.optional(),
    firstResponseTargetMinutes: targetSchema.optional(),
    businessHours: businessHoursSchema.optional(),
    memberIds: memberIdsSchema.optional(),
    channelIds: channelIdsSchema.optional(),
  })
  .strict();

/** What `PATCH /teams/{id}` takes: any of a team's settings; those left out stay as they are. */
export const apiUpdateTeamSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    assignment: assignmentSchema.optional(),
    maxOpenPerMember: maxOpenSchema.optional(),
    routingKeywords: keywordsSchema.optional(),
    firstResponseTargetMinutes: targetSchema.optional(),
    businessHours: businessHoursSchema.optional(),
    memberIds: memberIdsSchema.optional(),
    channelIds: channelIdsSchema.optional(),
  })
  .strict()
  .refine((change) => Object.keys(change).length > 0, {
    message: 'Give at least one setting to change.',
  });

/** A week of ranges as the API takes it, as the seven days of text Settings takes (ADR-389). */
export function apiDaysToTexts(days: readonly (readonly ApiTimeRange[])[]): string[] {
  return days.map((ranges) => ranges.map((r) => `${r.opens}-${r.closes}`).join(', '));
}

/**
 * The settings Settings would keep from these, normalized and checked as members' saves are; a
 * team's hours are checked day by day as Settings checks them (422 naming `businessHours.<n>`).
 */
export function teamSettingsOf(input: z.output<typeof apiCreateTeamSchema>): TeamSettings {
  return parseInput(teamSchema, {
    name: input.name,
    description: input.description ?? undefined,
    assignment: input.assignment,
    maxOpenPerMember: input.maxOpenPerMember ?? null,
    routingKeywords: input.routingKeywords,
    firstResponseTargetMinutes: input.firstResponseTargetMinutes ?? null,
    businessHours: input.businessHours ? apiDaysToTexts(input.businessHours) : null,
    memberIds: input.memberIds,
    channelIds: input.channelIds,
  });
}

/** A team's own hours as the API gives and takes them, from stored intervals. */
export function toApiTeamHours(hours: readonly BusinessInterval[] | null): ApiTimeRange[][] | null {
  return hours === null ? null : toApiDays(hours);
}

/** Whether two lists hold the same ids, whatever their order or repeats. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...right].every((id) => left.has(id));
}

/** Whether `next` would leave the team as `current` has it. */
export function sameTeamSettings(current: TeamSettings, next: TeamSettings): boolean {
  return (
    current.name === next.name &&
    current.description === next.description &&
    current.assignment === next.assignment &&
    current.maxOpenPerMember === next.maxOpenPerMember &&
    current.firstResponseTargetMinutes === next.firstResponseTargetMinutes &&
    sameTeamHours(current.businessHours, next.businessHours) &&
    current.routingKeywords.length === next.routingKeywords.length &&
    current.routingKeywords.every((keyword, i) => keyword === next.routingKeywords[i]) &&
    sameSet(current.memberIds, next.memberIds) &&
    sameSet(current.channelIds, next.channelIds)
  );
}

/** A team's settings as the API gives them. */
export function toApiTeamSettings(
  team: TeamSettings & { id: string; createdAt: Date; updatedAt: Date },
): ApiTeamSettings {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    assignment: team.assignment,
    maxOpenPerMember: team.maxOpenPerMember,
    routingKeywords: team.routingKeywords,
    firstResponseTargetMinutes: team.firstResponseTargetMinutes,
    businessHours: toApiTeamHours(team.businessHours),
    memberIds: team.memberIds,
    channelIds: team.channelIds,
    createdAt: team.createdAt.toISOString(),
    updatedAt: team.updatedAt.toISOString(),
  };
}

async function readApiTeam(tx: Tx, tenantId: string, id: string): Promise<ApiTeamSettings> {
  const team = await readTeamSettings(tx, tenantId, id);
  if (!team) throw notFound('Team');
  return toApiTeamSettings(team);
}

const isUuid = (id: string) => z.uuid().safeParse(id).success;

/**
 * One of the company's teams with its settings, members and numbers. Reading, it works while the
 * company is suspended, as reading scopes do.
 */
export async function apiGetTeam(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  id: string,
): Promise<ApiTeamSettings> {
  assertAnyScope(ctx, ['teams.manage']);
  if (!isUuid(id)) throw notFound('Team');
  return deps.db.run(ctx.scope, (tx) => readApiTeam(tx, ctx.tenant.id, id), {
    accessMode: 'read only',
  });
}

/**
 * Adds a team as members add one in Settings → Teams, within the plan's limit of teams, then routes
 * waiting conversations, and answers it as `GET /teams/{id}` gives it. Once per `Idempotency-Key`
 * when one is given.
 */
export async function apiCreateTeam(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'teams.manage');
  const data = teamSettingsOf(parseInput(apiCreateTeamSchema, input));
  const now = deps.clock.now();
  try {
    return await deps.db.run(ctx.scope, async (tx) => {
      // Claimed in the team's transaction, so a refused team leaves the key unused.
      let claimed: string | null = null;
      if (idempotency) {
        const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
        if ('replay' in claim) return claim.replay;
        claimed = claim.claimed;
      }
      const { teamId } = await writeCreateTeam(tx, ctx.tenant.id, data);
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'team.created',
          subjectType: 'team',
          subjectId: teamId,
          correlationId: ctx.requestId,
          metadata: {
            assignment: data.assignment,
            maxOpenPerMember: data.maxOpenPerMember,
            firstResponseTargetMinutes: data.firstResponseTargetMinutes,
            ...teamHoursAudit(data.businessHours),
            members: data.memberIds.length,
            channels: data.channelIds.length,
            keywords: data.routingKeywords.length,
            source: 'api',
          },
        },
        apiActor(ctx),
      );
      await routeWaitingConversations(tx, ctx.tenant.id, 50);
      const response = {
        status: 201,
        body: { data: await readApiTeam(tx, ctx.tenant.id, teamId) },
      };
      if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
      return { ...response, replayed: false };
    });
  } catch (error) {
    throw teamNameError(error);
  }
}

/**
 * Changes the settings given, with the rest as the team has them, as members save the team in
 * Settings (its row locked meanwhile), then routes waiting conversations, and answers the team. A
 * change that leaves the team as it is answers it with no audit entry, so a retry needs no key.
 */
export async function apiUpdateTeam(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  id: string,
  input: unknown,
): Promise<ApiTeamSettings> {
  assertScope(ctx, 'teams.manage');
  if (!isUuid(id)) throw notFound('Team');
  const change = parseInput(apiUpdateTeamSchema, input);
  try {
    return await deps.db.run(ctx.scope, async (tx) => {
      const current = await readTeamSettings(tx, ctx.tenant.id, id, { lock: true });
      if (!current) throw notFound('Team');
      const next = teamSettingsOf({
        name: change.name ?? current.name,
        description: change.description === undefined ? current.description : change.description,
        assignment: change.assignment ?? current.assignment,
        maxOpenPerMember:
          change.maxOpenPerMember === undefined
            ? current.maxOpenPerMember
            : change.maxOpenPerMember,
        routingKeywords: change.routingKeywords ?? current.routingKeywords,
        firstResponseTargetMinutes:
          change.firstResponseTargetMinutes === undefined
            ? current.firstResponseTargetMinutes
            : change.firstResponseTargetMinutes,
        businessHours:
          change.businessHours === undefined
            ? toApiTeamHours(current.businessHours)
            : change.businessHours,
        memberIds: change.memberIds ?? current.memberIds,
        channelIds: change.channelIds ?? current.channelIds,
      });
      if (sameTeamSettings(current, next)) return toApiTeamSettings(current);
      const { previousAssignment, hoursChanged } = await writeUpdateTeam(
        tx,
        ctx.tenant.id,
        id,
        next,
      );
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'team.updated',
          subjectType: 'team',
          subjectId: id,
          correlationId: ctx.requestId,
          metadata: {
            assignment: { from: previousAssignment, to: next.assignment },
            maxOpenPerMember: next.maxOpenPerMember,
            firstResponseTargetMinutes: next.firstResponseTargetMinutes,
            ...teamHoursAudit(next.businessHours),
            businessHoursChanged: hoursChanged,
            members: next.memberIds.length,
            channels: next.channelIds.length,
            keywords: next.routingKeywords.length,
            source: 'api',
          },
        },
        apiActor(ctx),
      );
      await routeWaitingConversations(tx, ctx.tenant.id, 50);
      return readApiTeam(tx, ctx.tenant.id, id);
    });
  } catch (error) {
    throw teamNameError(error);
  }
}

/**
 * Deletes a team as members do in Settings: its conversations leave the team, keeping their
 * assignees. Another company's team, an unknown one and one already deleted answer 404.
 */
export async function apiDeleteTeam(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  id: string,
): Promise<{ id: string; deleted: true; conversations: number }> {
  assertScope(ctx, 'teams.manage');
  if (!isUuid(id)) throw notFound('Team');
  return deps.db.run(ctx.scope, async (tx) => {
    const deleted = await writeDeleteTeam(tx, ctx.tenant.id, id);
    if (!deleted) throw notFound('Team');
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'team.deleted',
        subjectType: 'team',
        subjectId: id,
        correlationId: ctx.requestId,
        metadata: { conversations: deleted.conversations, source: 'api' },
      },
      apiActor(ctx),
    );
    return { id, deleted: true, conversations: deleted.conversations };
  });
}
