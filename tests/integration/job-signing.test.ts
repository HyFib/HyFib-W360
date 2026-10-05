import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inject } from 'vitest';
import { PgBoss } from 'pg-boss';
import { isAppError, uuidv7, type Clock } from '@w360/core';
import { sql } from '@w360/db';
import type { JobEnvelope } from '@w360/contracts';
import {
  JobSigner,
  RESIGN_IDLE_MS,
  authorizeJob,
  createPlatformOpsService,
  jobSigningKeyId,
  newResignState,
  pgBossQueueInspector,
  resignQueuedJobs,
  type PlatformActor,
  type ResignState,
} from '@w360/domain';
import {
  connectTestDatabases,
  createTenant,
  createUser,
  type TestDatabases,
  type TestTenant,
} from './helpers';

/**
 * Rotating the job signing key (SEC-4, ADR-135) against real PostgreSQL and pg-boss: while a
 * previous key is configured, the worker's sweep signs the waiting, retrying and failed jobs that key
 * signed (or that name no key) again with the signing key, with the same contents and time, so a
 * worker that knows only the new key runs them; never a job that does not verify, never a running or
 * finished job, and never a job a worker fetched between the lookup and the write. The console counts
 * jobs by the key they name, for platform administrators only.
 */
let dbs: TestDatabases;
let boss: PgBoss;
let owner: PgBoss;
let tenant: TestTenant;
let staff: PlatformActor;

const key = () => randomBytes(32).toString('hex');

async function admin<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

interface JobRow extends Record<string, unknown> {
  state: string;
  data: JobEnvelope & Record<string, unknown>;
  start_after: Date;
  retry_count: number;
}

const job = async (id: string) =>
  (
    await admin<JobRow>(
      'SELECT state, data, start_after, retry_count FROM pgboss.job WHERE id = $1',
      [id],
    )
  )[0]!;

/** A queue of this file's own, made with the migration role: one retry, then the dead letter. */
async function testQueue(): Promise<string> {
  const queue = `it.sign-${randomBytes(4).toString('hex')}`;
  await owner.createQueue(queue, { retryLimit: 1, retryDelay: 0, deadLetter: 'dead-letter' });
  return queue;
}

async function send(queue: string, data: unknown, options: { startAfter?: Date } = {}) {
  const id = await boss.send(queue, data as object, options);
  if (!id) throw new Error('pg-boss did not take the job');
  return id;
}

async function fetchOne(queue: string, id: string) {
  const [fetched] = await boss.fetch(queue);
  expect(fetched?.id).toBe(id);
}

const fail = (queue: string, id: string) =>
  boss.fail(queue, id, { name: 'AppError', code: 'provider_rejected', message: 'No' });

const envelopeFor = (ref: string, tenantId: string | null = null) => ({
  kind: 'crm.reminder',
  tenantId,
  actorUserId: null,
  ref,
});

const contents = (e: JobEnvelope) => ({
  v: e.v,
  kind: e.kind,
  tenantId: e.tenantId,
  actorUserId: e.actorUserId,
  ref: e.ref,
  issuedAt: e.issuedAt,
});

const ops = (signer: JobSigner) =>
  createPlatformOpsService({
    platformDb: dbs.platform,
    queues: pgBossQueueInspector(boss),
    clock: { now: () => new Date() },
    keyring: { currentKeyId: 'k1', keyIds: ['k1'] },
    jobSigning: signer,
  });

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

