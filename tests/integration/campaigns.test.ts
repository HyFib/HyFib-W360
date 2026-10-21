import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, sql, type TenantScope } from '@w360/db';
import {
  assignVariant,
  attributeCampaignOptOut,
  campaignCompletionNotice,
  campaignPauseNotice,
  cancelSendIntent,
  createCampaignsService,
  createConsentService,
  createContactsService,
  createEmailPreferencesService,
  createSegmentsService,
  createTemplatesService,
  findDueCampaigns,
  loadNumberMessagingLimit,
  outboxAad,
  pauseCampaignForRemovedLauncher,
  processSendIntent,
  processTemplateSubmit,
  runCampaignTick,
  syncTemplates,
  type CampaignsService,
  type SegmentsService,
  type TemplateDefinition,
} from '@w360/domain';
import { acceptInvitation, createUser, invite } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Campaigns against real PostgreSQL and the Graph stand-in: segments, audience snapshots, live
 * re-checks at queue and send time, idempotent cancellation and its races, approval, scheduling
 * windows, frequency caps, spending and message caps with rate cards, pause/resume, attribution,
 * and a 10,000-recipient run.
 */
let fx: WhatsAppFixture;

/** A clock the tests move forward (the runner paces itself by time). */
class TestClock implements Clock {
  private offset = 0;
  now() {
    return new Date(Date.now() + this.offset);
  }
  advance(ms: number) {
    this.offset += ms;
  }
}

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

beforeEach(() => {
  fx.standIn.state.sendQueue = [];
});

const scopeOf = (c: Company): TenantScope => authorizedTenantScope(c.tenant.id, null);

const promo: TemplateDefinition = {
  category: 'MARKETING',
  header: { type: 'none' },
  body: { text: 'Hello {{1}}, our festive sale starts today.', examples: ['Asha'] },
  footer: null,
  buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }],
};

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

interface Setup {
  c: Company;
  clock: TestClock;
  campaigns: CampaignsService;
  segments: SegmentsService;
  templateId: string;
  contact(
    phone: string,
    opts?: { name?: string; tags?: string[]; optIn?: boolean },
  ): Promise<string>;
  tick(campaignId: string, rate?: number): ReturnType<typeof runCampaignTick>;
  dispatchAll(campaignId: string): Promise<string[]>;
  draft(
    name: string,
    overrides?: Partial<Record<string, unknown>>,
  ): Promise<{ id: string; version: number }>;
  draftInput(name: string, overrides?: Partial<Record<string, unknown>>): Record<string, unknown>;
}

async function setup(): Promise<Setup> {
  const c = await fx.company();
  const clock = new TestClock();
  const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock, notices: fx.notices() };
  const templates = createTemplatesService(deps);
  const owner = await fx.ctx(c, c.owner);
  const { id: templateId } = await templates.createDraft(owner, {
    whatsappAccountId: c.whatsappAccountId,
    name: 'festive_sale',
    language: 'en',
    definition: promo,
  });
  await templates.submitTemplate(owner, templateId);
  const workerDeps = {
    db: fx.dbs.app,
    keyring: fx.keyring,
    graph: fx.graph,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
  };
  expect(await processTemplateSubmit(workerDeps, scopeOf(c), templateId)).toBe('done');
  const t = fx.standIn.state.templates.get(c.wabaId)!.find((x) => x.name === 'festive_sale')!;
  t.status = 'APPROVED';
  await syncTemplates(workerDeps, scopeOf(c), c.whatsappAccountId);

  const contactsService = createContactsService({ db: fx.dbs.app, clock: systemClock });
  const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
  const campaigns = createCampaignsService(deps);
  const segments = createSegmentsService(deps);
  return {
    c,
    clock,
    campaigns,
    segments,
    templateId,
    async contact(phone, opts = {}) {
      const ctx = await fx.ctx(c, c.owner);
      const { id } = await contactsService.createContact(ctx, {
        phone,
        ...(opts.name ? { displayName: opts.name } : {}),
        tags: opts.tags ?? ['vip'],
      });
      if (opts.optIn ?? true) {
        await consent.recordConsent(ctx, {
          contactId: id,
          purpose: 'marketing',
          action: 'opt_in',
          note: 'Signed up at the store',
        });
      }
      return id;
    },
    tick(campaignId, rate = 100) {
      return runCampaignTick(
        {
          db: fx.dbs.app,
          jobs: fx.jobs(),
          signer: fx.signer,
          clock,
          sendRatePerSecond: rate,
          notices: fx.notices(),
        },
        scopeOf(c),
        campaignId,
      );
    },
    async dispatchAll(campaignId) {
      const intents = await fx.query<{ id: string }>(
        `SELECT s.id FROM app.send_intents s JOIN app.messages m ON m.id = s.message_id
          WHERE m.campaign_id = $1 AND s.state = 'queued' ORDER BY s.id`,
        [campaignId],
      );
      const outcomes: string[] = [];
      for (const intent of intents) {
        const r = await processSendIntent(
          { ...workerDeps, rate: { capacity: 1000, refillPerSecond: 1000 } },
          scopeOf(c),
          intent.id,
        );
        outcomes.push(r.outcome);
      }
      return outcomes;
    },
    async draft(name, overrides = {}) {
      const ctx = await fx.ctx(c, c.owner);
      const { id } = await campaigns.createDraft(ctx, { name }, {});
      await campaigns.updateDraft(ctx, id, draftInput(name, overrides), {});
      return { id, version: 1 };
    },
    draftInput,
  };

  function draftInput(name: string, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      expectedVersion: 0,
      name,
      channelAccountId: c.channelAccountId,
      templateId,
      variables: { header: [], body: [{ source: 'name', fallback: 'there' }] },
      audience: {
        kind: 'conditions',
        definition: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
      },
      schedule: { kind: 'now', timezone: 'Asia/Kolkata' },
      window: null,
      ratePerMinute: null,
      maxMessages: null,
      budget: null,
      stopAfterHours: 24,
      ...overrides,
    };
  }
}

async function recipients(campaignId: string) {
  return fx.query<{
    contact_id: string;
    state: string;
    skip_reason: string | null;
    message_id: string | null;
    replied_at: Date | null;
    opted_out_at: Date | null;
    estimated_cost_micros: string | null;
  }>(
    `SELECT contact_id, state, skip_reason, message_id, replied_at, opted_out_at, estimated_cost_micros
       FROM app.campaign_recipients WHERE campaign_id = $1 ORDER BY id`,
    [campaignId],
  );
}

async function campaignRow(id: string) {
  const [row] = await fx.query<{
    status: string;
    pause_reason: string | null;
    queued_count: number;
    skipped_count: number;
    launched_by_user_id: string | null;
    spent_estimate_micros: string;
    next_run_at: Date | null;
    completion_reason: string | null;
  }>(
    `SELECT status, pause_reason, queued_count, skipped_count, launched_by_user_id,
            spent_estimate_micros, next_run_at, completion_reason
       FROM app.campaigns WHERE id = $1`,
    [id],
  );
  return row!;
}

/** The emails queued about a campaign's automatic pauses (ADR-210), oldest first. */
const pauseEmails = (tenantId: string, campaignId: string) =>
  campaignEmails(tenantId, `campaign-paused:${campaignId}:`);

