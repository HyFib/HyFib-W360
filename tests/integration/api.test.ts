import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, sha256Hex, systemClock, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope, channelAccounts, sql } from '@w360/db';
import {
  API_KEY_LIMITS,
  API_KEY_REMINDER_DAYS,
  API_TOKEN_RE,
  apiCreateContact,
  apiErrorResponse,
  apiGetContact,
  apiGetMessage,
  apiKeyReminderNotice,
  apiListContacts,
  apiListTemplates,
  apiRecordConsent,
  apiSendMessage,
  apiSendTemplate,
  authenticateApiToken,
  createApiKeysService,
  createCampaignsService,
  createConsentService,
  createContactsService,
  createInboxService,
  createTemplatesService,
  generateApiToken,
  outboxAad,
  processSendIntent,
  processTemplateSubmit,
  purgeApiIdempotencyKeys,
  queueTemplateMessage,
  remindApiKeyExpiry,
  remindExpiringApiKeys,
  syncTemplates,
  type ApiContext,
  type ApiKeyReminderDeps,
  type ApiKeysService,
  type ApiScope,
  type TemplateDefinition,
  type TenantContext,
} from '@w360/domain';
import { acceptInvitation, createUser, invite } from './helpers';
import {
  nextExternalId,
  startWhatsAppFixture,
  type Company,
  type WhatsAppFixture,
} from './whatsapp-fixture';

/**
 * The public API v1 (P5-08, ADR-052) against real PostgreSQL and the Graph stand-in: company API
 * keys (scopes, the limit of active keys, rotation with an overlap, revocation), authentication
 * through the definer function, scopes and company status, idempotent requests (replays, a key
 * reused for another request, concurrent retries, failures, expiry), contacts and consent, template
 * sends with the members' checks and the send pipeline, text replies within the 24-hour window
 * (ADR-070), message status, the idempotency sweep, isolation between companies, and reminders
 * before keys expire (ADR-067).
 */
let fx: WhatsAppFixture;
let keys: ApiKeysService;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
});

afterAll(async () => {
  await fx.close();
});

const deps = (clock: Clock = systemClock) => ({
  db: fx.dbs.app,
  clock,
  jobs: fx.jobs(),
  signer: fx.signer,
});
const at = (date: Date): Clock => ({ now: () => date });
const idem = (key: string, request: string) => ({ key, requestHash: sha256Hex(request) });
const sendRate = { capacity: 1000, refillPerSecond: 1000 };

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.publicMessage).toMatch(message);
    }
    return error;
  }
  throw new Error(`expected ${code}`);
}

/** A statement the database refuses (privileges or row security), with PostgreSQL's reason. */
async function expectRefused(promise: Promise<unknown>, reason: RegExp) {
  const error = await expectAppError(promise, 'forbidden');
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages.join(' | ')).toMatch(reason);
}

/** A key of the company created by its owner, and the context a request with it gets. */
async function apiKey(
  c: Company,
  scopes: ApiScope[],
  name = 'Integration',
): Promise<{ id: string; token: string; ctx: ApiContext }> {
  const owner = await fx.ctx(c, c.owner);
  const created = await keys.create(owner, { name, scopes, expiresInDays: 0 });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return { id: created.id, token: created.token, ctx };
}

let templateCounter = 0;
/** A template created, submitted and approved through the Graph stand-in, then synced. */
async function approvedTemplate(c: Company, definition: TemplateDefinition) {
  templateCounter += 1;
  const name = `api_tpl_${templateCounter}_${Date.now().toString(36)}`;
  const owner = await fx.ctx(c, c.owner);
  const templateDeps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
  const templates = createTemplatesService(templateDeps);
  const { id } = await templates.createDraft(owner, {
    whatsappAccountId: c.whatsappAccountId,
    name,
    language: 'en',
    definition,
  });
  await templates.submitTemplate(owner, id);
  const graphDeps = { ...templateDeps, keyring: fx.keyring, graph: fx.graph };
  const scope = authorizedTenantScope(c.tenant.id, null);
  expect(await processTemplateSubmit(graphDeps, scope, id)).toBe('done');
  const t = fx.standIn.state.templates.get(c.wabaId)?.find((x) => x.name === name);
  if (!t) throw new Error('template not at the stand-in');
  t.status = 'APPROVED';
  await syncTemplates(graphDeps, scope, c.whatsappAccountId);
  return { id, name };
}

/** Hands every queued send of the company to the Graph stand-in. */
async function sendAll(c: Company) {
  const intents = await fx.query<{ id: string; actor_user_id: string | null }>(
    `SELECT id, actor_user_id FROM app.send_intents WHERE tenant_id = $1 AND state = 'queued'
      ORDER BY created_at`,
    [c.tenant.id],
  );
  const outcomes: string[] = [];
  for (const intent of intents) {
    const result = await processSendIntent(
      { ...deps(), keyring: fx.keyring, graph: fx.graph, rate: sendRate },
      authorizedTenantScope(c.tenant.id, intent.actor_user_id),
      intent.id,
    );
    outcomes.push(result.outcome);
  }
  return outcomes;
}

/** Template messages the stand-in received for a number. */
const templatesTo = (to: string) =>
  fx.standIn.state.requests.filter(
    (r) => r.path.endsWith('/messages') && (r.body as { to?: string }).to === to,
  );

/** Another WhatsApp number of the company's account. */
async function addNumber(c: Company, status: 'active' | 'disconnected') {
  const id = uuidv7();
  const phoneNumberId = nextExternalId();
  await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx) => {
    await tx.insert(channelAccounts).values({
      id,
      tenantId: c.tenant.id,
      whatsappAccountId: c.whatsappAccountId,
      phoneNumberId,
      status,
      displayPhoneNumber: '+91 90000 00001',
    });
    await tx.execute(
      sql`select app.bind_provider_asset('meta_whatsapp', 'phone_number', ${phoneNumberId}, ${id}::uuid, ${c.wabaId})`,
    );
  });
  return id;
}

const shippingUpdate: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'none' },
  body: { text: 'Hi {{1}}, your order {{2}} has shipped.', examples: ['Asha', 'A-1001'] },
  footer: null,
  buttons: [],
};

const festiveSale: TemplateDefinition = {
  category: 'MARKETING',
  header: { type: 'none' },
  body: { text: 'Hello {{1}}, our festive sale starts today.', examples: ['Asha'] },
  footer: null,
  buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }],
};

