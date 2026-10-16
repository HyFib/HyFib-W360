import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import { sql } from '@w360/db';
import {
  METRIC_DEFINITIONS,
  createBusinessHoursService,
  createCampaignsService,
  currentMetricDefinitions,
  createInboxService,
  createTeamsService,
  createReportsService,
  dayOf,
  queueTextMessage,
  type Report,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Reports against real PostgreSQL: persisted metric definitions, reply turns maintained by
 * triggers on every write path, and report numbers checked against hand-computed expectations
 * (denominators, percentiles, time-zone days, cost estimates with unpriced reasons), plus exports
 * and permissions.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.publicMessage).toMatch(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

const H = 3_600_000;
const MIN = 60_000;

describe('metric definitions', () => {
  it('the persisted definitions are exactly the registry and cannot be changed', async () => {
    const rows = await fx.query<Record<string, unknown>>(
      `SELECT key, version, label, unit, description, numerator, denominator, window_rule,
              timezone_rule, missing_data, freshness, available
         FROM ops.metric_definitions ORDER BY key, version`,
    );
    const persisted = rows.map((r) => ({
      key: r.key,
      version: r.version,
      label: r.label,
      unit: r.unit,
      description: r.description,
      numerator: r.numerator,
      denominator: r.denominator,
      window: r.window_rule,
      timezoneRule: r.timezone_rule,
      missingData: r.missing_data,
      freshness: r.freshness,
      available: r.available,
    }));
    const registry = [...METRIC_DEFINITIONS].sort((a, b) =>
      a.key === b.key ? a.version - b.version : a.key < b.key ? -1 : 1,
    );
    expect(persisted).toEqual(registry);

    await expect(
      fx.dbs.appPool.query(`UPDATE ops.metric_definitions SET label = 'x'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      fx.dbs.appPool.query(
        `INSERT INTO ops.metric_definitions (key, version, label, unit, description, numerator,
           missing_data, freshness, available)
         VALUES ('fake.metric', 1, 'Fake', 'count', 'x', 'x', 'x', 'x', true)`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(fx.query(`UPDATE ops.metric_definitions SET label = 'x'`)).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('reply turns', () => {
  it('open on customer messages and close on a member reply or when resolved', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const inbox = createInboxService({ db: fx.dbs.app, clock: systemClock });
    const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
    const turns = (conversationId: string) =>
      fx.query<{ end_reason: string | null; ended_by_membership_id: string | null }>(
        `SELECT end_reason, ended_by_membership_id FROM app.conversation_turns
          WHERE conversation_id = $1 ORDER BY started_at, created_at`,
        [conversationId],
      );

    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919811100001', text: 'Hi' }] }));
    const [conv] = await fx.query<{ id: string; version: number }>(
      `SELECT id, version FROM app.conversations WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    expect(await turns(conv!.id)).toEqual([{ end_reason: null, ended_by_membership_id: null }]);
    // A second message joins the waiting turn; a reaction does not start or change one.
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [
          { waId: '919811100001', text: 'Anyone there?' },
          {
            waId: '919811100001',
            type: 'reaction',
            extra: { reaction: { message_id: 'wamid.x', emoji: '👍' } },
          },
        ],
      }),
    );
    expect(await turns(conv!.id)).toHaveLength(1);

    await queueTextMessage(deps, owner, {
      conversationId: conv!.id,
      text: 'Hello! How can we help?',
      clientKey: `ck_${uuidv7()}`,
    });
    expect(await turns(conv!.id)).toEqual([
      { end_reason: 'replied', ended_by_membership_id: c.tenant.ownerMembershipId },
    ]);

    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919811100001', text: 'Thanks' }] }));
    const [current] = await fx.query<{ version: number }>(
      `SELECT version FROM app.conversations WHERE id = $1`,
      [conv!.id],
    );
    await inbox.setStatus(owner, {
      conversationId: conv!.id,
      status: 'resolved',
      expectedVersion: current!.version,
    });
    expect(await turns(conv!.id)).toEqual([
      { end_reason: 'replied', ended_by_membership_id: c.tenant.ownerMembershipId },
      { end_reason: 'resolved', ended_by_membership_id: c.tenant.ownerMembershipId },
    ]);
    const audit = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'conversation.status_changed'`,
      [c.tenant.id],
    );
    expect(audit.map((a) => a.metadata)).toEqual([{ from: 'open', to: 'resolved' }]);

    // Turns are written by the database only: the runtime role cannot rewrite or delete them.
    const [turn] = await fx.query<{ id: string }>(
      `SELECT id FROM app.conversation_turns WHERE conversation_id = $1 LIMIT 1`,
      [conv!.id],
    );
    await expectAppError(
      fx.dbs.app.run(owner.scope, (tx) =>
        tx.execute(
          sql`UPDATE app.conversation_turns SET started_at = now() WHERE id = ${turn!.id}`,
        ),
      ),
      'forbidden',
    );
    await expectAppError(
      fx.dbs.app.run(owner.scope, (tx) =>
        tx.execute(sql`DELETE FROM app.conversation_turns WHERE id = ${turn!.id}`),
      ),
      'forbidden',
    );
    await expect(
      fx.query(`UPDATE app.conversation_turns SET end_reason = 'replied' WHERE id = $1`, [
        turn!.id,
      ]),
    ).rejects.toThrow(/closed reply turn cannot change/);
  });
});

describe('company report', () => {
  interface Seed {
    c: Company;
    now: number;
    agentMembershipId: string;
    conv: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F', { conversationId: string; contactId: string }>;
    at: Record<string, Date>;
  }

  let seed: Seed;
  let report: Report;

  async function conversation(
    c: Company,
    phone: string,
    assigned: string | null = null,
  ): Promise<{ conversationId: string; contactId: string }> {
    const contactId = uuidv7();
    const conversationId = uuidv7();
    await fx.query(
      `INSERT INTO app.contacts (id, tenant_id, phone_e164, display_name, source)
       VALUES ($1, $2, $3, 'Seeded', 'manual')`,
      [contactId, c.tenant.id, phone],
    );
    await fx.query(
      `INSERT INTO app.conversations (id, tenant_id, channel_account_id, contact_id, assigned_membership_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [conversationId, c.tenant.id, c.channelAccountId, contactId, assigned],
    );
    return { conversationId, contactId };
  }

  interface MessageSpec {
    direction: 'inbound' | 'outbound';
    sender: 'contact' | 'agent' | 'campaign' | 'api';
    type?: string;
    status: string;
    at: Date;
    membershipId?: string;
    errorCode?: string;
    pricing?: Record<string, unknown>;
    recipient?: string;
    campaignId?: string;
  }

  async function message(c: Company, conversationId: string, m: MessageSpec): Promise<string> {
    const id = uuidv7();
    await fx.query(
      `INSERT INTO app.messages (id, tenant_id, conversation_id, channel_account_id, direction,
         external_message_id, type, content, status, sender_type, sender_membership_id, error_code,
         pricing, campaign_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        c.tenant.id,
        conversationId,
        c.channelAccountId,
        m.direction,
        `wamid.seed.${id}`,
        m.type ?? 'text',
        m.status,
        m.sender,
        m.membershipId ?? null,
        m.errorCode ?? null,
        m.pricing ? JSON.stringify(m.pricing) : null,
        m.campaignId ?? null,
        m.at,
      ],
    );
    if (m.recipient) {
      await fx.query(
        `INSERT INTO app.message_status_events (id, tenant_id, channel_account_id, message_id,
           external_message_id, status, provider_timestamp, recipient_wa_id)
         VALUES ($1, $2, $3, $4, $5, 'delivered', $6, $7)`,
        [uuidv7(), c.tenant.id, c.channelAccountId, id, `wamid.seed.${id}`, m.at, m.recipient],
      );
    }
    return id;
  }

  const billable = (category: string) => ({
    billable: true,
    pricing_model: 'PMP',
    type: 'regular',
    category,
  });

  beforeAll(async () => {
    const c = await fx.company();
    const now = Date.now();
    const t = (ms: number) => new Date(now - ms);
    const [agentMembership] = await fx.query<{ id: string }>(
      `SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2`,
      [c.tenant.id, c.agent.id],
    );
    const agentMembershipId = agentMembership!.id;
    const ownerMembershipId = c.tenant.ownerMembershipId;

    // A published SGD rate card (a currency no other suite uses): India and Singapore.
    const cardId = uuidv7();
    await fx.query(
      `INSERT INTO ops.rate_cards (id, currency, effective_from, source_url, created_by_user_id)
       VALUES ($1, 'SGD', now() - interval '30 days', 'https://example.test/sgd', $2)`,
      [cardId, c.owner.id],
    );
    await fx.query(
      `INSERT INTO ops.rate_card_prefixes (rate_card_id, prefix, market)
       VALUES ($1, '91', 'India'), ($1, '65', 'Singapore')`,
      [cardId],
    );
    await fx.query(
      `INSERT INTO ops.rate_card_prices (rate_card_id, market, category, price_micros)
       VALUES ($1, 'India', 'marketing', 150000), ($1, 'India', 'utility', 20000),
              ($1, 'Singapore', 'marketing', 300000)`,
      [cardId],
    );
    await fx.query(`UPDATE ops.rate_cards SET status = 'published' WHERE id = $1`, [cardId]);
    const owner = await fx.ctx(c, c.owner);
    const campaignsSvc = createCampaignsService({
      db: fx.dbs.app,
      jobs: fx.jobs(),
      signer: fx.signer,
      clock: systemClock,
      notices: fx.notices(),
    });
    await campaignsSvc.updateSettings(
      owner,
      { approvalRequired: false, cap: null, costCurrency: 'SGD' },
      {},
    );
    const inbox = createInboxService({ db: fx.dbs.app, clock: systemClock });
    await inbox.updateResponseTarget(owner, { minutes: 60 });

    const conv = {
      A: await conversation(c, '+919876500001'),
      B: await conversation(c, '+919876500002'),
      C: await conversation(c, '+919876500003', agentMembershipId),
      D: await conversation(c, '+8801711000004'),
      E: await conversation(c, '+919876500005'),
      F: await conversation(c, '+919876500006'),
    };
    const at = {
      m1: t(50 * H),
      m2: t(50 * H - 30_000),
      m3: t(50 * H - MIN),
      m4: t(50 * H - 10 * MIN),
      m5: t(48 * H),
      m6: t(48 * H - 2 * MIN),
      m7: t(26 * H),
      m8: t(23 * H),
      m9: t(30 * MIN),
      m10: t(23 * H),
      m11: t(24 * H),
      m12: t(5 * H),
      m13: t(6 * H),
      f1: t(240 * H),
      f2: t(240 * H - 5 * MIN),
    };

    // A campaign started in the period and one started before it.
    const campaignId = uuidv7();
    const oldCampaignId = uuidv7();
    for (const [id, name, started] of [
      [campaignId, '=HYPERLINK("https://example.test")', t(6 * H)],
      [oldCampaignId, 'Old campaign', t(480 * H)],
    ] as const) {
      await fx.query(
        `INSERT INTO app.campaigns (id, tenant_id, name, status, timezone, started_at, canceled_at,
           estimate_currency)
         VALUES ($1, $2, $3, 'canceled', 'Asia/Kolkata', $4, $4, 'SGD')`,
        [id, c.tenant.id, name, started],
      );
    }

    const A = conv.A.conversationId;
    await message(c, A, { direction: 'inbound', sender: 'contact', status: 'received', at: at.m1 });
    await message(c, A, {
      direction: 'inbound',
      sender: 'contact',
      type: 'reaction',
      status: 'received',
      at: at.m2,
    });
    await message(c, A, { direction: 'inbound', sender: 'contact', status: 'received', at: at.m3 });
    await message(c, A, {
      direction: 'outbound',
      sender: 'agent',
      membershipId: ownerMembershipId,
      status: 'read',
      at: at.m4,
      pricing: {
        billable: false,
        pricing_model: 'PMP',
        type: 'free_customer_service',
        category: 'service',
      },
      recipient: '919876500001',
    });
    await message(c, A, { direction: 'inbound', sender: 'contact', status: 'received', at: at.m5 });
    await message(c, A, {
      direction: 'outbound',
      sender: 'agent',
      type: 'template',
      membershipId: agentMembershipId,
      status: 'delivered',
      at: at.m6,
      pricing: billable('utility'),
      recipient: '919876500001',
    });

    const B = conv.B.conversationId;
    await message(c, B, { direction: 'inbound', sender: 'contact', status: 'received', at: at.m7 });
    await message(c, B, {
      direction: 'outbound',
      sender: 'agent',
      membershipId: ownerMembershipId,
      status: 'sent',
      at: at.m8,
    });

    await message(c, conv.C.conversationId, {
      direction: 'inbound',
      sender: 'contact',
      status: 'received',
      at: at.m9,
    });
    await fx.query(`UPDATE app.conversations SET last_inbound_at = $2 WHERE id = $1`, [
      conv.C.conversationId,
      at.m9,
    ]);

    const D = conv.D.conversationId;
    const m11 = await message(c, D, {
      direction: 'outbound',
      sender: 'campaign',
      type: 'template',
      status: 'delivered',
      at: at.m11,
      pricing: billable('marketing'),
      recipient: '8801711000004',
      campaignId,
    });
    await message(c, D, {
      direction: 'inbound',
      sender: 'contact',
      status: 'received',
      at: at.m10,
    });
    await fx.query(`UPDATE app.conversations SET last_inbound_at = $2 WHERE id = $1`, [D, at.m10]);

    const E = conv.E.conversationId;
    await message(c, E, {
      direction: 'inbound',
      sender: 'contact',
      status: 'received',
      at: at.m12,
    });
    const m13 = await message(c, E, {
      direction: 'outbound',
      sender: 'campaign',
      type: 'template',
      status: 'delivered',
      at: at.m13,
      pricing: billable('marketing'),
      recipient: '919876500005',
      campaignId,
    });
    const m14 = await message(c, E, {
      direction: 'outbound',
      sender: 'campaign',
      type: 'template',
      status: 'failed',
      errorCode: '131049',
      at: at.m13,
      campaignId,
    });
    await message(c, E, { direction: 'outbound', sender: 'api', status: 'canceled', at: at.m13 });
    // Delivered, but Meta has not reported pricing yet.
    await message(c, E, {
      direction: 'outbound',
      sender: 'campaign',
      type: 'template',
      status: 'delivered',
      at: at.m13,
      recipient: '919876500005',
    });
    await message(c, E, {
      direction: 'outbound',
      sender: 'api',
      status: 'unknown_outcome',
      at: at.m13,
    });
    // Billable, but the card has no authentication price for India / no rate for this category.
    await message(c, E, {
      direction: 'outbound',
      sender: 'api',
      type: 'template',
      status: 'delivered',
      at: at.m13,
      pricing: billable('authentication'),
      recipient: '919876500005',
    });
    await message(c, E, {
      direction: 'outbound',
      sender: 'api',
      type: 'template',
      status: 'delivered',
      at: at.m13,
      pricing: billable('marketing_lite'),
      recipient: '919876500005',
    });
    // Resolved by the system (no member) without a reply.
    await fx.query(
      `UPDATE app.conversations SET status = 'resolved', resolved_at = $2 WHERE id = $1`,
      [E, t(4 * H)],
    );

    // Before the period: a turn answered 10 days ago.
    const F = conv.F.conversationId;
    await message(c, F, { direction: 'inbound', sender: 'contact', status: 'received', at: at.f1 });
    await message(c, F, {
      direction: 'outbound',
      sender: 'agent',
      membershipId: ownerMembershipId,
      status: 'delivered',
      at: at.f2,
    });

    // Campaign recipients: two delivered, one failed, one skipped.
    const recipients: [string, string, string | null, string | null, number | null, string][] = [
      [conv.E.contactId, 'queued', null, m13, 150000, 'replied'],
      [conv.D.contactId, 'queued', null, m11, null, 'opted_out'],
      [conv.A.contactId, 'queued', null, m14, 150000, ''],
      [conv.B.contactId, 'skipped', 'no_marketing_opt_in', null, null, ''],
    ];
    for (const [contactId, state, reason, messageId, cost, outcome] of recipients) {
      await fx.query(
        `INSERT INTO app.campaign_recipients (id, tenant_id, campaign_id, contact_id, state,
           skip_reason, message_id, estimated_cost_micros, queued_at, replied_at, opted_out_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          uuidv7(),
          c.tenant.id,
          campaignId,
          contactId,
          state,
          reason,
          messageId,
          cost,
          messageId ? at.m13 : null,
          outcome === 'replied' ? at.m12 : null,
          outcome === 'opted_out' ? at.m10 : null,
        ],
      );
    }

    // A member resolves B through the inbox (audited; its turn was already answered).
    const [b] = await fx.query<{ version: number }>(
      `SELECT version FROM app.conversations WHERE id = $1`,
      [B],
    );
    await inbox.setStatus(owner, {
      conversationId: B,
      status: 'resolved',
      expectedVersion: b!.version,
    });

    seed = { c, now, agentMembershipId, conv, at };
    const reports = createReportsService({ db: fx.dbs.app, clock: systemClock });
    report = await reports.getReport(owner, { preset: 'last_7_days' });
  });

  it('uses whole days in the company time zone', () => {
    const { period } = report;
    expect(period.timezone).toBe('Asia/Kolkata');
    expect(period.days).toHaveLength(7);
    expect(period.to).toBe(dayOf(new Date(seed.now), 'Asia/Kolkata'));
    expect(period.inProgress).toBe(true);
    // Midnight in Kolkata is 18:30 UTC the day before.
    expect(period.start.toISOString()).toMatch(/T18:30:00\.000Z$/);
    expect(period.end.getTime() - period.start.getTime()).toBe(7 * 24 * H);
  });

  it('counts messaging outcomes with their denominators', () => {
    const m = report.messaging;
    expect(m.totals).toEqual({
      inbound: 7,
      outbound: 11,
      byMember: 3,
      byCampaign: 4,
      byOther: 4,
      canceled: 1,
      inProgress: 0,
      sent: 8,
      delivered: 7,
      read: 1,
      failed: 1,
      unknown: 1,
    });
    expect(m.rates).toEqual({
      sent: { numerator: 8, denominator: 10 },
      delivered: { numerator: 7, denominator: 8 },
      read: { numerator: 1, denominator: 7 },
      failure: { numerator: 2, denominator: 10 },
    });
    expect(m.failureCodes).toEqual([{ code: '131049', count: 1 }]);
    // Days are the Kolkata calendar days of each message.
    const inboundDays = new Map<string, number>();
    for (const key of ['m1', 'm3', 'm5', 'm7', 'm9', 'm10', 'm12']) {
      const day = dayOf(seed.at[key]!, 'Asia/Kolkata');
      inboundDays.set(day, (inboundDays.get(day) ?? 0) + 1);
    }
    for (const d of m.days) expect(d.inbound).toBe(inboundDays.get(d.day) ?? 0);
  });

  it('estimates Meta charges for delivered billable messages and lists what it cannot price', () => {
    expect(report.costs).toMatchObject({
      currency: 'SGD',
      delivered: 7,
      billable: 5,
      free: 1,
      notReported: 1,
      priced: 2,
      totalMicros: 170000,
      unpriced: { noCurrency: 0, noRateCard: 0, otherCategory: 1, marketUnknown: 1, noPrice: 1 },
    });
    expect(report.costs.lines).toEqual([
      { category: 'marketing', market: 'India', count: 1, micros: 150000 },
      { category: 'utility', market: 'India', count: 1, micros: 20000 },
    ]);
    expect(report.costs.cards).toHaveLength(1);
  });

  it('reports the queue now and reply times of turns started in the period', () => {
    const { inbox } = report;
    expect(inbox.targetMinutes).toBe(60);
    expect(inbox.now).toMatchObject({
      open: 4,
      unassigned: 3,
      waiting: 2,
      windowsClosing: 1,
      windowsClosed: 0,
      overTarget: 1,
    });
    expect(inbox.now.oldestWaitSeconds).toBeGreaterThanOrEqual(23 * 3600);
    expect(inbox.now.oldestWaitSeconds).toBeLessThan(23 * 3600 + 120);
    expect(inbox.now.byAssignee.map((a) => [a.membershipId, a.name, a.waiting])).toEqual([
      [null, null, 1],
      [seed.agentMembershipId, 'Agent', 1],
    ]);
    expect(inbox.turns).toMatchObject({
      started: 6,
      answered: 3,
      resolvedWithoutReply: 1,
      waiting: 2,
      medianSeconds: 600,
      buckets: { upTo5m: 1, upTo1h: 1, upTo24h: 1, over24h: 0 },
      withinTarget: { numerator: 2, denominator: 4 },
    });
    // 90th percentile of 120 s, 600 s and 10,800 s, interpolated: 600 + 0.8 × 10,200.
    expect(inbox.turns.p90Seconds).toBeCloseTo(8760, 6);
    expect(inbox.days.reduce((n, d) => n + d.started, 0)).toBe(6);
  });

  it('shows member activity, including members who can reply but were quiet', () => {
    const rows = report.agents.map((a) => ({
      name: a.name,
      replies: a.replies,
      templates: a.templates,
      turnsAnswered: a.turnsAnswered,
      medianSeconds: a.medianSeconds,
      resolved: a.resolved,
    }));
    expect(rows).toEqual([
      {
        name: 'Owner',
        replies: 2,
        templates: 0,
        turnsAnswered: 2,
        medianSeconds: 5700,
        resolved: 1,
      },
      {
        name: 'Agent',
        replies: 1,
        templates: 1,
        turnsAnswered: 1,
        medianSeconds: 120,
        resolved: 0,
      },
    ]);
  });

  it('lists the funnel of campaigns started in the period', () => {
    expect(report.campaigns.truncated).toBe(false);
    expect(report.campaigns.rows).toHaveLength(1);
    expect(report.campaigns.rows[0]).toMatchObject({
      name: '=HYPERLINK("https://example.test")',
      status: 'canceled',
      currency: 'SGD',
      audience: 4,
      skipped: 1,
      queued: 3,
      sent: 2,
      delivered: 2,
      read: 0,
      failed: 1,
      unknown: 0,
      replied: 1,
      optedOut: 1,
      estimateMicros: 300000,
      estimateMissing: 1,
    });
  });

  it('includes the current version of every definition, with unavailable metrics marked', () => {
    expect(report.definitions).toEqual(currentMetricDefinitions());
    // Automations changed what a reply turn is (migration 0011): a new version, not an edit.
    expect(report.definitions.find((d) => d.key === 'inbox.within_target')?.version).toBe(3);
    expect(report.definitions.find((d) => d.key === 'automation.outcomes')).toMatchObject({
      version: 2,
      available: true,
    });
    // CRM deals became measurable (migration 0013): deal outcomes are a new, available version.
    expect(report.definitions.find((d) => d.key === 'crm.deal_outcomes')).toMatchObject({
      version: 2,
      available: true,
    });
    const unavailable = report.definitions.filter((d) => !d.available).map((d) => d.key);
    expect(unavailable).toEqual(['campaign.clicked', 'campaign.converted', 'contacts.retention']);
  });

  it('exports sections as formula-safe CSV for members with reports.export, audited', async () => {
    const { c } = seed;
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    const agent = await fx.ctx(c, c.agent);
    const reports = createReportsService({ db: fx.dbs.app, clock: systemClock });

    const costs = await reports.exportSection(owner, { preset: 'last_7_days' }, 'costs');
    expect(costs.filename).toBe(`costs-${report.period.from}-to-${report.period.to}.csv`);
    expect(costs.body.startsWith('\uFEFFstatus,pricing_category,market')).toBe(true);
    expect(costs.body).toContain('priced,marketing,India,1,0.15,150000,SGD\r\n');
    expect(costs.body).toContain('unpriced_market_unknown,,,1,,,SGD\r\n');

    const funnel = await reports.exportSection(owner, { preset: 'last_7_days' }, 'campaigns');
    expect(funnel.body).toContain(`"'=HYPERLINK(""https://example.test"")",canceled`);

    const audits = await fx.query<{ subject_id: string; metadata: Record<string, unknown> }>(
      `SELECT subject_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'report.exported' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(audits.map((a) => a.subject_id)).toEqual(['costs', 'campaigns']);
    expect(audits[0]!.metadata).toMatchObject({ preset: 'last_7_days', timezone: 'Asia/Kolkata' });

    // Marketers can read reports but not export them; agents cannot read them.
    await reports.getReport(marketer, {});
    await expectAppError(reports.exportSection(marketer, {}, 'messaging'), 'forbidden');
    await expectAppError(reports.getReport(agent, {}), 'forbidden');
    await expectAppError(reports.exportSection(owner, {}, 'contacts'), 'validation_failed');
  });

  it('rejects periods that are too long or end in the future', async () => {
    const owner = await fx.ctx(seed.c, seed.c.owner);
    const reports = createReportsService({ db: fx.dbs.app, clock: systemClock });
    await expectAppError(
      reports.getReport(owner, { preset: 'custom', from: '2026-01-01', to: '2026-06-30' }),
      'validation_failed',
      /at most 92 days/,
    );
    await expectAppError(
      reports.getReport(owner, { preset: 'custom', from: '2026-09-01', to: '2099-01-01' }),
      'validation_failed',
      /cannot end after today/,
    );
  });

  it('another company sees none of these numbers', async () => {
    const other = await fx.company();
    const owner = await fx.ctx(other, other.owner);
    const reports = createReportsService({ db: fx.dbs.app, clock: systemClock });
    const r = await reports.getReport(owner, { preset: 'last_30_days' });
    expect(r.messaging.totals.inbound + r.messaging.totals.outbound).toBe(0);
    expect(r.inbox.turns.started).toBe(0);
    expect(r.campaigns.rows).toEqual([]);
    expect(r.costs.delivered).toBe(0);
  });
});

describe('business hours, resolution time and CSAT', () => {
  // Saturday 2026-09-26 11:30 in Asia/Kolkata (the company's time zone, UTC+05:30).
  const clock = { now: () => new Date('2026-09-26T06:00:00Z') };
  const period = { preset: 'custom', from: '2026-09-14', to: '2026-09-20' };
  let c: Company;
  let agentMembershipId: string;
  let r: Report;
  /** Conversations of the fixture, for moving them into a team. */
  const seeded = new Map<string, string>();

  async function seededConversation(createdAt: string): Promise<string> {
    const contactId = uuidv7();
    const conversationId = uuidv7();
    await fx.query(
      `INSERT INTO app.contacts (id, tenant_id, display_name, source) VALUES ($1, $2, 'Seeded', 'manual')`,
      [contactId, c.tenant.id],
    );
    await fx.query(
      `INSERT INTO app.conversations (id, tenant_id, channel_account_id, contact_id, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [conversationId, c.tenant.id, c.channelAccountId, contactId, createdAt],
    );
    return conversationId;
  }

  async function seededMessage(
    conversationId: string,
    direction: 'inbound' | 'outbound',
    at: string,
    extra: { sender?: string; status?: string; type?: string } = {},
  ): Promise<string> {
    const id = uuidv7();
    await fx.query(
      `INSERT INTO app.messages (id, tenant_id, conversation_id, channel_account_id, direction, type,
         content, status, sender_type, sender_membership_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8, $9, $10)`,
      [
        id,
        c.tenant.id,
        conversationId,
        c.channelAccountId,
        direction,
        extra.type ?? 'text',
        extra.status ?? (direction === 'inbound' ? 'received' : 'delivered'),
        extra.sender ?? (direction === 'inbound' ? 'contact' : 'agent'),
        direction === 'outbound' && (extra.sender ?? 'agent') === 'agent'
          ? agentMembershipId
          : null,
        at,
      ],
    );
    return id;
  }

  const resolve = (conversationId: string, at: string) =>
    fx.query(`UPDATE app.conversations SET status = 'resolved', resolved_at = $2 WHERE id = $1`, [
      conversationId,
      at,
    ]);

  async function survey(
    conversationId: string,
    createdAt: string,
    s: { status?: string; score?: number; skip?: string },
  ) {
    const messageId = s.skip
      ? null
      : await seededMessage(conversationId, 'outbound', createdAt, {
          sender: 'system',
          type: 'interactive',
          status: s.status ?? 'delivered',
        });
    await fx.query(
      `INSERT INTO app.csat_surveys (id, tenant_id, conversation_id, message_id, skip_reason,
         assigned_membership_id, score, answered_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        uuidv7(),
        c.tenant.id,
        conversationId,
        messageId,
        s.skip ?? null,
        agentMembershipId,
        s.score ?? null,
        s.score ? createdAt : null,
        createdAt,
      ],
    );
  }

  beforeAll(async () => {
    c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    agentMembershipId = (await fx.ctx(c, c.agent)).membership.id;
    await createInboxService({ db: fx.dbs.app, clock }).updateResponseTarget(owner, {
      minutes: 60,
    });
    await createBusinessHoursService({ db: fx.dbs.app, clock }).updateBusinessHours(owner, {
      enabled: true,
      days: ['09:00-17:00', '09:00-17:00', '09:00-17:00', '09:00-17:00', '09:00-17:00', '', ''],
    });
    await fx.query(`UPDATE app.messaging_settings SET csat_enabled = true WHERE tenant_id = $1`, [
      c.tenant.id,
    ]);

    // A: Monday 16:30 → Tuesday 09:30 (17 h, 1 business hour); Tuesday 10:00 → 12:30 (2.5 h).
    const a = await seededConversation('2026-09-14T10:00:00Z');
    await seededMessage(a, 'inbound', '2026-09-14T11:00:00Z');
    await seededMessage(a, 'outbound', '2026-09-15T04:00:00Z');
    await seededMessage(a, 'inbound', '2026-09-15T04:30:00Z');
    await seededMessage(a, 'outbound', '2026-09-15T07:00:00Z');
    await resolve(a, '2026-09-15T07:30:00Z');
    // B: Saturday 10:00 → Monday 09:10 (47 h 10 min, 10 business minutes); resolved after the period.
    const b = await seededConversation('2026-09-19T04:00:00Z');
    await seededMessage(b, 'inbound', '2026-09-19T04:30:00Z');
    await seededMessage(b, 'outbound', '2026-09-21T03:40:00Z');
    await resolve(b, '2026-09-21T04:00:00Z');
    // E: opened Wednesday 10:00 and resolved an hour later without messages.
    const e = await seededConversation('2026-09-16T04:30:00Z');
    await resolve(e, '2026-09-16T05:30:00Z');
    // Waiting now: C since Friday 16:50 (10 business minutes), D since Thursday 09:00 (16 hours).
    const cc = await seededConversation('2026-09-25T11:00:00Z');
    await seededMessage(cc, 'inbound', '2026-09-25T11:20:00Z');
    const d = await seededConversation('2026-09-24T03:00:00Z');
    await seededMessage(d, 'inbound', '2026-09-24T03:30:00Z');
    for (const [name, id] of [
      ['a', a],
      ['b', b],
      ['c', cc],
      ['d', d],
    ] as const) {
      seeded.set(name, id);
    }

    await survey(a, '2026-09-15T07:31:00Z', { status: 'read', score: 3 });
    await survey(e, '2026-09-16T05:31:00Z', { status: 'delivered' });
    await survey(e, '2026-09-17T05:31:00Z', { skip: 'window_closed' });
    await survey(a, '2026-09-17T06:00:00Z', { status: 'failed' });
    await survey(e, '2026-09-18T05:31:00Z', { status: 'delivered', score: 1 });

    r = await createReportsService({ db: fx.dbs.app, clock }).getReport(owner, period);
  });

  it('measures reply times and the target in business hours when business hours are on', () => {
    expect(r.inbox.businessHours).toBe(true);
    expect(r.inbox.turns).toMatchObject({
      started: 3,
      answered: 3,
      medianSeconds: 61_200,
      businessMedianSeconds: 3_600,
      businessP90Seconds: 7_920,
      withinTarget: { numerator: 2, denominator: 3 },
    });
    // Waiting now: D is past the target in business hours; C has waited 10 business minutes.
    expect(r.inbox.now.waiting).toBe(2);
    expect(r.inbox.now.overTarget).toBe(1);
    const day = (d: string) => r.inbox.days.find((x) => x.day === d);
    expect(day('2026-09-14')).toMatchObject({ started: 1, businessMedianSeconds: 3_600 });
    expect(day('2026-09-19')).toMatchObject({ started: 1, businessMedianSeconds: 600 });
  });

  it('reports resolution times of cases resolved in the period', () => {
    expect(r.inbox.resolution).toEqual({
      resolved: 2,
      medianSeconds: 40_500,
      p90Seconds: 70_020,
    });
    expect(r.inbox.days.find((x) => x.day === '2026-09-16')).toMatchObject({
      casesResolved: 1,
      medianResolutionSeconds: 3_600,
    });
  });

  it('reports CSAT with delivered and answered denominators, credited to the assignee', () => {
    expect(r.csat).toMatchObject({
      enabled: true,
      surveys: 5,
      sent: 4,
      delivered: 3,
      answered: 2,
      ratings: { best: 1, middle: 0, worst: 1 },
      responseRate: { numerator: 2, denominator: 3 },
      score: { numerator: 1, denominator: 2 },
    });
    expect(r.csat.skipped.window_closed).toBe(1);
    const agent = r.agents.find((x) => x.membershipId === agentMembershipId);
    expect(agent).toMatchObject({ csatAnswered: 2, csatBest: 1 });
  });

  it('measures the target in absolute time when business hours are off', async () => {
    const owner = await fx.ctx(c, c.owner);
    await createBusinessHoursService({ db: fx.dbs.app, clock }).updateBusinessHours(owner, {
      enabled: false,
      days: ['09:00-17:00', '09:00-17:00', '09:00-17:00', '09:00-17:00', '09:00-17:00', '', ''],
    });
    const off = await createReportsService({ db: fx.dbs.app, clock }).getReport(owner, period);
    expect(off.inbox.businessHours).toBe(false);
    expect(off.inbox.turns.businessMedianSeconds).toBeNull();
    // 17 h, 2.5 h and 47 h are all over an hour.
    expect(off.inbox.turns.withinTarget).toEqual({ numerator: 0, denominator: 3 });
    expect(off.inbox.now.overTarget).toBe(2);
  });

  it('measures each conversation against its team’s own target, else the company’s (ADR-377)', async () => {
    const owner = await fx.ctx(c, c.owner);
    // Business hours are off since the test above: targets count absolute time.
    const { teamId } = await createTeamsService({ db: fx.dbs.app, clock }).createTeam(owner, {
      name: 'Night shift',
      firstResponseTargetMinutes: '1440',
    });
    for (const name of ['a', 'c']) {
      await fx.query(`UPDATE app.conversations SET team_id = $1 WHERE id = $2`, [
        teamId,
        seeded.get(name),
      ]);
    }
    const reports = createReportsService({ db: fx.dbs.app, clock });
    const withTeam = await reports.getReport(owner, period);
    expect(withTeam.inbox.targetMinutes).toBe(60);
    expect(withTeam.inbox.teamTargets).toEqual([{ teamId, name: 'Night shift', minutes: 1440 }]);
    // A's 17 h and 2.5 h are within the team's day; B's 47 h is past the company's hour.
    expect(withTeam.inbox.turns.withinTarget).toEqual({ numerator: 2, denominator: 3 });
    // C has waited 18 h 40 min, within the team's day; D 50 h 30 min, past the company's hour.
    expect(withTeam.inbox.now.overTarget).toBe(1);

    // Without the company's target, conversations outside the team have none and are left out.
    await createInboxService({ db: fx.dbs.app, clock }).updateResponseTarget(owner, {
      minutes: null,
    });
    const teamOnly = await reports.getReport(owner, period);
    expect(teamOnly.inbox.targetMinutes).toBeNull();
    expect(teamOnly.inbox.turns.withinTarget).toEqual({ numerator: 2, denominator: 2 });
    expect(teamOnly.inbox.now.overTarget).toBe(0);
    const latest = teamOnly.definitions.find((d) => d.key === 'inbox.within_target');
    expect(latest?.version).toBe(4);
  });
});
