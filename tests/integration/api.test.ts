import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, sha256Hex, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, channelAccounts, sql } from '@w360/db';
import {
  API_KEY_LIMITS,
  API_TOKEN_RE,
  apiCreateContact,
  apiErrorResponse,
  apiGetContact,
  apiGetMessage,
  apiListContacts,
  apiListTemplates,
  apiRecordConsent,
  apiSendTemplate,
  authenticateApiToken,
  createApiKeysService,
  createCampaignsService,
  createConsentService,
  createTemplatesService,
  processSendIntent,
  processTemplateSubmit,
  purgeApiIdempotencyKeys,
  queueTemplateMessage,
  syncTemplates,
  type ApiContext,
  type ApiKeysService,
  type ApiScope,
  type TemplateDefinition,
  type TenantContext,
} from '@w360/domain';
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
 * sends with the members' checks and the send pipeline, message status, the idempotency sweep, and
 * isolation between companies.
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
