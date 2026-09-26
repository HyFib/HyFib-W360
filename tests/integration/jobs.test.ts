import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, ManualClock, uuidv7 } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope, emailOutbox, eq, invitations, sql, systemScope } from '@w360/db';
import {
  EmailSendError,
  JobSigner,
  PgBossJobQueue,
  authorizeJob,
  enqueueEmail,
  findStaleOutboxRows,
  processEmailOutbox,
  type EmailSender,
} from '@w360/domain';
import { connectTestDatabases, invite, twoTenantFixture, type TestDatabases } from './helpers';

let dbs: TestDatabases;
let fx: Awaited<ReturnType<typeof twoTenantFixture>>;
let boss: PgBoss;
const signer = new JobSigner(randomBytes(32).toString('hex'));
const keyring = new Keyring({ primaryKeyId: 'test', keys: { test: randomBytes(32) } });

beforeAll(async () => {
  dbs = connectTestDatabases();
  fx = await twoTenantFixture(dbs);
  boss = new PgBoss({
    connectionString: inject('dbUrls').app,
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    max: 3,
  });
  boss.on('error', () => undefined);
  await boss.start();
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await dbs.close();
});

/** A representative company job: act on an invitation referenced by id. */
async function runInvitationJob(data: unknown) {
  const auth = await authorizeJob({ db: dbs.app, signer }, data, {
    expectedKind: 'invitation.process',
    requireActiveTenant: true,
    requireActiveActor: true,
  });
  if (auth.outcome !== 'authorized' || !auth.scope) return { auth, row: null };
  const row = await dbs.app.run(auth.scope, async (tx) => {
    const rows = await tx
      .select({ id: invitations.id, tenantId: invitations.tenantId })
      .from(invitations)
      .where(eq(invitations.id, auth.envelope.ref));
    return rows[0] ?? null;
  });
  return { auth, row };
}

