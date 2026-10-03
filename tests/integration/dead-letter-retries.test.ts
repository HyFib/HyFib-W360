import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { PgBoss } from 'pg-boss';
import { isAppError, uuidv7 } from '@w360/core';
import { sql, systemScope } from '@w360/db';
import {
  createPlatformOpsService,
  deadLetterJob,
  JobSigner,
  pgBossQueueInspector,
  recordDeadLetters,
  type PlatformActor,
} from '@w360/domain';
import {
  connectTestDatabases,
  createTenant,
  createUser,
  type TestDatabases,
  type TestTenant,
} from './helpers';

/**
 * Retrying a dead letter's job from the operations console (P5-10, ADR-108) against real
 * PostgreSQL and pg-boss: a platform administrator sends a job that failed all its attempts back
 * to its queue once, with a reason, in the platform audit log, and pg-boss hands it to a worker for
 * one more attempt. Refused for a job already retried, one whose signature did not verify, one of a
 * company being deleted, one pg-boss no longer keeps as failed and one whose work already waits;
 * for anyone but a platform administrator; and the definer reads and writes only what the retry
 * needs of pg-boss's jobs.
 */
let dbs: TestDatabases;
let boss: PgBoss;
let owner: PgBoss;
let signer: JobSigner;
let tenant: TestTenant;
let staff: PlatformActor;

const STAFF_NAME = 'Dead Letter Staff';
/**
 * The dead letters this file makes. Failure alerts are platform-wide (ADR-091): they are marked as
 * told after the file, so that a later file's alert counts only its own.
 */
const made: string[] = [];
const REASON = 'Store credentials fixed, ticket 4521';

const ops = () =>
  createPlatformOpsService({
    platformDb: dbs.platform,
    queues: pgBossQueueInspector(boss),
    clock: { now: () => new Date() },
    keyring: { currentKeyId: 'k1', keyIds: ['k1'] },
    jobSigning: signer,
  });

async function admin<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

async function expectCode(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.message).toMatch(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

/**
 * A queue of this test's own, created with the migration role like every queue: one retry (at
 * once), then the dead letter, unless it is to never retry.
 */
async function testQueue(
  policy: 'standard' | 'exclusive' = 'standard',
  retryLimit = 1,
): Promise<string> {
  const queue = `it.dlr-${randomBytes(4).toString('hex')}`;
  await owner.createQueue(queue, { retryLimit, retryDelay: 0, deadLetter: 'dead-letter', policy });
  return queue;
}

/** Records the dead letters pg-boss made of this queue's failed jobs, as the worker does. */
async function recordLetters(queue: string): Promise<string[]> {
  const letters = (
    await boss.fetch('dead-letter', { batchSize: 100, includeMetadata: true })
  ).filter((job) => job.sourceName === queue);
  await recordDeadLetters({ db: dbs.app, signer }, letters.map(deadLetterJob));
  made.push(...letters.map((job) => job.id));
  if (letters.length > 0) {
    await boss.complete(
      'dead-letter',
      letters.map((job) => job.id),
    );
  }
  return letters.map((job) => job.id);
}

/** A job that failed every attempt its queue allows, and the dead letter the worker recorded. */
async function deadLetteredJob(
  queue: string,
  options: { tenantId?: string | null; singletonKey?: string; attempts?: number } = {},
) {
  const envelope = signer.sign({
    kind: 'commerce.store',
    tenantId: options.tenantId === undefined ? tenant.id : options.tenantId,
    actorUserId: null,
    ref: `store-${randomBytes(3).toString('hex')}`,
  });
  const jobId = await boss.send(
    queue,
    envelope,
    options.singletonKey ? { singletonKey: options.singletonKey } : {},
  );
  if (!jobId) throw new Error('pg-boss did not take the job');
  for (let attempt = 0; attempt < (options.attempts ?? 2); attempt += 1) {
    const [fetched] = await boss.fetch(queue);
    expect(fetched?.id).toBe(jobId);
    await boss.fail(queue, jobId, { name: 'AppError', code: 'provider_rejected', message: 'No' });
  }
  const [deadLetterId] = await recordLetters(queue);
  if (!deadLetterId) throw new Error('pg-boss made no dead letter');
  return { jobId, deadLetterId, envelope };
}

const job = async (id: string) =>
  (
    await admin<{
      state: string;
      retry_limit: number;
      retry_count: number;
      completed_on: Date | null;
    }>(`SELECT state, retry_limit, retry_count, completed_on FROM pgboss.job WHERE id = $1`, [id])
  )[0];

const letter = async (id: string) =>
  (
    await admin<{ retried_at: Date | null; retried_by_user_id: string | null }>(
      `SELECT retried_at, retried_by_user_id FROM ops.dead_letters WHERE id = $1`,
      [id],
    )
  )[0];

const audits = (deadLetterId: string) =>
  admin(
    `SELECT actor_user_id, reason, result, correlation_id, metadata FROM ops.platform_audit_events
      WHERE action = 'platform.dead_letter_retried' AND metadata->>'deadLetterId' = $1`,
    [deadLetterId],
  );

/** A dead letter row as the worker records it, for the checks that need no pg-boss job. */
async function insertLetter(values: {
  queue?: string;
  jobId?: string | null;
  tenantId?: string | null;
  verified?: boolean;
  failedAt?: Date;
}): Promise<string> {
  const id = uuidv7();
  const verified = values.verified ?? true;
  await admin(
    `INSERT INTO ops.dead_letters (id, source_queue, source_job_id, kind, tenant_id, ref, verified,
       retries, failed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
    [
      id,
      values.queue ?? 'email.send',
      values.jobId === undefined ? uuidv7() : values.jobId,
      verified ? 'email.send' : null,
      verified ? (values.tenantId === undefined ? tenant.id : values.tenantId) : null,
      verified ? 'ref-1' : null,
      verified,
      values.failedAt ?? new Date(),
    ],
  );
  made.push(id);
  return id;
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  const urls = inject('dbUrls');
  const options = {
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    max: 2,
  } as const;
  boss = new PgBoss({ ...options, connectionString: urls.app });
  owner = new PgBoss({ ...options, connectionString: urls.owner });
  boss.on('error', () => undefined);
  owner.on('error', () => undefined);
  await boss.start();
  await owner.start();
  signer = new JobSigner(randomBytes(32).toString('hex'));
  const user = await createUser(dbs, { name: STAFF_NAME, twoFactor: true });
  await dbs.ownerPool.query(
    `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
    [user.id],
  );
  staff = { userId: user.id, role: 'platform_operator', correlationId: uuidv7() };
  tenant = await createTenant(dbs, await createUser(dbs));
});

