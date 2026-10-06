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
  enqueue(
    tx: Tx | null,
    queue: QueueName,
    envelope: JobEnvelope,
    options?: EnqueueOptions,
  ): Promise<string | null>;
  /** Enqueues several jobs of one queue in a single statement (same transaction semantics). */
  enqueueMany(
    tx: Tx | null,
    queue: QueueName,
    jobs: { envelope: JobEnvelope; options?: EnqueueOptions }[],
  ): Promise<void>;
  /**
   * Raises to `priority` the job of the queue waiting under `singletonKey` (created, or due a
   * retry) when its priority is lower. An exclusive queue collapses a job sent under the key of
   * one already waiting, which keeps its own priority; raising it keeps the priority the later
   * request asked for (ADR-178). A running job is left alone. Returns how many jobs it raised.
   */
  raisePriority(
    tx: Tx | null,
    queue: QueueName,
    singletonKey: string,
    priority: number,
  ): Promise<number>;
}

/** The job table of the pg-boss schema both runtimes configure (`pgboss`, see db/migrate.ts). */
const PGBOSS_JOB_TABLE = 'pgboss.job';

/** pg-boss 12 orders job states created < retry < active: below active, a job still waits. */
export const RAISE_WAITING_JOB_PRIORITY_SQL = `UPDATE ${PGBOSS_JOB_TABLE} SET priority = $3
  WHERE name = $1 AND singleton_key = $2 AND state < 'active' AND priority < $3
  RETURNING id`;

/** Adapts a drizzle transaction to pg-boss's minimal database interface. */
function transactionExecutor(tx: Tx) {
  return {
    async executeSql(
      text: string,
      values: unknown[] = [],
    ): Promise<{ rows: Record<string, unknown>[] }> {
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

  async enqueue(
    tx: Tx | null,
    queue: QueueName,
    envelope: JobEnvelope,
    options: EnqueueOptions = {},
  ) {
    return this.boss.send(queue, envelope, {
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.startAfter ? { startAfter: options.startAfter } : {}),
      ...(options.group ? { group: options.group } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(tx ? { db: transactionExecutor(tx) } : {}),
    });
  }

  async enqueueMany(
    tx: Tx | null,
    queue: QueueName,
    jobs: { envelope: JobEnvelope; options?: EnqueueOptions }[],
  ) {
    if (jobs.length === 0) return;
    await this.boss.insert(
      queue,
      jobs.map(({ envelope, options = {} }) => ({
        data: envelope,
        ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
        ...(options.startAfter ? { startAfter: options.startAfter } : {}),
        ...(options.group ? { group: options.group } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
      })),
      { returnId: false, ...(tx ? { db: transactionExecutor(tx) } : {}) },
    );
  }

  async raisePriority(tx: Tx | null, queue: QueueName, singletonKey: string, priority: number) {
    const db = tx ? transactionExecutor(tx) : this.boss.getDb();
    const { rows } = await db.executeSql(RAISE_WAITING_JOB_PRIORITY_SQL, [
      queue,
      singletonKey,
      priority,
    ]);
    return rows.length;
  }
}

/**
 * What to log beside an error pg-boss emits (ADR-129). pg-boss copies a worker's error into a plain
 * object with its queue and worker id; a database error is logged without the copy's other
 * properties, so the two are logged beside it.
 */
export function pgBossErrorContext(error: unknown): { queue?: string; worker?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const { queue, worker } = error as { queue?: unknown; worker?: unknown };
  return {
    ...(typeof queue === 'string' ? { queue } : {}),
    ...(typeof worker === 'string' ? { worker } : {}),
  };
}

/**
 * Job counts for one queue as pg-boss keeps them: refreshed by the supervising worker about once a
 * minute, so they can lag the table slightly. `failed` counts failed jobs still retained.
 */
export interface QueueSnapshot {
  name: string;
  ready: number;
  deferred: number;
  active: number;
  failed: number;
  total: number;
}

export interface QueueInspector {
  snapshot(): Promise<QueueSnapshot[]>;
}

/** Reads the queue counts through pg-boss's public `getQueues()`. */
export function pgBossQueueInspector(boss: PgBoss): QueueInspector {
  return {
    async snapshot() {
      const queues = await boss.getQueues();
      return queues
        .map((q) => ({
          name: q.name,
          ready: Number(q.readyCount),
          deferred: Number(q.deferredCount),
          active: Number(q.activeCount),
          failed: Number(q.failedCount),
          total: Number(q.totalCount),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

/** Collects enqueued jobs in memory; for unit tests of services only. */
export class RecordingJobQueue implements JobQueue {
  readonly jobs: { queue: QueueName; envelope: JobEnvelope; options: EnqueueOptions }[] = [];

  async enqueue(
    _tx: Tx | null,
    queue: QueueName,
    envelope: JobEnvelope,
    options: EnqueueOptions = {},
  ) {
    this.jobs.push({ queue, envelope, options });
    return `job-${this.jobs.length}`;
  }

  async enqueueMany(
    _tx: Tx | null,
    queue: QueueName,
    jobs: { envelope: JobEnvelope; options?: EnqueueOptions }[],
  ) {
    for (const job of jobs)
      this.jobs.push({ queue, envelope: job.envelope, options: job.options ?? {} });
  }

  /** Every recorded job counts as waiting. */
  async raisePriority(_tx: Tx | null, queue: QueueName, singletonKey: string, priority: number) {
    const waiting = this.jobs.filter(
      (j) =>
        j.queue === queue &&
        j.options.singletonKey === singletonKey &&
        (j.options.priority ?? 0) < priority,
    );
    for (const job of waiting) job.options = { ...job.options, priority };
    return waiting.length;
  }
}
