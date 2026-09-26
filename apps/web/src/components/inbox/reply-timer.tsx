import { Badge } from '@w360/ui';
import { formatWhen } from '@/lib/format';
import { formatDuration } from '@/lib/report-format';

/**
 * How long the customer has waited and when the reply is due under the first-response target
 * (computed by the inbox service, business hours included). Rendered on the server at page load;
 * live updates re-render it.
 */
export function ReplyTimer({
  waitingSince,
  replyDueAt,
  overdue,
  timerPausedUntil,
  timeZone,
  now,
}: {
  waitingSince: string | null;
  replyDueAt: string | null;
  overdue: boolean;
  timerPausedUntil: string | null;
  timeZone: string;
  now: Date;
}) {
  if (!waitingSince) return null;
  const waited = formatDuration((now.getTime() - new Date(waitingSince).getTime()) / 1000);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span>Waiting {waited}</span>
      {replyDueAt && overdue ? <Badge tone="danger">Reply overdue</Badge> : null}
      {replyDueAt && !overdue && timerPausedUntil ? (
        <span>· timer paused until {formatWhen(timerPausedUntil, timeZone, now)}</span>
      ) : null}
      {replyDueAt && !overdue && !timerPausedUntil ? (
        <span>· reply due {formatWhen(replyDueAt, timeZone, now)}</span>
      ) : null}
    </span>
  );
}
