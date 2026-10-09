import { queueMaxWaitMinutes, type QueueDefinition } from '@w360/contracts';
import { jsonbText } from '@w360/core';
import { sql, systemScope, type Database } from '@w360/db';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { queueAlertPost } from './alert-channel';

/**
 * How long jobs wait in each queue, and alerts for queues that fall behind (ADR-096). pg-boss's
 * counts carry no age, so the worker's minute sweep reads, for each queue this release declares,
 * the jobs pg-boss would hand to a worker now and when the oldest of them became due, and records
 * them in `ops.queue_waits`. A queue is late once that wait reaches the queue's limit
 * (`maxWaitMinutes` in the catalog) and until it is back under half of it; every platform
 * administrator is emailed once each time a queue becomes late, at most every 15 minutes, and the
 * same text is posted to the chat channel when one is set (ADR-338). Queue names, counts and times
 * only: nothing of a job's payload leaves pg-boss.
 */

/** Minutes between two late-queue alerts at least; enforced by `ops.mark_queue_alert`. */
export const QUEUE_ALERT_INTERVAL_MINUTES = 15;

/**
 * A check older than this is not fresh: `ops.mark_queue_alert` does not report it, and the console
 * says the worker's minute sweep has stopped checking.
 */
export const QUEUE_CHECK_FRESH_MINUTES = 5;

/** Queues named in one alert at most, one a line; the rest are counted. */
const NAMED_QUEUES = 8;

/** Characters of a queue's name shown at most, as in the failure alert (ADR-091). */
const QUEUE_NAME_MAX = 40;

const MINUTE_MS = 60_000;

export interface QueueWaitLimit {
  name: string;
  limitMinutes: number;
}

/** The limit of each queue a release declares, for the minute sweep. */
export const queueWaitLimits = (queues: readonly QueueDefinition[]): QueueWaitLimit[] =>
  queues.map((q) => ({ name: q.name, limitMinutes: queueMaxWaitMinutes(q) }));

export interface QueueWaitCheck {
  checked: number;
  /** Queues of those checked that are late now. */
  late: number;
}

/**
 * Reads each queue's waiting jobs from pg-boss and records them, with the queue's limit, in the same
 * transaction. Waiting is pg-boss's own "ready" (its queue stats: queued minus deferred): created or
 * retried, and due. A job held by a dependency waits for that job rather than for a worker, and is
 * left out; so the partial index pg-boss claims jobs with serves the read, without touching
 * finished jobs.
 */
export async function checkQueueWaits(
  db: Database,
  limits: readonly QueueWaitLimit[],
): Promise<QueueWaitCheck> {
  if (limits.length === 0) return { checked: 0, late: 0 };
  return db.run(systemScope, async (tx) => {
    const found = await tx.execute<{ name: string; waiting: number; oldest: Date | string }>(sql`
      select name, count(*)::int as waiting, min(start_after) as oldest
        from pgboss.job
       where name = any(${sql.param(limits.map((l) => l.name))}::text[])
         and state < 'active' and not blocked and start_after <= now()
       group by name`);
    const byName = new Map(found.rows.map((r) => [r.name, r]));
    const waits = limits.map((l) => {
      const row = byName.get(l.name);
      return {
        queue: l.name,
        waiting: row ? Number(row.waiting) : 0,
        oldest_waiting_since: row ? new Date(row.oldest).toISOString() : null,
        limit_minutes: l.limitMinutes,
      };
    });
    const recorded = await tx.execute<{ late: number }>(
      sql`select ops.record_queue_waits(${jsonbText(waits)}::jsonb) as late`,
    );
    return { checked: waits.length, late: Number(recorded.rows[0]?.late ?? 0) };
  });
}

/** A late queue as one alert tells it. */
export interface LateQueue {
  queue: string;
  waiting: number;
  oldestWaitingSince: Date;
  limitMinutes: number;
  /** When the worker read it: the wait is told as it was then. */
  checkedAt: Date;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function queueName(name: string): string {
  return name.length > QUEUE_NAME_MAX ? `${name.slice(0, QUEUE_NAME_MAX - 1)}…` : name;
}

/** A wait in whole minutes, as "under a minute", "23 minutes" or "2 hours 5 minutes". */
export function waitLabel(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / MINUTE_MS);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const inMinutes = (n: number) => `${n} ${plural(n, 'minute', 'minutes')}`;
  if (hours === 0) return inMinutes(minutes);
  const inHours = `${hours} ${plural(hours, 'hour', 'hours')}`;
  return rest === 0 ? inHours : `${inHours} ${inMinutes(rest)}`;
}

const waitOf = (q: LateQueue) => q.checkedAt.getTime() - q.oldestWaitingSince.getTime();