describe('API keys', () => {
  let c: Company;
  beforeAll(async () => {
    c = await fx.company();
  });

  it('are created by members who manage developer settings; the token is shown once and only its hash is stored', async () => {
    const owner = await fx.ctx(c, c.owner);
    const created = await keys.create(owner, {
      name: '  Order system ',
      scopes: ['messages.send', 'contacts.read'],
      expiresInDays: 90,
    });
    expect(created.token).toMatch(API_TOKEN_RE);
    expect(created.token.startsWith(`${created.keyPrefix}_`)).toBe(true);
    const [row] = await fx.query<{
      name: string;
      token_hash: string;
      scopes: string[];
      expires_at: Date;
      created_at: Date;
    }>('SELECT name, token_hash, scopes, expires_at, created_at FROM app.api_keys WHERE id = $1', [
      created.id,
    ]);
    expect(row!.name).toBe('Order system');
    expect(row!.token_hash).toBe(sha256Hex(created.token));
    expect(row!.scopes).toEqual(['contacts.read', 'messages.send']);
    const days = (row!.expires_at.getTime() - row!.created_at.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);

    const [audit] = await fx.query<{ metadata: Record<string, unknown>; actor_id: string }>(
      `SELECT metadata, actor_id FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'api_key.created' AND subject_id = $2`,
      [c.tenant.id, created.id],
    );
    expect(audit!.actor_id).toBe(c.owner.id);
    expect(audit!.metadata).toMatchObject({ keyPrefix: created.keyPrefix, name: 'Order system' });
    const logged = JSON.stringify(audit);
    expect(logged).not.toContain(created.token);
    expect(logged).not.toContain(row!.token_hash);

    const listed = await keys.list(owner);
    expect(listed.find((k) => k.id === created.id)).toMatchObject({
      name: 'Order system',
      keyPrefix: created.keyPrefix,
      state: 'active',
      createdBy: 'Owner',
      lastUsedAt: null,
    });

    for (const user of [c.agent, c.marketer]) {
      const member = await fx.ctx(c, user);
      await expectAppError(
        keys.create(member, { name: 'Mine', scopes: ['contacts.read'], expiresInDays: 30 }),
        'forbidden',
      );
      await expectAppError(keys.list(member), 'forbidden');
    }
  });

  it('check names, scopes and expiry, and never grant more than the member holds', async () => {
    const owner = await fx.ctx(c, c.owner);
    await expectAppError(
      keys.create(owner, { name: ' ', scopes: ['contacts.read'], expiresInDays: 30 }),
      'validation_failed',
    );
    await expectAppError(
      keys.create(owner, { name: 'None', scopes: [], expiresInDays: 30 }),
      'validation_failed',
    );
    await expectAppError(
      keys.create(owner, { name: 'Admin', scopes: ['tenant.manage'], expiresInDays: 30 }),
      'validation_failed',
    );
    await expectAppError(
      keys.create(owner, { name: 'Week', scopes: ['contacts.read'], expiresInDays: 7 }),
      'validation_failed',
    );

    // A member without the campaign sending permission (as a narrower role would be).
    const narrower: TenantContext = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((p) => p !== 'campaigns.send')),
    };
    await expectAppError(
      keys.create(narrower, {
        name: 'Marketing',
        scopes: ['messages.send_marketing'],
        expiresInDays: 30,
      }),
      'forbidden',
      /Send marketing templates/,
    );
    const marketing = await keys.create(owner, {
      name: 'Marketing',
      scopes: ['messages.send_marketing'],
      expiresInDays: 30,
    });
    // Rotating needs the same permissions as creating.
    await expectAppError(
      keys.rotate(narrower, { keyId: marketing.id, overlapHours: 1 }),
      'forbidden',
    );
    await keys.create(narrower, { name: 'Utility', scopes: ['messages.send'], expiresInDays: 30 });
  });

  it('are limited to 20 active keys per company, also when created concurrently', async () => {
    const d = await fx.company();
    const owner = await fx.ctx(d, d.owner);
    const make = (name: string) =>
      keys.create(owner, { name, scopes: ['contacts.read'], expiresInDays: 30 });
    const made = [];
    for (let i = 0; i < API_KEY_LIMITS.activeKeys - 1; i += 1) made.push(await make(`Key ${i}`));
    // One slot left and six concurrent creations: exactly one gets it. The pool opens six
    // connections first, so the creations really run at the same time.
    const scope = authorizedTenantScope(d.tenant.id, d.owner.id);
    await Promise.all(
      Array.from({ length: 6 }, () => fx.dbs.app.run(scope, (tx) => tx.execute(sql`select 1`))),
    );
    const race = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => make(`Racer ${i + 1}`)),
    );
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of race) {
      if (r.status === 'rejected') {
        expect(isAppError(r.reason) && r.reason.code).toBe('precondition_failed');
      }
    }
    await expectAppError(make('One more'), 'precondition_failed', /20 active API keys/);

    // Revoked and expired keys do not count.
    await keys.revoke(owner, { keyId: made[0]!.id });
    await fx.query(
      `UPDATE app.api_keys SET expires_at = created_at + interval '1 millisecond' WHERE id = $1`,
      [made[1]!.id],
    );
    await make('Replacement 1');
    await make('Replacement 2');
    await expectAppError(make('One more'), 'precondition_failed');
  });

  it('authenticate through the definer function: unknown, revoked and expired keys get nothing', async () => {
    const key = await apiKey(c, ['contacts.read', 'contacts.write']);
    expect(key.ctx.tenant).toEqual({ id: c.tenant.id, status: 'active' });
    expect([...key.ctx.key.scopes].sort()).toEqual(['contacts.read', 'contacts.write']);
    expect(key.ctx.key.id).toBe(key.id);

    // The last use is recorded at most once a minute.
    const lastUsed = async () =>
      (
        await fx.query<{ last_used_at: Date | null }>(
          'SELECT last_used_at FROM app.api_keys WHERE id = $1',
          [key.id],
        )
      )[0]!.last_used_at;
    const first = await lastUsed();
    expect(first).not.toBeNull();
    await authenticateApiToken(fx.dbs.app, key.token, 'r');
    expect(await lastUsed()).toEqual(first);
    await fx.query(
      `UPDATE app.api_keys SET last_used_at = now() - interval '2 minutes' WHERE id = $1`,
      [key.id],
    );
    await authenticateApiToken(fx.dbs.app, key.token, 'r');
    expect((await lastUsed())!.getTime()).toBeGreaterThan(Date.now() - 60_000);

    const other = `${key.token.slice(0, -4)}${key.token.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    expect(await authenticateApiToken(fx.dbs.app, other, 'r')).toBeNull();

    const expiring = await apiKey(c, ['contacts.read']);
    await fx.query(
      `UPDATE app.api_keys SET expires_at = created_at + interval '1 millisecond' WHERE id = $1`,
      [expiring.id],
    );
    expect(await authenticateApiToken(fx.dbs.app, expiring.token, 'r')).toBeNull();

    const owner = await fx.ctx(c, c.owner);
    await keys.revoke(owner, { keyId: key.id });
    expect(await authenticateApiToken(fx.dbs.app, key.token, 'r')).toBeNull();
    // Revoking again changes nothing and records nothing.
    await keys.revoke(owner, { keyId: key.id });
    const revocations = await fx.query(
      `SELECT 1 FROM app.audit_events WHERE action = 'api_key.revoked' AND subject_id = $1`,
      [key.id],
    );
    expect(revocations).toHaveLength(1);
    expect((await keys.list(owner)).find((k) => k.id === key.id)?.state).toBe('revoked');
    await expectAppError(keys.revoke(owner, { keyId: uuidv7() }), 'not_found');
  });

  it('stop working for a company being deleted, and read only for a suspended one', async () => {
    const d = await fx.company();
    const key = await apiKey(d, ['contacts.read', 'contacts.write']);
    await fx.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [d.tenant.id]);
    const suspended = await authenticateApiToken(fx.dbs.app, key.token, 'r');
    expect(suspended?.tenant.status).toBe('suspended');
    expect((await apiListContacts(deps(), suspended!, {})).data).toEqual([]);
    await expectAppError(
      apiCreateContact(deps(), suspended!, { phone: '+919811100001' }, null),
      'tenant_suspended',
      /suspended/,
    );
    await fx.query(`UPDATE app.tenants SET status = 'restricted' WHERE id = $1`, [d.tenant.id]);
    const restricted = await authenticateApiToken(fx.dbs.app, key.token, 'r');
    await expectAppError(
      apiCreateContact(deps(), restricted!, { phone: '+919811100001' }, null),
      'tenant_suspended',
      /plan has ended/,
    );
    await fx.query(`UPDATE app.tenants SET status = 'pending_deletion' WHERE id = $1`, [
      d.tenant.id,
    ]);
    expect(await authenticateApiToken(fx.dbs.app, key.token, 'r')).toBeNull();
  });

  it('rotate to a new key with the same scopes while the old one works for the overlap', async () => {
    const owner = await fx.ctx(c, c.owner);
    const old = await keys.create(owner, {
      name: 'Rotating',
      scopes: ['templates.read', 'contacts.read'],
      expiresInDays: 30,
    });
    const rotated = await keys.rotate(owner, { keyId: old.id, overlapHours: 24 });
    expect(rotated.token).not.toBe(old.token);
    const oldCtx = await authenticateApiToken(fx.dbs.app, old.token, 'r');
    const newCtx = await authenticateApiToken(fx.dbs.app, rotated.token, 'r');
    expect(oldCtx?.key.id).toBe(old.id);
    expect([...newCtx!.key.scopes].sort()).toEqual(['contacts.read', 'templates.read']);
    const rows = await fx.query<{
      id: string;
      name: string;
      expires_at: Date;
      created_at: Date;
      replaced_by_key_id: string | null;
    }>(
      'SELECT id, name, expires_at, created_at, replaced_by_key_id FROM app.api_keys WHERE id = ANY($1)',
      [[old.id, rotated.id]],
    );
    const oldRow = rows.find((r) => r.id === old.id)!;
    const newRow = rows.find((r) => r.id === rotated.id)!;
    expect(oldRow.replaced_by_key_id).toBe(rotated.id);
    expect(Math.abs(oldRow.expires_at.getTime() - (Date.now() + 24 * 3_600_000))).toBeLessThan(
      60_000,
    );
    // The new key keeps the old one's lifetime and name.
    expect(
      Math.round((newRow.expires_at.getTime() - newRow.created_at.getTime()) / 86_400_000),
    ).toBe(30);
    expect(newRow.name).toBe('Rotating');

    await expectAppError(keys.rotate(owner, { keyId: old.id, overlapHours: 1 }), 'conflict');
    await expectAppError(
      keys.rotate(owner, { keyId: rotated.id, overlapHours: 73 }),
      'validation_failed',
    );

    // No overlap: the old key is revoked at once.
    const third = await keys.rotate(owner, { keyId: rotated.id, overlapHours: 0 });
    expect(await authenticateApiToken(fx.dbs.app, rotated.token, 'r')).toBeNull();
    expect((await keys.list(owner)).find((k) => k.id === rotated.id)).toMatchObject({
      state: 'revoked',
      replacedByKeyId: third.id,
    });
    expect(await authenticateApiToken(fx.dbs.app, third.token, 'r')).not.toBeNull();
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE action = 'api_key.rotated' AND subject_id = $1`,
      [rotated.id],
    );
    expect(audit!.metadata).toMatchObject({ newKeyId: third.id, overlapHours: 0 });
    expect(JSON.stringify(audit)).not.toContain(third.token);
  });

  it('cannot be changed or deleted around the service: token, scopes, expiry and revocation are guarded', async () => {
    const key = await apiKey(c, ['contacts.read']);
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const attempt = (statement: ReturnType<typeof sql>) =>
      fx.dbs.app.run(scope, (tx) => tx.execute(statement));
    await expectRefused(
      attempt(sql`select token_hash from app.api_keys where id = ${key.id}::uuid`),
      /permission denied/,
    );
    await expectRefused(
      attempt(
        sql`update app.api_keys set token_hash = ${'0'.repeat(64)} where id = ${key.id}::uuid`,
      ),
      /permission denied/,
    );
    await expectRefused(
      attempt(
        sql`update app.api_keys set scopes = array['contacts.write'] where id = ${key.id}::uuid`,
      ),
      /permission denied/,
    );
    await expectRefused(
      attempt(sql`update app.api_keys set last_used_at = null where id = ${key.id}::uuid`),
      /permission denied/,
    );
    await expectRefused(
      attempt(sql`delete from app.api_keys where id = ${key.id}::uuid`),
      /permission denied/,
    );
    await attempt(
      sql`update app.api_keys set expires_at = now() + interval '1 day' where id = ${key.id}::uuid`,
    );
    await expect(
      attempt(
        sql`update app.api_keys set expires_at = now() + interval '2 days' where id = ${key.id}::uuid`,
      ),
    ).rejects.toThrow(/expiry can only come sooner/);
    await expect(
      attempt(sql`update app.api_keys set expires_at = null where id = ${key.id}::uuid`),
    ).rejects.toThrow(/expiry can only come sooner/);
    const owner = await fx.ctx(c, c.owner);
    await keys.revoke(owner, { keyId: key.id });
    await expect(
      attempt(
        sql`update app.api_keys set revoked_at = null, revoked_by_user_id = null where id = ${key.id}::uuid`,
      ),
    ).rejects.toThrow(/stays revoked/);
  });
});

