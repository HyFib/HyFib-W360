import { sql, systemScope, type Database } from '@w360/db';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';

/**
 * Alerts for the daily settlement reconciliation (ADR-066). When a day's run finishes with
 * transactions waiting for a person, or fails, platform owners are emailed once about that attempt.
 * The minute billing sweep lists the attempts not emailed yet (run ids and attempt numbers only) and
 * marks each in the transaction that queues the emails; the mark returns what the email says. The
 * email names days, counts and errors, never a transaction or a company: those stay on Platform →
 * Reconciliation.
 */

/** Days in one email at most; the rest wait for the next sweep. */
export const RECON_ALERT_DAYS = 10;

export interface SettlementReconAlertDeps {
  db: Database;
  outbox: OutboxDeps;
  appBaseUrl: string;
}

/** A finished attempt as the email describes it. */
export interface SettlementReconAlertDay {
  /** The settlement day, YYYY-MM-DD. */
  date: string;
  status: 'completed' | 'failed';
  lastError: string | null;
  /** Transactions still waiting for a person, by status. */
  openMismatch: number;
  openReview: number;
  openNotHyfib: number;
}

export interface SettlementReconAlertResult {
  /** Days in the email sent (none when nothing was due, or another sweep sent them). */
  alerted: number;
  /** Days due but not emailed because there is no platform owner to tell. */
  unsent: number;
  recipients: number;
}

function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

function describe(day: SettlementReconAlertDay): string {
  const label = dayLabel(day.date);
  if (day.status === 'failed') {
    const error = day.lastError ? ` The last error: ${day.lastError.slice(0, 400)}` : '';
    return `${label}: the check failed and waits for a platform owner to run the day again.${error}`;
  }
  const open = day.openMismatch + day.openReview + day.openNotHyfib;
  const parts = [
    day.openMismatch === 0
      ? null
      : `${day.openMismatch} ${day.openMismatch === 1 ? 'does' : 'do'} not match HyFib’s records`,
    day.openReview === 0
      ? null
      : `${day.openReview} ${day.openReview === 1 ? 'needs' : 'need'} a look`,
    day.openNotHyfib === 0
      ? null
      : `${day.openNotHyfib} ${day.openNotHyfib === 1 ? 'is' : 'are'} not HyFib’s`,
  ].filter((part): part is string => part !== null);
  return `${label}: ${open} ${open === 1 ? 'transaction waits' : 'transactions wait'} for a person (${parts.join(', ')}).`;
}

/** The email about finished attempts, oldest day first. */
export function settlementReconAlert(
  days: readonly SettlementReconAlertDay[],
  appBaseUrl: string,
): { subject: string; lines: string[]; url: string; actionLabel: string } {
  const [only] = days;
  const subject =
    days.length === 1 && only
      ? only.status === 'failed'
        ? `Settlement reconciliation for ${dayLabel(only.date)} failed`
        : `Settlement reconciliation for ${dayLabel(only.date)} needs a person`
      : `Settlement reconciliation needs a person for ${days.length} days`;
  const path =
    days.length === 1 && only
      ? `/platform/reconciliation/${only.date}`
      : '/platform/reconciliation';
  return {
    subject,
    lines: [
      ...days.map(describe),
      'Platform owners resolve each transaction with a note, or run a failed day again, on Platform → Reconciliation.',
    ],
    url: new URL(path, appBaseUrl).toString(),
    actionLabel: 'Open reconciliation',
  };
}

/**
 * The minute sweep's alerts: emails every platform owner once about the finished attempts not
 * emailed yet. Nothing is marked while there is no platform owner, so the alert goes out once there
 * is one.
 */
export async function alertSettlementReconFindings(
  deps: SettlementReconAlertDeps,
  limit = RECON_ALERT_DAYS,
): Promise<SettlementReconAlertResult> {
  const due = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ run_id: string; attempt: number }>(
        sql`select run_id, attempt from ops.settlement_recon_alerts_due(${limit}::int)`,
      ),
    { accessMode: 'read only' },
  );
  if (due.rows.length === 0) return { alerted: 0, unsent: 0, recipients: 0 };
  const recipients = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ user_id: string; email: string }>(
        sql`select user_id, email from ops.settlement_recon_alert_recipients()`,
      ),
    { accessMode: 'read only' },
  );
  if (recipients.rows.length === 0) {
    return { alerted: 0, unsent: due.rows.length, recipients: 0 };
  }
  return deps.db.run(systemScope, async (tx) => {
    const days: SettlementReconAlertDay[] = [];
    for (const { run_id: runId, attempt } of due.rows) {
      const marked = await tx.execute<{
        settlement_date: string;
        status: 'completed' | 'failed';
        last_error: string | null;
        open_mismatch: number;
        open_review: number;
        open_not_hyfib: number;
      }>(
        sql`select settlement_date::text as settlement_date, status, last_error, open_mismatch,
                   open_review, open_not_hyfib
              from ops.settlement_recon_mark_alerted(${runId}::uuid, ${attempt}::int)`,
      );
      const row = marked.rows[0];
      if (!row) continue;
      days.push({
        date: row.settlement_date,
        status: row.status,
        lastError: row.last_error,
        openMismatch: Number(row.open_mismatch),
        openReview: Number(row.open_review),
        openNotHyfib: Number(row.open_not_hyfib),
      });
    }
    if (days.length === 0) return { alerted: 0, unsent: 0, recipients: recipients.rows.length };
    const alert = settlementReconAlert(days, deps.appBaseUrl);
    for (const recipient of recipients.rows) {
      await enqueueEmail(deps.outbox, tx, {
        to: recipient.email,
        // About HyFib's own settlements, not a company's data.
        tenantId: null,
        payload: { kind: 'platform.notice', ...alert },
      });
    }
    return { alerted: days.length, unsent: 0, recipients: recipients.rows.length };
  });
}