/** The email for the queues one alert marked; pure, so the wording is unit-tested. */
export function lateQueueAlert(
  queues: LateQueue[],
  appBaseUrl: string,
): { subject: string; lines: string[]; url: string; actionLabel: string } {
  const sorted = [...queues].sort(
    (a, b) => waitOf(b) - waitOf(a) || a.queue.localeCompare(b.queue),
  );
  const n = sorted.length;
  const shown = n > NAMED_QUEUES ? sorted.slice(0, NAMED_QUEUES - 1) : sorted;
  const lines = [
    n === 1
      ? 'A queue has jobs waiting for a worker longer than its limit:'
      : `${n} queues have jobs waiting for a worker longer than their limits:`,
    ...shown.map(
      (q) =>
        `${queueName(q.queue)}: ${q.waiting} ${plural(q.waiting, 'job', 'jobs')} waiting, the oldest for ${waitLabel(waitOf(q))} (its limit is ${q.limitMinutes} ${plural(q.limitMinutes, 'minute', 'minutes')}).`,
    ),
  ];
  if (shown.length < n) {
    const more = n - shown.length;
    lines.push(
      `And ${more} more ${plural(more, 'queue', 'queues')}: Operations → Queues lists them.`,
    );
  }
  lines.push(
    'Jobs wait when the worker is stopped, busy with other work, or cannot reach the database. Look at the worker’s health and logs; Operations → Queues shows every queue’s counts and waits.',
    `This alert gives queue names and counts only. A queue is told again only after it has caught up and falls behind again; further alerts come at most every ${QUEUE_ALERT_INTERVAL_MINUTES} minutes.`,
  );
  const [first] = sorted;
  return {
    subject:
      n === 1 && first
        ? `Queue ${queueName(first.queue)} is falling behind`
        : `${n} queues are falling behind`,
    lines,
    url: new URL('/platform/ops/queues', appBaseUrl).toString(),
    actionLabel: 'Open queues',
  };
}

export interface LateQueueAlertDeps {
  db: Database;
  outbox: OutboxDeps;
  appBaseUrl: string;
}

export interface LateQueueAlertResult {
  /** Queues the email sent tells of (none when nothing was due, too soon, or another sweep sent it). */
  alerted: number;
  /** Late queues not emailed because there is no platform administrator to tell. */
  unsent: number;
  recipients: number;
  /** Whether the alert was also queued for the chat channel (ADR-338). */
  posted: boolean;
}

/**
 * The minute sweep's alert, after the check: when a queue became late and the last queue alert
 * went out at least 15 minutes ago, marks every late queue not yet told in the transaction that
 * queues one email to every platform administrator, and its post to the chat channel when one is
 * set. Nothing is marked while there is no platform administrator, so the alert goes out once
 * there is one, while the queue is still late.
 */
export async function alertLateQueues(deps: LateQueueAlertDeps): Promise<LateQueueAlertResult> {
  const due = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ due: number }>(sql`
        select count(*)::int as due from ops.queue_waits
         where late_since is not null and alerted_at is null
           and checked_at > now() - make_interval(mins => ${QUEUE_CHECK_FRESH_MINUTES})`),
    { accessMode: 'read only' },
  );
  const waiting = Number(due.rows[0]?.due ?? 0);
  if (waiting === 0) return { alerted: 0, unsent: 0, recipients: 0, posted: false };
  const recipients = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ user_id: string; email: string }>(
        sql`select user_id, email from ops.platform_failure_alert_recipients()`,
      ),
    { accessMode: 'read only' },
  );
  if (recipients.rows.length === 0) {
    return { alerted: 0, unsent: waiting, recipients: 0, posted: false };
  }
  return deps.db.run(systemScope, async (tx) => {
    const marked = await tx.execute<{
      queue: string;
      waiting: number;
      oldest_waiting_since: Date | string;
      limit_minutes: number;
      checked_at: Date | string;
    }>(
      sql`select queue, waiting, oldest_waiting_since, limit_minutes, checked_at
            from ops.mark_queue_alert()`,
    );
    const late: LateQueue[] = marked.rows.map((r) => ({
      queue: r.queue,
      waiting: Number(r.waiting),
      oldestWaitingSince: new Date(r.oldest_waiting_since),
      limitMinutes: Number(r.limit_minutes),
      checkedAt: new Date(r.checked_at),
    }));
    if (late.length === 0) {
      return { alerted: 0, unsent: 0, recipients: recipients.rows.length, posted: false };
    }
    const alert = lateQueueAlert(late, deps.appBaseUrl);
    for (const recipient of recipients.rows) {
      await enqueueEmail(deps.outbox, tx, {
        to: recipient.email,
        // About HyFib's own job queues, not a company's data.
        tenantId: null,
        payload: { kind: 'platform.notice', ...alert },
      });
    }
    const posted = await queueAlertPost(deps.outbox, tx, 'queues', alert);
    return { alerted: late.length, unsent: 0, recipients: recipients.rows.length, posted };
  });
}
