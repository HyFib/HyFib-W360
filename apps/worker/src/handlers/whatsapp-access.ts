import type { Job } from 'pg-boss';
import { toError } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  authorizeJob,
  checkAccessAndRefreshNumbers,
  findAccessChecksDue,
  type NumberFactsRefresh,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';
import { RetryableJobError } from './email';

/**
 * Checks one WhatsApp account's access with `debug_token` (ADR-137) and, once Meta admits the token,
 * its webhook subscription (ADR-138) and then the facts of its active numbers due a refresh
 * (ADR-402). A check that could not be made is recorded on the account and logged, and the minute
 * sweep signals it again after 30 minutes; only a failure of the access check itself (the database,
 * a crash) is retried by pg-boss. A number whose facts could not be read is logged and read again
 * at the next check; an error of the refresh is logged and never fails the job.
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
    const {
      access: result,
      numbers,
      numbersError,
    } = await checkAccessAndRefreshNumbers(
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
    if (result.outcome === 'paused') {
      // Meta throttles the account's management calls (ADR-399): the sweep signals the check
      // again once the pause ends.
      rt.logger.info(
        { ...facts, pausedUntil: result.pausedUntil },
        'WhatsApp access check deferred: Meta is limiting management requests',
      );
    } else if (result.outcome === 'not_checked') {
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
    if (numbersError !== undefined) {
      rt.logger.error(
        { ...facts, err: toError(numbersError).message },
        'WhatsApp numbers’ facts could not be refreshed; the next check tries again',
      );
    } else if (numbers) {
      logNumberFacts(rt, facts, numbers);
    }
  };
}

/** What the refresh of an account's numbers' facts did (ADR-402). */
function logNumberFacts(
  rt: WorkerRuntime,
  facts: Record<string, unknown>,
  refresh: NumberFactsRefresh,
): void {
  for (const number of refresh.numbers) {
    if (number.state === 'failed') {
      rt.logger.warn(
        {
          ...facts,
          channelAccountId: number.channelAccountId,
          kind: number.kind,
          error: number.error,
        },
        'WhatsApp number’s facts could not be read from Meta; the next check tries again',
      );
    }
  }
  const counts = {
    refreshed: refresh.numbers.filter((n) => n.state === 'refreshed').length,
    failed: refresh.numbers.filter((n) => n.state === 'failed').length,
    left: refresh.left,
  };
  if (refresh.outcome === 'paused') {
    rt.logger.info(
      { ...facts, ...counts, pausedUntil: refresh.pausedUntil },
      'WhatsApp numbers’ facts refresh stopped: Meta is limiting management requests',
    );
  } else if (refresh.numbers.length > 0 || refresh.left > 0) {
    rt.logger.info({ ...facts, ...counts }, 'WhatsApp numbers’ facts refreshed');
  }
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