/** The company's emails whose dedupe key starts with `prefix`, oldest first. */
async function campaignEmails(tenantId: string, prefix: string) {
  const rows = await fx.query<{
    id: string;
    to_address: string;
    dedupe_key: string;
    payload_ciphertext: string;
  }>(
    `SELECT id, to_address, dedupe_key, payload_ciphertext FROM ops.email_outbox
      WHERE tenant_id = $1 AND dedupe_key LIKE $2 ORDER BY id`,
    [tenantId, `${prefix}%`],
  );
  return rows.map((r) => ({
    to: r.to_address,
    dedupeKey: r.dedupe_key,
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

describe('segments', () => {
  let s: Setup;
  beforeAll(async () => {
    s = await setup();
  });

  it('saves, previews, updates with a version check and archives', async () => {
    const ctx = await fx.ctx(s.c, s.c.owner);
    const contacts = createContactsService({ db: fx.dbs.app, clock: systemClock });
    await contacts.createField(ctx, { label: 'City', type: 'text' });
    await contacts.createField(ctx, { label: 'Points', type: 'number' });
    const asha = await s.contact('+919810000001', { name: 'Asha', tags: ['vip', 'pune'] });
    await contacts.updateContact(ctx, asha, {
      displayName: 'Asha',
      attributes: { city: 'Pune', points: '120' },
    });
    const bina = await s.contact('+919810000002', { name: 'Bina', tags: ['vip'], optIn: false });
    await contacts.updateContact(ctx, bina, {
      displayName: 'Bina',
      attributes: { city: 'Mumbai', points: '30' },
    });
    await s.contact('+14155550100', { name: 'Chris', tags: ['newsletter'] });

    const def = {
      match: 'all',
      conditions: [
        { type: 'tag', op: 'has', tag: 'VIP' },
        { type: 'field', key: 'points', op: 'greater_than', value: '100' },
      ],
    };
    const preview = await s.segments.previewDefinition(ctx, def);
    expect(preview.count).toBe(1);
    expect(preview.sample.map((p) => p.displayName)).toEqual(['Asha']);

    const any = await s.segments.previewDefinition(ctx, {
      match: 'any',
      conditions: [
        { type: 'consent', purpose: 'marketing', status: 'not_recorded' },
        { type: 'calling_code', prefix: '1' },
      ],
    });
    expect(any.count).toBe(2);

    const { id } = await s.segments.createSegment(
      ctx,
      { name: 'Big spenders', definition: def },
      {},
    );
    await s.segments.updateSegment(
      ctx,
      id,
      {
        name: 'Big spenders',
        expectedVersion: 0,
        definition: {
          ...def,
          conditions: [{ type: 'field', key: 'city', op: 'equals', value: 'mumbai' }],
        },
      },
      {},
    );
    await expectAppError(
      s.segments.updateSegment(ctx, id, { name: 'x', expectedVersion: 0, definition: def }, {}),
      'conflict',
    );
    const saved = await s.segments.getSegment(ctx, id);
    expect(saved.preview?.count).toBe(1);
    await s.segments.archiveSegment(ctx, id, {});
    await expectAppError(s.segments.getSegment(ctx, id), 'not_found');
  });

  it('refuses unknown fields, wrong comparisons and foreign campaigns', async () => {
    const ctx = await fx.ctx(s.c, s.c.owner);
    const bad = (conditions: unknown[]) =>
      s.segments.previewDefinition(ctx, { match: 'all', conditions });
    await expectAppError(
      bad([{ type: 'field', key: 'missing', op: 'is_set' }]),
      'validation_failed',
      /does not exist/,
    );
    await expectAppError(
      bad([{ type: 'field', key: 'city', op: 'greater_than', value: '3' }]),
      'validation_failed',
      /does not apply/,
    );
    await expectAppError(
      bad([{ type: 'campaign', campaignId: uuidv7(), outcome: 'replied' }]),
      'validation_failed',
      /does not exist/,
    );
    await expectAppError(bad([]), 'validation_failed');
    const agent = await fx.ctx(s.c, s.c.agent);
    await expectAppError(
      s.segments.createSegment(agent, { name: 'x', definition: { conditions: [] } }, {}),
      'forbidden',
    );
  });
});

describe('campaign results (ADR-150)', () => {
  it('come from one statement, the commonest skip reasons and failure codes first, ties by reason or code', async () => {
    const s = await setup();
    const ctx = await fx.ctx(s.c, s.c.owner);
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    const phone = (n: number) => `+9198200500${String(n).padStart(2, '0')}`;
    const audience = (tag: string) => ({
      audience: {
        kind: 'conditions',
        definition: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag }] },
      },
    });
    // Runs the campaign and fails each contact's message with the code given, or without one.
    const failEach = async (id: string, failures: [contactId: string, code: number | null][]) => {
      await s.campaigns.submitCampaign(ctx, id, { expectedVersion: 1 }, {});
      await s.tick(id);
      expect(await s.dispatchAll(id)).toEqual(Array(failures.length).fill('accepted'));
      const wamids = await fx.query<{ external_message_id: string; contact_id: string }>(
        `SELECT m.external_message_id, cv.contact_id FROM app.messages m
           JOIN app.conversations cv ON cv.id = m.conversation_id WHERE m.campaign_id = $1`,
        [id],
      );
      const now = String(Math.floor(Date.now() / 1000));
      await fx.deliver(
        fx.messagesBody(s.c, {
          statuses: failures.map(([contactId, code]) => ({
            id: wamids.find((w) => w.contact_id === contactId)!.external_message_id,
            status: 'failed',
            timestamp: now,
            recipient_id: '919820050001',
            ...(code === null ? {} : { errors: [{ code, title: `Error ${code}` }] }),
          })),
        }),
      );
      return (await s.campaigns.getCampaign(ctx, id)).analytics;
    };

    // Two suppressed contacts and one without consent are skipped. Every message fails: one code
    // three times, another and no code twice each, nine codes once.
    const once = [131047, 131031, 131021, 131016, 131009, 131008, 131005, 131000, 130472];
    const codes = [131049, 131049, 131049, 131026, 131026, null, null, ...once];
    const failures: [string, number | null][] = [];
    for (const [i, code] of codes.entries()) {
      failures.push([await s.contact(phone(i + 1), { tags: ['first'] }), code]);
    }
    await s.contact(phone(17), { name: 'Esha', tags: ['first'] });
    await s.contact(phone(18), { name: 'Gita', tags: ['first'] });
    await s.contact(phone(19), { name: 'Farah', tags: ['first'], optIn: false });
    await consent.addSuppression(ctx, { phone: phone(17), reason: 'complaint' });
    await consent.addSuppression(ctx, { phone: phone(18), reason: 'complaint' });
    const first = await s.draft('Results', audience('first'));
    const analytics = await failEach(first.id, failures);
    expect(analytics).toMatchObject({ audience: 19, skipped: 3, queued: 16, failed: 16 });
    expect(analytics?.skipReasons).toEqual([
      { reason: 'suppressed', count: 2 },
      { reason: 'no_marketing_opt_in', count: 1 },
    ]);
    // The 10 commonest codes, ties in the codes' order and no code after them: two codes failing
    // once are left out.
    expect(analytics?.failureCodes).toEqual([
      { code: '131049', count: 3 },
      { code: '131026', count: 2 },
      { code: 'unknown', count: 2 },
      { code: '130472', count: 1 },
      { code: '131000', count: 1 },
      { code: '131005', count: 1 },
      { code: '131008', count: 1 },
      { code: '131009', count: 1 },
      { code: '131016', count: 1 },
      { code: '131021', count: 1 },
    ]);

    // When the tenth place is tied, no code is the one left out.
    const tied: [string, number | null][] = [];
    for (const [i, code] of [131049, 131049, null, 131026, ...once.slice(1)].entries()) {
      tied.push([await s.contact(phone(i + 21), { tags: ['second'] }), code]);
    }
    const again = await s.draft('Results again', audience('second'));
    const tiedAnalytics = await failEach(again.id, tied);
    // Only this campaign's recipients and messages count.
    expect(tiedAnalytics).toMatchObject({ audience: 12, skipped: 0, queued: 12, failed: 12 });
    expect(tiedAnalytics?.skipReasons).toEqual([]);
    expect(tiedAnalytics?.failureCodes).toEqual([
      { code: '131049', count: 2 },
      { code: '130472', count: 1 },
      { code: '131000', count: 1 },
      { code: '131005', count: 1 },
      { code: '131008', count: 1 },
      { code: '131009', count: 1 },
      { code: '131016', count: 1 },
      { code: '131021', count: 1 },
      { code: '131026', count: 1 },
      { code: '131031', count: 1 },
    ]);
  });
});

describe('campaign lifecycle', () => {
  let s: Setup;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    s = await setup();
    ids.asha = await s.contact('+919820000001', { name: 'Asha' });
    ids.bina = await s.contact('+919820000002');
    ids.chitra = await s.contact('+919820000003', { name: 'Chitra' });
    ids.optedOut = await s.contact('+919820000004', { name: 'Dev' });
    ids.suppressed = await s.contact('+919820000005', { name: 'Esha' });
    ids.noOptIn = await s.contact('+919820000006', { name: 'Farah', optIn: false });
    const ctx = await fx.ctx(s.c, s.c.owner);
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    await consent.recordConsent(ctx, {
      contactId: ids.optedOut,
      purpose: 'marketing',
      action: 'opt_out',
      note: 'Asked us to stop',
    });
    await consent.addSuppression(ctx, { phone: '+919820000005', reason: 'complaint' });
  });

  it('reviews, snapshots, queues through the send pipeline and reports outcomes', async () => {
    const ctx = await fx.ctx(s.c, s.c.owner);
    const { id } = await s.draft('Festive launch');
    const review = await s.campaigns.reviewDraft(ctx, id);
    expect(review.problems).toEqual([]);
    expect(review.audience).toEqual({
      total: 6,
      eligible: 3,
      skipped: { opted_out: 1, suppressed: 1, no_marketing_opt_in: 1 },
    });
    expect(review.estimate).toBeNull();

    const submitted = await s.campaigns.submitCampaign(ctx, id, { expectedVersion: 1 }, {});
    expect(submitted).toMatchObject({ status: 'scheduled', audience: 6, pending: 3 });
    await expectAppError(
      s.campaigns.updateDraft(
        ctx,
        id,
        { ...s.draftInput('Festive launch'), expectedVersion: 2 },
        {},
      ),
      'conflict',
      /Only draft/,
    );

    const tick = await s.tick(id);
    expect(tick).toMatchObject({ outcome: 'progress', queued: 3, skipped: 0 });
    const rows = await recipients(id);
    expect(rows.filter((r) => r.state === 'queued')).toHaveLength(3);
    expect(
      rows
        .filter((r) => r.state === 'skipped')
        .map((r) => r.skip_reason)
        .sort(),
    ).toEqual(['no_marketing_opt_in', 'opted_out', 'suppressed']);
    // Campaign threads are created resolved, so they do not flood the open inbox.
    const threads = await fx.query<{ status: string; sender_type: string; campaign_id: string }>(
      `SELECT cv.status, m.sender_type, m.campaign_id FROM app.messages m
         JOIN app.conversations cv ON cv.id = m.conversation_id WHERE m.campaign_id = $1`,
      [id],
    );
    expect(threads).toHaveLength(3);
    expect(threads.every((t) => t.status === 'resolved' && t.sender_type === 'campaign')).toBe(
      true,
    );

    expect(await s.dispatchAll(id)).toEqual(['accepted', 'accepted', 'accepted']);
    const sent = fx.standIn.state.requests
      .filter((r) => r.path.endsWith('/messages'))
      .slice(-3)
      .map((r) => r.body as { to: string; template: { components: unknown[] } });
    expect(sent.map((b) => b.to).sort()).toEqual(['919820000001', '919820000002', '919820000003']);
    expect(sent.find((b) => b.to === '919820000002')!.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'there' }] },
    ]);

    s.clock.advance(11_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'completed' });
    expect(await campaignRow(id)).toMatchObject({
      status: 'completed',
      completion_reason: 'all_processed',
      queued_count: 3,
      skipped_count: 3,
    });

    // Delivery statuses, a reply and a STOP keyword are attributed to the campaign.
    const wamids = await fx.query<{ external_message_id: string; contact_id: string }>(
      `SELECT m.external_message_id, cv.contact_id FROM app.messages m
         JOIN app.conversations cv ON cv.id = m.conversation_id WHERE m.campaign_id = $1`,
      [id],
    );
    const wamidOf = (contactId: string) =>
      wamids.find((w) => w.contact_id === contactId)!.external_message_id;
    const now = Math.floor(Date.now() / 1000);
    const status = (contactId: string, value: string, extra: Record<string, unknown> = {}) => ({
      id: wamidOf(contactId),
      status: value,
      timestamp: String(now),
      recipient_id: '919820000001',
      ...extra,
    });
    await fx.deliver(
      fx.messagesBody(s.c, {
        statuses: [
          status(ids.asha!, 'delivered'),
          status(ids.bina!, 'read'),
          status(ids.chitra!, 'failed', {
            errors: [
              {
                code: 131049,
                title: 'This message was not delivered to maintain healthy ecosystem engagement.',
              },
            ],
          }),
        ],
      }),
    );
    await fx.deliver(
      fx.messagesBody(s.c, { messages: [{ waId: '919820000001', text: 'Interested!' }] }),
    );
    await fx.deliver(fx.messagesBody(s.c, { messages: [{ waId: '919820000002', text: 'STOP' }] }));
    // Chitra's message failed, so a marketing opt-out of hers is not credited to the campaign.
    await fx.dbs.app.run(scopeOf(s.c), (tx) =>
      attributeCampaignOptOut(tx, {
        tenantId: s.c.tenant.id,
        contactId: ids.chitra!,
        at: new Date(),
      }),
    );
    const chitra = (await recipients(id)).find((r) => r.contact_id === ids.chitra)!;
    expect(chitra.opted_out_at).toBeNull();
    const view = await s.campaigns.getCampaign(ctx, id);
    expect(view.analytics).toMatchObject({
      audience: 6,
      queued: 3,
      sent: 2,
      delivered: 2,
      read: 1,
      failed: 1,
      replied: 2,
      optedOut: 1,
      skipped: 3,
    });
    expect(view.analytics?.failureCodes).toEqual([{ code: '131049', count: 1 }]);
    // Reasons tied at one each come in the reasons' order (ADR-150).
    expect(view.analytics?.skipReasons).toEqual([
      { reason: 'no_marketing_opt_in', count: 1 },
      { reason: 'opted_out', count: 1 },
      { reason: 'suppressed', count: 1 },
    ]);
    expect(view.events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'created',
        'edited',
        'submitted',
        'scheduled',
        'started',
        'completed',
      ]),
    );

    // Export: per-recipient outcomes, formula-safe.
    let csv = '';
    for await (const chunk of s.campaigns.exportRecipients(ctx, id)) csv += chunk;
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(7);
    expect(csv).toContain('+919820000001,Asha,queued,,delivered');

    // Retargeting by response: contacts who replied to this campaign.
    const replied = await s.segments.previewDefinition(ctx, {
      match: 'all',
      conditions: [{ type: 'campaign', campaignId: id, outcome: 'replied' }],
    });
    expect(replied.count).toBe(2);
  });

  it('sends tests to existing contacts through the normal consent checks', async () => {
    const ctx = await fx.ctx(s.c, s.c.owner);
    const { id } = await s.draft('Test sends');
    const results = await s.campaigns.sendTest(
      ctx,
      id,
      { phones: ['+91 98200 00003', '+919820000004', '+919899999999', '98200'] },
      {},
    );
    expect(results).toEqual([
      { phone: '+919820000003', ok: true, message: 'Queued.' },
      { phone: '+919820000004', ok: false, message: expect.stringMatching(/opted out/) },
      { phone: '+919899999999', ok: false, message: 'Not a contact yet. Add them first.' },
      { phone: '98200', ok: false, message: expect.stringMatching(/country code/) },
    ]);
    // Tests are ordinary template sends: not attached to the campaign's results.
    const attached = await fx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.messages WHERE campaign_id = $1',
      [id],
    );
    expect(attached[0]!.n).toBe(0);
    await expectAppError(
      s.campaigns.sendTest(await fx.ctx(s.c, s.c.agent), id, { phones: ['+919820000003'] }, {}),
      'forbidden',
    );
  });

  it('re-checks consent, suppression and erasure when queueing and again before dispatch', async () => {
    const ctx = await fx.ctx(s.c, s.c.owner);
    const { id } = await s.draft('Second wave');
    await s.campaigns.submitCampaign(ctx, id, { expectedVersion: 1 }, {});
    const snapshot = await recipients(id);
    expect(snapshot.filter((r) => r.state === 'pending')).toHaveLength(2);
    // After the snapshot: Asha opts out (the STOP above already took Bina out), Chitra is suppressed.
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    await consent.recordConsent(ctx, {
      contactId: ids.asha!,
      purpose: 'marketing',
      action: 'opt_out',
      note: 'Called to unsubscribe',
    });
    const pendingBefore = snapshot.filter((r) => r.state === 'pending').map((r) => r.contact_id);
    expect(pendingBefore.sort()).toEqual([ids.asha, ids.chitra].sort());
    await consent.addSuppression(ctx, { phone: '+919820000003', reason: 'manual' });
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 0, skipped: 2 });
    const after = await recipients(id);
    expect(
      after
        .filter((r) => pendingBefore.includes(r.contact_id))
        .map((r) => r.skip_reason)
        .sort(),
    ).toEqual(['opted_out', 'suppressed']);
  });
});

