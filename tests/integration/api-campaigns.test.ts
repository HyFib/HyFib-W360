import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, type TenantScope } from '@w360/db';
import {
  apiGetCampaign,
  apiListCampaigns,
  authenticateApiToken,
  createApiKeysService,
  createCampaignsService,
  createConsentService,
  createContactsService,
  createTemplatesService,
  processSendIntent,
  processTemplateSubmit,
  runCampaignTick,
  syncTemplates,
  type ApiContext,
  type ApiScope,
  type TemplateDefinition,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Reading campaigns through the public API (ADR-125) against real PostgreSQL and the Graph
 * stand-in: the company's campaigns newest first with their counters, in one status or all, on
 * exact pages; one campaign with its results counted as members' campaign page counts them, from
 * the send pipeline, delivery statuses, a reply and a STOP, and a cancelled one's recipients; null
 * results for a draft; never another company's campaigns; refusals without the scope or with a bad
 * filter.
 */
let fx: WhatsAppFixture;

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
  await fx?.close();
});

beforeEach(() => {
  fx.standIn.state.sendQueue = [];
});

const scopeOf = (c: Company): TenantScope => authorizedTenantScope(c.tenant.id, null);
const deps = () => ({ db: fx.dbs.app });

const promo: TemplateDefinition = {
  category: 'MARKETING',
  header: { type: 'none' },
  body: { text: 'Hello {{1}}, our festive sale starts today.', examples: ['Asha'] },
  footer: null,
  buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }],
};

/** A key of the company created by its owner, and the context a request with it gets. */
async function apiKey(c: Company, scopes: ApiScope[]): Promise<ApiContext> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name: 'Campaign results',
    scopes,
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

/** The code of a refusal and the paths it names. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, paths: (error.issues ?? []).map((i) => i.path) };
  }
  throw new Error('expected a refusal');
}

/** A company with an approved marketing template, a campaigns service and helpers to run one. */
async function setup() {
  const c = await fx.company();
  const clock = new TestClock();
  const serviceDeps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock };
  const owner = await fx.ctx(c, c.owner);
  const templates = createTemplatesService(serviceDeps);
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
  const campaigns = createCampaignsService(serviceDeps);
  return {
    c,
    owner,
    campaigns,
    templateId,
    async contact(phone: string, name: string, optIn = true) {
      const { id } = await contactsService.createContact(owner, {
        phone,
        displayName: name,
        tags: ['vip'],
      });
      if (optIn) {
        await consent.recordConsent(owner, {
          contactId: id,
          purpose: 'marketing',
          action: 'opt_in',
          note: 'Signed up at the store',
        });
      }
      return id;
    },
    async draft(name: string) {
      const { id } = await campaigns.createDraft(owner, { name }, {});
      await campaigns.updateDraft(
        owner,
        id,
        {
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
        },
        {},
      );
      return id;
    },
    /** Submits a draft and runs it to the end: queued, sent to the stand-in, completed. */
    async run(id: string) {
      await campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
      const tick = () =>
        runCampaignTick(
          { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock, sendRatePerSecond: 100 },
          scopeOf(c),
          id,
        );
      await tick();
      const intents = await fx.query<{ id: string }>(
        `SELECT s.id FROM app.send_intents s JOIN app.messages m ON m.id = s.message_id
          WHERE m.campaign_id = $1 AND s.state = 'queued' ORDER BY s.id`,
        [id],
      );
      for (const intent of intents) {
        await processSendIntent(
          { ...workerDeps, rate: { capacity: 1000, refillPerSecond: 1000 } },
          scopeOf(c),
          intent.id,
        );
      }
      clock.advance(11_000);
      expect(await tick()).toMatchObject({ outcome: 'completed' });
    },
  };
}

