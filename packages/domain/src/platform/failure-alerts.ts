import { sql, systemScope, type Database } from '@w360/db';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { queueAlertPost } from './alert-channel';
import { QUARANTINE_REASON_LABELS, WEBHOOK_PROVIDER_LABELS } from './ops-model';

/**
 * Alerts for work that failed for good (ADR-091): jobs the dead-letter queue received, Meta and
 * Razorpay webhook receipts that used all their processing attempts (the sweeper stops at
 * `MAX_RECEIPT_ATTEMPTS`) and provider events that could not be matched to a company. The
 * operations console lists them (ADR-054); this tells every platform administrator, once per item,
 * in one email at most every 15 minutes, and posts the same text to the chat channel when one is
 * set (ADR-338). The alert gives counts by queue, provider and reason, never a company, a receipt
 * or an error: those stay on the console behind platform sign-in.
 */

/** Minutes between two alerts at least; enforced by `ops.mark_failure_alert`. */
export const FAILURE_ALERT_INTERVAL_MINUTES = 15;

/** Entries named per line at most; the rest are counted together. */
const NAMED_PER_LINE = 6;

/**
 * Characters of a queue's name shown at most. A dead letter's queue can be named with up to 100
 * characters, and a line longer than a notice's 600 would fail the email, and so the alert, at every
 * sweep. Providers and reasons are the few the tables allow, all labelled.
 */
const QUEUE_NAME_MAX = 40;

function queueName(name: string): string {
  return name.length > QUEUE_NAME_MAX ? `${name.slice(0, QUEUE_NAME_MAX - 1)}…` : name;
}

export interface FailureAlertDeps {
  db: Database;
  outbox: OutboxDeps;
  appBaseUrl: string;
}

/** What one alert tells: items marked, by source and label. */
export interface FailureAlertCount {
  source: 'dead_letter' | 'receipt' | 'quarantine';
  /** The dead letter's queue, the receipt's provider, or the quarantine's provider and reason. */
  label: string;
  items: number;
}

export interface FailureAlertResult {
  /** Items the email sent tells of (none when nothing was due, too soon, or another sweep sent it). */
  alerted: number;
  /** Items due but not emailed because there is no platform administrator to tell. */
  unsent: number;
  recipients: number;
  /** Whether the alert was also queued for the chat channel (ADR-338). */
  posted: boolean;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function listed(entries: { name: string; items: number }[]): string {
  const sorted = [...entries].sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));
  const named = sorted.slice(0, NAMED_PER_LINE).map((e) => `${e.name} ${e.items}`);
  const rest = sorted.slice(NAMED_PER_LINE).reduce((sum, e) => sum + e.items, 0);
  return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}

const providerLabel = (provider: string) => WEBHOOK_PROVIDER_LABELS[provider] ?? provider;

/** The email for the counts one alert marked; pure, so the wording is unit-tested. */
export function failureAlert(
  counts: FailureAlertCount[],
  appBaseUrl: string,
): { subject: string; lines: string[]; url: string; actionLabel: string } {
  const bySource = (source: FailureAlertCount['source']) =>
    counts.filter((c) => c.source === source && c.items > 0);
  const deadLetters = bySource('dead_letter');
  const receipts = bySource('receipt');
  const quarantine = bySource('quarantine');
  const total = (list: FailureAlertCount[]) => list.reduce((sum, c) => sum + c.items, 0);
  const all = total(deadLetters) + total(receipts) + total(quarantine);
  const lines: string[] = [];
  if (deadLetters.length > 0) {
    const n = total(deadLetters);
    lines.push(
      `${n} ${plural(n, 'job', 'jobs')} used all ${plural(n, 'its', 'their')} retries and went to the dead-letter queue: ${listed(deadLetters.map((c) => ({ name: queueName(c.label), items: c.items })))}. The minute sweeps signal most work again, so look for the cause in the worker’s logs. Operations → Queues lists them.`,
    );
  }
  if (receipts.length > 0) {
    const n = total(receipts);
    lines.push(
      `${n} provider webhook ${plural(n, 'receipt', 'receipts')} used all 12 processing attempts: ${listed(receipts.map((c) => ({ name: providerLabel(c.label), items: c.items })))}. Once the cause is fixed, retry ${plural(n, 'it', 'them')} on Operations → Integrations within 7 days of receipt, while ${plural(n, 'its body is', 'their bodies are')} kept.`,
    );
  }
  if (quarantine.length > 0) {
    const n = total(quarantine);
    const entries = quarantine.map((c) => {
      const [provider = '', reason = ''] = c.label.split(':');
      return {
        name: `${providerLabel(provider)}, ${(QUARANTINE_REASON_LABELS[reason] ?? reason).toLowerCase()}`,
        items: c.items,
      };
    });
    lines.push(
      `${n} provider ${plural(n, 'event', 'events')} could not be matched to a company: ${listed(entries)}. Review ${plural(n, 'it', 'them')} on Operations → Integrations.`,
    );
  }
  lines.push(
    `This alert gives counts only: the companies, receipts and errors are on the operations console. Further alerts come at most every ${FAILURE_ALERT_INTERVAL_MINUTES} minutes.`,
  );
  const path =
    receipts.length === 0 && quarantine.length === 0
      ? '/platform/ops/queues'
      : deadLetters.length === 0
        ? '/platform/ops/integrations'
        : '/platform/ops';
  return {
    subject: `${all} ${plural(all, 'failure needs', 'failures need')} a look`,
    lines,
    url: new URL(path, appBaseUrl).toString(),
    actionLabel: 'Open operations',
  };
}

/**
 * The minute sweep's alert: when anything waits and the last alert went out at least 15 minutes
 * ago, marks it all in the transaction that queues one email to every platform administrator, and
 * its post to the chat channel when one is set. Nothing is marked while there is no platform
 * administrator, so the alert goes out once there is one.
 */
export async function alertFailures(deps: FailureAlertDeps): Promise<FailureAlertResult> {
  const due = await deps.db.run(
    systemScope,
    (tx) => tx.execute<{ due: number }>(sql`select ops.failure_alerts_due() as due`),
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
    const marked = await tx.execute<{ source: string; label: string; items: number }>(
      sql`select source, label, items from ops.mark_failure_alert()`,
    );
    const counts: FailureAlertCount[] = marked.rows.map((r) => ({
      source: r.source as FailureAlertCount['source'],
      label: r.label,
      items: Number(r.items),
    }));
    const alerted = counts.reduce((sum, c) => sum + c.items, 0);
    if (alerted === 0) {
      return { alerted: 0, unsent: 0, recipients: recipients.rows.length, posted: false };
    }
    const alert = failureAlert(counts, deps.appBaseUrl);
    for (const recipient of recipients.rows) {
      await enqueueEmail(deps.outbox, tx, {
        to: recipient.email,
        // About HyFib's own jobs and provider events, not a company's data.
        tenantId: null,
        payload: { kind: 'platform.notice', ...alert },
      });
    }
    const posted = await queueAlertPost(deps.outbox, tx, 'failures', alert);
    return { alerted, unsent: 0, recipients: recipients.rows.length, posted };
  });
}
