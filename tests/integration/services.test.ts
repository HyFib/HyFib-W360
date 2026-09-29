import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, isAppError, systemClock, uuidv7 } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  JobSigner,
  PgBossJobQueue,
  createPlatformService,
  createRateCardsService,
  createTenancyService,
  resolveTenantContext,
  type PlatformActor,
} from '@w360/domain';
import {
  connectTestDatabases,
  createTenant,
  createUser,
  twoTenantFixture,
  type TestDatabases,
} from './helpers';

/** Domain services against the real database: the checks that SQL policies alone cannot express. */
let dbs: TestDatabases;
let fx: Awaited<ReturnType<typeof twoTenantFixture>>;
let boss: PgBoss;
const signer = new JobSigner(randomBytes(32).toString('hex'));
const keyring = new Keyring({ primaryKeyId: 'test', keys: { test: randomBytes(32) } });

beforeAll(async () => {
  dbs = connectTestDatabases({ appPoolMax: 10 });
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

function tenancyService() {
  return createTenancyService({
    db: dbs.app,
    clock: systemClock,
    keyring,
    jobs: new PgBossJobQueue(boss),
    signer,
    appBaseUrl: 'http://localhost:3000',
    invitationTtlHours: 24,
  });
}

async function platformActor(): Promise<PlatformActor> {
  const admin = await createUser(dbs, { twoFactor: true });
  await dbs.ownerPool.query(
    `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
    [admin.id],
  );
  return { userId: admin.id, role: 'platform_operator', correlationId: uuidv7() };
}

describe('invitation quota', () => {
  it('holds under concurrent requests (issuance is serialised per company)', async () => {
    const owner = await createUser(dbs, { name: 'Quota Owner' });
    const tenant = await createTenant(dbs, owner);
    // 99 invitations already issued today: exactly one more fits under the daily limit of 100.
    await dbs.app.run(authorizedTenantScope(tenant.id, owner.id), (tx) =>
      tx.execute(sql`
        insert into app.invitations (id, tenant_id, email, roles, token_hash, expires_at, invited_by_user_id)
        select gen_random_uuid(), ${tenant.id}::uuid, 'bulk' || g || '@example.test', '{agent}',
               encode(sha256(convert_to(${randomBytes(8).toString('hex')} || g, 'UTF8')), 'hex'),
               now() + interval '1 day', ${owner.id}
          from generate_series(1, 99) g`),
    );
    const ctx = await resolveTenantContext(
      { db: dbs.app, clock: systemClock, mfaGracePeriodHours: 72 },
      { userId: owner.id, sessionId: null, tenantSlug: tenant.slug, correlationId: uuidv7() },
    );
    const service = tenancyService();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        service.createInvitation(ctx, { email: `rush${i}@example.test`, roles: ['agent'] }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    for (const reason of rejected) {
      expect(isAppError(reason) && reason.code).toBe('rate_limited');
    }
    const { rows } = await dbs.adminPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.invitations WHERE tenant_id = $1`,
      [tenant.id],
    );
    expect(rows[0]!.n).toBe(100);
  });
});

describe('audit log', () => {
  it('pages through events recorded in one transaction, which share their time to the microsecond', async () => {
    const owner = await createUser(dbs, { name: 'Audit Owner' });
    const tenant = await createTenant(dbs, owner);
    // Seven events written by one statement, as the changes of one request are.
    await dbs.app.run(authorizedTenantScope(tenant.id, owner.id), (tx) =>
      tx.execute(sql`
        insert into app.audit_events (id, tenant_id, actor_type, actor_id, action, result)
        select gen_random_uuid(), ${tenant.id}::uuid, 'user', ${owner.id}, 'test.bulk_' || g, 'success'
          from generate_series(1, 7) g`),
    );
    const { rows } = await dbs.adminPool.query<{ id: string }>(
      'SELECT id FROM app.audit_events WHERE tenant_id = $1 ORDER BY occurred_at DESC, id DESC',
      [tenant.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(7);
    const ctx = await resolveTenantContext(
      { db: dbs.app, clock: systemClock, mfaGracePeriodHours: 72 },
      { userId: owner.id, sessionId: null, tenantSlug: tenant.slug, correlationId: uuidv7() },
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await tenancyService().listAuditEvents(ctx, { limit: 2, cursor });
      expect(page.events[0]).not.toHaveProperty('cursorAt');
      seen.push(...page.events.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor && seen.length < 100);
    expect(seen).toEqual(rows.map((r) => r.id));
  });
});

describe('platform console', () => {
  it('loads any company by id, with seat counts and owners from the narrow helpers', async () => {
    const actor = await platformActor();
    const platform = createPlatformService({
      db: dbs.app,
      platformDb: dbs.platform,
      clock: systemClock,
    });
    const company = await platform.getTenant(actor, fx.tenantA.id);
    expect(company).toMatchObject({ id: fx.tenantA.id, slug: fx.tenantA.slug });
    expect(company!.activeMembers).toBe(2);
    expect(await platform.getTenant(actor, uuidv7())).toBeNull();
    expect(await platform.getTenant(actor, 'not-a-uuid')).toBeNull();

    const listed = await platform.listTenants(actor, { search: fx.tenantB.slug });
    expect(listed.find((c) => c.id === fx.tenantB.id)?.activeMembers).toBe(1);

    const owners = await platform.tenantOwners(actor, fx.tenantA.id);
    expect(owners).toEqual([
      {
        userId: fx.ownerA.id,
        name: 'Owner A',
        status: 'active',
        twoFactorEnabled: false,
      },
    ]);
  });

  it('lists rate cards with the number of markets each one prices', async () => {
    const actor = await platformActor();
    const rateCards = createRateCardsService({ platformDb: dbs.platform, clock: systemClock });
    const { id } = await rateCards.createRateCard(actor, {
      currency: 'XTS',
      effectiveFrom: '2031-01-01T00:00',
      sourceUrl: 'https://example.test/rate-card',
      csv: 'market,calling_codes,marketing,utility\nIndia,91,0.78,0.12\nIndonesia,62,0.41,0.2',
    });
    const listed = await rateCards.listRateCards(actor);
    expect(listed.find((c) => c.id === id)).toMatchObject({ currency: 'XTS', markets: 2 });
  });

  it('records the end of support access in the company audit log', async () => {
    const actor = await platformActor();
    const platform = createPlatformService({
      db: dbs.app,
      platformDb: dbs.platform,
      clock: systemClock,
    });
    const { grantId } = await platform.grantSupportAccess(actor, {
      tenantId: fx.tenantB.id,
      reason: 'Customer reported missing invitation emails',
      scopes: ['members.read'],
      durationMinutes: 30,
    });
    await platform.revokeSupportAccess(actor, grantId);
    const { rows } = await dbs.adminPool.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 ORDER BY occurred_at, id`,
      [fx.tenantB.id, grantId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'platform.support_access_granted',
      'platform.support_access_revoked',
    ]);
    expect(rows.every((r) => r.actor_id === actor.userId)).toBe(true);
  });
});