describe('cancellation', () => {
  let s: Setup;
  beforeAll(async () => {
    s = await setup();
    for (let i = 0; i < 6; i += 1) await s.contact(`+9198300000${10 + i}`, { name: `C${i}` });
  });

  it('is idempotent and cancels only what no worker has claimed', async () => {
    const ctx = await fx.ctx(s.c, s.c.marketer);
    const { id } = await s.draft('Cancel me');
    await s.campaigns.submitCampaign(await fx.ctx(s.c, s.c.owner), id, { expectedVersion: 1 }, {});
    expect(await s.tick(id)).toMatchObject({ queued: 6 });
    // Two sends reach Meta before the cancellation.
    const intents = await fx.query<{ id: string }>(
      `SELECT s.id FROM app.send_intents s JOIN app.messages m ON m.id = s.message_id
        WHERE m.campaign_id = $1 ORDER BY s.id LIMIT 2`,
      [id],
    );
    for (const intent of intents) {
      await processSendIntent(
        {
          db: fx.dbs.app,
          keyring: fx.keyring,
          graph: fx.graph,
          clock: systemClock,
          rate: { capacity: 100, refillPerSecond: 100 },
          jobs: fx.jobs(),
          signer: fx.signer,
        },
        scopeOf(s.c),
        intent.id,
      );
    }
    const first = await s.campaigns.cancelCampaign(ctx, id, {});
    expect(first).toEqual({
      status: 'canceled',
      changed: true,
      canceledRecipients: 0,
      releasedSends: 4,
    });
    const again = await s.campaigns.cancelCampaign(ctx, id, {});
    expect(again).toEqual({
      status: 'canceled',
      changed: false,
      canceledRecipients: 0,
      releasedSends: 0,
    });
    // The released intents are not claimable any more; nothing else is sent.
    const before = fx.standIn.state.requests.length;
    expect(await s.dispatchAll(id)).toEqual([]);
    expect(fx.standIn.state.requests.length).toBe(before);
    const messages = await fx.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM app.messages WHERE campaign_id = $1 GROUP BY status ORDER BY status`,
      [id],
    );
    expect(messages).toEqual([
      { status: 'accepted', n: 2 },
      { status: 'canceled', n: 4 },
    ]);
    const view = await s.campaigns.getCampaign(ctx, id);
    expect(view.analytics).toMatchObject({ canceled: 4, queued: 2, messageCanceled: 4 });
    const events = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.campaign_events WHERE campaign_id = $1 AND type = 'canceled'`,
      [id],
    );
    expect(events[0]!.n).toBe(1);
  });

  it('keeps a consistent state when a cancellation races the runner and the send worker', async () => {
    const owner = await fx.ctx(s.c, s.c.owner);
    const { id } = await s.draft('Race');
    await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    expect(await s.tick(id, 1)).toMatchObject({ queued: 6 });
    const [, , dispatched] = await Promise.all([
      s.campaigns.cancelCampaign(owner, id, {}),
      s.campaigns.cancelCampaign(owner, id, {}),
      s.dispatchAll(id),
    ]);
    const row = await campaignRow(id);
    expect(row.status).toBe('canceled');
    const intents = await fx.query<{ state: string; message_status: string }>(
      `SELECT s.state, m.status AS message_status FROM app.send_intents s
         JOIN app.messages m ON m.id = s.message_id WHERE m.campaign_id = $1`,
      [id],
    );
    // Every send either reached Meta or was cancelled; none is left waiting.
    for (const i of intents) {
      expect(['accepted', 'canceled']).toContain(i.state);
      expect(i.message_status).toBe(i.state === 'accepted' ? 'accepted' : 'canceled');
    }
    const accepted = intents.filter((i) => i.state === 'accepted').length;
    expect(dispatched.filter((o) => o === 'accepted')).toHaveLength(accepted);
    expect(
      (
        await fx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.campaign_events WHERE campaign_id = $1 AND type = 'canceled'`,
          [id],
        )
      )[0]!.n,
    ).toBe(1);
    // The runner stops for a cancelled campaign.
    s.clock.advance(11_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'inactive' });
  });

  it('cancels pending recipients of a paced campaign', async () => {
    const owner = await fx.ctx(s.c, s.c.owner);
    const { id } = await s.draft('Paced', { ratePerMinute: 1 });
    await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    const tick = await s.tick(id);
    expect(tick).toMatchObject({ outcome: 'progress', queued: 1 });
    // One per minute: the next tick is a minute away, and an early signal does nothing.
    expect(tick.nextRunAt!.getTime() - s.clock.now().getTime()).toBeGreaterThan(55_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'early' });
    const result = await s.campaigns.cancelCampaign(owner, id, {});
    expect(result).toMatchObject({ changed: true, canceledRecipients: 5, releasedSends: 1 });
  });
});

describe('approval, pause and resume', () => {
  let s: Setup;
  beforeAll(async () => {
    s = await setup();
    for (let i = 0; i < 4; i += 1) await s.contact(`+9198400000${10 + i}`, { name: `A${i}` });
    await s.campaigns.updateSettings(
      await fx.ctx(s.c, s.c.owner),
      { approvalRequired: true, cap: null, costCurrency: null },
      {},
    );
  });

  it('needs a different member with approval rights', async () => {
    const marketer = await fx.ctx(s.c, s.c.marketer);
    const owner = await fx.ctx(s.c, s.c.owner);
    const { id } = await s.draft('Needs approval');
    const submitted = await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    expect(submitted.status).toBe('pending_approval');
    expect(await s.tick(id)).toMatchObject({ outcome: 'inactive' });
    await expectAppError(s.campaigns.approveCampaign(marketer, id, {}, {}), 'forbidden');
    // Rejection sends it back to draft and drops the snapshot.
    await s.campaigns.rejectCampaign(owner, id, { note: 'Add the store address' }, {});
    expect(await campaignRow(id)).toMatchObject({ status: 'draft' });
    expect(await recipients(id)).toHaveLength(0);
    // The owner's own submission cannot be approved by the owner.
    const { id: own } = await s.draft('Owner campaign');
    await s.campaigns.submitCampaign(owner, own, { expectedVersion: 1 }, {});
    await expectAppError(
      s.campaigns.approveCampaign(owner, own, {}, {}),
      'forbidden',
      /different member/,
    );
    await s.campaigns.withdrawCampaign(owner, own, {});
    // Resubmitted by the marketer and approved by the owner: sends run under the marketer.
    const view = await s.campaigns.getCampaign(owner, id);
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: view.campaign.version }, {});
    await s.campaigns.approveCampaign(owner, id, { note: 'Looks good' }, {});
    expect(await campaignRow(id)).toMatchObject({
      status: 'scheduled',
      launched_by_user_id: s.c.marketer.id,
    });
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 4 });
  });

  it('pauses (releasing unclaimed sends), resumes under the resuming member and stops a send that returned to the queue', async () => {
    const owner = await fx.ctx(s.c, s.c.owner);
    const marketer = await fx.ctx(s.c, s.c.marketer);
    await s.campaigns.updateSettings(
      owner,
      { approvalRequired: false, cap: null, costCurrency: null },
      {},
    );
    const { id } = await s.draft('Pausable');
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    expect(await s.tick(id)).toMatchObject({ queued: 4 });
    expect(await s.campaigns.pauseCampaign(marketer, id, {})).toEqual({ released: 4 });
    expect(await s.campaigns.pauseCampaign(marketer, id, {})).toEqual({ released: 0 });
    expect((await recipients(id)).every((r) => r.state === 'pending')).toBe(true);
    expect(await campaignRow(id)).toMatchObject({
      status: 'paused',
      pause_reason: 'manual',
      queued_count: 0,
    });
    expect(await s.dispatchAll(id)).toEqual([]);

    await s.campaigns.resumeCampaign(owner, id, {});
    expect(await campaignRow(id)).toMatchObject({
      status: 'running',
      launched_by_user_id: s.c.owner.id,
    });
    expect(await s.tick(id)).toMatchObject({ queued: 4 });

    // A send that went back to the queue after the pause (retryable error) is not sent.
    await s.campaigns.pauseCampaign(owner, id, {});
    const [message] = await fx.query<{ id: string }>(
      `SELECT id FROM app.messages WHERE campaign_id = $1 AND status = 'canceled' LIMIT 1`,
      [id],
    );
    await fx.query(`UPDATE app.send_intents SET state = 'queued' WHERE message_id = $1`, [
      message!.id,
    ]);
    await fx.query(`UPDATE app.messages SET status = 'queued' WHERE id = $1`, [message!.id]);
    const [linked] = await fx.query<{ id: string }>(
      `UPDATE app.campaign_recipients SET state = 'queued', message_id = $1
        WHERE id = (SELECT id FROM app.campaign_recipients WHERE campaign_id = $2 AND state = 'pending' LIMIT 1)
        RETURNING id`,
      [message!.id, id],
    );
    const before = fx.standIn.state.requests.length;
    expect(await s.dispatchAll(id)).toEqual(['canceled']);
    expect(fx.standIn.state.requests.length).toBe(before);
    const [r] = await fx.query<{ state: string; message_id: string | null }>(
      `SELECT state, message_id FROM app.campaign_recipients WHERE id = $1`,
      [linked!.id],
    );
    expect(r).toEqual({ state: 'pending', message_id: null });
  });

  it('pauses when the member whose authority it uses leaves or loses the permission', async () => {
    const marketer = await fx.ctx(s.c, s.c.marketer);
    const { id } = await s.draft('Launcher leaves');
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    await fx.query(
      `UPDATE app.memberships SET roles = '{analyst}' WHERE tenant_id = $1 AND user_id = $2`,
      [s.c.tenant.id, s.c.marketer.id],
    );
    expect(await s.tick(id)).toMatchObject({
      outcome: 'paused',
      pauseReason: 'launcher_not_permitted',
    });
    await fx.query(
      `UPDATE app.memberships SET roles = '{marketer}' WHERE tenant_id = $1 AND user_id = $2`,
      [s.c.tenant.id, s.c.marketer.id],
    );
  });

  it('returns the sends of a member who left to the campaign, so a resuming member reaches everyone', async () => {
    const owner = await fx.ctx(s.c, s.c.owner);
    const marketer = await fx.ctx(s.c, s.c.marketer);
    const { id } = await s.draft('Launcher removed');
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    expect(await s.tick(id)).toMatchObject({ queued: 4 });
    const intents = await fx.query<{ id: string }>(
      `SELECT s.id FROM app.send_intents s JOIN app.messages m ON m.id = s.message_id
        WHERE m.campaign_id = $1 ORDER BY s.id`,
      [id],
    );
    await fx.query(
      `UPDATE app.memberships SET status = 'removed' WHERE tenant_id = $1 AND user_id = $2`,
      [s.c.tenant.id, s.c.marketer.id],
    );
    try {
      // The send worker rejects the member's jobs one by one (no longer a member)...
      const cleanup = authorizedTenantScope(s.c.tenant.id, null);
      const reason = {
        code: 'sender_removed' as const,
        message: 'Not sent: the sender is no longer a member.',
      };
      for (const intent of intents.slice(0, 2)) {
        expect(await cancelSendIntent(fx.dbs.app, cleanup, intent.id, reason, systemClock)).toBe(
          true,
        );
      }
      // ...and the runner's job pauses the campaign, releasing the sends not rejected yet.
      expect(
        await pauseCampaignForRemovedLauncher(
          { db: fx.dbs.app, clock: systemClock, notices: fx.notices() },
          cleanup,
          id,
          s.c.marketer.id,
        ),
      ).toBe(true);
      expect(await cancelSendIntent(fx.dbs.app, cleanup, intents[2]!.id, reason, systemClock)).toBe(
        false,
      );
      expect((await recipients(id)).map((r) => [r.state, r.message_id])).toEqual(
        Array.from({ length: 4 }, () => ['pending', null]),
      );
      expect(await campaignRow(id)).toMatchObject({
        status: 'paused',
        pause_reason: 'launcher_removed',
        queued_count: 0,
      });
      const messages = await fx.query<{ status: string; error_code: string }>(
        `SELECT status, error_code FROM app.messages WHERE campaign_id = $1 ORDER BY id`,
        [id],
      );
      expect(messages.map((m) => m.status)).toEqual([
        'canceled',
        'canceled',
        'canceled',
        'canceled',
      ]);
      expect(messages.filter((m) => m.error_code === 'sender_removed')).toHaveLength(2);

      await s.campaigns.resumeCampaign(owner, id, {});
      expect(await s.tick(id)).toMatchObject({ queued: 4 });
      expect(await s.dispatchAll(id)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    } finally {
      await fx.query(
        `UPDATE app.memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2`,
        [s.c.tenant.id, s.c.marketer.id],
      );
    }
  });
});

describe('emailing members when a campaign pauses by itself (ADR-210)', () => {
  async function member(c: Company, role: 'admin' | 'supervisor', status = 'active') {
    const user = await createUser(fx.dbs, { name: `Campaign ${role}` });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
    await acceptInvitation(fx.dbs, user, token);
    await fx.query(`UPDATE app.memberships SET status = $3 WHERE tenant_id = $1 AND user_id = $2`, [
      c.tenant.id,
      user.id,
      status,
    ]);
    return user;
  }
  async function pausedRow(id: string) {
    const [row] = await fx.query<{ version: number; deadline_at: Date | null }>(
      `SELECT version, deadline_at FROM app.campaigns WHERE id = $1`,
      [id],
    );
    return row!;
  }
  const companyName = async (c: Company) =>
    (
      await fx.query<{ name: string }>('SELECT name FROM app.tenants WHERE id = $1', [c.tenant.id])
    )[0]!.name;

  it('emails the member it sends under when its template can no longer be sent, once per pause, and nobody for a member’s own pause', async () => {
    const s = await setup();
    const marketer = await fx.ctx(s.c, s.c.marketer);
    await member(s.c, 'admin');
    await s.contact('+919840002001', { name: 'Asha' });
    await s.contact('+919840002002', { name: 'Ravi' });
    const { id } = await s.draft('Festive sale');
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 2 });
    // A member's own pause and resume email nobody.
    await s.campaigns.pauseCampaign(marketer, id, {});
    await s.campaigns.resumeCampaign(marketer, id, {});
    expect(await pauseEmails(s.c.tenant.id, id)).toEqual([]);

    await fx.query(`UPDATE app.message_templates SET status = 'paused' WHERE id = $1`, [
      s.templateId,
    ]);
    expect(await s.tick(id)).toMatchObject({
      outcome: 'paused',
      pauseReason: 'template_not_approved',
    });
    const first = await pausedRow(id);
    const expected = campaignPauseNotice({
      campaignName: 'Festive sale',
      reason: 'template_not_approved',
      sendUntil: first.deadline_at,
      timeZone: 'Asia/Kolkata',
    });
    expect(expected.lines[2]).toMatch(
      /^Messages that had not gone out yet wait until it is resumed\. Its sending period ends at \d+ \w+ \d{4} at \d{2}:\d{2} GMT\+5:30, /,
    );
    const email = {
      to: s.c.marketer.email,
      dedupeKey: `campaign-paused:${id}:${first.version}:${s.c.marketer.id}`,
      kind: 'tenant.notice',
      companyName: await companyName(s.c),
      subject: 'Campaign “Festive sale” paused: its template can no longer be sent',
      lines: expected.lines,
      url: `http://localhost:3000/c/${s.c.tenant.slug}/campaigns/${id}`,
      actionLabel: 'Open campaign',
    };
    // Only the marketer, who may still send campaigns, not the owner or the administrator.
    expect(await pauseEmails(s.c.tenant.id, id)).toEqual([email]);
    // A paused campaign's tick changes nothing and emails nobody again.
    expect(await s.tick(id)).toMatchObject({ outcome: 'inactive' });
    expect(await pauseEmails(s.c.tenant.id, id)).toHaveLength(1);

    // Approved again and resumed, then paused again: one more email, for the new pause.
    await fx.query(`UPDATE app.message_templates SET status = 'approved' WHERE id = $1`, [
      s.templateId,
    ]);
    await s.campaigns.resumeCampaign(marketer, id, {});
    await fx.query(`UPDATE app.message_templates SET status = 'paused' WHERE id = $1`, [
      s.templateId,
    ]);
    expect(await s.tick(id)).toMatchObject({ pauseReason: 'template_not_approved' });
    const second = await pausedRow(id);
    expect(second.version).toBeGreaterThan(first.version);
    expect(await pauseEmails(s.c.tenant.id, id)).toEqual([
      email,
      { ...email, dedupeKey: `campaign-paused:${id}:${second.version}:${s.c.marketer.id}` },
    ]);
  });

  it('emails the owners and administrators when the member it sends under can no longer send campaigns or leaves', async () => {
    const s = await setup();
    const marketer = await fx.ctx(s.c, s.c.marketer);
    const admin = await member(s.c, 'admin');
    await member(s.c, 'admin', 'suspended');
    await member(s.c, 'supervisor');
    await s.contact('+919840003001', { name: 'Asha' });
    const { id } = await s.draft('Winter launch');
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    await fx.query(
      `UPDATE app.memberships SET roles = '{analyst}' WHERE tenant_id = $1 AND user_id = $2`,
      [s.c.tenant.id, s.c.marketer.id],
    );
    expect(await s.tick(id)).toMatchObject({
      outcome: 'paused',
      pauseReason: 'launcher_not_permitted',
    });
    const row = await pausedRow(id);
    const notPermitted = await pauseEmails(s.c.tenant.id, id);
    // The owner and the active administrator approve and send campaigns; the marketer, the
    // suspended administrator, the supervisor and the agent are not emailed.
    expect(notPermitted.map((e) => e.to).sort()).toEqual([admin.email, s.c.owner.email].sort());
    expect(notPermitted.find((e) => e.to === admin.email)).toEqual({
      to: admin.email,
      dedupeKey: `campaign-paused:${id}:${row.version}:${admin.id}`,
      kind: 'tenant.notice',
      companyName: await companyName(s.c),
      subject: 'Campaign “Winter launch” paused: another member must resume it',
      lines: campaignPauseNotice({
        campaignName: 'Winter launch',
        reason: 'launcher_not_permitted',
        sendUntil: row.deadline_at,
        timeZone: 'Asia/Kolkata',
      }).lines,
      url: `http://localhost:3000/c/${s.c.tenant.slug}/campaigns/${id}`,
      actionLabel: 'Open campaign',
    });

    // A campaign set for tomorrow whose member left: the runner's job pauses it before it starts.
    await fx.query(
      `UPDATE app.memberships SET roles = '{marketer}' WHERE tenant_id = $1 AND user_id = $2`,
      [s.c.tenant.id, s.c.marketer.id],
    );
    const tomorrow = new Date(Date.now() + 86_400_000);
    const { id: later } = await s.draft('Tomorrow launch', {
      schedule: {
        kind: 'later',
        local: `${tomorrow.toISOString().slice(0, 10)}T09:00`,
        timezone: 'Asia/Kolkata',
      },
    });
    await s.campaigns.submitCampaign(marketer, later, { expectedVersion: 1 }, {});
    await fx.query(
      `UPDATE app.memberships SET status = 'removed' WHERE tenant_id = $1 AND user_id = $2`,
      [s.c.tenant.id, s.c.marketer.id],
    );
    const cleanup = authorizedTenantScope(s.c.tenant.id, null);
    const pauseDeps = { db: fx.dbs.app, clock: systemClock, notices: fx.notices() };
    expect(await pauseCampaignForRemovedLauncher(pauseDeps, cleanup, later, s.c.marketer.id)).toBe(
      true,
    );
    expect(await pauseCampaignForRemovedLauncher(pauseDeps, cleanup, later, s.c.marketer.id)).toBe(
      false,
    );
    const removed = await pauseEmails(s.c.tenant.id, later);
    expect(removed.map((e) => e.to).sort()).toEqual([admin.email, s.c.owner.email].sort());
    expect(removed.find((e) => e.to === s.c.owner.email)).toEqual({
      to: s.c.owner.email,
      dedupeKey: `campaign-paused:${later}:${(await pausedRow(later)).version}:${s.c.owner.id}`,
      kind: 'tenant.notice',
      companyName: await companyName(s.c),
      subject: 'Campaign “Tomorrow launch” paused: another member must resume it',
      lines: [
        'HyFib paused the campaign “Tomorrow launch”, and it sends nothing more until it is resumed.',
        'The member whose authority it sent under is no longer an active member of the company. A member who can send campaigns can resume it, and it then sends under their authority.',
        'It had not started, so nothing was sent. Once resumed, it starts at its scheduled time, or at once if that time has passed.',
      ],
      url: `http://localhost:3000/c/${s.c.tenant.slug}/campaigns/${later}`,
      actionLabel: 'Open campaign',
    });
  });
});

