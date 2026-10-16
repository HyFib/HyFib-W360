import { and, eq, isNotNull, messagingSettings, teams, type Tx } from '@w360/db';
import {
  addBusinessMinutes,
  businessStatusAt,
  loadBusinessCalendar,
  type BusinessCalendar,
} from './business-hours';

/**
 * Reply-due timers. A waiting customer's reply is due `minutes` after their reply turn started:
 * counted in business hours when the company's business hours are on (the timer pauses while the
 * business is closed), otherwise in absolute time. No target means no timer. The target is the one
 * of the team the conversation is in, when that team has its own, else the company's (ADR-377).
 */
export interface ReplyTarget {
  minutes: number | null;
  /** Present only when business hours are on. */
  calendar: BusinessCalendar | null;
}

export interface ReplyTimer {
  dueAt: Date | null;
  overdue: boolean;
  /** When business hours are on and the business is closed now: when the timer resumes. */
  pausedUntil: Date | null;
}

/** The company's target, its teams' own targets and, when business hours are on, its calendar. */
export interface ReplyTargets {
  /** The company's first-response target in minutes (Settings → Inbox), or null. */
  companyMinutes: number | null;
  /** The targets of the teams that have their own, by team id. */
  teamMinutes: ReadonlyMap<string, number>;
  /** Present only when business hours are on. */
  calendar: BusinessCalendar | null;
}

export async function loadReplyTargets(
  tx: Tx,
  tenantId: string,
  timezone: string,
): Promise<ReplyTargets> {
  const [row] = await tx
    .select({ minutes: messagingSettings.firstResponseTargetMinutes })
    .from(messagingSettings)
    .where(eq(messagingSettings.tenantId, tenantId));
  const teamRows = await tx
    .select({ id: teams.id, minutes: teams.firstResponseTargetMinutes })
    .from(teams)
    .where(and(eq(teams.tenantId, tenantId), isNotNull(teams.firstResponseTargetMinutes)));
  const { enabled, calendar } = await loadBusinessCalendar(tx, tenantId, timezone);
  return {
    companyMinutes: row?.minutes ?? null,
    teamMinutes: new Map(teamRows.flatMap((r) => (r.minutes === null ? [] : [[r.id, r.minutes]]))),
    calendar: enabled ? calendar : null,
  };
}

/** The target of a conversation in team `teamId`, or in no team: its team's own, else the company's. */
export function targetFor(targets: ReplyTargets, teamId: string | null): ReplyTarget {
  const team = teamId === null ? undefined : targets.teamMinutes.get(teamId);
  return { minutes: team ?? targets.companyMinutes, calendar: targets.calendar };
}

/** Whether any conversation of the company has a target: the company has one, or a team does. */
export function hasAnyTarget(targets: ReplyTargets): boolean {
  return targets.companyMinutes !== null || targets.teamMinutes.size > 0;
}

export function replyDueAt(target: ReplyTarget, startedAt: Date): Date | null {
  if (!target.minutes) return null;
  if (!target.calendar) return new Date(startedAt.getTime() + target.minutes * 60_000);
  return addBusinessMinutes(target.calendar, startedAt, target.minutes);
}

export function replyTimer(target: ReplyTarget, startedAt: Date, now: Date): ReplyTimer {
  const dueAt = replyDueAt(target, startedAt);
  let pausedUntil: Date | null = null;
  if (target.minutes && target.calendar && (!dueAt || dueAt.getTime() > now.getTime())) {
    const status = businessStatusAt(target.calendar, now);
    if (!status.open) pausedUntil = status.opensAt;
  }
  return {
    dueAt,
    overdue: dueAt !== null && dueAt.getTime() <= now.getTime(),
    pausedUntil,
  };
}