/** Sweeps until a lookup finds nothing (each sweep signs up to 500 jobs). */
async function sweepUntilIdle(signer: JobSigner, state: ResignState, clock: Clock) {
  const totals = { resigned: 0, changed: 0, unverifiable: [] as { queue: string; id: string }[] };
  for (let i = 0; i < 20 && state.idleUntil <= clock.now().getTime(); i += 1) {
    const r = await resignQueuedJobs({ db: dbs.app, signer, clock }, state);
    totals.resigned += r.resigned;
    totals.changed += r.changed;
    totals.unverifiable.push(...r.unverifiable);
  }
  return totals;
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
    max: 3,
  } as const;
  boss = new PgBoss({ ...options, connectionString: urls.app });
  owner = new PgBoss({ ...options, connectionString: urls.owner });
  boss.on('error', () => undefined);
  owner.on('error', () => undefined);
  await boss.start();
  await owner.start();
  const user = await createUser(dbs, { name: 'Job Signing Staff', twoFactor: true });
  await dbs.ownerPool.query(
    `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
    [user.id],
  );
  staff = { userId: user.id, role: 'platform_operator', correlationId: uuidv7() };
  tenant = await createTenant(dbs, await createUser(dbs));
});

afterAll(async () => {
  await owner.stop({ graceful: false, close: true });
  await boss.stop({ graceful: false, close: true });
  await dbs.close();
});

describe('rotating the job signing key (ADR-135)', () => {
  it('signs again what the previous key signed, so that a worker with only the new key runs it', async () => {
    const OLD = key();
    const NEW = key();
    const old = new JobSigner(OLD);
    const tag = randomBytes(3).toString('hex');
    const ref = (name: string) => `${name}-${tag}`;
    const issuedAt = Date.now() - 86_400_000;
    const waitingQueue = await testQueue();

    // Waiting now, scheduled months ahead, named after no key (signed before key ids), already
    // signed with the new key, forged in the previous key's name, and tampered with.
    const waiting = await send(
      waitingQueue,
      old.sign(envelopeFor(ref('waiting'), tenant.id), issuedAt),
    );
    const scheduled = await send(waitingQueue, old.sign(envelopeFor(ref('scheduled')), issuedAt), {
      startAfter: new Date(Date.now() + 90 * 86_400_000),
    });
    const { kid: _kid, ...unnamed } = old.sign(envelopeFor(ref('legacy')), issuedAt);
    const legacy = await send(waitingQueue, unnamed);
    const current = await send(waitingQueue, new JobSigner(NEW).sign(envelopeFor(ref('current'))));
    const forgedEnvelope = new JobSigner(key()).sign(envelopeFor(ref('forged'), tenant.id));
    const forged = await send(waitingQueue, { ...forgedEnvelope, kid: jobSigningKeyId(OLD) });
    const tampered = await send(waitingQueue, {
      ...old.sign(envelopeFor(ref('tampered'))),
      tenantId: tenant.id,
    });
    // Retrying after one failure; failed for good (with its dead letter's copy); running; finished.
    const retryQueue = await testQueue();
    const retrying = await send(retryQueue, old.sign(envelopeFor(ref('retrying')), issuedAt));
    await fetchOne(retryQueue, retrying);
    await fail(retryQueue, retrying);
    const failedQueue = await testQueue();
    const failed = await send(failedQueue, old.sign(envelopeFor(ref('failed')), issuedAt));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await fetchOne(failedQueue, failed);
      await fail(failedQueue, failed);
    }
    const [letter] = await admin<{ id: string }>(
      `SELECT id FROM pgboss.job WHERE name = 'dead-letter' AND data->>'ref' = $1`,
      [ref('failed')],
    );
    expect(letter).toBeDefined();
    const runningQueue = await testQueue();
    const running = await send(runningQueue, old.sign(envelopeFor(ref('running')), issuedAt));
    await fetchOne(runningQueue, running);
    const doneQueue = await testQueue();
    const finished = await send(doneQueue, old.sign(envelopeFor(ref('finished')), issuedAt));
    await fetchOne(doneQueue, finished);
    await boss.complete(doneQueue, finished);

    const toSign = { waiting, scheduled, legacy, retrying, failed, letter: letter!.id };
    const untouched = { current, forged, tampered, running, finished };
    const before = new Map<string, JobRow>();
    for (const id of [...Object.values(toSign), ...Object.values(untouched)]) {
      before.set(id, await job(id));
    }
    expect(before.get(retrying)!.state).toBe('retry');
    expect(before.get(failed)!.state).toBe('failed');
    expect(before.get(running)!.state).toBe('active');
    expect(before.get(finished)!.state).toBe('completed');

    // Step 2: the new key signs and the previous one is still accepted; the console counts.
    const step2 = new JobSigner(NEW, { previous: OLD });
    const ids = { old: jobSigningKeyId(OLD), new: jobSigningKeyId(NEW) };
    const counted = await ops(step2).jobSigning(staff);
    expect(counted.keys.find((k) => k.keyId === ids.old)).toEqual({
      keyId: ids.old,
      role: 'previous',
      queued: 6,
      active: 1,
      failed: 1,
    });
    expect(counted.keys.find((k) => k.keyId === ids.new)).toEqual({
      keyId: ids.new,
      role: 'signing',
      queued: 1,
      active: 0,
      failed: 0,
    });
    const unnamedCount = counted.keys.find((k) => k.keyId === null);
    expect(unnamedCount?.queued).toBeGreaterThanOrEqual(1);
    expect(counted.toResign).toBe(
      8 + unnamedCount!.queued + unnamedCount!.active + unnamedCount!.failed,
    );

    let now = Date.now();
    const clock = { now: () => new Date(now) };
    const state = newResignState();
    const swept = await sweepUntilIdle(step2, state, clock);
    expect(swept.resigned).toBe(6);
    expect(swept.changed).toBe(0);
    expect(swept.unverifiable).toEqual(
      expect.arrayContaining([
        { queue: waitingQueue, id: forged },
        { queue: waitingQueue, id: tampered },
      ]),
    );
    expect(swept.unverifiable.filter((j) => j.id === forged)).toHaveLength(1);

    // Step 3: a worker that knows only the new key verifies each job signed again, unchanged
    // otherwise, and still refuses the forged and tampered ones; nothing else moved.
    const step3 = new JobSigner(NEW);
    for (const [name, id] of Object.entries(toSign)) {
      const was = before.get(id)!;
      const now_ = await job(id);
      expect(now_.data.kid, name).toBe(ids.new);
      expect(contents(now_.data), name).toEqual(contents(was.data));
      expect(step3.verify(now_.data), name).not.toBeNull();
      expect([now_.state, now_.start_after, now_.retry_count], name).toEqual([
        was.state,
        was.start_after,
        was.retry_count,
      ]);
    }
    for (const [name, id] of Object.entries(untouched)) {
      expect((await job(id)).data, name).toEqual(before.get(id)!.data);
    }
    expect(step3.verify((await job(forged)).data)).toBeNull();
    expect(step3.verify((await job(tampered)).data)).toBeNull();
    expect(step3.verify((await job(running)).data)).toBeNull();
    const authorized = await authorizeJob(
      { db: dbs.app, signer: step3 },
      (await job(waiting)).data,
      { expectedKind: 'crm.reminder', requireActiveTenant: true, requireActiveActor: true },
    );
    expect(authorized.outcome).toBe('authorized');

    // The running job fails and waits for its retry: within the hour after a lookup found
    // nothing the sweep looks nothing up; after it, the job is signed again too.
    await fail(runningQueue, running);
    expect((await job(running)).state).toBe('retry');
    const quiet = await resignQueuedJobs({ db: dbs.app, signer: step2, clock }, state);
    expect(quiet).toEqual({ resigned: 0, changed: 0, unverifiable: [], stopped: false });
    now += RESIGN_IDLE_MS;
    const later = await sweepUntilIdle(step2, state, clock);
    expect(later.resigned).toBe(1);
    expect(later.unverifiable).toEqual([]);
    expect(step3.verify((await job(running)).data)?.ref).toBe(ref('running'));

    const after = await ops(step2).jobSigning(staff);
    expect(after.keys.find((k) => k.keyId === ids.old)).toEqual({
      keyId: ids.old,
      role: 'previous',
      queued: 2,
      active: 0,
      failed: 0,
    });
    expect(after.keys.find((k) => k.keyId === ids.new)).toEqual({
      keyId: ids.new,
      role: 'signing',
      queued: 7,
      active: 0,
      failed: 1,
    });
  });

  /**
   * Starts the sweep while `holder` holds the job's row with a change of its own, waits until the
   * sweep's write waits for that row, then commits the change.
   */
  async function raceWith(signer: JobSigner, id: string, change: string, params: unknown[]) {
    const holder = await dbs.adminPool.connect();
    let outcome: ReturnType<typeof resignQueuedJobs> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(change, [id, ...params]);
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      outcome = resignQueuedJobs(
        { db: dbs.app, signer, clock: { now: () => new Date() } },
        newResignState(),
      );
      await vi.waitFor(
        async () => {
          const [waiting] = await admin<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the sweep is not waiting');
        },
        { timeout: 4_000, interval: 20 },
      );
      await holder.query('COMMIT');
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    } finally {
      holder.release();
    }
    return outcome!;
  }

  it('leaves a job a worker fetched, or whose data changed, between the lookup and the write', async () => {
    const OLD = key();
    const NEW = key();
    const step2 = new JobSigner(NEW, { previous: OLD });
    const queue = await testQueue();

    // What pg-boss does when a worker fetches the job: it is running now.
    const fetched = await send(queue, new JobSigner(OLD).sign(envelopeFor(`race-${uuidv7()}`)));
    const original = await job(fetched);
    const first = await raceWith(
      step2,
      fetched,
      `UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = $1`,
      [],
    );
    expect([first.resigned, first.changed]).toEqual([0, 1]);
    expect((await job(fetched)).state).toBe('active');
    expect((await job(fetched)).data).toEqual(original.data);

    // Its data replaced by something else: the sweep does not put back what it read.
    const replaced = await send(queue, new JobSigner(OLD).sign(envelopeFor(`race-${uuidv7()}`)));
    const replacement = new JobSigner(NEW).sign(envelopeFor(`replacement-${uuidv7()}`));
    const second = await raceWith(
      step2,
      replaced,
      'UPDATE pgboss.job SET data = $2::jsonb WHERE id = $1',
      [JSON.stringify(replacement)],
    );
    expect([second.resigned, second.changed]).toEqual([0, 1]);
    expect((await job(replaced)).data).toEqual(replacement);
  });

  it('counts jobs by key for platform administrators only, and runs for the right roles', async () => {
    const signer = new JobSigner(key());
    const queue = await testQueue();
    await send(queue, signer.sign(envelopeFor(`count-${uuidv7()}`)));
    // A finished job and data that is no envelope are not counted.
    const finishedSigner = new JobSigner(key());
    const doneQueue = await testQueue();
    const finished = await send(doneQueue, finishedSigner.sign(envelopeFor(`count-${uuidv7()}`)));
    await fetchOne(doneQueue, finished);
    await boss.complete(doneQueue, finished);
    const notEnvelope = randomBytes(8).toString('hex');
    await send(queue, { kid: notEnvelope, note: 'not a job envelope' });
    const rows = await dbs.platform.run(staff.userId, (tx) =>
      tx.execute<{ key_id: string | null; state: string; jobs: string }>(
        sql`select key_id, state, jobs from ops.job_signing_key_counts()`,
      ),
    );
    for (const row of rows.rows) {
      expect(['created', 'retry', 'active', 'failed']).toContain(row.state);
      expect(row.key_id).not.toBe(finishedSigner.keyId);
      expect(row.key_id).not.toBe(notEnvelope);
    }
    const overview = await ops(signer).jobSigning(staff);
    expect(overview.keyId).toBe(signer.keyId);
    expect(overview.keys[0]).toEqual({
      keyId: signer.keyId,
      role: 'signing',
      queued: 1,
      active: 0,
      failed: 0,
    });
    expect(overview.toResign).toBe(0);

    const outsider = await createUser(dbs, { twoFactor: true });
    await expectCode(
      ops(signer).jobSigning({
        userId: outsider.id,
        role: 'platform_operator',
        correlationId: uuidv7(),
      }),
      'forbidden',
    );
    const fn = 'ops.job_signing_key_counts()';
    for (const [role, allowed] of [
      ['w360_platform', true],
      ['w360_app', false],
      ['w360_auth', false],
    ] as const) {
      const [row] = await admin<{ ok: boolean }>(
        `SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`,
        [role, fn],
      );
      expect(row!.ok, role).toBe(allowed);
    }
    const [definition] = await admin<{ definer: boolean; owner: string; config: string[] }>(
      `SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [fn],
    );
    expect(definition).toEqual({
      definer: true,
      owner: 'w360_definer',
      config: ['search_path=pg_catalog, pg_temp'],
    });
    // The definer reads a job's data for the counts and writes nothing more of it than before.
    const [grants] = await admin<{ read: boolean; write: boolean }>(
      `SELECT has_column_privilege('w360_definer', 'pgboss.job', 'data', 'SELECT') AS read,
              has_column_privilege('w360_definer', 'pgboss.job', 'data', 'UPDATE') AS write`,
    );
    expect(grants).toEqual({ read: true, write: false });
  });
});