describe('worker job authorization', () => {
  it('drops forged or tampered envelopes and records a security event', async () => {
    const env = signer.sign({
      kind: 'invitation.process',
      tenantId: fx.tenantA.id,
      actorUserId: fx.ownerA.id,
      ref: uuidv7(),
    });
    const before = await dbs.adminPool.query(
      `SELECT count(*)::int AS n FROM ops.security_events WHERE event_type = 'job.invalid_signature'`,
    );
    const tampered = await runInvitationJob({ ...env, tenantId: fx.tenantB.id });
    expect(tampered.auth).toEqual({ outcome: 'rejected', reason: 'invalid_signature' });
    const forged = await runInvitationJob({ ...env, sig: 'f'.repeat(64) });
    expect(forged.auth.outcome).toBe('rejected');
    const after = await dbs.adminPool.query(
      `SELECT count(*)::int AS n FROM ops.security_events WHERE event_type = 'job.invalid_signature'`,
    );
    expect(after.rows[0].n - before.rows[0].n).toBe(2);
  });

  it('a validly signed job for company A cannot reach company B rows', async () => {
    const { invitationId: bInvitation } = await invite(
      dbs,
      fx.tenantB,
      fx.ownerB,
      'b-only@example.test',
      ['agent'],
    );
    const env = signer.sign({
      kind: 'invitation.process',
      tenantId: fx.tenantA.id,
      actorUserId: fx.ownerA.id,
      ref: bInvitation,
    });
    const result = await runInvitationJob(env);
    expect(result.auth.outcome).toBe('authorized');
    expect(result.row).toBeNull();
  });

  it('a job for its own company finds its row', async () => {
    const { invitationId } = await invite(dbs, fx.tenantA, fx.ownerA, 'a-own@example.test', [
      'agent',
    ]);
    const env = signer.sign({
      kind: 'invitation.process',
      tenantId: fx.tenantA.id,
      actorUserId: fx.ownerA.id,
      ref: invitationId,
    });
    const result = await runInvitationJob(env);
    expect(result.row).toEqual({ id: invitationId, tenantId: fx.tenantA.id });
  });

  it('rejects jobs of an unexpected kind', async () => {
    const env = signer.sign({
      kind: 'email.send',
      tenantId: fx.tenantA.id,
      actorUserId: null,
      ref: uuidv7(),
    });
    expect((await runInvitationJob(env)).auth).toEqual({
      outcome: 'rejected',
      reason: 'unexpected_kind',
    });
  });

  it('defers outbound work while a company is suspended and resumes after reactivation', async () => {
    const env = signer.sign({
      kind: 'invitation.process',
      tenantId: fx.tenantB.id,
      actorUserId: fx.ownerB.id,
      ref: uuidv7(),
    });
    const admin = uuidv7();
    await dbs.adminPool.query(
      `INSERT INTO auth.users (id, name, email, email_verified) VALUES ($1, 'Ops', $2, true)`,
      [admin, `${admin}@example.test`],
    );
    await dbs.platform.run(admin, (tx) =>
      tx.execute(
        sql`update app.tenants set status = 'suspended' where id = ${fx.tenantB.id}::uuid`,
      ),
    );
    expect((await runInvitationJob(env)).auth).toMatchObject({
      outcome: 'deferred',
      reason: 'tenant_suspended',
      cleanupScope: { kind: 'tenant', tenantId: fx.tenantB.id, userId: null },
    });
    await dbs.platform.run(admin, (tx) =>
      tx.execute(sql`update app.tenants set status = 'active' where id = ${fx.tenantB.id}::uuid`),
    );
    expect((await runInvitationJob(env)).auth.outcome).toBe('authorized');
  });

  it('stops work queued by a member whose membership was revoked in the meantime', async () => {
    const env = signer.sign({
      kind: 'invitation.process',
      tenantId: fx.tenantA.id,
      actorUserId: fx.agentA.id,
      ref: uuidv7(),
    });
    expect((await runInvitationJob(env)).auth.outcome).toBe('authorized');
    await dbs.app.run(authorizedTenantScope(fx.tenantA.id, fx.ownerA.id), (tx) =>
      tx.execute(
        sql`update app.memberships set status = 'suspended' where user_id = ${fx.agentA.id} and tenant_id = ${fx.tenantA.id}::uuid`,
      ),
    );
    expect((await runInvitationJob(env)).auth).toMatchObject({
      outcome: 'rejected',
      reason: 'actor_not_member',
      cleanupScope: { kind: 'tenant', tenantId: fx.tenantA.id, userId: null },
    });
    await dbs.app.run(authorizedTenantScope(fx.tenantA.id, fx.ownerA.id), (tx) =>
      tx.execute(
        sql`update app.memberships set status = 'active' where user_id = ${fx.agentA.id} and tenant_id = ${fx.tenantA.id}::uuid`,
      ),
    );
  });

  it('rejects jobs for a deleted company', async () => {
    const env = signer.sign({
      kind: 'invitation.process',
      tenantId: uuidv7(),
      actorUserId: null,
      ref: uuidv7(),
    });
    expect((await runInvitationJob(env)).auth).toEqual({
      outcome: 'rejected',
      reason: 'tenant_missing',
    });
  });
});

describe('transactional enqueue', () => {
  const queue = () => new PgBossJobQueue(boss);

  it('a job enqueued in a rolled-back transaction never becomes visible', async () => {
    const ref = uuidv7();
    await expect(
      dbs.app.run(systemScope, async (tx) => {
        await queue().enqueue(
          tx,
          QUEUES.emailSend.name,
          signer.sign({ kind: 'email.send', tenantId: null, actorUserId: null, ref }),
          { singletonKey: ref },
        );
        throw new Error('business write failed');
      }),
    ).rejects.toThrow('business write failed');
    const jobs = await dbs.adminPool.query(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE singleton_key = $1`,
      [ref],
    );
    expect(jobs.rows[0].n).toBe(0);
  });

  it('a job enqueued in a committed transaction is visible exactly once per key', async () => {
    const ref = uuidv7();
    for (let i = 0; i < 3; i += 1) {
      await dbs.app.run(systemScope, (tx) =>
        queue().enqueue(
          tx,
          QUEUES.emailSend.name,
          signer.sign({ kind: 'email.send', tenantId: null, actorUserId: null, ref }),
          { singletonKey: ref },
        ),
      );
    }
    const jobs = await dbs.adminPool.query(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE singleton_key = $1`,
      [ref],
    );
    expect(jobs.rows[0].n).toBe(1);
  });
});

class FakeSender implements EmailSender {
  sent: string[] = [];
  failWith: EmailSendError | null = null;
  delayMs = 0;
  async send(message: { to: string }) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw this.failWith;
    this.sent.push(message.to);
    return { providerMessageId: `msg-${this.sent.length}` };
  }
}

