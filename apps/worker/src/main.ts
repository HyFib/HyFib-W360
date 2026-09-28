import { QUEUES } from '@w360/contracts';
import { toError } from '@w360/core';
import { startHealthServer } from './health';
import {
  autoRechargeHandler,
  billingEventProcessHandler,
  billingSweepHandler,
} from './handlers/billing';
import { automationHttpHandler, automationRunHandler } from './handlers/automations';
import { campaignRunHandler } from './handlers/campaigns';
import { crmReminderHandler } from './handlers/crm';
import { emailSendHandler, outboxSweepHandler } from './handlers/email';
import { flowKeysHandler, flowSyncHandler } from './handlers/flows';
import {
  commerceAccountHandler,
  commerceLinkHandler,
  commerceSyncHandler,
} from './handlers/commerce';
import { commerceStoreHandler, commerceStoreMessageHandler } from './handlers/stores';
import {
  channelOnboardHandler,
  messageSendHandler,
  messagingSweepHandler,
  webhookProcessHandler,
} from './handlers/messaging';
import {
  templateDeleteHandler,
  templateSubmitHandler,
  templateSyncHandler,
} from './handlers/templates';
import { deadLetterHandler } from './handlers/dead-letters';
import { tenantDeleteHandler } from './handlers/tenancy';
import { webhookDeliverHandler } from './handlers/webhooks';
import { logFailures } from './job-log';
import { createWorkerRuntime } from './runtime';
import { startWebhookListener } from './webhook-listener';

/**
 * Worker process: consumes durable jobs. Safe to run several replicas; pg-boss claims each job
 * with SKIP LOCKED and exclusive queues collapse duplicate signals. On SIGTERM it stops fetching,
 * waits for in-flight jobs (bounded), then closes connections.
 */
