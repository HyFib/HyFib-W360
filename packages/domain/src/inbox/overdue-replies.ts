import { clipText, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  authorizedTenantScope,
  conversationTurns,
  conversations,
  eq,
  inArray,
  isNull,
  memberships,
  overdueReplyNotices,
  sql,
  systemScope,
  teamMembers,
  teams,
  tenants,
  users,
  type Database,
  type OverdueNoticeSkipReason,
  type TenantRole,
  type Tx,
} from '@w360/db';
import { permissionsForRoles } from '../authz/permissions';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { wantsEmail } from '../tenancy/email-preferences';
import { hasAnyTarget, loadReplyTargets, replyDueAt, targetFor } from './sla';

/**
 * Emails to the members responsible when a waiting customer's reply is overdue (ADR-230). The
 * worker's minute sweep asks `ops.overdue_reply_turns` for open reply turns that may be overdue and
 * works through each company's in the company's own scope: the due time comes from the inbox's own
 * rule (the first-response target of the conversation's team when it has one, else the company's,
 * ADR-377, counted in business hours when they are on), and each turn is noticed at most once
 * (`app.overdue_reply_notices`). A reply due later than the sweep thought (business hours) waits
 * for its due time; one due more than a day ago is skipped.
 *
 * The member responsible is the one the conversation is assigned to; when nobody who can still
 * see it is, the members of its team; when it has no team (or nobody there can answer), the
 * members who assign conversations. Each of them gets at most one email per company in a sweep:
 * the conversation's link, or the count and the inbox's list by longest wait when several replies
 * fell due together (business hours opening on a night's messages). Emails never carry the
 * customer's name, number or messages: they stay readable after their reader loses access.
 */
export const OVERDUE_NOTICE_LATE_LIMIT_MS = 24 * 3_600_000;

/**
 * Whether a notice due at `dueAt` is too late at `now`: more than a day after it was due, or after
 * the time a waiting notice was put off to when that is later. A waiting notice is planned again
 * (put off to the time of the change) when its calendar or target changes (ADR-389), so it is not
 * counted late for having waited, as the automatic reply's lateness rule does (ADR-384).
 */
export function overdueNoticeTooLate(input: {
  now: Date;
  dueAt: Date;
  waitedUntil: Date | null;
}): boolean {
  const lateFrom = Math.max(input.dueAt.getTime(), input.waitedUntil?.getTime() ?? 0);
  return input.now.getTime() - lateFrom > OVERDUE_NOTICE_LATE_LIMIT_MS;
}

/** How long a turn the calendar never makes due (closed for a year) waits before another look. */
const NEVER_DUE_RECHECK_MS = 24 * 3_600_000;

/** Why a member is emailed about an overdue reply. */
export type OverdueReason = 'assigned' | 'team' | 'routing';

export interface OverdueMember {
  id: string;
  roles: readonly TenantRole[];
  optOuts: readonly string[];
  email: string;
}

/**
 * The members responsible for a waiting conversation, and why: the member it is assigned to while
 * they can see it, else its team's members who can see and answer it, else the members who assign
 * conversations. `members` are the company's active members.
 */
export function responsibleMembers(
  conversation: { assignedMembershipId: string | null; teamId: string | null },
  members: readonly OverdueMember[],
  teamMemberIds: ReadonlySet<string>,
): { reason: OverdueReason; members: OverdueMember[] } {
  const assigned = conversation.assignedMembershipId;
  // The inbox's rule: every conversation, or unassigned ones and one's own.
  const canSee = (m: OverdueMember) => {
    const granted = permissionsForRoles(m.roles);
    return (
      granted.has('inbox.read_all') ||
      (granted.has('inbox.read_assigned') && (assigned === null || assigned === m.id))
    );
  };
  const can = (m: OverdueMember, permission: 'inbox.reply' | 'inbox.assign') =>
    permissionsForRoles(m.roles).has(permission);
  const assignee = assigned ? members.find((m) => m.id === assigned) : undefined;
  if (assignee && canSee(assignee) && can(assignee, 'inbox.reply')) {
    return { reason: 'assigned', members: [assignee] };
  }
  if (conversation.teamId) {
    const team = members.filter(
      (m) => teamMemberIds.has(m.id) && canSee(m) && can(m, 'inbox.reply'),
    );
    if (team.length > 0) return { reason: 'team', members: team };
  }
  return { reason: 'routing', members: members.filter((m) => canSee(m) && can(m, 'inbox.assign')) };
}