describe('emailing the member a campaign sent under when it finishes (ADR-214)', () => {
  const completionEmails = (tenantId: string, campaignId: string) =>
    campaignEmails(tenantId, `campaign-completed:${campaignId}:`);
  async function finished(id: string) {
    const [row] = await fx.query<{
      version: number;
      deadline_at: Date | null;
      completion_reason: string | null;
    }>(`SELECT version, deadline_at, completion_reason FROM app.campaigns WHERE id = $1`, [id]);
    return row!;
  }

  it('emails the member once when every contact was handed over or skipped, and nobody for a cancelled campaign', async () => {
    const s = await setup();
    const marketer = await fx.ctx(s.c, s.c.marketer);
    await s.contact('+919840004001', { name: 'Asha' });
    await s.contact('+919840004002', { name: 'Ravi' });
    await s.contact('+919840004003', { name: 'Meena', optIn: false });
    const { id } = await s.draft('Spring sale');
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 2 });
    expect(await completionEmails(s.c.tenant.id, id)).toEqual([]);
    s.clock.advance(11_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'completed' });
    const row = await finished(id);
    expect(row.completion_reason).toBe('all_processed');
    const [{ name: company }] = (await fx.query<{ name: string }>(
      'SELECT name FROM app.tenants WHERE id = $1',
      [s.c.tenant.id],
    )) as [{ name: string }];
    expect(await completionEmails(s.c.tenant.id, id)).toEqual([
      {
        to: s.c.marketer.email,
        dedupeKey: `campaign-completed:${id}:${row.version}:${s.c.marketer.id}`,
        kind: 'tenant.notice',
        companyName: company,
        subject: 'Campaign “Spring sale” finished sending',
        lines: campaignCompletionNotice({
          campaignName: 'Spring sale',
          reason: 'all_processed',
          audience: 3,
          queued: 2,
          skipped: 1,
          expired: 0,
          sendUntil: row.deadline_at,
          timeZone: 'Asia/Kolkata',
        }).lines,
        url: `http://localhost:3000/c/${s.c.tenant.slug}/campaigns/${id}`,
        actionLabel: 'Open campaign',
      },
    ]);
    // A finished campaign's tick changes nothing and emails nobody again.
    expect(await s.tick(id)).toMatchObject({ outcome: 'inactive' });
    expect(await completionEmails(s.c.tenant.id, id)).toHaveLength(1);

    // A member's cancellation emails nobody.
    const { id: canceled } = await s.draft('Cancelled sale');
    await s.campaigns.submitCampaign(marketer, canceled, { expectedVersion: 1 }, {});
    await s.campaigns.cancelCampaign(marketer, canceled, {});
    expect(await completionEmails(s.c.tenant.id, canceled)).toEqual([]);
  });

  it('says how many contacts its sending period left unreached, and emails nobody once the member is no longer active', async () => {
    const s = await setup();
    const marketer = await fx.ctx(s.c, s.c.marketer);
    await s.contact('+919840005001', { name: 'Asha' });
    await s.contact('+919840005002', { name: 'Ravi' });
    await s.contact('+919840005003', { name: 'Meena' });
    // One message a minute: the first tick queues one, then the sending period ends.
    const { id } = await s.draft('Slow sale', { ratePerMinute: 1 });
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 1 });
    s.clock.advance(25 * 3_600_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'completed' });
    const row = await finished(id);
    expect(row.completion_reason).toBe('deadline_passed');
    const [email] = await completionEmails(s.c.tenant.id, id);
    expect(email).toMatchObject({
      to: s.c.marketer.email,
      subject: 'Campaign “Slow sale” ended: its sending period is over',
      lines: campaignCompletionNotice({
        campaignName: 'Slow sale',
        reason: 'deadline_passed',
        audience: 3,
        queued: 1,
        skipped: 2,
        expired: 2,
        sendUntil: row.deadline_at,
        timeZone: 'Asia/Kolkata',
      }).lines,
    });
    expect(email!.lines[0]).toMatch(
      /^The sending period of the campaign “Slow sale” ended at \d+ \w+ \d{4} at \d{2}:\d{2} GMT\+5:30, so the 2 contacts it had not reached were skipped\.$/,
    );

    // The member was suspended before the period ended: the campaign ends, emailing nobody.
    const { id: other } = await s.draft('Paused sale', { ratePerMinute: 1 });
    await s.campaigns.submitCampaign(marketer, other, { expectedVersion: 1 }, {});
    expect(await s.tick(other)).toMatchObject({ queued: 1 });
    await fx.query(
      `UPDATE app.memberships SET status = 'suspended' WHERE tenant_id = $1 AND user_id = $2`,
      [s.c.tenant.id, s.c.marketer.id],
    );
    s.clock.advance(25 * 3_600_000);
    expect(await s.tick(other)).toMatchObject({ outcome: 'completed' });
    expect(await completionEmails(s.c.tenant.id, other)).toEqual([]);
  });
});

