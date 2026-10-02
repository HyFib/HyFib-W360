import { inject } from 'vitest';
import pg from 'pg';
import { randomToken, sha256Hex, uuidv7 } from '@w360/core';
import {
  authenticatedUserScope,
  authorizedTenantScope,
  createDatabase,
  createPool,
  type Database,
  sql,
} from '@w360/db';
import { createPlatformDatabase, type PlatformDatabase } from '@w360/db/platform';

export interface TestDatabases {
  app: Database;
  appPool: pg.Pool;
  authPool: pg.Pool;
  platform: PlatformDatabase;
  platformPool: pg.Pool;
  ownerPool: pg.Pool;
  adminPool: pg.Pool;
  close(): Promise<void>;
}

export function connectTestDatabases(options: { appPoolMax?: number } = {}): TestDatabases {
  const urls = inject('dbUrls');
  const appPool = createPool({
    connectionString: urls.app,
    max: options.appPoolMax ?? 5,
    applicationName: 'it-app',
  });
  const authPool = new pg.Pool({
    connectionString: urls.auth,
    max: 3,
    application_name: 'it-auth',
  });
  const platformPool = createPool({
    connectionString: urls.platform,
    max: 2,
    applicationName: 'it-platform',
  });
  const ownerPool = new pg.Pool({
    connectionString: urls.owner,
    max: 2,
    application_name: 'it-owner',
  });
  const adminPool = new pg.Pool({
    connectionString: urls.admin,
    max: 2,
    application_name: 'it-admin',
  });
  const app = createDatabase(appPool);
  const platform = createPlatformDatabase(platformPool);
  return {
    app,
    appPool,
    authPool,
    platform,
    platformPool,
    ownerPool,
    adminPool,
    async close() {
      await Promise.all([
        appPool.end(),
        authPool.end(),
        platformPool.end(),
        ownerPool.end(),
        adminPool.end(),
      ]);
    },
  };
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
}

let userCounter = 0;

/** Inserts an identity row the way the auth library would (through the w360_auth role). */
export async function createUser(
  dbs: TestDatabases,
  options: { email?: string; name?: string; verified?: boolean; twoFactor?: boolean } = {},
): Promise<TestUser> {
  userCounter += 1;
  const id = `usr_${randomToken(12)}`;
  const email = (
    options.email ?? `user${userCounter}.${randomToken(4).toLowerCase()}@example.test`
  ).toLowerCase();
  const name = options.name ?? `Test User ${userCounter}`;
  await dbs.authPool.query(
    `INSERT INTO auth.users (id, name, email, email_verified, two_factor_enabled) VALUES ($1, $2, $3, $4, $5)`,
    [id, name, email, options.verified ?? true, options.twoFactor ?? false],
  );
  return { id, email, name };
}

export interface TestTenant {
  id: string;
  slug: string;
  ownerMembershipId: string;
}

export async function createTenant(
  dbs: TestDatabases,
  owner: TestUser,
  slug?: string,
): Promise<TestTenant> {
  const tenantId = uuidv7();
  const membershipId = uuidv7();
  const s =
    slug ??
    `co-${randomToken(6)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}`;
  await dbs.app.run(authenticatedUserScope(owner.id), async (tx) => {
    await tx.execute(
      sql`select app.create_tenant(${tenantId}::uuid, ${membershipId}::uuid, ${'Company ' + s}, ${s}, 'Asia/Kolkata', 'en')`,
    );
  });
  return { id: tenantId, slug: s, ownerMembershipId: membershipId };
}

/** Creates a pending invitation inside the tenant scope and returns the raw token. */
export async function invite(
  dbs: TestDatabases,
  tenant: TestTenant,
  inviter: TestUser,
  email: string,
  roles: string[],
  options: { expiresAt?: Date } = {},
): Promise<{ token: string; invitationId: string }> {
  const token = randomToken();
  const invitationId = uuidv7();
  await dbs.app.run(authorizedTenantScope(tenant.id, inviter.id), async (tx) => {
    await tx.execute(sql`
      insert into app.invitations (id, tenant_id, email, roles, token_hash, expires_at, invited_by_user_id)
      values (${invitationId}::uuid, ${tenant.id}::uuid, ${email.toLowerCase()}, ${`{${roles.join(',')}}`}::text[],
              ${sha256Hex(token)}, ${(options.expiresAt ?? new Date(Date.now() + 7 * 86400_000)).toISOString()}::timestamptz,
              ${inviter.id})`);
  });
  return { token, invitationId };
}

export async function acceptInvitation(
  dbs: TestDatabases,
  user: TestUser,
  token: string,
): Promise<string> {
  const membershipId = uuidv7();
  return dbs.app.run(authenticatedUserScope(user.id), async (tx) => {
    const res = await tx.execute<{ tenant_id: string }>(
      sql`select app.accept_invitation(${sha256Hex(token)}, ${membershipId}::uuid) as tenant_id`,
    );
    return res.rows[0]!.tenant_id;
  });
}

/**
 * The webhook delivery job's logger where every delivery should be prepared: anything it logs (a
 * delivery that failed as `payload_failed`) fails the test, with the ids and the error's class.
 */
export const failOnLog = {
  error(fields: Record<string, unknown>, message: string): never {
    throw new Error(`${message}: ${JSON.stringify(fields)}`);
  },
};

/** Two companies with owners plus an extra member in A, the standard adversarial fixture. */
export async function twoTenantFixture(dbs: TestDatabases) {
  const ownerA = await createUser(dbs, { name: 'Owner A' });
  const ownerB = await createUser(dbs, { name: 'Owner B' });
  const tenantA = await createTenant(dbs, ownerA);
  const tenantB = await createTenant(dbs, ownerB);
  const agentA = await createUser(dbs, { name: 'Agent A' });
  const { token } = await invite(dbs, tenantA, ownerA, agentA.email, ['agent']);
  await acceptInvitation(dbs, agentA, token);
  return { ownerA, ownerB, agentA, tenantA, tenantB };
}
