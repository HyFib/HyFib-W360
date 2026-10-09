import { sql, systemScope, type Database } from '@w360/db';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { queueAlertPost } from './alert-channel';
import { INTEGRATION_SOURCE_LABELS, INTEGRATION_STATE_LABELS } from './ops-model';

/**
 * Alerts for companies' failing integrations (ADR-139): what the operations console's Integrations
 * page lists (ADR-054, ADR-137, ADR-138), read from the same rule (`ops.integration_failures`).
 * Every platform administrator hears of each failure once, by its integration and state, in one
 * email at most every 15 minutes (posted to the chat channel too when one is set, ADR-338), with
 * counts by kind only: the companies, labels and errors stay on the console behind platform
 * sign-in. A failure the console has not listed for an hour is forgotten, so the integration is
 * told again if it fails later.
 */

/** Minutes between two alerts at least; enforced by `ops.mark_integration_alert`. */
export const INTEGRATION_ALERT_INTERVAL_MINUTES = 15;

/** Kinds named in the email at most; the rest are counted together. */
const NAMED_KINDS = 6;

export interface IntegrationAlertDeps {
  db: Database;
  outbox: OutboxDeps;
  appBaseUrl: string;
}

/** What one alert tells: failures marked, by the console's source and state. */
export interface IntegrationAlertCount {
  source: string;
  state: string;
  items: number;
}

export interface IntegrationAlertResult {
  /**
   * Failures the email sent tells of (none when nothing was due, too soon, or another sweep sent
   * it).
   */
  alerted: number;
  /** Failures due but not emailed because there is no platform administrator to tell. */
  unsent: number;
  recipients: number;
  /** Whether the alert was also queued for the chat channel (ADR-338). */
  posted: boolean;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * A kind of failure as the console labels it, such as "WhatsApp number, needs reconnecting"; the
 * assignment notices (ADR-314) name kinds the same way.
 */
export function integrationKindLabel(source: string, state: string): string {
  const what = INTEGRATION_SOURCE_LABELS[source] ?? source;
  return `${what}, ${(INTEGRATION_STATE_LABELS[state] ?? state).toLowerCase()}`;
}

/** The email for the counts one alert marked; pure, so the wording is unit-tested. */
export function integrationAlert(
  counts: IntegrationAlertCount[],
  appBaseUrl: string,
): { subject: string; lines: string[]; url: string; actionLabel: string } {
  const kinds = counts
    .filter((c) => c.items > 0)
    .map((c) => ({ name: integrationKindLabel(c.source, c.state), items: c.items }))
    .sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));
  const total = kinds.reduce((sum, k) => sum + k.items, 0);
  const named = kinds.slice(0, NAMED_KINDS).map((k) => `${k.name} ${k.items}`);
  const rest = kinds.slice(NAMED_KINDS).reduce((sum, k) => sum + k.items, 0);
  const list = rest > 0 ? `${named.join('; ')} and ${rest} more` : named.join('; ');
  return {
    subject: `${total} company ${plural(total, 'integration is', 'integrations are')} failing`,
    lines: [
      `Operations → Integrations lists ${total} failing ${plural(total, 'integration', 'integrations')} of companies that platform staff were not alerted about yet: ${list}.`,
      `This alert gives counts only: the companies and errors are on the operations console. Each failure is told once while it lasts, and further alerts come at most every ${INTEGRATION_ALERT_INTERVAL_MINUTES} minutes.`,
    ],
    url: new URL('/platform/ops/integrations', appBaseUrl).toString(),
    actionLabel: 'Open integrations',
  };
}

/**
 * The minute sweep's alert: refreshes the marks of failures still listed and forgets those not
 * listed for an hour; when a listed failure was not told yet and the last integration alert went
 * out at least 15 minutes ago, marks the failures in the transaction that queues one email to every
 * platform administrator, and its post to the chat channel when one is set. Nothing is marked while
 * there is no platform administrator, so the alert goes out once there is one.
 */
export async function alertIntegrationFailures(
  deps: IntegrationAlertDeps,
): Promise<IntegrationAlertResult> {
  // Read and write: the check also keeps and forgets marks.
  const due = await deps.db.run(systemScope, (tx) =>
    tx.execute<{ due: number }>(sql`select ops.integration_alerts_due() as due`),
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
    const marked = await tx.execute<{ source: string; state: string; items: number }>(
      sql`select source, state, items from ops.mark_integration_alert()`,
    );
    const counts: IntegrationAlertCount[] = marked.rows.map((r) => ({
      source: r.source,
      state: r.state,
      items: Number(r.items),
    }));
    const alerted = counts.reduce((sum, c) => sum + c.items, 0);
    if (alerted === 0) {
      return { alerted: 0, unsent: 0, recipients: recipients.rows.length, posted: false };
    }
    const alert = integrationAlert(counts, deps.appBaseUrl);
    for (const recipient of recipients.rows) {
      await enqueueEmail(deps.outbox, tx, {
        to: recipient.email,
        // About companies' integrations as a whole, with no company's data.
        tenantId: null,
        payload: { kind: 'platform.notice', ...alert },
      });
    }
    const posted = await queueAlertPost(deps.outbox, tx, 'integrations', alert);
    return { alerted, unsent: 0, recipients: recipients.rows.length, posted };
  });
}
