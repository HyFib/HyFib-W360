import type { Job } from 'pg-boss';
import { ALL_QUEUES, QUEUES } from '@w360/contracts';
import { toError } from '@w360/core';
import { authorizedTenantScope } from '@w360/db';
import {
  alertFailures,
  alertLateQueues,
  applyMessagingRetention,
  authorizeJob,
  cancelSendIntent,
  checkQueueWaits,
  findStaleReceipts,
  findStaleSendIntents,
  noticeApiKeyUsageDue,
  processChannelOnboarding,
  processMetaWebhookReceipt,
  processSendIntent,
  purgeApiIdempotencyKeys,
  purgeDeadLetters,
  purgeRateLimitBuckets,
  queueWaitLimits,
  recoverExpiredSend,
  remindExpiringApiKeys,
  routeDueConversations,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';
import { sweepAutomationRuns } from './automations';
import { sweepTaskReminders } from './crm';
import { signalDueCampaigns } from './campaigns';
import { RetryableJobError } from './email';
import { signalDueTemplateSyncs } from './templates';
import { sweepCommerceWork } from './commerce';
import { sweepStoreMessages, sweepStoreWork } from './stores';
import { sweepFlowWork } from './flows';
import { sweepWebhooks } from './webhooks';

/** Processes one stored Meta webhook receipt (idempotent; see processMetaWebhookReceipt). */
export function webhookProcessHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'webhook.process',
      requireActiveTenant: false,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || auth.envelope.tenantId !== null) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'webhook job dropped');
      return;
    }
    const outcome = await processMetaWebhookReceipt(
      { db: rt.db, keyring: rt.keyring, clock: rt.clock, jobs: rt.jobs, signer: rt.signer },
      auth.envelope.ref,
    );
    rt.logger.info({ jobId: job.id, receiptId: auth.envelope.ref, outcome }, 'webhook processed');
  };
}

/**
 * Sends one queued message. Retries and deferrals are scheduled by signalling the durable intent
 * again at its next attempt time; the intent row, not the job, is the source of truth.
 */
export function messageSendHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'message.send',
      requireActiveTenant: true,
      requireActiveActor: true,
    });
    if (auth.outcome === 'deferred' || (auth.outcome === 'rejected' && 'cleanupScope' in auth)) {
      const suspended = auth.outcome === 'deferred';
      const canceled = await cancelSendIntent(
        rt.db,
        auth.cleanupScope,
        auth.envelope.ref,
        suspended
          ? { code: 'company_suspended', message: 'Not sent: the company is suspended.' }
          : { code: 'sender_removed', message: 'Not sent: the sender is no longer a member.' },
        rt.clock,
      );
      rt.logger.info({ jobId: job.id, reason: auth.reason, canceled }, 'send intent stopped');
      return;
    }
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'send job dropped');
      return;
    }
    if (!rt.graph) throw new RetryableJobError('Meta is not configured');
    const intentId = auth.envelope.ref;
    const result = await processSendIntent(
      {
        db: rt.db,
        keyring: rt.keyring,
        graph: rt.graph,
        clock: rt.clock,
        rate: rt.sendRate,
        jobs: rt.jobs,
        signer: rt.signer,
      },
      auth.scope,
      intentId,
    );
    rt.logger.info({ jobId: job.id, intentId, outcome: result.outcome }, 'send intent processed');
    if (result.retryAt) {
      await rt.jobs.enqueue(
        null,
        QUEUES.messageSend.name,
        rt.signer.sign({
          kind: 'message.send',
          tenantId: auth.scope.tenantId,
          actorUserId: auth.envelope.actorUserId,
          ref: intentId,
        }),
        {
          singletonKey: `${intentId}:${result.retryAt.getTime()}`,
          startAfter: result.retryAt,
          ...(result.channelAccountId ? { group: { id: result.channelAccountId } } : {}),
        },
      );
    }
  };
}