/**
 * Alerts for payments no settlement showed (ADR-071): platform owners are emailed once about each
 * paid top-up on the unsettled list of Platform → Reconciliation (7 days after its payment, with
 * every day since reconciled). The email gives how many and on which days they were paid, never a
 * company, an amount or a payment id: those stay on the page.
 */

/** Payments recorded per sweep at most; the rest wait for the next sweep. */
export const UNSETTLED_ALERT_PAYMENTS = 50;

export interface UnsettledAlertResult {
  /** Payments in the email sent (none when nothing was due, or another sweep recorded them). */
  alerted: number;
  /** Payments due but not emailed because there is no platform owner to tell. */
  unsent: number;
  recipients: number;
}

/** A calendar day in India time, where Razorpay's settlement days are counted. */
function indiaDayLabel(at: Date): string {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(
    at,
  );
}

/** The email about newly unsettled payments, given their payment times. */
export function unsettledPaymentsAlert(
  paidAt: readonly Date[],
  appBaseUrl: string,
): { subject: string; lines: string[]; url: string; actionLabel: string } {
  const sorted = [...paidAt].sort((a, b) => a.getTime() - b.getTime());
  const count = sorted.length;
  const first = indiaDayLabel(sorted[0] ?? new Date(0));
  const last = indiaDayLabel(sorted[count - 1] ?? new Date(0));
  const when = first === last ? `on ${first}` : `from ${first} to ${last}`;
  return {
    subject:
      count === 1
        ? 'A paid top-up was not settled within 7 days'
        : `${count} paid top-ups were not settled within 7 days`,
    lines: [
      `${count === 1 ? 'A top-up' : `${count} top-ups`} paid ${when} (India time) ${count === 1 ? 'was' : 'were'} in no settlement Razorpay reported for the 7 days after payment, although every one of those days was reconciled.`,
      'Razorpay may be holding a payment, it may have been refunded or disputed in the Razorpay Dashboard, or HyFib’s records may be wrong: check each payment in the Razorpay Dashboard.',
      'Platform → Reconciliation lists them under “Payments not seen in a settlement”, with their companies, amounts and Razorpay payment ids.',
    ],
    url: new URL('/platform/reconciliation', appBaseUrl).toString(),
    actionLabel: 'Open reconciliation',
  };
}

/**
 * The minute sweep's alert about unsettled payments: emails every platform owner once about the
 * payments on the list not emailed yet. Nothing is recorded while there is no platform owner, so the
 * alert goes out once there is one.
 */
export async function alertUnsettledPayments(
  deps: SettlementReconAlertDeps,
  limit = UNSETTLED_ALERT_PAYMENTS,
): Promise<UnsettledAlertResult> {
  const due = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ payment_id: string }>(
        sql`select payment_id from ops.settlement_unsettled_alerts_due(${limit}::int)`,
      ),
    { accessMode: 'read only' },
  );
  if (due.rows.length === 0) return { alerted: 0, unsent: 0, recipients: 0 };
  const recipients = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ user_id: string; email: string }>(
        sql`select user_id, email from ops.settlement_recon_alert_recipients()`,
      ),
    { accessMode: 'read only' },
  );
  if (recipients.rows.length === 0) {
    return { alerted: 0, unsent: due.rows.length, recipients: 0 };
  }
  const ids = due.rows.map((r) => r.payment_id);
  return deps.db.run(systemScope, async (tx) => {
    const marked = await tx.execute<{ payment_id: string; paid_at: Date | string }>(
      sql`select payment_id, paid_at from ops.settlement_mark_unsettled_alerted(${sql.param(ids)}::text[])`,
    );
    if (marked.rows.length === 0) {
      return { alerted: 0, unsent: 0, recipients: recipients.rows.length };
    }
    const alert = unsettledPaymentsAlert(
      marked.rows.map((r) => new Date(r.paid_at)),
      deps.appBaseUrl,
    );
    for (const recipient of recipients.rows) {
      await enqueueEmail(deps.outbox, tx, {
        to: recipient.email,
        // About HyFib's own settlements, not a company's data.
        tenantId: null,
        payload: { kind: 'platform.notice', ...alert },
      });
    }
    return { alerted: marked.rows.length, unsent: 0, recipients: recipients.rows.length };
  });
}
