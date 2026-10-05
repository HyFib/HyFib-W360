import type { Job } from 'pg-boss';
import { QUEUES } from '@w360/contracts';
import { authorizeJob, checkWhatsAppAccess, findAccessChecksDue } from '@w360/domain';
import type { WorkerRuntime } from '../runtime';
import { RetryableJobError } from './email';

/**
 * Checks one WhatsApp account's access with `debug_token` (ADR-137) and, once Meta admits the token,
 * its webhook subscription (ADR-138). A check that could not be made is recorded on the account and
 * logged, and the minute sweep signals it again after 30 minutes; only a failure of the job itself
 * (the database, a crash) is retried by pg-boss.
 */
export function whatsappAccessCheckHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'whatsapp.access_check',
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'access check job dropped');
      return;
    }
    if (!rt.graph || !rt.meta) throw new RetryableJobError('Meta is not configured');
    const result = await checkWhatsAppAccess(
      {
        db: rt.db,
        keyring: rt.keyring,
        graph: rt.graph,
        clock: rt.clock,
        meta: { appId: rt.meta.appId, appSecret: rt.meta.appSecret },
        notices: rt.notices,
      },
      auth.scope,
      auth.envelope.ref,
    );
    const facts = {
      jobId: job.id,
      tenantId: auth.scope.tenantId,
      whatsappAccountId: auth.envelope.ref,
      outcome: result.outcome,
      ...(result.webhooks ? { webhooks: result.webhooks.state } : {}),
    };
    const webhooksError =
      result.webhooks && 'error' in result.webhooks ? result.webhooks.error : undefined;
    if (result.outcome === 'not_checked') {
      rt.logger.warn({ ...facts, error: result.error }, 'WhatsApp access could not be checked');
    } else if (result.outcome === 'lost') {
      rt.logger.warn(facts, 'WhatsApp access lost; the company was asked to reconnect');
    } else if (webhooksError) {
      // The webhook subscription could not be checked, or could not be restored (ADR-138).
      rt.logger.warn(
        { ...facts, error: webhooksError },
        'WhatsApp webhook subscription not confirmed',
      );
    } else {
      rt.logger.info(facts, 'WhatsApp access checked');
    }
  };
}

/** Signals a check for every account due one (called from the messaging sweep). */
export async function signalDueAccessChecks(rt: WorkerRuntime): Promise<number> {
  if (!rt.graph || !rt.meta) return 0;
  const due = await findAccessChecksDue(rt.db);
  for (const item of due) {
    // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
    await rt.jobs.enqueue(
      null,
      QUEUES.whatsappAccessCheck.name,
      rt.signer.sign({
        kind: 'whatsapp.access_check',
        tenantId: item.tenantId,
        actorUserId: null,
        ref: item.whatsappAccountId,
      }),
      { singletonKey: `access:${item.whatsappAccountId}` },
    );
  }
  return due.length;
}
