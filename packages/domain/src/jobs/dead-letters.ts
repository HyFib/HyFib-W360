import type { JobWithMetadata } from 'pg-boss';
import { deadLetters, sql, systemScope, type Database } from '@w360/db';
import type { JobSigner } from './envelope';

/**
 * Dead letters (ADR-054). A job that failed all its retries is copied by pg-boss into the
 * `dead-letter` queue; the worker consumes that queue and records each job here so platform staff
 * can see it without SQL. Only what cannot quote customer data is kept: the source queue and job,
 * the envelope's kind, reference and company when its signature verifies, the retries used and the
 * error's name and code. The job itself, with its full output, stays in pg-boss for its retention.
 */
export interface DeadLetterJob {
  /** The job's id in the dead-letter queue. */
  id: string;
  /** The signed envelope the original job carried. */
  data: unknown;
  /** What pg-boss stored when the original job last failed (a serialised error). */
  output: unknown;
  sourceName: string | null;
  sourceId: string | null;
  sourceCreatedOn: Date | null;
  sourceRetryCount: number | null;
  /** When the job reached the dead-letter queue. */
  createdOn: Date;
}

/** The fields of a dead-letter queue job, fetched with its metadata, that a record is made from. */
export function deadLetterJob(job: JobWithMetadata<unknown>): DeadLetterJob {
  return {
    id: job.id,
    data: job.data,
    output: job.output,
    sourceName: job.sourceName,
    sourceId: job.sourceId,
    sourceCreatedOn: job.sourceCreatedOn,
    sourceRetryCount: job.sourceRetryCount,
    createdOn: job.createdOn,
  };
}

const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;
const ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/;
const QUEUE_NAME = /^[a-z][a-z0-9_.-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Failures pg-boss records itself, with fixed messages (not data), named so they read as one kind. */
const PG_BOSS_FAILURES: Record<string, { name: string; code: string }> = {
  'job timed out': { name: 'Timeout', code: 'job_timed_out' },
  'job heartbeat timeout': { name: 'Timeout', code: 'heartbeat_timeout' },
};

/**
 * The error's name and code from a failed job's output, and nothing else: messages, stacks and
 * details can quote data (a database error's detail repeats the values of a unique key, for
 * example). A code is an application error code or a SQLSTATE.
 */
export function deadLetterError(output: unknown): { name: string | null; code: string | null } {
  if (!output || typeof output !== 'object') return { name: null, code: null };
  const record = output as Record<string, unknown>;
  const wrapped = record.value;
  if (wrapped && typeof wrapped === 'object') {
    const message = (wrapped as Record<string, unknown>).message;
    if (typeof message === 'string' && PG_BOSS_FAILURES[message]) return PG_BOSS_FAILURES[message];
  }
  const name = typeof record.name === 'string' && ERROR_NAME.test(record.name) ? record.name : null;
  const rawCode =
    typeof record.code === 'number' && Number.isInteger(record.code)
      ? String(record.code)
      : record.code;
  const code = typeof rawCode === 'string' && ERROR_CODE.test(rawCode) ? rawCode : null;
  return { name, code };
}

/** The row recorded for one dead-lettered job. */
export function deadLetterRow(signer: JobSigner, job: DeadLetterJob, now: Date = new Date()) {
  const envelope = signer.verify(job.data, now.getTime());
  const error = deadLetterError(job.output);
  const sourceQueue =
    job.sourceName && QUEUE_NAME.test(job.sourceName) ? job.sourceName : 'unknown';
  return {
    id: job.id,
    sourceQueue,
    sourceJobId: job.sourceId && UUID.test(job.sourceId) ? job.sourceId : null,
    kind: envelope?.kind ?? null,
    tenantId: envelope?.tenantId ?? null,
    ref: envelope?.ref ?? null,
    verified: envelope !== null,
    retries:
      typeof job.sourceRetryCount === 'number' && job.sourceRetryCount >= 0
        ? job.sourceRetryCount
        : null,
    errorName: error.name,
    errorCode: error.code,
    firstQueuedAt: job.sourceCreatedOn,
    failedAt: job.createdOn,
  };
}

/**
 * Records a batch of dead-lettered jobs in one transaction and returns how many rows were new. The
 * worker role may only insert, so a batch recorded again after a failed completion is ignored row
 * by row (same job ids).
 */
export async function recordDeadLetters(
  deps: { db: Database; signer: JobSigner },
  jobs: DeadLetterJob[],
): Promise<number> {
  if (jobs.length === 0) return 0;
  const rows = jobs.map((job) => deadLetterRow(deps.signer, job));
  return deps.db.run(systemScope, async (tx) => {
    const result = await tx.insert(deadLetters).values(rows).onConflictDoNothing();
    return result.rowCount ?? 0;
  });
}

/** Deletes dead letters 30 days after their job failed (bounded per call). */
export async function purgeDeadLetters(db: Database, limit = 5000): Promise<number> {
  return db.run(systemScope, async (tx) => {
    const result = await tx.execute<{ deleted: number }>(
      sql`select ops.purge_dead_letters(${limit}) as deleted`,
    );
    return Number(result.rows[0]?.deleted ?? 0);
  });
}