describe('requests with a key', () => {
  let c: Company;
  let other: Company;
  beforeAll(async () => {
    c = await fx.company();
    other = await fx.company();
  });

  it('are limited to the key’s scopes', async () => {
    const { ctx } = await apiKey(c, ['templates.read']);
    expect((await apiListTemplates(deps(), ctx)).data).toEqual([]);
    await expectAppError(apiListContacts(deps(), ctx, {}), 'forbidden', /contacts\.read/);
    await expectAppError(
      apiCreateContact(deps(), ctx, { phone: '+919811100002' }, null),
      'forbidden',
      /contacts\.write/,
    );
    await expectAppError(
      apiSendTemplate(deps(), ctx, { to: 'x', templateId: 'y' }, idem('a', 'a')),
      'forbidden',
      /messages\.send/,
    );
    await expectAppError(apiGetMessage(deps(), ctx, uuidv7()), 'forbidden');
  });

  it('create contacts or answer with the existing one, and refuse suppressed numbers', async () => {
    const { ctx, id: keyId } = await apiKey(c, ['contacts.read', 'contacts.write']);
    const created = await apiCreateContact(
      deps(),
      ctx,
      { phone: '+91 98111 00003', name: 'Asha', email: 'Asha@Example.com', tags: ['VIP', 'vip'] },
      null,
    );
    expect(created.status).toBe(201);
    expect(created.replayed).toBe(false);
    const data = created.body.data as {
      id: string;
      phone: string;
      email: string;
      tags: string[];
      source: string;
      consent: unknown;
    };
    expect(data).toMatchObject({
      name: 'Asha',
      phone: '+919811100003',
      email: 'Asha@Example.com',
      tags: ['vip'],
      source: 'api',
      consent: { marketing: null, utility: null },
    });
    expect(created.body.created).toBe(true);
    const [audit] = await fx.query<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM app.audit_events WHERE action = 'contact.created' AND subject_id = $1`,
      [data.id],
    );
    expect(audit).toEqual({ actor_type: 'api_key', actor_id: keyId });

    const again = await apiCreateContact(
      deps(),
      ctx,
      { phone: '+919811100003', name: 'Someone else', tags: ['order'] },
      null,
    );
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      created: false,
      data: { id: data.id, name: 'Asha', tags: ['order', 'vip'] },
    });

    const invalid = await expectAppError(
      apiCreateContact(deps(), ctx, { phone: '98111' }, null),
      'validation_failed',
    );
    expect(isAppError(invalid) && invalid.issues?.[0]?.path).toBe('phone');
    await expectAppError(
      apiCreateContact(deps(), ctx, { phone: '+919811100004', company: 'Acme' }, null),
      'validation_failed',
    );

    const owner = await fx.ctx(c, c.owner);
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).addSuppression(owner, {
      phone: '+919811100005',
      reason: 'complaint',
    });
    await expectAppError(
      apiCreateContact(deps(), ctx, { phone: '+919811100005' }, null),
      'precondition_failed',
      /suppression list/,
    );
    const rows = await fx.query(
      'SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2',
      [c.tenant.id, '+919811100005'],
    );
    expect(rows).toHaveLength(0);
  });

  it('list contacts newest first with cursors, find one by number and read one by id', async () => {
    const d = await fx.company();
    const { ctx } = await apiKey(d, ['contacts.read', 'contacts.write']);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await apiCreateContact(deps(), ctx, { phone: `+91981110010${i}` }, null);
      ids.push((r.body.data as { id: string }).id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await apiListContacts(deps(), ctx, {
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.data.map((x) => x.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());

    const byPhone = await apiListContacts(deps(), ctx, { phone: '+91 98111 00102' });
    expect(byPhone.data.map((x) => x.id)).toEqual([ids[2]]);
    await expectAppError(apiListContacts(deps(), ctx, { limit: '101' }), 'validation_failed');
    await expectAppError(
      apiListContacts(deps(), ctx, { cursor: 'not-a-cursor' }),
      'validation_failed',
    );
    await expectAppError(apiListContacts(deps(), ctx, { sort: 'name' }), 'validation_failed');

    expect((await apiGetContact(deps(), ctx, ids[0]!)).phone).toBe('+919811100100');
    await expectAppError(apiGetContact(deps(), ctx, 'nope'), 'not_found');
    // Another company's contact does not exist for this key.
    const theirs = await apiKey(other, ['contacts.read']);
    await expectAppError(apiGetContact(deps(), theirs.ctx, ids[0]!), 'not_found');
    expect((await apiListContacts(deps(), theirs.ctx, {})).data.map((x) => x.id)).not.toContain(
      ids[0],
    );
  });

  it('record consent as the key, with its evidence', async () => {
    const { ctx, id: keyId } = await apiKey(c, ['contacts.write']);
    const created = await apiCreateContact(deps(), ctx, { phone: '+919811100006' }, null);
    const contactId = (created.body.data as { id: string }).id;
    const updated = await apiRecordConsent(deps(), ctx, contactId, {
      purpose: 'marketing',
      action: 'opt_in',
      evidence: 'Checkout form on example.com',
    });
    expect(updated.consent).toEqual({ marketing: 'opted_in', utility: null });
    const [event] = await fx.query<{
      source: string;
      actor_type: string;
      actor_id: string;
      evidence: Record<string, unknown>;
    }>(
      `SELECT source, actor_type, actor_id, evidence FROM app.consent_events
        WHERE tenant_id = $1 AND contact_id = $2`,
      [c.tenant.id, contactId],
    );
    expect(event).toEqual({
      source: 'api',
      actor_type: 'api_key',
      actor_id: keyId,
      evidence: { note: 'Checkout form on example.com', apiKeyId: keyId },
    });
    await expectAppError(
      apiRecordConsent(deps(), ctx, contactId, { purpose: 'marketing', action: 'opt_out' }),
      'validation_failed',
      /how the contact/,
    );
    await expectAppError(
      apiRecordConsent(deps(), ctx, uuidv7(), {
        purpose: 'utility',
        action: 'opt_out',
        evidence: 'Phone call',
      }),
      'not_found',
    );
  });

  it('with an Idempotency-Key replay the first response, refuse the key for another request and keep no failures', async () => {
    const { ctx, id: keyId } = await apiKey(c, ['contacts.write']);
    const body = { phone: '+919811100007', name: 'Ravi' };
    const first = await apiCreateContact(deps(), ctx, body, idem('create-7', 'body-7'));
    expect(first).toMatchObject({ status: 201, replayed: false });
    const replay = await apiCreateContact(deps(), ctx, body, idem('create-7', 'body-7'));
    expect(replay).toEqual({ ...first, replayed: true });
    const audits = await fx.query(
      `SELECT 1 FROM app.audit_events WHERE action = 'contact.created' AND subject_id = $1`,
      [(first.body.data as { id: string }).id],
    );
    expect(audits).toHaveLength(1);

    const reused = await expectAppError(
      apiCreateContact(deps(), ctx, { phone: '+919811100008' }, idem('create-7', 'other body')),
      'validation_failed',
      /already used with a different request/,
    );
    expect(apiErrorResponse(reused, 'r').body.error.reason).toBe('idempotency_key_reused');

    // A failed request stores nothing: the same key works once the cause is gone.
    const owner = await fx.ctx(c, c.owner);
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    await consent.addSuppression(owner, { phone: '+919811100009', reason: 'manual' });
    await expectAppError(
      apiCreateContact(deps(), ctx, { phone: '+919811100009' }, idem('create-9', 'body-9')),
      'precondition_failed',
    );
    const stored = await fx.query(
      `SELECT 1 FROM app.api_idempotency_keys WHERE api_key_id = $1 AND idempotency_key = 'create-9'`,
      [keyId],
    );
    expect(stored).toHaveLength(0);
    const suppression = (await consent.listSuppressions(owner, {})).items.find(
      (s) => s.phoneE164 === '+919811100009',
    );
    await consent.removeSuppression(owner, suppression!.id);
    const retried = await apiCreateContact(
      deps(),
      ctx,
      { phone: '+919811100009' },
      idem('create-9', 'body-9'),
    );
    expect(retried.status).toBe(201);

    // Keys are per API key: another key may use the same Idempotency-Key for its own request.
    const second = await apiKey(c, ['contacts.write']);
    const theirs = await apiCreateContact(
      deps(),
      second.ctx,
      { phone: '+919811100010' },
      idem('create-7', 'their body'),
    );
    expect(theirs).toMatchObject({ status: 201, replayed: false });

    // After 24 hours the key is free again.
    const later = at(new Date(Date.now() + 25 * 3_600_000));
    const recycled = await apiCreateContact(
      deps(later),
      ctx,
      { phone: '+919811100011' },
      idem('create-7', 'a new request'),
    );
    expect(recycled).toMatchObject({ status: 201, replayed: false });
  });
});

describe('template sends', () => {
  let c: Company;
  let utility: { id: string; name: string };
  let marketing: { id: string; name: string };
  beforeAll(async () => {
    c = await fx.company();
    utility = await approvedTemplate(c, shippingUpdate);
    marketing = await approvedTemplate(c, festiveSale);
  });

  it('lists approved templates with their variables and numbers', async () => {
    const { ctx } = await apiKey(c, ['templates.read']);
    const { data } = await apiListTemplates(deps(), ctx);
    expect(data.find((t) => t.id === utility.id)).toEqual({
      id: utility.id,
      name: utility.name,
      language: 'en',
      category: 'utility',
      variables: { header: 0, body: 2 },
      text: { header: null, body: 'Hi {{1}}, your order {{2}} has shipped.', footer: null },
      channels: [{ id: c.channelAccountId, phone: '+91 90000 00000' }],
    });
    expect(data.find((t) => t.id === marketing.id)?.category).toBe('marketing');
  });

  it('queue one message per Idempotency-Key and send it through the pipeline', async () => {
    const { ctx, id: keyId } = await apiKey(c, ['messages.send']);
    const input = {
      to: '+91 98111 00020',
      templateId: utility.id,
      variables: { body: ['Asha', 'A-1001'] },
    };
    const first = await apiSendTemplate(deps(), ctx, input, idem('send-20', 'send-20'));
    expect(first.status).toBe(201);
    const queued = first.body.data as { id: string; contactId: string; channelId: string };
    expect(queued).toMatchObject({
      type: 'template',
      status: 'queued',
      channelId: c.channelAccountId,
      templateId: utility.id,
    });
    const [message] = await fx.query<{
      sender_type: string;
      api_key_id: string;
      template_id: string;
      conversation_status: string;
      actor_user_id: string | null;
    }>(
      `SELECT m.sender_type, m.api_key_id, m.template_id, cv.status AS conversation_status,
              si.actor_user_id
         FROM app.messages m
         JOIN app.conversations cv ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
        WHERE m.id = $1`,
      [queued.id],
    );
    expect(message).toEqual({
      sender_type: 'api',
      api_key_id: keyId,
      template_id: utility.id,
      conversation_status: 'resolved',
      actor_user_id: null,
    });
    const [contact] = await fx.query<{ source: string; phone_e164: string }>(
      'SELECT source, phone_e164 FROM app.contacts WHERE id = $1',
      [queued.contactId],
    );
    expect(contact).toEqual({ source: 'api', phone_e164: '+919811100020' });

    const replay = await apiSendTemplate(deps(), ctx, input, idem('send-20', 'send-20'));
    expect(replay).toEqual({ ...first, replayed: true });

    // Concurrent retries with a new key: exactly one message.
    const [a, b] = await Promise.all([
      apiSendTemplate(deps(), ctx, input, idem('send-21', 'send-21')),
      apiSendTemplate(deps(), ctx, input, idem('send-21', 'send-21')),
    ]);
    expect((a.body.data as { id: string }).id).toBe((b.body.data as { id: string }).id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    const count = await fx.query(
      `SELECT 1 FROM app.messages m JOIN app.conversations cv
          ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
        WHERE cv.contact_id = $1 AND m.direction = 'outbound'`,
      [queued.contactId],
    );
    expect(count).toHaveLength(2);

    expect(await sendAll(c)).toEqual(['accepted', 'accepted']);
    const sent = templatesTo('919811100020');
    expect(sent).toHaveLength(2);
    const template = (sent[0]!.body as { template: { name: string; components: unknown[] } })
      .template;
    expect(template.name).toBe(utility.name);
    expect(JSON.stringify(template.components)).toContain('A-1001');

    const status = await apiGetMessage(deps(), ctx, queued.id);
    expect(status).toMatchObject({
      id: queued.id,
      type: 'template',
      status: 'accepted',
      to: '+919811100020',
      templateId: utility.id,
      templateName: utility.name,
      channelId: c.channelAccountId,
      contactId: queued.contactId,
      error: null,
    });
    const [row] = await fx.query<{ external_message_id: string }>(
      'SELECT external_message_id FROM app.messages WHERE id = $1',
      [queued.id],
    );
    await fx.deliver(
      fx.messagesBody(c, {
        statuses: [
          {
            id: row!.external_message_id,
            status: 'delivered',
            timestamp: String(Math.floor(Date.now() / 1000)),
            recipient_id: '919811100020',
          },
        ],
      }),
    );
    expect((await apiGetMessage(deps(), ctx, queued.id)).status).toBe('delivered');
  });

  it('check the template, its variables and the number before queueing', async () => {
    const { ctx } = await apiKey(c, ['messages.send', 'messages.send_marketing']);
    const send = (input: Record<string, unknown>, key: string) =>
      apiSendTemplate(deps(), ctx, input, idem(key, key));
    const to = '+919811100021';
    await expectAppError(
      send({ to, templateId: utility.id, variables: { body: ['Asha'] } }, 'v-1'),
      'validation_failed',
      /2 body variables/,
    );
    await expectAppError(send({ to, templateId: uuidv7() }, 'v-2'), 'not_found');
    await expectAppError(
      send({ to: '12345', templateId: utility.id, variables: { body: ['a', 'b'] } }, 'v-3'),
      'validation_failed',
    );
    await expectAppError(
      send({ to, templateId: utility.id, variables: { body: ['a', 'b'] }, extra: 1 }, 'v-4'),
      'validation_failed',
    );
    // A suppressed number is refused and gets no contact.
    const owner = await fx.ctx(c, c.owner);
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).addSuppression(owner, {
      phone: '+919811100022',
      reason: 'legal',
    });
    await expectAppError(
      send({ to: '+919811100022', templateId: utility.id, variables: { body: ['a', 'b'] } }, 'v-6'),
      'precondition_failed',
      /suppression list/,
    );
    expect(
      await fx.query('SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2', [
        c.tenant.id,
        '+919811100022',
      ]),
    ).toHaveLength(0);
    await fx.query(`UPDATE app.message_templates SET status = 'paused' WHERE id = $1`, [
      utility.id,
    ]);
    await expectAppError(
      send({ to, templateId: utility.id, variables: { body: ['a', 'b'] } }, 'v-5'),
      'precondition_failed',
      /approved/,
    );
    await fx.query(`UPDATE app.message_templates SET status = 'approved' WHERE id = $1`, [
      utility.id,
    ]);

    // Several numbers: the request says which; another company's or a disconnected one is refused.
    const second = await addNumber(c, 'active');
    const disconnected = await addNumber(c, 'disconnected');
    const base = { to, templateId: utility.id, variables: { body: ['a', 'b'] } };
    await expectAppError(send(base, 'n-1'), 'validation_failed', /several WhatsApp numbers/);
    const other = await fx.company();
    await expectAppError(send({ ...base, from: other.channelAccountId }, 'n-2'), 'not_found');
    await expectAppError(
      send({ ...base, from: disconnected }, 'n-3'),
      'precondition_failed',
      /not active/,
    );
    const viaSecond = await send({ ...base, from: second }, 'n-4');
    expect((viaSecond.body.data as { channelId: string }).channelId).toBe(second);
    await fx.query(`UPDATE app.channel_accounts SET status = 'disconnected' WHERE id = $1`, [
      second,
    ]);
    const viaOnly = await send(base, 'n-5');
    expect((viaOnly.body.data as { channelId: string }).channelId).toBe(c.channelAccountId);
    // Nothing of these was sent yet; hand the queue over so later tests start empty.
    await sendAll(c);
  });

  it('need the marketing scope, the contact’s opt-in and room under the frequency cap for marketing templates', async () => {
    const utilityOnly = await apiKey(c, ['messages.send']);
    const to = '+919811100030';
    const input = { to, templateId: marketing.id, variables: { body: ['Asha'] } };
    await expectAppError(
      apiSendTemplate(deps(), utilityOnly.ctx, input, idem('m-1', 'm-1')),
      'forbidden',
      /messages\.send_marketing/,
    );
    const { ctx } = await apiKey(c, ['messages.send_marketing', 'contacts.write']);
    await expectAppError(
      apiSendTemplate(deps(), ctx, input, idem('m-2', 'm-2')),
      'precondition_failed',
    );
    // A refused send creates no contact.
    expect(
      await fx.query('SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2', [
        c.tenant.id,
        to,
      ]),
    ).toHaveLength(0);

    const created = await apiCreateContact(deps(), ctx, { phone: to }, null);
    const contactId = (created.body.data as { id: string }).id;
    await apiRecordConsent(deps(), ctx, contactId, {
      purpose: 'marketing',
      action: 'opt_in',
      evidence: 'Signed up at the store counter',
    });
    const owner = await fx.ctx(c, c.owner);
    const campaigns = createCampaignsService(deps());
    await campaigns.updateSettings(
      owner,
      { approvalRequired: false, cap: { count: 1, days: 7 }, costCurrency: null },
      {},
    );
    try {
      const sent = await apiSendTemplate(deps(), ctx, input, idem('m-3', 'm-3'));
      expect(sent.status).toBe(201);
      await expectAppError(
        apiSendTemplate(deps(), ctx, input, idem('m-4', 'm-4')),
        'precondition_failed',
        /as many marketing messages/,
      );
      // Utility templates are not counted by the marketing cap.
      const utilitySend = await apiSendTemplate(
        deps(),
        utilityOnly.ctx,
        { to, templateId: utility.id, variables: { body: ['Asha', 'A-2'] } },
        idem('m-5', 'm-5'),
      );
      expect(utilitySend.status).toBe(201);
    } finally {
      await campaigns.updateSettings(
        owner,
        { approvalRequired: false, cap: null, costCurrency: null },
        {},
      );
    }
    await sendAll(c);
  });

  it('are checked again before sending: an opt-out after queueing stops the message', async () => {
    const { ctx } = await apiKey(c, ['messages.send', 'contacts.write']);
    const queued = await apiSendTemplate(
      deps(),
      ctx,
      { to: '+919811100040', templateId: utility.id, variables: { body: ['Ravi', 'A-3'] } },
      idem('o-1', 'o-1'),
    );
    const data = queued.body.data as { id: string; contactId: string };
    await apiRecordConsent(deps(), ctx, data.contactId, {
      purpose: 'utility',
      action: 'opt_out',
      evidence: 'Asked us by email to stop order updates',
    });
    await sendAll(c);
    expect(templatesTo('919811100040')).toHaveLength(0);
    const status = await apiGetMessage(deps(), ctx, data.id);
    expect(status.status).toBe('failed');
    expect(status.error?.code).toBe('opted_out');
    await expectAppError(
      apiSendTemplate(
        deps(),
        ctx,
        { to: '+919811100040', templateId: utility.id, variables: { body: ['Ravi', 'A-4'] } },
        idem('o-2', 'o-2'),
      ),
      'precondition_failed',
    );
  });

  it('report the status of the company’s API messages only', async () => {
    const { ctx } = await apiKey(c, ['messages.send']);
    // A member's template send is not an API message.
    const agent = await fx.ctx(c, c.agent);
    const contact = await apiCreateContact(
      deps(),
      (await apiKey(c, ['contacts.write'])).ctx,
      { phone: '+919811100050' },
      null,
    );
    const contactId = (contact.body.data as { id: string }).id;
    await apiRecordConsent(deps(), (await apiKey(c, ['contacts.write'])).ctx, contactId, {
      purpose: 'utility',
      action: 'opt_in',
      evidence: 'Order form',
    });
    const member = await queueTemplateMessage(deps(), agent, {
      contactId,
      channelAccountId: c.channelAccountId,
      templateId: utility.id,
      params: { header: [], body: ['Asha', 'A-5'] },
      clientKey: `ck-${uuidv7()}`,
    });
    await expectAppError(apiGetMessage(deps(), ctx, member.messageId), 'not_found');
    await expectAppError(apiGetMessage(deps(), ctx, 'not-a-uuid'), 'not_found');

    // Another company's key cannot read this company's API message.
    const mine = await apiSendTemplate(
      deps(),
      ctx,
      { to: '+919811100050', templateId: utility.id, variables: { body: ['Asha', 'A-6'] } },
      idem('s-1', 's-1'),
    );
    const other = await fx.company();
    const theirs = await apiKey(other, ['messages.send']);
    await expectAppError(
      apiGetMessage(deps(), theirs.ctx, (mine.body.data as { id: string }).id),
      'not_found',
    );

    // A send Meta refuses shows its error.
    fx.standIn.state.sendQueue = [
      { kind: 'accept' },
      { kind: 'error', status: 400, code: 131026, message: 'Message undeliverable' },
    ];
    await sendAll(c);
    fx.standIn.state.sendQueue = [];
    const failed = await apiGetMessage(deps(), ctx, (mine.body.data as { id: string }).id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: '131026' });
  });
});

describe('text replies (ADR-070)', () => {
  /** An inbound message from `waId`, sent `secondsAgo` seconds ago by WhatsApp's timestamp. */
  async function wrote(company: Company, waId: string, secondsAgo = 0) {
    const timestamp = Math.floor(Date.now() / 1000) - secondsAgo;
    await fx.deliver(
      fx.messagesBody(company, { messages: [{ waId, text: 'Where is my order?', timestamp }] }),
    );
  }
  const reply = (to: string, text = 'It ships today.', extra: Record<string, unknown> = {}) => ({
    type: 'text',
    to,
    text,
    ...extra,
  });
  const idOf = (response: { body: Record<string, unknown> }) =>
    (response.body.data as { id: string }).id;
  const reason = (error: unknown) => apiErrorResponse(error, 'r').body.error.reason;

  async function conversationWith(company: Company, phone: string) {
    const [row] = await fx.query<{
      id: string;
      status: string;
      assigned_membership_id: string | null;
      unread_count: number;
      last_message_preview: string | null;
    }>(
      `SELECT cv.id, cv.status, cv.assigned_membership_id, cv.unread_count, cv.last_message_preview
         FROM app.conversations cv
         JOIN app.contacts ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contact_id
        WHERE cv.tenant_id = $1 AND ct.phone_e164 = $2 AND cv.channel_account_id = $3`,
      [company.tenant.id, phone, company.channelAccountId],
    );
    if (!row) throw new Error('no conversation');
    return row;
  }

  it('reply once per Idempotency-Key to a number that wrote in the last 24 hours, through the send pipeline', async () => {
    const c = await fx.company();
    const { ctx, id: keyId } = await apiKey(c, ['messages.reply'], 'Helpdesk');
    const waId = '919811100040';
    await wrote(c, waId);
    const before = await conversationWith(c, `+${waId}`);

    const first = await apiSendMessage(deps(), ctx, reply(`+${waId}`), idem('text-1', 'text-1'));
    expect(first.status).toBe(201);
    const queued = first.body.data as { id: string; contactId: string };
    expect(queued).toEqual({
      id: expect.any(String),
      type: 'text',
      status: 'queued',
      contactId: expect.any(String),
      channelId: c.channelAccountId,
    });
    const replay = await apiSendMessage(deps(), ctx, reply(`+${waId}`), idem('text-1', 'text-1'));
    expect(replay).toEqual({ ...first, replayed: true });
    // One signed send job for the worker.
    const jobs = await fx.query<{ singleton_key: string }>(
      `SELECT j.singleton_key FROM pgboss.job j
         JOIN app.send_intents si ON si.id::text = j.singleton_key
        WHERE j.name = $1 AND si.message_id = $2`,
      [QUEUES.messageSend.name, queued.id],
    );
    expect(jobs).toHaveLength(1);

    const [message] = await fx.query(
      `SELECT m.type, m.content, m.sender_type, m.api_key_id, m.sender_membership_id,
              m.conversation_id, m.template_id, si.request, si.actor_user_id
         FROM app.messages m
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
        WHERE m.id = $1`,
      [queued.id],
    );
    expect(message).toEqual({
      type: 'text',
      content: { text: 'It ships today.' },
      sender_type: 'api',
      api_key_id: keyId,
      sender_membership_id: null,
      conversation_id: before.id,
      template_id: null,
      request: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waId,
        type: 'text',
        text: { body: 'It ships today.', preview_url: false },
      },
      actor_user_id: null,
    });
    // Not a member's reply: the conversation keeps its status, assignee and unread count, and the
    // customer still waits for a member.
    expect(await conversationWith(c, `+${waId}`)).toEqual({
      ...before,
      last_message_preview: 'It ships today.',
    });
    const turns = await fx.query<{ end_reason: string | null }>(
      'SELECT end_reason FROM app.conversation_turns WHERE conversation_id = $1',
      [before.id],
    );
    expect(turns).toEqual([{ end_reason: null }]);
    // Members see which key sent it.
    const thread = await createInboxService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    }).getConversation(await fx.ctx(c, c.owner), before.id);
    expect(thread.messages.find((m) => m.id === queued.id)).toMatchObject({
      senderType: 'api',
      senderName: null,
      apiKeyName: 'Helpdesk',
    });

    // A link preview when asked for.
    const withLink = await apiSendMessage(
      deps(),
      ctx,
      reply(`+${waId}`, 'Track it at https://example.com/t/1', { previewUrl: true }),
      idem('text-2', 'text-2'),
    );
    expect(await sendAll(c)).toEqual(['accepted', 'accepted']);
    const sent = fx.standIn.state.requests.filter(
      (r) => r.path.endsWith('/messages') && (r.body as { to?: string } | undefined)?.to === waId,
    );
    expect(sent.map((r) => (r.body as { type: string; text: unknown }).text)).toEqual([
      { body: 'It ships today.', preview_url: false },
      { body: 'Track it at https://example.com/t/1', preview_url: true },
    ]);
    expect(await apiGetMessage(deps(), ctx, queued.id)).toEqual({
      id: queued.id,
      type: 'text',
      status: 'accepted',
      statusAt: expect.any(String),
      to: `+${waId}`,
      templateId: null,
      templateName: null,
      channelId: c.channelAccountId,
      contactId: queued.contactId,
      error: null,
      createdAt: expect.any(String),
    });
    expect((await apiGetMessage(deps(), ctx, idOf(withLink))).type).toBe('text');
  });

  it('refuse, with one answer, numbers that did not write to the number in the last 24 hours', async () => {
    const c = await fx.company();
    const { ctx, id: keyId } = await apiKey(c, ['messages.reply']);
    const send = (input: Record<string, unknown>, key: string, clock?: Clock) =>
      apiSendMessage(deps(clock), ctx, input, idem(key, key));

    // Not a contact.
    const unknown = await expectAppError(
      send(reply('+919811100041'), 'w-1'),
      'precondition_failed',
      /has not written to this WhatsApp number in the last 24 hours/,
    );
    expect(reason(unknown)).toBe('window_closed');
    const sameAnswer = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'precondition_failed');
      expect(apiErrorResponse(error, 'r').body.error).toEqual(
        apiErrorResponse(unknown, 'r').body.error,
      );
    };
    // A contact who never wrote.
    const contacts = await apiKey(c, ['contacts.write']);
    await apiCreateContact(deps(), contacts.ctx, { phone: '+919811100042' }, null);
    await sameAnswer(send(reply('+919811100042'), 'w-2'));
    // Last wrote 24 hours and a second ago; just under 24 hours is answered, until it passes.
    await wrote(c, '919811100043', 24 * 3600 + 1);
    await sameAnswer(send(reply('+919811100043'), 'w-3'));
    await wrote(c, '919811100044', 24 * 3600 - 60);
    expect((await send(reply('+919811100044'), 'w-4')).status).toBe(201);
    await sameAnswer(send(reply('+919811100044'), 'w-5', at(new Date(Date.now() + 61_000))));
    // An erased contact.
    await wrote(c, '919811100047');
    const erased = await conversationWith(c, '+919811100047');
    const [erasedContact] = await fx.query<{ contact_id: string }>(
      'SELECT contact_id FROM app.conversations WHERE id = $1',
      [erased.id],
    );
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(
      await fx.ctx(c, c.owner),
      { contactId: erasedContact!.contact_id, suppress: false },
    );
    await sameAnswer(send(reply('+919811100047'), 'w-6'));

    // The key's scope, the company's state and the body.
    const templatesOnly = await apiKey(c, ['messages.send', 'messages.send_marketing']);
    await expectAppError(
      apiSendMessage(deps(), templatesOnly.ctx, reply('+919811100044'), idem('w-7', 'w-7')),
      'forbidden',
      /messages\.reply/,
    );
    // A body without a type is a template send (the template is unknown here).
    await expectAppError(
      apiSendMessage(
        deps(),
        templatesOnly.ctx,
        { to: '+919811100044', templateId: uuidv7() },
        idem('w-7b', 'w-7b'),
      ),
      'not_found',
    );
    await expectAppError(
      apiSendMessage(
        deps(),
        { ...ctx, tenant: { ...ctx.tenant, status: 'restricted' } },
        reply('+919811100044'),
        idem('w-8', 'w-8'),
      ),
      'tenant_suspended',
    );
    await expectAppError(
      send(reply('+919811100044', 'x'.repeat(4097)), 'w-9'),
      'validation_failed',
    );
    await expectAppError(send(reply('+919811100044', '   '), 'w-10'), 'validation_failed');
    await expectAppError(send(reply('98110'), 'w-11'), 'validation_failed');
    await expectAppError(
      send({ ...reply('+919811100044'), templateId: uuidv7() }, 'w-12'),
      'validation_failed',
    );
    await expectAppError(
      send({ ...reply('+919811100044'), type: 'image' }, 'w-13'),
      'validation_failed',
    );

    // Refusals write nothing: one message and one stored response, from the reply that was sent.
    const stored = await fx.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM app.api_idempotency_keys WHERE api_key_id = $1',
      [keyId],
    );
    expect(stored.map((r) => r.idempotency_key)).toEqual(['w-4']);
    const sentByKey = await fx.query('SELECT id FROM app.messages WHERE api_key_id = $1', [keyId]);
    expect(sentByKey).toHaveLength(1);
  });

  it('go from the number the contact wrote to', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['messages.reply']);
    const send = (input: Record<string, unknown>, key: string) =>
      apiSendMessage(deps(), ctx, input, idem(key, key));
    await wrote(c, '919811100048');
    const second = await addNumber(c, 'active');
    const off = await addNumber(c, 'disconnected');
    await expectAppError(
      send(reply('+919811100048'), 'n-1'),
      'validation_failed',
      /several WhatsApp numbers/,
    );
    // The contact wrote to the first number, not the second.
    const elsewhere = await expectAppError(
      send(reply('+919811100048', 'Hi', { from: second }), 'n-2'),
      'precondition_failed',
    );
    expect(reason(elsewhere)).toBe('window_closed');
    await expectAppError(
      send(reply('+919811100048', 'Hi', { from: uuidv7() }), 'n-3'),
      'not_found',
    );
    await expectAppError(
      send(reply('+919811100048', 'Hi', { from: off }), 'n-4'),
      'precondition_failed',
      /not active/,
    );
    const sent = await send(reply('+919811100048', 'Hi', { from: c.channelAccountId }), 'n-5');
    expect(sent.body.data).toMatchObject({ channelId: c.channelAccountId });
  });

  it('are checked again when the worker sends: a window that closed in between fails the message', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['messages.reply']);
    await wrote(c, '919811100049', 24 * 3600 - 30);
    const sent = await apiSendMessage(deps(), ctx, reply('+919811100049'), idem('l-1', 'l-1'));
    const [intent] = await fx.query<{ id: string }>(
      'SELECT id FROM app.send_intents WHERE message_id = $1',
      [idOf(sent)],
    );
    const result = await processSendIntent(
      {
        ...deps(at(new Date(Date.now() + 60_000))),
        keyring: fx.keyring,
        graph: fx.graph,
        rate: sendRate,
      },
      authorizedTenantScope(c.tenant.id, null),
      intent!.id,
    );
    expect(result.outcome).toBe('failed');
    expect(await apiGetMessage(deps(), ctx, idOf(sent))).toMatchObject({
      type: 'text',
      status: 'failed',
      error: { code: 'window_closed' },
    });
    expect(
      fx.standIn.state.requests.filter(
        (r) => (r.body as { to?: string } | undefined)?.to === '919811100049',
      ),
    ).toEqual([]);
  });

  it('reach only the company’s own contacts and numbers', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const mine = await apiKey(c, ['messages.reply']);
    const theirs = await apiKey(other, ['messages.reply']);
    await wrote(c, '919811100050');
    const refused = await expectAppError(
      apiSendMessage(deps(), theirs.ctx, reply('+919811100050'), idem('i-1', 'i-1')),
      'precondition_failed',
    );
    expect(reason(refused)).toBe('window_closed');
    await expectAppError(
      apiSendMessage(
        deps(),
        theirs.ctx,
        reply('+919811100050', 'Hi', { from: c.channelAccountId }),
        idem('i-2', 'i-2'),
      ),
      'not_found',
    );
    const sent = await apiSendMessage(deps(), mine.ctx, reply('+919811100050'), idem('i-3', 'i-3'));
    await expectAppError(apiGetMessage(deps(), theirs.ctx, idOf(sent)), 'not_found');
    expect((await apiGetMessage(deps(), mine.ctx, idOf(sent))).status).toBe('queued');
  });
});

describe('isolation and retention', () => {
  it('keeps keys, idempotency keys and their functions to their company and roles', async () => {
    const a = await fx.company();
    const b = await fx.company();
    const keyA = await apiKey(a, ['contacts.write']);
    await apiCreateContact(deps(), keyA.ctx, { phone: '+919811100060' }, idem('iso', 'iso'));
    const scopeB = authorizedTenantScope(b.tenant.id, b.owner.id);
    const seenByB = await fx.dbs.app.run(scopeB, async (tx) => ({
      keys: (await tx.execute(sql`select id from app.api_keys where id = ${keyA.id}::uuid`)).rows,
      idem: (
        await tx.execute(
          sql`select id from app.api_idempotency_keys where api_key_id = ${keyA.id}::uuid`,
        )
      ).rows,
      updated: (
        await tx.execute(
          sql`update app.api_keys set name = 'taken' where id = ${keyA.id}::uuid returning id`,
        )
      ).rows,
    }));
    expect(seenByB).toEqual({ keys: [], idem: [], updated: [] });
    await expectRefused(
      fx.dbs.app.run(scopeB, (tx) =>
        tx.execute(sql`insert into app.api_keys (id, tenant_id, name, key_prefix, token_hash, scopes,
          created_by_user_id) values (${uuidv7()}::uuid, ${a.tenant.id}::uuid, 'x',
          'w360_aaaaaaaaaaaa', ${'1'.repeat(64)}, array['contacts.read'], ${b.owner.id})`),
      ),
      /row-level security/,
    );

    const can = async (role: string, fn: string) =>
      (
        await fx.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [
          role,
          fn,
        ])
      )[0]!.ok;
    for (const fn of [
      'ops.api_key_authenticate(text)',
      'ops.purge_api_idempotency_keys(integer)',
    ]) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
      expect(await can('public', fn), fn).toBe(false);
    }
  });

  it('deletes expired idempotency keys in the sweep and keeps current ones', async () => {
    const c = await fx.company();
    const { ctx, id: keyId } = await apiKey(c, ['contacts.write']);
    await apiCreateContact(deps(), ctx, { phone: '+919811100070' }, idem('old', 'old'));
    await apiCreateContact(deps(), ctx, { phone: '+919811100071' }, idem('new', 'new'));
    await fx.query(
      `UPDATE app.api_idempotency_keys
          SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
        WHERE api_key_id = $1 AND idempotency_key = 'old'`,
      [keyId],
    );
    expect(await purgeApiIdempotencyKeys(fx.dbs.app)).toBeGreaterThanOrEqual(1);
    const left = await fx.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM app.api_idempotency_keys WHERE api_key_id = $1',
      [keyId],
    );
    expect(left.map((r) => r.idempotency_key)).toEqual(['new']);
  });
});

describe('reminders before keys expire (ADR-067)', () => {
  const DAY = 86_400_000;
  const reminderDeps = (clock: Clock = systemClock): ApiKeyReminderDeps => ({
    db: fx.dbs.app,
    clock,
    notices: {
      outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
      appBaseUrl: 'http://localhost:3000',
    },
  });
  const sweep = () => remindExpiringApiKeys(reminderDeps());

  async function member(c: Company, role: string) {
    const user = await createUser(fx.dbs, { name: `Keys ${role}` });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
    await acceptInvitation(fx.dbs, user, token);
    return user;
  }

  /**
   * A key of the company created by its owner that expires in `ms` (a fixture step: keys are
   * created for at least 30 days, and an expiry can only come sooner).
   */
  async function expiringKey(c: Company, ms: number, name = 'Expiring') {
    const owner = await fx.ctx(c, c.owner);
    const created = await keys.create(owner, {
      name,
      scopes: ['contacts.read'],
      expiresInDays: 30,
    });
    await fx.query(
      `UPDATE app.api_keys SET expires_at = now() + $2 * interval '1 millisecond' WHERE id = $1`,
      [created.id, ms],
    );
    return created;
  }

  /** A key written as it would stand after a lifetime in the past (a fixture step). */
  async function pastKey(c: Company, createdAt: Date, expiresAt: Date) {
    const id = uuidv7();
    const { keyPrefix, tokenHash } = generateApiToken();
    await fx.query(
      `INSERT INTO app.api_keys (id, tenant_id, name, key_prefix, token_hash, scopes,
                                 created_by_user_id, created_at, expires_at)
       VALUES ($1, $2, 'Old', $3, $4, array['contacts.read'], $5, $6, $7)`,
      [id, c.tenant.id, keyPrefix, tokenHash, c.owner.id, createdAt, expiresAt],
    );
    return id;
  }

  /** The keys `ops.api_key_expiry_reminders_due` lists for the company, soonest first. */
  async function due(tenantId: string, days = API_KEY_REMINDER_DAYS): Promise<string[]> {
    const rows = await fx.query<{ key_id: string }>(
      `SELECT key_id FROM ops.api_key_expiry_reminders_due(1000, $2) WHERE tenant_id = $1`,
      [tenantId, days],
    );
    return rows.map((r) => r.key_id);
  }

  async function keyRow(id: string) {
    const [row] = await fx.query<{
      created_at: Date;
      expires_at: Date;
      expiry_reminded_at: Date | null;
    }>('SELECT created_at, expires_at, expiry_reminded_at FROM app.api_keys WHERE id = $1', [id]);
    return row!;
  }

  /** The company's notices queued in the outbox, oldest first. */
  async function companyNotices(tenantId: string) {
    const { rows } = await fx.dbs.adminPool.query<{
      id: string;
      to_address: string;
      payload_ciphertext: string;
    }>(
      `SELECT id, to_address, payload_ciphertext FROM ops.email_outbox
        WHERE tenant_id = $1 AND kind = 'tenant.notice' ORDER BY id`,
      [tenantId],
    );
    return rows.map((r) => ({
      to: r.to_address,
      ...(JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
        kind: string;
        companyName: string;
        subject: string;
        lines: string[];
        url: string;
        actionLabel: string;
      }),
    }));
  }

  it('email the owners and administrators once when a key expires within 7 days, with its name, prefix and times in the company’s time zone', async () => {
    const c = await fx.company();
    await fx.query(`UPDATE app.tenants SET timezone = 'Europe/London' WHERE id = $1`, [
      c.tenant.id,
    ]);
    const admin = await member(c, 'admin');
    await member(c, 'billing');
    const owner = await fx.ctx(c, c.owner);
    const soon = await expiringKey(c, 3 * DAY, 'Orders\nsync');
    const later = await expiringKey(c, 8 * DAY, 'Later');
    const forever = await keys.create(owner, {
      name: 'Forever',
      scopes: ['contacts.read'],
      expiresInDays: 0,
    });
    const month = await keys.create(owner, {
      name: 'Month',
      scopes: ['contacts.read'],
      expiresInDays: 30,
    });
    expect(await due(c.tenant.id)).toEqual([soon.id]);
    expect(await due(c.tenant.id, 9)).toEqual([soon.id, later.id]);
    // The window is at most 30 days whatever the caller asks for.
    expect(await due(c.tenant.id, 365)).toEqual([soon.id, later.id, month.id]);

    const result = await sweep();
    expect(result.failed).toEqual([]);
    expect(result.reminded).toBeGreaterThanOrEqual(1);
    const row = await keyRow(soon.id);
    expect(row.expiry_reminded_at).not.toBeNull();
    const sent = await companyNotices(c.tenant.id);
    const [{ name: companyName } = { name: '' }] = await fx.query<{ name: string }>(
      'SELECT name FROM app.tenants WHERE id = $1',
      [c.tenant.id],
    );
    // Owners and administrators manage keys; the billing manager, agent and marketer do not.
    expect(sent.map((n) => n.to).sort()).toEqual([admin.email, c.owner.email].sort());
    const expected = apiKeyReminderNotice(
      {
        name: 'Orders\nsync',
        keyPrefix: soon.keyPrefix,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        createdBy: 'Owner',
        lastUsedAt: null,
      },
      'Europe/London',
    );
    for (const notice of sent) {
      expect(notice).toMatchObject({
        kind: 'tenant.notice',
        companyName,
        subject: expected.subject,
        lines: expected.lines,
        url: `http://localhost:3000/c/${c.tenant.slug}/settings/api-keys`,
        actionLabel: 'Open API keys',
      });
    }
    expect(expected.subject).toMatch(/^API key “Orders sync” expires on /);
    expect(expected.lines[0]).toMatch(/ (GMT|BST)\. From then on/);
    expect(JSON.stringify(sent)).not.toContain(soon.token);

    // Once: the key is no longer listed, and another sweep sends nothing more.
    expect(await due(c.tenant.id)).toEqual([]);
    await sweep();
    expect(await companyNotices(c.tenant.id)).toHaveLength(2);
    const listed = await keys.list(owner);
    expect(listed.find((k) => k.id === soon.id)?.expiryRemindedAt).toEqual(row.expiry_reminded_at);
    for (const id of [later.id, forever.id, month.id]) {
      expect(listed.find((k) => k.id === id)?.expiryRemindedAt, id).toBeNull();
    }

    // A key that comes within 7 days later is reminded then, on its own.
    await fx.query(`UPDATE app.api_keys SET expires_at = now() + interval '6 days' WHERE id = $1`, [
      later.id,
    ]);
    await sweep();
    const all = await companyNotices(c.tenant.id);
    expect(all).toHaveLength(4);
    expect(all.slice(2).every((n) => n.subject.startsWith('API key “Later” expires on '))).toBe(
      true,
    );
  });

  it('check each key again in its company’s scope: revoked, rotated, expired, reminded or distant keys and companies being deleted get nothing', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const deps = reminderDeps();
    const revoked = await expiringKey(c, 2 * DAY, 'Revoked');
    await keys.revoke(owner, { keyId: revoked.id });
    // Rotating gives the new key the old key's lifetime (here two days, from the fixture step):
    // the new key is reminded before it expires, the replaced one is not.
    const rotated = await expiringKey(c, 2 * DAY, 'Rotated');
    const replacement = await keys.rotate(owner, { keyId: rotated.id, overlapHours: 24 });
    const now = Date.now();
    const expired = await pastKey(c, new Date(now - 31 * DAY), new Date(now - DAY));
    const reminded = await expiringKey(c, 2 * DAY, 'Reminded');
    await fx.query(`UPDATE app.api_keys SET expiry_reminded_at = now() WHERE id = $1`, [
      reminded.id,
    ]);
    const current = await expiringKey(c, 2 * DAY, 'Current');
    const today = await expiringKey(c, DAY / 2, 'Today');
    // Soonest expiry first.
    const listed = await due(c.tenant.id);
    expect(listed[0]).toBe(today.id);
    expect(listed.slice(1).sort()).toEqual([current.id, replacement.id].sort());
    // The window is at least a day whatever the caller asks for.
    expect(await due(c.tenant.id, 0)).toEqual([today.id]);
    expect(await due(c.tenant.id, -3)).toEqual([today.id]);

    for (const id of [revoked.id, rotated.id, expired, reminded.id]) {
      expect(await remindApiKeyExpiry(deps, c.tenant.id, id), id).toBe(false);
    }
    // Checked against the worker's clock too: not yet within 7 days, or expired meanwhile.
    const { expires_at: expiresAt } = await keyRow(current.id);
    const at = (ms: number): Clock => ({ now: () => new Date(expiresAt.getTime() + ms) });
    expect(await remindApiKeyExpiry(reminderDeps(at(-8 * DAY)), c.tenant.id, current.id)).toBe(
      false,
    );
    expect(await remindApiKeyExpiry(reminderDeps(at(1_000)), c.tenant.id, current.id)).toBe(false);
    expect(await remindApiKeyExpiry(deps, c.tenant.id, uuidv7())).toBe(false);
    // A key id is looked up in the company's own scope only.
    const other = await fx.company();
    expect(await remindApiKeyExpiry(deps, other.tenant.id, current.id)).toBe(false);
    expect(await companyNotices(c.tenant.id)).toEqual([]);
    expect(await companyNotices(other.tenant.id)).toEqual([]);
    for (const id of [revoked.id, rotated.id, expired, current.id]) {
      expect((await keyRow(id)).expiry_reminded_at, id).toBeNull();
    }

    expect(await remindApiKeyExpiry(deps, c.tenant.id, current.id)).toBe(true);
    expect(await remindApiKeyExpiry(deps, c.tenant.id, current.id)).toBe(false);
    expect(await remindApiKeyExpiry(deps, c.tenant.id, replacement.id)).toBe(true);
    const sent = await companyNotices(c.tenant.id);
    expect(sent.map((n) => n.subject)).toEqual([
      expect.stringMatching(/^API key “Current” expires on /),
      expect.stringMatching(/^API key “Rotated” expires on /),
    ]);

    // Suspended and restricted companies' keys still read, so they are reminded; the keys of a
    // company being deleted no longer work, so they are not.
    const statuses = ['suspended', 'restricted', 'pending_deletion'] as const;
    const companies = await Promise.all(statuses.map(() => fx.company()));
    const statusKeys = [];
    for (const [i, status] of statuses.entries()) {
      const company = companies[i]!;
      statusKeys.push(await expiringKey(company, 2 * DAY));
      await fx.query(`UPDATE app.tenants SET status = $2 WHERE id = $1`, [
        company.tenant.id,
        status,
      ]);
    }
    const [suspended, restricted, deleting] = companies as [Company, Company, Company];
    expect(await due(suspended.tenant.id)).toEqual([statusKeys[0]!.id]);
    expect(await due(restricted.tenant.id)).toEqual([statusKeys[1]!.id]);
    expect(await due(deleting.tenant.id)).toEqual([]);
    expect(await remindApiKeyExpiry(deps, deleting.tenant.id, statusKeys[2]!.id)).toBe(false);
    expect((await keyRow(statusKeys[2]!.id)).expiry_reminded_at).toBeNull();
    expect(await remindApiKeyExpiry(deps, suspended.tenant.id, statusKeys[0]!.id)).toBe(true);
    expect(await remindApiKeyExpiry(deps, restricted.tenant.id, statusKeys[1]!.id)).toBe(true);
    expect(await companyNotices(deleting.tenant.id)).toEqual([]);
  });

  it('send one reminder when sweeps run at once', async () => {
    const c = await fx.company();
    const key = await expiringKey(c, 2 * DAY);
    const deps = reminderDeps();
    const results = await Promise.all([
      remindApiKeyExpiry(deps, c.tenant.id, key.id),
      remindApiKeyExpiry(deps, c.tenant.id, key.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const second = await expiringKey(c, 2 * DAY, 'Second');
    const sweeps = await Promise.all([sweep(), sweep()]);
    expect(sweeps.flatMap((s) => s.failed)).toEqual([]);
    expect((await keyRow(second.id)).expiry_reminded_at).not.toBeNull();
    // One owner: one email per key.
    expect(await companyNotices(c.tenant.id)).toHaveLength(2);
  });

  it('keep the reminder mark once it is set', async () => {
    const c = await fx.company();
    const key = await expiringKey(c, 2 * DAY);
    expect(await remindApiKeyExpiry(reminderDeps(), c.tenant.id, key.id)).toBe(true);
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const attempt = (statement: ReturnType<typeof sql>) =>
      fx.dbs.app.run(scope, (tx) => tx.execute(statement));
    await expect(
      attempt(sql`update app.api_keys set expiry_reminded_at = null where id = ${key.id}::uuid`),
    ).rejects.toThrow(/expiry reminder is sent once/);
    await expect(
      attempt(sql`update app.api_keys set expiry_reminded_at = now() where id = ${key.id}::uuid`),
    ).rejects.toThrow(/expiry reminder is sent once/);
    // Other changes to the key still work: revoking it, for example.
    await keys.revoke(await fx.ctx(c, c.owner), { keyId: key.id });
    expect((await keyRow(key.id)).expiry_reminded_at).not.toBeNull();
  });
});
