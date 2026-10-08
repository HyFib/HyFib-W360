import { sql, systemScope } from '@w360/db';
import { enqueueEmail } from '../email/outbox';
import { integrationKindLabel, type IntegrationAlertDeps } from './integration-alerts';

/**
 * Emails a platform administrator the failing integrations other administrators assigned to them
 * on the operations console (ADR-314, after ADR-313): the worker's minute sweep tells each assignee
 * once, in one email for the failures assigned since its last run, with counts by kind and who
 * assigned them, as the alert emails do (ADR-139): the companies, labels and errors stay on the
 * console behind platform sign-in. An administrator who assigns a failure to themselves is not
 * emailed, nor is one whose failure recovered before the sweep.
 */

/** Kinds named in the email at most; the rest are counted together, as the alerts do. */
const NAMED_KINDS = 6;

/** One assignment to tell of, as `ops.claim_integration_assignment_notices` returns it. */
export interface AssignmentNoticeRow {
  assigneeUserId: string;
  email: string;
  assignedByUserId: string;
  assignedByName: string;
  source: string;
  state: string;
}

export interface AssignmentNoticeResult {
  /** Assignments the emails queued tell of. */
  told: number;
  /** Administrators emailed. */
  recipients: number;
}

/**
 * The email that tells one administrator of the failures assigned to them; pure, so the wording is
 * unit-tested. Kinds are named as the console names them, the most first; the administrator who
 * assigned them is named when there is one, and counted when there are several.
 */
export function assignmentNotice(
  assignments: readonly Pick<
    AssignmentNoticeRow,
    'assignedByUserId' | 'assignedByName' | 'source' | 'state'
  >[],
  appBaseUrl: string,
): { subject: string; lines: string[]; url: string; actionLabel: string } {
  const counts = new Map<string, number>();
  for (const a of assignments) {
    const kind = integrationKindLabel(a.source, a.state);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const kinds = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  const named = kinds.slice(0, NAMED_KINDS).map(([kind, n]) => `${kind} ${n}`);
  const rest = kinds.slice(NAMED_KINDS).reduce((sum, [, n]) => sum + n, 0);
  const list = rest > 0 ? `${named.join('; ')} and ${rest} more` : named.join('; ');
  const total = assignments.length;
  const assigners = new Map(assignments.map((a) => [a.assignedByUserId, a.assignedByName]));
  const who =
    assigners.size === 1 ? [...assigners.values()].join('') : `${assigners.size} administrators`;
  return {
    subject:
      total === 1
        ? 'A failing integration was assigned to you'
        : `${total} failing integrations were assigned to you`,
    lines: [
      `${who} assigned you ${total === 1 ? 'a failing integration' : `${total} failing integrations`} on the operations console.`,
      `By kind: ${list}.`,
      'This email gives counts only: the companies and errors are on the operations console. Failures you assign to yourself are not emailed.',
    ],
    url: new URL('/platform/ops/integrations', appBaseUrl).toString(),
    actionLabel: 'Open integrations',
  };
}

/**
 * The minute sweep's notices: claims every assignment not told yet (`ops.claim_integration_
 * assignment_notices` marks them told and returns those still listed whose assignee is still an
 * administrator) and, in the same transaction, queues one email to each assignee. A failure of the
 * email's transaction leaves the assignments untold, for the next sweep.
 */
export async function noticeIntegrationAssignments(
  deps: IntegrationAlertDeps,
): Promise<AssignmentNoticeResult> {
  return deps.db.run(systemScope, async (tx) => {
    const claimed = await tx.execute<{
      assignee_user_id: string;
      email: string;
      assigned_by_user_id: string;
      assigned_by_name: string;
      source: string;
      state: string;
    }>(
      sql`select assignee_user_id, email, assigned_by_user_id, assigned_by_name, source, state
            from ops.claim_integration_assignment_notices()`,
    );
    const byAssignee = new Map<string, { email: string; rows: AssignmentNoticeRow[] }>();
    for (const r of claimed.rows) {
      const assignee = byAssignee.get(r.assignee_user_id) ?? { email: r.email, rows: [] };
      assignee.rows.push({
        assigneeUserId: r.assignee_user_id,
        email: r.email,
        assignedByUserId: r.assigned_by_user_id,
        assignedByName: r.assigned_by_name,
        source: r.source,
        state: r.state,
      });
      byAssignee.set(r.assignee_user_id, assignee);
    }
    for (const { email, rows } of byAssignee.values()) {
      await enqueueEmail(deps.outbox, tx, {
        to: email,
        // About the console's failures, with no company's data.
        tenantId: null,
        payload: { kind: 'platform.notice', ...assignmentNotice(rows, deps.appBaseUrl) },
      });
    }
    return { told: claimed.rows.length, recipients: byAssignee.size };
  });
}