describe('reading campaigns (ADR-125)', () => {
  it('lists campaigns newest first with their counters and reads one with its results, as members see them', async () => {
    const s = await setup();
    const asha = await s.contact('+919820001001', 'Asha');
    const bina = await s.contact('+919820001002', 'Bina');
    const chitra = await s.contact('+919820001003', 'Chitra');
    await s.contact('+919820001004', 'Dev', false);
    const festive = await s.draft('Festive launch');
    await s.run(festive);
    // A draft without a number or a template yet.
    const { id: draft } = await s.campaigns.createDraft(s.owner, { name: 'Spring draft' }, {});
    // Submitted and cancelled before the runner starts it: its recipients are cancelled, and it
    // never queued a message.
    const weekend = await s.draft('Weekend offer');
    await s.campaigns.submitCampaign(s.owner, weekend, { expectedVersion: 1 }, {});
    expect(await s.campaigns.cancelCampaign(s.owner, weekend, {})).toMatchObject({
      status: 'canceled',
      canceledRecipients: 3,
      releasedSends: 0,
    });
    // Another company's campaign is never listed or read.
    const other = await setup();
    await other.contact('+919820001005', 'Other');
    const theirs = await other.draft('Their campaign');

    // Delivery statuses, a reply and a STOP keyword, as the campaign tests drive them.
    const wamids = await fx.query<{ external_message_id: string; contact_id: string }>(
      `SELECT m.external_message_id, cv.contact_id FROM app.messages m
         JOIN app.conversations cv ON cv.id = m.conversation_id WHERE m.campaign_id = $1`,
      [festive],
    );
    const wamidOf = (contactId: string) =>
      wamids.find((w) => w.contact_id === contactId)!.external_message_id;
    const now = String(Math.floor(Date.now() / 1000));
    await fx.deliver(
      fx.messagesBody(s.c, {
        statuses: [
          { id: wamidOf(asha), status: 'delivered', timestamp: now, recipient_id: '919820001001' },
          { id: wamidOf(bina), status: 'read', timestamp: now, recipient_id: '919820001002' },
          {
            id: wamidOf(chitra),
            status: 'failed',
            timestamp: now,
            recipient_id: '919820001003',
            errors: [{ code: 131049, title: 'Not delivered to maintain healthy engagement.' }],
          },
        ],
      }),
    );
    await fx.deliver(
      fx.messagesBody(s.c, { messages: [{ waId: '919820001001', text: 'Interested!' }] }),
    );
    await fx.deliver(fx.messagesBody(s.c, { messages: [{ waId: '919820001002', text: 'STOP' }] }));

    const ctx = await apiKey(s.c, ['campaigns.read']);
    const list = await apiListCampaigns(deps(), ctx, {});
    expect([list.data.map((c) => c.name), list.nextCursor]).toEqual([
      ['Weekend offer', 'Spring draft', 'Festive launch'],
      null,
    ]);
    const [weekendListed, draftListed, festiveListed] = list.data;
    expect(festiveListed).toMatchObject({
      id: festive,
      status: 'completed',
      pauseReason: null,
      completionReason: 'all_processed',
      templateId: s.templateId,
      templateName: 'festive_sale',
      canceledAt: null,
      audienceCount: 4,
      queuedCount: 3,
      skippedCount: 1,
    });
    expect(festiveListed!.channel).toEqual({ id: s.c.channelAccountId, phone: '+91 90000 00000' });
    expect(festiveListed!.scheduledAt).not.toBeNull();
    expect(festiveListed!.startedAt).not.toBeNull();
    expect(festiveListed!.completedAt).not.toBeNull();
    expect(draftListed).toMatchObject({
      id: draft,
      status: 'draft',
      templateId: null,
      templateName: null,
      channel: null,
      scheduledAt: null,
      startedAt: null,
      audienceCount: 0,
    });
    expect(weekendListed).toMatchObject({
      id: weekend,
      status: 'canceled',
      completionReason: null,
      startedAt: null,
      completedAt: null,
      audienceCount: 4,
      queuedCount: 0,
      skippedCount: 1,
    });
    expect(weekendListed!.canceledAt).not.toBeNull();
    // One status, and exact pages.
    const names = async (query: Record<string, string>) =>
      (await apiListCampaigns(deps(), ctx, query)).data.map((c) => c.name);
    expect(await names({ status: 'completed' })).toEqual(['Festive launch']);
    expect(await names({ status: 'draft' })).toEqual(['Spring draft']);
    expect(await names({ status: 'canceled' })).toEqual(['Weekend offer']);
    expect(await names({ status: 'running' })).toEqual([]);
    const first = await apiListCampaigns(deps(), ctx, { limit: '2' });
    expect(first.data.map((c) => c.name)).toEqual(['Weekend offer', 'Spring draft']);
    const second = await apiListCampaigns(deps(), ctx, { limit: '2', cursor: first.nextCursor! });
    expect([second.data.map((c) => c.name), second.nextCursor]).toEqual([['Festive launch'], null]);

    // The results, counted as members' campaign page counts them.
    const read = await apiGetCampaign(deps(), ctx, festive);
    expect(read).toMatchObject({ id: festive, name: 'Festive launch', status: 'completed' });
    expect(read.results).toEqual({
      audience: 4,
      pending: 0,
      skipped: 1,
      canceled: 0,
      queued: 3,
      inProgress: 0,
      sent: 2,
      delivered: 2,
      read: 1,
      failed: 1,
      unknown: 0,
      messagesCanceled: 0,
      // A STOP is a reply too, and the opt-out it records.
      replied: 2,
      optedOut: 1,
      skipReasons: [{ reason: 'no_marketing_opt_in', count: 1 }],
      failureCodes: [{ code: '131049', count: 1 }],
    });
    const members = (await s.campaigns.getCampaign(s.owner, festive)).analytics!;
    expect(read.results).toMatchObject({
      sent: members.sent,
      delivered: members.delivered,
      read: members.read,
      failed: members.failed,
      replied: members.replied,
      optedOut: members.optedOut,
    });
    // Cancelled recipients are not cancelled messages.
    expect((await apiGetCampaign(deps(), ctx, weekend)).results).toEqual({
      audience: 4,
      pending: 0,
      skipped: 1,
      canceled: 3,
      queued: 0,
      inProgress: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      unknown: 0,
      messagesCanceled: 0,
      replied: 0,
      optedOut: 0,
      skipReasons: [{ reason: 'no_marketing_opt_in', count: 1 }],
      failureCodes: [],
    });
    // A draft has no results yet; another company's campaign and a bad id are not found.
    expect((await apiGetCampaign(deps(), ctx, draft)).results).toBeNull();
    expect((await refusal(apiGetCampaign(deps(), ctx, theirs))).code).toBe('not_found');
    expect((await refusal(apiGetCampaign(deps(), ctx, 'not-an-id'))).code).toBe('not_found');
    expect((await apiListCampaigns(deps(), ctx, {})).data.map((c) => c.id)).not.toContain(theirs);
  });

  it('refuses keys without the scope and bad filters, naming them', async () => {
    const c = await fx.company();
    const reader = await apiKey(c, ['contacts.read']);
    expect((await refusal(apiListCampaigns(deps(), reader, {}))).code).toBe('forbidden');
    expect((await refusal(apiGetCampaign(deps(), reader, uuidv7()))).code).toBe('forbidden');
    const ctx = await apiKey(c, ['campaigns.read']);
    for (const [query, path] of [
      [{ status: 'finished' }, 'status'],
      [{ limit: '0' }, 'limit'],
      [{ limit: '101' }, 'limit'],
      [{ name: 'Festive' }, ''],
    ] as const) {
      expect(await refusal(apiListCampaigns(deps(), ctx, query))).toEqual({
        code: 'validation_failed',
        paths: [path],
      });
    }
    expect((await refusal(apiListCampaigns(deps(), ctx, { cursor: 'nope' }))).code).toBe(
      'validation_failed',
    );
    expect((await apiListCampaigns(deps(), ctx, {})).data).toEqual([]);
  });
});
