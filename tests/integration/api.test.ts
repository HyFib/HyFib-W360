import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAppError, sha256Hex, systemClock, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope, channelAccounts, sql, whatsappAccounts } from '@w360/db';
import {
  API_LIMITS,
  API_KEY_LIMITS,
  API_KEY_REMINDER_DAYS,
  API_MESSAGE_FEED_WINDOW,
  API_SCOPE_KEYS,
  API_TOKEN_RE,
  RUN_BUDGETS,
  advanceAutomationRun,
  apiAddConversationNote,
  apiCreateContact,
  apiCreateDeal,
  apiErrorResponse,
  apiGetAutomationRun,
  apiGetContact,
  apiGetConversation,
  apiGetDeal,
  apiGetOrder,
  apiGetMessage,
  apiKeyReminderNotice,
  apiListAutomations,
  apiListChannels,
  apiListContacts,
  apiListConversationMessages,
  apiListConversationNotes,
  apiListConversations,
  apiListDeals,
  apiListMembers,
  apiListMessages,
  apiMessageChanges,
  apiListOrders,
  apiListPipelines,
  apiListTeams,
  apiListTemplates,
  apiRecordConsent,
  apiSendManyTemplates,
  apiSendMessage,
  apiSendTemplate,
  apiUpdateConversation,
  apiUpdateManyConversations,
  apiUpdateMatchingConversations,
  apiUpdateOrder,
  apiStartAutomationRun,
  apiStartManyAutomationRuns,
  apiStopAutomationRun,
  apiStopManyAutomationRuns,
  authenticateApiRequest,
  authenticateApiToken,
  botButtonId,
  createApiKeysService,
  createAutomationService,
  createCampaignsService,
  createCommerceService,
  createConsentService,
  createContactsService,
  createCrmService,
  createCsatService,
  createInboxService,
  createPlanAdminService,
  createTeamsService,
  createTemplatesService,
  createTenancyService,
  createWebhooksService,
  credentialAad,
  dayOf,
  generateApiToken,
  outboxAad,
  processCommerceSync,
  processSendIntent,
  processTemplateSubmit,
  purgeApiIdempotencyKeys,
  queueTemplateMessage,
  queueTextMessage,
  remindApiKeyExpiry,
  remindExpiringApiKeys,
  routeDueConversations,
  syncTemplates,
  type ApiAutomationRun,
  type ApiAutomationRunStart,
  type ApiContext,
  type ApiConversation,
  type ApiDeal,
  type ApiKeyReminderDeps,
  type ApiKeysService,
  type ApiScope,
  type AutomationTrigger,
  type PlatformActor,
  type TemplateDefinition,
  type TenantContext,
} from '@w360/domain';
import { acceptInvitation, createUser, invite } from './helpers';
import {
  nextExternalId,
  startWhatsAppFixture,
  type Company,
  type InboundSpec,
  type WhatsAppFixture,
} from './whatsapp-fixture';

/**
 * The public API v1 (P5-08, ADR-052) against real PostgreSQL and the Graph stand-in: company API
 * keys (scopes, the limit of active keys, rotation with an overlap, revocation), authentication
 * through the definer function, scopes and company status, idempotent requests (replays, a key
 * reused for another request, concurrent retries, failures, expiry), contacts and consent, template
 * sends with the members' checks and the send pipeline, text replies within the 24-hour window
 * (ADR-070), message status, reading conversations and their messages (ADR-072), resolving and
 * reopening conversations (ADR-075), assigning them and moving them between teams (ADR-093), the
 * networks a key accepts requests from (ADR-076), starting automations (ADR-077), the idempotency
 * sweep, isolation between companies, and reminders before keys expire (ADR-067).
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

/**
 * A template made in WhatsApp Manager with a photo, video or document header, which HyFib's editor
 * cannot create, approved at the stand-in and synced (ADR-201).
 */
async function syncedMediaTemplate(c: Company, format: 'IMAGE' | 'VIDEO' | 'DOCUMENT') {
  templateCounter += 1;
  const name = `api_media_${templateCounter}_${Date.now().toString(36)}`;
  const list = fx.standIn.state.templates.get(c.wabaId) ?? [];
  fx.standIn.state.templates.set(c.wabaId, list);
  fx.standIn.state.templateCounter += 1;
  list.push({
    id: String(9_000_000_000 + fx.standIn.state.templateCounter),
    name,
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      { type: 'HEADER', format, example: { header_handle: ['4::aW1hZ2UvanBlZw==:ARZ'] } },
      {
        type: 'BODY',
        text: 'Hi {{1}}, parcel {{2}} was delivered.',
        example: { body_text: [['Asha', 'P-1']] },
      },
    ],
  });
  const graphDeps = {
    db: fx.dbs.app,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
    keyring: fx.keyring,
    graph: fx.graph,
  };
  await syncTemplates(graphDeps, authorizedTenantScope(c.tenant.id, null), c.whatsappAccountId);
  const [row] = await fx.query<{ id: string }>(
    'SELECT id FROM app.message_templates WHERE tenant_id = $1 AND name = $2',
    [c.tenant.id, name],
  );
  if (!row) throw new Error('template not synced');
  return { id: row.id, name };
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

  it('pages through contacts written in one transaction, which share their creation time', async () => {
    const d = await fx.company();
    const { ctx } = await apiKey(d, ['contacts.read']);
    const batch = await fx.query<{ id: string }>(
      `INSERT INTO app.contacts (id, tenant_id, phone_e164, source)
       SELECT gen_random_uuid(), $1, '+9170300' || lpad(g::text, 5, '0'), 'import'
         FROM generate_series(1, 5) g
       RETURNING id`,
      [d.tenant.id],
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await apiListContacts(deps(), ctx, {
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.data.map((x) => x.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual(batch.map((r) => r.id).sort());
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
      variables: { header: 0, body: 2, buttons: 0 },
      headerMedia: null,
      links: [],
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
    const campaigns = createCampaignsService({ ...deps(), notices: fx.notices() });
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

  it('send a template whose website button’s link ends with a value, each send giving it (ADR-228)', async () => {
    const tracking = await approvedTemplate(c, {
      category: 'UTILITY',
      header: { type: 'none' },
      body: { text: 'Hi {{1}}, order {{2}} has shipped.', examples: ['Asha', 'A-1001'] },
      footer: null,
      buttons: [
        {
          type: 'URL',
          text: 'Track order',
          url: 'https://shop.example/track/{{1}}',
          example: 'A-1001',
        },
      ],
    });
    const { ctx } = await apiKey(c, ['templates.read', 'messages.send']);
    // Listed with the link each send ends.
    const { data } = await apiListTemplates(deps(), ctx);
    expect(data.find((t) => t.id === tracking.id)).toMatchObject({
      variables: { header: 0, body: 2, buttons: 1 },
      links: [{ button: 'Track order', url: 'https://shop.example/track/{{1}}' }],
    });

    const sent = await apiSendTemplate(
      deps(),
      ctx,
      {
        to: '+919811160601',
        templateId: tracking.id,
        variables: { body: ['Asha', 'A-601'], buttons: ['A-601'] },
      },
      idem('link-tpl-1', 'link-tpl-1'),
    );
    expect(sent.status).toBe(201);
    const queued = sent.body.data as { id: string };
    const [stored] = await fx.query<{
      content: { rendered: { buttons: unknown[] } };
      request: { template: { components: unknown[] } };
      intent_id: string;
    }>(
      `SELECT m.content, si.request, si.id AS intent_id FROM app.messages m
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
        WHERE m.id = $1`,
      [queued.id],
    );
    expect(stored?.request.template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Asha' },
          { type: 'text', text: 'A-601' },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'A-601' }],
      },
    ]);
    expect(stored?.content.rendered.buttons).toEqual([
      { type: 'URL', text: 'Track order', url: 'https://shop.example/track/A-601' },
    ]);
    // The stand-in takes the end of the link as the button's text parameter (research M-198).
    const result = await processSendIntent(
      { ...deps(), keyring: fx.keyring, graph: fx.graph, rate: sendRate },
      authorizedTenantScope(c.tenant.id, null),
      stored!.intent_id,
    );
    expect(result.outcome).toBe('accepted');

    // Refused before anything is written: values missing or not wanted, by count; a value a
    // link cannot end with, by its place.
    const one = (variables: Record<string, unknown>, key: string, templateId = tracking.id) =>
      apiSendTemplate(deps(), ctx, { to: '+919811160602', templateId, variables }, idem(key, key));
    await expectAppError(
      one({ body: ['a', 'b'] }, 'link-tpl-2'),
      'validation_failed',
      /^This template needs 0 header, 2 body and 1 button variables\.$/,
    );
    await expectAppError(
      one({ body: ['a', 'b'], buttons: ['x'] }, 'link-tpl-3', utility.id),
      'validation_failed',
      /^This template needs 0 header and 2 body variables\.$/,
    );
    const refused = await expectAppError(
      one({ body: ['a', 'b'], buttons: ['A 602'] }, 'link-tpl-4'),
      'validation_failed',
    );
    expect(isAppError(refused) && refused.publicMessage).toBe(
      'Track order: The end of a link cannot contain spaces.',
    );
    expect(isAppError(refused) && refused.issues?.map((i) => i.path)).toEqual([
      'variables.buttons.0',
    ]);
    const many = await expectAppError(
      apiSendManyTemplates(
        deps(),
        ctx,
        {
          templateId: tracking.id,
          messages: [
            { to: '+919811160603', variables: { body: ['a', 'b'], buttons: ['A-603'] } },
            { to: '+919811160604', variables: { body: ['a', 'b'], buttons: ['A\t604'] } },
          ],
        },
        idem('link-tpl-5', 'link-tpl-5'),
      ),
      'validation_failed',
    );
    expect(isAppError(many) && many.issues?.map((i) => i.path)).toEqual([
      'messages.1.variables.buttons.0',
    ]);
    // No contact was created for the refused numbers.
    const [written] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.contacts
        WHERE tenant_id = $1 AND phone_e164 IN ('+919811160602', '+919811160603', '+919811160604')`,
      [c.tenant.id],
    );
    expect(written!.n).toBe(0);
  });

  it('send a template with a photo or document header, each send giving its file by link (ADR-201)', async () => {
    const photo = await syncedMediaTemplate(c, 'IMAGE');
    const receipt = await syncedMediaTemplate(c, 'DOCUMENT');
    const { ctx } = await apiKey(c, ['templates.read', 'messages.send']);
    // Listed with the file a send gives; the header asks for no text value.
    const { data } = await apiListTemplates(deps(), ctx);
    expect(data.find((t) => t.id === photo.id)).toEqual({
      id: photo.id,
      name: photo.name,
      language: 'en',
      category: 'utility',
      variables: { header: 0, body: 2, buttons: 0 },
      headerMedia: 'image',
      links: [],
      text: { header: null, body: 'Hi {{1}}, parcel {{2}} was delivered.', footer: null },
      channels: [{ id: c.channelAccountId, phone: '+91 90000 00000' }],
    });
    expect(data.find((t) => t.id === receipt.id)?.headerMedia).toBe('document');
    // Members cannot send it from HyFib, and are told why.
    const owner = await fx.ctx(c, c.owner);
    const memberTemplates = createTemplatesService({
      db: fx.dbs.app,
      jobs: fx.jobs(),
      signer: fx.signer,
      clock: systemClock,
    });
    expect(
      (await memberTemplates.listTemplates(owner)).find((t) => t.name === photo.name),
    ).toMatchObject({
      sendable: false,
      unsupportedReason:
        'This template has a photo header: HyFib sends such templates only through the API, which gives a link to the file.',
    });

    const link = 'https://cdn.example.com/parcels/p-501.jpg';
    const sent = await apiSendTemplate(
      deps(),
      ctx,
      {
        to: '+919811100501',
        templateId: photo.id,
        variables: { body: ['Asha', 'P-501'] },
        headerMedia: { link },
      },
      idem('media-tpl-1', 'media-tpl-1'),
    );
    expect(sent.status).toBe(201);
    const queued = sent.body.data as { id: string };
    const [stored] = await fx.query<{
      content: Record<string, unknown>;
      request: { template: { components: unknown[] } };
    }>(
      `SELECT m.content, si.request FROM app.messages m
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
        WHERE m.id = $1`,
      [queued.id],
    );
    expect(stored?.content).toMatchObject({
      headerMedia: { type: 'image', link },
      rendered: { header: null, body: 'Hi Asha, parcel P-501 was delivered.' },
    });
    const photoComponents = [
      { type: 'header', parameters: [{ type: 'image', image: { link } }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Asha' },
          { type: 'text', text: 'P-501' },
        ],
      },
    ];
    expect(stored?.request.template.components).toEqual(photoComponents);

    // To many numbers, each with its own file.
    const pdf = (n: number) => `https://cdn.example.com/receipts/p-${n}.pdf`;
    const many = await apiSendManyTemplates(
      deps(),
      ctx,
      {
        templateId: receipt.id,
        messages: [502, 503].map((n) => ({
          to: `+919811100${n}`,
          variables: { body: ['Ravi', `P-${n}`] },
          headerMedia: { link: pdf(n) },
        })),
      },
      idem('media-tpl-2', 'media-tpl-2'),
    );
    expect(
      (many.body.data as { message: { status: string } | null }[]).map((a) => a.message?.status),
    ).toEqual(['queued', 'queued']);

    // Refused before anything is written: a file missing, or given to a template without one, by
    // its place; a link that is not https.
    const refuse = async (send: Promise<unknown>, message: string, paths: string[]) => {
      const refused = await expectAppError(send, 'validation_failed');
      expect(isAppError(refused) && refused.publicMessage).toBe(message);
      expect(isAppError(refused) && refused.issues?.map((i) => i.path)).toEqual(paths);
    };
    const one = (input: Record<string, unknown>, key: string) =>
      apiSendTemplate(deps(), ctx, { to: '+919811100504', ...input }, idem(key, key));
    await refuse(
      one({ templateId: photo.id, variables: { body: ['a', 'b'] } }, 'media-tpl-3'),
      'This template has a photo header: give the link to its file.',
      ['headerMedia'],
    );
    await refuse(
      one(
        { templateId: utility.id, variables: { body: ['a', 'b'] }, headerMedia: { link } },
        'media-tpl-4',
      ),
      'This template has no photo, video or document header, so it takes no file.',
      ['headerMedia'],
    );
    await refuse(
      one(
        {
          templateId: photo.id,
          variables: { body: ['a', 'b'] },
          headerMedia: { link: 'http://cdn.example.com/p.jpg' },
        },
        'media-tpl-5',
      ),
      'Give an https:// link to the media, without a user name or password',
      ['headerMedia.link'],
    );
    await refuse(
      apiSendManyTemplates(
        deps(),
        ctx,
        {
          templateId: receipt.id,
          messages: [
            {
              to: '+919811100505',
              variables: { body: ['a', 'b'] },
              headerMedia: { link: pdf(505) },
            },
            { to: '+919811100506', variables: { body: ['a', 'b'] } },
          ],
        },
        idem('media-tpl-6', 'media-tpl-6'),
      ),
      'This template has a document header: give the link to its file.',
      ['messages.1.headerMedia'],
    );
    expect(
      await fx.query(
        'SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = ANY($2::text[])',
        [c.tenant.id, ['+919811100504', '+919811100505', '+919811100506']],
      ),
    ).toHaveLength(0);

    // WhatsApp gets each file as its header's one parameter; reads never give the file.
    expect((await sendAll(c)).filter((outcome) => outcome !== 'accepted')).toEqual([]);
    const toPhoto = templatesTo('919811100501');
    expect(toPhoto).toHaveLength(1);
    expect(
      (toPhoto[0]?.body as { template: { components: unknown[] } }).template.components,
    ).toEqual(photoComponents);
    for (const n of [502, 503]) {
      const [request] = templatesTo(`919811100${n}`);
      expect(
        (request?.body as { template: { components: unknown[] } }).template.components[0],
      ).toEqual({
        type: 'header',
        parameters: [{ type: 'document', document: { link: pdf(n) } }],
      });
    }
    const status = await apiGetMessage(deps(), ctx, queued.id);
    expect(status).toMatchObject({ status: 'accepted', templateId: photo.id });
    expect(JSON.stringify(status)).not.toContain('cdn.example.com');
  });

  it('send one template to many numbers in one call, each refusal answered in its place (ADR-163)', async () => {
    const { ctx, id: keyId } = await apiKey(c, ['messages.send', 'contacts.write']);
    const owner = await fx.ctx(c, c.owner);
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).addSuppression(owner, {
      phone: '+919811100402',
      reason: 'legal',
    });
    const optedOut = await apiCreateContact(deps(), ctx, { phone: '+919811100403' }, null);
    await apiRecordConsent(deps(), ctx, (optedOut.body.data as { id: string }).id, {
      purpose: 'utility',
      action: 'opt_out',
      evidence: 'Asked us by email to stop order updates',
    });
    const to = (n: number, name: string) => ({
      to: `+91981110040${n}`,
      variables: { body: [name, `A-40${n}`] },
    });
    const input = {
      templateId: utility.id,
      messages: [
        { ...to(1, 'Asha'), to: '+91 98111 00401' },
        to(2, 'Ravi'),
        to(3, 'Mina'),
        to(4, 'Dev'),
      ],
    };
    type Answer = {
      to: string;
      message: { id: string; status: string } | null;
      error: { code: string; message: string } | null;
    };
    const first = await apiSendManyTemplates(deps(), ctx, input, idem('many-1', 'many-1'));
    expect(first).toMatchObject({ status: 200, replayed: false });
    const answers = first.body.data as Answer[];
    expect(answers.map((a) => a.to)).toEqual([
      '+919811100401',
      '+919811100402',
      '+919811100403',
      '+919811100404',
    ]);
    expect(answers[0]).toMatchObject({
      message: {
        type: 'template',
        status: 'queued',
        channelId: c.channelAccountId,
        templateId: utility.id,
      },
      error: null,
    });
    expect(answers.slice(1, 3)).toEqual([
      {
        to: '+919811100402',
        message: null,
        error: {
          code: 'precondition_failed',
          message: 'This number is on the company’s suppression list.',
        },
      },
      {
        to: '+919811100403',
        message: null,
        error: {
          code: 'precondition_failed',
          message: 'This contact has opted out of these messages.',
        },
      },
    ]);
    expect(answers[3]).toMatchObject({ message: { status: 'queued' }, error: null });
    // A refused number gets no contact; each queued message is the key's, to its own contact.
    expect(
      await fx.query('SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2', [
        c.tenant.id,
        '+919811100402',
      ]),
    ).toHaveLength(0);
    const rows = await fx.query<{ sender_type: string; api_key_id: string; phone_e164: string }>(
      `SELECT m.sender_type, m.api_key_id, ct.phone_e164
         FROM app.messages m
         JOIN app.conversations cv ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
         JOIN app.contacts ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contact_id
        WHERE m.id = ANY($1::uuid[])
        ORDER BY ct.phone_e164`,
      [[answers[0]?.message?.id, answers[3]?.message?.id]],
    );
    expect(rows).toEqual([
      { sender_type: 'api', api_key_id: keyId, phone_e164: '+919811100401' },
      { sender_type: 'api', api_key_id: keyId, phone_e164: '+919811100404' },
    ]);
    // One call per key: a retry answers as the first call did and queues nothing.
    expect(await apiSendManyTemplates(deps(), ctx, input, idem('many-1', 'many-1'))).toEqual({
      ...first,
      replayed: true,
    });

    // Refused as a whole before any number is sent to: values that do not fill the variables.
    const short = await expectAppError(
      apiSendManyTemplates(
        deps(),
        ctx,
        {
          templateId: utility.id,
          messages: [to(5, 'Asha'), { to: '+919811100406', variables: { body: ['Ravi'] } }],
        },
        idem('many-2', 'many-2'),
      ),
      'validation_failed',
      /2 body variables/,
    );
    expect(isAppError(short) && short.issues?.map((i) => i.path)).toEqual(['messages.1.variables']);
    expect(
      await fx.query(
        'SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = ANY($2::text[])',
        [c.tenant.id, ['+919811100405', '+919811100406']],
      ),
    ).toHaveLength(0);
    // A marketing template needs the marketing scope, as for one send.
    await expectAppError(
      apiSendManyTemplates(
        deps(),
        ctx,
        {
          templateId: marketing.id,
          messages: [{ to: '+919811100407', variables: { body: ['Asha'] } }],
        },
        idem('many-3', 'many-3'),
      ),
      'forbidden',
      /messages\.send_marketing/,
    );

    expect(await sendAll(c)).toEqual(['accepted', 'accepted']);
    expect(templatesTo('919811100401')).toHaveLength(1);
    expect(templatesTo('919811100402')).toHaveLength(0);
    expect(templatesTo('919811100403')).toHaveLength(0);
    const sent = templatesTo('919811100404');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.body)).toContain('A-404');
  });

  it('check each marketing send to many numbers for the opt-in and against the frequency cap (ADR-163)', async () => {
    const { ctx } = await apiKey(c, ['messages.send_marketing', 'contacts.write']);
    const optIn = async (phone: string) => {
      const created = await apiCreateContact(deps(), ctx, { phone }, null);
      await apiRecordConsent(deps(), ctx, (created.body.data as { id: string }).id, {
        purpose: 'marketing',
        action: 'opt_in',
        evidence: 'Signed up at the store counter',
      });
    };
    await optIn('+919811100411');
    await optIn('+919811100412');
    const owner = await fx.ctx(c, c.owner);
    const campaigns = createCampaignsService({ ...deps(), notices: fx.notices() });
    await campaigns.updateSettings(
      owner,
      { approvalRequired: false, cap: { count: 1, days: 7 }, costCurrency: null },
      {},
    );
    try {
      const sale = (to: string) => ({ to, variables: { body: ['Asha'] } });
      const earlier = await apiSendTemplate(
        deps(),
        ctx,
        { ...sale('+919811100412'), templateId: marketing.id },
        idem('mk-1', 'mk-1'),
      );
      expect(earlier.status).toBe(201);
      const many = await apiSendManyTemplates(
        deps(),
        ctx,
        {
          templateId: marketing.id,
          messages: [sale('+919811100411'), sale('+919811100412'), sale('+919811100413')],
        },
        idem('mk-2', 'mk-2'),
      );
      const answers = many.body.data as {
        to: string;
        message: { id: string } | null;
        error: { code: string; message: string } | null;
      }[];
      expect(answers.map((a) => [a.to, a.message === null, a.error?.code ?? null])).toEqual([
        ['+919811100411', false, null],
        ['+919811100412', true, 'precondition_failed'],
        ['+919811100413', true, 'precondition_failed'],
      ]);
      expect(answers[1]?.error?.message).toMatch(
        /as many marketing messages as the company allows/,
      );
      expect(answers[2]?.error?.message).toMatch(/not opted in to marketing messages/);
      // The number refused for its opt-in got no contact.
      expect(
        await fx.query('SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2', [
          c.tenant.id,
          '+919811100413',
        ]),
      ).toHaveLength(0);
    } finally {
      await campaigns.updateSettings(
        owner,
        { approvalRequired: false, cap: null, costCurrency: null },
        {},
      );
    }
    expect(await sendAll(c)).toEqual(['accepted', 'accepted']);
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
      replyTo: null,
      error: null,
      createdAt: expect.any(String),
    });
    expect((await apiGetMessage(deps(), ctx, idOf(withLink))).type).toBe('text');
  });

  it('send media from an https link the same way, keeping the link and the caption, never the media (ADR-194)', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['messages.reply', 'conversations.read'], 'Catalogue');
    const waId = '919811100194';
    await wrote(c, waId);
    const conv = await conversationWith(c, `+${waId}`);
    const menu = 'https://cdn.example.com/menu.pdf';
    const greeting = 'https://cdn.example.com/hello.ogg';
    const document = await apiSendMessage(
      deps(),
      ctx,
      { type: 'document', to: `+${waId}`, link: menu, caption: '  Our menu ' },
      idem('media-1', 'media-1'),
    );
    expect(document.status).toBe(201);
    expect(document.body.data).toMatchObject({ type: 'document', status: 'queued' });
    const audio = await apiSendMessage(
      deps(),
      ctx,
      { type: 'audio', to: `+${waId}`, link: greeting },
      idem('media-2', 'media-2'),
    );
    const stored = await fx.query(
      `SELECT m.type, m.content, m.sender_type, si.request
         FROM app.messages m
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
        WHERE m.id = ANY($1::uuid[]) ORDER BY m.created_at`,
      [[idOf(document), idOf(audio)]],
    );
    const frame = { messaging_product: 'whatsapp', recipient_type: 'individual', to: waId };
    expect(stored).toEqual([
      {
        type: 'document',
        content: { link: menu, caption: 'Our menu' },
        sender_type: 'api',
        request: { ...frame, type: 'document', document: { link: menu, caption: 'Our menu' } },
      },
      {
        type: 'audio',
        content: { link: greeting },
        sender_type: 'api',
        request: { ...frame, type: 'audio', audio: { link: greeting } },
      },
    ]);
    expect((await conversationWith(c, `+${waId}`)).last_message_preview).toBe('Audio');
    // WhatsApp's media objects through the send pipeline (the stand-in checks their shape).
    expect(await sendAll(c)).toEqual(['accepted', 'accepted']);
    // Their status reads back as the media they are, never as templates.
    for (const [message, type] of [
      [document, 'document'],
      [audio, 'audio'],
    ] as const) {
      expect(await apiGetMessage(deps(), ctx, idOf(message))).toMatchObject({
        type,
        status: 'accepted',
        templateId: null,
        templateName: null,
      });
    }
    const sent = fx.standIn.state.requests.filter(
      (r) => r.path.endsWith('/messages') && (r.body as { to?: string } | undefined)?.to === waId,
    );
    expect(
      sent.map((r) => {
        const body = r.body as Record<string, unknown> & { type: string };
        return [body.type, body[body.type]];
      }),
    ).toEqual([
      ['document', { link: menu, caption: 'Our menu' }],
      ['audio', { link: greeting }],
    ]);
    // Read back with the caption as the text; the media is never attached.
    const { data } = await apiListConversationMessages(deps(), ctx, conv.id, {});
    expect(
      data
        .filter((m) => m.direction === 'outbound')
        .map((m) => [m.type, m.text, m.mimeType, m.sentBy]),
    ).toEqual(
      expect.arrayContaining([
        ['document', 'Our menu', null, 'api'],
        ['audio', null, null, 'api'],
      ]),
    );
    // Refused before anything is queued: a link that is not https, a caption on audio, and a
    // number whose window has closed.
    const refusedLink = await apiSendMessage(
      deps(),
      ctx,
      { type: 'image', to: `+${waId}`, link: 'http://cdn.example.com/a.jpg' },
      idem('media-3', 'media-3'),
    ).catch((error: unknown) => error);
    expect(isAppError(refusedLink) && refusedLink.issues?.[0]?.path).toBe('link');
    const refusedCaption = await apiSendMessage(
      deps(),
      ctx,
      { type: 'audio', to: `+${waId}`, link: greeting, caption: 'Hello' },
      idem('media-4', 'media-4'),
    ).catch((error: unknown) => error);
    expect(isAppError(refusedCaption) && refusedCaption.code).toBe('validation_failed');
    const lateWaId = '919811100195';
    await wrote(c, lateWaId, 25 * 3600);
    const late = await apiSendMessage(
      deps(),
      ctx,
      { type: 'image', to: `+${lateWaId}`, link: 'https://cdn.example.com/a.jpg' },
      idem('media-5', 'media-5'),
    ).catch((error: unknown) => error);
    expect(reason(late)).toBe('window_closed');
    const [{ count } = { count: -1 }] = await fx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app.messages WHERE tenant_id = $1 AND direction = 'outbound'`,
      [c.tenant.id],
    );
    expect(count).toBe(2);
  });

  it('send a sticker from an https link the same way, without a caption (ADR-198)', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['messages.reply', 'conversations.read'], 'Stickers');
    const waId = '919811101981';
    await wrote(c, waId);
    const conv = await conversationWith(c, `+${waId}`);
    const link = 'https://cdn.example.com/thanks.webp';
    const sent = await apiSendMessage(
      deps(),
      ctx,
      { type: 'sticker', to: `+${waId}`, link },
      idem('sticker-1', 'sticker-1'),
    );
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ type: 'sticker', status: 'queued' });
    const [stored] = await fx.query(
      `SELECT m.type, m.content, si.request
         FROM app.messages m
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
        WHERE m.id = $1`,
      [idOf(sent)],
    );
    expect(stored).toEqual({
      type: 'sticker',
      content: { link },
      request: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waId,
        type: 'sticker',
        sticker: { link },
      },
    });
    expect((await conversationWith(c, `+${waId}`)).last_message_preview).toBe('Sticker');
    // WhatsApp's sticker object through the send pipeline (the stand-in checks its shape).
    expect(await sendAll(c)).toEqual(['accepted']);
    expect(await apiGetMessage(deps(), ctx, idOf(sent))).toMatchObject({
      type: 'sticker',
      status: 'accepted',
    });
    const atStandIn = fx.standIn.state.requests.filter(
      (r) => r.path.endsWith('/messages') && (r.body as { to?: string } | undefined)?.to === waId,
    );
    expect(atStandIn.map((r) => (r.body as { sticker?: unknown }).sticker)).toEqual([{ link }]);
    const { data } = await apiListConversationMessages(deps(), ctx, conv.id, {});
    expect(data.find((m) => m.direction === 'outbound')).toMatchObject({
      type: 'sticker',
      text: null,
      mimeType: null,
      sentBy: 'api',
    });
    // A caption is refused before anything is queued.
    const captioned = await apiSendMessage(
      deps(),
      ctx,
      { type: 'sticker', to: `+${waId}`, link, caption: 'Thanks!' },
      idem('sticker-2', 'sticker-2'),
    ).catch((error: unknown) => error);
    expect(isAppError(captioned) && captioned.code).toBe('validation_failed');
    const [{ count } = { count: -1 }] = await fx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app.messages WHERE tenant_id = $1 AND direction = 'outbound'`,
      [c.tenant.id],
    );
    expect(count).toBe(1);
  });

  it('send a location the same way, keeping its coordinates and giving WhatsApp decimal text (ADR-195)', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['messages.reply', 'conversations.read'], 'Front desk');
    const waId = '919811101951';
    await wrote(c, waId);
    const conv = await conversationWith(c, `+${waId}`);
    const clinic = await apiSendMessage(
      deps(),
      ctx,
      {
        type: 'location',
        to: `+${waId}`,
        latitude: 18.5204,
        longitude: 73.8567,
        name: ' Harbour Dental ',
        address: '12 Harbour Road, Pune',
      },
      idem('location-1', 'location-1'),
    );
    expect(clinic.status).toBe(201);
    expect(clinic.body.data).toMatchObject({ type: 'location', status: 'queued' });
    // A place without a name, just south of the equator: its latitude written out in decimals.
    const pier = await apiSendMessage(
      deps(),
      ctx,
      {
        type: 'location',
        to: `+${waId}`,
        latitude: -0.0000005,
        longitude: 9.45,
        address: 'Pier 3',
      },
      idem('location-2', 'location-2'),
    );
    const stored = await fx.query(
      `SELECT m.type, m.content, m.sender_type, si.request
         FROM app.messages m
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
        WHERE m.id = ANY($1::uuid[]) ORDER BY m.created_at`,
      [[idOf(clinic), idOf(pier)]],
    );
    const frame = { messaging_product: 'whatsapp', recipient_type: 'individual', to: waId };
    const clinicPlace = { name: 'Harbour Dental', address: '12 Harbour Road, Pune' };
    expect(stored).toEqual([
      {
        type: 'location',
        content: { latitude: 18.5204, longitude: 73.8567, ...clinicPlace },
        sender_type: 'api',
        request: {
          ...frame,
          type: 'location',
          location: { latitude: '18.5204', longitude: '73.8567', ...clinicPlace },
        },
      },
      {
        type: 'location',
        content: { latitude: -0.0000005, longitude: 9.45, address: 'Pier 3' },
        sender_type: 'api',
        request: {
          ...frame,
          type: 'location',
          location: { latitude: '-0.0000005', longitude: '9.45', address: 'Pier 3' },
        },
      },
    ]);
    expect((await conversationWith(c, `+${waId}`)).last_message_preview).toBe('Pier 3');
    // WhatsApp's location objects through the send pipeline (the stand-in checks their shape).
    expect(await sendAll(c)).toEqual(['accepted', 'accepted']);
    for (const message of [clinic, pier]) {
      expect(await apiGetMessage(deps(), ctx, idOf(message))).toMatchObject({
        type: 'location',
        status: 'accepted',
      });
    }
    const sent = fx.standIn.state.requests.filter(
      (r) => r.path.endsWith('/messages') && (r.body as { to?: string } | undefined)?.to === waId,
    );
    expect(sent.map((r) => (r.body as { location?: unknown }).location)).toEqual([
      { latitude: '18.5204', longitude: '73.8567', ...clinicPlace },
      { latitude: '-0.0000005', longitude: '9.45', address: 'Pier 3' },
    ]);
    // Read back with the place's name, or its address, as the text.
    const { data } = await apiListConversationMessages(deps(), ctx, conv.id, {});
    expect(
      data.filter((m) => m.direction === 'outbound').map((m) => [m.type, m.text, m.sentBy]),
    ).toEqual(
      expect.arrayContaining([
        ['location', 'Harbour Dental', 'api'],
        ['location', 'Pier 3', 'api'],
      ]),
    );
    // Refused before anything is queued: a latitude past the pole, a property Meta's spec does not
    // send, and a number whose window has closed.
    const pole = await apiSendMessage(
      deps(),
      ctx,
      { type: 'location', to: `+${waId}`, latitude: 90.5, longitude: 0 },
      idem('location-3', 'location-3'),
    ).catch((error: unknown) => error);
    expect(isAppError(pole) && pole.issues?.[0]?.path).toBe('latitude');
    const withUrl = await apiSendMessage(
      deps(),
      ctx,
      { type: 'location', to: `+${waId}`, latitude: 1, longitude: 2, url: 'https://x.example' },
      idem('location-4', 'location-4'),
    ).catch((error: unknown) => error);
    expect(isAppError(withUrl) && withUrl.code).toBe('validation_failed');
    const lateWaId = '919811101952';
    await wrote(c, lateWaId, 25 * 3600);
    const late = await apiSendMessage(
      deps(),
      ctx,
      { type: 'location', to: `+${lateWaId}`, latitude: 1, longitude: 2 },
      idem('location-5', 'location-5'),
    ).catch((error: unknown) => error);
    expect(reason(late)).toBe('window_closed');
    const [{ count } = { count: -1 }] = await fx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app.messages WHERE tenant_id = $1 AND direction = 'outbound'`,
      [c.tenant.id],
    );
    expect(count).toBe(2);
  });

  it('send contact cards the same way, kept in WhatsApp’s words and read back as shared cards are (ADR-197)', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['messages.reply', 'conversations.read'], 'Front desk');
    const waId = '919811101971';
    await wrote(c, waId);
    const conv = await conversationWith(c, `+${waId}`);
    const sent = await apiSendMessage(
      deps(),
      ctx,
      {
        type: 'contacts',
        to: `+${waId}`,
        contacts: [
          {
            name: { formattedName: ' Harbour Dental Front Desk ', firstName: 'Front desk' },
            phones: [{ phone: '+91 20 4000 1234', type: 'WORK' }],
            emails: [{ email: 'desk@harbour.example', type: 'WORK' }],
          },
          {
            name: { formattedName: 'Dr Rao', lastName: 'Rao', prefix: 'Dr' },
            phones: [{ phone: '+91 98200 12345', type: 'WORK', waId: '919820012345' }],
          },
        ],
      },
      idem('cards-1', 'cards-1'),
    );
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ type: 'contacts', status: 'queued' });
    const desk = {
      name: { formatted_name: 'Harbour Dental Front Desk', first_name: 'Front desk' },
      phones: [{ phone: '+91 20 4000 1234', type: 'WORK' }],
      emails: [{ email: 'desk@harbour.example', type: 'WORK' }],
    };
    const rao = {
      name: { formatted_name: 'Dr Rao', last_name: 'Rao', prefix: 'Dr' },
      phones: [{ phone: '+91 98200 12345', type: 'WORK', wa_id: '919820012345' }],
    };
    const [stored] = await fx.query(
      `SELECT m.type, m.content, m.sender_type, si.request
         FROM app.messages m
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
        WHERE m.id = $1`,
      [idOf(sent)],
    );
    expect(stored).toEqual({
      type: 'contacts',
      content: { contacts: [desk, rao] },
      sender_type: 'api',
      request: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waId,
        type: 'contacts',
        contacts: [desk, rao],
      },
    });
    expect((await conversationWith(c, `+${waId}`)).last_message_preview).toBe(
      'Contact card: Harbour Dental Front Desk, Dr Rao',
    );
    // WhatsApp's contact objects through the send pipeline (the stand-in checks their shape).
    expect(await sendAll(c)).toEqual(['accepted']);
    expect(await apiGetMessage(deps(), ctx, idOf(sent))).toMatchObject({
      type: 'contacts',
      status: 'accepted',
    });
    const atStandIn = fx.standIn.state.requests.filter(
      (r) => r.path.endsWith('/messages') && (r.body as { to?: string } | undefined)?.to === waId,
    );
    expect(atStandIn.map((r) => (r.body as { contacts?: unknown }).contacts)).toEqual([
      [desk, rao],
    ]);
    // Read back as the cards customers share are read (ADR-196).
    const { data } = await apiListConversationMessages(deps(), ctx, conv.id, {});
    const card = data.find((m) => m.direction === 'outbound');
    expect(card).toMatchObject({ type: 'contacts', text: null, sentBy: 'api' });
    expect(card?.contacts?.map((x) => [x.name.formattedName, x.phones.map((p) => p.waId)])).toEqual(
      [
        ['Harbour Dental Front Desk', [null]],
        ['Dr Rao', ['919820012345']],
      ],
    );
    // Refused before anything is queued: a name without another part, a kind the spec does not
    // name, and a number whose window has closed.
    const nameless = await apiSendMessage(
      deps(),
      ctx,
      { type: 'contacts', to: `+${waId}`, contacts: [{ name: { formattedName: 'Desk' } }] },
      idem('cards-2', 'cards-2'),
    ).catch((error: unknown) => error);
    expect(isAppError(nameless) && nameless.issues?.[0]?.path).toBe('contacts.0.name.firstName');
    const mobile = await apiSendMessage(
      deps(),
      ctx,
      {
        type: 'contacts',
        to: `+${waId}`,
        contacts: [
          {
            name: { formattedName: 'Dr Rao', lastName: 'Rao' },
            phones: [{ phone: '+91 98200 12345', type: 'MOBILE' }],
          },
        ],
      },
      idem('cards-3', 'cards-3'),
    ).catch((error: unknown) => error);
    expect(isAppError(mobile) && mobile.code).toBe('validation_failed');
    const lateWaId = '919811101972';
    await wrote(c, lateWaId, 25 * 3600);
    const late = await apiSendMessage(
      deps(),
      ctx,
      {
        type: 'contacts',
        to: `+${lateWaId}`,
        contacts: [{ name: { formattedName: 'Dr Rao', lastName: 'Rao' } }],
      },
      idem('cards-4', 'cards-4'),
    ).catch((error: unknown) => error);
    expect(reason(late)).toBe('window_closed');
    const [{ count } = { count: -1 }] = await fx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app.messages WHERE tenant_id = $1 AND direction = 'outbound'`,
      [c.tenant.id],
    );
    expect(count).toBe(1);
  });

  it('send reply buttons and lists the same way, and give a tap back with its kind (ADR-080)', async () => {
    const c = await fx.company();
    const { ctx, id: keyId } = await apiKey(c, ['messages.reply', 'conversations.read'], 'Booking');
    const waId = '919811100096';
    await wrote(c, waId);
    const conv = await conversationWith(c, `+${waId}`);
    const buttons = {
      type: 'buttons',
      to: `+${waId}`,
      header: 'Your appointment',
      body: 'Tomorrow at 10:00 with Dr Rao. Can you come?',
      footer: 'Sunrise Clinic',
      buttons: [
        { id: 'appt-7:yes', title: 'Confirm' },
        { id: 'appt-7:no', title: 'Cancel' },
      ],
    };
    const list = {
      type: 'list',
      to: `+${waId}`,
      body: 'Pick another time.',
      button: 'See times',
      sections: [
        {
          title: 'Morning',
          rows: [
            { id: 'slot-10', title: '10:00', description: 'Dr Rao' },
            { id: 'slot-11', title: '11:00' },
          ],
        },
        { title: 'Afternoon', rows: [{ id: 'slot-15', title: '15:00' }] },
      ],
    };
    const sentButtons = await apiSendMessage(deps(), ctx, buttons, idem('buttons-1', 'buttons-1'));
    const sentList = await apiSendMessage(deps(), ctx, list, idem('list-1', 'list-1'));
    for (const sent of [sentButtons, sentList]) {
      expect(sent.status).toBe(201);
      expect(sent.body.data).toEqual({
        id: expect.any(String),
        type: 'interactive',
        status: 'queued',
        contactId: expect.any(String),
        channelId: c.channelAccountId,
      });
    }
    // A retry answers as the first request did and sends nothing more.
    expect(await apiSendMessage(deps(), ctx, list, idem('list-1', 'list-1'))).toEqual({
      ...sentList,
      replayed: true,
    });
    const stored = await fx.query(
      `SELECT m.id, m.type, m.content, m.sender_type, m.api_key_id, si.request
         FROM app.messages m
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
        WHERE m.id = ANY($1::uuid[])
        ORDER BY m.created_at`,
      [[idOf(sentButtons), idOf(sentList)]],
    );
    const request = (interactive: unknown) => ({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'interactive',
      interactive,
    });
    expect(stored).toEqual([
      {
        id: idOf(sentButtons),
        type: 'interactive',
        sender_type: 'api',
        api_key_id: keyId,
        // What the inbox shows; the ids only go to Meta.
        content: {
          header: 'Your appointment',
          body: buttons.body,
          footer: 'Sunrise Clinic',
          buttons: ['Confirm', 'Cancel'],
        },
        request: request({
          type: 'button',
          header: { type: 'text', text: 'Your appointment' },
          body: { text: buttons.body },
          footer: { text: 'Sunrise Clinic' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'appt-7:yes', title: 'Confirm' } },
              { type: 'reply', reply: { id: 'appt-7:no', title: 'Cancel' } },
            ],
          },
        }),
      },
      {
        id: idOf(sentList),
        type: 'interactive',
        sender_type: 'api',
        api_key_id: keyId,
        content: {
          header: null,
          body: 'Pick another time.',
          footer: null,
          list: {
            button: 'See times',
            sections: [
              {
                title: 'Morning',
                rows: [
                  { title: '10:00', description: 'Dr Rao' },
                  { title: '11:00', description: null },
                ],
              },
              { title: 'Afternoon', rows: [{ title: '15:00', description: null }] },
            ],
          },
        },
        request: request({
          type: 'list',
          body: { text: 'Pick another time.' },
          action: {
            button: 'See times',
            sections: [
              {
                title: 'Morning',
                rows: [
                  { id: 'slot-10', title: '10:00', description: 'Dr Rao' },
                  { id: 'slot-11', title: '11:00' },
                ],
              },
              { title: 'Afternoon', rows: [{ id: 'slot-15', title: '15:00' }] },
            ],
          },
        }),
      },
    ]);
    // The Graph stand-in checks both against Meta's limits, and accepts them.
    expect(await sendAll(c)).toEqual(['accepted', 'accepted']);
    expect((await apiGetMessage(deps(), ctx, idOf(sentButtons))).type).toBe('interactive');
    expect((await apiGetMessage(deps(), ctx, idOf(sentList))).type).toBe('interactive');
    expect((await conversationWith(c, `+${waId}`)).last_message_preview).toBe('Pick another time.');

    // The customer picks a row: it comes back with the row's id, its kind and its description.
    const [sentRow] = await fx.query<{ external_message_id: string }>(
      'SELECT external_message_id FROM app.messages WHERE id = $1',
      [idOf(sentList)],
    );
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [
          {
            waId,
            type: 'interactive',
            extra: {
              interactive: {
                type: 'list_reply',
                list_reply: { id: 'slot-10', title: '10:00', description: 'Dr Rao' },
              },
              context: { from: '919000000000', id: sentRow!.external_message_id },
            },
          },
        ],
      }),
    );
    const { data } = await apiListConversationMessages(deps(), ctx, conv.id, {});
    expect(
      data
        .slice(0, 3)
        .map(({ direction, type, text, reply }) => ({ direction, type, text, reply })),
    ).toEqual([
      {
        direction: 'inbound',
        type: 'interactive',
        text: '10:00',
        reply: { id: 'slot-10', title: '10:00', type: 'list', description: 'Dr Rao' },
      },
      { direction: 'outbound', type: 'interactive', text: 'Pick another time.', reply: null },
      { direction: 'outbound', type: 'interactive', text: buttons.body, reply: null },
    ]);
  });

  it('refuse buttons and rows with HyFib’s own ids, or beyond Meta’s limits, before anything is stored', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['messages.reply']);
    const waId = '919811100097';
    await wrote(c, waId);
    const bodies: Record<string, unknown>[] = [
      {
        type: 'buttons',
        to: `+${waId}`,
        body: 'How did we do?',
        buttons: [{ id: 'w360csat:0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01:3', title: 'Great' }],
      },
      {
        type: 'list',
        to: `+${waId}`,
        body: 'Pick one',
        button: 'Options',
        sections: [{ rows: [{ id: 'W360bot:run:node:1:0', title: 'One' }] }],
      },
      {
        type: 'list',
        to: `+${waId}`,
        body: 'Pick one',
        button: 'Options',
        sections: [
          {
            title: 'A',
            rows: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, title: `A${i}` })),
          },
          {
            title: 'B',
            rows: Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, title: `B${i}` })),
          },
        ],
      },
    ];
    for (const [i, body] of bodies.entries()) {
      await expectAppError(
        apiSendMessage(deps(), ctx, body, idem(`bad-${i}`, `bad-${i}`)),
        'validation_failed',
      );
    }
    const [row] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.messages WHERE tenant_id = $1 AND direction = 'outbound'`,
      [c.tenant.id],
    );
    expect(row?.n).toBe(0);
    // A number that has not written gets the one answer text replies get.
    const closed = await expectAppError(
      apiSendMessage(
        deps(),
        ctx,
        { ...bodies[0], to: '+919811100098', buttons: [{ id: 'yes', title: 'Yes' }] },
        idem('closed', 'closed'),
      ),
      'precondition_failed',
    );
    expect(reason(closed)).toBe('window_closed');
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

const inbox = () =>
  createInboxService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });

/** Inbound messages from `waId`, one webhook each, to the company's number or another of its. */
async function inbound(
  company: Company,
  waId: string,
  messages: Omit<InboundSpec, 'waId'>[],
  phoneNumberId = company.phoneNumberId,
) {
  for (const m of messages) {
    await fx.deliver(
      fx.messagesBody({ ...company, phoneNumberId }, { messages: [{ ...m, waId }] }),
    );
  }
}

async function conversationOf(company: Company, waId: string) {
  const [row] = await fx.query<{ id: string; contact_id: string; version: number }>(
    `SELECT cv.id, cv.contact_id, cv.version
       FROM app.conversations cv
       JOIN app.contacts ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contact_id
      WHERE cv.tenant_id = $1 AND ct.phone_e164 = $2`,
    [company.tenant.id, `+${waId}`],
  );
  if (!row) throw new Error('no conversation');
  return row;
}

describe('quotes and reactions (ADR-082)', () => {
  const idOf = (response: { body: Record<string, unknown> }) =>
    (response.body.data as { id: string }).id;
  const wamid = () => `wamid.in.${uuidv7()}`;

  async function messageWith(company: Company, externalId: string) {
    const [row] = await fx.query<{ id: string }>(
      'SELECT id FROM app.messages WHERE tenant_id = $1 AND external_message_id = $2',
      [company.tenant.id, externalId],
    );
    if (!row) throw new Error('no message with that WhatsApp id');
    return row.id;
  }
  async function externalIdOf(messageId: string) {
    const [row] = await fx.query<{ external_message_id: string | null }>(
      'SELECT external_message_id FROM app.messages WHERE id = $1',
      [messageId],
    );
    return row?.external_message_id ?? null;
  }
  const stored = async (messageId: string) =>
    (
      await fx.query(
        `SELECT m.type, m.content, m.context_external_id, si.request
           FROM app.messages m
           JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
          WHERE m.id = $1`,
        [messageId],
      )
    )[0];

  it('quote a message of the conversation and react to what the contact wrote, through the send pipeline', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['messages.reply', 'conversations.read'], 'Helpdesk');
    const waId = '919811100200';
    const asked = wamid();
    await inbound(c, waId, [{ id: asked, text: 'Can I move my appointment?' }]);
    const conv = await conversationOf(c, waId);
    const askedId = await messageWith(c, asked);
    const send = (input: Record<string, unknown>, key: string) =>
      apiSendMessage(deps(), ctx, input, idem(key, key));

    // A text and buttons that quote the question, and a reaction to it, once per key.
    const text = await send(
      { type: 'text', to: `+${waId}`, text: 'Yes: which day suits you?', replyTo: askedId },
      'q-1',
    );
    expect(text.status).toBe(201);
    const buttons = await send(
      {
        type: 'buttons',
        to: `+${waId}`,
        body: 'Or keep it?',
        buttons: [{ id: 'keep', title: 'Keep it' }],
        replyTo: askedId,
      },
      'q-2',
    );
    const reaction = { type: 'reaction', to: `+${waId}`, replyTo: askedId, emoji: '👍' };
    const reacted = await send(reaction, 'q-3');
    expect(reacted.status).toBe(201);
    expect(reacted.body.data).toEqual({
      id: expect.any(String),
      type: 'reaction',
      status: 'queued',
      contactId: conv.contact_id,
      channelId: c.channelAccountId,
    });
    expect(await send(reaction, 'q-3')).toEqual({ ...reacted, replayed: true });

    // The quoted message's WhatsApp id goes in `context`; a reaction names it in `reaction`.
    expect(await stored(idOf(text))).toEqual({
      type: 'text',
      content: { text: 'Yes: which day suits you?' },
      context_external_id: asked,
      request: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waId,
        context: { message_id: asked },
        type: 'text',
        text: { body: 'Yes: which day suits you?', preview_url: false },
      },
    });
    expect(await stored(idOf(buttons))).toMatchObject({
      type: 'interactive',
      context_external_id: asked,
      request: { context: { message_id: asked }, type: 'interactive' },
    });
    expect(await stored(idOf(reacted))).toEqual({
      type: 'reaction',
      content: { emoji: '👍', message_id: asked },
      context_external_id: null,
      request: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waId,
        type: 'reaction',
        reaction: { message_id: asked, emoji: '👍' },
      },
    });
    const [preview] = await fx.query<{ last_message_preview: string }>(
      'SELECT last_message_preview FROM app.conversations WHERE id = $1',
      [conv.id],
    );
    expect(preview?.last_message_preview).toBe('Reacted 👍');

    // The Graph stand-in accepts all three, as Meta's spec describes them.
    expect(await sendAll(c)).toEqual(['accepted', 'accepted', 'accepted']);
    const bodies = templatesTo(waId).map((r) => r.body as Record<string, unknown>);
    expect(bodies.map((b) => [b.type, b.context])).toEqual([
      ['text', { message_id: asked }],
      ['interactive', { message_id: asked }],
      ['reaction', undefined],
    ]);
    expect(await apiGetMessage(deps(), ctx, idOf(reacted))).toMatchObject({
      type: 'reaction',
      status: 'accepted',
      replyTo: askedId,
    });
    expect((await apiGetMessage(deps(), ctx, idOf(text))).replyTo).toBe(askedId);
    expect((await apiGetMessage(deps(), ctx, idOf(buttons))).replyTo).toBe(askedId);

    // The customer quotes the text reply and reacts to it; a quote of a message HyFib does not
    // have names none.
    const textWamid = await externalIdOf(idOf(text));
    if (!textWamid) throw new Error('the reply has no WhatsApp id');
    await inbound(c, waId, [
      { text: 'Thursday, please.', contextId: textWamid },
      { type: 'reaction', extra: { reaction: { message_id: textWamid, emoji: '🙏' } } },
      { text: 'And one more thing.', contextId: 'wamid.not.here' },
    ]);
    const page = await apiListConversationMessages(deps(), ctx, conv.id, { limit: '10' });
    expect(page.data.map((m) => [m.direction, m.type, m.text, m.replyTo])).toEqual([
      ['inbound', 'text', 'And one more thing.', null],
      ['inbound', 'reaction', '🙏', idOf(text)],
      ['inbound', 'text', 'Thursday, please.', idOf(text)],
      ['outbound', 'reaction', '👍', askedId],
      ['outbound', 'interactive', 'Or keep it?', askedId],
      ['outbound', 'text', 'Yes: which day suits you?', askedId],
      ['inbound', 'text', 'Can I move my appointment?', null],
    ]);

    // Another customer on the number quoting the first one's message names nothing: only a
    // message of the same conversation counts.
    await inbound(c, '919811100204', [{ text: 'Same question here.', contextId: asked }]);
    const otherConv = await conversationOf(c, '919811100204');
    const otherPage = await apiListConversationMessages(deps(), ctx, otherConv.id, {});
    expect(otherPage.data.map((m) => [m.text, m.replyTo])).toEqual([['Same question here.', null]]);
    const otherThread = await inbox().getConversation(await fx.ctx(c, c.owner), otherConv.id);
    expect(otherThread.messages.map((m) => m.replyTo)).toEqual([null]);

    // Members see the quote above a reply and what a reaction is for.
    const thread = await inbox().getConversation(await fx.ctx(c, c.owner), conv.id);
    const shown = (id: string) => thread.messages.find((m) => m.id === id)?.replyTo;
    const question = { id: askedId, direction: 'inbound', text: 'Can I move my appointment?' };
    expect(shown(idOf(text))).toEqual(question);
    expect(shown(idOf(reacted))).toEqual(question);
    const thursday = page.data.find((m) => m.text === 'Thursday, please.');
    expect(shown(thursday!.id)).toEqual({
      id: idOf(text),
      direction: 'outbound',
      text: 'Yes: which day suits you?',
    });
    expect(shown(askedId)).toBeNull();
  });

  it('refuse, storing nothing, what the conversation cannot quote or react to', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const { ctx, id: keyId } = await apiKey(c, ['messages.reply']);
    const send = (input: Record<string, unknown>, key: string) =>
      apiSendMessage(deps(), ctx, input, idem(key, key));
    const waId = '919811100201';
    const to = `+${waId}`;
    const [old, asked, theirReaction, elsewhere, otherCompany] = [
      wamid(),
      wamid(),
      wamid(),
      wamid(),
      wamid(),
    ];
    // A message 31 days old, a recent one and the customer's reaction to it: the window is open.
    await inbound(c, waId, [
      {
        id: old,
        text: 'Last month’s order',
        timestamp: Math.floor(Date.now() / 1000) - 31 * 24 * 3600,
      },
      { id: asked, text: 'Where is my order?' },
      {
        id: theirReaction,
        type: 'reaction',
        extra: { reaction: { message_id: asked, emoji: '😀' } },
      },
    ]);
    await inbound(c, '919811100202', [{ id: elsewhere, text: 'Hello from another customer' }]);
    await inbound(other, '919811100203', [{ id: otherCompany, text: 'Hello from elsewhere' }]);
    const ids = {
      old: await messageWith(c, old),
      asked: await messageWith(c, asked),
      theirReaction: await messageWith(c, theirReaction),
      elsewhere: await messageWith(c, elsewhere),
      otherCompany: await messageWith(other, otherCompany),
    };
    // Replies of the business: one accepted, one accepted and then failed, one still queued.
    const accepted = idOf(await send({ type: 'text', to, text: 'On its way.' }, 'r-1'));
    const failed = idOf(await send({ type: 'text', to, text: 'Here is the link.' }, 'r-2'));
    expect(await sendAll(c)).toEqual(['accepted', 'accepted']);
    await fx.deliver(
      fx.messagesBody(c, {
        statuses: [
          {
            id: await externalIdOf(failed),
            status: 'failed',
            timestamp: String(Math.floor(Date.now() / 1000)),
            recipient_id: waId,
            errors: [{ code: 131026, title: 'Message undeliverable' }],
          },
        ],
      }),
    );
    const queued = idOf(await send({ type: 'text', to, text: 'Checking.' }, 'r-3'));
    const quote = (replyTo: string) => ({ type: 'text', to, text: 'About this:', replyTo });
    const react = (replyTo: string, emoji = '👍') => ({ type: 'reaction', to, replyTo, emoji });

    const refused = async (input: Record<string, unknown>, key: string, message: string) => {
      const error = await expectAppError(send(input, key), 'validation_failed');
      expect(apiErrorResponse(error, 'r').body.error).toMatchObject({
        message,
        issues: [{ path: 'replyTo', message }],
      });
    };
    const unknown = 'Give the id of a message in this conversation.';
    for (const [i, id] of [uuidv7(), ids.elsewhere, ids.otherCompany].entries()) {
      await refused(quote(id), `x-q${i}`, unknown);
      await refused(react(id), `x-r${i}`, unknown);
    }
    await refused(
      quote(ids.theirReaction),
      'x-1',
      'Reactions and WhatsApp notices cannot be quoted.',
    );
    await refused(quote(queued), 'x-2', 'Only messages WhatsApp accepted can be quoted.');
    await refused(quote(failed), 'x-3', 'Only messages WhatsApp accepted can be quoted.');
    await refused(react(accepted), 'x-4', 'Reactions go on messages the contact sent.');
    await refused(react(ids.old), 'x-5', 'Reactions go on messages from the last 30 days.');
    await refused(
      react(ids.theirReaction),
      'x-6',
      'Reactions go on messages the contact sent, not on reactions or WhatsApp notices.',
    );
    await expectAppError(send(react(ids.asked, 'yes'), 'x-7'), 'validation_failed', /one emoji/);
    await expectAppError(send(react(ids.asked, '👍👎'), 'x-8'), 'validation_failed', /one emoji/);
    // A number that has not written gets the one answer, whatever it names.
    const closed = await expectAppError(
      send({ ...react(ids.asked), to: '+919811100299' }, 'x-9'),
      'precondition_failed',
    );
    expect(apiErrorResponse(closed, 'r').body.error.reason).toBe('window_closed');

    // An old message can still be quoted; the one reply sent, with the first three, is all that
    // was stored.
    expect((await send(quote(ids.old), 'r-4')).status).toBe(201);
    const keysStored = await fx.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM app.api_idempotency_keys WHERE api_key_id = $1 ORDER BY idempotency_key',
      [keyId],
    );
    expect(keysStored.map((r) => r.idempotency_key)).toEqual(['r-1', 'r-2', 'r-3', 'r-4']);
    const sentByKey = await fx.query('SELECT id FROM app.messages WHERE api_key_id = $1', [keyId]);
    expect(sentByKey).toHaveLength(4);
  });
});

let planCodes = 0;
/** Puts the company on a published plan with the given modules (P5-01), as platform staff would. */
async function onPlan(c: Company, modules: string[]) {
  const staff = await createUser(fx.dbs, { twoFactor: true });
  await fx.dbs.ownerPool.query(
    `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_owner')`,
    [staff.id],
  );
  const actor: PlatformActor = {
    userId: staff.id,
    role: 'platform_owner',
    correlationId: uuidv7(),
  };
  const plans = createPlanAdminService({ platformDb: fx.dbs.platform, clock: systemClock });
  planCodes += 1;
  const { id } = await plans.createPlan(actor, {
    code: `shop-api-${Date.now().toString(36)}-${planCodes}`,
    name: 'Shop plan',
    price: '999',
    intervalMonths: '1',
    trialDays: '0',
    graceDays: '7',
    seatsIncluded: '10',
    numbersIncluded: '5',
    modules,
  });
  await plans.publishPlan(actor, id);
  const view = await plans.tenantPlan(actor, c.tenant.id);
  await plans.setTenantPlan(actor, {
    tenantId: c.tenant.id,
    version: view.state.version,
    status: 'active',
    planId: id,
    periodStart: dayOf(new Date(), 'Asia/Kolkata'),
    periodEnd: dayOf(new Date(Date.now() + 30 * 86_400_000), 'Asia/Kolkata'),
    reason: 'Plan for the API Commerce tests',
  });
}

