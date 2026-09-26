import { sql, type SQL } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { JobEnvelope, QueueName } from '@w360/contracts';
import type { Tx } from '@w360/db';

/**
 * Job producer abstraction. When a transaction is supplied the job row is inserted through that
 * transaction, so it becomes visible if and only if the business change commits. Durable business
 * rows (outbox, send intents, webhook receipts) remain the source of truth; sweepers re-signal any
 * row whose job was lost, so correctness never depends on a single enqueue.
 */
export interface EnqueueOptions {
  singletonKey?: string;
  startAfter?: Date;
  /** Fairness group (for example a phone number id); see pg-boss group concurrency. */
  group?: { id: string; tier?: string };
  priority?: number;
}

export interface JobQueue {
  enqueue(tx: Tx | null, queue: QueueName, envelope: JobEnvelope, options?: EnqueueOptions): Promise<string | null>;
}

/** Adapts a drizzle transaction to pg-boss's minimal database interface. */
function transactionExecutor(tx: Tx) {
  return {
    async executeSql(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      const parts = text.split(/(\$\d+)/g);
      const chunks: SQL[] = parts.map((part) => {
        const match = /^\$(\d+)$/.exec(part);
        if (!match) return sql.raw(part);
        const index = Number(match[1]) - 1;
        if (index < 0 || index >= values.length) throw new Error(`Missing SQL parameter ${part}`);
        return sql`${values[index]}`;
      });
      const result = await tx.execute<Record<string, unknown>>(sql.join(chunks, sql.raw('')));
      return { rows: result.rows };
    },
  };
}

export class PgBossJobQueue implements JobQueue {
  constructor(private readonly boss: PgBoss) {}

  async enqueue(tx: Tx | null, queue: QueueName, envelope: JobEnvelope, options: EnqueueOptions = {}) {
    return this.boss.send(queue, envelope, {
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.startAfter ? { startAfter: options.startAfter } : {}),
      ...(options.group ? { group: options.group } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(tx ? { db: transactionExecutor(tx) } : {}),
    });
  }
}

/** Collects enqueued jobs in memory; for unit tests of services only. */
export class RecordingJobQueue implements JobQueue {
  readonly jobs: { queue: QueueName; envelope: JobEnvelope; options: EnqueueOptions }[] = [];

  async enqueue(_tx: Tx | null, queue: QueueName, envelope: JobEnvelope, options: EnqueueOptions = {}) {
    this.jobs.push({ queue, envelope, options });
    return `job-${this.jobs.length}`;
  }
}