describe('notice emails skip members who turned them off (ADR-215)', () => {
  it('emails no approver, submitter or sender who turned the kind off', async () => {
    const s = await setup();
    const owner = await fx.ctx(s.c, s.c.owner);
    const marketer = await fx.ctx(s.c, s.c.marketer);
    const prefs = createEmailPreferencesService({ db: fx.dbs.app });
    // An administrator approves; the owner turned approval emails off.
    const user = await createUser(fx.dbs, { name: 'Campaign admin' });
    const { token } = await invite(fx.dbs, s.c.tenant, s.c.owner, user.email, ['admin']);
    await acceptInvitation(fx.dbs, user, token);
    const admin = await fx.ctx(s.c, user);
    await prefs.updateEmailPreferences(owner, { off: ['campaign_approvals'] });
    await prefs.updateEmailPreferences(marketer, {
      off: ['campaign_reviews', 'campaign_pauses', 'campaign_completions'],
    });
    await s.campaigns.updateSettings(
      owner,
      { approvalRequired: true, cap: null, costCurrency: null },
      {},
    );
    await s.contact('+919840006001', { name: 'Asha' });
    const { id } = await s.draft('Quiet sale');
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    expect(
      (await campaignEmails(s.c.tenant.id, `campaign-approval:${id}:`)).map((e) => e.to),
    ).toEqual([user.email]);
    await s.campaigns.approveCampaign(admin, id, {}, {});
    expect(await campaignEmails(s.c.tenant.id, `campaign-review:${id}:`)).toEqual([]);
    expect(await s.tick(id)).toMatchObject({ queued: 1 });
    await fx.query(`UPDATE app.message_templates SET status = 'paused' WHERE id = $1`, [
      s.templateId,
    ]);
    // The next tick is due a tick after the batch.
    s.clock.advance(11_000);
    expect(await s.tick(id)).toMatchObject({ pauseReason: 'template_not_approved' });
    expect(await campaignEmails(s.c.tenant.id, `campaign-paused:${id}:`)).toEqual([]);
    await fx.query(`UPDATE app.message_templates SET status = 'approved' WHERE id = $1`, [
      s.templateId,
    ]);
    await s.campaigns.resumeCampaign(marketer, id, {});
    expect(await s.tick(id)).toMatchObject({ queued: 1 });
    s.clock.advance(11_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'completed' });
    expect(await campaignEmails(s.c.tenant.id, `campaign-completed:${id}:`)).toEqual([]);
  });
});

describe('scheduling, windows, frequency caps and spending caps', () => {
  let s: Setup;
  beforeAll(async () => {
    s = await setup();
    for (let i = 0; i < 5; i += 1) await s.contact(`+9198500000${10 + i}`, { name: `S${i}` });
  });

  it('starts at the scheduled wall-clock time and waits outside the sending window', async () => {
    const owner = await fx.ctx(s.c, s.c.owner);
    const tomorrow = new Date(Date.now() + 86_400_000);
    const local = `${tomorrow.toISOString().slice(0, 10)}T09:00`;
    const { id } = await s.draft('Tomorrow 9', {
      schedule: { kind: 'later', local, timezone: 'Asia/Kolkata' },
    });
    const review = await s.campaigns.reviewDraft(owner, id);
    expect(review.scheduledAt?.toISOString()).toBe(`${local.slice(0, 10)}T03:30:00.000Z`);
    await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    expect(await s.tick(id)).toMatchObject({ outcome: 'early' });
    expect((await findDueCampaigns(fx.dbs.app)).some((d) => d.campaignId === id)).toBe(false);
    await s.campaigns.cancelCampaign(owner, id, {});

    // A sending window that is closed now: the runner waits for it to open.
    const hour = new Date().getUTCHours();
    const start = `${String((hour + 2) % 24).padStart(2, '0')}:00`;
    const end = `${String((hour + 3) % 24).padStart(2, '0')}:00`;
    const { id: windowed } = await s.draft('Windowed', {
      schedule: { kind: 'now', timezone: 'UTC' },
      window: { start, end },
    });
    await s.campaigns.submitCampaign(owner, windowed, { expectedVersion: 1 }, {});
    const waiting = await s.tick(windowed);
    expect(waiting.outcome).toBe('waiting');
    expect(waiting.nextRunAt!.getUTCHours()).toBe((hour + 2) % 24);
    expect(waiting.nextRunAt!.getUTCMinutes()).toBe(0);
    await s.campaigns.cancelCampaign(owner, windowed, {});
  });

  it('skips contacts over the marketing frequency cap', async () => {
    const owner = await fx.ctx(s.c, s.c.owner);
    await s.campaigns.updateSettings(
      owner,
      { approvalRequired: false, cap: { count: 1, days: 7 }, costCurrency: null },
      {},
    );
    const { id: first } = await s.draft('First touch');
    await s.campaigns.submitCampaign(owner, first, { expectedVersion: 1 }, {});
    expect(await s.tick(first)).toMatchObject({ queued: 5 });
    const { id: second } = await s.draft('Second touch');
    await s.campaigns.submitCampaign(owner, second, { expectedVersion: 1 }, {});
    expect(await s.tick(second)).toMatchObject({ queued: 0, skipped: 5 });
    expect((await recipients(second)).every((r) => r.skip_reason === 'frequency_capped')).toBe(
      true,
    );
    await s.campaigns.updateSettings(
      owner,
      { approvalRequired: false, cap: null, costCurrency: null },
      {},
    );
  });

  it('enforces a spending cap from a published rate card and a message cap', async () => {
    const owner = await fx.ctx(s.c, s.c.owner);
    // Test-only rate card: 1 INR per marketing message to +91 numbers (not a real Meta price).
    const [card] = await fx.query<{ id: string }>(
      `INSERT INTO ops.rate_cards (id, currency, effective_from, source_url, created_by_user_id)
       VALUES (gen_random_uuid(), 'INR', now() - interval '1 day', 'https://example.test/rates', $1) RETURNING id`,
      [s.c.owner.id],
    );
    await expect(
      fx.query(`UPDATE ops.rate_cards SET status = 'published' WHERE id = $1`, [card!.id]),
    ).rejects.toThrow(/needs prices/);
    await fx.query(
      `INSERT INTO ops.rate_card_prefixes (rate_card_id, prefix, market) VALUES ($1, '91', 'India')`,
      [card!.id],
    );
    await fx.query(
      `INSERT INTO ops.rate_card_prices (rate_card_id, market, category, price_micros) VALUES ($1, 'India', 'marketing', 1000000)`,
      [card!.id],
    );
    await fx.query(`UPDATE ops.rate_cards SET status = 'published' WHERE id = $1`, [card!.id]);
    await expect(
      fx.query(
        `INSERT INTO ops.rate_card_prices (rate_card_id, market, category, price_micros) VALUES ($1, 'India', 'utility', 1)`,
        [card!.id],
      ),
    ).rejects.toThrow(/only be added to a draft/);
    await expect(
      fx.query(
        `UPDATE ops.rate_cards SET source_url = 'https://example.test/other' WHERE id = $1`,
        [card!.id],
      ),
    ).rejects.toThrow(/immutable/);

    await s.campaigns.updateSettings(
      owner,
      { approvalRequired: false, cap: null, costCurrency: 'INR' },
      {},
    );
    const { id } = await s.draft('Budgeted', { budget: { amount: '2.5', currency: 'INR' } });
    const review = await s.campaigns.reviewDraft(owner, id);
    expect(review.estimate).toMatchObject({
      currency: 'INR',
      totalMicros: 5_000_000,
      unpricedCount: 0,
    });
    await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    expect(await s.tick(id)).toMatchObject({
      outcome: 'paused',
      queued: 2,
      pauseReason: 'budget_reached',
    });
    expect(await campaignRow(id)).toMatchObject({
      spent_estimate_micros: '2000000',
      queued_count: 2,
    });
    await expectAppError(
      s.campaigns.resumeCampaign(owner, id, {}),
      'precondition_failed',
      /spending cap/,
    );
    await s.campaigns.updateGuardrails(
      owner,
      id,
      { ratePerMinute: null, maxMessages: 4, budget: { amount: '10', currency: 'INR' } },
      {},
    );
    await s.campaigns.resumeCampaign(owner, id, {});
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 2 });
    s.clock.advance(11_000);
    expect(await s.tick(id)).toMatchObject({
      outcome: 'paused',
      pauseReason: 'message_cap_reached',
    });
    expect(
      (await recipients(id))
        .filter((r) => r.state === 'queued')
        .map((r) => r.estimated_cost_micros),
    ).toEqual(['1000000', '1000000', '1000000', '1000000']);
    // Each pause emailed the owner, whose authority it sends under (ADR-210).
    expect((await pauseEmails(s.c.tenant.id, id)).map((e) => [e.to, e.subject])).toEqual([
      [s.c.owner.email, 'Campaign “Budgeted” paused: its spending cap was reached'],
      [s.c.owner.email, 'Campaign “Budgeted” paused: its message cap was reached'],
    ]);
  });
});