describe('product messages (ADR-086)', () => {
  const commerce = () =>
    createCommerceService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
      keyring: fx.keyring,
      appBaseUrl: 'https://app.example.test',
      allowLiveKeys: false,
    });
  const catalogDeps = () => ({
    db: fx.dbs.app,
    keyring: fx.keyring,
    graph: fx.graph,
    clock: systemClock,
    razorpayBaseUrl: 'http://127.0.0.1:9',
    jobs: fx.jobs(),
    signer: fx.signer,
  });

  /**
   * A WhatsApp account's catalogs at Meta, each with its products, read by HyFib (Commerce →
   * Catalogs). The company's first account unless another is given.
   */
  async function catalogs(
    c: Company,
    entries: { id: string; products: [string, string][] }[],
    account = { wabaId: c.wabaId, whatsappAccountId: c.whatsappAccountId },
  ) {
    fx.standIn.state.catalogs.set(
      account.wabaId,
      entries.map((e) => ({ id: e.id, name: `Catalog ${e.id}`, product_count: e.products.length })),
    );
    for (const e of entries) {
      fx.standIn.state.catalogProducts.set(
        e.id,
        e.products.map(([retailerId, name], i) => ({
          id: `${e.id}${i}`,
          retailer_id: retailerId,
          name,
          price: '₹100.00',
          currency: 'INR',
          availability: 'in stock',
          review_status: 'approved',
        })),
      );
    }
    await commerce().requestSync(await fx.ctx(c, c.owner), {
      whatsappAccountId: account.whatsappAccountId,
    });
    expect(
      await processCommerceSync(
        catalogDeps(),
        authorizedTenantScope(c.tenant.id, null),
        account.whatsappAccountId,
      ),
    ).toBe('done');
  }

  /** Another WhatsApp account of the company, connected with the same token, without numbers. */
  async function secondAccount(c: Company) {
    const whatsappAccountId = uuidv7();
    const wabaId = nextExternalId();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx) => {
      await tx.insert(whatsappAccounts).values({
        id: whatsappAccountId,
        tenantId: c.tenant.id,
        wabaId,
        name: 'Second account',
        status: 'connected',
        credentialCiphertext: fx.keyring.encrypt(
          c.token,
          credentialAad(c.tenant.id, whatsappAccountId),
        ),
      });
      await tx.execute(
        sql`select app.bind_provider_asset('meta_whatsapp', 'waba', ${wabaId}, ${whatsappAccountId}::uuid, null)`,
      );
    });
    return { wabaId, whatsappAccountId };
  }

  async function wrote(c: Company, waId: string, secondsAgo = 0) {
    const timestamp = Math.floor(Date.now() / 1000) - secondsAgo;
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId, text: 'What tea do you have?', timestamp }] }),
    );
  }

  const idOf = (response: { body: Record<string, unknown> }) =>
    (response.body.data as { id: string }).id;
  const reasonOf = (error: unknown) => apiErrorResponse(error, 'r').body.error.reason;
  const issuesOf = (error: unknown) =>
    (apiErrorResponse(error, 'r').body.error as { issues?: { path: string; message: string }[] })
      .issues ?? [];

  it('send a product, several products and the catalog once per Idempotency-Key, as the inbox sends them', async () => {
    const c = await fx.company();
    const { ctx, id: keyId } = await apiKey(c, ['messages.reply'], 'Shop');
    await catalogs(c, [
      {
        id: '5558601',
        products: [
          ['chai-1', 'Masala chai'],
          ['chai-2', 'Ginger biscuits'],
          ['chai-3', 'Clay cup'],
        ],
      },
    ]);
    const waId = '919811100601';
    await wrote(c, waId);
    const to = `+${waId}`;
    const product = {
      type: 'product',
      to,
      retailerId: 'chai-1',
      body: 'Our best seller',
      footer: 'Tea house',
    };
    const list = {
      type: 'product_list',
      to,
      header: 'Tea time',
      body: 'Goes well with chai',
      sections: [
        { title: 'Tea', retailerIds: ['chai-1'] },
        { title: 'Snacks', retailerIds: ['chai-2', 'chai-3'] },
      ],
    };
    const menu = { type: 'catalog', to, thumbnailRetailerId: 'chai-3', body: 'See our menu' };
    const sent = [
      await apiSendMessage(deps(), ctx, product, idem('product-1', 'product-1')),
      await apiSendMessage(deps(), ctx, list, idem('product-2', 'product-2')),
      await apiSendMessage(deps(), ctx, menu, idem('product-3', 'product-3')),
    ];
    for (const response of sent) {
      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({
        id: expect.any(String),
        type: 'interactive',
        status: 'queued',
        contactId: expect.any(String),
        channelId: c.channelAccountId,
      });
    }
    // A retry answers as the first request did and queues nothing more.
    expect(await apiSendMessage(deps(), ctx, list, idem('product-2', 'product-2'))).toEqual({
      ...sent[1],
      replayed: true,
    });
    const stored = await fx.query(
      `SELECT m.id, m.type, m.content, m.sender_type, m.api_key_id, si.request
         FROM app.messages m
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
        WHERE m.id = ANY($1::uuid[])
        ORDER BY m.created_at`,
      [sent.map(idOf)],
    );
    const request = (interactive: unknown) => ({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'interactive',
      interactive,
    });
    const common = { type: 'interactive', sender_type: 'api', api_key_id: keyId };
    expect(stored).toEqual([
      {
        id: idOf(sent[0]!),
        ...common,
        // Stored as the inbox stores the products it sends, with the names HyFib read from Meta.
        content: {
          products: {
            kind: 'product',
            names: ['Masala chai'],
            body: 'Our best seller',
            footer: 'Tea house',
          },
        },
        request: request({
          type: 'product',
          body: { text: 'Our best seller' },
          footer: { text: 'Tea house' },
          action: { catalog_id: '5558601', product_retailer_id: 'chai-1' },
        }),
      },
      {
        id: idOf(sent[1]!),
        ...common,
        content: {
          products: {
            kind: 'product_list',
            names: ['Masala chai', 'Ginger biscuits', 'Clay cup'],
            header: 'Tea time',
            body: 'Goes well with chai',
            footer: '',
          },
        },
        request: request({
          type: 'product_list',
          header: { type: 'text', text: 'Tea time' },
          body: { text: 'Goes well with chai' },
          action: {
            catalog_id: '5558601',
            sections: [
              { title: 'Tea', product_items: [{ product_retailer_id: 'chai-1' }] },
              {
                title: 'Snacks',
                product_items: [
                  { product_retailer_id: 'chai-2' },
                  { product_retailer_id: 'chai-3' },
                ],
              },
            ],
          },
        }),
      },
      {
        id: idOf(sent[2]!),
        ...common,
        content: {
          products: { kind: 'catalog', names: ['Clay cup'], body: 'See our menu', footer: '' },
        },
        request: request({
          type: 'catalog_message',
          body: { text: 'See our menu' },
          action: {
            name: 'catalog_message',
            parameters: { thumbnail_product_retailer_id: 'chai-3' },
          },
        }),
      },
    ]);
    // The Graph stand-in, which checks product messages against the catalogs, accepts all three.
    expect(await sendAll(c)).toEqual(['accepted', 'accepted', 'accepted']);
    const [conv] = await fx.query<{ id: string; last_message_preview: string }>(
      `SELECT cv.id, cv.last_message_preview FROM app.conversations cv
         JOIN app.messages m ON m.tenant_id = cv.tenant_id AND m.conversation_id = cv.id
        WHERE m.id = $1`,
      [idOf(sent[2]!)],
    );
    expect(conv?.last_message_preview).toBe('[Catalog]');
    // Members see which key sent them.
    const thread = await createInboxService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    }).getConversation(await fx.ctx(c, c.owner), conv!.id);
    expect(thread.messages.find((m) => m.id === idOf(sent[0]!))).toMatchObject({
      senderType: 'api',
      apiKeyName: 'Shop',
    });
    expect((await apiGetMessage(deps(), ctx, idOf(sent[1]!))).status).toBe('accepted');
  });

  it('refuse products the number cannot send, catalogs it cannot tell apart and a plan without Commerce, storing nothing', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const { ctx } = await apiKey(c, ['messages.reply'], 'Shop');
    await catalogs(c, [
      {
        id: '5558602',
        products: [
          ['chai-1', 'Masala chai'],
          ['cup-1', 'Clay cup'],
          ['old-1', 'Old mug'],
        ],
      },
      {
        id: '5558603',
        products: [
          ['chai-1', 'Masala chai (winter)'],
          ['snack-1', 'Biscuits'],
        ],
      },
      { id: '5558604', products: [['gone-1', 'Tea towel']] },
    ]);
    await catalogs(other, [{ id: '5558605', products: [['theirs-1', 'Their tea']] }]);
    // The company's other WhatsApp account has a catalog of its own, which this number cannot send.
    await catalogs(
      c,
      [{ id: '5558606', products: [['elsewhere-1', 'Tea of the other account']] }],
      await secondAccount(c),
    );
    // Meta no longer lists a product, and a catalog was disconnected from the number.
    await fx.query(
      `UPDATE app.commerce_products SET removed_at = now() WHERE tenant_id = $1 AND retailer_id = 'old-1'`,
      [c.tenant.id],
    );
    await fx.query(
      `UPDATE app.commerce_catalogs SET disconnected_at = now() WHERE tenant_id = $1 AND meta_catalog_id = '5558604'`,
      [c.tenant.id],
    );
    const waId = '919811100602';
    await wrote(c, waId);
    const to = `+${waId}`;
    const send = (body: Record<string, unknown>, key: string) =>
      apiSendMessage(deps(), ctx, { to, ...body }, idem(key, key));
    const refusedFor = async (
      body: Record<string, unknown>,
      key: string,
      path: string,
      message: RegExp,
    ) => {
      const error = await expectAppError(send(body, key), 'validation_failed', message);
      expect(issuesOf(error).map((i) => i.path)).toEqual([path]);
    };

    for (const [retailerId, key] of [
      ['nope-1', 'unknown'],
      ['old-1', 'removed'],
      ['gone-1', 'disconnected'],
      ['theirs-1', 'other-company'],
      ['elsewhere-1', 'other-account'],
    ] as const) {
      await refusedFor(
        { type: 'product', retailerId },
        `refuse-${key}`,
        'products',
        new RegExp(`Not in a catalog of this WhatsApp number: ${retailerId}`),
      );
    }
    // A content id in two catalogs needs the catalog named; ids in different catalogs are refused.
    await refusedFor(
      { type: 'product', retailerId: 'chai-1' },
      'refuse-two',
      'catalogId',
      /name one with catalogId/,
    );
    await refusedFor(
      {
        type: 'product_list',
        header: 'Mixed',
        body: 'Both',
        sections: [{ retailerIds: ['cup-1', 'snack-1'] }],
      },
      'refuse-mixed',
      'products',
      /Give products from one catalog/,
    );
    await refusedFor(
      { type: 'product', retailerId: 'snack-1', catalogId: '5558602' },
      'refuse-wrong-catalog',
      'products',
      /with that id: snack-1/,
    );
    /** The Graph action and the names a send stored. */
    const sentOf = async (response: { body: Record<string, unknown> }) => {
      const [row] = await fx.query<{
        request: { interactive: { action: Record<string, unknown> } };
        content: { products: { names: string[] } };
      }>(
        `SELECT si.request, m.content
           FROM app.send_intents si
           JOIN app.messages m ON m.tenant_id = si.tenant_id AND m.id = si.message_id
          WHERE si.message_id = $1`,
        [idOf(response)],
      );
      return { action: row?.request.interactive.action, names: row?.content.products.names };
    };
    const named = await send(
      { type: 'product', retailerId: 'chai-1', catalogId: '5558602' },
      'send-named',
    );
    expect(named.status).toBe(201);
    // The product's name is the one in the catalog named.
    expect(await sentOf(named)).toEqual({
      action: { catalog_id: '5558602', product_retailer_id: 'chai-1' },
      names: ['Masala chai'],
    });
    // Without catalogId, the one catalog holding every id is used, though another holds one of them.
    const whole = await send(
      {
        type: 'product_list',
        header: 'Chai set',
        body: 'Tea and a cup',
        sections: [{ retailerIds: ['chai-1', 'cup-1'] }],
      },
      'send-whole',
    );
    expect(whole.status).toBe(201);
    expect(await sentOf(whole)).toEqual({
      action: {
        catalog_id: '5558602',
        sections: [
          { product_items: [{ product_retailer_id: 'chai-1' }, { product_retailer_id: 'cup-1' }] },
        ],
      },
      names: ['Masala chai', 'Clay cup'],
    });

    // A number whose window closed gets the replies' single answer.
    const late = '919811100603';
    await wrote(c, late, 25 * 3600);
    const closed = await expectAppError(
      apiSendMessage(
        deps(),
        ctx,
        { type: 'product', to: `+${late}`, retailerId: 'cup-1' },
        idem('late', 'late'),
      ),
      'precondition_failed',
    );
    expect(reasonOf(closed)).toBe('window_closed');

    // A plan without Commerce is refused first, even to a number whose window closed.
    await onPlan(c, []);
    const notInPlan = await expectAppError(
      apiSendMessage(
        deps(),
        ctx,
        { type: 'product', to: `+${late}`, retailerId: 'cup-1' },
        idem('no-commerce', 'no-commerce'),
      ),
      'forbidden',
      /does not include Commerce/,
    );
    expect(reasonOf(notInPlan)).toBe('not_in_plan');
    await onPlan(c, ['commerce']);
    expect((await send({ type: 'product', retailerId: 'cup-1' }, 'with-commerce')).status).toBe(
      201,
    );

    // Only the three sends went through; no refusal kept a message or an idempotency key.
    const kept = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.messages WHERE tenant_id = $1 AND api_key_id IS NOT NULL`,
      [c.tenant.id],
    );
    expect(kept).toEqual([{ n: 3 }]);
    const keysKept = await fx.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM app.api_idempotency_keys WHERE tenant_id = $1 ORDER BY idempotency_key`,
      [c.tenant.id],
    );
    expect(keysKept.map((k) => k.idempotency_key)).toEqual([
      'send-named',
      'send-whole',
      'with-commerce',
    ]);
  });
});

