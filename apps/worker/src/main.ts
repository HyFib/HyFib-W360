import { QUEUES } from '@w360/contracts';
import { toError } from '@w360/core';
import { startHealthServer } from './health';
import {
  autoRechargeHandler,
  billingEventProcessHandler,
  billingSweepHandler,
} from './handlers/billing';
import { automationRunHandler } from './handlers/automations';
import { campaignRunHandler } from './handlers/campaigns';
import { emailSendHandler, outboxSweepHandler } from './handlers/email';
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
import { createWorkerRuntime } from './runtime';

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
    emailSendHandler(rt),
  );
  await rt.boss.work(
    QUEUES.outboxSweep.name,
    { localConcurrency: 1, batchSize: 1 },
    outboxSweepHandler(rt),
  );
  await rt.boss.schedule(QUEUES.outboxSweep.name, '* * * * *', null, {
    singletonKey: 'outbox-sweep',
  });
  // Conversational latency: an inbound message, each bot message and the automation step after it
  // pass through these three queues, so they are polled every second (pg-boss's default is 2 s).
  await rt.boss.work(
    QUEUES.webhookProcess.name,
    { localConcurrency: concurrency, batchSize: 1, pollingIntervalSeconds: 1 },
    webhookProcessHandler(rt),
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
    messageSendHandler(rt),
  );
  await rt.boss.work(
    QUEUES.channelOnboard.name,
    { localConcurrency: 1, batchSize: 1 },
    channelOnboardHandler(rt),
  );
  await rt.boss.work(
    QUEUES.messagingSweep.name,
    { localConcurrency: 1, batchSize: 1 },
    messagingSweepHandler(rt),
  );
  await rt.boss.schedule(QUEUES.messagingSweep.name, '* * * * *', null, {
    singletonKey: 'messaging-sweep',
  });
  await rt.boss.work(
    QUEUES.templateSubmit.name,
    { localConcurrency: 2, batchSize: 1 },
    templateSubmitHandler(rt),
  );
  await rt.boss.work(
    QUEUES.templateDelete.name,
    { localConcurrency: 2, batchSize: 1 },
    templateDeleteHandler(rt),
  );
  await rt.boss.work(
    QUEUES.templateSync.name,
    { localConcurrency: 2, batchSize: 1 },
    templateSyncHandler(rt),
  );
  await rt.boss.work(
    QUEUES.campaignRun.name,
    { localConcurrency: 2, batchSize: 1 },
    campaignRunHandler(rt),
  );
  await rt.boss.work(
    QUEUES.automationRun.name,
    { localConcurrency: concurrency, batchSize: 1, pollingIntervalSeconds: 1 },
    automationRunHandler(rt),
  );
  await rt.boss.work(
    QUEUES.billingEventProcess.name,
    { localConcurrency: concurrency, batchSize: 1 },
    billingEventProcessHandler(rt),
  );
  await rt.boss.work(
    QUEUES.autoRecharge.name,
    { localConcurrency: 2, batchSize: 1 },
    autoRechargeHandler(rt),
  );
  await rt.boss.work(
    QUEUES.billingSweep.name,
    { localConcurrency: 1, batchSize: 1 },
    billingSweepHandler(rt),
  );
  await rt.boss.schedule(QUEUES.billingSweep.name, '* * * * *', null, {
    singletonKey: 'billing-sweep',
  });
  rt.logger.info({ concurrency }, 'worker started');

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    rt.logger.info({ signal }, 'worker stopping');
    try {
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
