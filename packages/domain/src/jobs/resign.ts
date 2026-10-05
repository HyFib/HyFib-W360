import { jsonbText, type Clock } from '@w360/core';
import { sql, systemScope, type Database } from '@w360/db';
import type { JobSigner } from './envelope';

/**
 * Signing queued jobs again while the job signing key rotates (ADR-135). A job's envelope is signed
 * when the job is queued, and a reminder, a scheduled campaign or an automation's wait can stay
 * queued for months; so while a previous key is configured, the worker's minute sweep signs the jobs
 * that key signed again with the signing key, and the previous key can be removed once none is left
 * instead of once all of them have run.
 *
 * Jobs waiting, retrying or failed (pg-boss keeps a failed job, which the operations console can
 * retry, ADR-108) whose envelope names the previous key, or no key (signed before key ids), are
 * verified one by one and signed again with the same contents and time. One that does not verify is never signed: it is left as it is, its consumer
 * refuses it as before, and it is reported once. Each write is a compare and set on the job's state
 * and signature, so a job a worker fetched, or another sweep signed, meanwhile is left as it is.
 */

/** Jobs one sweep signs again at most. */
export const RESIGN_BATCH = 500;
/** After a lookup found nothing, the next one waits this long. */
export const RESIGN_IDLE_MS = 60 * 60_000;
/** Jobs that do not verify a worker leaves out of its lookups before it stops signing again. */
export const RESIGN_SKIP_LIMIT = 1000;

/** A queued job: its queue and id, never its data. */
export interface QueuedJobRef {
  queue: string;
  id: string;
}

/** What a worker remembers between sweeps. */
export interface ResignState {
  /** Jobs that did not verify (`queue:id`), left out of later lookups until the worker restarts. */
  skip: Set<string>;
  /** When the next lookup may run (epoch ms): an hour after one found nothing. */
  idleUntil: number;
}

export const newResignState = (): ResignState => ({ skip: new Set(), idleUntil: 0 });

export interface ResignSweepResult {
  resigned: number;
  /** Jobs fetched, finished or signed again by another sweep between the lookup and the write. */
  changed: number;
  /** Jobs that did not verify with any configured key this sweep. */
  unverifiable: QueuedJobRef[];
  /** Whether this worker stopped signing jobs again: too many did not verify. */
  stopped: boolean;
}

/**
 * The minute sweep's part: while a previous job signing key is configured, signs up to `limit`
 * queued jobs it signed again with the signing key. Only an instance still running with the
 * previous configuration signs with that key, so once a lookup finds nothing the next waits an
 * hour. After RESIGN_SKIP_LIMIT jobs that do not verify, the worker stops until it restarts.
 */
export async function resignQueuedJobs(
  deps: { db: Database; signer: JobSigner; clock: Clock },
  state: ResignState,
  limit = RESIGN_BATCH,
): Promise<ResignSweepResult> {
  const result: ResignSweepResult = {
    resigned: 0,
    changed: 0,
    unverifiable: [],
    stopped: state.skip.size >= RESIGN_SKIP_LIMIT,
  };
  const previous = deps.signer.previousKeyId;
  const now = deps.clock.now().getTime();
  if (previous === null || result.stopped || now < state.idleUntil) return result;
  const jobs = await deps.db.run(
    systemScope,
    async (tx) =>
      (
        await tx.execute<{ name: string; id: string; data: unknown; sig: string }>(sql`
          select name, id::text as id, data, data->>'sig' as sig
            from pgboss.job
           where state in ('created', 'retry', 'failed')
             and jsonb_typeof(data) = 'object' and data ? 'sig'
             and (data->>'kid' = ${previous} or not data ? 'kid')
             and not (name || ':' || id::text) = any(${sql.param([...state.skip])}::text[])
           limit ${Math.max(Math.min(limit, RESIGN_BATCH), 0)}`)
      ).rows,
    { accessMode: 'read only' },
  );
  if (jobs.length === 0) state.idleUntil = now + RESIGN_IDLE_MS;
  const writes: { name: string; id: string; sig: string; data: string }[] = [];
  for (const job of jobs) {
    const envelope = deps.signer.resign(job.data, now);
    if (envelope === null) {
      state.skip.add(`${job.name}:${job.id}`);
      result.unverifiable.push({ queue: job.name, id: job.id });
    } else {
      writes.push({ name: job.name, id: job.id, sig: job.sig, data: jsonbText(envelope) });
    }
  }
  if (writes.length > 0) {
    const written = await deps.db.run(systemScope, async (tx) => {
      const res = await tx.execute(sql`
        update pgboss.job j set data = w.data
          from unnest(${sql.param(writes.map((w) => w.name))}::text[],
                      ${sql.param(writes.map((w) => w.id))}::uuid[],
                      ${sql.param(writes.map((w) => w.sig))}::text[],
                      ${sql.param(writes.map((w) => w.data))}::jsonb[]) as w(name, id, sig, data)
         where j.name = w.name and j.id = w.id
           and j.state in ('created', 'retry', 'failed')
           and j.data->>'sig' = w.sig`);
      return res.rowCount ?? 0;
    });
    result.resigned = written;
    result.changed = writes.length - written;
  }
  result.stopped = state.skip.size >= RESIGN_SKIP_LIMIT;
  return result;
}