describe('WhatsApp orders (ADR-167)', () => {
  const commerce = () =>
    createCommerceService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
      keyring: fx.keyring,
      appBaseUrl: 'https://app.example.test',
      allowLiveKeys: false,
    });

  /** A cart the customer sends from the catalog through the Meta webhook pipeline; its order. */
  async function sendCart(
    c: Company,
    waId: string,
    items: { retailerId: string; quantity: number; price: number }[],
    text = '',
  ) {
    await inbound(c, waId, [
      {
        type: 'order',
        extra: {
          order: {
            catalog_id: '5558701',
            text,
            product_items: items.map((i) => ({
              product_retailer_id: i.retailerId,
              quantity: i.quantity,
              item_price: i.price,
              currency: 'INR',
            })),
          },
        },
      },
    ]);
    const [order] = await fx.query<{
      id: string;
      reference: string;
      conversation_id: string;
      contact_id: string;
      message_id: string;
    }>(
      `SELECT o.id, o.reference, o.conversation_id, o.contact_id, o.message_id
         FROM app.commerce_orders o
         JOIN app.contacts ct ON ct.tenant_id = o.tenant_id AND ct.id = o.contact_id
        WHERE o.tenant_id = $1 AND ct.phone_e164 = $2
        ORDER BY o.received_at DESC, o.id DESC LIMIT 1`,
      [c.tenant.id, `+${waId}`],
    );
    if (!order) throw new Error('order not recorded');
    return order;
  }

  const versionOf = async (orderId: string) =>
    (
      await fx.query<{ version: number }>('SELECT version FROM app.commerce_orders WHERE id = $1', [
        orderId,
      ])
    )[0]!.version;

  it('list the company’s orders newest first on exact pages, with their items, filtered, and one by id', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const reader = await apiKey(c, ['orders.read'], 'Order sync');
    const list = (query: Record<string, string | null | undefined>) =>
      apiListOrders(deps(), reader.ctx, query);
    const first = await sendCart(
      c,
      '919811100701',
      [
        { retailerId: 'sku-1', quantity: 2, price: 19.99 },
        { retailerId: 'sku-2', quantity: 1, price: 250 },
      ],
      'Please gift wrap',
    );
    const second = await sendCart(c, '919811100702', [
      { retailerId: 'sku-3', quantity: 1, price: 99 },
    ]);
    const third = await sendCart(c, '919811100701', [
      { retailerId: 'sku-1', quantity: 1, price: 19.99 },
    ]);
    await sendCart(other, '919811100703', [{ retailerId: 'sku-1', quantity: 1, price: 10 }]);

    // Newest first, two to a page and the last on the next; another company's order never.
    const page = await list({ limit: '2' });
    expect(page.data.map((o) => o.id)).toEqual([third.id, second.id]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const last = await list({ limit: '2', cursor: page.nextCursor });
    expect(last.data.map((o) => o.id)).toEqual([first.id]);
    expect(last.nextCursor).toBeNull();

    // The order as the webhook describes it: money in minor units, items in cart order, ids only.
    const [stored] = await fx.query<{ received_at: Date }>(
      'SELECT received_at FROM app.commerce_orders WHERE id = $1',
      [first.id],
    );
    expect(last.data[0]).toEqual({
      id: first.id,
      reference: first.reference,
      status: 'received',
      statusChangedAt: expect.any(String),
      conversationId: first.conversation_id,
      contactId: first.contact_id,
      channelId: c.channelAccountId,
      messageId: first.message_id,
      catalogId: '5558701',
      currency: 'INR',
      subtotalMinor: 28_998,
      itemCount: 2,
      droppedItems: 0,
      customerNote: 'Please gift wrap',
      items: [
        { retailerId: 'sku-1', name: null, quantity: 2, unitPriceMinor: 1_999, currency: 'INR' },
        { retailerId: 'sku-2', name: null, quantity: 1, unitPriceMinor: 25_000, currency: 'INR' },
      ],
      receivedAt: stored!.received_at.toISOString(),
      paidAt: null,
      updatedAt: expect.any(String),
    });
    expect(await apiGetOrder(deps(), reader.ctx, first.id)).toEqual(last.data[0]);

    // Filters by contact, conversation and reference.
    expect((await list({ contactId: first.contact_id })).data.map((o) => o.id)).toEqual([
      third.id,
      first.id,
    ]);
    expect((await list({ conversationId: second.conversation_id })).data.map((o) => o.id)).toEqual([
      second.id,
    ]);
    expect((await list({ reference: second.reference })).data.map((o) => o.id)).toEqual([
      second.id,
    ]);

    // A member confirms the first order: it is found by its status and as changed since.
    const before = new Date(Date.now() - 1_000).toISOString();
    await commerce().setOrderStatus(owner, {
      id: first.id,
      expectedVersion: await versionOf(first.id),
      status: 'confirmed',
    });
    expect((await list({ status: 'confirmed' })).data.map((o) => [o.id, o.status])).toEqual([
      [first.id, 'confirmed'],
    ]);
    expect((await list({ status: 'received' })).data.map((o) => o.id)).toEqual([
      third.id,
      second.id,
    ]);
    expect((await list({ updatedSince: before })).data.map((o) => o.id)).toContain(first.id);
    expect(
      (await list({ updatedSince: new Date(Date.now() + 60_000).toISOString() })).data,
    ).toEqual([]);

    // Another company's order is not found by its id; nor is one that does not exist.
    const [theirs] = await fx.query<{ id: string }>(
      'SELECT id FROM app.commerce_orders WHERE tenant_id = $1',
      [other.tenant.id],
    );
    await expectAppError(apiGetOrder(deps(), reader.ctx, theirs!.id), 'not_found');
    await expectAppError(apiGetOrder(deps(), reader.ctx, uuidv7()), 'not_found');
  });

  it('keep an erased contact’s orders without the note, and need the scope and Commerce in the plan', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const reader = await apiKey(c, ['orders.read']);
    const order = await sendCart(
      c,
      '919811100711',
      [{ retailerId: 'sku-1', quantity: 1, price: 19.99 }],
      'Leave at the door',
    );
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: order.contact_id,
      suppress: false,
    });
    const kept = await apiGetOrder(deps(), reader.ctx, order.id);
    expect([kept.customerNote, kept.contactId, kept.items.length]).toEqual([
      null,
      order.contact_id,
      1,
    ]);
    expect((await apiListOrders(deps(), reader.ctx, {})).data.map((o) => o.id)).toEqual([order.id]);

    // A key without the scope is refused before anything is read; reading is allowed while the
    // company is suspended, as every read is.
    const others = await apiKey(c, ['conversations.read', 'contacts.read']);
    await expectAppError(apiListOrders(deps(), others.ctx, {}), 'forbidden', /orders\.read/);
    await expectAppError(apiGetOrder(deps(), others.ctx, order.id), 'forbidden', /orders\.read/);
    const suspended = {
      ...reader.ctx,
      tenant: { ...reader.ctx.tenant, status: 'suspended' as const },
    };
    expect((await apiListOrders(deps(), suspended, {})).data).toHaveLength(1);

    // A plan without Commerce reads no orders; with it again, it does. Each read starts when it is
    // awaited, so neither is refused while nothing waits for it.
    await onPlan(c, []);
    for (const read of [
      () => apiListOrders(deps(), reader.ctx, {}),
      () => apiGetOrder(deps(), reader.ctx, order.id),
    ]) {
      const error = await expectAppError(read(), 'forbidden', /does not include Commerce/);
      expect(isAppError(error) && error.details).toEqual({ apiReason: 'not_in_plan' });
    }
    await onPlan(c, ['commerce']);
    expect((await apiGetOrder(deps(), reader.ctx, order.id)).id).toBe(order.id);
  });

  it('are moved on as members move them, as the key, and a retry changes nothing (ADR-168)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await createWebhooksService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egressPolicy: { allowLoopbackForTests: true },
    }).create(owner, {
      url: 'https://hooks.receiver.test/orders',
      eventTypes: ['order.status_changed'],
    });
    const writer = await apiKey(c, ['orders.write'], 'Order system');
    const change = (id: string, input: unknown) => apiUpdateOrder(deps(), writer.ctx, id, input);
    const order = await sendCart(
      c,
      '919811100721',
      [{ retailerId: 'sku-1', quantity: 3, price: 10 }],
      'Ring twice',
    );
    const versionBefore = await versionOf(order.id);

    // Confirmed from received, as the key, and answered as GET /orders/{id} gives the order.
    const confirmed = await change(order.id, { status: 'confirmed', expectedStatus: 'received' });
    expect(confirmed).toMatchObject({
      id: order.id,
      reference: order.reference,
      status: 'confirmed',
      subtotalMinor: 3_000,
      customerNote: 'Ring twice',
    });
    expect(confirmed.items.map((i) => [i.retailerId, i.quantity])).toEqual([['sku-1', 3]]);
    const reader = await apiKey(c, ['orders.read']);
    expect(await apiGetOrder(deps(), reader.ctx, order.id)).toEqual(confirmed);
    expect(await versionOf(order.id)).toBe(versionBefore + 1);
    const audit = () =>
      fx.query<{ actor_type: string; actor_id: string; metadata: Record<string, unknown> }>(
        `SELECT actor_type, actor_id, metadata FROM app.audit_events
          WHERE tenant_id = $1 AND subject_id = $2 AND action = 'commerce.order_status_changed'
          ORDER BY occurred_at, id`,
        [c.tenant.id, order.id],
      );
    expect(await audit()).toEqual([
      {
        actor_type: 'api_key',
        actor_id: writer.id,
        metadata: { reference: order.reference, from: 'received', to: 'confirmed', source: 'api' },
      },
    ]);
    const events = async () =>
      (
        await fx.query<{ status: string; detail: { orderId: string; previousStatus: string } }>(
          `SELECT status, detail FROM app.webhook_events
            WHERE tenant_id = $1 AND type = 'order.status_changed' ORDER BY created_at, id`,
          [c.tenant.id],
        )
      ).map((e) => [e.detail.orderId, e.detail.previousStatus, e.status]);
    expect(await events()).toEqual([[order.id, 'received', 'confirmed']]);

    // A retry, even with the status it expected the first time, changes nothing.
    expect(await change(order.id, { status: 'confirmed', expectedStatus: 'received' })).toEqual(
      confirmed,
    );
    expect(await versionOf(order.id)).toBe(versionBefore + 1);
    expect(await audit()).toHaveLength(1);
    expect(await events()).toHaveLength(1);

    // A member's page opened before the key's change is stale.
    await expectAppError(
      commerce().setOrderStatus(owner, {
        id: order.id,
        expectedVersion: versionBefore,
        status: 'cancelled',
      }),
      'conflict',
      /Someone else changed this/,
    );

    // Not in the status expected, or a move members cannot make: refused naming the status.
    await expectAppError(
      change(order.id, { status: 'cancelled', expectedStatus: 'received' }),
      'conflict',
      /^The order is not received, so it was not changed\. This order's status is confirmed\.$/,
    );
    const other = await sendCart(c, '919811100722', [
      { retailerId: 'sku-2', quantity: 1, price: 5 },
    ]);
    await expectAppError(
      change(other.id, { status: 'fulfilled' }),
      'conflict',
      /^The order cannot move to fulfilled from its status\. This order's status is received\.$/,
    );
    expect(await versionOf(order.id)).toBe(versionBefore + 1);
    expect(await versionOf(other.id)).toBe(1);

    // Fulfilled from confirmed, after which nothing moves it; cancelled from received, for good.
    expect((await change(order.id, { status: 'fulfilled' })).status).toBe('fulfilled');
    await expectAppError(
      change(order.id, { status: 'cancelled' }),
      'conflict',
      /status is fulfilled\.$/,
    );
    expect(
      (await change(other.id, { status: 'cancelled', expectedStatus: 'received' })).status,
    ).toBe('cancelled');
    await expectAppError(
      change(other.id, { status: 'confirmed' }),
      'conflict',
      /status is cancelled\.$/,
    );

    // Payment statuses are Razorpay's: an order waiting for payment is left to members, who cancel
    // its Payment Link; a paid one is fulfilled, never cancelled.
    const waiting = await sendCart(c, '919811100723', [
      { retailerId: 'sku-3', quantity: 1, price: 7 },
    ]);
    const paid = await sendCart(c, '919811100724', [
      { retailerId: 'sku-4', quantity: 2, price: 9 },
    ]);
    await fx.query(`UPDATE app.commerce_orders SET status = 'awaiting_payment' WHERE id = $1`, [
      waiting.id,
    ]);
    await fx.query(
      `UPDATE app.commerce_orders SET status = 'paid', paid_at = now() WHERE id = $1`,
      [paid.id],
    );
    for (const status of ['confirmed', 'fulfilled', 'cancelled']) {
      await expectAppError(
        change(waiting.id, { status }),
        'conflict',
        /members cancel its Payment Link in the app first\. This order's status is awaiting_payment\.$/,
      );
    }
    await expectAppError(change(paid.id, { status: 'cancelled' }), 'conflict', /status is paid\.$/);
    const fulfilled = await change(paid.id, { status: 'fulfilled', expectedStatus: 'paid' });
    expect([fulfilled.status, fulfilled.paidAt]).toEqual(['fulfilled', expect.any(String)]);
    expect(await events()).toEqual([
      [order.id, 'received', 'confirmed'],
      [order.id, 'confirmed', 'fulfilled'],
      [other.id, 'received', 'cancelled'],
      [waiting.id, 'received', 'awaiting_payment'],
      [paid.id, 'received', 'paid'],
      [paid.id, 'paid', 'fulfilled'],
    ]);
  });

  it('need orders.write, an active company, Commerce in the plan and the company’s own order (ADR-168)', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const writer = await apiKey(c, ['orders.write']);
    const order = await sendCart(c, '919811100731', [
      { retailerId: 'sku-1', quantity: 1, price: 19.99 },
    ]);
    const theirs = await sendCart(other, '919811100732', [
      { retailerId: 'sku-1', quantity: 1, price: 19.99 },
    ]);
    const confirm = { status: 'confirmed' };
    const statusOf = async (orderId: string) =>
      (
        await fx.query<{ status: string }>('SELECT status FROM app.commerce_orders WHERE id = $1', [
          orderId,
        ])
      )[0]!.status;

    // Another company's order and one that does not exist are not found, and nothing changes.
    await expectAppError(apiUpdateOrder(deps(), writer.ctx, theirs.id, confirm), 'not_found');
    await expectAppError(apiUpdateOrder(deps(), writer.ctx, uuidv7(), confirm), 'not_found');
    expect(await statusOf(theirs.id)).toBe('received');

    // A key that only reads orders, or one of a suspended company, changes none.
    const reader = await apiKey(c, ['orders.read']);
    await expectAppError(
      apiUpdateOrder(deps(), reader.ctx, order.id, confirm),
      'forbidden',
      /orders\.write/,
    );
    const suspended = {
      ...writer.ctx,
      tenant: { ...writer.ctx.tenant, status: 'suspended' as const },
    };
    await expectAppError(apiUpdateOrder(deps(), suspended, order.id, confirm), 'tenant_suspended');

    // A plan without Commerce changes no orders; with it again, it does.
    await onPlan(c, []);
    const error = await expectAppError(
      apiUpdateOrder(deps(), writer.ctx, order.id, confirm),
      'forbidden',
      /does not include Commerce/,
    );
    expect(isAppError(error) && error.details).toEqual({ apiReason: 'not_in_plan' });
    expect(await statusOf(order.id)).toBe('received');
    await onPlan(c, ['commerce']);
    expect((await apiUpdateOrder(deps(), writer.ctx, order.id, confirm)).status).toBe('confirmed');

    // Granting the scope needs inbox.reply, which members change orders with.
    const owner = await fx.ctx(c, c.owner);
    const narrower: TenantContext = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((p) => p !== 'inbox.reply')),
    };
    await expectAppError(
      keys.create(narrower, { name: 'Orders', scopes: ['orders.write'], expiresInDays: 30 }),
      'forbidden',
      /Confirm, fulfil and cancel WhatsApp orders/,
    );
  });
});