afterAll(async () => {
  await admin(
    `UPDATE ops.dead_letters SET alerted_at = now() WHERE alerted_at IS NULL AND id = ANY($1::uuid[])`,
    [made],
  );
  await owner.stop({ graceful: false, close: true });
  await boss.stop({ graceful: false, close: true });
  await dbs.close();
});

describe('retrying a dead letter (ADR-108)', () => {
  it('sends the job back to its queue for one more attempt, once, with the reason in the platform audit log; failing again, it has a dead letter of its own', async () => {
    const queue = await testQueue();
    const { jobId, deadLetterId, envelope } = await deadLetteredJob(queue);
    // Its two attempts (the queue's one retry) used.
    expect(await job(jobId)).toMatchObject({ state: 'failed', retry_limit: 1, retry_count: 1 });

    expect(await ops().retryDeadLetter(staff, { deadLetterId, reason: `  ${REASON}  ` })).toEqual({
      queue,
    });
    // pg-boss's own retry: back to retry with one more attempt allowed, no completion time.
    expect(await job(jobId)).toEqual({
      state: 'retry',
      retry_limit: 2,
      retry_count: 1,
      completed_on: null,
    });
    expect(await letter(deadLetterId)).toEqual({
      retried_at: expect.any(Date),
      retried_by_user_id: staff.userId,
    });
    expect(await audits(deadLetterId)).toEqual([
      {
        actor_user_id: staff.userId,
        reason: REASON,
        result: 'success',
        correlation_id: staff.correlationId,
        metadata: { deadLetterId, queue, jobId, tenantId: tenant.id },
      },
    ]);

    // Once only.
    await expectCode(
      ops().retryDeadLetter(staff, { deadLetterId, reason: 'Trying it once more, ticket 4521' }),
      'precondition_failed',
      /already retried/,
    );
    expect(await audits(deadLetterId)).toHaveLength(1);

    // A worker takes the same job, with the same envelope, for its one more attempt.
    const [again] = await boss.fetch(queue);
    expect(again?.id).toBe(jobId);
    expect(again?.data).toEqual(envelope);
    await boss.fail(queue, jobId, { name: 'AppError', code: 'provider_rejected', message: 'No' });
    expect(await job(jobId)).toMatchObject({ state: 'failed', retry_limit: 2, retry_count: 2 });
    const [second] = await recordLetters(queue);
    expect(second).toBeDefined();
    expect(second).not.toBe(deadLetterId);

    // The console lists both: the retried one with who retried it, the new one not retried. A
    // queue this release does not declare is never offered (its retention is unknown here).
    const { deadLetters } = await ops().queues(staff);
    const mine = deadLetters.filter((d) => d.sourceJobId === jobId);
    expect(
      mine.map((d) => ({
        id: d.id,
        retried: d.retriedAt !== null,
        by: d.retriedByName,
        retryBlock: d.retryBlock,
      })),
    ).toEqual([
      { id: second, retried: false, by: null, retryBlock: 'undeclared' },
      { id: deadLetterId, retried: true, by: STAFF_NAME, retryBlock: 'retried' },
    ]);
    // The new dead letter can be retried in its turn.
    await ops().retryDeadLetter(staff, { deadLetterId: second!, reason: REASON });
    expect(await job(jobId)).toMatchObject({ state: 'retry', retry_limit: 3 });
    const [third] = await boss.fetch(queue);
    expect(third?.id).toBe(jobId);
    await boss.complete(queue, jobId);
  });

  it('offers a retry only while the queue keeps the failed job, and says why not for a job whose signature did not verify, one of a queue that never retries and one of a company being deleted', async () => {
    const hour = 3_600_000;
    const now = Date.now();
    const deleting = await createTenant(dbs, await createUser(dbs));
    await admin(`UPDATE app.tenants SET status = 'pending_deletion' WHERE id = $1`, [deleting.id]);
    const suspended = await createTenant(dbs, await createUser(dbs));
    await admin(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [suspended.id]);
    // email.send keeps failed jobs 72 hours.
    const fresh = await insertLetter({ failedAt: new Date(now - hour) });
    const stale = await insertLetter({ failedAt: new Date(now - 73 * hour) });
    const unverified = await insertLetter({ verified: false });
    const noJob = await insertLetter({ jobId: null });
    const ofDeleting = await insertLetter({ tenantId: deleting.id });
    const ofSuspended = await insertLetter({ tenantId: suspended.id });
    const ofGone = await insertLetter({ tenantId: uuidv7() });
    const ofPlatform = await insertLetter({ tenantId: null });
    const ofAutoRecharge = await insertLetter({ queue: 'billing.auto-recharge' });
    const ofReceipt = await insertLetter({ queue: 'webhook.process' });

    const { deadLetters } = await ops().queues(staff);
    const offered = (id: string) => {
      const row = deadLetters.find((d) => d.id === id);
      if (!row) throw new Error(`dead letter ${id} not listed`);
      return row;
    };
    expect(offered(fresh)).toMatchObject({ retryable: true, retryBlock: null, retriedAt: null });
    expect(offered(fresh).retryableUntil?.getTime()).toBe(
      offered(fresh).failedAt.getTime() + 72 * hour,
    );
    const blocks = Object.fromEntries(
      Object.entries({
        stale,
        unverified,
        noJob,
        ofDeleting,
        ofSuspended,
        ofGone,
        ofPlatform,
        ofAutoRecharge,
        ofReceipt,
      }).map(([name, id]) => [name, [offered(id).retryable, offered(id).retryBlock]]),
    );
    expect(blocks).toEqual({
      stale: [false, 'expired'],
      unverified: [false, 'unverified'],
      noJob: [false, 'unverified'],
      ofDeleting: [false, 'company'],
      ofSuspended: [true, null],
      ofGone: [false, 'company'],
      ofPlatform: [true, null],
      ofAutoRecharge: [false, 'no_retries'],
      ofReceipt: [false, 'receipt'],
    });
  });

  it('refuses a dead letter whose signature did not verify, one without its job, one of a company being deleted or gone, one of a receipt queue and one that does not exist, changing nothing', async () => {
    const deleting = await createTenant(dbs, await createUser(dbs));
    await admin(`UPDATE app.tenants SET status = 'pending_deletion' WHERE id = $1`, [deleting.id]);
    const deleted = await createTenant(dbs, await createUser(dbs));
    await admin(`UPDATE app.tenants SET status = 'deleted' WHERE id = $1`, [deleted.id]);
    const cases: [string, RegExp][] = [
      [await insertLetter({ verified: false }), /did not verify/],
      [await insertLetter({ jobId: null }), /did not verify/],
      [await insertLetter({ tenantId: deleting.id }), /being deleted or is gone/],
      [await insertLetter({ tenantId: deleted.id }), /being deleted or is gone/],
      [await insertLetter({ tenantId: uuidv7() }), /being deleted or is gone/],
      [await insertLetter({ queue: 'billing.event-process' }), /receipt on the Integrations page/],
      [await insertLetter({ queue: 'webhook.process' }), /receipt on the Integrations page/],
    ];
    for (const [deadLetterId, message] of cases) {
      await expectCode(
        ops().retryDeadLetter(staff, { deadLetterId, reason: REASON }),
        'precondition_failed',
        message,
      );
      expect(await letter(deadLetterId)).toEqual({ retried_at: null, retried_by_user_id: null });
      expect(await audits(deadLetterId)).toEqual([]);
    }
    await expectCode(
      ops().retryDeadLetter(staff, { deadLetterId: uuidv7(), reason: REASON }),
      'not_found',
    );
  });

  it('refuses a job pg-boss no longer keeps as failed, one of a queue that never retries and one whose work already waits in its queue, changing nothing', async () => {
    // Deleted after its queue's retention (pg-boss's deletion, here by the migration role).
    const standard = await testQueue();
    const gone = await deadLetteredJob(standard);
    await dbs.ownerPool.query(`DELETE FROM pgboss.job WHERE id = $1`, [gone.jobId]);
    await expectCode(
      ops().retryDeadLetter(staff, { deadLetterId: gone.deadLetterId, reason: REASON }),
      'precondition_failed',
      /no longer keeps this job as failed/,
    );
    expect(await letter(gone.deadLetterId)).toEqual({ retried_at: null, retried_by_user_id: null });

    // Already sent back with pg-boss's own retry (by an engineer, RUNBOOKS §3).
    const retried = await deadLetteredJob(standard);
    await boss.retry(standard, retried.jobId);
    await expectCode(
      ops().retryDeadLetter(staff, { deadLetterId: retried.deadLetterId, reason: REASON }),
      'precondition_failed',
      /no longer keeps this job as failed/,
    );
    expect(await job(retried.jobId)).toMatchObject({ state: 'retry', retry_limit: 2 });
    const [taken] = await boss.fetch(standard);
    expect(taken?.id).toBe(retried.jobId);
    await boss.complete(standard, retried.jobId);

    // A queue that never retries its jobs (as billing.auto-recharge) is not retried here either.
    const never = await testQueue('standard', 0);
    const once = await deadLetteredJob(never, { attempts: 1 });
    await expectCode(
      ops().retryDeadLetter(staff, { deadLetterId: once.deadLetterId, reason: REASON }),
      'precondition_failed',
      /never retries its jobs/,
    );
    expect(await job(once.jobId)).toMatchObject({ state: 'failed', retry_limit: 0 });
    expect(await letter(once.deadLetterId)).toEqual({ retried_at: null, retried_by_user_id: null });
    expect(await audits(once.deadLetterId)).toEqual([]);

    // An exclusive queue already holds a job for the same work: it will do it.
    const exclusive = await testQueue('exclusive');
    const key = `store-${randomBytes(3).toString('hex')}`;
    const first = await deadLetteredJob(exclusive, { singletonKey: key });
    const waiting = await boss.send(exclusive, { kind: 'later' }, { singletonKey: key });
    expect(waiting).not.toBeNull();
    await expectCode(
      ops().retryDeadLetter(staff, { deadLetterId: first.deadLetterId, reason: REASON }),
      'precondition_failed',
      /already waiting in its queue/,
    );
    expect(await job(first.jobId)).toMatchObject({ state: 'failed', retry_limit: 1 });
    expect(await letter(first.deadLetterId)).toEqual({
      retried_at: null,
      retried_by_user_id: null,
    });
    expect(await audits(first.deadLetterId)).toEqual([]);
    // Once that job is done, the dead letter's job can go back.
    const [next] = await boss.fetch(exclusive);
    expect(next?.id).toBe(waiting);
    await boss.complete(exclusive, waiting!);
    await ops().retryDeadLetter(staff, { deadLetterId: first.deadLetterId, reason: REASON });
    expect(await job(first.jobId)).toMatchObject({ state: 'retry', retry_limit: 2 });
    const [last] = await boss.fetch(exclusive);
    expect(last?.id).toBe(first.jobId);
    await boss.complete(exclusive, first.jobId);
  });

  it('needs a platform administrator and a reason; the runtime role cannot run it and the platform role cannot mark a dead letter itself', async () => {
    const deadLetterId = await insertLetter({});
    // The service refuses a short reason before the database; the function refuses it too.
    await expectCode(
      ops().retryDeadLetter(staff, { deadLetterId, reason: 'too short' }),
      'validation_failed',
    );
    await expectCode(
      dbs.platform.run(staff.userId, (tx) =>
        tx.execute(
          sql`select ops.platform_retry_dead_letter(${deadLetterId}::uuid, ${'  short  '}, 'c')`,
        ),
      ),
      'precondition_failed',
      /at least 10 characters/,
    );
    const outsider = await createUser(dbs, { twoFactor: true });
    await expectCode(
      dbs.platform.run(outsider.id, (tx) =>
        tx.execute(
          sql`select ops.platform_retry_dead_letter(${deadLetterId}::uuid, ${REASON}, 'c')`,
        ),
      ),
      'forbidden',
    );
    await expect(
      dbs.app.run(systemScope, (tx) =>
        tx.execute(
          sql`select ops.platform_retry_dead_letter(${deadLetterId}::uuid, ${REASON}, 'c')`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      dbs.platformPool.query(
        `UPDATE ops.dead_letters SET retried_at = now(), retried_by_user_id = $2 WHERE id = $1`,
        [deadLetterId, staff.userId],
      ),
    ).rejects.toThrow(/permission denied/);
    expect(await letter(deadLetterId)).toEqual({ retried_at: null, retried_by_user_id: null });
    // A retry always names who made it.
    await expect(
      dbs.adminPool.query(`UPDATE ops.dead_letters SET retried_at = now() WHERE id = $1`, [
        deadLetterId,
      ]),
    ).rejects.toThrow(/violates check constraint "dead_letters_retried_by"/);

    // Called directly, the function trims the reason it audits too.
    const queue = await testQueue();
    const direct = await deadLetteredJob(queue);
    await dbs.platform.run(staff.userId, (tx) =>
      tx.execute(
        sql`select ops.platform_retry_dead_letter(${direct.deadLetterId}::uuid, ${`  ${REASON}  `}, 'c')`,
      ),
    );
    expect(await audits(direct.deadLetterId)).toMatchObject([{ reason: REASON }]);
    const [taken] = await boss.fetch(queue);
    expect(taken?.id).toBe(direct.jobId);
    await boss.complete(queue, direct.jobId);
  });

  it("gives the definer only the job columns pg-boss's retry reads and writes, the singleton key the stranded-work sweep reads (ADR-111) and the data the job signing counts read (ADR-135)", async () => {
    const asDefiner = async (statement: string) => {
      const client = await dbs.adminPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE w360_definer');
        await client.query(statement);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    await asDefiner(
      `SELECT id, name, state, retry_limit, singleton_key, data FROM pgboss.job LIMIT 1`,
    );
    await asDefiner(
      `UPDATE pgboss.job SET state = 'retry', retry_limit = retry_limit + 1, completed_on = NULL
        WHERE name = 'it.none' AND id = gen_random_uuid() AND state = 'failed'`,
    );
    for (const statement of [
      `SELECT output FROM pgboss.job LIMIT 1`,
      `SELECT completed_on FROM pgboss.job LIMIT 1`,
      `UPDATE pgboss.job SET data = NULL WHERE false`,
      `UPDATE pgboss.job SET singleton_key = NULL WHERE false`,
      `UPDATE pgboss.job SET start_after = now() WHERE false`,
      `DELETE FROM pgboss.job WHERE false`,
      `INSERT INTO pgboss.job (name) VALUES ('x')`,
      `SELECT name FROM pgboss.queue LIMIT 1`,
    ]) {
      await expect(asDefiner(statement), statement).rejects.toThrow(/permission denied/);
    }
  });
});