/** Advances number setup (subscribe app, register number, health check). */
export function channelOnboardHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'channel.onboard',
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'onboarding job dropped');
      return;
    }
    if (!rt.graph) throw new RetryableJobError('Meta is not configured');
    const outcome = await processChannelOnboarding(
      { db: rt.db, keyring: rt.keyring, graph: rt.graph, clock: rt.clock },
      auth.scope,
      auth.envelope.ref,
    );
    rt.logger.info(
      { jobId: job.id, channelAccountId: auth.envelope.ref, outcome },
      'onboarding step',
    );
    if (outcome === 'retry') throw new RetryableJobError('transient provider failure during setup');
  };
}

/**
 * Every minute: re-signal webhook receipts and send intents whose signal was lost, settle send
 * intents whose worker died (before dispatch: re-queued; after dispatch: unknown outcome, never an
 * automatic resend), signal automation runs and task reminders that are due or lost their
 * signal, route waiting conversations of round-robin teams, remind companies of API keys that
 * expire soon, delete rate limit buckets that are full again, alert platform staff to work that
 * failed for good, and check how long jobs wait in each queue.
 */
export function messagingSweepHandler(rt: WorkerRuntime) {
  return async (): Promise<void> => {
    const receipts = await findStaleReceipts(rt);
    for (const id of receipts) {
      await rt.jobs.enqueue(
        null,
        QUEUES.webhookProcess.name,
        rt.signer.sign({ kind: 'webhook.process', tenantId: null, actorUserId: null, ref: id }),
        { singletonKey: id },
      );
    }
    const intents = await findStaleSendIntents(rt.db);
    let recovered = 0;
    for (const intent of intents) {
      // Tenant ids here come from the database (SECURITY DEFINER sweep query), not from a payload.
      const scope = authorizedTenantScope(intent.tenantId, null);
      const recovery = await recoverExpiredSend(rt, scope, intent.id);
      if (recovery === 'unknown_outcome') {
        recovered += 1;
        continue;
      }
      await rt.jobs.enqueue(
        null,
        QUEUES.messageSend.name,
        rt.signer.sign({
          kind: 'message.send',
          tenantId: intent.tenantId,
          actorUserId: intent.actorUserId,
          ref: intent.id,
        }),
        { singletonKey: intent.id, group: { id: intent.channelAccountId } },
      );
    }
    const templateSyncs = await signalDueTemplateSyncs(rt);
    if (templateSyncs > 0) rt.logger.info({ templateSyncs }, 'template syncs signalled');
    const flowWork = await sweepFlowWork(rt);
    if (flowWork > 0) rt.logger.info({ flowWork }, 'flow work signalled');
    const commerceWork = await sweepCommerceWork(rt);
    if (commerceWork > 0) rt.logger.info({ commerceWork }, 'commerce work signalled');
    const storeWork = await sweepStoreWork(rt);
    if (storeWork > 0) rt.logger.info({ storeWork }, 'store work signalled');
    const storeMessages = await sweepStoreMessages(rt);
    if (storeMessages > 0) rt.logger.info({ storeMessages }, 'store messages signalled');
    const campaignTicks = await signalDueCampaigns(rt);
    if (campaignTicks > 0) rt.logger.info({ campaignTicks }, 'campaign ticks signalled');
    const automations = await sweepAutomationRuns(rt);
    if (automations.signalled > 0) rt.logger.info(automations, 'automation runs signalled');
    const reminders = await sweepTaskReminders(rt);
    if (reminders > 0) rt.logger.info({ reminders }, 'task reminders signalled');
    const routed = await routeDueConversations(rt.db);
    if (routed > 0) rt.logger.info({ routed }, 'waiting conversations assigned');
    const retention = await applyMessagingRetention(rt.db);
    if (retention.bodiesErased + retention.receiptsDeleted + retention.eventsPruned > 0) {
      rt.logger.info(retention, 'messaging retention applied');
    }
    const idempotencyKeys = await purgeApiIdempotencyKeys(rt.db);
    if (idempotencyKeys > 0)
      rt.logger.info({ idempotencyKeys }, 'expired API idempotency keys deleted');
    // Reminders before API keys expire (ADR-067).
    const keyReminders = await remindExpiringApiKeys({
      db: rt.db,
      clock: rt.clock,
      notices: rt.notices,
    });
    for (const failure of keyReminders.failed) {
      rt.logger.warn(
        { tenantId: failure.tenantId, keyId: failure.keyId, err: toError(failure.error).message },
        'API key expiry reminder failed; will retry',
      );
    }
    if (keyReminders.reminded > 0)
      rt.logger.info({ reminded: keyReminders.reminded }, 'API key expiry reminders emailed');
    // Emails at 80% and at a key's own monthly limit (ADR-098).
    const keyUsage = await noticeApiKeyUsageDue({
      db: rt.db,
      clock: rt.clock,
      notices: rt.notices,
    });
    for (const failure of keyUsage.failed) {
      rt.logger.warn(
        {
          tenantId: failure.tenantId,
          usageId: failure.usageId,
          err: toError(failure.error).message,
        },
        'API key usage email failed; will retry',
      );
    }
    if (keyUsage.warned + keyUsage.reached > 0)
      rt.logger.info(
        { warned: keyUsage.warned, reached: keyUsage.reached },
        'API key usage emails queued',
      );
    // Token buckets that are full again limit nothing (ADR-068).
    const buckets = await purgeRateLimitBuckets(rt.db);
    if (buckets > 0) rt.logger.info({ buckets }, 'full rate limit buckets deleted');
    const deadLettersPurged = await purgeDeadLetters(rt.db);
    if (deadLettersPurged > 0) rt.logger.info({ deadLettersPurged }, 'old dead letters deleted');
    const webhooks = await sweepWebhooks(rt);
    if (webhooks.woken + webhooks.purged > 0) rt.logger.info(webhooks, 'webhook sweep');
    if (receipts.length > 0 || intents.length > 0) {
      rt.logger.info(
        { receipts: receipts.length, intents: intents.length, unknownOutcomes: recovered },
        'messaging sweep',
      );
    }
    // Dead letters, receipts that used all their attempts and unmatched provider events: platform
    // staff hear of each once, at most every 15 minutes (ADR-091). Last, so that a failure here
    // holds back none of the sweep's other work.
    const failures = await alertFailures({
      db: rt.db,
      outbox: rt.notices.outbox,
      appBaseUrl: rt.notices.appBaseUrl,
    });
    if (failures.alerted > 0) {
      rt.logger.info(
        { items: failures.alerted, recipients: failures.recipients },
        'failure alert emailed to platform staff',
      );
    }
    if (failures.unsent > 0) {
      rt.logger.warn(
        { items: failures.unsent },
        'work failed for good but there is no platform administrator to email',
      );
    }
    // How long jobs wait in each queue; platform staff hear of a queue that falls behind once, at
    // most every 15 minutes, and again only after it caught up (ADR-096).
    const waits = await checkQueueWaits(rt.db, queueWaitLimits(ALL_QUEUES));
    if (waits.late > 0) rt.logger.warn({ lateQueues: waits.late }, 'job queues are late');
    const lateQueues = await alertLateQueues({
      db: rt.db,
      outbox: rt.notices.outbox,
      appBaseUrl: rt.notices.appBaseUrl,
    });
    if (lateQueues.alerted > 0) {
      rt.logger.info(
        { queues: lateQueues.alerted, recipients: lateQueues.recipients },
        'late queue alert emailed to platform staff',
      );
    }
    if (lateQueues.unsent > 0) {
      rt.logger.warn(
        { queues: lateQueues.unsent },
        'job queues are late but there is no platform administrator to email',
      );
    }
  };
}
