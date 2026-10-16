import type { Job } from 'pg-boss';
import { QUEUES } from '@w360/contracts';
import { authorizeJob, findDueReportEmailCompanies, sendDueReportEmails } from '@w360/domain';
import type { WorkerRuntime } from '../runtime';

/**
 * Sends a company's due report emails (ADR-376). The members' rows decide: a duplicate or stale
 * job finds nothing due, and a company whose job failed is signalled again by the sweep an hour
 * after the attempt started.
 */
export function reportEmailHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'report.email',
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome === 'deferred') {
      // Suspended company: the sweep signals it again after reactivation; late emails are skipped.
      rt.logger.info({ jobId: job.id }, 'report emails deferred');
      return;
    }
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'report email job dropped');
      return;
    }
    const outcome = await sendDueReportEmails(
      { db: rt.db, clock: rt.clock, outbox: rt.notices.outbox, appBaseUrl: rt.notices.appBaseUrl },
      auth.scope,
    );
    rt.logger.info({ jobId: job.id, tenantId: auth.scope.tenantId, ...outcome }, 'report emails');
  };
}

/** Signals a job for each company with a report email due. Called by the minute sweep. */
export async function signalDueReportEmails(rt: WorkerRuntime): Promise<number> {
  const due = await findDueReportEmailCompanies(rt.db, rt.clock.now());
  for (const tenantId of due) {
    // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
    await rt.jobs.enqueue(
      null,
      QUEUES.reportEmail.name,
      rt.signer.sign({ kind: 'report.email', tenantId, actorUserId: null, ref: tenantId }),
      { singletonKey: `report-email:${tenantId}` },
    );
  }
  return due.length;
}
