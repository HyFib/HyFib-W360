import type { Job } from 'pg-boss';
import {
  authorizeJob,
  findDueReminders,
  scheduleTaskReminder,
  sendTaskReminder,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';

/**
 * Emails a task reminder (see crm/reminders). The task row decides: a duplicate, early or stale
 * job does nothing, and a reminder whose job was lost is signalled again by the sweep.
 */
export function crmReminderHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'crm.reminder',
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome === 'deferred') {
      // Suspended company: the sweep signals the reminder again after reactivation.
      rt.logger.info({ jobId: job.id, taskId: auth.envelope.ref }, 'task reminder deferred');
      return;
    }
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'task reminder job dropped');
      return;
    }
    const outcome = await sendTaskReminder(
      { db: rt.db, clock: rt.clock, outbox: rt.notices.outbox, appBaseUrl: rt.notices.appBaseUrl },
      auth.scope,
      auth.envelope.ref,
    );
    rt.logger.info({ jobId: job.id, taskId: auth.envelope.ref, outcome }, 'task reminder');
  };
}

/** Signals reminders more than 30 seconds overdue whose job was lost. Called by the minute sweep. */
export async function sweepTaskReminders(rt: WorkerRuntime): Promise<number> {
  const due = await findDueReminders(rt.db);
  for (const reminder of due) {
    // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
    await scheduleTaskReminder(rt, null, {
      tenantId: reminder.tenantId,
      taskId: reminder.taskId,
      remindAt: reminder.remindAt,
    });
  }
  return due.length;
}