describe('CRM pipelines and deals (ADR-253)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
  const contacts = () => createContactsService({ db: fx.dbs.app, clock: systemClock });
  let phones = 0;
  /** A contact with a number of its own (98 and eight digits: the clock and a counter). */
  const contactOf = async (owner: TenantContext, name: string) => {
    phones += 1;
    const digits = `${String(Date.now() % 1_000_000).padStart(6, '0')}${String(phones % 100).padStart(2, '0')}`;
    return (await contacts().createContact(owner, { displayName: name, phone: `+9198${digits}` }))
      .id;
  };
  /** A pipeline of the company and its active stages, as the CRM settings list them. */
  async function pipelineOf(
    owner: TenantContext,
    name: string,
    currency: string,
    stages: unknown[],
  ) {
    const { id } = await crm().createPipeline(owner, { name, currency, stages });
    const [pipeline] = (await crm().listPipelines(owner)).filter((p) => p.id === id);
    return { id, stages: pipeline!.stages.map((s) => s.id) };
  }

  it('list pipelines with their stages and deals newest first on exact pages, filtered, and one by id', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const theirOwner = await fx.ctx(other, other.owner);
    const reader = await apiKey(c, ['deals.read'], 'Deal sync');
    const sales = await pipelineOf(owner, 'Sales', 'INR', [
      'New',
      { name: 'Qualified', winPercent: 40 },
      'Proposal',
    ]);
    const renewals = await pipelineOf(owner, 'Renewals', 'USD', ['Due']);
    const theirs = await pipelineOf(theirOwner, 'Theirs', 'INR', ['Open']);
    const asha = await contactOf(owner, 'Asha');
    const ravi = await contactOf(owner, 'Ravi');
    const first = await crm().createDeal(owner, {
      contactId: asha,
      pipelineId: sales.id,
      stageId: sales.stages[0],
      title: 'Annual plan',
      value: '1500.50',
      ownerMembershipId: agent.membership.id,
      expectedCloseOn: '2026-12-15',
    });
    const second = await crm().createDeal(owner, {
      contactId: ravi,
      pipelineId: sales.id,
      stageId: sales.stages[1],
      title: 'Pilot',
    });
    const third = await crm().createDeal(owner, {
      contactId: asha,
      pipelineId: renewals.id,
      stageId: renewals.stages[0],
      title: 'Renewal',
      value: '200',
    });
    const theirDeal = await crm().createDeal(theirOwner, {
      contactId: await contactOf(theirOwner, 'Mira'),
      pipelineId: theirs.id,
      stageId: theirs.stages[0],
      title: 'Theirs',
    });

    // Pipelines oldest first, a page at a time, each with its stages in board order; never
    // another company's.
    const page = await apiListPipelines(deps(), reader.ctx, { limit: '1' });
    expect(page.data.map((p) => p.id)).toEqual([sales.id]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const rest = await apiListPipelines(deps(), reader.ctx, { cursor: page.nextCursor });
    expect(rest.data.map((p) => p.id)).toEqual([renewals.id]);
    expect(rest.nextCursor).toBeNull();
    expect(page.data[0]).toEqual({
      id: sales.id,
      name: 'Sales',
      currency: 'INR',
      position: expect.any(Number),
      archived: false,
      stages: [
        {
          id: sales.stages[0],
          name: 'New',
          position: expect.any(Number),
          archived: false,
          winPercent: null,
        },
        {
          id: sales.stages[1],
          name: 'Qualified',
          position: expect.any(Number),
          archived: false,
          winPercent: 40,
        },
        {
          id: sales.stages[2],
          name: 'Proposal',
          position: expect.any(Number),
          archived: false,
          winPercent: null,
        },
      ],
      createdAt: expect.any(String),
    });

    // Deals newest first, two to a page and the last on the next; another company's never.
    const list = (query: Record<string, string | null | undefined>) =>
      apiListDeals(deps(), reader.ctx, query);
    const deals = await list({ limit: '2' });
    expect(deals.data.map((d) => d.id)).toEqual([third.id, second.id]);
    const last = await list({ limit: '2', cursor: deals.nextCursor });
    expect(last.data.map((d) => d.id)).toEqual([first.id]);
    expect(last.nextCursor).toBeNull();

    // The deal as the board shows it: the value in minor units of the pipeline's currency, ids only.
    const [stored] = await fx.query<{ created_at: Date; stage_entered_at: Date }>(
      'SELECT created_at, stage_entered_at FROM app.crm_deals WHERE id = $1',
      [first.id],
    );
    expect(last.data[0]).toEqual({
      id: first.id,
      title: 'Annual plan',
      pipelineId: sales.id,
      stageId: sales.stages[0],
      status: 'open',
      valueMinor: 150_050,
      currency: 'INR',
      contactId: asha,
      conversationId: null,
      ownerId: agent.membership.id,
      expectedCloseOn: '2026-12-15',
      stageEnteredAt: stored!.stage_entered_at.toISOString(),
      lostReason: null,
      closedAt: null,
      createdAt: stored!.created_at.toISOString(),
      updatedAt: expect.any(String),
    });
    expect(await apiGetDeal(deps(), reader.ctx, first.id)).toEqual(last.data[0]);
    expect((await apiGetDeal(deps(), reader.ctx, third.id)).currency).toBe('USD');
    expect(deals.data[1]).toMatchObject({ valueMinor: null, ownerId: null, expectedCloseOn: null });

    // Filters, alone and together.
    const ids = async (query: Record<string, string>) => (await list(query)).data.map((d) => d.id);
    expect(await ids({ pipelineId: sales.id })).toEqual([second.id, first.id]);
    expect(await ids({ stageId: sales.stages[1]! })).toEqual([second.id]);
    expect(await ids({ contactId: asha })).toEqual([third.id, first.id]);
    expect(await ids({ contactId: asha, pipelineId: sales.id })).toEqual([first.id]);
    expect(await ids({ ownerId: agent.membership.id })).toEqual([first.id]);
    expect(await ids({ ownerId: 'none' })).toEqual([third.id, second.id]);

    // A member closes the second deal as lost: it is found by its status, with its reason, and
    // as changed since; a closed deal keeps its stage.
    const before = new Date(Date.now() - 1_000).toISOString();
    await crm().closeDeal(owner, {
      id: second.id,
      expectedVersion: 1,
      outcome: 'lost',
      lostReason: 'Chose another supplier',
    });
    const lost = await list({ status: 'lost' });
    expect(lost.data.map((d) => [d.id, d.stageId, d.lostReason])).toEqual([
      [second.id, sales.stages[1], 'Chose another supplier'],
    ]);
    expect(lost.data[0]?.closedAt).toEqual(expect.any(String));
    expect(await ids({ status: 'open' })).toEqual([third.id, first.id]);
    expect(await ids({ updatedSince: before })).toContain(second.id);
    expect(await ids({ updatedSince: new Date(Date.now() + 60_000).toISOString() })).toEqual([]);

    // An archived pipeline is still listed, and its closed deals still read.
    await crm().closeDeal(owner, { id: third.id, expectedVersion: 1, outcome: 'won' });
    const [renewal] = (await crm().listPipelines(owner)).filter((p) => p.id === renewals.id);
    await crm().archivePipeline(owner, { id: renewals.id, expectedVersion: renewal!.version });
    const all = await apiListPipelines(deps(), reader.ctx, {});
    expect(all.data.map((p) => [p.id, p.archived])).toEqual([
      [sales.id, false],
      [renewals.id, true],
    ]);
    expect((await apiGetDeal(deps(), reader.ctx, third.id)).status).toBe('won');

    // Another company's deal is not found by its id; nor is one that does not exist.
    await expectAppError(apiGetDeal(deps(), reader.ctx, theirDeal.id), 'not_found');
    await expectAppError(apiGetDeal(deps(), reader.ctx, uuidv7()), 'not_found');
  });

  it('keep an erased contact’s deals as erasure leaves them, and need the scope and the CRM in the plan', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const reader = await apiKey(c, ['deals.read']);
    const sales = await pipelineOf(owner, 'Sales', 'INR', ['New']);
    const contactId = await contactOf(owner, 'Asha');
    const deal = await crm().createDeal(owner, {
      contactId,
      pipelineId: sales.id,
      stageId: sales.stages[0],
      title: 'Annual plan for Asha',
    });
    await crm().closeDeal(owner, {
      id: deal.id,
      expectedVersion: 1,
      outcome: 'lost',
      lostReason: 'Asha moved abroad',
    });
    const changedAt = async () =>
      (
        await fx.query<{ at: string }>(
          'SELECT updated_at::text AS at FROM app.crm_deals WHERE id = $1',
          [deal.id],
        )
      )[0]!.at;
    const closedAt = await changedAt();
    const before = await apiGetDeal(deps(), reader.ctx, deal.id);
    await contacts().eraseContact(owner, { contactId, suppress: false });
    const kept = await apiGetDeal(deps(), reader.ctx, deal.id);
    expect([kept.title, kept.lostReason, kept.status, kept.contactId]).toEqual([
      'Deal (contact erased)',
      null,
      'lost',
      contactId,
    ]);
    // Erasure changes the deal, so a pass asking for changes since then sees it again.
    expect(await changedAt()).not.toBe(closedAt);
    expect(
      (await apiListDeals(deps(), reader.ctx, { updatedSince: before.updatedAt })).data,
    ).toEqual([kept]);

    // A key without the scope is refused before anything is read; reading is allowed while the
    // company is suspended, as every read is.
    const others = await apiKey(c, ['contacts.read', 'orders.read']);
    for (const read of [
      () => apiListPipelines(deps(), others.ctx, {}),
      () => apiListDeals(deps(), others.ctx, {}),
      () => apiGetDeal(deps(), others.ctx, deal.id),
    ]) {
      await expectAppError(read(), 'forbidden', /deals\.read/);
    }
    const suspended = {
      ...reader.ctx,
      tenant: { ...reader.ctx.tenant, status: 'suspended' as const },
    };
    expect((await apiListDeals(deps(), suspended, {})).data).toHaveLength(1);

    // A plan without the CRM reads no pipelines or deals; with it again, it does.
    await onPlan(c, []);
    for (const read of [
      () => apiListPipelines(deps(), reader.ctx, {}),
      () => apiListDeals(deps(), reader.ctx, {}),
      () => apiGetDeal(deps(), reader.ctx, deal.id),
    ]) {
      const error = await expectAppError(read(), 'forbidden', /does not include the CRM/);
      expect(isAppError(error) && error.details).toEqual({ apiReason: 'not_in_plan' });
    }
    await onPlan(c, ['crm']);
    expect((await apiGetDeal(deps(), reader.ctx, deal.id)).id).toBe(deal.id);
    expect((await apiListPipelines(deps(), reader.ctx, {})).data.map((p) => p.id)).toEqual([
      sales.id,
    ]);

    // Granting the scope needs crm.read, which members read the CRM with.
    const narrower: TenantContext = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((p) => p !== 'crm.read')),
    };
    await expectAppError(
      keys.create(narrower, { name: 'Deals', scopes: ['deals.read'], expiresInDays: 30 }),
      'forbidden',
      /Read CRM deals/,
    );
  });

  it('are created as members create them, as the key, and a retry answers the first (ADR-254)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const writer = await apiKey(c, ['deals.write'], 'Web shop');
    const reader = await apiKey(c, ['deals.read']);
    const sales = await pipelineOf(owner, 'Sales', 'INR', [
      'New',
      { name: 'Qualified', winPercent: 40 },
    ]);
    const asha = await contactOf(owner, 'Asha');
    const created = await apiCreateDeal(
      deps(),
      writer.ctx,
      {
        contactId: asha,
        pipelineId: sales.id,
        title: '  Website order  ',
        valueMinor: 49_900,
        ownerId: agent.membership.id,
        expectedCloseOn: '2026-11-30',
      },
      null,
    );
    expect([created.status, created.replayed]).toEqual([201, false]);
    const deal = (created.body as { data: ApiDeal }).data;
    // In the pipeline's first stage, as GET /deals/{id} reads it.
    expect(deal).toMatchObject({
      title: 'Website order',
      pipelineId: sales.id,
      stageId: sales.stages[0],
      status: 'open',
      valueMinor: 49_900,
      currency: 'INR',
      contactId: asha,
      conversationId: null,
      ownerId: agent.membership.id,
      expectedCloseOn: '2026-11-30',
      lostReason: null,
      closedAt: null,
    });
    expect(await apiGetDeal(deps(), reader.ctx, deal.id)).toEqual(deal);

    // Recorded as the key's: its creator, its page and timeline, and the audit log.
    const [row] = await fx.query<{
      created_by_api_key_id: string | null;
      created_by_membership_id: string | null;
    }>('SELECT created_by_api_key_id, created_by_membership_id FROM app.crm_deals WHERE id = $1', [
      deal.id,
    ]);
    expect(row).toEqual({ created_by_api_key_id: writer.id, created_by_membership_id: null });
    const shown = await crm().getDeal(owner, deal.id);
    expect([shown.createdBy, shown.createdByAutomation, shown.createdThroughApi]).toEqual([
      null,
      false,
      true,
    ]);
    expect(shown.timeline.map((a) => [a.kind, a.actor, a.data.apiKeyId])).toEqual([
      ['deal_created', null, writer.id],
    ]);
    const [audit] = await fx.query<{
      actor_type: string;
      actor_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_type, actor_id, metadata FROM app.audit_events
        WHERE action = 'crm.deal_created' AND subject_id = $1`,
      [deal.id],
    );
    expect(audit).toMatchObject({
      actor_type: 'api_key',
      actor_id: writer.id,
      metadata: { pipelineId: sales.id, stageId: sales.stages[0], source: 'api' },
    });

    // A stage of the pipeline; a retry with the same Idempotency-Key answers the first, once.
    const request = {
      contactId: asha,
      pipelineId: sales.id,
      stageId: sales.stages[1],
      title: 'Renewal',
    };
    const key = idem('deal-renewal-1', JSON.stringify(request));
    const first = await apiCreateDeal(deps(), writer.ctx, request, key);
    const again = await apiCreateDeal(deps(), writer.ctx, request, key);
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    expect(again.body).toEqual(first.body);
    expect((first.body as { data: ApiDeal }).data.stageId).toBe(sales.stages[1]);
    expect(
      await fx.query('SELECT id FROM app.crm_deals WHERE tenant_id = $1 AND title = $2', [
        c.tenant.id,
        'Renewal',
      ]),
    ).toHaveLength(1);
  });

  it('refuse what members are refused, and need the scope, an active company and the CRM (ADR-254)', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    const writer = await apiKey(c, ['deals.write']);
    const sales = await pipelineOf(owner, 'Sales', 'INR', ['New', 'Qualified', 'Proposal']);
    const renewals = await pipelineOf(owner, 'Renewals', 'INR', ['Due']);
    const theirs = await pipelineOf(await fx.ctx(other, other.owner), 'Theirs', 'INR', ['Open']);
    const asha = await contactOf(owner, 'Asha');
    const body = (input: Record<string, unknown> = {}) => ({
      contactId: asha,
      pipelineId: sales.id,
      title: 'Annual plan',
      ...input,
    });
    const create = (input: Record<string, unknown> = {}) =>
      apiCreateDeal(deps(), writer.ctx, body(input), null);
    const paths = (error: unknown) =>
      isAppError(error) ? (error.issues ?? []).map((i) => i.path) : [];

    // Another company's pipeline, another pipeline's stage, and owners who cannot use the CRM are
    // named; another company's or an unknown contact is not found.
    for (const [input, path] of [
      [{ pipelineId: theirs.id }, 'pipelineId'],
      [{ stageId: renewals.stages[0] }, 'stageId'],
      [{ ownerId: marketer.membership.id }, 'ownerId'],
      [{ ownerId: uuidv7() }, 'ownerId'],
    ] as const) {
      expect(paths(await expectAppError(create(input), 'validation_failed'))).toEqual([path]);
    }
    await expectAppError(create({ contactId: uuidv7() }), 'not_found', /Contact/);

    // A stage members removed and an archived pipeline are conflicts; an erased contact is gone.
    await crm().updatePipeline(owner, {
      id: sales.id,
      expectedVersion: 1,
      name: 'Sales',
      stages: [
        { id: sales.stages[0], name: 'New' },
        { id: sales.stages[1], name: 'Qualified' },
      ],
    });
    await expectAppError(create({ stageId: sales.stages[2] }), 'conflict', /removed/);
    await crm().archivePipeline(owner, { id: renewals.id, expectedVersion: 1 });
    await expectAppError(create({ pipelineId: renewals.id }), 'conflict', /archived/);
    const erased = await contactOf(owner, 'Ravi');
    await contacts().eraseContact(owner, { contactId: erased, suppress: false });
    await expectAppError(create({ contactId: erased }), 'not_found', /Contact/);
    const [none] = await fx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.crm_deals WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(none?.n).toBe(0);

    // A key that only reads deals, or one of a suspended company, creates none.
    const reader = await apiKey(c, ['deals.read']);
    await expectAppError(
      apiCreateDeal(deps(), reader.ctx, body(), null),
      'forbidden',
      /deals\.write/,
    );
    const suspended = {
      ...writer.ctx,
      tenant: { ...writer.ctx.tenant, status: 'suspended' as const },
    };
    await expectAppError(apiCreateDeal(deps(), suspended, body(), null), 'tenant_suspended');

    // A plan without the CRM creates none; with it again, the deal is created.
    await onPlan(c, []);
    const error = await expectAppError(create(), 'forbidden', /does not include the CRM/);
    expect(isAppError(error) && error.details).toEqual({ apiReason: 'not_in_plan' });
    await onPlan(c, ['crm']);
    expect((await create()).status).toBe(201);

    // Granting the scope needs crm.write, which members create deals with.
    const narrower: TenantContext = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((p) => p !== 'crm.write')),
    };
    await expectAppError(
      keys.create(narrower, { name: 'Deals', scopes: ['deals.write'], expiresInDays: 30 }),
      'forbidden',
      /Create CRM deals/,
    );
  });
});

describe('conversation reads (ADR-072)', () => {
  /** Every page of a listing, following `nextCursor`. */
  async function everyPage<T>(
    read: (cursor?: string) => Promise<{ data: T[]; nextCursor: string | null }>,
  ) {
    const pages: T[][] = [];
    let cursor: string | undefined;
    do {
      const page = await read(cursor);
      pages.push(page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && pages.length < 50);
    return pages;
  }

  /** PostgreSQL's time, to the microsecond. */
  async function databaseNow() {
    const [row] = await fx.query<{ now: string }>(
      `SELECT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
    );
    return row!.now;
  }

  it('need the conversations.read scope, which only members who read every conversation grant', async () => {
    const c = await fx.company();
    const without = await apiKey(c, ['contacts.read', 'messages.reply']);
    for (const read of [
      apiListConversations(deps(), without.ctx, {}),
      apiGetConversation(deps(), without.ctx, uuidv7()),
      apiListConversationMessages(deps(), without.ctx, uuidv7(), {}),
    ]) {
      await expectAppError(read, 'forbidden', /conversations\.read scope/);
    }

    const owner = await fx.ctx(c, c.owner);
    // A member who reads only the conversations assigned to them (as a narrower role would).
    const narrower: TenantContext = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((p) => p !== 'inbox.read_all')),
    };
    await expectAppError(
      keys.create(narrower, { name: 'Reader', scopes: ['conversations.read'], expiresInDays: 30 }),
      'forbidden',
      /Read conversations/,
    );
    // Every scope fits on one key.
    const all = await keys.create(owner, {
      name: 'Everything',
      scopes: [...API_SCOPE_KEYS],
      expiresInDays: 30,
    });
    const [row] = await fx.query<{ scopes: string[] }>(
      'SELECT scopes FROM app.api_keys WHERE id = $1',
      [all.id],
    );
    expect(row!.scopes).toEqual([...API_SCOPE_KEYS]);
    expect(row!.scopes).toContain('conversations.read');
  });

  it('list the company’s conversations newest first, filtered, on pages that never skip or repeat', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['conversations.read']);
    const second = await addNumber(c, 'active');
    const [secondNumber] = await fx.query<{ phone_number_id: string }>(
      'SELECT phone_number_id FROM app.channel_accounts WHERE id = $1',
      [second],
    );
    const waIds = ['919811100060', '919811100061', '919811100062', '919811100063'];
    for (const waId of waIds) await inbound(c, waId, [{ text: 'Hello' }]);
    await inbound(c, '919811100064', [{ text: 'Hello' }], secondNumber!.phone_number_id);
    const convs = await Promise.all([...waIds, '919811100064'].map((w) => conversationOf(c, w)));
    const [resolved, assigned, sameTime, wroteAgain, onSecond] = convs as [
      (typeof convs)[number],
      (typeof convs)[number],
      (typeof convs)[number],
      (typeof convs)[number],
      (typeof convs)[number],
    ];
    // Conversations created in one transaction (a campaign's batch) share their creation time to
    // the microsecond, which a cursor must keep apart.
    await fx.query(
      `UPDATE app.conversations SET created_at = '2026-09-28T10:00:00.123456Z'
        WHERE id = ANY($1::uuid[])`,
      [[assigned.id, sameTime.id, wroteAgain.id]],
    );
    const newestFirst = (
      await fx.query<{ id: string }>(
        'SELECT id FROM app.conversations WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC',
        [c.tenant.id],
      )
    ).map((r) => r.id);

    // Query values arrive as strings from the URL.
    const pages = await everyPage((cursor) =>
      apiListConversations(deps(), ctx, { limit: '2', ...(cursor ? { cursor } : {}) }),
    );
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat().map((x) => x.id)).toEqual(newestFirst);
    const onePerPage = await everyPage((cursor) =>
      apiListConversations(deps(), ctx, { limit: '1', ...(cursor ? { cursor } : {}) }),
    );
    expect(onePerPage.flat().map((x) => x.id)).toEqual(newestFirst);

    const ids = async (query: Record<string, string>) =>
      (await apiListConversations(deps(), ctx, query)).data.map((x) => x.id);
    const inOrder = (...wanted: { id: string }[]) =>
      newestFirst.filter((id) => wanted.some((w) => w.id === id));
    expect(await ids({ channelId: second })).toEqual([onSecond.id]);
    expect(await ids({ channelId: c.channelAccountId })).toEqual(
      inOrder(resolved, assigned, sameTime, wroteAgain),
    );
    expect(await ids({ contactId: sameTime.contact_id })).toEqual([sameTime.id]);
    expect(await ids({ contactId: uuidv7() })).toEqual([]);

    // A member resolves one conversation and assigns another; a contact writes again in a third.
    const since = await databaseNow();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await inbox().setStatus(owner, {
      conversationId: resolved.id,
      status: 'resolved',
      expectedVersion: resolved.version,
    });
    await inbox().assign(owner, {
      conversationId: assigned.id,
      membershipId: agent.membership.id,
      expectedVersion: assigned.version,
    });
    await inbound(c, waIds[3]!, [{ text: 'Any news?' }]);
    expect(await ids({ updatedSince: since })).toEqual(inOrder(resolved, assigned, wroteAgain));
    expect(await ids({ updatedSince: await databaseNow() })).toEqual([]);
    expect(await ids({ status: 'resolved' })).toEqual([resolved.id]);
    expect(await ids({ status: 'open' })).toEqual(
      inOrder(assigned, sameTime, wroteAgain, onSecond),
    );
    expect(await ids({ status: 'open', channelId: second })).toEqual([onSecond.id]);
    expect(await ids({ status: 'resolved', channelId: second })).toEqual([]);

    const listed = (await apiListConversations(deps(), ctx, {})).data;
    const [row] = await fx.query<{
      last_message_at: Date;
      last_inbound_at: Date;
      updated_at: Date;
    }>('SELECT last_message_at, last_inbound_at, updated_at FROM app.conversations WHERE id = $1', [
      assigned.id,
    ]);
    const shown = listed.find((x) => x.id === assigned.id);
    expect(shown).toEqual({
      id: assigned.id,
      contactId: assigned.contact_id,
      channelId: c.channelAccountId,
      status: 'open',
      assigned: true,
      assigneeId: agent.membership.id,
      teamId: null,
      unreadCount: 1,
      lastMessageAt: row!.last_message_at.toISOString(),
      lastInboundAt: row!.last_inbound_at.toISOString(),
      serviceWindowEndsAt: new Date(row!.last_inbound_at.getTime() + 24 * 3600_000).toISOString(),
      createdAt: '2026-09-28T10:00:00.123Z',
      updatedAt: row!.updated_at.toISOString(),
      resolvedAt: null,
      tags: [],
    });
    expect(await apiGetConversation(deps(), ctx, assigned.id)).toEqual(shown);
    expect(listed.find((x) => x.id === resolved.id)).toMatchObject({
      status: 'resolved',
      assigned: false,
      assigneeId: null,
      unreadCount: 0,
      resolvedAt: expect.any(String),
    });
  });

  it('read a conversation’s messages newest first, in the words the webhooks use', async () => {
    const c = await fx.company();
    const reader = await apiKey(c, ['conversations.read']);
    const replier = await apiKey(c, ['messages.reply'], 'Helpdesk');
    const owner = await fx.ctx(c, c.owner);
    await createCsatService({ db: fx.dbs.app, clock: systemClock }).updateCsatSettings(owner, {
      enabled: true,
      question: 'How did we do today?',
      labels: ['Great', 'Okay', 'Poor'],
    });
    const waId = '919811100070';
    await inbound(c, waId, [
      { text: 'Where is my order?' },
      {
        type: 'image',
        extra: {
          image: {
            id: 'media-1',
            mime_type: 'image/jpeg',
            sha256: 'c2hhMjU2',
            caption: 'The box arrived damaged',
          },
        },
      },
      { type: 'button', extra: { button: { text: 'Track order', payload: 'TRACK' } } },
      {
        type: 'interactive',
        extra: {
          interactive: {
            type: 'list_reply',
            list_reply: { id: 'size-m', title: 'Medium', description: 'Chest 40 in' },
          },
        },
      },
      { type: 'reaction', extra: { reaction: { message_id: 'wamid.earlier', emoji: '👍' } } },
      {
        type: 'location',
        extra: {
          location: { latitude: 12.97, longitude: 77.59, name: 'Home', address: 'MG Road' },
        },
      },
    ]);
    const conv = await conversationOf(c, waId);
    const agentReply = await queueTextMessage(deps(), owner, {
      conversationId: conv.id,
      text: 'Sorry about the box.',
      clientKey: `ck-${uuidv7()}`,
    });
    const tpl = await approvedTemplate(c, shippingUpdate);
    const template = await queueTemplateMessage(deps(), owner, {
      contactId: conv.contact_id,
      channelAccountId: c.channelAccountId,
      templateId: tpl.id,
      params: { header: [], body: ['Asha', 'A-1001'] },
      clientKey: `ck-${uuidv7()}`,
    });
    const reply = (text: string, key: string) =>
      apiSendMessage(deps(), replier.ctx, { type: 'text', to: `+${waId}`, text }, idem(key, key));
    const apiReply = (await reply('A replacement ships today.', 'c-1')).body.data as { id: string };
    const failing = (await reply('Here is the tracking link.', 'c-2')).body.data as { id: string };
    // Resolving sends the satisfaction survey, an interactive message from HyFib.
    await inbox().setStatus(owner, {
      conversationId: conv.id,
      status: 'resolved',
      expectedVersion: (await conversationOf(c, waId)).version,
    });
    const [survey] = await fx.query<{ message_id: string }>(
      'SELECT message_id FROM app.csat_surveys WHERE conversation_id = $1',
      [conv.id],
    );
    expect(await sendAll(c)).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'accepted']);
    // WhatsApp reports the template read and the second API reply failed.
    const wamid = new Map(
      (
        await fx.query<{ id: string; external_message_id: string }>(
          'SELECT id, external_message_id FROM app.messages WHERE id = ANY($1::uuid[])',
          [[template.messageId, failing.id]],
        )
      ).map((r) => [r.id, r.external_message_id]),
    );
    const t = Math.floor(Date.now() / 1000);
    await fx.deliver(
      fx.messagesBody(c, {
        statuses: [
          {
            id: wamid.get(template.messageId),
            status: 'read',
            timestamp: String(t),
            recipient_id: waId,
          },
          {
            id: wamid.get(failing.id),
            status: 'failed',
            timestamp: String(t),
            recipient_id: waId,
            errors: [{ code: 131026, title: 'Message undeliverable' }],
          },
        ],
      }),
    );
    // Internal notes are not messages.
    await inbox().addNote(owner, { conversationId: conv.id, body: 'Offer a refund if it recurs.' });

    const pages = await everyPage((cursor) =>
      apiListConversationMessages(deps(), reader.ctx, conv.id, {
        limit: '4',
        ...(cursor ? { cursor } : {}),
      }),
    );
    expect(pages.map((p) => p.length)).toEqual([4, 4, 3]);
    const read = pages.flat();
    // The taps and the reaction answer messages this conversation does not have.
    const base = {
      id: expect.any(String),
      conversationId: conv.id,
      reply: null,
      replyTo: null,
      mimeType: null,
      contentTooLarge: false,
      contactsLeftOut: 0,
      contacts: null,
      templateId: null,
      templateName: null,
      sentBy: null,
      apiKeyId: null,
      statusAt: expect.any(String),
      error: null,
      createdAt: expect.any(String),
    };
    const fromContact = (type: string, text: string, more: Record<string, unknown> = {}) => ({
      ...base,
      direction: 'inbound',
      type,
      text,
      status: 'received',
      ...more,
    });
    const toContact = (id: string, type: string, text: string, more: Record<string, unknown>) => ({
      ...base,
      id,
      direction: 'outbound',
      type,
      text,
      ...more,
    });
    expect([...read].reverse()).toEqual([
      fromContact('text', 'Where is my order?'),
      fromContact('image', 'The box arrived damaged', { mimeType: 'image/jpeg' }),
      fromContact('button', 'Track order', {
        reply: { id: 'TRACK', title: 'Track order', type: 'button', description: null },
      }),
      fromContact('interactive', 'Medium', {
        reply: { id: 'size-m', title: 'Medium', type: 'list', description: 'Chest 40 in' },
      }),
      fromContact('reaction', '👍'),
      fromContact('location', 'Home'),
      toContact(agentReply.messageId, 'text', 'Sorry about the box.', {
        sentBy: 'agent',
        status: 'accepted',
      }),
      toContact(template.messageId, 'template', 'Hi Asha, your order A-1001 has shipped.', {
        templateId: tpl.id,
        templateName: tpl.name,
        sentBy: 'agent',
        status: 'read',
        statusAt: new Date(t * 1000).toISOString(),
      }),
      toContact(apiReply.id, 'text', 'A replacement ships today.', {
        sentBy: 'api',
        apiKeyId: replier.id,
        status: 'accepted',
      }),
      toContact(failing.id, 'text', 'Here is the tracking link.', {
        sentBy: 'api',
        apiKeyId: replier.id,
        status: 'failed',
        error: { code: '131026', title: 'Message undeliverable' },
      }),
      toContact(survey!.message_id, 'interactive', 'How did we do today?', {
        sentBy: 'system',
        status: 'accepted',
      }),
    ]);

    // Messages saved in one transaction share their creation time; pages keep them apart too.
    const firstThree = read.slice(-3).map((m) => m.id);
    await fx.query(
      `UPDATE app.messages SET created_at = '2026-09-28T10:00:00.654321Z'
        WHERE id = ANY($1::uuid[])`,
      [firstThree],
    );
    const newestFirst = (
      await fx.query<{ id: string }>(
        'SELECT id FROM app.messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC',
        [conv.id],
      )
    ).map((r) => r.id);
    const onePerPage = await everyPage((cursor) =>
      apiListConversationMessages(deps(), reader.ctx, conv.id, {
        limit: '1',
        ...(cursor ? { cursor } : {}),
      }),
    );
    expect(onePerPage.flat().map((m) => m.id)).toEqual(newestFirst);
    expect(newestFirst).toHaveLength(11);
  });

  it('say which messages were too large to keep and how many contacts a card left out (ADR-132)', async () => {
    const c = await fx.company();
    const reader = await apiKey(c, ['conversations.read']);
    const waId = '919811100072';
    // A system update larger than a message may hold, kept as too large (ADR-131).
    const wide = '𝒳'.repeat(2048); // 4,096 code units, 8 KB as UTF-8
    const system = Object.fromEntries(
      [
        'type',
        'body',
        'user_id',
        'parent_user_id',
        'previous_user_id',
        'previous_parent_user_id',
        'wa_id',
        'new_wa_id',
      ].map((key) => [key, wide]),
    );
    // A contact card of 25 contacts of about 4 KB, which keeps the first that fit.
    const card = Array.from({ length: 25 }, (_, i) => ({
      name: { formatted_name: `Contact ${i}` },
      addresses: [{ street: 'x'.repeat(4_000), city: 'Pune' }],
    }));
    await inbound(c, waId, [
      { text: 'Hello' },
      { type: 'system', extra: { system } },
      { type: 'contacts', extra: { contacts: card } },
    ]);
    const conv = await conversationOf(c, waId);
    const [stored] = await fx.query<{ omitted: number }>(
      `SELECT (content->>'omittedContacts')::int AS omitted FROM app.messages
        WHERE conversation_id = $1 AND type = 'contacts'`,
      [conv.id],
    );
    expect(stored!.omitted).toBeGreaterThan(0);

    const { data } = await apiListConversationMessages(deps(), reader.ctx, conv.id, {});
    const byType = new Map(data.map((m) => [m.type, m]));
    expect(byType.get('system')).toMatchObject({
      text: null,
      reply: null,
      mimeType: null,
      contentTooLarge: true,
      contactsLeftOut: 0,
    });
    expect(byType.get('contacts')).toMatchObject({
      text: null,
      contentTooLarge: false,
      contactsLeftOut: stored!.omitted,
    });
    expect(byType.get('text')).toMatchObject({
      text: 'Hello',
      contentTooLarge: false,
      contactsLeftOut: 0,
    });
    // The feed across conversations (this company has only this one) says the same.
    const feed = await apiListMessages(deps(), reader.ctx, {});
    expect(feed.data.map((m) => [m.type, m.contentTooLarge, m.contactsLeftOut]).sort()).toEqual(
      [
        ['contacts', false, stored!.omitted],
        ['system', true, 0],
        ['text', false, 0],
      ].sort(),
    );
  });

  it('give the contacts a card shares as WhatsApp gave them, wherever messages are read (ADR-196)', async () => {
    const c = await fx.company();
    const reader = await apiKey(c, ['conversations.read']);
    const waId = '919811101961';
    // Meta's example of a received card (research M-193), and a contact with only a name and an
    // email address.
    const lucia = {
      name: { first_name: 'Lucía', last_name: 'Gómez', formatted_name: 'Lucía Gómez' },
      org: { company: 'Google' },
      phones: [{ phone: '+1 (983) 555-2319', wa_id: '19835552319', type: 'MOBILE' }],
    };
    const ravi = { name: { formatted_name: 'Ravi' }, emails: [{ email: 'ravi@example.com' }] };
    await inbound(c, waId, [
      { type: 'contacts', extra: { contacts: [lucia, ravi] } },
      { text: 'My colleagues' },
    ]);
    const conv = await conversationOf(c, waId);
    const none = { middleName: null, prefix: null, suffix: null };
    const card = [
      {
        name: { formattedName: 'Lucía Gómez', firstName: 'Lucía', lastName: 'Gómez', ...none },
        phones: [{ phone: '+1 (983) 555-2319', waId: '19835552319', type: 'MOBILE' }],
        emails: [],
        urls: [],
        addresses: [],
        org: { company: 'Google', department: null, title: null },
        birthday: null,
      },
      {
        name: { formattedName: 'Ravi', firstName: null, lastName: null, ...none },
        phones: [],
        emails: [{ email: 'ravi@example.com', type: null }],
        urls: [],
        addresses: [],
        org: null,
        birthday: null,
      },
    ];
    // The conversation, the feed across conversations and the change feed give the same contacts;
    // other messages give none.
    const { data } = await apiListConversationMessages(deps(), reader.ctx, conv.id, {});
    expect(data.map((m) => [m.type, m.text, m.contactsLeftOut, m.contacts])).toEqual(
      expect.arrayContaining([
        ['contacts', null, 0, card],
        ['text', 'My colleagues', 0, null],
      ]),
    );
    expect(data).toHaveLength(2);
    const feed = await apiListMessages(deps(), reader.ctx, {});
    expect(feed.data.find((m) => m.type === 'contacts')?.contacts).toEqual(card);
    const changes = await apiMessageChanges(
      { db: fx.dbs.app, keyring: fx.keyring },
      reader.ctx,
      {},
    );
    expect(changes.data.map((change) => change.message?.contacts ?? null)).toEqual(
      expect.arrayContaining([card, null]),
    );
  });

  it('leave out erased contacts and other companies, and check what they are asked', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const mine = await apiKey(c, ['conversations.read']);
    const theirs = await apiKey(other, ['conversations.read']);
    await inbound(c, '919811100080', [{ text: 'Hello' }]);
    await inbound(c, '919811100081', [{ text: 'Please forget me' }]);
    const kept = await conversationOf(c, '919811100080');
    const erased = await conversationOf(c, '919811100081');
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(
      await fx.ctx(c, c.owner),
      { contactId: erased.contact_id, suppress: false },
    );

    const ids = async (ctx: ApiContext, query: Record<string, string> = {}) =>
      (await apiListConversations(deps(), ctx, query)).data.map((x) => x.id);
    expect(await ids(mine.ctx)).toEqual([kept.id]);
    expect(await ids(mine.ctx, { contactId: erased.contact_id })).toEqual([]);
    await expectAppError(apiGetConversation(deps(), mine.ctx, erased.id), 'not_found');
    await expectAppError(apiListConversationMessages(deps(), mine.ctx, erased.id, {}), 'not_found');

    // Another company's key finds nothing of this company.
    expect(await ids(theirs.ctx)).toEqual([]);
    expect(await ids(theirs.ctx, { contactId: kept.contact_id })).toEqual([]);
    expect(await ids(theirs.ctx, { channelId: c.channelAccountId })).toEqual([]);
    await expectAppError(apiGetConversation(deps(), theirs.ctx, kept.id), 'not_found');
    await expectAppError(apiListConversationMessages(deps(), theirs.ctx, kept.id, {}), 'not_found');

    // Reading continues while the company is suspended or its plan has ended.
    for (const status of ['suspended', 'restricted'] as const) {
      const ctx = { ...mine.ctx, tenant: { ...mine.ctx.tenant, status } };
      expect(await ids(ctx)).toEqual([kept.id]);
      expect((await apiListConversationMessages(deps(), ctx, kept.id, {})).data).toHaveLength(1);
    }

    // Ids and queries are checked.
    await expectAppError(apiGetConversation(deps(), mine.ctx, 'not-a-uuid'), 'not_found');
    await expectAppError(
      apiListConversationMessages(deps(), mine.ctx, 'not-a-uuid', {}),
      'not_found',
    );
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { status: 'closed' },
      { contactId: 'x' },
      { channelId: 'x' },
      { updatedSince: 'yesterday' },
      { cursor: 'not-a-cursor' },
      { assignee: 'me' },
    ]) {
      await expectAppError(apiListConversations(deps(), mine.ctx, query), 'validation_failed');
    }
    for (const query of [{ limit: '101' }, { cursor: 'not-a-cursor' }, { status: 'open' }]) {
      await expectAppError(
        apiListConversationMessages(deps(), mine.ctx, kept.id, query),
        'validation_failed',
      );
    }
  });
});

