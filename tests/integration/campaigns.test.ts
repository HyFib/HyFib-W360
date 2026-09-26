import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, sql, type TenantScope } from '@w360/db';
import {
  attributeCampaignOptOut,
  cancelSendIntent,
  createCampaignsService,
  createConsentService,
  createContactsService,
  createSegmentsService,
  createTemplatesService,
  findDueCampaigns,
  pauseCampaignForRemovedLauncher,
  processSendIntent,
  processTemplateSubmit,
  runCampaignTick,
  syncTemplates,
  type CampaignsService,
  type SegmentsService,
  type TemplateDefinition,
} from '@w360/domain';
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
  const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock };
  const templates = createTemplatesService(deps);
  const owner = await fx.ctx(c, c.owner);
  const { id: templateId } = await templates.createDraft(owner, {
    whatsappAccountId: c.whatsappAccountId,
    name: 'festive_sale',
    language: 'en',
    definition: promo,
  });
  await templates.submitTemplate(owner, templateId);
  const workerDeps = { db: fx.dbs.app, keyring: fx.keyring, graph: fx.graph, clock: systemClock };
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
        { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock, sendRatePerSecond: rate },
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
          { db: fx.dbs.app, clock: systemClock },
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