async function createOutboxRow(to: string): Promise<string> {
  const jobs = new PgBossJobQueue(boss);
  return dbs.app.run(systemScope, (tx) =>
    enqueueEmail({ keyring, jobs, signer }, tx, {
      to,
      payload: {
        kind: 'auth.verify_email',
        name: 'Test',
        url: 'https://app.example.test/verify?token=x',
      },
    }),
  );
}

describe('email outbox delivery', () => {
  it('delivers once, records the provider id and erases the encrypted payload', async () => {
    const id = await createOutboxRow('deliver@example.test');
    const sender = new FakeSender();
    const clock = new ManualClock(new Date());
    expect(await processEmailOutbox({ db: dbs.app, keyring, sender, clock }, id)).toBe('sent');
    expect(await processEmailOutbox({ db: dbs.app, keyring, sender, clock }, id)).toBe(
      'not_claimable',
    );
    expect(sender.sent).toEqual(['deliver@example.test']);
    const row = await dbs.app.run(
      systemScope,
      async (tx) => (await tx.select().from(emailOutbox).where(eq(emailOutbox.id, id)))[0],
    );
    expect(row).toMatchObject({
      status: 'sent',
      payloadCiphertext: null,
      providerMessageId: 'msg-1',
      attempts: 1,
    });
  });

  it('two workers racing for the same row send it only once', async () => {
    const id = await createOutboxRow('race@example.test');
    const sender = new FakeSender();
    sender.delayMs = 100;
    const clock = new ManualClock(new Date());
    const results = await Promise.all([
      processEmailOutbox({ db: dbs.app, keyring, sender, clock }, id),
      processEmailOutbox({ db: dbs.app, keyring, sender, clock }, id),
    ]);
    expect(results.sort()).toEqual(['not_claimable', 'sent']);
    expect(sender.sent).toEqual(['race@example.test']);
  });

  it('transient failures are retried; permanent failures stop and drop the payload', async () => {
    const id = await createOutboxRow('flaky@example.test');
    const sender = new FakeSender();
    const clock = new ManualClock(new Date());
    sender.failWith = new EmailSendError('temporary', false);
    expect(await processEmailOutbox({ db: dbs.app, keyring, sender, clock }, id)).toBe(
      'retry_scheduled',
    );
    sender.failWith = new EmailSendError('mailbox does not exist', true);
    expect(await processEmailOutbox({ db: dbs.app, keyring, sender, clock }, id)).toBe(
      'failed_permanent',
    );
    const row = await dbs.app.run(
      systemScope,
      async (tx) => (await tx.select().from(emailOutbox).where(eq(emailOutbox.id, id)))[0],
    );
    expect(row).toMatchObject({ status: 'failed', attempts: 2, payloadCiphertext: null });
  });

  it('a worker that died mid-delivery leaves a lease that the sweeper recovers after expiry', async () => {
    const id = await createOutboxRow('crash@example.test');
    const t0 = new Date();
    // Simulate a worker that claimed the row and then crashed before recording the result.
    await dbs.app.run(systemScope, (tx) =>
      tx
        .update(emailOutbox)
        .set({ status: 'sending', lockedUntil: new Date(t0.getTime() + 120_000), attempts: 1 })
        .where(eq(emailOutbox.id, id)),
    );
    const sender = new FakeSender();
    expect(
      await processEmailOutbox({ db: dbs.app, keyring, sender, clock: new ManualClock(t0) }, id),
    ).toBe('not_claimable');
    const later = new ManualClock(new Date(t0.getTime() + 121_000));
    expect(await findStaleOutboxRows({ db: dbs.app, clock: later })).toContain(id);
    expect(await processEmailOutbox({ db: dbs.app, keyring, sender, clock: later }, id)).toBe(
      'sent',
    );
  });

  it('refuses to decrypt a payload copied from another row (AAD binding)', async () => {
    const a = await createOutboxRow('aad-a@example.test');
    const b = await createOutboxRow('aad-b@example.test');
    const source = await dbs.app.run(
      systemScope,
      async (tx) => (await tx.select().from(emailOutbox).where(eq(emailOutbox.id, a)))[0]!,
    );
    await dbs.app.run(systemScope, (tx) =>
      tx
        .update(emailOutbox)
        .set({ payloadCiphertext: source.payloadCiphertext })
        .where(eq(emailOutbox.id, b)),
    );
    const sender = new FakeSender();
    expect(
      await processEmailOutbox(
        { db: dbs.app, keyring, sender, clock: new ManualClock(new Date()) },
        b,
      ),
    ).toBe('failed_permanent');
    expect(sender.sent).toEqual([]);
  });
});