describe('conversation status (ADR-075)', () => {
  const resolve = { status: 'resolved' };

  async function conversationRow(id: string) {
    const [row] = await fx.query<{
      status: string;
      resolved_at: Date | null;
      unread_count: number;
      version: number;
      updated_at: Date;
    }>(
      'SELECT status, resolved_at, unread_count, version, updated_at FROM app.conversations WHERE id = $1',
      [id],
    );
    if (!row) throw new Error('no conversation');
    return row;
  }

  /** The audit entries of status changes of a conversation, oldest first. */
  const statusAudit = (c: Company, id: string) =>
    fx.query<{
      actor_type: string;
      actor_id: string | null;
      correlation_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_type, actor_id, correlation_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'conversation.status_changed' AND subject_id = $2
        ORDER BY occurred_at, id`,
      [c.tenant.id, id],
    );

  it('need the conversations.write scope, which only members who manage the whole inbox grant', async () => {
    const c = await fx.company();
    const reader = await apiKey(c, ['conversations.read', 'messages.reply']);
    await expectAppError(
      apiUpdateConversation(deps(), reader.ctx, uuidv7(), resolve),
      'forbidden',
      /conversations\.write scope/,
    );
    const owner = await fx.ctx(c, c.owner);
    // A member who does not supervise the inbox (as a narrower role would not).
    const narrower: TenantContext = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((p) => p !== 'inbox.supervise')),
    };
    await expectAppError(
      keys.create(narrower, { name: 'Closer', scopes: ['conversations.write'], expiresInDays: 30 }),
      'forbidden',
      /Resolve, reopen, assign and add notes to conversations/,
    );
    const granted = await keys.create(owner, {
      name: 'Closer',
      scopes: ['conversations.write'],
      expiresInDays: 30,
    });
    const [row] = await fx.query<{ scopes: string[] }>(
      'SELECT scopes FROM app.api_keys WHERE id = $1',
      [granted.id],
    );
    expect(row!.scopes).toEqual(['conversations.write']);
  });

  it('resolve and reopen as the inbox does, audited as the key, without a survey', async () => {
    const c = await fx.company();
    const { ctx, id: keyId } = await apiKey(c, ['conversations.write'], 'Helpdesk');
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await createCsatService({ db: fx.dbs.app, clock: systemClock }).updateCsatSettings(owner, {
      enabled: true,
      question: 'How did we do today?',
      labels: ['Great', 'Okay', 'Poor'],
    });
    await createWebhooksService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egressPolicy: { allowLoopbackForTests: true },
    }).create(owner, {
      url: 'https://hooks.receiver.test/status',
      eventTypes: ['conversation.status_changed'],
    });
    const waId = '919811100090';
    await inbound(c, waId, [{ text: 'Where is my order?' }, { text: 'Hello?' }]);
    const conv = await conversationOf(c, waId);
    await inbox().assign(owner, {
      conversationId: conv.id,
      membershipId: agent.membership.id,
      expectedVersion: conv.version,
    });
    const before = await conversationRow(conv.id);
    expect(before).toMatchObject({ status: 'open', resolved_at: null, unread_count: 2 });

    const resolved = await apiUpdateConversation(deps(), ctx, conv.id, resolve);
    const after = await conversationRow(conv.id);
    expect(after).toMatchObject({
      status: 'resolved',
      resolved_at: expect.any(Date),
      unread_count: 0,
      version: before.version + 1,
    });
    expect(resolved).toEqual(
      await apiGetConversation(deps(), (await apiKey(c, ['conversations.read'])).ctx, conv.id),
    );
    expect(resolved).toMatchObject({
      id: conv.id,
      status: 'resolved',
      assigned: true,
      unreadCount: 0,
      resolvedAt: after.resolved_at!.toISOString(),
      updatedAt: after.updated_at.toISOString(),
    });
    expect(await statusAudit(c, conv.id)).toEqual([
      {
        actor_type: 'api_key',
        actor_id: keyId,
        correlation_id: ctx.requestId,
        metadata: { from: 'open', to: 'resolved', source: 'api' },
      },
    ]);
    // The wait for a reply and the case end without crediting a member; the case keeps the
    // assignee, and no survey is sent although surveys are on.
    expect(
      await fx.query(
        'SELECT end_reason, ended_by_membership_id FROM app.conversation_turns WHERE conversation_id = $1',
        [conv.id],
      ),
    ).toEqual([{ end_reason: 'resolved', ended_by_membership_id: null }]);
    const cases = () =>
      fx.query<{ resolved: boolean; resolved_by: string | null; assigned: string | null }>(
        `SELECT resolved_at IS NOT NULL AS resolved, resolved_by_membership_id AS resolved_by,
                assigned_membership_id AS assigned
           FROM app.conversation_cases WHERE conversation_id = $1 ORDER BY opened_at, id`,
        [conv.id],
      );
    expect(await cases()).toEqual([
      { resolved: true, resolved_by: null, assigned: agent.membership.id },
    ]);
    const surveys = await fx.query('SELECT id FROM app.csat_surveys WHERE conversation_id = $1', [
      conv.id,
    ]);
    expect(surveys).toEqual([]);
    // The inbox hears of it live, and the webhook event is captured once.
    expect(
      await fx.query(
        `SELECT assigned_membership_id, payload FROM app.tenant_events
          WHERE conversation_id = $1 AND type = 'conversation.status' ORDER BY id`,
        [conv.id],
      ),
    ).toEqual([{ assigned_membership_id: agent.membership.id, payload: { status: 'resolved' } }]);
    const events = () =>
      fx.query<{ status: string; detail: Record<string, unknown> }>(
        `SELECT status, detail FROM app.webhook_events
          WHERE conversation_id = $1 AND type = 'conversation.status_changed' ORDER BY created_at, id`,
        [conv.id],
      );
    expect(await events()).toEqual([{ status: 'resolved', detail: { previousStatus: 'open' } }]);

    // The status it already has changes nothing, so a retry does no harm.
    expect(await apiUpdateConversation(deps(), ctx, conv.id, resolve)).toEqual(resolved);
    expect(await conversationRow(conv.id)).toEqual(after);
    expect(await statusAudit(c, conv.id)).toHaveLength(1);
    expect(await events()).toHaveLength(1);

    // Reopened: a new case opens and the conversation keeps its assignee.
    const reopened = await apiUpdateConversation(deps(), ctx, conv.id, { status: 'open' });
    expect(reopened).toMatchObject({
      status: 'open',
      assigned: true,
      unreadCount: 0,
      resolvedAt: null,
    });
    expect((await conversationRow(conv.id)).version).toBe(after.version + 1);
    expect((await statusAudit(c, conv.id)).map((a) => a.metadata)).toEqual([
      { from: 'open', to: 'resolved', source: 'api' },
      { from: 'resolved', to: 'open', source: 'api' },
    ]);
    expect(await cases()).toEqual([
      { resolved: true, resolved_by: null, assigned: agent.membership.id },
      { resolved: false, resolved_by: null, assigned: null },
    ]);
    expect((await events()).map((e) => e.status)).toEqual(['resolved', 'open']);
    expect(await apiUpdateConversation(deps(), ctx, conv.id, { status: 'open' })).toEqual(reopened);

    // Resolved again, the contact's next message opens it as after a member's resolve.
    await apiUpdateConversation(deps(), ctx, conv.id, resolve);
    await inbound(c, waId, [{ text: 'One more thing' }]);
    expect(await conversationRow(conv.id)).toMatchObject({
      status: 'open',
      resolved_at: null,
      unread_count: 1,
    });
  });

  it('change the status once when requests come at once, locked like a member’s change', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['conversations.write']);
    await inbound(c, '919811100091', [{ text: 'Hello' }]);
    const conv = await conversationOf(c, '919811100091');
    const holder = await fx.dbs.adminPool.connect();
    let requests: Promise<ApiConversation>[] | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM app.conversations WHERE id = $1 FOR UPDATE', [conv.id]);
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      requests = [1, 2].map(() => apiUpdateConversation(deps(), ctx, conv.id, resolve));
      // Both wait behind the row lock (the second behind the first), then run one after the other.
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            `WITH RECURSIVE blocked (pid) AS (
               SELECT a.pid FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))
               UNION
               SELECT a.pid FROM pg_stat_activity a
                 JOIN blocked b ON b.pid = ANY (pg_blocking_pids(a.pid)))
             SELECT count(*)::int AS n FROM blocked`,
            [lock!.pid],
          );
          if (waiting!.n < 2) throw new Error('the requests are not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    const results = await Promise.all(requests ?? []);
    expect(results.map((r) => r.status)).toEqual(['resolved', 'resolved']);
    expect(results[0]).toEqual(results[1]);
    expect(await statusAudit(c, conv.id)).toHaveLength(1);
    expect((await conversationRow(conv.id)).version).toBe(conv.version + 1);
  });

  it('leave out erased contacts and other companies, and check what they are asked', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const mine = await apiKey(c, ['conversations.write']);
    const theirs = await apiKey(other, ['conversations.write']);
    await inbound(c, '919811100092', [{ text: 'Hello' }]);
    await inbound(c, '919811100093', [{ text: 'Please forget me' }]);
    const kept = await conversationOf(c, '919811100092');
    const erased = await conversationOf(c, '919811100093');
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(
      await fx.ctx(c, c.owner),
      { contactId: erased.contact_id, suppress: false },
    );
    const erasedBefore = await conversationRow(erased.id);
    const keptBefore = await conversationRow(kept.id);

    await expectAppError(apiUpdateConversation(deps(), mine.ctx, erased.id, resolve), 'not_found');
    await expectAppError(apiUpdateConversation(deps(), theirs.ctx, kept.id, resolve), 'not_found');
    // Nothing changes while the company is suspended or its plan has ended.
    for (const status of ['suspended', 'restricted'] as const) {
      const ctx = { ...mine.ctx, tenant: { ...mine.ctx.tenant, status } };
      await expectAppError(
        apiUpdateConversation(deps(), ctx, kept.id, resolve),
        'tenant_suspended',
      );
    }
    // Ids and bodies are checked.
    for (const id of ['not-a-uuid', uuidv7()]) {
      await expectAppError(apiUpdateConversation(deps(), mine.ctx, id, resolve), 'not_found');
    }
    for (const body of [
      {},
      { status: 'pending' },
      { status: 'closed' },
      { status: 'resolved', assigned: false },
      null,
      'resolved',
    ]) {
      await expectAppError(
        apiUpdateConversation(deps(), mine.ctx, kept.id, body),
        'validation_failed',
      );
    }
    expect(await conversationRow(erased.id)).toEqual(erasedBefore);
    expect(await conversationRow(kept.id)).toEqual(keptBefore);
    expect(await statusAudit(c, erased.id)).toEqual([]);
    expect(await statusAudit(c, kept.id)).toEqual([]);
  });
});

describe('assigning conversations (ADR-093)', () => {
  const teams = () => createTeamsService({ db: fx.dbs.app, clock: systemClock });
  const tenancy = () =>
    createTenancyService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      jobs: fx.jobs(),
      signer: fx.signer,
      appBaseUrl: 'http://localhost:3000',
      invitationTtlHours: 72,
    });

  /** A member with one role, joined through an invitation. */
  async function joined(c: Company, role: string, name: string) {
    const user = await createUser(fx.dbs, { name });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
    await acceptInvitation(fx.dbs, user, token);
    return fx.ctx(c, user);
  }

  async function conversationRow(id: string) {
    const [row] = await fx.query<{
      assigned: string | null;
      team_id: string | null;
      status: string;
      version: number;
    }>(
      `SELECT assigned_membership_id AS assigned, team_id, status, version
         FROM app.conversations WHERE id = $1`,
      [id],
    );
    if (!row) throw new Error('no conversation');
    return row;
  }

  /** The audit entries of a conversation's assignee, team, status and routing, oldest first. */
  const changes = (c: Company, id: string) =>
    fx.query<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      correlation_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, actor_type, actor_id, correlation_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2
          AND action IN ('conversation.assigned', 'conversation.team_changed',
                         'conversation.status_changed', 'conversation.routed')
        ORDER BY occurred_at, id`,
      [c.tenant.id, id],
    );

  /** The conversation of a customer who wrote once. */
  async function conversationWith(c: Company, waId: string) {
    await inbound(c, waId, [{ text: 'Hello' }]);
    return conversationOf(c, waId);
  }

  it('read the members conversations can be assigned to and the teams, a page at a time', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const supervisor = await joined(c, 'supervisor', 'Sam Supervisor');
    await joined(c, 'analyst', 'Ana Analyst');
    const leaving = await joined(c, 'agent', 'Lee Leaving');
    await tenancy().setMemberStatus(owner, {
      membershipId: leaving.membership.id,
      status: 'suspended',
    });
    const { teamId: support } = await teams().createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      memberIds: [agent.membership.id, supervisor.membership.id],
    });
    const { teamId: sales } = await teams().createTeam(owner, {
      name: 'Sales',
      memberIds: [agent.membership.id],
    });
    await teams().setAvailability(agent, { available: true });
    const reader = await apiKey(c, ['conversations.read']);

    // Active members whose role answers conversations: not the marketer, the analyst or the
    // suspended agent. Names, teams and availability only.
    const members = await apiListMembers(deps(), reader.ctx, {});
    expect(members).toEqual({
      data: [
        { id: owner.membership.id, name: 'Owner', available: false, teamIds: [] },
        { id: agent.membership.id, name: 'Agent', available: true, teamIds: [support, sales] },
        {
          id: supervisor.membership.id,
          name: 'Sam Supervisor',
          available: false,
          teamIds: [support],
        },
      ],
      nextCursor: null,
    });
    const first = await apiListMembers(deps(), reader.ctx, { limit: 2 });
    expect(first.data).toEqual(members.data.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    expect(
      await apiListMembers(deps(), reader.ctx, { limit: 2, cursor: first.nextCursor ?? '' }),
    ).toEqual({ data: members.data.slice(2), nextCursor: null });

    const listed = await apiListTeams(deps(), reader.ctx, {});
    expect(listed).toEqual({
      data: [
        { id: support, name: 'Support', assignment: 'round_robin' },
        { id: sales, name: 'Sales', assignment: 'manual' },
      ],
      nextCursor: null,
    });
    const onePage = await apiListTeams(deps(), reader.ctx, { limit: 1 });
    expect(onePage.data).toEqual(listed.data.slice(0, 1));
    expect(
      await apiListTeams(deps(), reader.ctx, { limit: 1, cursor: onePage.nextCursor ?? '' }),
    ).toEqual({ data: listed.data.slice(1), nextCursor: null });

    // Reads need conversations.read, go on while the company is suspended, and stay in the company.
    const writer = await apiKey(c, ['conversations.write']);
    for (const list of [apiListMembers, apiListTeams]) {
      await expectAppError(list(deps(), writer.ctx, {}), 'forbidden', /conversations\.read scope/);
    }
    const suspended = {
      ...reader.ctx,
      tenant: { ...reader.ctx.tenant, status: 'suspended' as const },
    };
    expect(await apiListMembers(deps(), suspended, {})).toEqual(members);
    const other = await fx.company();
    const theirs = await apiKey(other, ['conversations.read']);
    expect((await apiListMembers(deps(), theirs.ctx, {})).data.map((m) => m.name)).toEqual([
      'Owner',
      'Agent',
    ]);
    expect(await apiListTeams(deps(), theirs.ctx, {})).toEqual({ data: [], nextCursor: null });
  });

  it('read the company’s WhatsApp numbers with channels.read, oldest first, a page at a time (ADR-171)', async () => {
    const c = await fx.company();
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54321', name: 'Outlet' });
    const closed = await fx.addNumber(c, { phone: '+91 90000 11111', status: 'disconnected' });
    const pending = await fx.addNumber(c, { phone: null, status: 'onboarding' });
    const reader = await apiKey(c, ['channels.read']);
    const [main] = await fx.query<{ created_at: Date }>(
      'SELECT created_at FROM app.channel_accounts WHERE id = $1',
      [c.channelAccountId],
    );

    // Every number, whatever its status, in the order it was added: its number, verified name and
    // status only, never Meta's ids.
    const all = await apiListChannels(deps(), reader.ctx, {});
    expect(all.data.map((n) => [n.id, n.phone, n.name, n.status])).toEqual([
      [c.channelAccountId, '+91 90000 00000', null, 'active'],
      [outlet.channelAccountId, '+91 90000 54321', 'Outlet', 'active'],
      [closed.channelAccountId, '+91 90000 11111', null, 'disconnected'],
      [pending.channelAccountId, null, null, 'onboarding'],
    ]);
    expect(all.data[0]?.createdAt).toBe(main!.created_at.toISOString());
    expect(all.nextCursor).toBeNull();
    for (const n of all.data) {
      expect(Object.keys(n)).toEqual(['id', 'phone', 'name', 'status', 'createdAt']);
    }
    for (const metaId of [c.phoneNumberId, outlet.phoneNumberId, c.wabaId]) {
      expect(JSON.stringify(all)).not.toContain(metaId);
    }

    // Pages never skip or repeat a number, and a status narrows them.
    const first = await apiListChannels(deps(), reader.ctx, { limit: 3 });
    expect(first.data).toEqual(all.data.slice(0, 3));
    expect(first.nextCursor).not.toBeNull();
    expect(
      await apiListChannels(deps(), reader.ctx, { limit: 3, cursor: first.nextCursor ?? '' }),
    ).toEqual({ data: all.data.slice(3), nextCursor: null });
    expect(
      (await apiListChannels(deps(), reader.ctx, { status: 'active' })).data.map((n) => n.id),
    ).toEqual([c.channelAccountId, outlet.channelAccountId]);
    expect(await apiListChannels(deps(), reader.ctx, { status: 'failed' })).toEqual({
      data: [],
      nextCursor: null,
    });

    // Reads need channels.read, go on while the company is suspended, and stay in the company.
    const sender = await apiKey(c, ['messages.send', 'templates.read', 'webhooks.manage']);
    await expectAppError(
      apiListChannels(deps(), sender.ctx, {}),
      'forbidden',
      /channels\.read scope/,
    );
    const suspended = {
      ...reader.ctx,
      tenant: { ...reader.ctx.tenant, status: 'suspended' as const },
    };
    expect(await apiListChannels(deps(), suspended, {})).toEqual(all);
    const other = await fx.company();
    const theirs = await apiKey(other, ['channels.read']);
    expect(await apiListChannels(deps(), theirs.ctx, {})).toEqual({
      data: [expect.objectContaining({ id: other.channelAccountId, status: 'active' })],
      nextCursor: null,
    });
  });

  it('assign, reassign, unassign and move conversations as the inbox does, audited as the key', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const supervisor = await joined(c, 'supervisor', 'Sam Supervisor');
    const { teamId: sales } = await teams().createTeam(owner, { name: 'Sales' });
    const writer = await apiKey(c, ['conversations.write'], 'Router');
    const reader = await apiKey(c, ['conversations.read']);
    await createWebhooksService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egressPolicy: { allowLoopbackForTests: true },
    }).create(owner, {
      url: 'https://hooks.receiver.test/assignment',
      eventTypes: ['conversation.assignment_changed'],
    });
    const conv = await conversationWith(c, '919811100190');
    const update = (body: unknown) => apiUpdateConversation(deps(), writer.ctx, conv.id, body);
    const live = () =>
      fx.query<{ type: string; assigned_membership_id: string | null; payload: unknown }>(
        `SELECT type, assigned_membership_id, payload FROM app.tenant_events
          WHERE conversation_id = $1 AND type IN ('conversation.assigned', 'conversation.team')
          ORDER BY id`,
        [conv.id],
      );
    const webhookEvents = () =>
      fx.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM app.webhook_events
          WHERE conversation_id = $1 AND type = 'conversation.assignment_changed'
          ORDER BY created_at, id`,
        [conv.id],
      );
    const before = await conversationRow(conv.id);
    expect(before).toMatchObject({ assigned: null, team_id: null, status: 'open' });

    // Assigned to the agent, as GET then reads it, audited as the key.
    const assigned = await update({ assigneeId: agent.membership.id });
    expect(assigned).toMatchObject({
      id: conv.id,
      status: 'open',
      assigned: true,
      assigneeId: agent.membership.id,
      teamId: null,
    });
    expect(assigned).toEqual(await apiGetConversation(deps(), reader.ctx, conv.id));
    expect(await conversationRow(conv.id)).toMatchObject({
      assigned: agent.membership.id,
      version: before.version + 1,
    });
    expect(await changes(c, conv.id)).toEqual([
      {
        action: 'conversation.assigned',
        actor_type: 'api_key',
        actor_id: writer.id,
        correlation_id: writer.ctx.requestId,
        metadata: { from: null, to: agent.membership.id, source: 'api' },
      },
    ]);
    // What it already has changes nothing, so a retry does no harm.
    expect(await update({ assigneeId: agent.membership.id })).toEqual(assigned);
    expect(await conversationRow(conv.id)).toMatchObject({ version: before.version + 1 });

    // Given to another member, then to none: the inbox and webhooks hear of each change, the webhook
    // naming the member before and after (ADR-094).
    expect((await update({ assigneeId: supervisor.membership.id })).assigneeId).toBe(
      supervisor.membership.id,
    );
    expect(await update({ assigneeId: null })).toMatchObject({ assigned: false, assigneeId: null });
    expect(await live()).toEqual([
      {
        type: 'conversation.assigned',
        assigned_membership_id: agent.membership.id,
        payload: { previous: null },
      },
      {
        type: 'conversation.assigned',
        assigned_membership_id: supervisor.membership.id,
        payload: { previous: agent.membership.id },
      },
      {
        type: 'conversation.assigned',
        assigned_membership_id: null,
        payload: { previous: supervisor.membership.id },
      },
    ]);
    expect((await webhookEvents()).map((e) => e.detail)).toEqual([
      { assigned: true, assigneeId: agent.membership.id, previousAssigneeId: null },
      {
        assigned: true,
        assigneeId: supervisor.membership.id,
        previousAssigneeId: agent.membership.id,
      },
      { assigned: false, assigneeId: null, previousAssigneeId: supervisor.membership.id },
    ]);

    // Into a team that assigns by hand and out again: nobody is given the conversation, and the
    // team it already has changes nothing.
    expect(await update({ teamId: sales })).toMatchObject({ teamId: sales, assigned: false });
    const inSales = await conversationRow(conv.id);
    expect(await update({ teamId: sales })).toMatchObject({ teamId: sales });
    expect(await conversationRow(conv.id)).toEqual(inSales);
    expect(await update({ teamId: null })).toMatchObject({ teamId: null, assigned: false });

    // All three at once: the team, then the member, then the status.
    expect(
      await update({ status: 'resolved', assigneeId: agent.membership.id, teamId: sales }),
    ).toMatchObject({
      status: 'resolved',
      assigneeId: agent.membership.id,
      teamId: sales,
      unreadCount: 0,
    });
    const audited = await changes(c, conv.id);
    expect(audited.map((a) => [a.action, a.metadata])).toEqual([
      ['conversation.assigned', { from: null, to: agent.membership.id, source: 'api' }],
      [
        'conversation.assigned',
        { from: agent.membership.id, to: supervisor.membership.id, source: 'api' },
      ],
      ['conversation.assigned', { from: supervisor.membership.id, to: null, source: 'api' }],
      ['conversation.team_changed', { from: null, to: sales, source: 'api' }],
      ['conversation.team_changed', { from: sales, to: null, source: 'api' }],
      ['conversation.team_changed', { from: null, to: sales, source: 'api' }],
      ['conversation.assigned', { from: null, to: agent.membership.id, source: 'api' }],
      ['conversation.status_changed', { from: 'open', to: 'resolved', source: 'api' }],
    ]);
    expect(audited.every((a) => a.actor_type === 'api_key' && a.actor_id === writer.id)).toBe(true);
    // The inbox heard of the team moves, and of the status with the member it now has.
    expect(
      (await live()).filter((e) => e.type === 'conversation.team').map((e) => e.payload),
    ).toEqual([{ teamId: sales }, { teamId: null }, { teamId: sales }]);
    expect(
      await fx.query(
        `SELECT assigned_membership_id, payload FROM app.tenant_events
          WHERE conversation_id = $1 AND type = 'conversation.status'`,
        [conv.id],
      ),
    ).toEqual([{ assigned_membership_id: agent.membership.id, payload: { status: 'resolved' } }]);

    // Lists by member and team, or those without one.
    const unrouted = await conversationWith(c, '919811100191');
    const ids = async (query: Record<string, string>) =>
      (await apiListConversations(deps(), reader.ctx, query)).data.map((x) => x.id);
    expect(await ids({ assigneeId: agent.membership.id })).toEqual([conv.id]);
    expect(await ids({ assigneeId: 'none' })).toEqual([unrouted.id]);
    expect(await ids({ assigneeId: supervisor.membership.id })).toEqual([]);
    expect(await ids({ teamId: sales })).toEqual([conv.id]);
    expect(await ids({ teamId: 'none' })).toEqual([unrouted.id]);
    expect(await ids({ teamId: 'none', status: 'resolved' })).toEqual([]);
  });

  it('give a conversation moved to a round-robin team to its next available member when it has none', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const supervisor = await joined(c, 'supervisor', 'Sam Supervisor');
    const { teamId: support } = await teams().createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      memberIds: [agent.membership.id, supervisor.membership.id],
    });
    await teams().setAvailability(agent, { available: true });
    const writer = await apiKey(c, ['conversations.write']);
    const update = (id: string, body: unknown) =>
      apiUpdateConversation(deps(), writer.ctx, id, body);

    // Open and unassigned: routed at once, as the inbox's team control does.
    const routed = await conversationWith(c, '919811100192');
    expect(await update(routed.id, { teamId: support })).toMatchObject({
      teamId: support,
      assigneeId: agent.membership.id,
    });
    expect((await changes(c, routed.id)).map((a) => [a.action, a.actor_type])).toEqual([
      ['conversation.team_changed', 'api_key'],
      ['conversation.routed', 'system'],
    ]);
    // Moved with no member named, or with none (as the minute sweep would a moment later).
    const unnamed = await conversationWith(c, '919811100199');
    expect(await update(unnamed.id, { teamId: support, assigneeId: null })).toMatchObject({
      assigneeId: agent.membership.id,
    });
    // A member named in the same request keeps it, even one routing would pass over.
    const named = await conversationWith(c, '919811100193');
    expect(
      await update(named.id, { teamId: support, assigneeId: supervisor.membership.id }),
    ).toMatchObject({ teamId: support, assigneeId: supervisor.membership.id });
    // A conversation resolved in the same request, and one with a member, keep theirs.
    const resolved = await conversationWith(c, '919811100194');
    expect(await update(resolved.id, { status: 'resolved', teamId: support })).toMatchObject({
      status: 'resolved',
      teamId: support,
      assigned: false,
    });
    const owned = await conversationWith(c, '919811100195');
    await update(owned.id, { assigneeId: owner.membership.id });
    expect(await update(owned.id, { teamId: support })).toMatchObject({
      teamId: support,
      assigneeId: owner.membership.id,
    });
    for (const id of [named.id, resolved.id, owned.id]) {
      expect((await changes(c, id)).map((a) => a.action)).not.toContain('conversation.routed');
    }
    // Unassigned in a round-robin team, it goes out again from the minute sweep.
    expect(await update(routed.id, { assigneeId: null })).toMatchObject({ assigned: false });
    await routeDueConversations(fx.dbs.app);
    expect((await conversationRow(routed.id)).assigned).toBe(agent.membership.id);
  });

  it('refuse members who cannot answer conversations and teams of other companies, changing nothing', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const marketer = await fx.ctx(c, c.marketer);
    const billing = await joined(c, 'billing', 'Bea Billing');
    const leaving = await joined(c, 'agent', 'Lee Leaving');
    await tenancy().setMemberStatus(owner, {
      membershipId: leaving.membership.id,
      status: 'suspended',
    });
    const other = await fx.company();
    const theirAgent = await fx.ctx(other, other.agent);
    const { teamId: sales } = await teams().createTeam(owner, { name: 'Sales' });
    const { teamId: foreign } = await teams().createTeam(await fx.ctx(other, other.owner), {
      name: 'Foreign',
    });
    const writer = await apiKey(c, ['conversations.write']);
    const theirs = await apiKey(other, ['conversations.write']);
    const conv = await conversationWith(c, '919811100196');
    const before = await conversationRow(conv.id);
    const refused = async (body: unknown, path: 'assigneeId' | 'teamId') => {
      const error = await expectAppError(
        apiUpdateConversation(deps(), writer.ctx, conv.id, body),
        'validation_failed',
      );
      expect(isAppError(error) && error.issues).toEqual([{ path, message: expect.any(String) }]);
    };
    for (const member of [marketer, billing, leaving, theirAgent]) {
      await refused({ assigneeId: member.membership.id }, 'assigneeId');
    }
    await refused({ assigneeId: uuidv7() }, 'assigneeId');
    for (const teamId of [foreign, uuidv7()]) await refused({ teamId }, 'teamId');
    // A refused member undoes the team named with it; a refused team, the rest.
    await refused({ teamId: sales, assigneeId: marketer.membership.id }, 'assigneeId');
    await refused(
      { teamId: foreign, assigneeId: agent.membership.id, status: 'resolved' },
      'teamId',
    );
    expect(await conversationRow(conv.id)).toEqual(before);
    expect(await changes(c, conv.id)).toEqual([]);

    // Another company's key does not find the conversation; nothing changes while the company is
    // suspended or its plan has ended; an erased contact's conversation is not found.
    await expectAppError(
      apiUpdateConversation(deps(), theirs.ctx, conv.id, { assigneeId: theirAgent.membership.id }),
      'not_found',
    );
    for (const status of ['suspended', 'restricted'] as const) {
      const ctx = { ...writer.ctx, tenant: { ...writer.ctx.tenant, status } };
      await expectAppError(
        apiUpdateConversation(deps(), ctx, conv.id, { assigneeId: agent.membership.id }),
        'tenant_suspended',
      );
    }
    const erased = await conversationWith(c, '919811100197');
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: erased.contact_id,
      suppress: false,
    });
    await expectAppError(
      apiUpdateConversation(deps(), writer.ctx, erased.id, { assigneeId: agent.membership.id }),
      'not_found',
    );
    expect((await conversationRow(erased.id)).assigned).toBeNull();
    expect(await changes(c, erased.id)).toEqual([]);
    expect(await conversationRow(conv.id)).toEqual(before);
  });

  it('wait for a member being suspended or a team being deleted, then refuse them', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const { teamId: sales } = await teams().createTeam(owner, { name: 'Sales' });
    const writer = await apiKey(c, ['conversations.write']);
    const conv = await conversationWith(c, '919811100198');
    const before = await conversationRow(conv.id);

    /** The request's outcome when another transaction holds rows with `statement` as it comes. */
    async function whileHeld(statement: string, id: string, body: unknown) {
      const holder = await fx.dbs.adminPool.connect();
      let outcome: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query(statement, [id]);
        const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
        outcome = apiUpdateConversation(deps(), writer.ctx, conv.id, body).then(
          () => 'changed',
          (error: unknown) => (isAppError(error) ? error.code : error),
        );
        await vi.waitFor(
          async () => {
            const [waiting] = await fx.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
              [lock!.pid],
            );
            if (waiting!.n < 1) throw new Error('the request is not waiting yet');
          },
          { timeout: 4_000, interval: 20 },
        );
      } finally {
        await holder.query('COMMIT');
        holder.release();
      }
      return outcome;
    }

    // Without the locks the request would assign a member being suspended (their suspension
    // releasing nothing it cannot see yet), or fail on the deleted team's foreign key.
    expect(
      await whileHeld(
        `UPDATE app.memberships SET status = 'suspended' WHERE id = $1`,
        agent.membership.id,
        {
          assigneeId: agent.membership.id,
        },
      ),
    ).toBe('validation_failed');
    expect(await whileHeld('DELETE FROM app.teams WHERE id = $1', sales, { teamId: sales })).toBe(
      'validation_failed',
    );
    expect(await conversationRow(conv.id)).toEqual(before);
    expect(await changes(c, conv.id)).toEqual([]);
  });

  it('change many conversations in one call, each as PATCH changes it, in the order given, audited as the key (ADR-120)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const supervisor = await joined(c, 'supervisor', 'Sam Supervisor');
    const { teamId: support } = await teams().createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      memberIds: [agent.membership.id, supervisor.membership.id],
    });
    await teams().setAvailability(agent, { available: true });
    await teams().setAvailability(supervisor, { available: true });
    const writer = await apiKey(c, ['conversations.write'], 'Bulk router');
    const many = (body: unknown) => apiUpdateManyConversations(deps(), writer.ctx, body);
    const [first, second, third] = [
      await conversationWith(c, '919811100301'),
      await conversationWith(c, '919811100302'),
      await conversationWith(c, '919811100303'),
    ];

    // Assigned to one member, answered in the order given.
    const assigned = await many({
      conversationIds: [third.id, first.id, second.id],
      assigneeId: supervisor.membership.id,
    });
    expect(assigned.map((v) => [v.id, v.assigneeId])).toEqual([
      [third.id, supervisor.membership.id],
      [first.id, supervisor.membership.id],
      [second.id, supervisor.membership.id],
    ]);
    for (const conv of [first, second, third]) {
      expect((await changes(c, conv.id)).map((a) => [a.action, a.actor_type, a.actor_id])).toEqual([
        ['conversation.assigned', 'api_key', writer.id],
      ]);
    }
    const correlation = new Set(
      (await Promise.all([first, second, third].map((v) => changes(c, v.id)))).map(
        (rows) => rows[0]?.correlation_id,
      ),
    );
    expect(correlation).toEqual(new Set([writer.ctx.requestId]));

    // Resolved together; the same call again changes nothing.
    const ids = [first.id, second.id, third.id];
    expect((await many({ conversationIds: ids, status: 'resolved' })).map((v) => v.status)).toEqual(
      ['resolved', 'resolved', 'resolved'],
    );
    const audited = async () =>
      (await Promise.all(ids.map((id) => changes(c, id)))).reduce((n, rows) => n + rows.length, 0);
    const before = await audited();
    const versions = await Promise.all(ids.map(async (id) => (await conversationRow(id)).version));
    await many({ conversationIds: ids, status: 'resolved' });
    expect(await audited()).toBe(before);
    expect(await Promise.all(ids.map(async (id) => (await conversationRow(id)).version))).toEqual(
      versions,
    );

    // Moved into a round-robin team, open and unassigned ones go out in turn, in the order given.
    const [fourth, fifth] = [
      await conversationWith(c, '919811100304'),
      await conversationWith(c, '919811100305'),
    ];
    const moved = await many({ conversationIds: [fifth.id, fourth.id], teamId: support });
    expect(moved.map((v) => [v.id, v.teamId, v.assigneeId])).toEqual([
      [fifth.id, support, agent.membership.id],
      [fourth.id, support, supervisor.membership.id],
    ]);
    for (const conv of [fourth, fifth]) {
      expect((await changes(c, conv.id)).map((a) => a.action)).toEqual([
        'conversation.team_changed',
        'conversation.routed',
      ]);
    }

    // The most a call takes.
    const hundred: string[] = [];
    for (let i = 0; i < API_LIMITS.conversationsPerChange; i++) {
      hundred.push((await conversationWith(c, `9198122${String(i).padStart(5, '0')}`)).id);
    }
    const all = await many({ conversationIds: hundred, status: 'resolved' });
    expect(all.map((v) => v.id)).toEqual(hundred);
    expect(new Set(all.map((v) => v.status))).toEqual(new Set(['resolved']));
  });

  it('refuse the whole call, changing nothing, for an id that names none of the company’s conversations, a member or a team it may not take (ADR-120)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const marketer = await fx.ctx(c, c.marketer);
    const other = await fx.company();
    const { teamId: foreign } = await teams().createTeam(await fx.ctx(other, other.owner), {
      name: 'Foreign',
    });
    const writer = await apiKey(c, ['conversations.write']);
    const theirs = await apiKey(other, ['conversations.write']);
    const kept = await conversationWith(c, '919811100311');
    const alsoKept = await conversationWith(c, '919811100312');
    const theirConversation = await conversationWith(other, '919811100313');
    const erased = await conversationWith(c, '919811100314');
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: erased.contact_id,
      suppress: false,
    });
    const rows = async () => Promise.all([kept.id, alsoKept.id].map((id) => conversationRow(id)));
    const before = await rows();
    const refused = async (ctx: typeof writer.ctx, body: unknown, path: string) => {
      const error = await expectAppError(
        apiUpdateManyConversations(deps(), ctx, body),
        'validation_failed',
      );
      expect(isAppError(error) && error.issues).toEqual([{ path, message: expect.any(String) }]);
    };
    const pair = [kept.id, alsoKept.id];
    await refused(
      writer.ctx,
      { conversationIds: [...pair, theirConversation.id], status: 'resolved' },
      'conversationIds.2',
    );
    await refused(
      writer.ctx,
      { conversationIds: [kept.id, erased.id, alsoKept.id], status: 'resolved' },
      'conversationIds.1',
    );
    await refused(
      writer.ctx,
      { conversationIds: [uuidv7(), ...pair], assigneeId: agent.membership.id },
      'conversationIds.0',
    );
    await refused(
      writer.ctx,
      { conversationIds: pair, assigneeId: marketer.membership.id },
      'assigneeId',
    );
    await refused(
      writer.ctx,
      { conversationIds: pair, status: 'resolved', teamId: foreign },
      'teamId',
    );
    await refused(theirs.ctx, { conversationIds: pair, status: 'resolved' }, 'conversationIds.0');
    await refused(
      writer.ctx,
      { conversationIds: [kept.id, kept.id], status: 'resolved' },
      'conversationIds',
    );
    expect(await rows()).toEqual(before);
    for (const id of pair) expect(await changes(c, id)).toEqual([]);
    await expectAppError(
      apiUpdateManyConversations(deps(), (await apiKey(c, ['conversations.read'])).ctx, {
        conversationIds: pair,
        status: 'resolved',
      }),
      'forbidden',
    );
  });

  it('take turns with calls changing the same conversations, locking them in id order (ADR-120)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const writer = await apiKey(c, ['conversations.write']);
    const [low, middle, high] = (
      await Promise.all(
        ['919811100321', '919811100322', '919811100323'].map((waId) => conversationWith(c, waId)),
      )
    )
      .map((v) => v.id)
      .sort() as [string, string, string];
    const holder = await fx.dbs.adminPool.connect();
    let calls: Promise<unknown[]> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM app.conversations WHERE id = $1 FOR UPDATE', [middle]);
      // Both wait: one for the held conversation, the other for one the first has locked. Locked
      // in the order given instead, the second would hold the last one while waiting, and the two
      // would deadlock once the conversation is let go.
      calls = Promise.all(
        [
          { conversationIds: [low, middle, high], assigneeId: agent.membership.id },
          { conversationIds: [high, middle, low], assigneeId: owner.membership.id },
        ].map((body) =>
          apiUpdateManyConversations(deps(), writer.ctx, body).then(
            () => 'changed',
            (error: unknown) => (isAppError(error) ? error.code : String(error)),
          ),
        ),
      );
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE cardinality(pg_blocking_pids(pid)) > 0`,
          );
          if (waiting!.n < 2) throw new Error('both calls are not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect(await calls).toEqual(['changed', 'changed']);
    const assignees = await Promise.all(
      [low, middle, high].map(async (id) => (await conversationRow(id)).assigned),
    );
    expect(new Set(assignees).size).toBe(1);
  });

  it('wait for a member being suspended or a team being deleted, locking in the order they do, then refuse them (ADR-120)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const { teamId: sales } = await teams().createTeam(owner, { name: 'Sales' });
    const writer = await apiKey(c, ['conversations.write']);
    const outcome = (body: unknown) =>
      apiUpdateManyConversations(deps(), writer.ctx, body).then(
        () => 'changed',
        (error: unknown) =>
          isAppError(error) ? (error.issues?.[0]?.path ?? error.code) : String(error),
      );

    /** Runs `first` in another transaction, the call while it holds its locks, then `then`. */
    async function race(
      first: (q: (sql: string, values: unknown[]) => Promise<unknown>) => Promise<void>,
      body: unknown,
      then: (q: (sql: string, values: unknown[]) => Promise<unknown>) => Promise<void>,
    ) {
      const other = await fx.dbs.adminPool.connect();
      const q = (sql: string, values: unknown[]) => other.query(sql, values);
      let call: Promise<unknown> | undefined;
      try {
        await other.query('BEGIN');
        await first(q);
        const [held] = (await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
        call = outcome(body);
        await vi.waitFor(
          async () => {
            const [waiting] = await fx.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
              [held!.pid],
            );
            if (waiting!.n < 1) throw new Error('the call is not waiting yet');
          },
          { timeout: 4_000, interval: 20 },
        );
        // The other transaction finishes without waiting for the call, which holds nothing it
        // needs: locked the other way round, the two would deadlock here.
        await then(q);
      } finally {
        await other.query('COMMIT');
        other.release();
      }
      return call;
    }

    // A suspension locks the member, then releases the member's conversations.
    const assigned = await conversationWith(c, '919811100331');
    const waiting = await conversationWith(c, '919811100332');
    await apiUpdateConversation(deps(), writer.ctx, assigned.id, {
      assigneeId: agent.membership.id,
    });
    expect(
      await race(
        (q) =>
          q(`UPDATE app.memberships SET status = 'suspended' WHERE id = $1`, [
            agent.membership.id,
          ]).then(() => undefined),
        { conversationIds: [assigned.id, waiting.id], assigneeId: agent.membership.id },
        (q) =>
          q('UPDATE app.conversations SET assigned_membership_id = NULL WHERE id = $1', [
            assigned.id,
          ]).then(() => undefined),
      ),
    ).toBe('assigneeId');
    expect((await conversationRow(assigned.id)).assigned).toBeNull();
    expect((await conversationRow(waiting.id)).assigned).toBeNull();

    // A team's deletion releases its conversations, then deletes the team.
    const inSales = await conversationWith(c, '919811100333');
    const elsewhere = await conversationWith(c, '919811100334');
    await apiUpdateConversation(deps(), writer.ctx, inSales.id, { teamId: sales });
    expect(
      await race(
        (q) =>
          q('UPDATE app.conversations SET team_id = NULL WHERE team_id = $1', [sales]).then(
            () => undefined,
          ),
        { conversationIds: [inSales.id, elsewhere.id], teamId: sales },
        (q) => q('DELETE FROM app.teams WHERE id = $1', [sales]).then(() => undefined),
      ),
    ).toBe('teamId');
    expect((await conversationRow(inSales.id)).team_id).toBeNull();
    expect((await conversationRow(elsewhere.id)).team_id).toBeNull();
  });

  it('change the conversations a filter finds, a page at a time, each as PATCH changes it, audited as the key (ADR-166)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const supervisor = await joined(c, 'supervisor', 'Sam Supervisor');
    const { teamId: support } = await teams().createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      memberIds: [agent.membership.id, supervisor.membership.id],
    });
    await teams().setAvailability(agent, { available: true });
    await teams().setAvailability(supervisor, { available: true });
    const writer = await apiKey(c, ['conversations.read', 'conversations.write'], 'Bulk tidy');
    const matching = (body: unknown) => apiUpdateMatchingConversations(deps(), writer.ctx, body);
    const other = await fx.company();
    const theirs = await conversationWith(other, '919811100500');
    const [first, second, third, fourth, fifth] = [
      await conversationWith(c, '919811100501'),
      await conversationWith(c, '919811100502'),
      await conversationWith(c, '919811100503'),
      await conversationWith(c, '919811100504'),
      await conversationWith(c, '919811100505'),
    ];
    await apiUpdateManyConversations(deps(), writer.ctx, {
      conversationIds: [first.id, second.id, third.id],
      assigneeId: agent.membership.id,
    });

    // The agent's open conversations go to the supervisor, newest first, two at a time.
    const byAgent = {
      filter: { status: 'open', assigneeId: agent.membership.id },
      change: { assigneeId: supervisor.membership.id },
      limit: 2,
    };
    const page = await matching(byAgent);
    expect(page.data.map((v) => [v.id, v.assigneeId])).toEqual([
      [third.id, supervisor.membership.id],
      [second.id, supervisor.membership.id],
    ]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const last = await matching({ ...byAgent, cursor: page.nextCursor });
    expect(last.data.map((v) => [v.id, v.assigneeId])).toEqual([
      [first.id, supervisor.membership.id],
    ]);
    expect(last.nextCursor).toBeNull();
    for (const conv of [first, second, third]) {
      const audited = await changes(c, conv.id);
      expect(audited.map((a) => [a.action, a.actor_type, a.actor_id])).toEqual([
        ['conversation.assigned', 'api_key', writer.id],
        ['conversation.assigned', 'api_key', writer.id],
      ]);
      expect(audited[1]?.metadata).toMatchObject({
        from: agent.membership.id,
        to: supervisor.membership.id,
        source: 'api',
      });
    }
    for (const conv of [fourth, fifth])
      expect((await conversationRow(conv.id)).assigned).toBeNull();
    // The filter finds none of them any more.
    expect(await matching(byAgent)).toEqual({ data: [], nextCursor: null });

    // Every open conversation without a team resolved in one page; another company's untouched.
    const resolved = await matching({
      filter: { status: 'open', teamId: 'none' },
      change: { status: 'resolved' },
      limit: 100,
    });
    expect(resolved.data.map((v) => [v.id, v.status])).toEqual(
      [fifth, fourth, third, second, first].map((v) => [v.id, 'resolved']),
    );
    expect(resolved.nextCursor).toBeNull();
    expect((await conversationRow(theirs.id)).status).toBe('open');

    // The unassigned ones reopened, then moved into the round-robin team, given out in turn.
    const reopened = await matching({
      filter: { status: 'resolved', assigneeId: 'none' },
      change: { status: 'open' },
    });
    expect(reopened.data.map((v) => [v.id, v.status])).toEqual([
      [fifth.id, 'open'],
      [fourth.id, 'open'],
    ]);
    const moved = await matching({
      filter: { status: 'open', assigneeId: 'none' },
      change: { teamId: support },
    });
    expect(moved.data.map((v) => [v.id, v.teamId, v.assigneeId])).toEqual([
      [fifth.id, support, agent.membership.id],
      [fourth.id, support, supervisor.membership.id],
    ]);
    for (const conv of [fourth, fifth]) {
      expect((await changes(c, conv.id)).map((a) => a.action)).toEqual([
        'conversation.status_changed',
        'conversation.status_changed',
        'conversation.team_changed',
        'conversation.routed',
      ]);
    }
  });

  it('refuse a member or a team it may not take before reading the page, even when nothing matches, changing nothing (ADR-166)', async () => {
    const c = await fx.company();
    const marketer = await fx.ctx(c, c.marketer);
    const other = await fx.company();
    const { teamId: foreign } = await teams().createTeam(await fx.ctx(other, other.owner), {
      name: 'Foreign',
    });
    const writer = await apiKey(c, ['conversations.read', 'conversations.write']);
    const conv = await conversationWith(c, '919811100511');
    const before = await conversationRow(conv.id);
    const refused = async (
      ctx: typeof writer.ctx,
      body: unknown,
      code: string,
      paths: string[],
    ) => {
      const error = await expectAppError(apiUpdateMatchingConversations(deps(), ctx, body), code);
      expect(isAppError(error) && (error.issues ?? []).map((i) => i.path)).toEqual(paths);
    };
    const open = { status: 'open' };
    for (const filter of [open, { contactId: uuidv7() }]) {
      await refused(
        writer.ctx,
        { filter, change: { assigneeId: marketer.membership.id } },
        'validation_failed',
        ['change.assigneeId'],
      );
      await refused(
        writer.ctx,
        { filter, change: { status: 'resolved', teamId: foreign } },
        'validation_failed',
        ['change.teamId'],
      );
      await refused(writer.ctx, { filter, change: { teamId: uuidv7() } }, 'validation_failed', [
        'change.teamId',
      ]);
    }
    await refused(writer.ctx, { filter: {}, change: { status: 'resolved' } }, 'validation_failed', [
      'filter',
    ]);
    for (const scopes of [['conversations.write'], ['conversations.read']] as const) {
      await refused(
        (await apiKey(c, [...scopes])).ctx,
        { filter: open, change: { status: 'resolved' } },
        'forbidden',
        [],
      );
    }
    for (const status of ['suspended', 'restricted'] as const) {
      const ctx = { ...writer.ctx, tenant: { ...writer.ctx.tenant, status } };
      await refused(ctx, { filter: open, change: { status: 'resolved' } }, 'tenant_suspended', []);
    }
    expect(await conversationRow(conv.id)).toEqual(before);
    expect(await changes(c, conv.id)).toEqual([]);

    // Another company's key finds none of the company's conversations.
    const theirs = await apiKey(other, ['conversations.read', 'conversations.write']);
    expect(
      await apiUpdateMatchingConversations(deps(), theirs.ctx, {
        filter: open,
        change: { status: 'resolved' },
      }),
    ).toEqual({ data: [], nextCursor: null });
    expect(await conversationRow(conv.id)).toEqual(before);
  });

  it('leave out a conversation someone else takes out of the filter meanwhile, and change one still matching as it now is (ADR-166)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { teamId: sales } = await teams().createTeam(owner, { name: 'Sales' });
    const writer = await apiKey(c, ['conversations.read', 'conversations.write']);
    const [taken, kept, moved] = [
      await conversationWith(c, '919811100521'),
      await conversationWith(c, '919811100522'),
      await conversationWith(c, '919811100523'),
    ];
    const holder = await fx.dbs.adminPool.connect();
    let call: ReturnType<typeof apiUpdateMatchingConversations> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE app.conversations SET assigned_membership_id = $2 WHERE id = $1', [
        taken.id,
        owner.membership.id,
      ]);
      await holder.query('UPDATE app.conversations SET team_id = $2 WHERE id = $1', [
        moved.id,
        sales,
      ]);
      const [held] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      // The page is read before the other transaction commits, so all three are on it; their rows
      // are then locked with the filter again, after it commits.
      call = apiUpdateMatchingConversations(deps(), writer.ctx, {
        filter: { assigneeId: 'none' },
        change: { status: 'resolved' },
      });
      call.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [held!.pid],
          );
          if (waiting!.n < 1) throw new Error('the call is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    const result = await call;
    expect(result?.data.map((v) => [v.id, v.status, v.teamId])).toEqual([
      [moved.id, 'resolved', sales],
      [kept.id, 'resolved', null],
    ]);
    expect(result?.nextCursor).toBeNull();
    expect(await conversationRow(taken.id)).toMatchObject({
      status: 'open',
      assigned: owner.membership.id,
    });
    expect(await changes(c, taken.id)).toEqual([]);
  });

  it('reach every conversation a filter finds, each changed once, when a call is sent again after a lost answer (ADR-166)', async () => {
    const c = await fx.company();
    const writer = await apiKey(c, ['conversations.read', 'conversations.write']);
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push((await conversationWith(c, `91981110053${i}`)).id);
    const call = (cursor?: string | null) =>
      apiUpdateMatchingConversations(deps(), writer.ctx, {
        filter: { status: 'open' },
        change: { status: 'resolved' },
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
    const first = await call();
    expect(first.data.map((v) => v.id)).toEqual([ids[4], ids[3]]);
    // The answer to the next call is lost. Sent again with the same cursor, it finds the
    // conversations still open past it: those it resolved are not found again.
    const lost = await call(first.nextCursor);
    expect(lost.data.map((v) => v.id)).toEqual([ids[2], ids[1]]);
    const again = await call(first.nextCursor);
    expect(again.data.map((v) => [v.id, v.status])).toEqual([[ids[0], 'resolved']]);
    expect(again.nextCursor).toBeNull();
    for (const id of ids) {
      expect((await changes(c, id)).map((a) => a.action)).toEqual(['conversation.status_changed']);
    }
    expect(await call()).toEqual({ data: [], nextCursor: null });
  });
});