/** A target in words: 30 minutes, 1 hour, 1 hour 30 minutes, 24 hours. */
export function targetText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (hours === 0) return unit(rest, 'minute');
  return rest === 0 ? unit(hours, 'hour') : `${unit(hours, 'hour')} ${unit(rest, 'minute')}`;
}

export interface OverdueItem {
  reason: OverdueReason;
  teamName: string | null;
  startedAt: Date;
  /** The target of the conversation's team when it has its own (ADR-377); else the company's. */
  teamTargetMinutes?: number | null;
  /**
   * Its team keeps its own business hours (ADR-389) or closed days (ADR-392): the due time was
   * counted in them.
   */
  teamOwnHours?: boolean;
}

/**
 * The email to one member about the replies overdue for them in one sweep: one conversation, or
 * how many and for what reasons, each against its team's target or the company's (`targetMinutes`).
 * Never the customer's details or messages.
 */
export function overdueReplyEmail(input: {
  targetMinutes: number | null;
  businessHours: boolean;
  timeZone: string;
  items: readonly OverdueItem[];
}): { subject: string; lines: string[] } {
  // In whose business hours a reply was counted: its team's own (ADR-389), or the company's.
  const inWords = (minutes: number | null, hours: string | null) =>
    `${minutes === null ? 'its target' : targetText(minutes)}${
      hours ? ` of ${hours} business hours` : input.businessHours ? ' of business hours' : ''
    }`;
  // Whose target a reply was due against, in words: a team's own, or the company's.
  const whose = (item: OverdueItem) => {
    const team = `the ${clipText(item.teamName ?? 'team', 80)} team’s`;
    return item.teamTargetMinutes
      ? `${team} reply target of ${inWords(item.teamTargetMinutes, item.teamOwnHours ? 'its' : null)}`
      : `your company’s reply target of ${inWords(input.targetMinutes, item.teamOwnHours ? team : null)}`;
  };
  const since = (at: Date) =>
    `${new Intl.DateTimeFormat('en-IN', {
      timeZone: input.timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(at)} (${input.timeZone})`;
  const oldest = input.items.reduce<Date | null>(
    (min, i) => (min === null || i.startedAt < min ? i.startedAt : min),
    null,
  );
  const [only] = input.items;
  if (input.items.length === 1 && only) {
    const where =
      only.reason === 'assigned'
        ? 'in a conversation assigned to you'
        : only.reason === 'team'
          ? `in a conversation for the ${clipText(only.teamName ?? 'team', 80)} team that nobody has taken yet`
          : 'in a conversation that no member who can reply has taken';
    return {
      subject: 'A customer is waiting past your reply target',
      lines: [
        `A customer has waited longer than ${whose(only)}, ${where}.`,
        `They have been waiting since ${since(only.startedAt)}.`,
        'Open the conversation to reply; this email leaves out the customer’s details and messages.',
      ],
    };
  }
  const count = (reason: OverdueReason) => input.items.filter((i) => i.reason === reason).length;
  const parts = [
    [count('assigned'), 'assigned to you'],
    [count('team'), 'for your teams, not yet taken'],
    [count('routing'), 'not taken by a member who can reply'],
  ] as const;
  const n = input.items.length.toLocaleString('en-IN');
  const targets = new Set(input.items.map(whose));
  const [shared] = targets;
  return {
    subject: `${n} customers are waiting past your reply target`,
    lines: [
      targets.size === 1 && shared
        ? `${n} customers have waited longer than ${shared}.`
        : `${n} customers have waited longer than their reply targets: their teams’ own, or your company’s.`,
      `Their conversations: ${parts
        .filter(([k]) => k > 0)
        .map(([k, text]) => `${k.toLocaleString('en-IN')} ${text}`)
        .join('; ')}.`,
      ...(oldest ? [`The longest has been waiting since ${since(oldest)}.`] : []),
      'Open the inbox, longest wait first, to reply; this email leaves out the customers’ details and messages.',
    ],
  };
}

