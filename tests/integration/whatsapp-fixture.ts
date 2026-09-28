import { randomBytes, randomInt } from 'node:crypto';
import { inject } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, channelAccounts, sql, whatsappAccounts } from '@w360/db';
import {
  GraphClient,
  JobSigner,
  PgBossJobQueue,
  credentialAad,
  processMetaWebhookReceipt,
  resolveTenantContext,
  storeWebhookReceipt,
  type TenantContext,
} from '@w360/domain';
import {
  acceptInvitation,
  connectTestDatabases,
  createTenant,
  createUser,
  invite,
  type TestDatabases,
  type TestTenant,
  type TestUser,
} from './helpers';
import { startGraphStandIn, type GraphStandIn } from '../support/graph-stand-in';

/**
 * Shared set-up for suites that need a company with a connected WhatsApp account and number:
 * real PostgreSQL, a producer-only pg-boss, and the test-only Graph stand-in.
 */
export const APP_ID = '1000000000001';
export const APP_SECRET = 'test-app-secret-'.padEnd(40, 'x');

export interface Company {
  owner: TestUser;
  agent: TestUser;
  marketer: TestUser;
  tenant: TestTenant;
  wabaId: string;
  phoneNumberId: string;
  whatsappAccountId: string;
  channelAccountId: string;
  token: string;
}

export interface InboundSpec {
  id?: string;
  waId?: string;
  text?: string;
  type?: string;
  extra?: Record<string, unknown>;
  timestamp?: number;
}

export interface WhatsAppFixture {
  dbs: TestDatabases;
  boss: PgBoss;
  standIn: GraphStandIn;
  graph: GraphClient;
  signer: JobSigner;
  keyring: Keyring;
  jobs(): PgBossJobQueue;
  company(): Promise<Company>;
  ctx(company: Company, user: TestUser): Promise<TenantContext>;
  messagesBody(
    company: Company,
    value: { messages?: InboundSpec[]; statuses?: Record<string, unknown>[] },
  ): unknown;
  fieldBody(wabaId: string, field: string, value: Record<string, unknown>): unknown;
  deliver(body: unknown, clock?: Clock): Promise<{ receiptId: string; outcome: string }>;
  query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * Meta-style numeric ids. Every test file shares one database and the asset bindings are unique
 * across companies, so ids must not repeat between files: a per-file counter cannot guarantee
 * that, 47 random bits do.
 */
export const nextExternalId = () => '8' + String(randomInt(0, 2 ** 47)).padStart(15, '0');

export async function startWhatsAppFixture(): Promise<WhatsAppFixture> {
  const dbs = connectTestDatabases({ appPoolMax: 10 });
  const boss = new PgBoss({
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
  const standIn = await startGraphStandIn({ appId: APP_ID, appSecret: APP_SECRET });
  const graph = new GraphClient({ baseUrl: standIn.baseUrl, version: 'v26.0', timeoutMs: 1_500 });
  const signer = new JobSigner(randomBytes(32).toString('hex'));
  const keyring = new Keyring({ primaryKeyId: 'test', keys: { test: randomBytes(32) } });
  const jobs = () => new PgBossJobQueue(boss);

  const fixture: WhatsAppFixture = {
    dbs,
    boss,
    standIn,
    graph,
    signer,
    keyring,
    jobs,
    async company() {
      const owner = await createUser(dbs, { name: 'Owner' });
      const tenant = await createTenant(dbs, owner);
      const agent = await createUser(dbs, { name: 'Agent' });
      const marketer = await createUser(dbs, { name: 'Marketer' });
      for (const [user, role] of [
        [agent, 'agent'],
        [marketer, 'marketer'],
      ] as const) {
        const { token } = await invite(dbs, tenant, owner, user.email, [role]);
        await acceptInvitation(dbs, user, token);
      }
      const wabaId = nextExternalId();
      const phoneNumberId = nextExternalId();
      const token = `EAAG${randomBytes(12).toString('hex')}`;
      standIn.state.tokens.set(token, {
        appId: APP_ID,
        valid: true,
        scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      });
      const whatsappAccountId = uuidv7();
      const channelAccountId = uuidv7();
      await dbs.app.run(authorizedTenantScope(tenant.id, owner.id), async (tx) => {
        await tx.insert(whatsappAccounts).values({
          id: whatsappAccountId,
          tenantId: tenant.id,
          wabaId,
          name: 'Main account',
          status: 'connected',
          credentialCiphertext: keyring.encrypt(token, credentialAad(tenant.id, whatsappAccountId)),
        });
        await tx.execute(
          sql`select app.bind_provider_asset('meta_whatsapp', 'waba', ${wabaId}, ${whatsappAccountId}::uuid, null)`,
        );
        await tx.insert(channelAccounts).values({
          id: channelAccountId,
          tenantId: tenant.id,
          whatsappAccountId,
          phoneNumberId,
          status: 'active',
          displayPhoneNumber: '+91 90000 00000',
        });
        await tx.execute(
          sql`select app.bind_provider_asset('meta_whatsapp', 'phone_number', ${phoneNumberId}, ${channelAccountId}::uuid, ${wabaId})`,
        );
      });
      return {
        owner,
        agent,
        marketer,
        tenant,
        wabaId,
        phoneNumberId,
        whatsappAccountId,
        channelAccountId,
        token,
      };
    },
    ctx(company, user) {
      return resolveTenantContext(
        { db: dbs.app, clock: systemClock, mfaGracePeriodHours: 72 },
        {
          userId: user.id,
          sessionId: `sess_${user.id}`,
          // Signed in just now, as after a sign-in (step-up checks, ADR-056).
          sessionCreatedAt: new Date(),
          tenantSlug: company.tenant.slug,
          correlationId: uuidv7(),
        },
      );
    },
    messagesBody(company, value) {
      const now = Math.floor(Date.now() / 1000);
      const messages = value.messages?.map((m) => ({
        id: m.id ?? `wamid.in.${randomBytes(6).toString('hex')}`,
        ...(m.waId ? { from: m.waId } : {}),
        timestamp: String(m.timestamp ?? now),
        type: m.type ?? 'text',
        ...(m.type && m.type !== 'text' ? (m.extra ?? {}) : { text: { body: m.text ?? 'Hello' } }),
      }));
      const contacts = value.messages?.map((m) => ({
        profile: { name: 'Priya Customer' },
        ...(m.waId ? { wa_id: m.waId } : {}),
      }));
      return {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: company.wabaId,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '919000000000',
                    phone_number_id: company.phoneNumberId,
                  },
                  ...(contacts ? { contacts } : {}),
                  ...(messages ? { messages } : {}),
                  ...(value.statuses ? { statuses: value.statuses } : {}),
                },
              },
            ],
          },
        ],
      };
    },
    fieldBody(wabaId, field, value) {
      return {
        object: 'whatsapp_business_account',
        entry: [{ id: wabaId, changes: [{ field, value }] }],
      };
    },
    async deliver(body, clock = systemClock) {
      const stored = await storeWebhookReceipt(
        { db: dbs.app, keyring, jobs: jobs(), signer },
        { provider: 'meta_whatsapp', rawBody: Buffer.from(JSON.stringify(body)) },
      );
      const outcome = await processMetaWebhookReceipt(
        { db: dbs.app, keyring, clock, jobs: jobs(), signer },
        stored.receiptId,
      );
      return { receiptId: stored.receiptId, outcome };
    },
    async query(text, params = []) {
      return (await dbs.adminPool.query(text, params)).rows;
    },
    async close() {
      await standIn.close();
      await boss.stop({ graceful: false, close: true });
      await dbs.close();
    },
  };
  return fixture;
}