describe('internal notes (ADR-084)', () => {
  const notesOf = (conversationId: string) =>
    fx.query<{
      author_membership_id: string | null;
      author_api_key_id: string | null;
      body: string;
    }>(
      `SELECT author_membership_id, author_api_key_id, body FROM app.conversation_notes
        WHERE conversation_id = $1 ORDER BY created_at, id`,
      [conversationId],
    );
  const conversationState = (id: string) =>
    fx.query(
      `SELECT status, assigned_membership_id, unread_count, version, updated_at, last_message_at,
              last_message_preview
         FROM app.conversations WHERE id = $1`,
      [id],
    );
  const messagesOf = (id: string) =>
    fx.query('SELECT id, status FROM app.messages WHERE conversation_id = $1 ORDER BY id', [id]);
  const text = 'Ticket #4521 opened in the helpdesk.';

  it('add a note once per Idempotency-Key, which the inbox names as the key’s and WhatsApp never receives', async () => {
    const c = await fx.company();
    const { ctx, id: keyId } = await apiKey(c, ['conversations.write'], 'Helpdesk');
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const waId = '919811100094';
    await inbound(c, waId, [{ text: 'My parcel is late' }]);
    const conv = await conversationOf(c, waId);
    await inbox().assign(owner, {
      conversationId: conv.id,
      membershipId: agent.membership.id,
      expectedVersion: conv.version,
    });
    const before = await conversationState(conv.id);
    const messagesBefore = await messagesOf(conv.id);

    const first = await apiAddConversationNote(
      deps(),
      ctx,
      conv.id,
      { text: `  ${text}  ` },
      idem('note-1', 'a'),
    );
    expect(first).toEqual({
      status: 201,
      replayed: false,
      body: {
        data: {
          id: expect.any(String),
          conversationId: conv.id,
          text,
          writtenBy: 'api',
          apiKeyId: keyId,
          createdAt: expect.any(String),
        },
      },
    });
    // A retry answers as the first request did and adds nothing.
    expect(
      await apiAddConversationNote(
        deps(),
        ctx,
        conv.id,
        { text: `  ${text}  ` },
        idem('note-1', 'a'),
      ),
    ).toEqual({ ...first, replayed: true });
    expect(await notesOf(conv.id)).toEqual([
      { author_membership_id: null, author_api_key_id: keyId, body: text },
    ]);

    // The inbox shows it with the key's name, next to a member's note, and hears of it live.
    await inbox().addNote(agent, { conversationId: conv.id, body: 'Called the courier.' });
    const thread = await inbox().getConversation(agent, conv.id);
    expect(thread.notes.map((n) => [n.body, n.authorName, n.apiKeyName])).toEqual([
      [text, null, 'Helpdesk'],
      ['Called the courier.', 'Agent', null],
    ]);
    expect(
      await fx.query(
        `SELECT assigned_membership_id FROM app.tenant_events
          WHERE conversation_id = $1 AND type = 'conversation.note' ORDER BY id`,
        [conv.id],
      ),
    ).toEqual([
      { assigned_membership_id: agent.membership.id },
      { assigned_membership_id: agent.membership.id },
    ]);
    // Nothing else about the conversation changes, and nothing is sent.
    expect(await conversationState(conv.id)).toEqual(before);
    expect(await messagesOf(conv.id)).toEqual(messagesBefore);
  });

  it('refuse, storing nothing, what the key, the company or the conversation does not allow', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const mine = await apiKey(c, ['conversations.write']);
    const reader = await apiKey(c, ['conversations.read', 'messages.reply']);
    const theirs = await apiKey(other, ['conversations.write']);
    await inbound(c, '919811100095', [{ text: 'Hello' }]);
    await inbound(c, '919811100097', [{ text: 'Please forget me' }]);
    const kept = await conversationOf(c, '919811100095');
    const erased = await conversationOf(c, '919811100097');
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(
      await fx.ctx(c, c.owner),
      { contactId: erased.contact_id, suppress: false },
    );
    const add = (ctx: ApiContext, id: string, body: unknown, key: string) =>
      apiAddConversationNote(deps(), ctx, id, body, idem(key, key));

    await expectAppError(add(reader.ctx, kept.id, { text }, 'r-1'), 'forbidden');
    await expectAppError(add(theirs.ctx, kept.id, { text }, 'r-2'), 'not_found', /Conversation/);
    await expectAppError(add(mine.ctx, erased.id, { text }, 'r-3'), 'not_found', /Conversation/);
    for (const [i, id] of ['not-a-uuid', uuidv7()].entries()) {
      await expectAppError(add(mine.ctx, id, { text }, `r-4-${i}`), 'not_found');
    }
    for (const [i, body] of [
      {},
      { text: ' ' },
      { text: 'x'.repeat(4001) },
      { note: text },
    ].entries()) {
      await expectAppError(add(mine.ctx, kept.id, body, `r-5-${i}`), 'validation_failed');
    }
    // Nothing is added while the company is suspended or its plan has ended.
    for (const status of ['suspended', 'restricted'] as const) {
      const ctx = { ...mine.ctx, tenant: { ...mine.ctx.tenant, status } };
      await expectAppError(add(ctx, kept.id, { text }, `r-6-${status}`), 'tenant_suspended');
    }
    expect(await notesOf(kept.id)).toEqual([]);
    expect(await notesOf(erased.id)).toEqual([]);
    expect(
      await fx.query('SELECT id FROM app.api_idempotency_keys WHERE api_key_id = ANY($1)', [
        [mine.id, reader.id, theirs.id],
      ]),
    ).toEqual([]);
  });

  it('never outlive an erasure: erasure deletes notes added before it, and a note waiting for it is refused', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['conversations.write']);
    await inbound(c, '919811100098', [{ text: 'Delete my data' }]);
    const conv = await conversationOf(c, '919811100098');
    await apiAddConversationNote(
      deps(),
      ctx,
      conv.id,
      { text: 'Asked for erasure.' },
      idem('e-1', 'e'),
    );
    expect(await notesOf(conv.id)).toHaveLength(1);

    // An erasure holds the conversation while the key adds a note: the note waits, then is refused.
    const erasing = await fx.dbs.adminPool.connect();
    let adding: Promise<unknown> | undefined;
    try {
      await erasing.query('BEGIN');
      await erasing.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [c.tenant.id, c.owner.id],
      );
      await erasing.query('SELECT app.erase_contact($1, false)', [conv.contact_id]);
      const [holder] = (await erasing.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows;
      adding = expectAppError(
        apiAddConversationNote(deps(), ctx, conv.id, { text: 'Refund issued.' }, idem('e-2', 'f')),
        'not_found',
        /Conversation/,
      );
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
            [holder!.pid],
          );
          if (waiting!.n < 1) throw new Error('the note is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await erasing.query('COMMIT');
      erasing.release();
    }
    await adding;
    expect(await notesOf(conv.id)).toEqual([]);
  });

  it('keep exactly one author on every note, a key of the company, fixed once written', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['conversations.write']);
    await inbound(c, '919811100099', [{ text: 'Hi' }]);
    const conv = await conversationOf(c, '919811100099');
    const added = await apiAddConversationNote(
      deps(),
      key.ctx,
      conv.id,
      { text },
      idem('d-1', 'd'),
    );
    const id = (added.body as { data: { id: string } }).data.id;
    const owner = await fx.ctx(c, c.owner);
    // Both, or neither: the check refuses (as the owner of the tables, beyond row security).
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.conversation_notes SET author_membership_id = $2 WHERE id = $1`,
        [id, owner.membership.id],
      ),
    ).rejects.toThrow(/conversation_notes_author/);
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.conversation_notes SET author_api_key_id = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/conversation_notes_author/);
    // The key must be one of the company's own.
    const stranger = await apiKey(await fx.company(), ['conversations.write']);
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.conversation_notes SET author_api_key_id = $2 WHERE id = $1`,
        [id, stranger.id],
      ),
    ).rejects.toThrow(/conversation_notes_api_key_fk/);
    // The runtime role cannot change who wrote a note.
    await expect(
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), (tx) =>
        tx.execute(
          sql`UPDATE app.conversation_notes SET author_api_key_id = NULL WHERE id = ${id}`,
        ),
      ),
    ).rejects.toThrow();
    expect(await notesOf(conv.id)).toEqual([
      { author_membership_id: null, author_api_key_id: key.id, body: text },
    ]);
  });
});

describe('allowed networks (ADR-076)', () => {
  const create = (owner: TenantContext, allowedNetworks?: string) =>
    keys.create(owner, {
      name: 'Server',
      scopes: ['contacts.read'],
      expiresInDays: 30,
      ...(allowedNetworks === undefined ? {} : { allowedNetworks }),
    });
  const keyRow = async (id: string) => {
    const [row] = await fx.query<{ allowed_networks: string[] | null; last_used_at: Date | null }>(
      'SELECT allowed_networks::text[] AS allowed_networks, last_used_at FROM app.api_keys WHERE id = $1',
      [id],
    );
    return row!;
  };
  /** What a request with the token from `ip` gets: its key, a refusal of the address, or nothing. */
  const from = async (token: string, ip: string | null) => {
    const auth = await authenticateApiRequest(fx.dbs.app, token, uuidv7(), ip);
    if (!auth) return 'unknown';
    return 'authenticated' in auth ? 'accepted' : 'refused';
  };

  it('accept requests only from the networks listed, and a refused request does not use the key', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const key = await create(owner, '203.0.113.0/24\n2001:db8::/32, 198.51.100.7 203.0.113.0/24');
    expect((await keyRow(key.id)).allowed_networks).toEqual([
      '203.0.113.0/24',
      '2001:db8::/32',
      '198.51.100.7/32',
    ]);
    const [created] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE action = 'api_key.created' AND subject_id = $1`,
      [key.id],
    );
    expect(created!.metadata.allowedNetworks).toEqual([
      '203.0.113.0/24',
      '2001:db8::/32',
      '198.51.100.7/32',
    ]);

    // Refused addresses leave the key unused.
    for (const ip of ['203.0.114.1', '198.51.100.8', '2001:db9::1', '10.0.0.1', null]) {
      expect(await from(key.token, ip), String(ip)).toBe('refused');
    }
    expect((await keyRow(key.id)).last_used_at).toBeNull();
    for (const ip of [
      '203.0.113.1',
      '203.0.113.255',
      '198.51.100.7',
      '2001:db8::1',
      '2001:db8:ffff::9',
    ]) {
      expect(await from(key.token, ip), ip).toBe('accepted');
    }
    // An IPv4 client seen as IPv4-mapped IPv6 is the same client.
    expect(await from(key.token, '::ffff:203.0.113.9')).toBe('accepted');
    expect((await keyRow(key.id)).last_used_at).not.toBeNull();
    // Without an address the key is refused; the helper without one gives no context.
    expect(await authenticateApiToken(fx.dbs.app, key.token, 'r')).toBeNull();
    expect(await authenticateApiToken(fx.dbs.app, key.token, 'r', '203.0.113.1')).not.toBeNull();

    // A key without networks accepts any address, and none.
    const open = await create(owner);
    expect((await keyRow(open.id)).allowed_networks).toBeNull();
    for (const ip of ['203.0.114.1', '2001:db9::1', null]) {
      expect(await from(open.token, ip), String(ip)).toBe('accepted');
    }
    // An unknown token is unknown from any address.
    expect(await from(generateApiToken().token, '203.0.113.1')).toBe('unknown');

    // The lookup without an address, kept for a rolling deploy by 0051, is gone (0074).
    const [old] = await fx.query<{ fn: string | null }>(
      `SELECT to_regprocedure('ops.api_key_authenticate(text)')::text AS fn`,
    );
    expect(old?.fn).toBeNull();
  });

  it('check what they are given as networks', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const refusals: [string, RegExp][] = [
      ['example.com', /not an IP address or network/],
      ['203.0.113.7/24', /did you mean 203\.0\.113\.0\/24\?/],
      ['2001:db8::1/32', /did you mean 2001:db8::\/32\?/],
      ['10.0.0.0/0', /accept every address/],
      ['10.0.0.0/33', /prefix length longer/],
      ['fe80::1%eth0', /not an IP address or network/],
      ['::ffff:203.0.113.7', /IPv4 address 203\.0\.113\.7/],
      [Array.from({ length: 21 }, (_, i) => `198.51.100.${i}`).join('\n'), /at most 20/],
    ];
    for (const [text, reason] of refusals) {
      await expectAppError(create(owner, text), 'validation_failed', reason);
    }
    // The same address written twice is listed once.
    const key = await create(owner, '203.0.113.7\n203.0.113.7/32');
    expect((await keyRow(key.id)).allowed_networks).toEqual(['203.0.113.7/32']);
    // Nothing was created by the refused requests.
    const [count] = await fx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.api_keys WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(count!.n).toBe(1);
  });

  it('change for an active key after a recent sign-in, audited, and carry over to the rotated key', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const key = await create(owner, '203.0.113.0/24');
    const audit = () =>
      fx.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM app.audit_events
          WHERE action = 'api_key.networks_changed' AND subject_id = $1 ORDER BY occurred_at, id`,
        [key.id],
      );

    expect(
      await keys.setAllowedNetworks(owner, {
        keyId: key.id,
        allowedNetworks: '203.0.113.0/24\n198.51.100.0/24',
      }),
    ).toEqual({ allowedNetworks: ['203.0.113.0/24', '198.51.100.0/24'] });
    expect(await from(key.token, '198.51.100.9')).toBe('accepted');
    // The same list again changes nothing and records nothing.
    await keys.setAllowedNetworks(owner, {
      keyId: key.id,
      allowedNetworks: '203.0.113.0/24, 198.51.100.0/24',
    });
    // Emptied, the key accepts any address.
    expect(await keys.setAllowedNetworks(owner, { keyId: key.id, allowedNetworks: '' })).toEqual({
      allowedNetworks: null,
    });
    expect(await from(key.token, null)).toBe('accepted');
    expect((await audit()).map((a) => a.metadata)).toEqual([
      {
        keyPrefix: key.keyPrefix,
        from: ['203.0.113.0/24'],
        to: ['203.0.113.0/24', '198.51.100.0/24'],
      },
      { keyPrefix: key.keyPrefix, from: ['203.0.113.0/24', '198.51.100.0/24'], to: null },
    ]);

    // A stale sign-in, a member who does not manage keys, another company and bad input.
    const stale: TenantContext = { ...owner, signedInAt: new Date(Date.now() - 16 * 60_000) };
    await expectAppError(
      keys.setAllowedNetworks(stale, { keyId: key.id, allowedNetworks: '203.0.113.0/24' }),
      'step_up_required',
    );
    await expectAppError(
      keys.setAllowedNetworks(await fx.ctx(c, c.agent), {
        keyId: key.id,
        allowedNetworks: '203.0.113.0/24',
      }),
      'forbidden',
    );
    await expectAppError(
      keys.setAllowedNetworks(await fx.ctx(other, other.owner), {
        keyId: key.id,
        allowedNetworks: '203.0.113.0/24',
      }),
      'not_found',
    );
    await expectAppError(
      keys.setAllowedNetworks(owner, { keyId: key.id, allowedNetworks: '203.0.113.7/24' }),
      'validation_failed',
    );
    expect((await keyRow(key.id)).allowed_networks).toBeNull();

    // Rotation keeps the networks.
    await keys.setAllowedNetworks(owner, { keyId: key.id, allowedNetworks: '2001:db8::/48' });
    const rotated = await keys.rotate(owner, { keyId: key.id, overlapHours: 0 });
    expect((await keyRow(rotated.id)).allowed_networks).toEqual(['2001:db8::/48']);
    expect(await from(rotated.token, '2001:db8::5')).toBe('accepted');
    expect(await from(rotated.token, '203.0.113.1')).toBe('refused');
    // The revoked old key's networks can no longer be changed.
    await expectAppError(
      keys.setAllowedNetworks(owner, { keyId: key.id, allowedNetworks: '' }),
      'conflict',
    );
    const listed = (await keys.list(owner)).find((k) => k.id === rotated.id);
    expect(listed?.allowedNetworks).toEqual(['2001:db8::/48']);
  });
});

describe('addresses for all keys (ADR-099)', () => {
  const create = (owner: TenantContext, allowedNetworks?: string) =>
    keys.create(owner, {
      name: 'Server',
      scopes: ['contacts.read'],
      expiresInDays: 30,
      ...(allowedNetworks === undefined ? {} : { allowedNetworks }),
    });
  const lastUsed = async (id: string) => {
    const [row] = await fx.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM app.api_keys WHERE id = $1',
      [id],
    );
    return row!.last_used_at;
  };
  const settingsRows = (tenantId: string) =>
    fx.query<{ allowed_networks: string[] | null }>(
      'SELECT allowed_networks::text[] AS allowed_networks FROM app.api_settings WHERE tenant_id = $1',
      [tenantId],
    );
  /** What a request with the token from `ip` gets: its key, whose addresses refused it, or nothing. */
  const from = async (token: string, ip: string | null) => {
    const auth = await authenticateApiRequest(fx.dbs.app, token, uuidv7(), ip);
    if (!auth) return 'unknown';
    return 'authenticated' in auth ? 'accepted' : `refused by the ${auth.by}`;
  };

  it('hold every key of the company to them, and a refused request does not use the key', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const key = await create(owner);
    const otherKey = await create(await fx.ctx(other, other.owner));
    expect(await keys.companyNetworks(owner)).toEqual({ allowedNetworks: null });
    expect(await settingsRows(c.tenant.id)).toEqual([]);

    const listed = ['203.0.113.0/24', '2001:db8::/32', '198.51.100.7/32'];
    expect(
      await keys.setCompanyNetworks(owner, {
        allowedNetworks: '203.0.113.0/24\n2001:db8::/32, 198.51.100.7 203.0.113.0/24',
      }),
    ).toEqual({ allowedNetworks: listed });
    expect(await keys.companyNetworks(owner)).toEqual({ allowedNetworks: listed });
    expect(await settingsRows(c.tenant.id)).toEqual([{ allowed_networks: listed }]);

    // Refused addresses leave the key unused.
    for (const ip of ['203.0.114.1', '198.51.100.8', '2001:db9::1', '10.0.0.1', null]) {
      expect(await from(key.token, ip), String(ip)).toBe('refused by the company');
    }
    expect(await lastUsed(key.id)).toBeNull();
    for (const ip of ['203.0.113.1', '198.51.100.7', '2001:db8::1', '::ffff:203.0.113.9']) {
      expect(await from(key.token, ip), ip).toBe('accepted');
    }
    expect(await lastUsed(key.id)).not.toBeNull();
    // A key created later is held to them too; another company's keys are not.
    const later = await create(owner);
    expect(await from(later.token, '10.0.0.1')).toBe('refused by the company');
    expect(await from(otherKey.token, '10.0.0.1')).toBe('accepted');
    expect(await authenticateApiToken(fx.dbs.app, later.token, 'r', '10.0.0.1')).toBeNull();
    expect(await authenticateApiToken(fx.dbs.app, later.token, 'r', '203.0.113.1')).not.toBeNull();

    // Emptied, the company's keys accept any address again, and none.
    expect(await keys.setCompanyNetworks(owner, { allowedNetworks: ' \n ' })).toEqual({
      allowedNetworks: null,
    });
    expect(await from(key.token, '10.0.0.1')).toBe('accepted');
    expect(await from(key.token, null)).toBe('accepted');
    expect(await settingsRows(c.tenant.id)).toEqual([{ allowed_networks: null }]);
  });

  it("accept a key's requests only from addresses on both lists when the key lists its own", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const key = await create(owner, '203.0.113.0/24\n198.51.100.0/24');
    await keys.setCompanyNetworks(owner, { allowedNetworks: '198.51.100.0/24\n192.0.2.0/24' });
    expect(await from(key.token, '198.51.100.9')).toBe('accepted');
    // The key's own list is checked first.
    expect(await from(key.token, '203.0.113.9')).toBe('refused by the company');
    expect(await from(key.token, '192.0.2.9')).toBe('refused by the key');
    expect(await from(key.token, '10.0.0.1')).toBe('refused by the key');
    expect(await from(key.token, null)).toBe('refused by the key');
  });

  it('change after a recent sign-in, by members who manage keys, audited and kept to the company', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const audit = async () =>
      (
        await fx.query<{ subject_type: string; subject_id: string; metadata: unknown }>(
          `SELECT subject_type, subject_id, metadata FROM app.audit_events
            WHERE action = 'api.networks_changed' AND tenant_id = $1 ORDER BY occurred_at, id`,
          [c.tenant.id],
        )
      ).map((a) => [a.subject_type, a.subject_id, a.metadata]);

    await keys.setCompanyNetworks(owner, { allowedNetworks: '203.0.113.0/24' });
    await keys.setCompanyNetworks(owner, { allowedNetworks: '203.0.113.0/24\n198.51.100.0/24' });
    // The same list again changes nothing and records nothing.
    await keys.setCompanyNetworks(owner, { allowedNetworks: '203.0.113.0/24, 198.51.100.0/24' });
    await keys.setCompanyNetworks(owner, { allowedNetworks: '' });
    expect(await audit()).toEqual([
      ['tenant', c.tenant.id, { from: null, to: ['203.0.113.0/24'] }],
      [
        'tenant',
        c.tenant.id,
        { from: ['203.0.113.0/24'], to: ['203.0.113.0/24', '198.51.100.0/24'] },
      ],
      ['tenant', c.tenant.id, { from: ['203.0.113.0/24', '198.51.100.0/24'], to: null }],
    ]);

    // A stale sign-in, a member who does not manage keys, and bad input change nothing.
    const stale: TenantContext = { ...owner, signedInAt: new Date(Date.now() - 16 * 60_000) };
    await expectAppError(
      keys.setCompanyNetworks(stale, { allowedNetworks: '203.0.113.0/24' }),
      'step_up_required',
    );
    const agent = await fx.ctx(c, c.agent);
    await expectAppError(
      keys.setCompanyNetworks(agent, { allowedNetworks: '203.0.113.0/24' }),
      'forbidden',
    );
    await expectAppError(keys.companyNetworks(agent), 'forbidden');
    const refusals: [string, RegExp][] = [
      ['example.com', /not an IP address or network/],
      ['203.0.113.7/24', /did you mean 203\.0\.113\.0\/24\?/],
      ['10.0.0.0/0', /accept every address/],
      [Array.from({ length: 21 }, (_, i) => `198.51.100.${i}`).join('\n'), /at most 20/],
    ];
    for (const [text, reason] of refusals) {
      await expectAppError(
        keys.setCompanyNetworks(owner, { allowedNetworks: text }),
        'validation_failed',
        reason,
      );
    }
    expect(await settingsRows(c.tenant.id)).toEqual([{ allowed_networks: null }]);
    expect(await audit()).toHaveLength(3);

    // Each company's addresses are its own, for the service and for the runtime role.
    await keys.setCompanyNetworks(await fx.ctx(other, other.owner), {
      allowedNetworks: '192.0.2.0/24',
    });
    expect(await keys.companyNetworks(owner)).toEqual({ allowedNetworks: null });
    const inCompany = (tenantId: string, query: ReturnType<typeof sql>) =>
      fx.dbs.app.run(authorizedTenantScope(tenantId, null), async (tx) => {
        const res = await tx.execute<{ allowed_networks: string[] | null }>(query);
        return res.rows;
      });
    expect(
      await inCompany(
        c.tenant.id,
        sql`select allowed_networks::text[] as allowed_networks from app.api_settings`,
      ),
    ).toEqual([{ allowed_networks: null }]);
    expect(
      await inCompany(
        c.tenant.id,
        sql`update app.api_settings set allowed_networks = null where tenant_id = ${other.tenant.id}::uuid returning allowed_networks`,
      ),
    ).toEqual([]);
    expect(await settingsRows(other.tenant.id)).toEqual([{ allowed_networks: ['192.0.2.0/24'] }]);
    await expect(inCompany(c.tenant.id, sql`delete from app.api_settings`)).rejects.toThrow();
    // The table refuses an empty list (none is NULL) and more than 20 networks.
    for (const value of [
      '{}',
      `{${Array.from({ length: 21 }, (_, i) => `198.51.100.${i}`).join(',')}}`,
    ]) {
      await expect(
        fx.dbs.adminPool.query(
          'UPDATE app.api_settings SET allowed_networks = $2::cidr[] WHERE tenant_id = $1',
          [c.tenant.id, value],
        ),
      ).rejects.toThrow(/api_settings_allowed_networks_check/);
    }
  });

  it('let two first changes at once make one row, one after the other', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    // Another transaction holds the company's key lock while both changes come.
    const holder = await fx.dbs.adminPool.connect();
    let changes: Promise<unknown>[] | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `api-keys:${c.tenant.id}`,
      ]);
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      changes = ['203.0.113.0/24', '198.51.100.0/24'].map((allowedNetworks) =>
        keys.setCompanyNetworks(owner, { allowedNetworks }),
      );
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [lock!.pid],
          );
          if (waiting!.n < 2) throw new Error('the changes are not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    const results = await Promise.allSettled(changes ?? []);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await settingsRows(c.tenant.id);
    expect(rows).toHaveLength(1);
    const entries = await fx.query<{ metadata: { from: string[] | null; to: string[] | null } }>(
      `SELECT metadata FROM app.audit_events
        WHERE action = 'api.networks_changed' AND tenant_id = $1`,
      [c.tenant.id],
    );
    // The second change saw the first: its "from" is the first's "to". (Both transactions began
    // before either took the lock, so their audit times need not follow the order they ran in.)
    expect(entries).toHaveLength(2);
    const first = entries.find((e) => e.metadata.from === null);
    const second = entries.find((e) => e !== first);
    expect(first).toBeDefined();
    expect(second!.metadata.from).toEqual(first!.metadata.to);
    expect(rows[0]!.allowed_networks).toEqual(second!.metadata.to);
  });
});