export interface OverdueReplyDeps {
  db: Database;
  clock: Clock;
  outbox: OutboxDeps;
  appBaseUrl: string;
}

export interface OverdueReplySweep {
  /** Turns whose members were emailed. */
  noticed: number;
  emails: number;
  /** Turns business hours put off. */
  waiting: number;
  skipped: number;
  /** Companies whose turns could not be worked through; the next sweep tries them again. */
  failed: { tenantId: string; error: unknown }[];
}

/** Emails the members responsible for replies that fell overdue (see above). */
export async function noticeOverdueReplies(
  deps: OverdueReplyDeps,
  limit = 200,
): Promise<OverdueReplySweep> {
  const now = deps.clock.now();
  const rows = await deps.db.run(
    systemScope,
    async (tx) =>
      (
        await tx.execute<{ tenant_id: string; turn_id: string }>(
          sql`select tenant_id, turn_id from ops.overdue_reply_turns(${now.toISOString()}::timestamptz, ${limit})`,
        )
      ).rows,
    { accessMode: 'read only' },
  );
  const byTenant = new Map<string, string[]>();
  for (const row of rows) {
    const turns = byTenant.get(row.tenant_id) ?? [];
    turns.push(row.turn_id);
    byTenant.set(row.tenant_id, turns);
  }
  const sweep: OverdueReplySweep = { noticed: 0, emails: 0, waiting: 0, skipped: 0, failed: [] };
  for (const [tenantId, turnIds] of byTenant) {
    try {
      // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
      const outcome = await deps.db.run(authorizedTenantScope(tenantId, null), (tx) =>
        noticeCompanyTurns(deps, tx, tenantId, turnIds, now),
      );
      sweep.noticed += outcome.noticed;
      sweep.emails += outcome.emails;
      sweep.waiting += outcome.waiting;
      sweep.skipped += outcome.skipped;
    } catch (error) {
      sweep.failed.push({ tenantId, error });
    }
  }
  return sweep;
}

type CompanyOutcome = Omit<OverdueReplySweep, 'failed'>;