async function main(): Promise<void> {
  const rt = await createWorkerRuntime();
  let stopping = false;
  const health = startHealthServer(rt, () => stopping);

  await rt.boss.start();
  const concurrency = rt.config.WORKER_CONCURRENCY;
  await rt.boss.work(
    QUEUES.emailSend.name,
    { localConcurrency: concurrency, batchSize: 1 },
    logFailures(rt, QUEUES.emailSend.name, emailSendHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.outboxSweep.name,
    { localConcurrency: 1, batchSize: 1 },
    logFailures(rt, QUEUES.outboxSweep.name, outboxSweepHandler(rt)),
  );
  await rt.boss.schedule(QUEUES.outboxSweep.name, '* * * * *', null, {
    singletonKey: 'outbox-sweep',
  });
  // Conversational latency: an inbound message, each bot message and the automation step after it
  // pass through these three queues, so they are polled every second (pg-boss's default is 2 s).
  await rt.boss.work(
    QUEUES.webhookProcess.name,
    { localConcurrency: concurrency, batchSize: 1, pollingIntervalSeconds: 1 },
    logFailures(rt, QUEUES.webhookProcess.name, webhookProcessHandler(rt)),
  );
  // Per-number fairness: at most two in-flight sends per business number across the cluster
  // (queued with group = channel id), so one busy number cannot starve the others.
  await rt.boss.work(
    QUEUES.messageSend.name,
    {
      localConcurrency: concurrency,
      batchSize: 1,
      groupConcurrency: 2,
      pollingIntervalSeconds: 1,
    },
    logFailures(rt, QUEUES.messageSend.name, messageSendHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.channelOnboard.name,
    { localConcurrency: 1, batchSize: 1 },
    logFailures(rt, QUEUES.channelOnboard.name, channelOnboardHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.messagingSweep.name,
    { localConcurrency: 1, batchSize: 1 },
    logFailures(rt, QUEUES.messagingSweep.name, messagingSweepHandler(rt)),
  );
  await rt.boss.schedule(QUEUES.messagingSweep.name, '* * * * *', null, {
    singletonKey: 'messaging-sweep',
  });
  await rt.boss.work(
    QUEUES.templateSubmit.name,
    { localConcurrency: 2, batchSize: 1 },
    logFailures(rt, QUEUES.templateSubmit.name, templateSubmitHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.templateDelete.name,
    { localConcurrency: 2, batchSize: 1 },
    logFailures(rt, QUEUES.templateDelete.name, templateDeleteHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.templateSync.name,
    { localConcurrency: 2, batchSize: 1 },
    logFailures(rt, QUEUES.templateSync.name, templateSyncHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.campaignRun.name,
    { localConcurrency: 2, batchSize: 1 },
    logFailures(rt, QUEUES.campaignRun.name, campaignRunHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.automationRun.name,
    { localConcurrency: concurrency, batchSize: 1, pollingIntervalSeconds: 1 },
    logFailures(rt, QUEUES.automationRun.name, automationRunHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.automationHttp.name,
    { localConcurrency: concurrency, batchSize: 1, pollingIntervalSeconds: 1 },
    logFailures(rt, QUEUES.automationHttp.name, automationHttpHandler(rt)),
  );
  // Outgoing webhooks: one job per company at a time (stately queue), woken by the listener below
  // and the minute sweep.
  await rt.boss.work(
    QUEUES.webhookDeliver.name,
    { localConcurrency: concurrency, batchSize: 1, pollingIntervalSeconds: 1 },
    logFailures(rt, QUEUES.webhookDeliver.name, webhookDeliverHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.crmReminder.name,
    { localConcurrency: 2, batchSize: 1 },
    logFailures(rt, QUEUES.crmReminder.name, crmReminderHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.flowSync.name,
    { localConcurrency: 2, batchSize: 1 },
    logFailures(rt, QUEUES.flowSync.name, flowSyncHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.flowKeys.name,
    { localConcurrency: 1, batchSize: 1 },
    logFailures(rt, QUEUES.flowKeys.name, flowKeysHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.commerceSync.name,
    { localConcurrency: 1, batchSize: 1 },
    logFailures(rt, QUEUES.commerceSync.name, commerceSyncHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.commerceLink.name,
    { localConcurrency: 2, batchSize: 1 },
    logFailures(rt, QUEUES.commerceLink.name, commerceLinkHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.commerceAccount.name,
    { localConcurrency: 1, batchSize: 1 },
    logFailures(rt, QUEUES.commerceAccount.name, commerceAccountHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.commerceStore.name,
    { localConcurrency: 2, batchSize: 1 },
    logFailures(rt, QUEUES.commerceStore.name, commerceStoreHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.commerceStoreMessage.name,
    { localConcurrency: 2, batchSize: 1 },
    logFailures(rt, QUEUES.commerceStoreMessage.name, commerceStoreMessageHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.billingEventProcess.name,
    { localConcurrency: concurrency, batchSize: 1 },
    logFailures(rt, QUEUES.billingEventProcess.name, billingEventProcessHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.autoRecharge.name,
    { localConcurrency: 2, batchSize: 1 },
    logFailures(rt, QUEUES.autoRecharge.name, autoRechargeHandler(rt)),
  );
  await rt.boss.work(
    QUEUES.billingSweep.name,
    { localConcurrency: 1, batchSize: 1 },
    logFailures(rt, QUEUES.billingSweep.name, billingSweepHandler(rt)),
  );
  await rt.boss.schedule(QUEUES.billingSweep.name, '* * * * *', null, {
    singletonKey: 'billing-sweep',
  });
  // Company deletions (ADR-055): one run per company at a time, started by the billing sweep.
  await rt.boss.work(
    QUEUES.tenantDelete.name,
    { localConcurrency: 1, batchSize: 1 },
    logFailures(rt, QUEUES.tenantDelete.name, tenantDeleteHandler(rt)),
  );
  // Jobs that failed all their retries: recorded for the platform operations console (ADR-054).
  await rt.boss.work(
    QUEUES.deadLetter.name,
    { localConcurrency: 1, batchSize: 20, includeMetadata: true },
    logFailures(rt, QUEUES.deadLetter.name, deadLetterHandler(rt)),
  );
  const webhookListener = startWebhookListener(rt);
  rt.logger.info({ concurrency }, 'worker started');

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    rt.logger.info({ signal }, 'worker stopping');
    try {
      await webhookListener.close();
      await rt.boss.stop({ graceful: true, timeout: 30_000 });
      await rt.close();
    } catch (error) {
      rt.logger.error({ err: toError(error) }, 'error during shutdown');
    } finally {
      health.close();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('worker failed to start:', toError(error).message);
  process.exit(1);
});