describe('automations started through the API (ADR-077)', () => {
  /** An appointment reminder with two quick replies. */
  const appointmentReminder: TemplateDefinition = {
    category: 'UTILITY',
    header: { type: 'none' },
    body: {
      text: 'Hi {{1}}, your appointment is at {{2}}. Please confirm.',
      examples: ['Asha', '5 pm today'],
    },
    footer: null,
    buttons: [
      { type: 'QUICK_REPLY', text: 'Confirm' },
      { type: 'QUICK_REPLY', text: 'Reschedule' },
    ],
  };
  const apiTrigger: AutomationTrigger = { type: 'api', inputs: ['patient', 'appointment_time'] };
  const inputs = { patient: 'Asha', appointment_time: '5 pm today' };

  /** Reminds with the template; "Confirm" thanks the contact, any other reply goes to people. */
  const reminderFlow = (templateId: string) => ({
    version: 1,
    start: 'remind',
    nodes: [
      {
        id: 'remind',
        type: 'ask_template',
        templateId,
        header: [],
        body: ['{{input.patient}}', '{{input.appointment_time}}'],
        buttons: [
          { index: 0, title: 'Confirm', next: 'thanks' },
          { index: 1, title: 'Reschedule', next: 'people' },
        ],
        saveAs: 'choice',
        replyNext: 'people',
        timeoutMinutes: 60,
        timeoutNext: null,
      },
      {
        id: 'thanks',
        type: 'send_text',
        text: 'Thanks {{input.patient}}, see you at {{input.appointment_time}}.',
        next: null,
      },
      { id: 'people', type: 'handoff', teamId: null },
    ],
  });

  const automationService = () =>
    createAutomationService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });

  async function save(
    owner: TenantContext,
    name: string,
    trigger: AutomationTrigger,
    graph: unknown,
    channelAccountId: string | null,
  ) {
    const svc = automationService();
    const { id } = await svc.createAutomation(owner, { name });
    const saved = await svc.updateAutomation(owner, {
      id,
      expectedVersion: 0,
      name,
      description: null,
      channelAccountId,
      trigger,
      graph,
    });
    return { id, version: saved.version, issues: saved.issues };
  }

  async function publish(
    owner: TenantContext,
    name: string,
    trigger: AutomationTrigger,
    graph: unknown,
    channelAccountId: string | null,
  ) {
    const saved = await save(owner, name, trigger, graph, channelAccountId);
    expect(saved.issues).toEqual([]);
    const published = await automationService().publishAutomation(owner, {
      id: saved.id,
      expectedVersion: saved.version,
      note: null,
    });
    return { id: saved.id, version: published.version };
  }

  const runRow = async (id: string) => {
    const [row] = await fx.query<{
      status: string;
      end_reason: string | null;
      end_detail: string | null;
      mode: string;
      trigger_type: string;
      api_key_id: string | null;
      variables: Record<string, string>;
      conversation_id: string;
      contact_id: string;
    }>(
      `SELECT status, end_reason, end_detail, mode, trigger_type, api_key_id, variables,
              conversation_id, contact_id
         FROM app.automation_runs WHERE id = $1`,
      [id],
    );
    if (!row) throw new Error('run not found');
    return row;
  };

  /**
   * Advances a run the way the worker does, handing each message it queues to the send worker (the
   * stand-in accepts it), until it waits with nothing in flight or ends. Returns the run's status.
   */
  async function driveRun(c: Company, runId: string) {
    for (let i = 0; i < 20; i += 1) {
      const result = await advanceAutomationRun(
        { ...deps(), keyring: fx.keyring },
        authorizedTenantScope(c.tenant.id, null),
        runId,
        null,
      );
      const sent = await sendAll(c);
      if (sent.length === 0 && result.outcome !== 'sending') return (await runRow(runId)).status;
    }
    throw new Error('the run did not settle');
  }

  /** Templates and texts the stand-in received for a number. */
  const templateSends = (to: string) =>
    templatesTo(to).flatMap((r) => {
      const template = (r.body as { template?: { name: string; components: unknown[] } }).template;
      return template ? [template] : [];
    });
  const textsTo = (to: string) =>
    templatesTo(to).flatMap((r) => {
      const text = (r.body as { text?: { body: string } }).text;
      return text ? [text.body] : [];
    });
  const bodyTexts = (template: { components: unknown[] } | undefined) =>
    (
      (template?.components ?? []).find((x) => (x as { type: string }).type === 'body') as
        { parameters: { text: string }[] } | undefined
    )?.parameters.map((p) => p.text);

  const reasonOf = (error: unknown) => apiErrorResponse(error, 'r').body.error.reason;
  async function refusedWith(
    promise: Promise<unknown>,
    code: string,
    reason: string | undefined,
    message?: RegExp,
  ) {
    const error = await expectAppError(promise, code, message);
    expect(reasonOf(error)).toBe(reason);
  }

  let planCodes = 0;
  /** Puts the company on a published plan with the given terms (P5-01), as platform staff would. */
  async function onPlan(c: Company, overrides: Record<string, unknown>) {
    const staff = await createUser(fx.dbs, { twoFactor: true });
    await fx.dbs.ownerPool.query(
      `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_owner')`,
      [staff.id],
    );
    const actor: PlatformActor = {
      userId: staff.id,
      role: 'platform_owner',
      correlationId: uuidv7(),
    };
    const plans = createPlanAdminService({ platformDb: fx.dbs.platform, clock: systemClock });
    planCodes += 1;
    const { id } = await plans.createPlan(actor, {
      code: `auto-api-${Date.now().toString(36)}-${planCodes}`,
      name: 'Automation plan',
      price: '999',
      intervalMonths: '1',
      trialDays: '0',
      graceDays: '7',
      seatsIncluded: '10',
      numbersIncluded: '5',
      modules: ['automations'],
      ...overrides,
    });
    await plans.publishPlan(actor, id);
    const view = await plans.tenantPlan(actor, c.tenant.id);
    await plans.setTenantPlan(actor, {
      tenantId: c.tenant.id,
      version: view.state.version,
      status: 'active',
      planId: id,
      periodStart: dayOf(new Date(), 'Asia/Kolkata'),
      periodEnd: dayOf(new Date(Date.now() + 30 * 86_400_000), 'Asia/Kolkata'),
      reason: 'Plan for the API automation tests',
    });
  }

  it('fill the ends of a template’s links from the inputs, and fail a run whose end the link cannot take (ADR-229)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, {
      category: 'UTILITY',
      header: { type: 'none' },
      body: { text: 'Hi {{1}}, manage your booking below.', examples: ['Asha'] },
      footer: null,
      buttons: [
        {
          type: 'URL',
          text: 'Manage booking',
          url: 'https://clinic.example/booking/{{1}}',
          example: 'B-1',
        },
      ],
    });
    const trigger: AutomationTrigger = { type: 'api', inputs: ['patient', 'booking'] };
    const graph = (links: string[]) => ({
      version: 1,
      start: 'send',
      nodes: [
        {
          id: 'send',
          type: 'send_template',
          templateId: template.id,
          header: [],
          body: ['{{input.patient}}'],
          links,
          next: null,
        },
      ],
    });
    // A step that leaves the link's end out does not pass the checks.
    const unfinished = await save(owner, 'No link', trigger, graph([]), c.channelAccountId);
    expect(unfinished.issues.map((i) => i.message)).toContain(
      `The template “${template.name}” has 2 variables: fill in each one.`,
    );
    const flow = await publish(
      owner,
      'Booking link',
      trigger,
      graph(['{{input.booking}}']),
      c.channelAccountId,
    );
    const { ctx } = await apiKey(c, ['automations.start'], 'Clinic system');
    const start = async (to: string, booking: string, key: string) =>
      (
        await apiStartAutomationRun(
          deps(),
          ctx,
          flow.id,
          { to, inputs: { patient: 'Asha', booking } },
          idem(key, key),
        )
      ).body.data as ApiAutomationRun;

    const good = await start('+91 98111 70001', 'B-42', 'link-run-1');
    expect(await driveRun(c, good.id)).toBe('completed');
    expect(templateSends('919811170001')[0]?.components).toContainEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'B-42' }],
    });
    // An end with a space: nothing is sent and the run says why.
    const bad = await start('+91 98111 70002', 'B 43', 'link-run-2');
    expect(await driveRun(c, bad.id)).toBe('failed');
    expect(await runRow(bad.id)).toMatchObject({
      end_reason: 'send_blocked',
      end_detail: 'invalid_link',
    });
    expect(templateSends('919811170002')).toEqual([]);
  });

  it('start a published automation for a contact once per Idempotency-Key, with its inputs, and follow the contact’s tap', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, appointmentReminder);
    const flow = await publish(
      owner,
      'Appointment reminder',
      apiTrigger,
      reminderFlow(template.id),
      c.channelAccountId,
    );
    // Drafts, archived automations and automations started otherwise are not listed.
    await save(owner, 'Draft only', apiTrigger, reminderFlow(template.id), c.channelAccountId);
    await publish(
      owner,
      'Brochure',
      {
        type: 'keyword',
        keywords: ['brochure'],
        match: 'contains',
        hours: 'any',
        cooldownMinutes: 0,
      },
      {
        version: 1,
        start: 'hi',
        nodes: [{ id: 'hi', type: 'send_text', text: 'Here it is.', next: null }],
      },
      null,
    );
    const { ctx, id: keyId } = await apiKey(c, ['automations.start'], 'Booking system');
    expect((await apiListAutomations(deps(), ctx, {})).data).toEqual([
      {
        id: flow.id,
        name: 'Appointment reminder',
        status: 'active',
        inputs: ['patient', 'appointment_time'],
        channelId: c.channelAccountId,
        phoneNumber: '+91 90000 00000',
        createdAt: expect.any(String),
      },
    ]);

    const input = { to: '+91 98111 00060', inputs };
    const first = await apiStartAutomationRun(deps(), ctx, flow.id, input, idem('run-1', 'run-1'));
    expect(first.status).toBe(201);
    const started = first.body.data as ApiAutomationRun;
    expect(started).toEqual({
      id: expect.any(String),
      automationId: flow.id,
      contactId: expect.any(String),
      conversationId: expect.any(String),
      channelId: c.channelAccountId,
      status: 'running',
      endReason: null,
      startedAt: expect.any(String),
      endedAt: null,
    });
    // A retry replays the first answer and starts nothing more.
    expect(
      await apiStartAutomationRun(deps(), ctx, flow.id, input, idem('run-1', 'run-1')),
    ).toEqual({ ...first, replayed: true });
    expect(await runRow(started.id)).toMatchObject({
      status: 'running',
      mode: 'live',
      trigger_type: 'api',
      api_key_id: keyId,
      variables: { 'input.patient': 'Asha', 'input.appointment_time': '5 pm today' },
      conversation_id: started.conversationId,
      contact_id: started.contactId,
    });
    // The contact is new, from the API; the conversation starts resolved, out of the inbox.
    const [contact] = await fx.query<{ source: string; phone_e164: string }>(
      'SELECT source, phone_e164 FROM app.contacts WHERE id = $1',
      [started.contactId],
    );
    expect(contact).toEqual({ source: 'api', phone_e164: '+919811100060' });
    const [thread] = await fx.query<{ status: string; last_inbound_at: Date | null }>(
      'SELECT status, last_inbound_at FROM app.conversations WHERE id = $1',
      [started.conversationId],
    );
    expect(thread).toEqual({ status: 'resolved', last_inbound_at: null });
    // Audited as the key, without the inputs.
    expect(
      await fx.query(
        `SELECT actor_type, actor_id, correlation_id, metadata FROM app.audit_events
          WHERE tenant_id = $1 AND action = 'automation.run_started' AND subject_id = $2`,
        [c.tenant.id, started.id],
      ),
    ).toEqual([
      {
        actor_type: 'api_key',
        actor_id: keyId,
        correlation_id: ctx.requestId,
        metadata: { automationId: flow.id, source: 'api' },
      },
    ]);

    // Starts for the same number at once: one run, the other is refused as busy.
    const both = await Promise.allSettled([
      apiStartAutomationRun(
        deps(),
        ctx,
        flow.id,
        { ...input, to: '+919811100061' },
        idem('a', 'a'),
      ),
      apiStartAutomationRun(
        deps(),
        ctx,
        flow.id,
        { ...input, to: '+919811100061' },
        idem('b', 'b'),
      ),
    ]);
    expect(
      both.map((r) => (r.status === 'fulfilled' ? 'started' : reasonOf(r.reason))).sort(),
    ).toEqual(['automation_busy', 'started']);

    // The template goes out from the automation's number with the inputs and a payload per button.
    expect(await driveRun(c, started.id)).toBe('waiting');
    const [sent] = templateSends('919811100060');
    expect(sent?.name).toBe(template.name);
    expect(bodyTexts(sent)).toEqual(['Asha', '5 pm today']);
    expect(sent?.components.filter((x) => (x as { type: string }).type === 'button')).toEqual([
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: botButtonId(started.id, 'remind', 1, 0) }],
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '1',
        parameters: [{ type: 'payload', payload: botButtonId(started.id, 'remind', 1, 1) }],
      },
    ]);
    expect(await apiGetAutomationRun(deps(), ctx, started.id)).toMatchObject({
      id: started.id,
      status: 'waiting',
      endReason: null,
      endedAt: null,
    });

    // The contact taps "Confirm": the conversation opens and the run continues.
    const [bot] = await fx.query<{
      external_message_id: string;
      content: { rendered: { body: string } };
    }>(
      `SELECT external_message_id, content FROM app.messages
        WHERE conversation_id = $1 AND sender_type = 'bot'`,
      [started.conversationId],
    );
    expect(bot?.content.rendered.body).toBe(
      'Hi Asha, your appointment is at 5 pm today. Please confirm.',
    );
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [
          {
            waId: '919811100060',
            type: 'button',
            extra: {
              button: { payload: botButtonId(started.id, 'remind', 1, 0), text: 'Confirm' },
              context: { from: '919000000000', id: bot!.external_message_id },
            },
          },
        ],
      }),
    );
    expect(await driveRun(c, started.id)).toBe('completed');
    expect(textsTo('919811100060')).toEqual(['Thanks Asha, see you at 5 pm today.']);
    expect(await apiGetAutomationRun(deps(), ctx, started.id)).toMatchObject({
      status: 'completed',
      endReason: 'no_next',
      endedAt: expect.any(String),
    });
    expect((await runRow(started.id)).variables).toEqual({
      'input.patient': 'Asha',
      'input.appointment_time': '5 pm today',
      choice: 'Confirm',
    });
    // A message from the contact never starts an automation started through the API.
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919811100060', text: 'thanks!' }] }));
    expect(
      await fx.query('SELECT 1 FROM app.automation_runs WHERE conversation_id = $1', [
        started.conversationId,
      ]),
    ).toHaveLength(1);

    // Members see which key started it, with the inputs among the answers.
    expect(await automationService().getRun(owner, started.id)).toMatchObject({
      triggerType: 'api',
      apiKeyName: 'Booking system',
      variables: { 'input.patient': 'Asha', choice: 'Confirm' },
    });
    // Any key of the company with the scope reads the run; another company's key does not.
    const reports = await apiKey(c, ['automations.start'], 'Reports');
    expect((await apiGetAutomationRun(deps(), reports.ctx, started.id)).id).toBe(started.id);
    const other = await fx.company();
    const theirs = await apiKey(other, ['automations.start']);
    await expectAppError(apiGetAutomationRun(deps(), theirs.ctx, started.id), 'not_found');
    await expectAppError(
      apiStartAutomationRun(deps(), theirs.ctx, flow.id, input, idem('x', 'x')),
      'not_found',
    );
    expect((await apiListAutomations(deps(), theirs.ctx, {})).data).toEqual([]);
  });

  it('refuse, changing nothing, what the key, the automation, the contact or the conversation does not allow', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, appointmentReminder);
    const flow = await publish(
      owner,
      'Reminder',
      apiTrigger,
      reminderFlow(template.id),
      c.channelAccountId,
    );
    const { ctx } = await apiKey(c, ['automations.start', 'contacts.write']);
    let n = 0;
    const start = (automationId: string, body: Record<string, unknown>) => {
      n += 1;
      return apiStartAutomationRun(deps(), ctx, automationId, body, idem(`r-${n}`, `r-${n}`));
    };
    const runs = async () =>
      (
        await fx.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM app.automation_runs WHERE tenant_id = $1',
          [c.tenant.id],
        )
      )[0]!.n;
    const to = '+919811100070';

    // The scope, for reading as for starting.
    const narrow = await apiKey(c, ['contacts.read']);
    await expectAppError(
      apiListAutomations(deps(), narrow.ctx, {}),
      'forbidden',
      /automations\.start/,
    );
    await expectAppError(
      apiStartAutomationRun(deps(), narrow.ctx, flow.id, { to, inputs }, idem('s', 's')),
      'forbidden',
    );
    await expectAppError(apiGetAutomationRun(deps(), narrow.ctx, uuidv7()), 'forbidden');
    await expectAppError(start(uuidv7(), { to, inputs }), 'not_found');
    await expectAppError(start('not-a-uuid', { to, inputs }), 'not_found');
    await expectAppError(apiGetAutomationRun(deps(), ctx, 'not-a-uuid'), 'not_found');

    // Every declared input, as text, and nothing else.
    await expectAppError(
      start(flow.id, { to, inputs: { patient: 'Ravi' } }),
      'validation_failed',
      /Give the input “appointment_time” a value/,
    );
    await expectAppError(
      start(flow.id, { to, inputs: { ...inputs, room: '4' } }),
      'validation_failed',
      /no input named “room”/,
    );
    await expectAppError(
      start(flow.id, { to, inputs: { ...inputs, patient: 'x'.repeat(1001) } }),
      'validation_failed',
      /limited to 1000 characters/,
    );
    await expectAppError(start(flow.id, { to: '12345', inputs }), 'validation_failed');
    await expectAppError(
      start(flow.id, { to, inputs, from: c.channelAccountId }),
      'validation_failed',
    );

    // An automation that is not published, archived, started otherwise or paused.
    const draft = await save(
      owner,
      'Draft',
      apiTrigger,
      reminderFlow(template.id),
      c.channelAccountId,
    );
    await refusedWith(
      start(draft.id, { to, inputs }),
      'precondition_failed',
      'automation_unavailable',
      /not been published/,
    );
    const keyword = await publish(
      owner,
      'Brochure',
      {
        type: 'keyword',
        keywords: ['brochure'],
        match: 'contains',
        hours: 'any',
        cooldownMinutes: 0,
      },
      { version: 1, start: 'hi', nodes: [{ id: 'hi', type: 'send_text', text: 'Hi', next: null }] },
      null,
    );
    await refusedWith(
      start(keyword.id, { to, inputs: {} }),
      'precondition_failed',
      'automation_unavailable',
      /does not start through the API/,
    );
    const svc = automationService();
    const old = await publish(
      owner,
      'Old',
      apiTrigger,
      reminderFlow(template.id),
      c.channelAccountId,
    );
    await svc.archiveAutomation(owner, { id: old.id, expectedVersion: old.version });
    await refusedWith(
      start(old.id, { to, inputs }),
      'precondition_failed',
      'automation_unavailable',
      /archived/,
    );
    const paused = await svc.setAutomationStatus(owner, {
      id: flow.id,
      expectedVersion: flow.version,
      status: 'paused',
    });
    await refusedWith(start(flow.id, { to, inputs }), 'precondition_failed', 'automation_paused');
    expect((await apiListAutomations(deps(), ctx, {})).data.map((a) => [a.id, a.status])).toEqual([
      [flow.id, 'paused'],
    ]);
    await svc.setAutomationStatus(owner, {
      id: flow.id,
      expectedVersion: paused.version,
      status: 'active',
    });

    // Marketing templates need the key's marketing scope; the step checks consent when it sends.
    const promo = await approvedTemplate(c, festiveSale);
    const promoFlow = await publish(
      owner,
      'Festive sale',
      { type: 'api', inputs: ['first_name'] },
      {
        version: 1,
        start: 'sale',
        nodes: [
          {
            id: 'sale',
            type: 'send_template',
            templateId: promo.id,
            header: [],
            body: ['{{input.first_name}}'],
            next: null,
          },
        ],
      },
      c.channelAccountId,
    );
    await expectAppError(
      start(promoFlow.id, { to: '+919811100071', inputs: { first_name: 'Asha' } }),
      'forbidden',
      /messages\.send_marketing/,
    );

    // The suppression list, opt-outs and the number.
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    await consent.addSuppression(owner, { phone: '+919811100072', reason: 'legal' });
    await expectAppError(
      start(flow.id, { to: '+919811100072', inputs }),
      'precondition_failed',
      /suppression list/,
    );
    expect(
      await fx.query('SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2', [
        c.tenant.id,
        '+919811100072',
      ]),
    ).toHaveLength(0);
    const optedOut = await apiCreateContact(deps(), ctx, { phone: '+919811100073' }, null);
    await apiRecordConsent(deps(), ctx, (optedOut.body.data as { id: string }).id, {
      purpose: 'utility',
      action: 'opt_out',
      evidence: 'Asked us by email to stop reminders',
    });
    await expectAppError(start(flow.id, { to: '+919811100073', inputs }), 'precondition_failed');
    await fx.query(`UPDATE app.channel_accounts SET status = 'disconnected' WHERE id = $1`, [
      c.channelAccountId,
    ]);
    try {
      await refusedWith(
        start(flow.id, { to, inputs }),
        'precondition_failed',
        'channel_unavailable',
        /not active/,
      );
    } finally {
      await fx.query(`UPDATE app.channel_accounts SET status = 'active' WHERE id = $1`, [
        c.channelAccountId,
      ]);
    }
    expect(await runs()).toBe(0);

    // With the marketing scope the run starts; without the contact's opt-in its template is not sent.
    const marketer = await apiKey(c, ['automations.start', 'messages.send_marketing']);
    // The key's marketing scope counts only while the company's plan includes it (ADR-092).
    const refusedByPlan = await expectAppError(
      apiStartAutomationRun(
        deps(),
        { ...marketer.ctx, planScopes: new Set<ApiScope>(['automations.start']) },
        promoFlow.id,
        { to: '+919811100071', inputs: { first_name: 'Asha' } },
        idem('p-plan', 'p-plan'),
      ),
      'forbidden',
      /^Your company's plan does not include the messages\.send_marketing scope\./,
    );
    expect(isAppError(refusedByPlan) && refusedByPlan.details).toEqual({
      apiReason: 'not_in_plan',
    });
    expect(await runs()).toBe(0);
    const promoRun = await apiStartAutomationRun(
      deps(),
      marketer.ctx,
      promoFlow.id,
      { to: '+919811100071', inputs: { first_name: 'Asha' } },
      idem('p', 'p'),
    );
    const promoRunId = (promoRun.body.data as ApiAutomationRun).id;
    expect(await driveRun(c, promoRunId)).toBe('failed');
    expect(await runRow(promoRunId)).toMatchObject({
      end_reason: 'send_blocked',
      end_detail: 'no_marketing_opt_in',
    });
    expect(templateSends('919811100071')).toEqual([]);

    // A conversation assigned to a member, or handled by another run.
    await inbound(c, '919811100074', [{ text: 'Hello' }]);
    const assigned = await conversationOf(c, '919811100074');
    const agent = await fx.ctx(c, c.agent);
    await inbox().assign(owner, {
      conversationId: assigned.id,
      membershipId: agent.membership.id,
      expectedVersion: assigned.version,
    });
    await refusedWith(
      start(flow.id, { to: '+919811100074', inputs }),
      'conflict',
      'conversation_assigned',
    );
    const busy = await start(flow.id, { to: '+919811100075', inputs });
    await refusedWith(
      start(flow.id, { to: '+919811100075', inputs }),
      'conflict',
      'automation_busy',
    );

    // At most maxRunsPerConversationPerHour runs start in a conversation in an hour.
    await svc.stopRun(owner, (busy.body.data as ApiAutomationRun).id);
    for (let i = 1; i < RUN_BUDGETS.maxRunsPerConversationPerHour; i += 1) {
      const again = await start(flow.id, { to: '+919811100075', inputs });
      await svc.stopRun(owner, (again.body.data as ApiAutomationRun).id);
    }
    await refusedWith(
      start(flow.id, { to: '+919811100075', inputs }),
      'conflict',
      'automation_limit',
    );
  });

  it('refuse starts the company’s plan does not allow', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, appointmentReminder);
    const flow = await publish(
      owner,
      'Reminder',
      apiTrigger,
      reminderFlow(template.id),
      c.channelAccountId,
    );
    const { ctx } = await apiKey(c, ['automations.start']);
    await onPlan(c, { automationRunsMonthly: '1' });
    const first = await apiStartAutomationRun(
      deps(),
      ctx,
      flow.id,
      { to: '+919811100080', inputs },
      idem('q-1', 'q-1'),
    );
    expect(first.status).toBe(201);
    await refusedWith(
      apiStartAutomationRun(
        deps(),
        ctx,
        flow.id,
        { to: '+919811100081', inputs },
        idem('q-2', 'q-2'),
      ),
      'precondition_failed',
      'automation_quota',
      /no automation runs left/,
    );
    // The refused start leaves no contact behind.
    expect(
      await fx.query('SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2', [
        c.tenant.id,
        '+919811100081',
      ]),
    ).toHaveLength(0);
    await onPlan(c, { modules: [] });
    await refusedWith(
      apiStartAutomationRun(
        deps(),
        ctx,
        flow.id,
        { to: '+919811100082', inputs },
        idem('q-3', 'q-3'),
      ),
      'forbidden',
      'not_in_plan',
      /does not include automations/,
    );
  });

  it('start an automation for many contacts in one call, each start answered in its place and a refused one changing nothing (ADR-161)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, appointmentReminder);
    const flow = await publish(
      owner,
      'Reminder',
      apiTrigger,
      reminderFlow(template.id),
      c.channelAccountId,
    );
    const { ctx } = await apiKey(c, ['automations.start', 'contacts.write']);
    let n = 0;
    const startMany = (runs: unknown[]) => {
      n += 1;
      return apiStartManyAutomationRuns(deps(), ctx, flow.id, { runs }, idem(`m-${n}`, `m-${n}`));
    };
    const runRows = () =>
      fx.query<{ contact_id: string; variables: Record<string, string> }>(
        `SELECT contact_id, variables FROM app.automation_runs
          WHERE tenant_id = $1 ORDER BY started_at, id`,
        [c.tenant.id],
      );
    const contactOf = async (phone: string) =>
      (
        await fx.query<{ id: string }>(
          'SELECT id FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2',
          [c.tenant.id, phone],
        )
      )[0]?.id ?? null;

    // A contact on the suppression list, one who opted out, one another run handles and one whose
    // conversation a member holds.
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    await consent.addSuppression(owner, { phone: '+919811100091', reason: 'legal' });
    const optedOut = await apiCreateContact(deps(), ctx, { phone: '+919811100092' }, null);
    await apiRecordConsent(deps(), ctx, (optedOut.body.data as { id: string }).id, {
      purpose: 'utility',
      action: 'opt_out',
      evidence: 'Asked us by email to stop reminders',
    });
    await apiStartAutomationRun(
      deps(),
      ctx,
      flow.id,
      { to: '+919811100093', inputs },
      idem('busy', 'busy'),
    );
    await inbound(c, '919811100094', [{ text: 'Hello' }]);
    const assigned = await conversationOf(c, '919811100094');
    const agent = await fx.ctx(c, c.agent);
    await inbox().assign(owner, {
      conversationId: assigned.id,
      membershipId: agent.membership.id,
      expectedVersion: assigned.version,
    });
    const before = (await runRows()).length;

    const patient = (name: string) => ({ patient: name, appointment_time: '5 pm today' });
    const body = {
      runs: [
        { to: '+91 98111 00090', inputs: patient('Asha') },
        { to: '+919811100091', inputs: patient('Ravi') },
        { to: '+919811100092', inputs: patient('Meena') },
        { to: '+919811100093', inputs: patient('Kiran') },
        { to: '+919811100094', inputs: patient('Joseph') },
        { to: '+919811100095', inputs: patient('Fatima') },
      ],
    };
    const call = () =>
      apiStartManyAutomationRuns(deps(), ctx, flow.id, body, idem('m-0', JSON.stringify(body)));
    const answer = await call();
    expect(answer.status).toBe(200);
    const starts = (answer.body as { data: ApiAutomationRunStart[] }).data;
    const started = (to: string) => ({
      to,
      run: expect.objectContaining({
        automationId: flow.id,
        channelId: c.channelAccountId,
        status: 'running',
        endReason: null,
      }),
      error: null,
    });
    expect(starts).toEqual([
      started('+919811100090'),
      {
        to: '+919811100091',
        run: null,
        error: { code: 'precondition_failed', message: expect.stringMatching(/suppression list/) },
      },
      {
        to: '+919811100092',
        run: null,
        error: { code: 'precondition_failed', message: expect.any(String) },
      },
      {
        to: '+919811100093',
        run: null,
        error: { code: 'conflict', reason: 'automation_busy', message: expect.any(String) },
      },
      {
        to: '+919811100094',
        run: null,
        error: { code: 'conflict', reason: 'conversation_assigned', message: expect.any(String) },
      },
      started('+919811100095'),
    ]);
    // Each run started is its contact's, with its own inputs; a refused start left no contact.
    const rows = (await runRows()).slice(before);
    expect(rows.map((r) => r.variables['input.patient'])).toEqual(['Asha', 'Fatima']);
    expect(rows.map((r) => r.contact_id)).toEqual([
      await contactOf('+919811100090'),
      await contactOf('+919811100095'),
    ]);
    expect(starts[0]?.run?.contactId).toBe(await contactOf('+919811100090'));
    expect(await contactOf('+919811100091')).toBeNull();
    // A retry answers as the first call did and starts nothing more.
    expect(await call()).toEqual({ ...answer, replayed: true });
    expect(await runRows()).toHaveLength(before + 2);

    // Refused as a whole, starting nothing: a number twice, inputs the automation does not take,
    // and a paused automation.
    await expectAppError(
      startMany([
        { to: '+919811100096', inputs },
        { to: '+91 98111 00096', inputs },
      ]),
      'validation_failed',
      /Give each number once/,
    );
    const badInputs = await expectAppError(
      startMany([
        { to: '+919811100096', inputs },
        { to: '+919811100097', inputs: { patient: 'Ravi' } },
      ]),
      'validation_failed',
      /appointment_time/,
    );
    expect(isAppError(badInputs) && badInputs.issues?.map((i) => i.path)).toEqual([
      'runs.1.inputs',
    ]);
    await automationService().setAutomationStatus(owner, {
      id: flow.id,
      expectedVersion: flow.version,
      status: 'paused',
    });
    await refusedWith(
      startMany([{ to: '+919811100096', inputs }]),
      'precondition_failed',
      'automation_paused',
    );
    expect(await runRows()).toHaveLength(before + 2);
    expect(await contactOf('+919811100096')).toBeNull();
  });

  it('start many until the plan has no runs left, refuse the rest without a trace, and refuse them all when the plan has no automations (ADR-161)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, appointmentReminder);
    const flow = await publish(
      owner,
      'Reminder',
      apiTrigger,
      reminderFlow(template.id),
      c.channelAccountId,
    );
    const { ctx } = await apiKey(c, ['automations.start']);
    await onPlan(c, { automationRunsMonthly: '2' });
    const runs = ['+919811100180', '+919811100181', '+919811100182'].map((to) => ({
      to,
      inputs,
    }));
    const answer = await apiStartManyAutomationRuns(
      deps(),
      ctx,
      flow.id,
      { runs },
      idem('pq-1', 'pq-1'),
    );
    const starts = (answer.body as { data: ApiAutomationRunStart[] }).data;
    expect(starts.map((s) => (s.run ? 'started' : s.error?.reason))).toEqual([
      'started',
      'started',
      'automation_quota',
    ]);
    expect(starts[2]).toEqual({
      to: '+919811100182',
      run: null,
      error: {
        code: 'precondition_failed',
        reason: 'automation_quota',
        message: "Your company's plan has no automation runs left this month.",
      },
    });
    expect(
      await fx.query('SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2', [
        c.tenant.id,
        '+919811100182',
      ]),
    ).toHaveLength(0);
    await onPlan(c, { modules: [] });
    await refusedWith(
      apiStartManyAutomationRuns(
        deps(),
        ctx,
        flow.id,
        { runs: [{ to: '+919811100183', inputs }] },
        idem('pq-2', 'pq-2'),
      ),
      'forbidden',
      'not_in_plan',
      /does not include automations/,
    );
  });

  it('keep the key that started a run fixed, and clear the inputs when the contact is erased', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, appointmentReminder);
    const flow = await publish(
      owner,
      'Reminder',
      apiTrigger,
      reminderFlow(template.id),
      c.channelAccountId,
    );
    const key = await apiKey(c, ['automations.start']);
    const other = await apiKey(c, ['automations.start'], 'Other');
    const started = (
      await apiStartAutomationRun(
        deps(),
        key.ctx,
        flow.id,
        { to: '+919811100085', inputs: { patient: 'Kim', appointment_time: '9 am' } },
        idem('e-1', 'e-1'),
      )
    ).body.data as ApiAutomationRun;
    // What started the run cannot change, even for the table owner.
    for (const change of [`api_key_id = '${other.id}'`, `trigger_type = 'keyword'`]) {
      await expect(
        fx.dbs.adminPool.query(`UPDATE app.automation_runs SET ${change} WHERE id = $1`, [
          started.id,
        ]),
      ).rejects.toThrow(/what started an automation run is fixed/);
    }
    // Only runs started through the API name a key, also where the guard is set aside.
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('w360.allow_retention_purge', 'on', true)`);
      await expect(
        client.query('UPDATE app.automation_runs SET api_key_id = NULL WHERE id = $1', [
          started.id,
        ]),
      ).rejects.toThrow(/automation_runs_api_key/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    // Erasing the contact stops the run and clears its inputs with its answers.
    expect(await driveRun(c, started.id)).toBe('waiting');
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: started.contactId,
      suppress: false,
    });
    expect(await runRow(started.id)).toMatchObject({
      status: 'stopped',
      end_reason: 'contact_erased',
      variables: {},
    });
    expect(await apiGetAutomationRun(deps(), key.ctx, started.id)).toMatchObject({
      status: 'stopped',
      endReason: 'contact_erased',
    });
  });

  it('are saved with one number and tried by members with the inputs they give', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, appointmentReminder);
    const svc = automationService();
    // Calls do not choose a number: publishing needs the automation limited to one.
    const noNumber = await save(owner, 'No number', apiTrigger, reminderFlow(template.id), null);
    expect(noNumber.issues.map((i) => i.message)).toEqual([
      'An automation started through the API sends from one WhatsApp number: choose it.',
    ]);
    await expectAppError(
      svc.publishAutomation(owner, {
        id: noNumber.id,
        expectedVersion: noNumber.version,
        note: null,
      }),
      'precondition_failed',
    );
    // Steps use only the inputs the trigger declares.
    const undeclared = await save(
      owner,
      'Undeclared',
      { type: 'api', inputs: ['patient'] },
      reminderFlow(template.id),
      c.channelAccountId,
    );
    expect(undeclared.issues.map((i) => i.message)).toEqual([
      '{{input.appointment_time}} is not one of the trigger’s inputs. Add it to the trigger’s inputs first.',
      '{{input.appointment_time}} is not one of the trigger’s inputs. Add it to the trigger’s inputs first.',
    ]);

    // A test run takes the inputs from the member, on a conversation of the test phone.
    const draft = await save(
      owner,
      'Reminder',
      apiTrigger,
      reminderFlow(template.id),
      c.channelAccountId,
    );
    expect(draft.issues).toEqual([]);
    await inbound(c, '919811100090', [{ text: 'hi' }]);
    const conversation = await conversationOf(c, '919811100090');
    const test = (given: Record<string, unknown>) =>
      svc.startTestRun(owner, {
        id: draft.id,
        expectedVersion: draft.version,
        conversationId: conversation.id,
        inputs: given,
      });
    await expectAppError(
      test({ patient: 'Asha' }),
      'validation_failed',
      /Give the input “appointment_time” a value/,
    );
    const { runId } = await test({ patient: 'Asha', appointment_time: '5 pm' });
    expect(await runRow(runId)).toMatchObject({
      mode: 'test',
      trigger_type: 'test',
      api_key_id: null,
      variables: { 'input.patient': 'Asha', 'input.appointment_time': '5 pm' },
    });
    expect(await driveRun(c, runId)).toBe('waiting');
    expect(bodyTexts(templateSends('919811100090').at(-1))).toEqual(['Asha', '5 pm']);
    // Keys read only the runs keys started.
    const { ctx } = await apiKey(c, ['automations.start']);
    await expectAppError(apiGetAutomationRun(deps(), ctx, runId), 'not_found');
  });

  it('stop a run a key started, once, cancelling what it queued, without handing the conversation to people (ADR-079)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, appointmentReminder);
    const flow = await publish(
      owner,
      'Appointment reminder',
      apiTrigger,
      reminderFlow(template.id),
      c.channelAccountId,
    );
    await createWebhooksService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egressPolicy: { allowLoopbackForTests: true },
    }).create(owner, {
      url: 'https://hooks.receiver.test/runs',
      eventTypes: ['automation.run_ended'],
    });
    const { ctx, id: keyId } = await apiKey(c, ['automations.start'], 'Booking system');
    const start = async (to: string, key: string) =>
      (await apiStartAutomationRun(deps(), ctx, flow.id, { to, inputs }, idem(key, key))).body
        .data as ApiAutomationRun;
    const stopsOf = (runId: string) =>
      fx.query(
        `SELECT actor_type, actor_id, correlation_id, metadata FROM app.audit_events
          WHERE tenant_id = $1 AND action = 'automation.run_stopped' AND subject_id = $2`,
        [c.tenant.id, runId],
      );
    const conversationOf = async (id: string) =>
      (
        await fx.query<{ status: string; assigned_membership_id: string | null }>(
          'SELECT status, assigned_membership_id FROM app.conversations WHERE id = $1',
          [id],
        )
      )[0];
    const waitingTurns = (conversationId: string) =>
      fx.query<{ start_reason: string }>(
        `SELECT start_reason FROM app.conversation_turns
          WHERE conversation_id = $1 AND ended_at IS NULL`,
        [conversationId],
      );

    // A run waiting for the contact's answer to its template.
    const waiting = await start('+91 98111 00091', 'stop-1');
    expect(await driveRun(c, waiting.id)).toBe('waiting');
    // Other companies' keys, keys without the scope, companies that may not write and unknown ids
    // change nothing.
    const theirs = await apiKey(await fx.company(), ['automations.start']);
    await expectAppError(apiStopAutomationRun(deps(), theirs.ctx, waiting.id), 'not_found');
    const narrow = await apiKey(c, ['contacts.read']);
    await expectAppError(apiStopAutomationRun(deps(), narrow.ctx, waiting.id), 'forbidden');
    for (const status of ['suspended', 'restricted'] as const) {
      await expectAppError(
        apiStopAutomationRun(deps(), { ...ctx, tenant: { ...ctx.tenant, status } }, waiting.id),
        'tenant_suspended',
      );
    }
    for (const id of ['not-a-uuid', uuidv7()]) {
      await expectAppError(apiStopAutomationRun(deps(), ctx, id), 'not_found');
    }
    expect((await runRow(waiting.id)).status).toBe('waiting');

    const stopped = await apiStopAutomationRun(deps(), ctx, waiting.id);
    expect(stopped).toEqual({
      ...waiting,
      status: 'stopped',
      endReason: 'stopped_by_api',
      endedAt: expect.any(String),
    });
    expect(await runRow(waiting.id)).toMatchObject({
      status: 'stopped',
      end_reason: 'stopped_by_api',
    });
    expect(await stopsOf(waiting.id)).toEqual([
      {
        actor_type: 'api_key',
        actor_id: keyId,
        correlation_id: ctx.requestId,
        metadata: { automationId: flow.id, source: 'api' },
      },
    ]);
    // The end is sent to webhooks with its reason (ADR-078).
    expect(
      await fx.query(
        `SELECT status, detail FROM app.webhook_events
          WHERE tenant_id = $1 AND type = 'automation.run_ended'`,
        [c.tenant.id],
      ),
    ).toEqual([
      {
        status: 'stopped',
        detail: { runId: waiting.id, automationId: flow.id, endReason: 'stopped_by_api' },
      },
    ]);
    // Not handed to people: the contact never wrote, so the conversation stays resolved, with
    // nobody assigned and no one waiting for a reply.
    expect(await conversationOf(waiting.conversationId)).toEqual({
      status: 'resolved',
      assigned_membership_id: null,
    });
    expect(await waitingTurns(waiting.conversationId)).toEqual([]);
    expect(
      (
        await fx.query<{ outcome: string; detail: string | null }>(
          'SELECT outcome, detail FROM app.automation_run_steps WHERE run_id = $1 ORDER BY seq',
          [waiting.id],
        )
      ).at(-1),
    ).toEqual({ outcome: 'stopped', detail: 'stopped_by_api' });
    // A retry, or another key of the company, answers the run as it is and changes nothing, even
    // while a newer run works in the same conversation.
    expect(await apiStopAutomationRun(deps(), ctx, waiting.id)).toEqual(stopped);
    const newer = await start('+91 98111 00091', 'stop-1b');
    expect(newer.conversationId).toBe(waiting.conversationId);
    const other = await apiKey(c, ['automations.start']);
    expect(await apiStopAutomationRun(deps(), other.ctx, waiting.id)).toEqual(stopped);
    expect(await stopsOf(waiting.id)).toHaveLength(1);
    expect((await runRow(newer.id)).status).toBe('running');
    expect(await apiStopAutomationRun(deps(), ctx, newer.id)).toMatchObject({
      status: 'stopped',
      endReason: 'stopped_by_api',
    });

    // Stopped before its template left: the template is cancelled and never sent.
    const queued = await start('+91 98111 00092', 'stop-2');
    await advanceAutomationRun(
      { ...deps(), keyring: fx.keyring },
      authorizedTenantScope(c.tenant.id, null),
      queued.id,
      null,
    );
    expect(
      await fx.query(
        `SELECT m.status, s.state FROM app.messages m
           JOIN app.send_intents s ON s.tenant_id = m.tenant_id AND s.message_id = m.id
          WHERE m.conversation_id = $1`,
        [queued.conversationId],
      ),
    ).toEqual([{ status: 'queued', state: 'queued' }]);
    expect(await apiStopAutomationRun(deps(), ctx, queued.id)).toMatchObject({
      status: 'stopped',
      endReason: 'stopped_by_api',
    });
    expect(await sendAll(c)).toEqual([]);
    expect(templateSends('919811100092')).toEqual([]);
    expect(
      await fx.query(
        `SELECT m.status, m.error_code, s.state FROM app.messages m
           JOIN app.send_intents s ON s.tenant_id = m.tenant_id AND s.message_id = m.id
          WHERE m.conversation_id = $1`,
        [queued.conversationId],
      ),
    ).toEqual([{ status: 'canceled', error_code: 'bot_stopped', state: 'canceled' }]);

    // A contact who wrote first: the stop leaves them waiting for a member, unassigned.
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919811100093', text: 'Hello' }] }));
    const wrote = await start('+91 98111 00093', 'stop-3');
    expect(await driveRun(c, wrote.id)).toBe('waiting');
    expect(await waitingTurns(wrote.conversationId)).toEqual([]);
    await apiStopAutomationRun(deps(), ctx, wrote.id);
    expect(await conversationOf(wrote.conversationId)).toEqual({
      status: 'open',
      assigned_membership_id: null,
    });
    expect(await waitingTurns(wrote.conversationId)).toEqual([{ start_reason: 'handoff' }]);

    // Runs keys did not start are not found: a run the company's keyword automation started.
    const brochure = await publish(
      owner,
      'Brochure',
      {
        type: 'keyword',
        keywords: ['brochure'],
        match: 'contains',
        hours: 'any',
        cooldownMinutes: 0,
      },
      {
        version: 1,
        start: 'hi',
        nodes: [{ id: 'hi', type: 'send_text', text: 'Here it is.', next: null }],
      },
      null,
    );
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: '919811100094', text: 'brochure please' }] }),
    );
    const [keywordRun] = await fx.query<{ id: string }>(
      'SELECT id FROM app.automation_runs WHERE tenant_id = $1 AND automation_id = $2',
      [c.tenant.id, brochure.id],
    );
    await expectAppError(apiStopAutomationRun(deps(), ctx, keywordRun!.id), 'not_found');
    expect((await runRow(keywordRun!.id)).status).toBe('running');
  });

  it('stop many runs keys started in one call, all of them or none, each as one stop does (ADR-162)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, appointmentReminder);
    const flow = await publish(
      owner,
      'Reminder',
      apiTrigger,
      reminderFlow(template.id),
      c.channelAccountId,
    );
    const { ctx, id: keyId } = await apiKey(c, ['automations.start'], 'Booking system');
    const start = async (to: string, key: string) =>
      (await apiStartAutomationRun(deps(), ctx, flow.id, { to, inputs }, idem(key, key))).body
        .data as ApiAutomationRun;
    const stops = () =>
      fx.query<{ subject_id: string; actor_id: string }>(
        `SELECT subject_id, actor_id FROM app.audit_events
          WHERE tenant_id = $1 AND action = 'automation.run_stopped' ORDER BY occurred_at, id`,
        [c.tenant.id],
      );
    const lastStep = async (runId: string) =>
      (
        await fx.query<{ outcome: string; detail: string | null }>(
          'SELECT outcome, detail FROM app.automation_run_steps WHERE run_id = $1 ORDER BY seq',
          [runId],
        )
      ).at(-1);

    // A run waiting for its template's answer, one still running, one stopped before, and a newer
    // run in the stopped one's conversation.
    const waiting = await start('+91 98111 00191', 'sm-1');
    expect(await driveRun(c, waiting.id)).toBe('waiting');
    const running = await start('+91 98111 00192', 'sm-2');
    const ended = await start('+91 98111 00193', 'sm-3');
    const endedAnswer = await apiStopAutomationRun(deps(), ctx, ended.id);
    const newer = await start('+91 98111 00193', 'sm-4');
    expect(newer.conversationId).toBe(ended.conversationId);

    // All of them or none: an id that names no run a key of the company started refuses the call,
    // naming its place, and nothing is stopped.
    const refusedAt = async (promise: Promise<unknown>, path: string) => {
      const error = await expectAppError(promise, 'validation_failed');
      expect(isAppError(error) && error.issues?.map((i) => i.path)).toEqual([path]);
    };
    await refusedAt(
      apiStopManyAutomationRuns(deps(), ctx, { runIds: [waiting.id, uuidv7()] }),
      'runIds.1',
    );
    const theirs = await apiKey(await fx.company(), ['automations.start']);
    await refusedAt(
      apiStopManyAutomationRuns(deps(), theirs.ctx, { runIds: [running.id] }),
      'runIds.0',
    );
    expect((await runRow(waiting.id)).status).toBe('waiting');
    expect((await runRow(running.id)).status).toBe('running');
    const before = (await stops()).length;

    const ids = [running.id, ended.id, newer.id, waiting.id];
    const stopped = await apiStopManyAutomationRuns(deps(), ctx, { runIds: ids });
    expect(stopped.map((r) => [r.id, r.status, r.endReason])).toEqual(
      ids.map((id) => [id, 'stopped', 'stopped_by_api']),
    );
    // The run stopped before is answered as it was; the others are stopped by this call, in the
    // order given, each with its step and an audit entry as the key.
    expect(stopped[1]).toEqual(endedAnswer);
    expect((await stops()).slice(before).map((e) => [e.subject_id, e.actor_id])).toEqual(
      [running.id, newer.id, waiting.id].map((id) => [id, keyId]),
    );
    for (const id of [running.id, newer.id, waiting.id]) {
      expect(await lastStep(id)).toEqual({ outcome: 'stopped', detail: 'stopped_by_api' });
    }
    // A retry answers the same and records nothing more.
    expect(await apiStopManyAutomationRuns(deps(), ctx, { runIds: ids })).toEqual(stopped);
    expect(await stops()).toHaveLength(before + 3);
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
      'ops.api_key_authenticate(text,inet)',
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

describe('the message feed (ADR-088)', () => {
  /** Every page of the feed, following `nextCursor`. */
  async function everyPage(ctx: ApiContext, query: Record<string, string>) {
    const pages: Awaited<ReturnType<typeof apiListMessages>>['data'][] = [];
    let cursor: string | undefined;
    do {
      const page = await apiListMessages(deps(), ctx, { ...query, ...(cursor ? { cursor } : {}) });
      pages.push(page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && pages.length < 50);
    return pages;
  }

  /** PostgreSQL's time, to the microsecond. */
  async function databaseNow() {
    const [row] = await fx.query<{ now: string }>(
      `SELECT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
    );
    return row!.now;
  }

  it('lists the messages of every conversation newest first, with their contact and number, on pages that never skip or repeat', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const reader = await apiKey(c, ['conversations.read']);
    const replier = await apiKey(c, ['messages.reply'], 'Helpdesk');
    const owner = await fx.ctx(c, c.owner);
    const second = await addNumber(c, 'active');
    const [secondNumber] = await fx.query<{ phone_number_id: string }>(
      'SELECT phone_number_id FROM app.channel_accounts WHERE id = $1',
      [second],
    );
    // Two messages in one delivery share their creation time to the microsecond.
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [
          { waId: '919811100081', text: 'Is it in stock?' },
          { waId: '919811100081', text: 'In blue?' },
        ],
      }),
    );
    await inbound(c, '919811100082', [{ text: 'Hello' }], secondNumber!.phone_number_id);
    await inbound(c, '919811100083', [{ text: 'Please forget me' }]);
    await inbound(other, '919811100084', [{ text: 'Another company' }]);
    const reply = await apiSendMessage(
      deps(),
      replier.ctx,
      { type: 'text', to: '+919811100081', from: c.channelAccountId, text: 'Yes, in blue too.' },
      idem('feed-1', 'feed-1'),
    );
    const [asking, onSecond, erasedConv] = await Promise.all(
      ['919811100081', '919811100082', '919811100083'].map((w) => conversationOf(c, w)),
    );
    const [asked] = await fx.query<{ times: number }>(
      `SELECT count(DISTINCT created_at)::int AS times FROM app.messages
        WHERE conversation_id = $1 AND direction = 'inbound'`,
      [asking!.id],
    );
    expect(asked!.times).toBe(1);
    // Internal notes are not messages, and an erased contact's conversation is left out.
    await inbox().addNote(owner, { conversationId: asking!.id, body: 'Check the warehouse.' });
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: erasedConv!.contact_id,
      suppress: false,
    });
    const newestFirst = (
      await fx.query<{ id: string }>(
        `SELECT m.id FROM app.messages m
           JOIN app.conversations cv ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
          WHERE m.tenant_id = $1 AND cv.contact_id <> $2
          ORDER BY m.created_at DESC, m.id DESC`,
        [c.tenant.id, erasedConv!.contact_id],
      )
    ).map((r) => r.id);
    expect(newestFirst).toHaveLength(4);
    for (const limit of ['1', '2', '3']) {
      const pages = await everyPage(reader.ctx, { limit });
      expect(
        pages.flat().map((m) => m.id),
        `limit ${limit}`,
      ).toEqual(newestFirst);
    }

    // Each message reads as the conversation's messages read it, with the contact and number.
    const feed = (await apiListMessages(deps(), reader.ctx, {})).data;
    const inConversation = (await apiListConversationMessages(deps(), reader.ctx, asking!.id, {}))
      .data;
    expect(feed.filter((m) => m.conversationId === asking!.id)).toEqual(
      inConversation.map((m) => ({
        ...m,
        contactId: asking!.contact_id,
        channelId: c.channelAccountId,
      })),
    );
    expect(feed.find((m) => m.conversationId === onSecond!.id)).toMatchObject({
      contactId: onSecond!.contact_id,
      channelId: second,
      direction: 'inbound',
      text: 'Hello',
    });
    expect(feed.find((m) => m.id === (reply.body.data as { id: string }).id)).toMatchObject({
      direction: 'outbound',
      sentBy: 'api',
      apiKeyId: replier.id,
      text: 'Yes, in blue too.',
    });

    // Filters: direction, number and a time; each keeps the order.
    const ids = async (query: Record<string, string>) =>
      (await apiListMessages(deps(), reader.ctx, query)).data.map((m) => m.id);
    const outboundIds = feed.filter((m) => m.direction === 'outbound').map((m) => m.id);
    expect(outboundIds).toHaveLength(1);
    expect(await ids({ direction: 'outbound' })).toEqual(outboundIds);
    expect(await ids({ direction: 'inbound' })).toEqual(
      newestFirst.filter((id) => !outboundIds.includes(id)),
    );
    expect(await ids({ channelId: second })).toEqual(
      feed.filter((m) => m.channelId === second).map((m) => m.id),
    );
    expect(await ids({ channelId: uuidv7() })).toEqual([]);
    // `since` a message's own time includes it.
    const [replyTime] = await fx.query<{ at: string }>(
      `SELECT to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM app.messages WHERE id = $1`,
      [(reply.body.data as { id: string }).id],
    );
    expect((await ids({ since: replyTime!.at })).at(-1)).toBe(
      (reply.body.data as { id: string }).id,
    );
    const since = await databaseNow();
    expect(await ids({ since })).toEqual([]);
    await inbound(c, '919811100082', [{ text: 'Any update?' }], secondNumber!.phone_number_id);
    const [latest] = await ids({ since });
    expect(await ids({ since })).toEqual([latest]);
    expect(await ids({ since, direction: 'outbound' })).toEqual([]);

    // Another company's key reads only its own company's messages.
    const theirs = await apiKey(other, ['conversations.read']);
    const theirFeed = (await apiListMessages(deps(), theirs.ctx, {})).data;
    expect(theirFeed.map((m) => m.text)).toEqual(['Another company']);
  });

  it(`reads at most ${API_MESSAGE_FEED_WINDOW} messages a page: filters that leave out most of them give short pages that go on to the end`, async () => {
    const c = await fx.company();
    const reader = await apiKey(c, ['conversations.read']);
    const second = await addNumber(c, 'active');
    await inbound(c, '919811100085', [{ text: 'The first' }]);
    const conv = await conversationOf(c, '919811100085');
    // Each statement adds messages after every message before, a microsecond apart.
    const add = (direction: string, count: number) =>
      fx.query(
        `INSERT INTO app.messages (id, tenant_id, conversation_id, channel_account_id, direction,
                                   type, content, status, sender_type, created_at)
         SELECT gen_random_uuid(), cv.tenant_id, cv.id, cv.channel_account_id, $2, 'text',
                jsonb_build_object('text', 'Message ' || g),
                CASE WHEN $2 = 'inbound' THEN 'received' ELSE 'sent' END,
                CASE WHEN $2 = 'inbound' THEN 'contact' ELSE 'agent' END,
                (SELECT max(created_at) FROM app.messages WHERE conversation_id = cv.id)
                  + g * interval '1 microsecond'
           FROM app.conversations cv, generate_series(1, $3::int) g
          WHERE cv.id = $1`,
        [conv.id, direction, count],
      );
    // Newest first: an answer, the contact's messages, then two answers, the newer of them the last
    // message the first page reads, then the first message.
    await add('outbound', 2);
    await add('inbound', API_MESSAGE_FEED_WINDOW - 2);
    await add('outbound', 1);
    const newestFirst = await fx.query<{ id: string; direction: string }>(
      `SELECT id, direction FROM app.messages WHERE conversation_id = $1
        ORDER BY created_at DESC, id DESC`,
      [conv.id],
    );
    expect(newestFirst).toHaveLength(API_MESSAGE_FEED_WINDOW + 2);
    const answers = newestFirst.filter((m) => m.direction === 'outbound').map((m) => m.id);
    expect(newestFirst.map((m) => m.id).indexOf(answers[1]!)).toBe(API_MESSAGE_FEED_WINDOW - 1);

    // Without filters every page is full, and the pages hold every message once.
    const all = await everyPage(reader.ctx, { limit: '100' });
    expect(all.slice(0, -1).every((p) => p.length === 100)).toBe(true);
    expect(all.flat().map((m) => m.id)).toEqual(newestFirst.map((m) => m.id));

    // The answers: the first page reads the newest messages up to its window, the last of them
    // included; its cursor goes on after that one, and the next page finds the last answer.
    const first = await apiListMessages(deps(), reader.ctx, { direction: 'outbound' });
    expect(first.data.map((m) => m.id)).toEqual(answers.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const rest = await apiListMessages(deps(), reader.ctx, {
      direction: 'outbound',
      cursor: first.nextCursor!,
    });
    expect(rest.data.map((m) => m.id)).toEqual([answers[2]]);
    expect(rest.nextCursor).toBeNull();

    // A number without messages: empty pages that still reach the end.
    const none = await everyPage(reader.ctx, { channelId: second });
    expect(none).toEqual([[], []]);

    // The cursor of a short page reads on exactly: the contact's messages page by page are every
    // inbound message once.
    const inboundPages = await everyPage(reader.ctx, { direction: 'inbound', limit: '100' });
    expect(inboundPages.flat().map((m) => m.id)).toEqual(
      newestFirst.filter((m) => m.direction === 'inbound').map((m) => m.id),
    );
  });

  it('needs the conversations.read scope and refuses queries it does not know', async () => {
    const c = await fx.company();
    const without = await apiKey(c, ['messages.reply', 'conversations.write']);
    await expectAppError(
      apiListMessages(deps(), without.ctx, {}),
      'forbidden',
      /conversations\.read scope/,
    );
    const reader = await apiKey(c, ['conversations.read']);
    for (const query of [
      { direction: 'both' },
      { channelId: 'main' },
      { since: 'yesterday' },
      { limit: '101' },
      { status: 'read' },
      { cursor: 'not-a-cursor' },
    ]) {
      await expectAppError(apiListMessages(deps(), reader.ctx, query), 'validation_failed');
    }
  });
});

