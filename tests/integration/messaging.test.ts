import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, isAppError, systemClock, uuidv7, type MetaConfig } from '@w360/core';
import {
  authorizedTenantScope,
  channelAccounts,
  eq,
  sql,
  whatsappAccounts,
  type TenantScope,
} from '@w360/db';
import {
  GraphClient,
  JobSigner,
  PgBossJobQueue,
  applyMessagingRetention,
  cancelSendIntent,
  createInboxService,
  createOnboardingService,
  credentialAad,
  currentEventCursor,
  processChannelOnboarding,
  processMetaWebhookReceipt,
  processSendIntent,
  queueTextMessage,
  readTenantEvents,
  recoverExpiredSend,
  resolveTenantContext,
  resolveUnknownOutcome,
  storeWebhookReceipt,
  verifyMetaSignature,
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
 * Messaging pipeline against real PostgreSQL: webhook receipts, attribution through verified asset
 * bindings, idempotent ingestion, delivery-state ordering, the outbound send state machine
 * (including responses that never arrive), Embedded Signup onboarding and inbox concurrency.
 * Meta is represented by a local test-only stand-in (tests/support/graph-stand-in.ts).
 */
const APP_ID = '1000000000001';
const APP_SECRET = 'test-app-secret-'.padEnd(40, 'x');

let dbs: TestDatabases;
let boss: PgBoss;
let graphStandIn: GraphStandIn;
let graph: GraphClient;
const signer = new JobSigner(randomBytes(32).toString('hex'));
const keyring = new Keyring({ primaryKeyId: 'test', keys: { test: randomBytes(32) } });
const rate = { capacity: 1000, refillPerSecond: 1000 };

let seq = 0;
const nextId = () => String(9_000_000_000 + ++seq * 7919 + Math.floor(Math.random() * 1000));

interface Company {
  owner: TestUser;
  agent: TestUser;
  agent2: TestUser;
  tenant: TestTenant;
  wabaId: string;
  phoneNumberId: string;
  whatsappAccountId: string;
  channelAccountId: string;
  token: string;
}

async function companyWithChannel(): Promise<Company> {
  const owner = await createUser(dbs, { name: 'Owner' });
  const tenant = await createTenant(dbs, owner);
  const agent = await createUser(dbs, { name: 'Agent One' });
  const agent2 = await createUser(dbs, { name: 'Agent Two' });
  for (const a of [agent, agent2]) {
    const { token } = await invite(dbs, tenant, owner, a.email, ['agent']);
    await acceptInvitation(dbs, a, token);
  }
  const wabaId = nextId();
  const phoneNumberId = nextId();
  const token = `EAAG${randomBytes(12).toString('hex')}`;
  graphStandIn.state.tokens.set(token, {
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
    agent2,
    tenant,
    wabaId,
    phoneNumberId,
    whatsappAccountId,
    channelAccountId,
    token,
  };
}

function ctxFor(company: Company, user: TestUser): Promise<TenantContext> {
  return resolveTenantContext(
    { db: dbs.app, clock: systemClock, mfaGracePeriodHours: 72 },
    {
      userId: user.id,
      sessionId: `sess_${user.id}`,
      sessionCreatedAt: new Date(),
      tenantSlug: company.tenant.slug,
      correlationId: uuidv7(),
    },
  );
}

interface InboundSpec {
  id?: string;
  from?: string;
  waId?: string;
  userId?: string;
  text?: string;
  type?: string;
  extra?: Record<string, unknown>;
  timestamp?: number;
}

function webhookBody(
  wabaId: string,
  phoneNumberId: string,
  value: { messages?: InboundSpec[]; statuses?: Record<string, unknown>[] },
) {
  const now = Math.floor(Date.now() / 1000);
  const messages = value.messages?.map((m) => ({
    id: m.id ?? `wamid.in.${randomBytes(6).toString('hex')}`,
    ...(m.from ? { from: m.from } : m.waId ? { from: m.waId } : {}),
    timestamp: String(m.timestamp ?? now),
    type: m.type ?? 'text',
    ...(m.type && m.type !== 'text' ? (m.extra ?? {}) : { text: { body: m.text ?? 'Hello' } }),
  }));
  const contacts = value.messages?.map((m) => ({
    profile: { name: 'Priya Customer' },
    ...(m.waId ? { wa_id: m.waId } : {}),
    ...(m.userId ? { user_id: m.userId } : {}),
  }));
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919000000000', phone_number_id: phoneNumberId },
              ...(contacts ? { contacts } : {}),
              ...(messages ? { messages } : {}),
              ...(value.statuses ? { statuses: value.statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

async function deliver(body: unknown) {
  const stored = await storeWebhookReceipt(
    { db: dbs.app, keyring, jobs: new PgBossJobQueue(boss), signer },
    { provider: 'meta_whatsapp', rawBody: Buffer.from(JSON.stringify(body)) },
  );
  const outcome = await processMetaWebhookReceipt(
    { db: dbs.app, keyring, clock: systemClock, jobs: new PgBossJobQueue(boss), signer },
    stored.receiptId,
  );
  return { ...stored, outcome };
}

async function adminQuery<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

function sendDeps() {
  return {
    db: dbs.app,
    keyring,
    graph,
    clock: systemClock,
    rate,
    jobs: new PgBossJobQueue(boss),
    signer,
  };
}
function outboundDeps() {
  return { db: dbs.app, jobs: new PgBossJobQueue(boss), signer, clock: systemClock };
}

async function intentFor(messageId: string) {
  const [row] = await adminQuery<{
    id: string;
    state: string;
    attempts: number;
    sent_at: Date | null;
  }>('SELECT id, state, attempts, sent_at FROM app.send_intents WHERE message_id = $1', [
    messageId,
  ]);
  return row!;
}

async function messageRow(messageId: string) {
  const [row] = await adminQuery<{
    status: string;
    external_message_id: string | null;
    error_code: string | null;
  }>('SELECT status, external_message_id, error_code FROM app.messages WHERE id = $1', [messageId]);
  return row!;
}

beforeAll(async () => {
  dbs = connectTestDatabases({ appPoolMax: 10 });
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
  graphStandIn = await startGraphStandIn({ appId: APP_ID, appSecret: APP_SECRET });
  graph = new GraphClient({ baseUrl: graphStandIn.baseUrl, version: 'v26.0', timeoutMs: 1_500 });
});

afterAll(async () => {
  await graphStandIn.close();
  await boss.stop({ graceful: false, close: true });
  await dbs.close();
});

beforeEach(() => {
  graphStandIn.state.sendQueue = [];
  graphStandIn.state.registerError = null;
});

describe('webhook signatures', () => {
  it('accepts the current or previous secret and rejects anything else', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
    const sign = (secret: string) =>
      `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, sign('current'), ['current', 'previous'])).toBe(true);
    expect(verifyMetaSignature(body, sign('previous'), ['current', 'previous'])).toBe(true);
    expect(verifyMetaSignature(body, sign('attacker'), ['current', 'previous'])).toBe(false);
    expect(verifyMetaSignature(body, null, ['current'])).toBe(false);
    expect(verifyMetaSignature(Buffer.from(`${body} `), sign('current'), ['current'])).toBe(false);
  });
});

describe('inbound ingestion', () => {
  it('stores each delivery once and processes replays idempotently', async () => {
    const c = await companyWithChannel();
    const body = webhookBody(c.wabaId, c.phoneNumberId, {
      messages: [{ id: 'wamid.dup.1', waId: '919812345678', text: 'Do you deliver to Pune?' }],
    });
    const first = await deliver(body);
    expect(first).toMatchObject({ duplicate: false, outcome: 'processed' });
    // Meta retries the same bytes: one receipt.
    const again = await storeWebhookReceipt(
      { db: dbs.app, keyring, jobs: new PgBossJobQueue(boss), signer },
      { provider: 'meta_whatsapp', rawBody: Buffer.from(JSON.stringify(body)) },
    );
    expect(again).toEqual({ receiptId: first.receiptId, duplicate: true });
    // Same message in a differently serialised delivery: a new receipt, but no second message.
    const reordered = { entry: body.entry, object: body.object };
    const second = await deliver(reordered);
    expect(second.duplicate).toBe(false);
    const msgs = await adminQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.messages WHERE tenant_id = $1 AND external_message_id = 'wamid.dup.1'`,
      [c.tenant.id],
    );
    expect(msgs[0]!.n).toBe(1);
    const [conv] = await adminQuery<{ unread_count: number; last_message_preview: string }>(
      'SELECT unread_count, last_message_preview FROM app.conversations WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(conv).toEqual({ unread_count: 1, last_message_preview: 'Do you deliver to Pune?' });
    // A processed receipt cannot be claimed again.
    expect(
      await processMetaWebhookReceipt(
        { db: dbs.app, keyring, clock: systemClock, jobs: new PgBossJobQueue(boss), signer },
        first.receiptId,
      ),
    ).toBe('not_claimable');
  });

  it('quarantines events for unknown numbers or mismatched accounts, once per receipt', async () => {
    const c = await companyWithChannel();
    const unknown = await deliver(
      webhookBody(c.wabaId, nextId(), { messages: [{ waId: '919800000001', text: 'hi' }] }),
    );
    expect(unknown.outcome).toBe('quarantined');
    const mismatch = await deliver(
      webhookBody(nextId(), c.phoneNumberId, { messages: [{ waId: '919800000002', text: 'hi' }] }),
    );
    expect(mismatch.outcome).toBe('quarantined');
    const rows = await adminQuery<{ receipt_id: string; reason: string }>(
      'SELECT receipt_id, reason FROM ops.webhook_quarantine WHERE receipt_id = ANY($1::uuid[]) ORDER BY reason',
      [[unknown.receiptId, mismatch.receiptId]],
    );
    expect(rows.map((r) => r.reason)).toEqual(['asset_mismatch', 'unknown_asset']);
    // Nothing leaked into the company.
    const leaked = await adminQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.messages WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    expect(leaked[0]!.n).toBe(0);
    // Reprocessing a quarantined receipt (after an operator reset) does not duplicate entries.
    await dbs.adminPool.query(`UPDATE ops.webhook_receipts SET status = 'failed' WHERE id = $1`, [
      unknown.receiptId,
    ]);
    await processMetaWebhookReceipt(
      { db: dbs.app, keyring, clock: systemClock, jobs: new PgBossJobQueue(boss), signer },
      unknown.receiptId,
    );
    const again = await adminQuery<{ n: number }>(
      'SELECT count(*)::int AS n FROM ops.webhook_quarantine WHERE receipt_id = $1',
      [unknown.receiptId],
    );
    expect(again[0]!.n).toBe(1);
  });

  it('a number bound to one company cannot be bound by another', async () => {
    const a = await companyWithChannel();
    const b = await companyWithChannel();
    await expect(
      dbs.app.run(authorizedTenantScope(b.tenant.id, b.owner.id), (tx) =>
        tx.execute(
          sql`select app.bind_provider_asset('meta_whatsapp', 'phone_number', ${a.phoneNumberId}, ${b.channelAccountId}::uuid, ${a.wabaId})`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    const resolved = await adminQuery<{ tenant_id: string }>(
      `SELECT tenant_id FROM ops.provider_asset_bindings WHERE external_id = $1 AND status = 'active'`,
      [a.phoneNumberId],
    );
    expect(resolved).toEqual([{ tenant_id: a.tenant.id }]);
  });

  it('keeps business-scoped user ids and refuses to send to contacts without a phone number', async () => {
    const c = await companyWithChannel();
    const userId = `IN.${randomBytes(8).toString('hex')}`;
    await deliver(
      webhookBody(c.wabaId, c.phoneNumberId, { messages: [{ from: userId, userId, text: 'Hi' }] }),
    );
    const [identity] = await adminQuery<{ bsuid: string; wa_id: string | null }>(
      'SELECT bsuid, wa_id FROM app.contact_identities WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(identity).toEqual({ bsuid: userId, wa_id: null });
    const [conv] = await adminQuery<{ id: string }>(
      'SELECT id FROM app.conversations WHERE tenant_id = $1',
      [c.tenant.id],
    );
    const ctx = await ctxFor(c, c.agent);
    await expect(
      queueTextMessage(outboundDeps(), ctx, {
        conversationId: conv!.id,
        text: 'Hello',
        clientKey: 'ck-bsuid-1',
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('delivery status ordering', () => {
  it('never moves a message backwards and keeps every provider event', async () => {
    const c = await companyWithChannel();
    const waId = '919811111111';
    await deliver(
      webhookBody(c.wabaId, c.phoneNumberId, { messages: [{ waId, text: 'Order status?' }] }),
    );
    const [conv] = await adminQuery<{ id: string }>(
      'SELECT id FROM app.conversations WHERE tenant_id = $1',
      [c.tenant.id],
    );
    const ctx = await ctxFor(c, c.agent);
    // A status for this send arrives before the send worker records the WAMID (orphan).
    const wamid = `wamid.out.${randomBytes(6).toString('hex')}`;
    const t = Math.floor(Date.now() / 1000);
    await deliver(
      webhookBody(c.wabaId, c.phoneNumberId, {
        statuses: [
          { id: wamid, status: 'delivered', timestamp: String(t + 2), recipient_id: waId },
        ],
      }),
    );
    const { messageId } = await queueTextMessage(outboundDeps(), ctx, {
      conversationId: conv!.id,
      text: 'It ships today.',
      clientKey: 'ck-order-1',
    });
    graphStandIn.state.sendQueue.push({ kind: 'accept', wamid });
    const result = await processSendIntent(
      sendDeps(),
      ctx.scope as TenantScope,
      (await intentFor(messageId)).id,
    );
    expect(result.outcome).toBe('accepted');
    expect(await messageRow(messageId)).toMatchObject({
      status: 'delivered',
      external_message_id: wamid,
    });

    // Out-of-order and conflicting statuses: read, then a late sent, then failed.
    await deliver(
      webhookBody(c.wabaId, c.phoneNumberId, {
        statuses: [
          { id: wamid, status: 'read', timestamp: String(t + 5), recipient_id: waId },
          { id: wamid, status: 'sent', timestamp: String(t + 1), recipient_id: waId },
          {
            id: wamid,
            status: 'failed',
            timestamp: String(t + 6),
            recipient_id: waId,
            errors: [{ code: 131026, title: 'Message undeliverable' }],
          },
        ],
      }),
    );
    expect((await messageRow(messageId)).status).toBe('read');
    // Duplicate status deliveries collapse; history keeps one row per distinct event.
    await deliver(
      webhookBody(c.wabaId, c.phoneNumberId, {
        statuses: [{ id: wamid, status: 'read', timestamp: String(t + 5), recipient_id: waId }],
      }),
    );
    const history = await adminQuery<{ status: string }>(
      'SELECT status FROM app.message_status_events WHERE tenant_id = $1 AND external_message_id = $2 ORDER BY provider_timestamp',
      [c.tenant.id, wamid],
    );
    expect(history.map((h) => h.status)).toEqual(['sent', 'delivered', 'read', 'failed']);
  });
});

describe('outbound sends', () => {
  async function openConversation(c: Company, waId = '919822222222') {
    await deliver(webhookBody(c.wabaId, c.phoneNumberId, { messages: [{ waId, text: 'Hello' }] }));
    const [conv] = await adminQuery<{ id: string }>(
      'SELECT id FROM app.conversations WHERE tenant_id = $1',
      [c.tenant.id],
    );
    return conv!.id;
  }

  it('sends with the company token, idempotent per composer key', async () => {
    const c = await companyWithChannel();
    const conversationId = await openConversation(c);
    const ctx = await ctxFor(c, c.agent);
    const first = await queueTextMessage(outboundDeps(), ctx, {
      conversationId,
      text: 'Hi there',
      clientKey: 'ck-idem-1',
    });
    const dup = await queueTextMessage(outboundDeps(), ctx, {
      conversationId,
      text: 'Hi there',
      clientKey: 'ck-idem-1',
    });
    expect(dup).toEqual({ messageId: first.messageId, duplicate: true });
    const before = graphStandIn.state.requests.length;
    const result = await processSendIntent(
      sendDeps(),
      ctx.scope as TenantScope,
      (await intentFor(first.messageId)).id,
    );
    expect(result.outcome).toBe('accepted');
    const sent = graphStandIn.state.requests
      .slice(before)
      .find((r) => r.path.endsWith('/messages'));
    expect(sent?.authorization).toBe(`Bearer ${c.token}`);
    expect(sent?.path).toBe(`/v26.0/${c.phoneNumberId}/messages`);
    expect(sent?.body).toMatchObject({
      to: '919822222222',
      type: 'text',
      text: { body: 'Hi there' },
    });
    // Processing the same intent again does nothing.
    expect(
      (
        await processSendIntent(
          sendDeps(),
          ctx.scope as TenantScope,
          (await intentFor(first.messageId)).id,
        )
      ).outcome,
    ).toBe('not_claimable');
    // Unassigned conversation was claimed by the replying agent.
    const [conv] = await adminQuery<{ assigned_membership_id: string }>(
      'SELECT assigned_membership_id FROM app.conversations WHERE id = $1',
      [conversationId],
    );
    expect(conv!.assigned_membership_id).toBe(ctx.membership.id);
  });

  it('schedules retries for rate limits and server errors, and fails permanently otherwise', async () => {
    const c = await companyWithChannel();
    const conversationId = await openConversation(c);
    const ctx = await ctxFor(c, c.agent);
    const { messageId } = await queueTextMessage(outboundDeps(), ctx, {
      conversationId,
      text: 'One',
      clientKey: 'ck-retry-1',
    });
    graphStandIn.state.sendQueue.push({
      kind: 'error',
      status: 429,
      code: 130429,
      message: 'Rate limit hit',
    });
    const retried = await processSendIntent(
      sendDeps(),
      ctx.scope as TenantScope,
      (await intentFor(messageId)).id,
    );
    expect(retried.outcome).toBe('retry_scheduled');
    expect(retried.retryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(retried.channelAccountId).toBe(c.channelAccountId);
    expect(await intentFor(messageId)).toMatchObject({
      state: 'queued',
      attempts: 1,
      sent_at: null,
    });

    const second = await queueTextMessage(outboundDeps(), ctx, {
      conversationId,
      text: 'Two',
      clientKey: 'ck-perm-1',
    });
    graphStandIn.state.sendQueue.push({
      kind: 'error',
      status: 400,
      code: 131047,
      message: 'Re-engagement message',
    });
    expect(
      (
        await processSendIntent(
          sendDeps(),
          ctx.scope as TenantScope,
          (await intentFor(second.messageId)).id,
        )
      ).outcome,
    ).toBe('failed');
    expect(await messageRow(second.messageId)).toMatchObject({
      status: 'failed',
      error_code: '131047',
    });
  });

  it('marks the number for reconnection when Meta rejects the token', async () => {
    const c = await companyWithChannel();
    const conversationId = await openConversation(c);
    const ctx = await ctxFor(c, c.agent);
    const { messageId } = await queueTextMessage(outboundDeps(), ctx, {
      conversationId,
      text: 'Hi',
      clientKey: 'ck-auth-1',
    });
    graphStandIn.state.tokens.get(c.token)!.valid = false;
    expect(
      (
        await processSendIntent(
          sendDeps(),
          ctx.scope as TenantScope,
          (await intentFor(messageId)).id,
        )
      ).outcome,
    ).toBe('failed');
    const [channel] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.channel_accounts WHERE id = $1',
      [c.channelAccountId],
    );
    expect(channel!.status).toBe('needs_reconnect');
  });

  it('never resends automatically when no response arrived; a member decides', async () => {
    const c = await companyWithChannel();
    const conversationId = await openConversation(c);
    const ctx = await ctxFor(c, c.agent);
    const dropped = await queueTextMessage(outboundDeps(), ctx, {
      conversationId,
      text: 'Dropped',
      clientKey: 'ck-unk-1',
    });
    graphStandIn.state.sendQueue.push({ kind: 'drop_connection' });
    expect(
      (
        await processSendIntent(
          sendDeps(),
          ctx.scope as TenantScope,
          (await intentFor(dropped.messageId)).id,
        )
      ).outcome,
    ).toBe('unknown_outcome');
    const timedOut = await queueTextMessage(outboundDeps(), ctx, {
      conversationId,
      text: 'Slow',
      clientKey: 'ck-unk-2',
    });
    graphStandIn.state.sendQueue.push({ kind: 'hang', ms: 3_000 });
    expect(
      (
        await processSendIntent(
          sendDeps(),
          ctx.scope as TenantScope,
          (await intentFor(timedOut.messageId)).id,
        )
      ).outcome,
    ).toBe('unknown_outcome');
    const sends = () =>
      graphStandIn.state.requests.filter((r) => r.path.endsWith('/messages')).length;
    const count = sends();
    // Workers and sweepers leave unknown outcomes alone.
    expect(
      (
        await processSendIntent(
          sendDeps(),
          ctx.scope as TenantScope,
          (await intentFor(dropped.messageId)).id,
        )
      ).outcome,
    ).toBe('not_claimable');
    expect(sends()).toBe(count);

    await resolveUnknownOutcome(outboundDeps(), ctx, {
      messageId: dropped.messageId,
      decision: 'mark_sent',
    });
    expect((await messageRow(dropped.messageId)).status).toBe('sent');
    await resolveUnknownOutcome(outboundDeps(), ctx, {
      messageId: timedOut.messageId,
      decision: 'resend',
    });
    expect(await intentFor(timedOut.messageId)).toMatchObject({ state: 'queued' });
    await expect(
      resolveUnknownOutcome(outboundDeps(), ctx, {
        messageId: dropped.messageId,
        decision: 'resend',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('recovers a dead worker: re-queues before dispatch, unknown outcome after', async () => {
    const c = await companyWithChannel();
    const conversationId = await openConversation(c);
    const ctx = await ctxFor(c, c.agent);
    const scope = authorizedTenantScope(c.tenant.id, null);
    const before = await queueTextMessage(outboundDeps(), ctx, {
      conversationId,
      text: 'A',
      clientKey: 'ck-lease-1',
    });
    const after = await queueTextMessage(outboundDeps(), ctx, {
      conversationId,
      text: 'B',
      clientKey: 'ck-lease-2',
    });
    await dbs.adminPool.query(
      `UPDATE app.send_intents SET state = 'sending', lease_until = now() - interval '1 minute', sent_at = NULL WHERE message_id = $1`,
      [before.messageId],
    );
    await dbs.adminPool.query(
      `UPDATE app.send_intents SET state = 'sending', lease_until = now() - interval '1 minute', sent_at = now() - interval '2 minutes' WHERE message_id = $1`,
      [after.messageId],
    );
    const stale = await adminQuery<{ id: string }>('SELECT id FROM ops.stale_send_intents(100)');
    const staleIds = stale.map((s) => s.id);
    expect(staleIds).toEqual(
      expect.arrayContaining([
        (await intentFor(before.messageId)).id,
        (await intentFor(after.messageId)).id,
      ]),
    );
    expect(
      await recoverExpiredSend(sendDeps(), scope, (await intentFor(before.messageId)).id),
    ).toBe('requeued');
    expect(await recoverExpiredSend(sendDeps(), scope, (await intentFor(after.messageId)).id)).toBe(
      'unknown_outcome',
    );
    expect((await messageRow(after.messageId)).status).toBe('unknown_outcome');
  });

  it('refuses free-form replies outside the 24-hour window', async () => {
    const c = await companyWithChannel();
    const old = Math.floor(Date.now() / 1000) - 25 * 3600;
    await deliver(
      webhookBody(c.wabaId, c.phoneNumberId, {
        messages: [{ waId: '919833333333', text: 'Old', timestamp: old }],
      }),
    );
    const [conv] = await adminQuery<{ id: string }>(
      'SELECT id FROM app.conversations WHERE tenant_id = $1',
      [c.tenant.id],
    );
    const ctx = await ctxFor(c, c.agent);
    await expect(
      queueTextMessage(outboundDeps(), ctx, {
        conversationId: conv!.id,
        text: 'Late',
        clientKey: 'ck-window-1',
      }),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  it('stops queued sends when the company is suspended', async () => {
    const c = await companyWithChannel();
    const conversationId = await openConversation(c);
    const ctx = await ctxFor(c, c.agent);
    const { messageId } = await queueTextMessage(outboundDeps(), ctx, {
      conversationId,
      text: 'Queued',
      clientKey: 'ck-susp-1',
    });
    const canceled = await cancelSendIntent(
      dbs.app,
      authorizedTenantScope(c.tenant.id, null),
      (await intentFor(messageId)).id,
      { code: 'company_suspended', message: 'Not sent: the company is suspended.' },
      systemClock,
    );
    expect(canceled).toBe(true);
    expect(await intentFor(messageId)).toMatchObject({ state: 'canceled' });
    expect(await messageRow(messageId)).toMatchObject({
      status: 'failed',
      error_code: 'company_suspended',
    });
  });
});

describe('inbox', () => {
  it('lets exactly one of two agents claim a conversation at the same version', async () => {
    const c = await companyWithChannel();
    await deliver(
      webhookBody(c.wabaId, c.phoneNumberId, {
        messages: [{ waId: '919844444444', text: 'Help' }],
      }),
    );
    const inbox = createInboxService({ db: dbs.app, clock: systemClock });
    const [ctx1, ctx2] = await Promise.all([ctxFor(c, c.agent), ctxFor(c, c.agent2)]);
    const { items } = await inbox.listConversations(ctx1, { view: 'unassigned' });
    const conv = items[0]!;
    const results = await Promise.allSettled([
      inbox.assign(ctx1, {
        conversationId: conv.id,
        membershipId: ctx1.membership.id,
        expectedVersion: conv.version,
      }),
      inbox.assign(ctx2, {
        conversationId: conv.id,
        membershipId: ctx2.membership.id,
        expectedVersion: conv.version,
      }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(
      isAppError(failed[0]) && ['conflict', 'forbidden', 'not_found'].includes(failed[0].code),
    ).toBe(true);

    // The losing agent can no longer see a conversation assigned to someone else.
    const winner = results[0]!.status === 'fulfilled' ? ctx1 : ctx2;
    const loser = winner === ctx1 ? ctx2 : ctx1;
    await expect(inbox.getConversation(loser, conv.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    const thread = await inbox.getConversation(winner, conv.id);
    expect(thread.conversation.assignedMembershipId).toBe(winner.membership.id);
    // Owners (read_all) see it and can reassign; stale versions are refused.
    const owner = await ctxFor(c, c.owner);
    await expect(
      inbox.assign(owner, {
        conversationId: conv.id,
        membershipId: null,
        expectedVersion: conv.version,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('keeps internal notes on the thread and resolves and reopens with version checks', async () => {
    const c = await companyWithChannel();
    await deliver(
      webhookBody(c.wabaId, c.phoneNumberId, {
        messages: [{ waId: '919877777777', text: 'Refund?' }],
      }),
    );
    const inbox = createInboxService({ db: dbs.app, clock: systemClock });
    const owner = await ctxFor(c, c.owner);
    const [first] = (await inbox.listConversations(owner, {})).items;
    await inbox.addNote(owner, {
      conversationId: first!.id,
      body: 'Order #1042, refund approved.',
    });
    let thread = await inbox.getConversation(owner, first!.id);
    expect(thread.notes.map((n) => n.body)).toEqual(['Order #1042, refund approved.']);
    await inbox.setStatus(owner, {
      conversationId: first!.id,
      status: 'resolved',
      expectedVersion: thread.conversation.version,
    });
    expect(
      (await inbox.listConversations(owner, { status: 'resolved' })).items.map((i) => i.id),
    ).toContain(first!.id);
    await expect(
      inbox.setStatus(owner, {
        conversationId: first!.id,
        status: 'open',
        expectedVersion: thread.conversation.version,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // A new customer message reopens a resolved conversation.
    await deliver(
      webhookBody(c.wabaId, c.phoneNumberId, {
        messages: [{ waId: '919877777777', text: 'Thanks!' }],
      }),
    );
    thread = await inbox.getConversation(owner, first!.id);
    expect(thread.conversation.status).toBe('open');
    // Agents without the thread cannot add notes to someone else's conversation.
    await inbox.assign(owner, {
      conversationId: first!.id,
      membershipId: owner.membership.id,
      expectedVersion: thread.conversation.version,
    });
    const agent = await ctxFor(c, c.agent);
    await expect(
      inbox.addNote(agent, { conversationId: first!.id, body: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('delivers company events in commit order through durable cursors, per company only', async () => {
    const a = await companyWithChannel();
    const b = await companyWithChannel();
    const scopeA = authorizedTenantScope(a.tenant.id, a.owner.id);
    const scopeB = authorizedTenantScope(b.tenant.id, b.owner.id);
    const cursorA = await currentEventCursor(dbs.app, scopeA);
    const cursorB = await currentEventCursor(dbs.app, scopeB);
    await deliver(
      webhookBody(a.wabaId, a.phoneNumberId, { messages: [{ waId: '919855555555', text: 'One' }] }),
    );
    await deliver(
      webhookBody(a.wabaId, a.phoneNumberId, { messages: [{ waId: '919855555555', text: 'Two' }] }),
    );
    const page = await readTenantEvents(dbs.app, scopeA, cursorA);
    expect(page.events.map((e) => e.type)).toEqual(['message.received', 'message.received']);
    const resumed = await readTenantEvents(dbs.app, scopeA, page.cursor);
    expect(resumed.events).toEqual([]);
    const other = await readTenantEvents(dbs.app, scopeB, cursorB);
    expect(other.events).toEqual([]);
  });
});

describe('Embedded Signup onboarding', () => {
  function metaConfig(): MetaConfig {
    return {
      appId: APP_ID,
      appSecret: APP_SECRET,
      webhookSecrets: [APP_SECRET],
      graphApiVersion: 'v26.0',
      graphBaseUrl: graphStandIn.baseUrl,
      webhookVerifyToken: 'verify',
      embeddedSignupConfigId: '777',
    };
  }
  function onboarding() {
    return createOnboardingService({
      db: dbs.app,
      keyring,
      jobs: new PgBossJobQueue(boss),
      signer,
      clock: systemClock,
      graph,
      meta: metaConfig(),
    });
  }
  async function ownerContext() {
    const owner = await createUser(dbs, { name: 'Signup Owner' });
    const tenant = await createTenant(dbs, owner);
    const ctx = await resolveTenantContext(
      { db: dbs.app, clock: systemClock, mfaGracePeriodHours: 72 },
      {
        userId: owner.id,
        sessionId: `sess_${owner.id}`,
        tenantSlug: tenant.slug,
        correlationId: uuidv7(),
      },
    );
    return { owner, tenant, ctx };
  }
  function grant(
    wabaId: string,
    phoneNumberId: string,
    overrides: { appId?: string; targets?: string[] } = {},
  ) {
    const code = `code-${randomBytes(8).toString('hex')}`;
    const token = `EAAG${randomBytes(12).toString('hex')}`;
    graphStandIn.state.codes.set(code, token);
    graphStandIn.state.tokens.set(token, {
      appId: overrides.appId ?? APP_ID,
      valid: true,
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      ...(overrides.targets
        ? { granular: [{ scope: 'whatsapp_business_management', target_ids: overrides.targets }] }
        : {}),
    });
    graphStandIn.state.wabaNumbers.set(wabaId, [phoneNumberId]);
    graphStandIn.state.numbers.set(phoneNumberId, {
      display_phone_number: '+91 98000 00000',
      verified_name: 'Signup Traders',
    });
    return { code, token };
  }

  it('verifies the grant, binds the assets, stores the token encrypted and finishes setup', async () => {
    const { ctx, tenant } = await ownerContext();
    const service = onboarding();
    const wabaId = nextId();
    const phoneNumberId = nextId();
    const { code, token } = grant(wabaId, phoneNumberId, { targets: [wabaId] });
    const started = await service.start(ctx);
    expect(started).toMatchObject({ appId: APP_ID, configId: '777', graphApiVersion: 'v26.0' });
    const { channelAccountId, whatsappAccountId } = await service.complete(ctx, {
      state: started.state,
      code,
      wabaId,
      phoneNumberId,
    });
    const [account] = await adminQuery<{ credential_ciphertext: string }>(
      'SELECT credential_ciphertext FROM app.whatsapp_accounts WHERE id = $1',
      [whatsappAccountId],
    );
    expect(account!.credential_ciphertext).not.toContain(token);
    expect(
      keyring.decryptString(
        account!.credential_ciphertext,
        credentialAad(tenant.id, whatsappAccountId),
      ),
    ).toBe(token);
    // The same state cannot be used twice.
    await expect(
      service.complete(ctx, { state: started.state, code, wabaId, phoneNumberId }),
    ).rejects.toMatchObject({ code: 'precondition_failed' });

    const outcome = await processChannelOnboarding(
      { db: dbs.app, keyring, graph, clock: systemClock },
      authorizedTenantScope(tenant.id, null),
      channelAccountId,
    );
    expect(outcome).toBe('active');
    const [channel] = await adminQuery<{
      status: string;
      verified_name: string;
      onboarding_step: string;
    }>('SELECT status, verified_name, onboarding_step FROM app.channel_accounts WHERE id = $1', [
      channelAccountId,
    ]);
    expect(channel).toEqual({
      status: 'active',
      verified_name: 'Signup Traders',
      onboarding_step: 'done',
    });
    const register = graphStandIn.state.requests.find(
      (r) => r.path === `/v26.0/${phoneNumberId}/register`,
    );
    expect(register?.body).toMatchObject({ messaging_product: 'whatsapp' });
    expect((register?.body as { pin: string }).pin).toMatch(/^\d{6}$/);
  });

  it('rejects tokens for another app, unshared accounts, foreign numbers and assets owned elsewhere', async () => {
    const service = onboarding();
    const attempt = async (
      setup: (wabaId: string, phoneNumberId: string) => { code: string },
      named?: { wabaId?: string; phoneNumberId?: string },
    ) => {
      const { ctx } = await ownerContext();
      const wabaId = nextId();
      const phoneNumberId = nextId();
      const { code } = setup(wabaId, phoneNumberId);
      const started = await service.start(ctx);
      return service.complete(ctx, {
        state: started.state,
        code,
        wabaId: named?.wabaId ?? wabaId,
        phoneNumberId: named?.phoneNumberId ?? phoneNumberId,
      });
    };
    await expect(attempt((w, p) => grant(w, p, { appId: '999' }))).rejects.toMatchObject({
      code: 'provider_rejected',
    });
    await expect(attempt((w, p) => grant(w, p, { targets: ['1'] }))).rejects.toMatchObject({
      code: 'provider_rejected',
    });
    await expect(attempt((w, p) => grant(w, p), { phoneNumberId: nextId() })).rejects.toMatchObject(
      {
        code: 'provider_rejected',
      },
    );
    // Assets already connected to another company.
    const taken = await companyWithChannel();
    const { ctx } = await ownerContext();
    const { code } = grant(taken.wabaId, taken.phoneNumberId);
    const started = await service.start(ctx);
    await expect(
      service.complete(ctx, {
        state: started.state,
        code,
        wabaId: taken.wabaId,
        phoneNumberId: taken.phoneNumberId,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('binds the attempt to the member and browser session that started it', async () => {
    const { ctx, tenant, owner } = await ownerContext();
    const service = onboarding();
    const wabaId = nextId();
    const phoneNumberId = nextId();
    const { code } = grant(wabaId, phoneNumberId);
    const started = await service.start(ctx);
    const otherSession = await resolveTenantContext(
      { db: dbs.app, clock: systemClock, mfaGracePeriodHours: 72 },
      {
        userId: owner.id,
        sessionId: 'sess_other_browser',
        tenantSlug: tenant.slug,
        correlationId: uuidv7(),
      },
    );
    await expect(
      service.complete(otherSession, { state: started.state, code, wabaId, phoneNumberId }),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  it('records a failed registration with a clear reason', async () => {
    const { ctx, tenant } = await ownerContext();
    const service = onboarding();
    const wabaId = nextId();
    const phoneNumberId = nextId();
    const { code } = grant(wabaId, phoneNumberId);
    const started = await service.start(ctx);
    const { channelAccountId } = await service.complete(ctx, {
      state: started.state,
      code,
      wabaId,
      phoneNumberId,
    });
    graphStandIn.state.registerError = {
      status: 400,
      code: 133016,
      message: 'Too many registration attempts',
    };
    const outcome = await processChannelOnboarding(
      { db: dbs.app, keyring, graph, clock: systemClock },
      authorizedTenantScope(tenant.id, null),
      channelAccountId,
    );
    expect(outcome).toBe('failed');
    const [channel] = await dbs.app.run(authorizedTenantScope(tenant.id, null), (tx) =>
      tx
        .select({
          status: channelAccounts.status,
          error: channelAccounts.onboardingError,
          step: channelAccounts.onboardingStep,
        })
        .from(channelAccounts)
        .where(eq(channelAccounts.id, channelAccountId)),
    );
    expect(channel).toMatchObject({ status: 'failed', step: 'register_number' });
    expect(channel!.error).toMatch(/72 hours/);
  });
});

describe('retention', () => {
  it('erases raw bodies after 7 days, deletes receipts after 90 and prunes old live events', async () => {
    const c = await companyWithChannel();
    const recent = await deliver(
      webhookBody(c.wabaId, c.phoneNumberId, {
        messages: [{ waId: '919866666666', text: 'Recent' }],
      }),
    );
    const week = await deliver(
      webhookBody(c.wabaId, c.phoneNumberId, {
        messages: [{ waId: '919866666666', text: 'Week' }],
      }),
    );
    const old = await deliver(
      webhookBody(nextId(), nextId(), { messages: [{ waId: '919866666667', text: 'Old' }] }),
    );
    await dbs.adminPool.query(
      `UPDATE ops.webhook_receipts SET received_at = now() - interval '8 days' WHERE id = $1`,
      [week.receiptId],
    );
    await dbs.adminPool.query(
      `UPDATE ops.webhook_receipts SET received_at = now() - interval '91 days' WHERE id = $1`,
      [old.receiptId],
    );
    await dbs.adminPool.query(
      `UPDATE app.tenant_events SET created_at = now() - interval '8 days' WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    const result = await applyMessagingRetention(dbs.app);
    expect(result.bodiesErased).toBeGreaterThanOrEqual(1);
    expect(result.receiptsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.eventsPruned).toBeGreaterThanOrEqual(1);
    const rows = await adminQuery<{ id: string; has_body: boolean }>(
      'SELECT id, body_ciphertext IS NOT NULL AS has_body FROM ops.webhook_receipts WHERE id = ANY($1::uuid[])',
      [[recent.receiptId, week.receiptId, old.receiptId]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.has_body]));
    expect(byId[recent.receiptId]).toBe(true);
    expect(byId[week.receiptId]).toBe(false);
    expect(old.receiptId in byId).toBe(false);
    const events = await adminQuery<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.tenant_events WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(events[0]!.n).toBe(0);
    // The processed message itself is untouched by receipt retention.
    const messages = await adminQuery<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.messages WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(messages[0]!.n).toBe(2);
  });
});
