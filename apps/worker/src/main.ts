import { QUEUES } from '@w360/contracts';
import { toError } from '@w360/core';
import { startHealthServer } from './health';
import { emailSendHandler, outboxSweepHandler } from './handlers/email';
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
  await rt.boss.work(QUEUES.emailSend.name, { localConcurrency: concurrency, batchSize: 1 }, emailSendHandler(rt));
  await rt.boss.work(QUEUES.outboxSweep.name, { localConcurrency: 1, batchSize: 1 }, outboxSweepHandler(rt));
  await rt.boss.schedule(QUEUES.outboxSweep.name, '* * * * *', null, { singletonKey: 'outbox-sweep' });
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