describe('the ends of links (ADR-229)', () => {
  it('fills each recipient’s link from a field, with the fallback for a value the link cannot take', async () => {
    const s = await setup();
    const owner = await fx.ctx(s.c, s.c.owner);
    const contactsService = createContactsService({ db: fx.dbs.app, clock: systemClock });
    const { key } = await contactsService.createField(owner, { label: 'Order code', type: 'text' });
    // A template whose website button's link ends with a value (ADR-228).
    const templates = createTemplatesService({
      db: fx.dbs.app,
      jobs: fx.jobs(),
      signer: fx.signer,
      clock: systemClock,
    });
    const { id: templateId } = await templates.createDraft(owner, {
      whatsappAccountId: s.c.whatsappAccountId,
      name: 'order_link',
      language: 'en',
      definition: {
        category: 'MARKETING',
        header: { type: 'none' },
        body: { text: 'Hello {{1}}, your offer is ready.', examples: ['Asha'] },
        footer: null,
        buttons: [
          {
            type: 'URL',
            text: 'Open offer',
            url: 'https://shop.example/offer/{{1}}',
            example: 'A-1',
          },
        ],
      },
    });
    await templates.submitTemplate(owner, templateId);
    const workerDeps = {
      db: fx.dbs.app,
      keyring: fx.keyring,
      graph: fx.graph,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    };
    expect(await processTemplateSubmit(workerDeps, scopeOf(s.c), templateId)).toBe('done');
    fx.standIn.state.templates.get(s.c.wabaId)!.find((x) => x.name === 'order_link')!.status =
      'APPROVED';
    await syncTemplates(workerDeps, scopeOf(s.c), s.c.whatsappAccountId);

    const asha = await s.contact('+919830000001', { name: 'Asha' });
    const bina = await s.contact('+919830000002', { name: 'Bina' });
    await contactsService.updateContact(owner, asha, { attributes: { [key]: 'A-17' } });
    await contactsService.updateContact(owner, bina, { attributes: { [key]: 'B 18' } });

    // A fixed end the link cannot take is a problem before submitting.
    const fixed = await s.draft('Fixed link', {
      templateId,
      variables: {
        header: [],
        body: [{ source: 'name', fallback: 'there' }],
        buttons: [{ source: 'static', value: 'two words' }],
      },
    });
    expect((await s.campaigns.reviewDraft(owner, fixed.id)).problems).toContain(
      'Open offer: The end of a link cannot contain spaces.',
    );

    const { id } = await s.draft('Offer links', {
      templateId,
      variables: {
        header: [],
        body: [{ source: 'name', fallback: 'there' }],
        buttons: [{ source: 'field', key, fallback: 'latest' }],
      },
    });
    expect((await s.campaigns.reviewDraft(owner, id)).problems).toEqual([]);
    await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 2 });
    expect(await s.dispatchAll(id)).toEqual(['accepted', 'accepted']);
    const sent = fx.standIn.state.requests
      .filter((r) => r.path.endsWith('/messages'))
      .slice(-2)
      .map((r) => r.body as { to: string; template: { components: unknown[] } });
    const buttonOf = (to: string) =>
      sent
        .find((b) => b.to === to)!
        .template.components.filter((c) => (c as { type: string }).type === 'button');
    // Asha's own code; Bina's has a space, so the fallback.
    expect(buttonOf('919830000001')).toEqual([
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'A-17' }] },
    ]);
    expect(buttonOf('919830000002')).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'latest' }],
      },
    ]);
  });
});

