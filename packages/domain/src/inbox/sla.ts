import { eq, messagingSettings, type Tx } from '@w360/db';
import {
  addBusinessMinutes,
  businessStatusAt,
  loadBusinessCalendar,
  type BusinessCalendar,
} from './business-hours';

/**
 * Reply-due timers. A waiting customer's reply is due `minutes` after their reply turn started:
 * counted in business hours when the company's business hours are on (the timer pauses while the
 * business is closed), otherwise in absolute time. No target means no timer.
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

export async function loadReplyTarget(
  tx: Tx,
  tenantId: string,
  timezone: string,
): Promise<ReplyTarget> {
  const [row] = await tx
    .select({ minutes: messagingSettings.firstResponseTargetMinutes })
    .from(messagingSettings)
    .where(eq(messagingSettings.tenantId, tenantId));
  const { enabled, calendar } = await loadBusinessCalendar(tx, tenantId, timezone);
  return { minutes: row?.minutes ?? null, calendar: enabled ? calendar : null };
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