describe('reading notes (ADR-089)', () => {
  it('reads a conversation’s notes newest first, members’ and keys’ alike, without naming members or mentions', async () => {
    const c = await fx.company();
    const reader = await apiKey(c, ['conversations.read']);
    const writer = await apiKey(c, ['conversations.write'], 'Helpdesk');
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await inbound(c, '919811100086', [{ text: 'Where is my order?' }]);
    const conv = await conversationOf(c, '919811100086');
    await inbox().addNote(agent, {
      conversationId: conv.id,
      body: 'Asked the warehouse, @Owner please check.',
      mentionIds: [owner.membership.id],
    });
    const added = await apiAddConversationNote(
      deps(),
      writer.ctx,
      conv.id,
      { text: 'Ticket #4522 opened in the helpdesk.' },
      idem('read-note-1', 'a'),
    );
    // Two notes saved by one statement share their time to the microsecond.
    await fx.query(
      `INSERT INTO app.conversation_notes (id, tenant_id, conversation_id, author_membership_id, body)
       SELECT gen_random_uuid(), cv.tenant_id, cv.id, $2, 'Same time ' || g
         FROM app.conversations cv, generate_series(1, 2) g
        WHERE cv.id = $1`,
      [conv.id, owner.membership.id],
    );
    const newestFirst = await fx.query<{
      id: string;
      body: string;
      author_api_key_id: string | null;
    }>(
      `SELECT id, body, author_api_key_id FROM app.conversation_notes
        WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC`,
      [conv.id],
    );
    expect(newestFirst).toHaveLength(4);

    // Every note once, newest first, whatever the page size.
    for (const limit of ['1', '2', '3']) {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await apiListConversationNotes(deps(), reader.ctx, conv.id, {
          limit,
          ...(cursor ? { cursor } : {}),
        });
        ids.push(...page.data.map((n) => n.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor && ids.length < 20);
      expect(ids, `limit ${limit}`).toEqual(newestFirst.map((n) => n.id));
    }

    // Members' notes say a member wrote them, never which one or whom they mention; a key's note
    // names its key, and reads as the note the key added.
    const { data, nextCursor } = await apiListConversationNotes(deps(), reader.ctx, conv.id, {});
    expect(nextCursor).toBeNull();
    expect(data.map((n) => [n.text, n.writtenBy, n.apiKeyId])).toEqual(
      newestFirst.map((n) => [
        n.body,
        n.author_api_key_id ? 'api' : 'agent',
        n.author_api_key_id ?? null,
      ]),
    );
    const byKey = data.find((n) => n.writtenBy === 'api');
    expect(byKey).toEqual((added.body as { data: unknown }).data);
    expect(byKey!.apiKeyId).toBe(writer.id);
    const byMember = data.find((n) => n.text.startsWith('Asked the warehouse'));
    expect(byMember).toEqual({
      id: expect.any(String),
      conversationId: conv.id,
      text: 'Asked the warehouse, @Owner please check.',
      writtenBy: 'agent',
      apiKeyId: null,
      createdAt: expect.any(String),
    });

    // A conversation without notes reads as an empty page.
    await inbound(c, '919811100087', [{ text: 'Hi' }]);
    const quiet = await conversationOf(c, '919811100087');
    expect(await apiListConversationNotes(deps(), reader.ctx, quiet.id, {})).toEqual({
      data: [],
      nextCursor: null,
    });
  });

  it('finds no conversation of another company or an erased contact, and needs conversations.read', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const theirOwner = await fx.ctx(other, other.owner);
    const reader = await apiKey(c, ['conversations.read']);
    await inbound(c, '919811100088', [{ text: 'Please forget me' }]);
    await inbound(other, '919811100089', [{ text: 'Hello' }]);
    const erasedConv = await conversationOf(c, '919811100088');
    const theirs = await conversationOf(other, '919811100089');
    await inbox().addNote(theirOwner, { conversationId: theirs.id, body: 'Their note.' });
    await inbox().addNote(owner, { conversationId: erasedConv.id, body: 'Before the erasure.' });
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: erasedConv.contact_id,
      suppress: false,
    });
    for (const id of [theirs.id, erasedConv.id, uuidv7(), 'not-a-uuid']) {
      await expectAppError(apiListConversationNotes(deps(), reader.ctx, id, {}), 'not_found');
    }
    const without = await apiKey(c, ['conversations.write', 'messages.reply']);
    await expectAppError(
      apiListConversationNotes(deps(), without.ctx, theirs.id, {}),
      'forbidden',
      /conversations\.read scope/,
    );
    await inbound(c, '919811100090', [{ text: 'Still here' }]);
    const live = await conversationOf(c, '919811100090');
    for (const query of [{ limit: '0' }, { limit: '101' }, { cursor: 'nope' }, { since: 'now' }]) {
      await expectAppError(
        apiListConversationNotes(deps(), reader.ctx, live.id, query),
        'validation_failed',
      );
    }
  });
});