/** Jobs that can still run counted by the key their envelope names (`ops.job_signing_key_counts`). */
export interface JobSigningKeyCount {
  /** The key id the envelope names; null for envelopes signed before key ids. */
  keyId: string | null;
  state: 'created' | 'retry' | 'active' | 'failed';
  jobs: number;
}

export type JobSigningKeyRole = 'signing' | 'next' | 'previous' | 'none' | 'not_configured';

export const JOB_SIGNING_KEY_ROLE_LABELS: Record<JobSigningKeyRole, string> = {
  signing: 'Signs new jobs',
  next: 'Next (accepted, signs nothing yet)',
  previous: 'Previous (accepted while its jobs are signed again)',
  none: 'No key id (signed before key ids)',
  not_configured: 'Not configured',
};

export interface JobSigningOverview {
  keyId: string;
  nextKeyId: string | null;
  previousKeyId: string | null;
  /** Every configured key (even with no job), then key ids found only in jobs. */
  keys: {
    keyId: string | null;
    role: JobSigningKeyRole;
    /** Waiting or retrying. */
    queued: number;
    active: number;
    failed: number;
  }[];
  /**
   * Jobs the previous key or no key signed, which the worker signs again while a previous key is
   * configured; it can be removed once this is zero. Zero without a previous key.
   */
  toResign: number;
  /** Jobs naming a key that is not configured: their consumer will refuse them. */
  unverifiable: number;
}

const ROLE_ORDER: JobSigningKeyRole[] = ['signing', 'next', 'previous', 'none', 'not_configured'];

/** What the operations console shows of job signing: key ids and counts, never a key or a job. */
export function jobSigningOverview(
  signer: {
    readonly keyId: string;
    readonly nextKeyId: string | null;
    readonly previousKeyId: string | null;
  },
  counts: readonly JobSigningKeyCount[],
): JobSigningOverview {
  const roleOf = (keyId: string | null): JobSigningKeyRole =>
    keyId === null
      ? 'none'
      : keyId === signer.keyId
        ? 'signing'
        : keyId === signer.nextKeyId
          ? 'next'
          : keyId === signer.previousKeyId
            ? 'previous'
            : 'not_configured';
  const rows = new Map<string | null, { queued: number; active: number; failed: number }>();
  for (const keyId of [signer.keyId, signer.nextKeyId, signer.previousKeyId]) {
    if (keyId !== null) rows.set(keyId, { queued: 0, active: 0, failed: 0 });
  }
  for (const c of counts) {
    const row = rows.get(c.keyId) ?? { queued: 0, active: 0, failed: 0 };
    if (c.state === 'active') row.active += c.jobs;
    else if (c.state === 'failed') row.failed += c.jobs;
    else row.queued += c.jobs;
    rows.set(c.keyId, row);
  }
  const keys = [...rows]
    .map(([keyId, row]) => ({ keyId, role: roleOf(keyId), ...row }))
    .sort(
      (a, b) =>
        ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
        (a.keyId ?? '').localeCompare(b.keyId ?? ''),
    );
  const total = (role: JobSigningKeyRole) =>
    keys.filter((k) => k.role === role).reduce((sum, k) => sum + k.queued + k.active + k.failed, 0);
  return {
    keyId: signer.keyId,
    nextKeyId: signer.nextKeyId,
    previousKeyId: signer.previousKeyId,
    keys,
    toResign: signer.previousKeyId === null ? 0 : total('previous') + total('none'),
    unverifiable: total('not_configured'),
  };
}

const JOB_STATES = new Set(['created', 'retry', 'active', 'failed']);
const KEY_ID = /^[0-9a-f]{16}$/;
/** Stands for key ids in another form (a job's data is not trusted), counted as not configured. */
export const MALFORMED_KEY_ID = '(malformed)';

/** Rows of `ops.job_signing_key_counts`. */
export function parseJobSigningKeyCounts(
  rows: readonly { key_id: string | null; state: string; jobs: number | string }[],
): JobSigningKeyCount[] {
  return rows.flatMap((r) =>
    JOB_STATES.has(r.state)
      ? [
          {
            keyId: r.key_id === null ? null : KEY_ID.test(r.key_id) ? r.key_id : MALFORMED_KEY_ID,
            state: r.state as JobSigningKeyCount['state'],
            jobs: Number(r.jobs),
          },
        ]
      : [],
  );
}