describe('isolation', () => {
  it('another company cannot read, change or target a campaign or segment by id', async () => {
    const a = await setup();
    await a.contact('+919860000001', { name: 'Mine' });
    const owner = await fx.ctx(a.c, a.c.owner);
    const { id } = await a.draft('Private');
    const { id: segmentId } = await a.segments.createSegment(
      owner,
      {
        name: 'VIPs',
        definition: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
      },
      {},
    );
    const b = await setup();
    const other = await fx.ctx(b.c, b.c.owner);
    await expectAppError(b.campaigns.getCampaign(other, id), 'not_found');
    await expectAppError(b.campaigns.cancelCampaign(other, id, {}), 'not_found');
    await expectAppError(
      b.campaigns.submitCampaign(other, id, { expectedVersion: 1 }, {}),
      'not_found',
    );
    await expectAppError(b.segments.getSegment(other, segmentId), 'not_found');
    // Retargeting by another company's campaign, or a draft pointing at its segment, is refused.
    await expectAppError(
      b.segments.previewDefinition(other, {
        match: 'all',
        conditions: [{ type: 'campaign', campaignId: id, outcome: 'replied' }],
      }),
      'validation_failed',
    );
    const { id: mine } = await b.campaigns.createDraft(other, { name: 'Mine' }, {});
    await expectAppError(
      b.campaigns.updateDraft(
        other,
        mine,
        { ...b.draftInput('Mine'), audience: { kind: 'segment', segmentId } },
        {},
      ),
      'not_found',
    );
    await expectAppError(
      b.campaigns.updateDraft(
        other,
        mine,
        { ...b.draftInput('Mine'), templateId: a.templateId },
        {},
      ),
      'not_found',
    );
    const leaked = await fx.dbs.app.run(scopeOf(b.c), (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM app.campaign_recipients`),
    );
    expect(leaked.rows[0]).toEqual({ n: 0 });
  });
});

describe('the messaging-limit notice (ADR-400)', () => {
  /** Stores a number's limit as a health read that asked for it would (ADR-398). */
  const setLimit = (channelAccountId: string, limit: string | null, asked = true) =>
    fx.query(
      `UPDATE app.channel_accounts
          SET messaging_limit = $2, messaging_limit_checked_at = CASE WHEN $3 THEN now() END
        WHERE id = $1`,
      [channelAccountId, limit, asked],
    );

  it("reads only the campaign's own company's number, under its scope, for its review and its page", async () => {
    const a = await setup();
    const b = await setup();
    await a.contact('+919870000001', { name: 'Asha' });
    await a.contact('+919870000002', { name: 'Bina' });
    await a.contact('+919870000003', { name: 'Chitra', optIn: false });
    const owner = await fx.ctx(a.c, a.c.owner);
    const { id } = await a.draft('Limit check');

    // Never asked: unknown, with no figure.
    const never = await a.campaigns.reviewDraft(owner, id);
    expect(never.audience).toMatchObject({ total: 3, eligible: 2 });
    expect(never.messagingLimit).toMatchObject({
      status: 'unknown',
      unknown: 'not_asked',
      limit: null,
      checkedAt: null,
      figure: null,
      recipients: 2,
      tone: 'info',
    });

    // The other company's number has another limit, which A's review never shows.
    await setLimit(a.c.channelAccountId, 'TIER_250');
    await setLimit(b.c.channelAccountId, 'TIER_UNLIMITED');
    const within = await a.campaigns.reviewDraft(owner, id);
    expect(within.messagingLimit).toMatchObject({
      status: 'within',
      limit: 'TIER_250',
      figure: 250,
      recipients: 2,
      tone: 'info',
    });
    expect(within.messagingLimit?.checkedAt).toBeInstanceOf(Date);
    // The review counts the audience once, as before: the notice uses its eligible count.
    expect(within.messagingLimit?.recipients).toBe(within.audience?.eligible);

    // A number of another company is never read: not by A's company id under A's scope, and not by
    // B's company id under A's scope either (row security).
    for (const tenantId of [a.c.tenant.id, b.c.tenant.id]) {
      expect(
        await fx.dbs.app.run(scopeOf(a.c), (tx) =>
          loadNumberMessagingLimit(tx, tenantId, b.c.channelAccountId),
        ),
      ).toBeNull();
    }
    expect(
      await fx.dbs.app.run(scopeOf(a.c), (tx) =>
        loadNumberMessagingLimit(tx, a.c.tenant.id, a.c.channelAccountId),
      ),
    ).toMatchObject({ limit: 'TIER_250' });

    // Unknown kinds: Meta gave none, or a value research gives no figure for.
    await setLimit(a.c.channelAccountId, null);
    expect((await a.campaigns.reviewDraft(owner, id)).messagingLimit).toMatchObject({
      status: 'unknown',
      unknown: 'not_reported',
      figure: null,
    });
    await setLimit(a.c.channelAccountId, 'TIER_50');
    expect((await a.campaigns.reviewDraft(owner, id)).messagingLimit).toMatchObject({
      status: 'unknown',
      unknown: 'no_figure',
      limit: 'TIER_50',
      figure: null,
    });

    // Submitted and not finished: the page shows it from the frozen audience less those skipped.
    await setLimit(a.c.channelAccountId, 'TIER_250');
    expect(await a.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {})).toMatchObject({
      status: 'scheduled',
      audience: 3,
      pending: 2,
    });
    const live = await a.campaigns.getCampaign(owner, id);
    expect(live.messagingLimit).toMatchObject({
      status: 'within',
      limit: 'TIER_250',
      figure: 250,
      recipients: 2,
    });
    // B's owner cannot read A's campaign at all.
    await expectAppError(b.campaigns.getCampaign(await fx.ctx(b.c, b.c.owner), id), 'not_found');

    // Finished: no notice.
    await a.campaigns.cancelCampaign(owner, id, {});
    expect((await a.campaigns.getCampaign(owner, id)).messagingLimit).toBeNull();
    // A draft's page takes the notice from its review, not from the campaign.
    const { id: draft } = await a.draft('Another check');
    expect((await a.campaigns.getCampaign(owner, draft)).messagingLimit).toBeNull();
    expect((await a.campaigns.reviewDraft(owner, draft)).messagingLimit).toMatchObject({
      status: 'within',
    });
  });

  it('warns over a figure without blocking: 251 eligible contacts on TIER_250 are still submitted', async () => {
    // A company of its own, so no other test's rows count.
    const a = await setup();
    const owner = await fx.ctx(a.c, a.c.owner);
    await fx.query(
      `WITH c AS (
         INSERT INTO app.contacts (id, tenant_id, display_name, phone_e164, source)
         SELECT gen_random_uuid(), $1, 'Over ' || g, '+9171' || lpad(g::text, 8, '0'), 'import'
           FROM generate_series(1, 251) AS g
         RETURNING id)
       INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag)
       SELECT gen_random_uuid(), $1, c.id, 'vip' FROM c`,
      [a.c.tenant.id],
    );
    await fx.query(
      `INSERT INTO app.consent_events (id, tenant_id, contact_id, purpose, action, source, actor_type, occurred_at)
       SELECT gen_random_uuid(), tenant_id, id, 'marketing', 'opt_in', 'import', 'system', now()
         FROM app.contacts WHERE tenant_id = $1`,
      [a.c.tenant.id],
    );
    await setLimit(a.c.channelAccountId, 'TIER_250');
    const { id } = await a.draft('Over the figure');
    const review = await a.campaigns.reviewDraft(owner, id);
    expect(review.audience).toMatchObject({ total: 251, eligible: 251 });
    expect(review.problems).toEqual([]);
    expect(review.messagingLimit).toMatchObject({
      status: 'over',
      limit: 'TIER_250',
      figure: 250,
      recipients: 251,
      tone: 'warning',
      title: "More recipients than the number's messaging limit",
    });
    expect(await a.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {})).toMatchObject({
      status: 'scheduled',
      audience: 251,
      pending: 251,
    });
    expect((await a.campaigns.getCampaign(owner, id)).messagingLimit).toMatchObject({
      status: 'over',
      recipients: 251,
    });
  });

  it('is absent until the draft has a number and an audience, and never blocks a submission', async () => {
    const a = await setup();
    await a.contact('+919870000011', { name: 'Asha' });
    const owner = await fx.ctx(a.c, a.c.owner);
    const { id: empty } = await a.campaigns.createDraft(owner, { name: 'Empty' }, {});
    expect((await a.campaigns.reviewDraft(owner, empty)).messagingLimit).toBeNull();
    // A limit research gives no figure for, far from any figure: the draft is still submitted.
    await setLimit(a.c.channelAccountId, 'UNTIERED');
    const { id } = await a.draft('Untiered');
    const review = await a.campaigns.reviewDraft(owner, id);
    expect(review.problems).toEqual([]);
    expect(review.messagingLimit).toMatchObject({ status: 'unknown', unknown: 'no_figure' });
    expect(await a.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {})).toMatchObject({
      status: 'scheduled',
    });
  });
});

describe('a 10,000-recipient campaign', () => {
  it('snapshots and queues every recipient exactly once within the pacing bounds', async () => {
    const s = await setup();
    const owner = await fx.ctx(s.c, s.c.owner);
    const t0 = Date.now();
    await fx.query(
      `WITH c AS (
         INSERT INTO app.contacts (id, tenant_id, display_name, phone_e164, source)
         SELECT gen_random_uuid(), $1, 'Load ' || g, '+9170' || lpad(g::text, 8, '0'), 'import'
           FROM generate_series(1, 10000) AS g
         RETURNING id)
       INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag)
       SELECT gen_random_uuid(), $1, c.id, 'vip' FROM c`,
      [s.c.tenant.id],
    );
    await fx.query(
      `INSERT INTO app.consent_events (id, tenant_id, contact_id, purpose, action, source, actor_type, occurred_at)
       SELECT gen_random_uuid(), tenant_id, id, 'marketing', 'opt_in', 'import', 'system', now()
         FROM app.contacts WHERE tenant_id = $1`,
      [s.c.tenant.id],
    );
    // Statistics as autovacuum leaves them after a bulk import. Without them, the audience count
    // could be planned on statistics from before the 10,000 rows and outrun the statement timeout,
    // depending on when autovacuum ran (it did once in CI); the test is about the campaign path.
    await fx.query(
      'ANALYZE app.contacts, app.contact_tags, app.consent_events, app.contact_consents',
    );
    const seeded = Date.now() - t0;
    const { id } = await s.draft('Ten thousand');
    const t1 = Date.now();
    const submitted = await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    const snapshotMs = Date.now() - t1;
    expect(submitted).toMatchObject({ audience: 10_000, pending: 10_000 });
    let ticks = 0;
    let queued = 0;
    const t2 = Date.now();
    for (;;) {
      const r = await s.tick(id, 500);
      ticks += 1;
      queued += r.queued;
      if (r.outcome === 'completed') break;
      expect(r.queued).toBeLessThanOrEqual(500);
      // Let the send worker drain the backlog: here the intents are marked sent directly.
      await fx.query(
        `UPDATE app.send_intents SET state = 'accepted' WHERE state = 'queued'
           AND message_id IN (SELECT id FROM app.messages WHERE campaign_id = $1)`,
        [id],
      );
      s.clock.advance(10_000);
      expect(ticks).toBeLessThan(40);
    }
    const queueMs = Date.now() - t2;
    expect(queued).toBe(10_000);
    const counts = await fx.query<{ messages: number; intents: number; threads: number }>(
      `SELECT (SELECT count(*)::int FROM app.messages WHERE campaign_id = $1) AS messages,
              (SELECT count(DISTINCT s.message_id)::int FROM app.send_intents s
                 JOIN app.messages m ON m.id = s.message_id WHERE m.campaign_id = $1) AS intents,
              (SELECT count(DISTINCT m.conversation_id)::int FROM app.messages m WHERE m.campaign_id = $1) AS threads`,
      [id],
    );
    expect(counts[0]).toEqual({ messages: 10_000, intents: 10_000, threads: 10_000 });
    expect(await campaignRow(id)).toMatchObject({ status: 'completed', queued_count: 10_000 });
    console.info(
      `10k campaign: seed ${seeded} ms, snapshot ${snapshotMs} ms, ${ticks} ticks queued 10,000 in ${queueMs} ms`,
    );
  }, 180_000);
});

describe('A/B template variants (ADR-405)', () => {
  /** A test-only currency, so the rate card below changes no other test's estimates. */
  const CURRENCY = 'XVB';
  const MARKETING_MICROS = 1_000_000;
  const UTILITY_MICROS = 100_000;
  let cardCreated = false;

  /** Test-only prices for +91 numbers in XVB (not Meta's): marketing 1, utility 0.1. */
  async function ensureRateCard(createdBy: string) {
    if (cardCreated) return;
    const [card] = await fx.query<{ id: string }>(
      `INSERT INTO ops.rate_cards (id, currency, effective_from, source_url, created_by_user_id)
       VALUES (gen_random_uuid(), $1, now() - interval '1 day', 'https://example.test/ab-rates', $2)
       RETURNING id`,
      [CURRENCY, createdBy],
    );
    await fx.query(
      `INSERT INTO ops.rate_card_prefixes (rate_card_id, prefix, market) VALUES ($1, '91', 'India')`,
      [card!.id],
    );
    await fx.query(
      `INSERT INTO ops.rate_card_prices (rate_card_id, market, category, price_micros)
       VALUES ($1, 'India', 'marketing', $2), ($1, 'India', 'utility', $3)`,
      [card!.id, MARKETING_MICROS, UTILITY_MICROS],
    );
    await fx.query(`UPDATE ops.rate_cards SET status = 'published' WHERE id = $1`, [card!.id]);
    cardCreated = true;
  }

  const notice: TemplateDefinition = {
    category: 'UTILITY',
    header: { type: 'none' },
    body: { text: 'Your store has news for you.', examples: [] },
    footer: null,
    buttons: [],
  };

  /** Another approved template of the company's WhatsApp account. */
  async function approvedTemplate(s: Setup, name: string, definition: TemplateDefinition) {
    const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
    const templates = createTemplatesService(deps);
    const owner = await fx.ctx(s.c, s.c.owner);
    const { id } = await templates.createDraft(owner, {
      whatsappAccountId: s.c.whatsappAccountId,
      name,
      language: 'en',
      definition,
    });
    await templates.submitTemplate(owner, id);
    const workerDeps = { ...deps, keyring: fx.keyring, graph: fx.graph };
    expect(await processTemplateSubmit(workerDeps, scopeOf(s.c), id)).toBe('done');
    fx.standIn.state.templates.get(s.c.wabaId)!.find((x) => x.name === name)!.status = 'APPROVED';
    await syncTemplates(workerDeps, scopeOf(s.c), s.c.whatsappAccountId);
    return id;
  }

  async function variantRows(campaignId: string) {
    return fx.query<{
      contact_id: string;
      variant: string;
      state: string;
      skip_reason: string | null;
      message_id: string | null;
      estimated_cost_micros: string | null;
    }>(
      `SELECT contact_id, variant, state, skip_reason, message_id, estimated_cost_micros
         FROM app.campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
  }

  const byContact = (rows: { contact_id: string; variant: string }[]) =>
    new Map(rows.map((r) => [r.contact_id, r.variant]));

  it('assigns, prices, sends and reports each variant, every recipient once', async () => {
    const s = await setup();
    const owner = await fx.ctx(s.c, s.c.owner);
    await ensureRateCard(s.c.owner.id);
    await s.campaigns.updateSettings(
      owner,
      { approvalRequired: false, cap: null, costCurrency: CURRENCY },
      {},
    );
    for (let i = 0; i < 40; i += 1)
      await s.contact(`+9198410000${String(i).padStart(2, '0')}`, { name: `Ab${i}` });
    const noticeId = await approvedTemplate(s, 'store_news', notice);
    const { id } = await s.draft('A/B test', {
      variantB: { templateId: noticeId, variables: { header: [], body: [] }, sharePercent: 30 },
    });

    // The review checks and prices each variant by its own template.
    const review = await s.campaigns.reviewDraft(owner, id);
    expect(review.problems).toEqual([]);
    expect(review.audience).toMatchObject({ total: 40, eligible: 40 });
    const [a, b] = review.variants!;
    expect(a).toMatchObject({ label: 'A', templateId: s.templateId, sharePercent: 70 });
    expect(b).toMatchObject({ label: 'B', templateId: noticeId, sharePercent: 30 });
    expect(a!.audience!.total + b!.audience!.total).toBe(40);
    expect(b!.audience!.total).toBeGreaterThan(0);
    expect(a!.audience!.total).toBeGreaterThan(0);
    expect(a!.estimate!.totalMicros).toBe(a!.audience!.eligible * MARKETING_MICROS);
    expect(b!.estimate!.totalMicros).toBe(b!.audience!.eligible * UTILITY_MICROS);
    expect(review.estimate).toMatchObject({
      currency: CURRENCY,
      totalMicros: a!.estimate!.totalMicros + b!.estimate!.totalMicros,
      pricedCount: 40,
      unpricedCount: 0,
    });
    // The messaging limit notice counts every variant's recipients.
    if (review.messagingLimit) expect(review.messagingLimit.recipients).toBe(40);

    await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    const frozen = await variantRows(id);
    expect(frozen).toHaveLength(40);
    // Each recipient's variant is the one the stable hash gives, in SQL as in TypeScript.
    for (const r of frozen) expect(r.variant).toBe(assignVariant(id, r.contact_id, 30));
    const bCount = frozen.filter((r) => r.variant === 'B').length;
    expect(bCount).toBe(b!.audience!.total);

    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 40 });
    const queued = await variantRows(id);
    // Each recipient priced once, at its variant's category.
    for (const r of queued) {
      expect(r.state).toBe('queued');
      expect(r.estimated_cost_micros).toBe(
        String(r.variant === 'B' ? UTILITY_MICROS : MARKETING_MICROS),
      );
    }
    const spent = await campaignRow(id);
    expect(Number(spent.spent_estimate_micros)).toBe(
      (40 - bCount) * MARKETING_MICROS + bCount * UTILITY_MICROS,
    );

    // Each message is its variant's template, with its variant's variables.
    const messages = await fx.query<{ id: string; template_id: string; contact_id: string }>(
      `SELECT m.id, m.template_id, cv.contact_id FROM app.messages m
         JOIN app.conversations cv ON cv.id = m.conversation_id WHERE m.campaign_id = $1`,
      [id],
    );
    const variants = byContact(queued);
    for (const m of messages)
      expect(m.template_id).toBe(variants.get(m.contact_id) === 'B' ? noticeId : s.templateId);
    const outcomes = await s.dispatchAll(id);
    expect(outcomes).toHaveLength(40);
    const sentNames = fx.standIn.state.requests
      .filter((r) => r.path.endsWith('/messages'))
      .slice(-40)
      .map((r) => (r.body as { template: { name: string } }).template.name);
    expect(sentNames.filter((n) => n === 'store_news')).toHaveLength(bCount);
    expect(sentNames.filter((n) => n === 'festive_sale')).toHaveLength(40 - bCount);

    // Results per variant add up to the campaign's.
    const view = await s.campaigns.getCampaign(owner, id);
    expect(view.variantB).toMatchObject({ templateId: noticeId, sharePercent: 30 });
    const results = view.variantResults!;
    expect(results.map((r) => r.variant)).toEqual(['A', 'B']);
    expect(results[0]!.analytics).toMatchObject({ audience: 40 - bCount, queued: 40 - bCount });
    expect(results[1]!.analytics).toMatchObject({ audience: bCount, queued: bCount });
    expect(results[0]!.analytics.estimateMicros + results[1]!.analytics.estimateMicros).toBe(
      view.analytics!.estimateMicros,
    );
    // The recipients list names each one's variant.
    const listed = await s.campaigns.listRecipients(owner, id, {});
    expect(listed.withVariants).toBe(true);
    for (const r of listed.items) expect(r.variant).toBe(variants.get(r.contactId));
  });

  it('leaves a campaign without variant B as it was', async () => {
    const s = await setup();
    const owner = await fx.ctx(s.c, s.c.owner);
    for (let i = 0; i < 5; i += 1) await s.contact(`+9198420000${10 + i}`, { name: `P${i}` });
    const { id } = await s.draft('Plain');
    const review = await s.campaigns.reviewDraft(owner, id);
    expect(review.variants).toBeNull();
    expect(review.problems).toEqual([]);
    await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    expect((await variantRows(id)).every((r) => r.variant === 'A')).toBe(true);
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 5 });
    const view = await s.campaigns.getCampaign(owner, id);
    expect(view.variantB).toBeNull();
    expect(view.variantResults).toBeNull();
    expect((await s.campaigns.listRecipients(owner, id, {})).withVariants).toBe(false);
    const [variantCount] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.campaign_variants WHERE campaign_id = $1`,
      [id],
    );
    expect(variantCount!.n).toBe(0);
  });

  it("refuses another company's template as variant B", async () => {
    const mine = await setup();
    const theirs = await setup();
    const owner = await fx.ctx(mine.c, mine.c.owner);
    const { id } = await mine.draft('Borrowing');
    await expectAppError(
      mine.campaigns.updateDraft(
        owner,
        id,
        mine.draftInput('Borrowing', {
          expectedVersion: 1,
          variantB: {
            templateId: theirs.templateId,
            variables: { header: [], body: [{ source: 'name', fallback: 'there' }] },
            sharePercent: 50,
          },
        }),
        {},
      ),
      'not_found',
    );
    // Nothing was written, and the database refuses the row too (its foreign key is the
    // company's own templates).
    const [count] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.campaign_variants WHERE campaign_id = $1`,
      [id],
    );
    expect(count!.n).toBe(0);
    await expect(
      fx.query(
        `INSERT INTO app.campaign_variants (id, tenant_id, campaign_id, label, template_id, share_percent)
         VALUES (gen_random_uuid(), $1, $2, 'B', $3, 50)`,
        [mine.c.tenant.id, id, theirs.templateId],
      ),
    ).rejects.toThrow(/campaign_variants_template_fk/);
    // A share off the 5% steps is refused before anything is read.
    await expectAppError(
      mine.campaigns.updateDraft(
        owner,
        id,
        mine.draftInput('Borrowing', {
          expectedVersion: 1,
          variantB: { templateId: mine.templateId, variables: {}, sharePercent: 33 },
        }),
        {},
      ),
      'validation_failed',
    );
  });

  it('skips only the recipients of a marketing variant B who have not opted in', async () => {
    const s = await setup();
    const owner = await fx.ctx(s.c, s.c.owner);
    for (let i = 0; i < 20; i += 1)
      await s.contact(`+9198430000${String(i).padStart(2, '0')}`, { name: `In${i}` });
    for (let i = 20; i < 40; i += 1)
      await s.contact(`+9198430000${String(i).padStart(2, '0')}`, {
        name: `Out${i}`,
        optIn: false,
      });
    const noticeId = await approvedTemplate(s, 'store_news_util', notice);
    // A is the utility notice; B is the marketing template, which needs an opt-in.
    const { id } = await s.draft('Marketing B', {
      templateId: noticeId,
      variables: { header: [], body: [] },
      variantB: {
        templateId: s.templateId,
        variables: { header: [], body: [{ source: 'name', fallback: 'there' }] },
        sharePercent: 50,
      },
    });
    const review = await s.campaigns.reviewDraft(owner, id);
    expect(review.frequencyCap).toBeNull();
    expect(review.problems).toEqual([]);
    await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    const rows = await variantRows(id);
    const optedOutNames = new Set(
      (
        await fx.query<{ id: string }>(
          `SELECT id FROM app.contacts WHERE tenant_id = $1 AND display_name LIKE 'Out%'`,
          [s.c.tenant.id],
        )
      ).map((r) => r.id),
    );
    for (const r of rows) {
      const withoutOptIn = optedOutNames.has(r.contact_id);
      if (r.variant === 'B' && withoutOptIn) {
        expect(r).toMatchObject({ state: 'skipped', skip_reason: 'no_marketing_opt_in' });
      } else {
        expect(r).toMatchObject({ state: 'pending', skip_reason: null });
      }
    }
    expect(rows.some((r) => r.variant === 'B' && r.state === 'skipped')).toBe(true);
    expect(rows.some((r) => r.variant === 'A' && optedOutNames.has(r.contact_id))).toBe(true);
    // The runner checks each recipient against its own variant's purpose again.
    const tick = await s.tick(id);
    expect(tick).toMatchObject({ outcome: 'progress' });
    const after = await variantRows(id);
    expect(after.filter((r) => r.state === 'queued')).toHaveLength(
      rows.filter((r) => r.state === 'pending').length,
    );
  });

  it('keeps every assignment through a pause, a resume, a lost tick and a resubmission', async () => {
    const s = await setup();
    const owner = await fx.ctx(s.c, s.c.owner);
    const marketer = await fx.ctx(s.c, s.c.marketer);
    for (let i = 0; i < 30; i += 1)
      await s.contact(`+9198440000${String(i).padStart(2, '0')}`, { name: `R${i}` });
    const noticeId = await approvedTemplate(s, 'store_news_restart', notice);
    await s.campaigns.updateSettings(
      owner,
      { approvalRequired: true, cap: null, costCurrency: null },
      {},
    );
    const { id } = await s.draft('Restart', {
      ratePerMinute: 60,
      variantB: { templateId: noticeId, variables: { header: [], body: [] }, sharePercent: 50 },
    });
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    const first = byContact(await variantRows(id));
    // Taken back to a draft and submitted again: the same contacts get the same variants.
    await s.campaigns.withdrawCampaign(marketer, id, {});
    expect(await variantRows(id)).toHaveLength(0);
    const draft = await s.campaigns.getCampaign(owner, id);
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: draft.campaign.version }, {});
    expect(byContact(await variantRows(id))).toEqual(first);
    // The approval email names both variants.
    const approvals = await campaignEmails(s.c.tenant.id, `campaign-approval:${id}:`);
    expect(approvals.length).toBeGreaterThan(0);
    for (const email of approvals)
      expect(email.lines.join(' ')).toContain('It tests 2 templates side by side');
    await s.campaigns.approveCampaign(owner, id, {}, {});
    // Ten a tick at 60 a minute: a tick, a pause, a resume and a tick lost and signalled again.
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 10 });
    await s.campaigns.pauseCampaign(owner, id, {});
    expect(byContact(await variantRows(id))).toEqual(first);
    await s.campaigns.resumeCampaign(owner, id, {});
    s.clock.advance(15_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress' });
    s.clock.advance(15_000);
    await s.tick(id);
    const after = await variantRows(id);
    expect(byContact(after)).toEqual(first);
    // The runtime role cannot change a recorded variant: PostgreSQL refuses the column, which the
    // database layer maps to forbidden ("Operation not permitted.") with the reason as its cause.
    const refusal = await fx.dbs.app
      .run(scopeOf(s.c), (tx) =>
        tx.execute(sql`update app.campaign_recipients set variant = 'B' where campaign_id = ${id}`),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isAppError(refusal) ? refusal.code : refusal).toBe('forbidden');
    const reasons: string[] = [];
    for (let e: unknown = refusal; e instanceof Error; e = e.cause) reasons.push(e.message);
    expect(reasons.join(' | ')).toMatch(/permission denied/);
    // Each queued message used its recipient's recorded variant's template.
    const messages = await fx.query<{ template_id: string; contact_id: string }>(
      `SELECT m.template_id, cv.contact_id FROM app.messages m
         JOIN app.conversations cv ON cv.id = m.conversation_id
        WHERE m.campaign_id = $1 AND m.status <> 'canceled'`,
      [id],
    );
    for (const m of messages)
      expect(m.template_id).toBe(first.get(m.contact_id) === 'B' ? noticeId : s.templateId);
    await s.campaigns.updateSettings(
      owner,
      { approvalRequired: false, cap: null, costCurrency: null },
      {},
    );
  });

  it('checks a variant’s template only while it has pending recipients, so a finished B never holds A back', async () => {
    const s = await setup();
    const owner = await fx.ctx(s.c, s.c.owner);
    for (let i = 0; i < 30; i += 1)
      await s.contact(`+9198450000${String(i).padStart(2, '0')}`, { name: `F${i}` });
    const noticeId = await approvedTemplate(s, 'store_news_finished', notice);
    const variantB = {
      templateId: noticeId,
      variables: { header: [], body: [] },
      sharePercent: 50,
    };
    const { id: stillSending } = await s.draft('B still sending', { variantB });
    const { id: finished } = await s.draft('B finished', { variantB });
    await s.campaigns.submitCampaign(owner, stillSending, { expectedVersion: 1 }, {});
    await s.campaigns.submitCampaign(owner, finished, { expectedVersion: 1 }, {});
    // B's recipients of the second campaign were all handled; then Meta paused B's template.
    await fx.query(
      `UPDATE app.campaign_recipients SET state = 'skipped', skip_reason = 'suppressed'
        WHERE campaign_id = $1 AND variant = 'B'`,
      [finished],
    );
    await fx.query(`UPDATE app.message_templates SET status = 'paused' WHERE id = $1`, [noticeId]);

    // While B has pending recipients, its template pauses the campaign and a resume names B.
    expect(await s.tick(stillSending)).toMatchObject({
      outcome: 'paused',
      pauseReason: 'template_not_approved',
    });
    await expectAppError(
      s.campaigns.resumeCampaign(owner, stillSending, {}),
      'precondition_failed',
      /Variant B’s template is not approved/,
    );

    // Once B has none, A keeps sending, and a member's pause and resume are not refused for B.
    const aPending = (await variantRows(finished)).filter(
      (r) => r.variant === 'A' && r.state === 'pending',
    ).length;
    expect(aPending).toBeGreaterThan(0);
    expect(await s.tick(finished)).toMatchObject({ outcome: 'progress', queued: aPending });
    await s.campaigns.pauseCampaign(owner, finished, {});
    await s.campaigns.resumeCampaign(owner, finished, {});
    expect(await campaignRow(finished)).toMatchObject({ status: 'running' });
    await fx.query(`UPDATE app.message_templates SET status = 'approved' WHERE id = $1`, [
      noticeId,
    ]);
  });

  it('ignores a variant B that got no recipients, as when a web server of the release before submitted the draft', async () => {
    const s = await setup();
    const owner = await fx.ctx(s.c, s.c.owner);
    for (let i = 0; i < 6; i += 1)
      await s.contact(`+9198460000${String(i).padStart(2, '0')}`, { name: `O${i}` });
    const { id } = await s.draft('Old web server');
    await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    // The draft had a variant B without a template, which the older server's snapshot ignored.
    await fx.query(
      `INSERT INTO app.campaign_variants (id, tenant_id, campaign_id, label, share_percent)
       VALUES (gen_random_uuid(), $1, $2, 'B', 50)`,
      [s.c.tenant.id, id],
    );
    expect((await variantRows(id)).every((r) => r.variant === 'A')).toBe(true);
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 6 });
    await s.campaigns.pauseCampaign(owner, id, {});
    await s.campaigns.resumeCampaign(owner, id, {});
    expect(await campaignRow(id)).toMatchObject({ status: 'running' });
  });
});