async function noticeCompanyTurns(
  deps: OverdueReplyDeps,
  tx: Tx,
  tenantId: string,
  turnIds: readonly string[],
  now: Date,
): Promise<CompanyOutcome> {
  const outcome: CompanyOutcome = { noticed: 0, emails: 0, waiting: 0, skipped: 0 };
  const [company] = await tx
    .select({ name: tenants.name, slug: tenants.slug, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!company) return outcome;
  const targets = await loadReplyTargets(tx, tenantId, company.timezone);
  if (!hasAnyTarget(targets)) return outcome;
  // The conversations first, then the turns, as the automatic reply's sweep takes them (ADR-384):
  // a change of team (its trigger plans the notice again, ADR-389) either waits for this or is
  // seen, and a member's reply, which closes the turn, likewise. Conversations another transaction
  // holds are skipped and looked at in the next sweep, so the sweep never waits on them.
  const candidates = await tx
    .select({ conversationId: conversationTurns.conversationId })
    .from(conversationTurns)
    .where(
      and(eq(conversationTurns.tenantId, tenantId), inArray(conversationTurns.id, [...turnIds])),
    );
  const conversationIds = [...new Set(candidates.map((c) => c.conversationId))].sort();
  if (conversationIds.length === 0) return outcome;
  const held = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), inArray(conversations.id, conversationIds)))
    .orderBy(asc(conversations.id))
    .for('share', { skipLocked: true });
  if (held.length === 0) return outcome;
  const turns = await tx
    .select({
      id: conversationTurns.id,
      conversationId: conversationTurns.conversationId,
      startedAt: conversationTurns.startedAt,
    })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.tenantId, tenantId),
        inArray(conversationTurns.id, [...turnIds]),
        inArray(
          conversationTurns.conversationId,
          held.map((c) => c.id),
        ),
        isNull(conversationTurns.endedAt),
      ),
    )
    .orderBy(asc(conversationTurns.id))
    .for('update');
  if (turns.length === 0) return outcome;
  const notices = new Map(
    (
      await tx
        .select({
          turnId: overdueReplyNotices.turnId,
          state: overdueReplyNotices.state,
          dueAt: overdueReplyNotices.dueAt,
        })
        .from(overdueReplyNotices)
        .where(
          and(
            eq(overdueReplyNotices.tenantId, tenantId),
            inArray(
              overdueReplyNotices.turnId,
              turns.map((t) => t.id),
            ),
          ),
        )
    ).map((n) => [n.turnId, n]),
  );

  const record = async (
    turnId: string,
    values:
      | { state: 'waiting'; dueAt: Date }
      | { state: 'sent'; dueAt: Date; emailed: number }
      | { state: 'skipped'; dueAt: Date; skipReason: OverdueNoticeSkipReason },
  ) => {
    const row = {
      state: values.state,
      dueAt: values.dueAt,
      emailed: values.state === 'sent' ? values.emailed : 0,
      skipReason: values.state === 'skipped' ? values.skipReason : null,
      updatedAt: now,
    };
    if (notices.has(turnId)) {
      await tx
        .update(overdueReplyNotices)
        .set(row)
        .where(
          and(eq(overdueReplyNotices.tenantId, tenantId), eq(overdueReplyNotices.turnId, turnId)),
        );
    } else {
      await tx.insert(overdueReplyNotices).values({ id: uuidv7(), tenantId, turnId, ...row });
    }
  };

  // Each reply is due against its conversation's team's target, or the company's (ADR-377).
  const convs = new Map(
    (
      await tx
        .select({
          id: conversations.id,
          assignedMembershipId: conversations.assignedMembershipId,
          teamId: conversations.teamId,
          teamName: teams.name,
        })
        .from(conversations)
        .leftJoin(
          teams,
          and(eq(teams.tenantId, conversations.tenantId), eq(teams.id, conversations.teamId)),
        )
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            inArray(
              conversations.id,
              turns.map((t) => t.conversationId),
            ),
          ),
        )
    ).map((c) => [c.id, c]),
  );

  const overdue: { id: string; conversationId: string; startedAt: Date; dueAt: Date }[] = [];
  for (const turn of turns) {
    const notice = notices.get(turn.id);
    if (notice && notice.state !== 'waiting') continue;
    const target = targetFor(targets, convs.get(turn.conversationId)?.teamId ?? null);
    // Neither its team nor the company has a target any more: nothing is due.
    if (!target.minutes) continue;
    const dueAt = replyDueAt(target, turn.startedAt);
    if (!dueAt) {
      // The calendar opens for none of the target within a year: look again in a day.
      await record(turn.id, {
        state: 'waiting',
        dueAt: new Date(now.getTime() + NEVER_DUE_RECHECK_MS),
      });
      outcome.waiting += 1;
    } else if (dueAt > now) {
      await record(turn.id, { state: 'waiting', dueAt });
      outcome.waiting += 1;
    } else if (
      overdueNoticeTooLate({
        now,
        dueAt,
        waitedUntil: notice?.state === 'waiting' ? notice.dueAt : null,
      })
    ) {
      await record(turn.id, { state: 'skipped', dueAt, skipReason: 'too_late' });
      outcome.skipped += 1;
    } else {
      overdue.push({ ...turn, dueAt });
    }
  }
  if (overdue.length === 0) return outcome;
  const members = (
    await tx
      .select({
        id: memberships.id,
        roles: memberships.roles,
        optOuts: memberships.emailOptOuts,
        email: users.email,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active')))
      .orderBy(asc(memberships.id))
  ).map((m) => ({ ...m, roles: m.roles as TenantRole[] }));
  const teamIds = [...new Set([...convs.values()].flatMap((c) => (c.teamId ? [c.teamId] : [])))];
  const teamRows =
    teamIds.length > 0
      ? await tx
          .select({ teamId: teamMembers.teamId, membershipId: teamMembers.membershipId })
          .from(teamMembers)
          .where(and(eq(teamMembers.tenantId, tenantId), inArray(teamMembers.teamId, teamIds)))
      : [];

  // Each member's overdue replies in this sweep, so that a burst sends one email.
  const perMember = new Map<
    string,
    { member: OverdueMember; items: (OverdueItem & { turnId: string; conversationId: string })[] }
  >();
  for (const turn of overdue) {
    const conv = convs.get(turn.conversationId);
    const team = new Set(
      teamRows.filter((r) => r.teamId === conv?.teamId).map((r) => r.membershipId),
    );
    const responsible = responsibleMembers(
      {
        assignedMembershipId: conv?.assignedMembershipId ?? null,
        teamId: conv?.teamId ?? null,
      },
      members,
      team,
    );
    const emailed = responsible.members.filter((m) => wantsEmail(m.optOuts, 'reply_overdue'));
    if (emailed.length === 0) {
      await record(turn.id, {
        state: 'skipped',
        dueAt: turn.dueAt,
        skipReason: responsible.members.length === 0 ? 'no_one' : 'opted_out',
      });
      outcome.skipped += 1;
      continue;
    }
    for (const member of emailed) {
      const entry = perMember.get(member.id) ?? { member, items: [] };
      entry.items.push({
        reason: responsible.reason,
        teamName: conv?.teamName ?? null,
        startedAt: turn.startedAt,
        teamTargetMinutes: conv?.teamId ? (targets.teamMinutes.get(conv.teamId) ?? null) : null,
        teamOwnHours: conv?.teamId ? targets.teamCalendars.has(conv.teamId) : false,
        turnId: turn.id,
        conversationId: turn.conversationId,
      });
      perMember.set(member.id, entry);
    }
    await record(turn.id, { state: 'sent', dueAt: turn.dueAt, emailed: emailed.length });
    outcome.noticed += 1;
  }

  for (const { member, items } of perMember.values()) {
    const { subject, lines } = overdueReplyEmail({
      targetMinutes: targets.companyMinutes,
      businessHours: targets.calendar !== null,
      timeZone: company.timezone,
      items,
    });
    const [only] = items;
    const path =
      items.length === 1 && only
        ? `/c/${company.slug}/inbox/${only.conversationId}`
        : `/c/${company.slug}/inbox?view=all&status=open&order=waiting`;
    const firstTurn = items.map((i) => i.turnId).sort()[0];
    await enqueueEmail(deps.outbox, tx, {
      to: member.email,
      tenantId,
      // Each turn is noticed once, so its first turn names a member's email for good.
      dedupeKey: `reply-overdue:${firstTurn}:${member.id}`,
      payload: {
        kind: 'tenant.notice',
        companyName: company.name,
        subject,
        lines,
        url: new URL(path, deps.appBaseUrl).toString(),
        actionLabel: items.length === 1 ? 'Open conversation' : 'Open the inbox',
      },
    });
    outcome.emails += 1;
  }
  return outcome;
}
