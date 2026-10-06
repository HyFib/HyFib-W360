import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, sha256Hex, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, type TenantScope } from '@w360/db';
import {
  RECIPIENT_OUTCOMES,
  apiCancelCampaign,
  apiCreateCampaign,
  apiGetCampaign,
  apiListCampaignRecipients,
  apiListCampaigns,
  apiListMessages,
  apiPauseCampaign,
  apiResumeCampaign,
  apiReviewCampaign,
  apiSearchContacts,
  apiSubmitCampaign,
  apiUpdateCampaign,
  apiWithdrawCampaign,
  authenticateApiToken,
  campaignApprovalNotice,
  campaignReviewNotice,
  createApiKeysService,
  createCampaignsService,
  createConsentService,
  createContactsService,
  createSegmentsService,
  createTemplatesService,
  createWebhooksService,
  processSendIntent,
  outboxAad,
  processTemplateSubmit,
  runCampaignTick,
  syncTemplates,
  toApiCampaignReview,
  type ApiCampaignRecipient,
  type ApiContext,
  type ApiScope,
  type RecipientOutcome,
  type TemplateDefinition,
} from '@w360/domain';
import { acceptInvitation, createUser, invite } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Reading campaigns through the public API (ADR-125) against real PostgreSQL and the Graph
 * stand-in: the company's campaigns newest first with their counters, in one status or all, on
 * exact pages; one campaign with its results counted as members' campaign page counts them, from
 * the send pipeline, delivery statuses, a reply and a STOP, and a cancelled one's recipients; null
 * results for a draft; never another company's campaigns; refusals without the scope or with a bad
 * filter. Also finding contacts by what happened to a campaign's message to them, which needs
 * contacts.read and campaigns.read (ADR-126), listing a campaign's recipients with what
 * happened to each, by the results' own outcomes, erased contacts left out (ADR-127), and pausing
 * and cancelling campaigns as members do, the key named in the history and the audit (ADR-128),
 * resuming the campaigns keys paused, under their launcher's authority (ADR-176), creating and
 * editing drafts as members do, which members then submit and start (ADR-186), and reviewing them
 * as members' review reads them (ADR-193).
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
const writeDeps = () => ({ db: fx.dbs.app, clock: systemClock });
const submitDeps = () => ({ ...writeDeps(), campaignNotices: fx.notices() });

const promo: TemplateDefinition = {
  category: 'MARKETING',
  header: { type: 'none' },
  body: { text: 'Hello {{1}}, our festive sale starts today.', examples: ['Asha'] },
  footer: null,
  buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }],
};

/** A key of the company created by its owner, and the context a request with it gets. */
async function apiKey(
  c: Company,
  scopes: ApiScope[],
  name = 'Campaign results',
): Promise<ApiContext> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name,
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
  const serviceDeps = {
    db: fx.dbs.app,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock,
    notices: fx.notices(),
  };
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
    tick(id: string) {
      return runCampaignTick(
        { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock, sendRatePerSecond: 100 },
        scopeOf(c),
        id,
      );
    },
    erase(contactId: string) {
      return contactsService.eraseContact(owner, { contactId, suppress: false });
    },
    /**
     * Submits a draft and runs it to the end: queued, sent to the stand-in, completed. The call
     * sending the message to `dropFor` loses its connection, so that message's outcome is unknown.
     */
    async run(id: string, dropFor?: string) {
      await campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
      await this.tick(id);
      const intents = await fx.query<{ id: string; contact_id: string }>(
        `SELECT s.id, cv.contact_id FROM app.send_intents s
           JOIN app.messages m ON m.id = s.message_id
           JOIN app.conversations cv ON cv.id = m.conversation_id
          WHERE m.campaign_id = $1 AND s.state = 'queued' ORDER BY s.id`,
        [id],
      );
      for (const intent of intents) {
        if (intent.contact_id === dropFor) {
          fx.standIn.state.sendQueue.push({ kind: 'drop_connection' });
        }
        await processSendIntent(
          { ...workerDeps, rate: { capacity: 1000, refillPerSecond: 1000 } },
          scopeOf(c),
          intent.id,
        );
      }
      clock.advance(11_000);
      expect(await this.tick(id)).toMatchObject({ outcome: 'completed' });
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

describe('finding contacts by campaign outcome (ADR-126)', () => {
  it('finds the recipients by what happened to their message, with campaigns.read, as segments do', async () => {
    const s = await setup();
    // Created in this order, so pages list them newest first.
    const asha = await s.contact('+919820002001', 'Asha');
    const bina = await s.contact('+919820002002', 'Bina');
    const chitra = await s.contact('+919820002003', 'Chitra');
    await s.contact('+919820002004', 'Dev', false);
    const festive = await s.draft('Festive launch');
    await s.run(festive);
    const draft = await s.draft('Spring draft');
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
          { id: wamidOf(asha), status: 'delivered', timestamp: now, recipient_id: '919820002001' },
          { id: wamidOf(bina), status: 'read', timestamp: now, recipient_id: '919820002002' },
          {
            id: wamidOf(chitra),
            status: 'failed',
            timestamp: now,
            recipient_id: '919820002003',
            errors: [{ code: 131049, title: 'Not delivered to maintain healthy engagement.' }],
          },
        ],
      }),
    );
    await fx.deliver(
      fx.messagesBody(s.c, { messages: [{ waId: '919820002001', text: 'Interested!' }] }),
    );
    const other = await setup();
    await other.contact('+919820002005', 'Other');
    const theirs = await other.draft('Their campaign');

    const reader = await apiKey(s.c, ['contacts.read', 'campaigns.read']);
    const outcome = (campaignId: string, value: string) => ({
      type: 'campaign',
      campaignId,
      outcome: value,
    });
    const found = async (conditions: unknown[]) =>
      (await apiSearchContacts(deps(), reader, { conditions, limit: 100 })).data.map((c) => c.name);
    // Dev was skipped: no outcome finds him.
    expect(await found([outcome(festive, 'delivered')])).toEqual(['Bina', 'Asha']);
    expect(await found([outcome(festive, 'not_delivered')])).toEqual(['Chitra']);
    expect(await found([outcome(festive, 'read')])).toEqual(['Bina']);
    expect(await found([outcome(festive, 'replied')])).toEqual(['Asha']);
    expect(await found([outcome(festive, 'not_replied')])).toEqual(['Bina']);
    // A draft has no recipients yet.
    expect(await found([outcome(draft, 'delivered')])).toEqual([]);
    expect(await found([outcome(draft, 'not_delivered')])).toEqual([]);
    // The same contacts a segment with the same conditions counts.
    const segments = createSegmentsService({ db: fx.dbs.app, clock: systemClock });
    for (const value of ['delivered', 'not_delivered', 'read', 'replied', 'not_replied']) {
      const definition = { match: 'all', conditions: [outcome(festive, value)] };
      const preview = await segments.previewDefinition(s.owner, definition);
      expect((await found(definition.conditions)).length).toBe(preview.count);
    }
    // Another company's campaign is one the company does not have, named by its place.
    const unknown = await refusal(
      apiSearchContacts(deps(), reader, {
        conditions: [outcome(festive, 'delivered'), outcome(theirs, 'delivered')],
      }),
    );
    expect(unknown).toEqual({ code: 'validation_failed', paths: ['conditions.1.campaignId'] });
    // A key that reads contacts but not campaigns is refused, and so is one that reads only
    // campaigns.
    for (const scopes of [['contacts.read'], ['campaigns.read']] as const) {
      const key = await apiKey(s.c, [...scopes]);
      const r = await refusal(
        apiSearchContacts(deps(), key, { conditions: [outcome(festive, 'delivered')] }),
      );
      expect(r.code).toBe('forbidden');
    }
  });
});

describe('listing a campaign’s recipients (ADR-127)', () => {
  /** Every recipient the API lists for the campaign, `limit` at a time. */
  async function everyRecipient(
    ctx: ApiContext,
    campaignId: string,
    query: Record<string, string> = {},
    limit = 100,
  ): Promise<ApiCampaignRecipient[]> {
    const all: ApiCampaignRecipient[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 20; pages += 1) {
      const page = await apiListCampaignRecipients(deps(), ctx, campaignId, {
        ...query,
        limit: String(limit),
        ...(cursor ? { cursor } : {}),
      });
      expect(page.data.length).toBeLessThanOrEqual(limit);
      all.push(...page.data);
      cursor = page.nextCursor;
      if (!cursor) return all;
    }
    throw new Error('the pages never end');
  }

  const countOf = (outcome: RecipientOutcome) =>
    outcome === 'message_canceled'
      ? 'messagesCanceled'
      : outcome.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());

  /**
   * Each outcome lists as many recipients as its count in the campaign's results, less the
   * recipients of erased contacts it counts; returns the names each outcome lists.
   */
  async function outcomesAgainstResults(
    ctx: ApiContext,
    campaignId: string,
    erased: Partial<Record<RecipientOutcome, number>> = {},
  ) {
    const { results } = await apiGetCampaign(deps(), ctx, campaignId);
    const counts = results as unknown as Record<string, number>;
    const names: Partial<Record<RecipientOutcome, (string | null)[]>> = {};
    for (const outcome of RECIPIENT_OUTCOMES) {
      const listed = await everyRecipient(ctx, campaignId, { outcome });
      expect([outcome, listed.length]).toEqual([
        outcome,
        (counts[countOf(outcome)] ?? NaN) - (erased[outcome] ?? 0),
      ]);
      names[outcome] = listed.map((r) => r.contact.name).sort();
    }
    return names;
  }

  it('lists each recipient with what happened to it, each outcome as many as its count', async () => {
    const s = await setup();
    const asha = await s.contact('+919820003001', 'Asha');
    const bina = await s.contact('+919820003002', 'Bina');
    const chitra = await s.contact('+919820003003', 'Chitra');
    const dev = await s.contact('+919820003004', 'Dev', false);
    const esha = await s.contact('+919820003005', 'Esha');
    const farah = await s.contact('+919820003006', 'Farah');
    const gita = await s.contact('+919820003007', 'Gita');
    const festive = await s.draft('Festive launch');
    await s.run(festive, farah);
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
          { id: wamidOf(asha), status: 'delivered', timestamp: now, recipient_id: '919820003001' },
          { id: wamidOf(bina), status: 'read', timestamp: now, recipient_id: '919820003002' },
          {
            id: wamidOf(chitra),
            status: 'failed',
            timestamp: now,
            recipient_id: '919820003003',
            errors: [{ code: 131049, title: 'Not delivered to maintain healthy engagement.' }],
          },
          { id: wamidOf(esha), status: 'delivered', timestamp: now, recipient_id: '919820003005' },
          { id: wamidOf(gita), status: 'sent', timestamp: now, recipient_id: '919820003007' },
        ],
      }),
    );
    await fx.deliver(
      fx.messagesBody(s.c, { messages: [{ waId: '919820003001', text: 'Interested!' }] }),
    );
    await fx.deliver(fx.messagesBody(s.c, { messages: [{ waId: '919820003002', text: 'STOP' }] }));
    // Gita answers STOP before her message is reported delivered: counted for it, but the
    // results count replies and opt-outs of delivered messages only.
    await fx.deliver(fx.messagesBody(s.c, { messages: [{ waId: '919820003007', text: 'STOP' }] }));
    // Esha's message was delivered; then she was erased.
    await s.erase(esha);

    const reader = await apiKey(s.c, ['campaigns.read', 'contacts.read']);
    const listed = await everyRecipient(reader, festive);
    // The erased contact is left out; the others in a fixed order, by recipient id, as members'
    // recipients page lists them.
    const byContact = new Map(listed.map((r) => [r.contact.id, r]));
    expect([...byContact.keys()].sort()).toEqual([asha, bina, chitra, dev, farah, gita].sort());
    expect(listed.map((r) => r.id)).toEqual(listed.map((r) => r.id).sort());
    const members = await s.campaigns.listRecipients(s.owner, festive, {});
    expect(members.items.map((r) => r.contactId).sort()).toEqual(
      [asha, bina, chitra, dev, esha, farah, gita].sort(),
    );
    expect(listed.map((r) => r.id)).toEqual(
      members.items.filter((r) => r.contactId !== esha).map((r) => r.id),
    );
    // Pages of two: the same recipients, never skipped or repeated.
    const paged = await everyRecipient(reader, festive, {}, 2);
    expect(paged.map((r) => r.id)).toEqual(listed.map((r) => r.id));
    const first = await apiListCampaignRecipients(deps(), reader, festive, { limit: '2' });
    expect(first.nextCursor).toBe(first.data[1]!.id);

    // Each recipient as its message stands.
    const messageOf = async (contactId: string) =>
      (
        await fx.query<{
          id: string;
          status: string;
          status_at: Date;
          error_code: string | null;
          error_title: string | null;
        }>(
          `SELECT m.id, m.status, m.status_at, m.error_code, m.error_title FROM app.messages m
             JOIN app.conversations cv ON cv.id = m.conversation_id
            WHERE m.campaign_id = $1 AND cv.contact_id = $2`,
          [festive, contactId],
        )
      )[0]!;
    const message = async (contactId: string) => {
      const m = await messageOf(contactId);
      const error =
        m.error_code || m.error_title ? { code: m.error_code, title: m.error_title } : null;
      return { id: m.id, status: m.status, statusAt: new Date(m.status_at).toISOString(), error };
    };
    expect(byContact.get(asha)).toEqual({
      id: expect.any(String),
      contact: { id: asha, name: 'Asha', phone: '+919820003001' },
      state: 'queued',
      skipReason: null,
      message: { ...(await message(asha)), status: 'delivered', error: null },
      queuedAt: expect.any(String),
      repliedAt: expect.any(String),
      optedOutAt: null,
    });
    // A STOP is a reply and the opt-out it records.
    expect(byContact.get(bina)).toMatchObject({
      message: { ...(await message(bina)), status: 'read' },
      repliedAt: expect.any(String),
      optedOutAt: expect.any(String),
    });
    expect(byContact.get(chitra)).toMatchObject({
      state: 'queued',
      message: {
        ...(await message(chitra)),
        status: 'failed',
        error: { code: '131049', title: 'Not delivered to maintain healthy engagement.' },
      },
      repliedAt: null,
    });
    expect(byContact.get(dev)).toEqual({
      id: expect.any(String),
      contact: { id: dev, name: 'Dev', phone: '+919820003004' },
      state: 'skipped',
      skipReason: 'no_marketing_opt_in',
      message: null,
      queuedAt: null,
      repliedAt: null,
      optedOutAt: null,
    });
    expect(byContact.get(farah)).toMatchObject({
      message: { ...(await message(farah)), status: 'unknown_outcome' },
      repliedAt: null,
    });
    expect(byContact.get(gita)).toMatchObject({
      message: { ...(await message(gita)), status: 'sent' },
      repliedAt: expect.any(String),
      optedOutAt: expect.any(String),
    });
    for (const r of listed) {
      if (r.queuedAt) expect(r.queuedAt).toBe(new Date(r.queuedAt).toISOString());
    }
    // The message's status as the message feed reads it.
    const feedReader = await apiKey(s.c, ['conversations.read']);
    const feed = await apiListMessages(deps(), feedReader, { limit: 100 });
    const inFeed = feed.data.find((m) => m.id === byContact.get(chitra)!.message!.id);
    expect(inFeed).toMatchObject({
      status: 'failed',
      statusAt: byContact.get(chitra)!.message!.statusAt,
      error: byContact.get(chitra)!.message!.error,
    });

    // Each outcome: the recipients its count counts, Esha's delivered message counted but never
    // listed, and Gita's STOP in neither the replies nor the opt-outs.
    expect((await apiGetCampaign(deps(), reader, festive)).results).toMatchObject({
      queued: 6,
      sent: 4,
      delivered: 3,
      replied: 2,
      optedOut: 1,
    });
    const names = await outcomesAgainstResults(reader, festive, {
      queued: 1,
      sent: 1,
      delivered: 1,
    });
    expect(names).toEqual({
      pending: [],
      skipped: ['Dev'],
      canceled: [],
      queued: ['Asha', 'Bina', 'Chitra', 'Farah', 'Gita'],
      in_progress: [],
      sent: ['Asha', 'Bina', 'Gita'],
      delivered: ['Asha', 'Bina'],
      read: ['Bina'],
      failed: ['Chitra'],
      unknown: ['Farah'],
      message_canceled: [],
      replied: ['Asha', 'Bina'],
      opted_out: ['Bina'],
    });

    // Recipients waiting for their turn, cancelled before it, queued and not sent yet, and whose
    // queued message was cancelled: Bina and Gita opted out and Dev never opted in, so they are
    // skipped, and Esha, erased, is no longer in the audience.
    const waiting = await s.draft('Diwali teaser');
    await s.campaigns.submitCampaign(s.owner, waiting, { expectedVersion: 1 }, {});
    expect(await outcomesAgainstResults(reader, waiting)).toMatchObject({
      pending: ['Asha', 'Chitra', 'Farah'],
      skipped: ['Bina', 'Dev', 'Gita'],
      queued: [],
    });
    const weekend = await s.draft('Weekend offer');
    await s.campaigns.submitCampaign(s.owner, weekend, { expectedVersion: 1 }, {});
    await s.campaigns.cancelCampaign(s.owner, weekend, {});
    expect(await outcomesAgainstResults(reader, weekend)).toMatchObject({
      canceled: ['Asha', 'Chitra', 'Farah'],
      pending: [],
      message_canceled: [],
    });
    const monsoon = await s.draft('Monsoon preview');
    await s.campaigns.submitCampaign(s.owner, monsoon, { expectedVersion: 1 }, {});
    await s.tick(monsoon);
    expect(await outcomesAgainstResults(reader, monsoon)).toMatchObject({
      queued: ['Asha', 'Chitra', 'Farah'],
      in_progress: ['Asha', 'Chitra', 'Farah'],
      message_canceled: [],
    });
    const queued = await everyRecipient(reader, monsoon, { outcome: 'in_progress' });
    expect(queued.map((r) => r.message?.status)).toEqual(['queued', 'queued', 'queued']);
    // Cancelled before they were sent: the recipients are cancelled with their messages.
    await s.campaigns.cancelCampaign(s.owner, monsoon, {});
    expect(await outcomesAgainstResults(reader, monsoon)).toMatchObject({
      queued: [],
      in_progress: [],
      canceled: ['Asha', 'Chitra', 'Farah'],
      message_canceled: ['Asha', 'Chitra', 'Farah'],
    });
    expect((await everyRecipient(reader, monsoon, { outcome: 'canceled' }))[0]).toMatchObject({
      state: 'canceled',
      message: {
        status: 'canceled',
        error: { code: 'campaign_canceled', title: 'Not sent: the campaign was cancelled.' },
      },
    });

    // A draft has none; another company's campaign and a bad id are not found.
    const draft = await s.draft('Spring draft');
    expect(await apiListCampaignRecipients(deps(), reader, draft, {})).toEqual({
      data: [],
      nextCursor: null,
    });
    const other = await setup();
    await other.contact('+919820003008', 'Other');
    const theirs = await other.draft('Their campaign');
    await other.run(theirs);
    for (const id of [theirs, uuidv7(), 'not-an-id']) {
      expect((await refusal(apiListCampaignRecipients(deps(), reader, id, {}))).code).toBe(
        'not_found',
      );
    }
  });

  it('refuses keys without both scopes and bad parameters, naming them', async () => {
    const s = await setup();
    await s.contact('+919820004001', 'Asha');
    const festive = await s.draft('Festive launch');
    await s.campaigns.submitCampaign(s.owner, festive, { expectedVersion: 1 }, {});
    for (const scopes of [['campaigns.read'], ['contacts.read']] as const) {
      const key = await apiKey(s.c, [...scopes]);
      expect((await refusal(apiListCampaignRecipients(deps(), key, festive, {}))).code).toBe(
        'forbidden',
      );
    }
    const reader = await apiKey(s.c, ['campaigns.read', 'contacts.read']);
    for (const [query, path] of [
      [{ outcome: 'clicked' }, 'outcome'],
      [{ outcome: 'all' }, 'outcome'],
      [{ limit: '0' }, 'limit'],
      [{ limit: '101' }, 'limit'],
      [{ cursor: 'nope' }, 'cursor'],
      [{ state: 'queued' }, ''],
    ] as const) {
      expect(await refusal(apiListCampaignRecipients(deps(), reader, festive, query))).toEqual({
        code: 'validation_failed',
        paths: [path],
      });
    }
    expect((await apiListCampaignRecipients(deps(), reader, festive, {})).data).toHaveLength(1);
  });
});

describe('pausing and cancelling campaigns (ADR-128)', () => {
  /** The code and message of a refusal. */
  async function refused(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (!isAppError(error)) throw error;
      return { code: error.code, message: error.publicMessage };
    }
    throw new Error('expected a refusal');
  }
  const statusOf = async (campaignId: string) =>
    (
      await fx.query<{ status: string; pause_reason: string | null }>(
        `SELECT status, pause_reason FROM app.campaigns WHERE id = $1`,
        [campaignId],
      )
    )[0];
  const messagesOf = (campaignId: string) =>
    fx.query<{ status: string; error_code: string | null; error_title: string | null }>(
      `SELECT status, error_code, error_title FROM app.messages WHERE campaign_id = $1 ORDER BY id`,
      [campaignId],
    );
  const recipientStates = async (campaignId: string) =>
    (
      await fx.query<{ state: string }>(
        `SELECT state FROM app.campaign_recipients WHERE campaign_id = $1 AND state <> 'skipped'
          ORDER BY id`,
        [campaignId],
      )
    ).map((r) => r.state);
  const auditOf = (campaignId: string, action: string) =>
    fx.query<{
      actor_type: string;
      actor_id: string | null;
      metadata: Record<string, unknown>;
      correlation_id: string | null;
    }>(
      `SELECT actor_type, actor_id, metadata, correlation_id FROM app.audit_events
        WHERE subject_id = $1 AND action = $2 ORDER BY occurred_at, id`,
      [campaignId, action],
    );

  it('pauses a running campaign as a member does, names the key, and a member resumes it', async () => {
    const s = await setup();
    await s.contact('+919820005001', 'Asha');
    await s.contact('+919820005002', 'Bina');
    // An endpoint for campaign events, so their capture shows the reason.
    await createWebhooksService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egressPolicy: { allowLoopbackForTests: true },
    }).create(s.owner, {
      url: 'http://hooks.receiver.test:8080/campaigns',
      eventTypes: ['campaign.status_changed'],
      contactParts: null,
    });
    const flash = await s.draft('Flash sale');
    await s.campaigns.submitCampaign(s.owner, flash, { expectedVersion: 1 }, {});
    expect(await s.tick(flash)).toMatchObject({ outcome: 'progress' });
    expect(await messagesOf(flash)).toEqual([
      { status: 'queued', error_code: null, error_title: null },
      { status: 'queued', error_code: null, error_title: null },
    ]);

    const stopper = await apiKey(s.c, ['campaigns.stop'], 'Stock watcher');
    const paused = await apiPauseCampaign(writeDeps(), stopper, flash);
    expect(paused).toMatchObject({
      id: flash,
      name: 'Flash sale',
      status: 'paused',
      pauseReason: 'api',
      audienceCount: 2,
      queuedCount: 0,
    });
    expect(paused).not.toHaveProperty('results');
    // The answer is the campaign as GET /campaigns/{id} reads it, without the results, settings
    // and version that call adds (ADR-186).
    const reader = await apiKey(s.c, ['campaigns.read']);
    const {
      results: _results,
      settings: _settings,
      version: _version,
      ...read
    } = await apiGetCampaign(deps(), reader, flash);
    expect(paused).toEqual(read);
    // The queued messages were not sent, and their recipients wait for the resume.
    const notSent = { status: 'canceled', error_code: 'campaign_paused' };
    expect(await messagesOf(flash)).toEqual([
      { ...notSent, error_title: 'Not sent: the campaign was paused.' },
      { ...notSent, error_title: 'Not sent: the campaign was paused.' },
    ]);
    expect(await recipientStates(flash)).toEqual(['pending', 'pending']);
    // Members' history names the key; the audit row is the key's, with the request's id.
    const view = await s.campaigns.getCampaign(s.owner, flash);
    expect(view.events[0]).toMatchObject({
      type: 'paused',
      actorName: null,
      apiKeyName: 'Stock watcher',
      detail: { reason: 'api', released: 2, apiKeyId: stopper.key.id },
    });
    expect(view.events.filter((e) => e.apiKeyName !== null)).toHaveLength(1);
    // A key is no member: the event names no member.
    expect(
      await fx.query(
        `SELECT actor_user_id FROM app.campaign_events WHERE campaign_id = $1 AND type = 'paused'`,
        [flash],
      ),
    ).toEqual([{ actor_user_id: null }]);
    expect(await auditOf(flash, 'campaign.paused')).toEqual([
      {
        actor_type: 'api_key',
        actor_id: stopper.key.id,
        metadata: { reason: 'api', released: 2, source: 'api' },
        correlation_id: stopper.requestId,
      },
    ]);
    // campaign.status_changed reports the pause with its reason.
    const changes = await fx.query<{ status: string; previous: string; reason: string | null }>(
      `SELECT status, detail->>'previousStatus' AS previous, detail->>'pauseReason' AS reason
         FROM app.webhook_events
        WHERE type = 'campaign.status_changed' AND detail->>'campaignId' = $1
        ORDER BY occurred_at, id`,
      [flash],
    );
    expect(changes.at(-1)).toEqual({ status: 'paused', previous: 'running', reason: 'api' });

    // A retry is answered as it is, and changes nothing.
    expect(await apiPauseCampaign(writeDeps(), stopper, flash)).toEqual(paused);
    const pauses = (await s.campaigns.getCampaign(s.owner, flash)).events.filter(
      (e) => e.type === 'paused',
    );
    expect(pauses).toHaveLength(1);
    expect(await auditOf(flash, 'campaign.paused')).toHaveLength(1);

    // A member resumes it as any paused campaign, and it queues its messages again.
    await s.campaigns.resumeCampaign(s.owner, flash, {});
    expect(await statusOf(flash)).toEqual({ status: 'running', pause_reason: null });
    expect(await s.tick(flash)).toMatchObject({ outcome: 'progress' });
    expect((await messagesOf(flash)).map((m) => m.status).sort()).toEqual([
      'canceled',
      'canceled',
      'queued',
      'queued',
    ]);
    expect(await recipientStates(flash)).toEqual(['queued', 'queued']);
  });

  it('pauses only scheduled and running campaigns, and cancels any that has not finished', async () => {
    const s = await setup();
    await s.contact('+919820006001', 'Asha');
    await s.contact('+919820006002', 'Bina');
    const stopper = await apiKey(s.c, ['campaigns.stop'], 'Stock watcher');
    const pause = (id: string) => apiPauseCampaign(writeDeps(), stopper, id);
    const cancel = (id: string) => apiCancelCampaign(writeDeps(), stopper, id);

    // A draft sends nothing: both are refused, naming its status, and it stays a draft.
    const { id: draft } = await s.campaigns.createDraft(s.owner, { name: 'Spring draft' }, {});
    expect(await refused(pause(draft))).toEqual({
      code: 'conflict',
      message:
        "Only a scheduled or running campaign can be paused. This campaign's status is draft.",
    });
    expect(await refused(cancel(draft))).toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('members edit or cancel drafts in the app.'),
    });
    expect(await statusOf(draft)).toEqual({ status: 'draft', pause_reason: null });

    // Waiting for approval: it is not paused, but it is cancelled with its recipients.
    const approval = { cap: null, costCurrency: null };
    await s.campaigns.updateSettings(s.owner, { approvalRequired: true, ...approval }, {});
    const waiting = await s.draft('Needs approval');
    await s.campaigns.submitCampaign(s.owner, waiting, { expectedVersion: 1 }, {});
    await s.campaigns.updateSettings(s.owner, { approvalRequired: false, ...approval }, {});
    expect(await refused(pause(waiting))).toMatchObject({
      code: 'conflict',
      message: expect.stringContaining("This campaign's status is pending_approval."),
    });
    expect(await cancel(waiting)).toMatchObject({ status: 'canceled', pauseReason: null });
    expect(await recipientStates(waiting)).toEqual(['canceled', 'canceled']);

    // Scheduled: paused before it starts (nothing queued to release), then cancelled while paused.
    const scheduled = await s.draft('Weekend offer');
    await s.campaigns.submitCampaign(s.owner, scheduled, { expectedVersion: 1 }, {});
    expect(await statusOf(scheduled)).toEqual({ status: 'scheduled', pause_reason: null });
    expect(await pause(scheduled)).toMatchObject({ status: 'paused', pauseReason: 'api' });
    expect(await recipientStates(scheduled)).toEqual(['pending', 'pending']);
    const canceled = await cancel(scheduled);
    // The pause's reason is given while the campaign is paused only.
    expect(canceled).toMatchObject({ status: 'canceled', pauseReason: null });
    expect(canceled.canceledAt).not.toBeNull();
    expect(await recipientStates(scheduled)).toEqual(['canceled', 'canceled']);
    // Cancelled: answered as it is, and not paused.
    expect(await cancel(scheduled)).toEqual(canceled);
    expect(await refused(pause(scheduled))).toMatchObject({
      code: 'conflict',
      message: expect.stringContaining("This campaign's status is canceled."),
    });
    const history = (await s.campaigns.getCampaign(s.owner, scheduled)).events;
    expect(history.filter((e) => e.type === 'canceled')).toHaveLength(1);

    // Running, with messages queued and not sent: cancelled with them.
    const running = await s.draft('Flash sale');
    await s.campaigns.submitCampaign(s.owner, running, { expectedVersion: 1 }, {});
    expect(await s.tick(running)).toMatchObject({ outcome: 'progress' });
    expect(await cancel(running)).toMatchObject({ status: 'canceled', queuedCount: 0 });
    expect((await messagesOf(running)).map((m) => [m.status, m.error_code])).toEqual([
      ['canceled', 'campaign_canceled'],
      ['canceled', 'campaign_canceled'],
    ]);
    expect(await recipientStates(running)).toEqual(['canceled', 'canceled']);
    const [row] = await fx.query<{ canceled_by_user_id: string | null }>(
      `SELECT canceled_by_user_id FROM app.campaigns WHERE id = $1`,
      [running],
    );
    expect(row).toEqual({ canceled_by_user_id: null });
    expect((await s.campaigns.getCampaign(s.owner, running)).events[0]).toMatchObject({
      type: 'canceled',
      actorName: null,
      apiKeyName: 'Stock watcher',
      detail: { canceledRecipients: 0, releasedSends: 2, apiKeyId: stopper.key.id },
    });
    expect(await auditOf(running, 'campaign.canceled')).toEqual([
      {
        actor_type: 'api_key',
        actor_id: stopper.key.id,
        metadata: { canceledRecipients: 0, releasedSends: 2, source: 'api' },
        correlation_id: stopper.requestId,
      },
    ]);

    // Completed: answered as it is, and not paused.
    const done = await s.draft('Festive launch');
    await s.run(done);
    const reader = await apiKey(s.c, ['campaigns.read']);
    const {
      results: _results,
      settings: _settings,
      version: _version,
      ...completed
    } = await apiGetCampaign(deps(), reader, done);
    expect(completed.status).toBe('completed');
    expect(await cancel(done)).toEqual(completed);
    expect(await refused(pause(done))).toMatchObject({
      code: 'conflict',
      message: expect.stringContaining("This campaign's status is completed."),
    });
    expect(await auditOf(done, 'campaign.canceled')).toEqual([]);

    // Another company's campaign and a bad id are not found, and nothing changes.
    const other = await setup();
    await other.contact('+919820006003', 'Other');
    const theirs = await other.draft('Their campaign');
    await other.campaigns.submitCampaign(other.owner, theirs, { expectedVersion: 1 }, {});
    for (const id of [theirs, uuidv7(), 'not-an-id']) {
      expect((await refused(pause(id))).code).toBe('not_found');
      expect((await refused(cancel(id))).code).toBe('not_found');
    }
    expect(await statusOf(theirs)).toEqual({ status: 'scheduled', pause_reason: null });
  });

  it('refuses a key without the scope, and a company that cannot send, changing nothing', async () => {
    const s = await setup();
    await s.contact('+919820007001', 'Asha');
    const flash = await s.draft('Flash sale');
    await s.campaigns.submitCampaign(s.owner, flash, { expectedVersion: 1 }, {});
    const reader = await apiKey(s.c, ['campaigns.read', 'contacts.read']);
    expect((await refused(apiPauseCampaign(writeDeps(), reader, flash))).code).toBe('forbidden');
    expect((await refused(apiCancelCampaign(writeDeps(), reader, flash))).code).toBe('forbidden');
    // Suspended or restricted: the scope writes, so nothing is read or changed.
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const { token } = await keys.create(s.owner, {
      name: 'Stock watcher',
      scopes: ['campaigns.stop'],
      expiresInDays: 0,
    });
    try {
      for (const status of ['suspended', 'restricted'] as const) {
        await fx.query(`UPDATE app.tenants SET status = $2 WHERE id = $1`, [s.c.tenant.id, status]);
        const blocked = await authenticateApiToken(fx.dbs.app, token, uuidv7());
        if (!blocked) throw new Error('the key no longer authenticates');
        expect((await refused(apiPauseCampaign(writeDeps(), blocked, flash))).code).toBe(
          'tenant_suspended',
        );
        expect((await refused(apiCancelCampaign(writeDeps(), blocked, flash))).code).toBe(
          'tenant_suspended',
        );
      }
    } finally {
      await fx.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [s.c.tenant.id]);
    }
    expect(await statusOf(flash)).toEqual({ status: 'scheduled', pause_reason: null });
    expect(await auditOf(flash, 'campaign.paused')).toEqual([]);
    expect(await auditOf(flash, 'campaign.canceled')).toEqual([]);
  });
});

describe('resuming campaigns keys paused (ADR-176)', () => {
  /** The code and message of a refusal. */
  async function refused(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (!isAppError(error)) throw error;
      return { code: error.code, message: error.publicMessage };
    }
    throw new Error('expected a refusal');
  }
  const outbound = () => ({
    db: fx.dbs.app,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
  });
  const statusOf = async (campaignId: string) =>
    (
      await fx.query<{ status: string; pause_reason: string | null }>(
        `SELECT status, pause_reason FROM app.campaigns WHERE id = $1`,
        [campaignId],
      )
    )[0];
  const auditOf = (campaignId: string, action: string) =>
    fx.query<{
      actor_type: string;
      actor_id: string | null;
      metadata: Record<string, unknown>;
      correlation_id: string | null;
    }>(
      `SELECT actor_type, actor_id, metadata, correlation_id FROM app.audit_events
        WHERE subject_id = $1 AND action = $2 ORDER BY occurred_at, id`,
      [campaignId, action],
    );

  it("resumes a campaign a key paused under its launcher's authority, names the key, and the runner queues its recipients again", async () => {
    const s = await setup();
    await s.contact('+919820008001', 'Asha');
    await s.contact('+919820008002', 'Bina');
    await createWebhooksService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egressPolicy: { allowLoopbackForTests: true },
    }).create(s.owner, {
      url: 'http://hooks.receiver.test:8080/campaigns',
      eventTypes: ['campaign.status_changed'],
      contactParts: null,
    });
    const flash = await s.draft('Flash sale');
    await s.campaigns.submitCampaign(s.owner, flash, { expectedVersion: 1 }, {});
    expect(await s.tick(flash)).toMatchObject({ outcome: 'progress' });
    const stopper = await apiKey(s.c, ['campaigns.stop'], 'Stock watcher');
    expect(await apiPauseCampaign(writeDeps(), stopper, flash)).toMatchObject({
      status: 'paused',
      pauseReason: 'api',
    });

    const resumer = await apiKey(s.c, ['campaigns.resume'], 'Restock watcher');
    const resumed = await apiResumeCampaign(outbound(), resumer, flash);
    expect(resumed).toMatchObject({ id: flash, status: 'running', pauseReason: null });
    expect(resumed).not.toHaveProperty('results');
    // The answer is the campaign as GET /campaigns/{id} reads it, without the results, settings
    // and version that call adds (ADR-186).
    const reader = await apiKey(s.c, ['campaigns.read']);
    const {
      results: _results,
      settings: _settings,
      version: _version,
      ...read
    } = await apiGetCampaign(deps(), reader, flash);
    expect(resumed).toEqual(read);
    // It sends under the authority of the member who launched it, as before the pause.
    expect(
      await fx.query(`SELECT launched_by_user_id, paused_at FROM app.campaigns WHERE id = $1`, [
        flash,
      ]),
    ).toEqual([{ launched_by_user_id: s.c.owner.id, paused_at: null }]);
    // Members' history names the key, the event names no member, and the audit row is the key's.
    const view = await s.campaigns.getCampaign(s.owner, flash);
    expect(view.events[0]).toMatchObject({
      type: 'resumed',
      actorName: null,
      apiKeyName: 'Restock watcher',
      detail: { apiKeyId: resumer.key.id },
    });
    expect(
      await fx.query(
        `SELECT actor_user_id FROM app.campaign_events WHERE campaign_id = $1 AND type = 'resumed'`,
        [flash],
      ),
    ).toEqual([{ actor_user_id: null }]);
    expect(await auditOf(flash, 'campaign.resumed')).toEqual([
      {
        actor_type: 'api_key',
        actor_id: resumer.key.id,
        metadata: { source: 'api' },
        correlation_id: resumer.requestId,
      },
    ]);
    // campaign.status_changed reports it.
    const changes = await fx.query<{ status: string; previous: string; reason: string | null }>(
      `SELECT status, detail->>'previousStatus' AS previous, detail->>'pauseReason' AS reason
         FROM app.webhook_events
        WHERE type = 'campaign.status_changed' AND detail->>'campaignId' = $1
        ORDER BY occurred_at, id`,
      [flash],
    );
    expect(changes.at(-1)).toEqual({ status: 'running', previous: 'paused', reason: null });

    // A retry is answered as it is, and changes nothing.
    expect(await apiResumeCampaign(outbound(), resumer, flash)).toEqual(resumed);
    const resumes = (await s.campaigns.getCampaign(s.owner, flash)).events.filter(
      (e) => e.type === 'resumed',
    );
    expect(resumes).toHaveLength(1);
    expect(await auditOf(flash, 'campaign.resumed')).toHaveLength(1);

    // The runner queues again the recipients that waited since the pause.
    expect(await s.tick(flash)).toMatchObject({ outcome: 'progress' });
    const statuses = await fx.query<{ status: string }>(
      `SELECT status FROM app.messages WHERE campaign_id = $1 ORDER BY id`,
      [flash],
    );
    expect(statuses.map((m) => m.status).sort()).toEqual([
      'canceled',
      'canceled',
      'queued',
      'queued',
    ]);
  });

  it("lifts only a key's pause, after members' checks and while its launcher may send, and refuses the rest naming why, changing nothing", async () => {
    const s = await setup();
    await s.contact('+919820009001', 'Asha');
    await s.contact('+919820009002', 'Bina');
    const stopper = await apiKey(s.c, ['campaigns.stop'], 'Stock watcher');
    const resumer = await apiKey(s.c, ['campaigns.resume'], 'Restock watcher');
    const resume = (id: string) => apiResumeCampaign(outbound(), resumer, id);

    // Stopping is not resuming.
    const flash = await s.draft('Flash sale');
    await s.campaigns.submitCampaign(s.owner, flash, { expectedVersion: 1 }, {});
    expect(await s.tick(flash)).toMatchObject({ outcome: 'progress' });
    await apiPauseCampaign(writeDeps(), stopper, flash);
    expect((await refused(apiResumeCampaign(outbound(), stopper, flash))).code).toBe('forbidden');

    // A member's pause stays the members': refused, naming the reason, and it stays paused.
    await s.campaigns.resumeCampaign(s.owner, flash, {});
    await s.campaigns.pauseCampaign(s.owner, flash, {});
    expect(await refused(resume(flash))).toEqual({
      code: 'conflict',
      message:
        "Only a campaign a key paused is resumed through the API: members resume this one in the app. This campaign's pauseReason is manual.",
    });
    expect(await statusOf(flash)).toEqual({ status: 'paused', pause_reason: 'manual' });

    // A template Meta no longer approves is refused as members are, and the key's pause stays.
    await s.campaigns.resumeCampaign(s.owner, flash, {});
    await apiPauseCampaign(writeDeps(), stopper, flash);
    await fx.query(`UPDATE app.message_templates SET status = 'paused' WHERE id = $1`, [
      s.templateId,
    ]);
    expect(await refused(resume(flash))).toEqual({
      code: 'precondition_failed',
      message: 'The template is not approved by Meta.',
    });
    expect(await statusOf(flash)).toEqual({ status: 'paused', pause_reason: 'api' });
    await fx.query(`UPDATE app.message_templates SET status = 'approved' WHERE id = $1`, [
      s.templateId,
    ]);

    // A launcher who can no longer send campaigns leaves the resume to a member who can.
    const offer = await s.draft('Weekend offer');
    await s.campaigns.submitCampaign(
      await fx.ctx(s.c, s.c.marketer),
      offer,
      { expectedVersion: 1 },
      {},
    );
    expect(await apiPauseCampaign(writeDeps(), stopper, offer)).toMatchObject({
      status: 'paused',
      pauseReason: 'api',
    });
    const setRoles = (roles: string) =>
      fx.query(
        `UPDATE app.memberships SET roles = ARRAY[$3]::text[] WHERE tenant_id = $1 AND user_id = $2`,
        [s.c.tenant.id, s.c.marketer.id, roles],
      );
    await setRoles('agent');
    expect(await refused(resume(offer))).toEqual({
      code: 'precondition_failed',
      message:
        'The member who launched this campaign can no longer send campaigns, so it is not resumed through the API: a member who can resumes it in the app.',
    });
    expect(await statusOf(offer)).toEqual({ status: 'paused', pause_reason: 'api' });
    // Once they may again, it resumes; paused before it started, it is scheduled again, under the
    // same launcher, and a retry changes nothing.
    await setRoles('marketer');
    expect(await resume(offer)).toMatchObject({ status: 'scheduled', pauseReason: null });
    expect(await resume(offer)).toMatchObject({ status: 'scheduled', pauseReason: null });
    expect(
      await fx.query(`SELECT launched_by_user_id FROM app.campaigns WHERE id = $1`, [offer]),
    ).toEqual([{ launched_by_user_id: s.c.marketer.id }]);
    expect(await auditOf(offer, 'campaign.resumed')).toHaveLength(1);

    // A draft and a cancelled campaign are refused, naming the status.
    const { id: draft } = await s.campaigns.createDraft(s.owner, { name: 'Spring draft' }, {});
    expect(await refused(resume(draft))).toEqual({
      code: 'conflict',
      message: "Only a paused campaign can be resumed. This campaign's status is draft.",
    });
    await apiCancelCampaign(writeDeps(), stopper, offer);
    expect(await refused(resume(offer))).toEqual({
      code: 'conflict',
      message: "Only a paused campaign can be resumed. This campaign's status is canceled.",
    });

    // Another company's campaign and a bad id are not found, and nothing changes.
    const other = await setup();
    await other.contact('+919820009003', 'Other');
    const theirs = await other.draft('Their campaign');
    await other.campaigns.submitCampaign(other.owner, theirs, { expectedVersion: 1 }, {});
    await apiPauseCampaign(writeDeps(), await apiKey(other.c, ['campaigns.stop']), theirs);
    for (const id of [theirs, uuidv7(), 'not-an-id']) {
      expect((await refused(resume(id))).code).toBe('not_found');
    }
    expect(await statusOf(theirs)).toEqual({ status: 'paused', pause_reason: 'api' });
    // Only members resumed the first campaign.
    expect((await auditOf(flash, 'campaign.resumed')).map((a) => a.actor_type)).toEqual([
      'user',
      'user',
    ]);
  });
});

describe('campaign drafts through the API (ADR-186)', () => {
  const idem = (key: string, request: string) => ({ key, requestHash: sha256Hex(request) });
  /** The code and message of a refusal. */
  async function refused(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (!isAppError(error)) throw error;
      return { code: error.code, message: error.message };
    }
    throw new Error('expected a refusal');
  }
  const eventsOf = (campaignId: string) =>
    fx.query<{ type: string; actor_user_id: string | null; api_key_id: string | null }>(
      `SELECT type, actor_user_id, detail->>'apiKeyId' AS api_key_id FROM app.campaign_events
        WHERE campaign_id = $1 ORDER BY occurred_at, id`,
      [campaignId],
    );
  const auditOf = (campaignId: string, action: string) =>
    fx.query<{ actor_type: string; actor_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT actor_type, actor_id, metadata FROM app.audit_events
        WHERE subject_id = $1 AND action = $2 ORDER BY occurred_at, id`,
      [campaignId, action],
    );
  const newDraft = {
    variables: { header: [], body: [] },
    audience: null,
    schedule: { kind: 'now', local: null, timezone: 'Asia/Kolkata' },
    window: null,
    ratePerMinute: null,
    maxMessages: null,
    budget: null,
    stopAfterHours: 24,
  };

  it("create drafts with their settings once per Idempotency-Key, checked as members' drafts are, naming the key; members submit and start them", async () => {
    const s = await setup();
    await s.contact('+919820006001', 'Asha');
    const writer = await apiKey(s.c, ['campaigns.write', 'campaigns.read'], 'Campaign drafts');
    const reader = await apiKey(s.c, ['campaigns.read']);

    // A name alone starts as a member's new draft does, in the company's time zone.
    const bare = await apiCreateCampaign(writeDeps(), writer, { name: 'Weekend sale' }, null);
    expect(bare.status).toBe(201);
    const bareDraft = (bare.body as { data: Record<string, unknown> }).data;
    expect(bareDraft).toMatchObject({
      name: 'Weekend sale',
      status: 'draft',
      templateId: null,
      channel: null,
      results: null,
      version: 1,
      settings: newDraft,
    });

    // Every setting at once, as given; one draft per Idempotency-Key.
    const full = {
      name: 'Diwali offer',
      channelId: s.c.channelAccountId,
      templateId: s.templateId,
      variables: { body: [{ source: 'name', fallback: 'there' }] },
      audience: { conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
      schedule: { kind: 'later', local: '2030-11-01T09:00', timezone: 'Europe/London' },
      window: { start: '09:00', end: '20:00' },
      ratePerMinute: 100,
      maxMessages: 5000,
      budget: { amount: '2500.50', currency: 'INR' },
      stopAfterHours: 48,
    };
    const key = idem('diwali-1', JSON.stringify(full));
    const created = await apiCreateCampaign(writeDeps(), writer, full, key);
    const draft = (created.body as { data: { id: string } & Record<string, unknown> }).data;
    expect(draft).toMatchObject({
      name: 'Diwali offer',
      status: 'draft',
      templateId: s.templateId,
      templateName: 'festive_sale',
      channel: { id: s.c.channelAccountId },
      version: 1,
      settings: {
        variables: { header: [], body: [{ source: 'name', fallback: 'there' }] },
        audience: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
        schedule: { kind: 'later', local: '2030-11-01T09:00', timezone: 'Europe/London' },
        window: { start: '09:00', end: '20:00' },
        ratePerMinute: 100,
        maxMessages: 5000,
        budget: { amount: '2500.5', currency: 'INR' },
        stopAfterHours: 48,
      },
    });
    const replay = await apiCreateCampaign(writeDeps(), writer, full, key);
    expect(replay.replayed).toBe(true);
    expect((replay.body as { data: { id: string } }).data.id).toBe(draft.id);
    expect(
      await fx.query(`SELECT count(*)::int AS n FROM app.campaigns WHERE tenant_id = $1`, [
        s.c.tenant.id,
      ]),
    ).toEqual([{ n: 2 }]);
    // GET answers the settings to a key that edits drafts, and counts alone to a key that reads.
    expect(await apiGetCampaign(deps(), writer, draft.id)).toMatchObject({
      version: 1,
      settings: { maxMessages: 5000 },
    });
    expect(await apiGetCampaign(deps(), reader, draft.id)).toMatchObject({
      id: draft.id,
      version: null,
      settings: null,
    });

    // Members' checks: the company's number, template and segment, segments' rules, the time
    // zone, the window and the date; nothing is created by a refusal.
    const other = await setup();
    const archived = await createSegmentsService({
      db: fx.dbs.app,
      clock: systemClock,
    }).createSegment(
      s.owner,
      {
        name: 'Old buyers',
        definition: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'old' }] },
      },
      {},
    );
    await fx.query(`UPDATE app.segments SET archived_at = now() WHERE id = $1`, [archived.id]);
    for (const [body, expected] of [
      [{ channelId: other.c.channelAccountId }, { code: 'not_found' }],
      [{ templateId: other.templateId }, { code: 'not_found' }],
      [{ audience: { segmentId: archived.id } }, { code: 'not_found' }],
      [
        { audience: { conditions: [{ type: 'field', key: 'tier', op: 'equals', value: 'gold' }] } },
        { code: 'validation_failed' },
      ],
      [
        { schedule: { kind: 'now', timezone: 'Mars/Olympus' } },
        { code: 'validation_failed', message: 'Choose a valid time zone.' },
      ],
      [
        { window: { start: '09:00', end: '09:00' } },
        {
          code: 'validation_failed',
          message: 'Enter a sending window with different start and end times.',
        },
      ],
      [
        { schedule: { kind: 'later', local: '2030-02-30T09:00' } },
        { code: 'validation_failed', message: 'Enter a valid date and time.' },
      ],
    ] as const) {
      expect(
        await refused(apiCreateCampaign(writeDeps(), writer, { name: 'Refused', ...body }, null)),
        JSON.stringify(body),
      ).toMatchObject(expected);
    }
    expect(
      await fx.query(`SELECT count(*)::int AS n FROM app.campaigns WHERE name = 'Refused'`),
    ).toEqual([{ n: 0 }]);

    // The key, not a member, created it: named in the history and the audit.
    expect(
      await fx.query(`SELECT created_by_user_id FROM app.campaigns WHERE id = $1`, [draft.id]),
    ).toEqual([{ created_by_user_id: null }]);
    expect(await eventsOf(draft.id)).toEqual([
      { type: 'created', actor_user_id: null, api_key_id: writer.key.id },
    ]);
    expect(await auditOf(draft.id, 'campaign.created')).toEqual([
      { actor_type: 'api_key', actor_id: writer.key.id, metadata: { source: 'api' } },
    ]);
    const view = await s.campaigns.getCampaign(s.owner, draft.id);
    expect(view.events.map((e) => [e.type, e.actorName, e.apiKeyName])).toEqual([
      ['created', null, 'Campaign drafts'],
    ]);

    // A member submits the draft the key wrote and starts it, under their own authority (the key
    // first sends it at once, at any time and without a spending cap, which needs a rate card).
    const sendNow = await apiUpdateCampaign(deps(), writer, draft.id, {
      schedule: { kind: 'now' },
      window: null,
      budget: null,
    });
    expect(sendNow.settings).toMatchObject({
      schedule: { kind: 'now', local: null, timezone: 'Europe/London' },
      window: null,
      budget: null,
      maxMessages: 5000,
    });
    await s.campaigns.submitCampaign(s.owner, draft.id, { expectedVersion: sendNow.version! }, {});
    expect(await s.tick(draft.id)).toMatchObject({ outcome: 'progress', queued: 1 });
    expect(
      await fx.query(`SELECT status, launched_by_user_id FROM app.campaigns WHERE id = $1`, [
        draft.id,
      ]),
    ).toEqual([{ status: 'running', launched_by_user_id: s.c.owner.id }]);
  });

  it('edit drafts, keeping what is left out, refusing a changed version, a campaign that is no longer a draft and another company’s', async () => {
    const s = await setup();
    const writer = await apiKey(s.c, ['campaigns.write', 'campaigns.read'], 'Campaign drafts');
    const created = await apiCreateCampaign(
      writeDeps(),
      writer,
      {
        name: 'Spring sale',
        channelId: s.c.channelAccountId,
        templateId: s.templateId,
        variables: { body: [{ source: 'name', fallback: 'there' }] },
        audience: { conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
        maxMessages: 1000,
      },
      null,
    );
    const id = (created.body as { data: { id: string } }).data.id;

    // What is left out stays; null clears; the version goes up with each change.
    const capped = await apiUpdateCampaign(deps(), writer, id, {
      maxMessages: 100,
      ratePerMinute: 30,
    });
    expect(capped).toMatchObject({
      name: 'Spring sale',
      templateId: s.templateId,
      version: 2,
      settings: {
        audience: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
        maxMessages: 100,
        ratePerMinute: 30,
      },
    });
    const uncapped = await apiUpdateCampaign(deps(), writer, id, {
      expectedVersion: 2,
      maxMessages: null,
      name: 'Spring sale, final',
    });
    expect(uncapped).toMatchObject({
      name: 'Spring sale, final',
      version: 3,
      settings: { maxMessages: null, ratePerMinute: 30 },
    });

    // A member's edit changes the version: the key's change with the old one is refused and
    // changes nothing; without a version it applies to the draft as it is.
    await s.campaigns.updateDraft(
      s.owner,
      id,
      {
        expectedVersion: 3,
        name: 'Spring sale, by a member',
        channelAccountId: s.c.channelAccountId,
        templateId: s.templateId,
        variables: { header: [], body: [{ source: 'name', fallback: 'there' }] },
        audience: { kind: 'none' },
        schedule: { kind: 'now', timezone: 'Asia/Kolkata' },
        window: null,
        ratePerMinute: null,
        maxMessages: null,
        budget: null,
        stopAfterHours: 24,
      },
      {},
    );
    expect(
      await refused(apiUpdateCampaign(deps(), writer, id, { expectedVersion: 3, maxMessages: 10 })),
    ).toEqual({
      code: 'conflict',
      message:
        'This draft has changed since you read it: its version is 4. Read it again and give the version it has.',
    });
    expect(await apiUpdateCampaign(deps(), writer, id, { maxMessages: 10 })).toMatchObject({
      name: 'Spring sale, by a member',
      version: 5,
      settings: { audience: null, maxMessages: 10 },
    });
    // Each of the key's changes is in the history and the audit; the member's is the member's.
    expect((await eventsOf(id)).map((e) => [e.type, e.actor_user_id, e.api_key_id])).toEqual([
      ['created', null, writer.key.id],
      ['edited', null, writer.key.id],
      ['edited', null, writer.key.id],
      ['edited', s.c.owner.id, null],
      ['edited', null, writer.key.id],
    ]);
    expect((await auditOf(id, 'campaign.updated')).map((a) => a.actor_type)).toEqual([
      'api_key',
      'api_key',
      'user',
      'api_key',
    ]);

    // Once a member submits it, it is no longer a draft.
    await apiUpdateCampaign(deps(), writer, id, {
      audience: { conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
    });
    await s.contact('+919820006002', 'Bina');
    const { version } = (await s.campaigns.getCampaign(s.owner, id)).campaign;
    await s.campaigns.submitCampaign(s.owner, id, { expectedVersion: version }, {});
    expect(await refused(apiUpdateCampaign(deps(), writer, id, { maxMessages: 1 }))).toEqual({
      code: 'conflict',
      message: "Only draft campaigns can be edited. This campaign's status is scheduled.",
    });

    // Another company's draft and a bad id are not found; a key without the scope is refused.
    const other = await setup();
    const theirs = await other.draft('Their draft');
    for (const target of [theirs, uuidv7(), 'not-an-id']) {
      expect(
        (await refused(apiUpdateCampaign(deps(), writer, target, { maxMessages: 1 }))).code,
      ).toBe('not_found');
    }
    expect(
      (
        await refused(
          apiUpdateCampaign(deps(), await apiKey(s.c, ['campaigns.stop']), id, { maxMessages: 1 }),
        )
      ).code,
    ).toBe('forbidden');
    expect(
      await fx.query(`SELECT max_messages FROM app.campaigns WHERE id = $1`, [theirs]),
    ).toEqual([{ max_messages: null }]);
  });

  it('cancel a draft with a key that writes drafts, naming the key, and nothing else; a stopping key still cancels the rest (ADR-187)', async () => {
    const s = await setup();
    await s.contact('+919820007001', 'Asha');
    const writer = await apiKey(s.c, ['campaigns.write'], 'Campaign drafts');
    const stopper = await apiKey(s.c, ['campaigns.stop'], 'Stock watcher');
    // The key's own draft and a member's are cancelled alike; a retry answers each as it is.
    const created = await apiCreateCampaign(writeDeps(), writer, { name: 'Mistake' }, null);
    const mistake = (created.body as { data: { id: string } }).data.id;
    const membersDraft = await s.draft('Members draft');
    for (const id of [mistake, membersDraft]) {
      for (let i = 0; i < 2; i += 1) {
        expect(await apiCancelCampaign(writeDeps(), writer, id)).toMatchObject({
          id,
          status: 'canceled',
        });
      }
    }
    expect((await eventsOf(mistake)).map((e) => [e.type, e.actor_user_id, e.api_key_id])).toEqual([
      ['created', null, writer.key.id],
      ['canceled', null, writer.key.id],
    ]);
    expect(await auditOf(mistake, 'campaign.canceled')).toEqual([
      {
        actor_type: 'api_key',
        actor_id: writer.key.id,
        metadata: expect.objectContaining({ source: 'api' }),
      },
    ]);

    // Anything else needs the stopping scope: refused to the writing key, cancelled by the other,
    // and then answered as it is to either.
    const live = await s.draft('Live sale');
    await s.campaigns.submitCampaign(s.owner, live, { expectedVersion: 1 }, {});
    expect(await refused(apiCancelCampaign(writeDeps(), writer, live))).toEqual({
      code: 'forbidden',
      message: 'This API key does not have the campaigns.stop scope.',
    });
    expect(await apiCancelCampaign(writeDeps(), stopper, live)).toMatchObject({
      status: 'canceled',
    });
    expect(await apiCancelCampaign(writeDeps(), writer, live)).toMatchObject({
      status: 'canceled',
    });

    // A stopping key still does not cancel a draft, which stays a draft.
    const another = await s.draft('Another draft');
    expect(await refused(apiCancelCampaign(writeDeps(), stopper, another))).toEqual({
      code: 'conflict',
      message:
        "A draft sends nothing until a member submits it, so it is cancelled through the API only by a key with campaigns.write: members edit or cancel drafts in the app. This campaign's status is draft.",
    });
    expect(await fx.query(`SELECT status FROM app.campaigns WHERE id = $1`, [another])).toEqual([
      { status: 'draft' },
    ]);
  });
});

describe('reviewing campaign drafts through the API (ADR-193)', () => {
  it("answers a draft's review as members' review reads it: what blocks it, who it would reach and what it would cost, changing nothing", async () => {
    const s = await setup();
    const writer = await apiKey(s.c, ['campaigns.write'], 'Drafts');
    const versionOf = async (id: string) =>
      (
        await fx.query<{ version: number }>(`SELECT version FROM app.campaigns WHERE id = $1`, [id])
      )[0]?.version;
    // A draft the key started has no number, template or audience yet: what blocks it only.
    const started = await apiCreateCampaign(writeDeps(), writer, { name: 'Weekend offer' }, null);
    const emptyId = (started.body as { data: { id: string } }).data.id;
    const empty = await apiReviewCampaign(writeDeps(), writer, emptyId);
    const emptyVersion = await versionOf(emptyId);
    expect(empty).toEqual(
      toApiCampaignReview(
        { id: emptyId, version: emptyVersion! },
        {
          ...(await s.campaigns.reviewDraft(s.owner, emptyId)),
          scheduledAt: new Date(empty.scheduledAt!),
        },
      ),
    );
    expect(empty).toMatchObject({
      campaignId: emptyId,
      audience: null,
      estimate: null,
      costCurrency: null,
      approvalRequired: false,
      frequencyCap: null,
    });
    expect(empty.problems).toEqual(
      expect.arrayContaining([
        'Choose the WhatsApp number to send from.',
        'Choose an approved template.',
      ]),
    );

    // Contacts tagged vip: two opted in to marketing, one who never opted in, one who opted out.
    await s.contact('+919800000301', 'Asha');
    await s.contact('+919800000302', 'Ravi');
    await s.contact('+919800000303', 'Meena', false);
    const kiran = await s.contact('+919800000304', 'Kiran');
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).recordConsent(s.owner, {
      contactId: kiran,
      purpose: 'marketing',
      action: 'opt_out',
      note: 'Asked at the store',
    });
    // Test-only rate card in a currency no other test uses: 1.25 per marketing message to +91
    // numbers (not a Meta price).
    const [card] = await fx.query<{ id: string }>(
      `INSERT INTO ops.rate_cards (id, currency, effective_from, source_url, created_by_user_id)
       VALUES (gen_random_uuid(), 'CHF', now() - interval '1 day', 'https://example.test/rates/chf', $1)
       RETURNING id`,
      [s.c.owner.id],
    );
    await fx.query(
      `INSERT INTO ops.rate_card_prefixes (rate_card_id, prefix, market) VALUES ($1, '91', 'India')`,
      [card!.id],
    );
    await fx.query(
      `INSERT INTO ops.rate_card_prices (rate_card_id, market, category, price_micros)
       VALUES ($1, 'India', 'marketing', 1250000)`,
      [card!.id],
    );
    await fx.query(`UPDATE ops.rate_cards SET status = 'published' WHERE id = $1`, [card!.id]);
    await s.campaigns.updateSettings(
      s.owner,
      { approvalRequired: true, cap: { count: 2, days: 7 }, costCurrency: 'CHF' },
      {},
    );
    const id = await s.draft('Festive sale');
    const version = await versionOf(id);
    const reviewed = await apiReviewCampaign(writeDeps(), writer, id);
    expect(reviewed).toEqual({
      campaignId: id,
      version,
      problems: [],
      audience: {
        total: 4,
        eligible: 2,
        skipReasons: [
          { reason: 'no_marketing_opt_in', count: 1 },
          { reason: 'opted_out', count: 1 },
        ],
      },
      estimate: {
        currency: 'CHF',
        total: '2.5',
        pricedCount: 2,
        unpricedCount: 0,
        byMarket: [{ market: 'India', count: 2, amount: '2.5' }],
      },
      costCurrency: 'CHF',
      scheduledAt: expect.any(String),
      scheduleAdjustment: null,
      approvalRequired: true,
      frequencyCap: { count: 2, days: 7 },
    });
    // The same review members read, in the API's words; reading it changed nothing.
    expect(reviewed).toEqual(
      toApiCampaignReview(
        { id, version: version! },
        {
          ...(await s.campaigns.reviewDraft(s.owner, id)),
          scheduledAt: new Date(reviewed.scheduledAt!),
        },
      ),
    );
    expect(await versionOf(id)).toBe(version);
    const [{ events } = { events: -1 }] = await fx.query<{ events: number }>(
      `SELECT count(*)::int AS events FROM app.campaign_events WHERE campaign_id = $1`,
      [id],
    );
    expect(await apiReviewCampaign(writeDeps(), writer, id)).toMatchObject({ version });
    expect(
      (
        await fx.query<{ events: number }>(
          `SELECT count(*)::int AS events FROM app.campaign_events WHERE campaign_id = $1`,
          [id],
        )
      )[0]?.events,
    ).toBe(events);

    // A key that only reads campaigns gets no review; a submitted campaign keeps the audience it
    // was submitted with and is not reviewed; another company's draft is not found.
    const reader = await apiKey(s.c, ['campaigns.read', 'campaigns.stop'], 'Reader');
    expect(await refusal(apiReviewCampaign(writeDeps(), reader, id))).toMatchObject({
      code: 'forbidden',
    });
    await s.campaigns.submitCampaign(s.owner, id, { expectedVersion: version! }, {});
    await expect(apiReviewCampaign(writeDeps(), writer, id)).rejects.toThrow(
      "Only draft campaigns are reviewed. This campaign's status is pending_approval.",
    );
    const other = await fx.company();
    const otherOwner = await fx.ctx(other, other.owner);
    const { id: theirs } = await createCampaignsService({
      db: fx.dbs.app,
      jobs: fx.jobs(),
      signer: fx.signer,
      clock: systemClock,
      notices: fx.notices(),
    }).createDraft(otherOwner, { name: 'Theirs' }, {});
    expect(await refusal(apiReviewCampaign(writeDeps(), writer, theirs))).toMatchObject({
      code: 'not_found',
    });
  });
});

describe('submitting campaign drafts through the API (ADR-202)', () => {
  const versionOf = async (id: string) =>
    (
      await fx.query<{ version: number }>(`SELECT version FROM app.campaigns WHERE id = $1`, [id])
    )[0]!.version;
  const stateOf = (id: string) =>
    fx.query<{
      status: string;
      submitted_by_user_id: string | null;
      submitted_by_api_key_id: string | null;
      launched_by_user_id: string | null;
      approved_by_user_id: string | null;
    }>(
      `SELECT status, submitted_by_user_id, submitted_by_api_key_id, launched_by_user_id,
              approved_by_user_id
         FROM app.campaigns WHERE id = $1`,
      [id],
    );
  const recipientsOf = (id: string) =>
    fx.query<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM app.campaign_recipients WHERE campaign_id = $1
        GROUP BY state ORDER BY state`,
      [id],
    );
  async function refused(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (!isAppError(error)) throw error;
      return { code: error.code, message: error.publicMessage };
    }
    throw new Error('expected a refusal');
  }

  it("submits a draft with members' checks for a member's approval, never starting it, and the approver launches it", async () => {
    const s = await setup();
    const writer = await apiKey(s.c, ['campaigns.write'], 'Drafts');
    await s.contact('+919820008001', 'Asha');
    await s.contact('+919820008002', 'Ravi');
    await s.contact('+919820008003', 'Meena', false);
    // Members' submissions start at once in this company; a key's waits all the same.
    expect((await s.campaigns.getSettings(s.owner)).approvalRequired).toBe(false);
    const id = await s.draft('Festive sale');
    const version = await versionOf(id);

    // A stale version and a draft the checks refuse are refused, and stay drafts.
    expect(
      await refused(apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: version + 1 })),
    ).toEqual({
      code: 'conflict',
      message: `This draft has changed since you read it: its version is ${version}. Read it again and give the version it has.`,
    });
    const started = await apiCreateCampaign(writeDeps(), writer, { name: 'Weekend offer' }, null);
    const emptyId = (started.body as { data: { id: string } }).data.id;
    expect(
      await refused(
        apiSubmitCampaign(submitDeps(), writer, emptyId, {
          expectedVersion: await versionOf(emptyId),
        }),
      ),
    ).toEqual({ code: 'precondition_failed', message: 'Choose the WhatsApp number to send from.' });
    for (const draft of [id, emptyId]) {
      expect(await stateOf(draft)).toEqual([
        {
          status: 'draft',
          submitted_by_user_id: null,
          submitted_by_api_key_id: null,
          launched_by_user_id: null,
          approved_by_user_id: null,
        },
      ]);
      expect(await recipientsOf(draft)).toEqual([]);
    }

    // Submitted: its audience taken, waiting for a member's approval, the key named.
    const submitted = await apiSubmitCampaign(submitDeps(), writer, id, {
      expectedVersion: version,
    });
    expect(submitted).toMatchObject({
      id,
      status: 'pending_approval',
      audienceCount: 3,
      skippedCount: 1,
      queuedCount: 0,
      startedAt: null,
    });
    expect(await stateOf(id)).toEqual([
      {
        status: 'pending_approval',
        submitted_by_user_id: null,
        submitted_by_api_key_id: writer.key.id,
        launched_by_user_id: null,
        approved_by_user_id: null,
      },
    ]);
    expect(await versionOf(id)).toBe(version + 1);
    expect(await recipientsOf(id)).toEqual([
      { state: 'pending', n: 2 },
      { state: 'skipped', n: 1 },
    ]);
    expect(
      await fx.query(
        `SELECT actor_user_id, detail->>'apiKeyId' AS api_key_id, (detail->>'pending')::int AS pending
           FROM app.campaign_events WHERE campaign_id = $1 AND type = 'submitted'`,
        [id],
      ),
    ).toEqual([{ actor_user_id: null, api_key_id: writer.key.id, pending: 2 }]);
    expect(
      await fx.query(
        `SELECT actor_type, actor_id, metadata FROM app.audit_events
          WHERE subject_id = $1 AND action = 'campaign.submitted'`,
        [id],
      ),
    ).toEqual([
      {
        actor_type: 'api_key',
        actor_id: writer.key.id,
        metadata: expect.objectContaining({ source: 'api', approvalRequired: true, pending: 2 }),
      },
    ]);
    // A retry is answered as it is; another key cannot submit what is no longer a draft.
    expect(await apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: version })).toEqual(
      submitted,
    );
    const other = await apiKey(s.c, ['campaigns.write'], 'Other drafts');
    expect(
      await refused(apiSubmitCampaign(submitDeps(), other, id, { expectedVersion: version + 1 })),
    ).toEqual({
      code: 'conflict',
      message: "Only draft campaigns are submitted. This campaign's status is pending_approval.",
    });
    expect((await s.campaigns.getCampaign(s.owner, id)).people.submittedByKey).toBe('Drafts');

    // The approver becomes its launcher, so approving needs permission to send campaigns.
    const cannotSend = {
      ...s.owner,
      permissions: new Set([...s.owner.permissions].filter((p) => p !== 'campaigns.send')),
    } as typeof s.owner;
    expect(await refused(s.campaigns.approveCampaign(cannotSend, id, {}, {}))).toEqual({
      code: 'forbidden',
      message:
        'An API key submitted this campaign, so it sends under the authority of the member who approves it: approving it needs permission to send campaigns.',
    });
    expect((await stateOf(id))[0]?.status).toBe('pending_approval');
    await s.campaigns.approveCampaign(s.owner, id, {}, {});
    expect(await stateOf(id)).toEqual([
      {
        status: 'scheduled',
        submitted_by_user_id: null,
        submitted_by_api_key_id: writer.key.id,
        launched_by_user_id: s.c.owner.id,
        approved_by_user_id: s.c.owner.id,
      },
    ]);
    expect(
      await apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: version }),
    ).toMatchObject({
      id,
      status: 'scheduled',
    });
  });

  it('takes a rejected or withdrawn submission back to a draft without the key, and keeps one submitter', async () => {
    const s = await setup();
    const writer = await apiKey(s.c, ['campaigns.write'], 'Drafts');
    await s.contact('+919820008011', 'Asha');
    const id = await s.draft('Diwali offer');
    const first = await versionOf(id);
    await apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: first });
    await s.campaigns.rejectCampaign(s.owner, id, { note: 'Not this week' }, {});
    expect(await stateOf(id)).toEqual([
      {
        status: 'draft',
        submitted_by_user_id: null,
        submitted_by_api_key_id: null,
        launched_by_user_id: null,
        approved_by_user_id: null,
      },
    ]);
    expect(await recipientsOf(id)).toEqual([]);
    // The version it was submitted at no longer submits it; the current one does.
    expect(
      (await refused(apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: first }))).code,
    ).toBe('conflict');
    await apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: await versionOf(id) });
    // A member who approves campaigns takes a key's submission back.
    await s.campaigns.withdrawCampaign(s.owner, id, {});
    expect((await stateOf(id))[0]).toMatchObject({
      status: 'draft',
      submitted_by_api_key_id: null,
    });

    // The database keeps at most one submitter, and only a key of the company.
    await expect(
      fx.query(
        `UPDATE app.campaigns SET submitted_by_user_id = $2, submitted_by_api_key_id = $3 WHERE id = $1`,
        [id, s.c.owner.id, writer.key.id],
      ),
    ).rejects.toThrow(/campaigns_one_submitter/);
    const elsewhere = await fx.company();
    const theirs = await apiKey(elsewhere, ['campaigns.write'], 'Theirs');
    await expect(
      fx.query(`UPDATE app.campaigns SET submitted_by_api_key_id = $2 WHERE id = $1`, [
        id,
        theirs.key.id,
      ]),
    ).rejects.toThrow(/campaigns_submitted_by_api_key_fk/);
    expect(
      await fx.query(
        `SELECT has_column_privilege('w360_app', 'app.campaigns', 'submitted_by_api_key_id', 'UPDATE') AS can`,
      ),
    ).toEqual([{ can: true }]);
  });
});

describe('withdrawing campaign submissions through the API (ADR-203)', () => {
  const versionOf = async (id: string) =>
    (
      await fx.query<{ version: number }>(`SELECT version FROM app.campaigns WHERE id = $1`, [id])
    )[0]!.version;
  async function refused(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (!isAppError(error)) throw error;
      return { code: error.code, message: error.publicMessage };
    }
    throw new Error('expected a refusal');
  }

  it("takes a key's own submission back to a draft at a new version, and nobody else's", async () => {
    const s = await setup();
    const writer = await apiKey(s.c, ['campaigns.write'], 'Drafts');
    const other = await apiKey(s.c, ['campaigns.write'], 'Other drafts');
    await s.contact('+919820008021', 'Asha');
    const id = await s.draft('Festive sale');
    // A draft is answered as it is, changing nothing.
    const version = await versionOf(id);
    expect(await apiWithdrawCampaign(writeDeps(), writer, id)).toMatchObject({
      id,
      status: 'draft',
    });
    expect(await versionOf(id)).toBe(version);
    await apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: version });

    // Another key cannot take it back, and it keeps waiting with its audience.
    expect(await refused(apiWithdrawCampaign(writeDeps(), other, id))).toEqual({
      code: 'forbidden',
      message:
        'Only the key that submitted this campaign withdraws it through the API: members withdraw it in the app.',
    });
    expect(
      (
        await fx.query<{ status: string }>(`SELECT status FROM app.campaigns WHERE id = $1`, [id])
      )[0]?.status,
    ).toBe('pending_approval');

    // The key that submitted it does: a draft at a new version without its audience; a retry
    // answers the draft as it is.
    for (let i = 0; i < 2; i += 1) {
      expect(await apiWithdrawCampaign(writeDeps(), writer, id)).toMatchObject({
        id,
        status: 'draft',
        audienceCount: 0,
        skippedCount: 0,
      });
    }
    expect(await versionOf(id)).toBe(version + 2);
    expect(
      await fx.query(`SELECT 1 FROM app.campaign_recipients WHERE campaign_id = $1`, [id]),
    ).toEqual([]);
    expect(
      await fx.query(
        `SELECT submitted_by_api_key_id, submitted_at FROM app.campaigns WHERE id = $1`,
        [id],
      ),
    ).toEqual([{ submitted_by_api_key_id: null, submitted_at: null }]);
    expect(
      await fx.query(
        `SELECT type, actor_user_id, detail->>'apiKeyId' AS api_key_id FROM app.campaign_events
          WHERE campaign_id = $1 AND type IN ('submitted', 'withdrawn') ORDER BY occurred_at, id`,
        [id],
      ),
    ).toEqual([
      { type: 'submitted', actor_user_id: null, api_key_id: writer.key.id },
      { type: 'withdrawn', actor_user_id: null, api_key_id: writer.key.id },
    ]);
    expect(
      await fx.query(
        `SELECT actor_type, actor_id, metadata FROM app.audit_events
          WHERE subject_id = $1 AND action = 'campaign.withdrawn'`,
        [id],
      ),
    ).toEqual([{ actor_type: 'api_key', actor_id: writer.key.id, metadata: { source: 'api' } }]);

    // It is submitted again from its new version; once approved it is no longer withdrawn.
    await apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: version + 2 });
    await s.campaigns.approveCampaign(s.owner, id, {}, {});
    expect(await refused(apiWithdrawCampaign(writeDeps(), writer, id))).toEqual({
      code: 'conflict',
      message:
        "Only a campaign waiting for approval is withdrawn. This campaign's status is scheduled.",
    });

    // A member's submission is withdrawn in the app only.
    await s.campaigns.updateSettings(
      s.owner,
      { approvalRequired: true, cap: null, costCurrency: null },
      {},
    );
    const membersId = await s.draft('Members sale');
    await s.campaigns.submitCampaign(
      s.owner,
      membersId,
      { expectedVersion: await versionOf(membersId) },
      {},
    );
    expect((await refused(apiWithdrawCampaign(writeDeps(), writer, membersId))).code).toBe(
      'forbidden',
    );
  });
});

describe('emailing about campaigns waiting for approval (ADR-204, ADR-205)', () => {
  const versionOf = async (id: string) =>
    (
      await fx.query<{ version: number }>(`SELECT version FROM app.campaigns WHERE id = $1`, [id])
    )[0]!.version;
  /** The company's campaign emails of one kind queued in the outbox, oldest first. */
  async function campaignEmails(tenantId: string, kind: 'campaign-approval' | 'campaign-review') {
    const rows = await fx.query<{
      id: string;
      to_address: string;
      dedupe_key: string;
      payload_ciphertext: string;
    }>(
      `SELECT id, to_address, dedupe_key, payload_ciphertext FROM ops.email_outbox
        WHERE tenant_id = $1 AND dedupe_key LIKE $2 ORDER BY id`,
      [tenantId, `${kind}:%`],
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
  const approvalEmails = (tenantId: string) => campaignEmails(tenantId, 'campaign-approval');
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
  const companyName = async (c: Company) =>
    (
      await fx.query<{ name: string }>('SELECT name FROM app.tenants WHERE id = $1', [c.tenant.id])
    )[0]!.name;

  it("emails a key's submission once to the active members who approve and send campaigns, in its transaction, with its counts and a link", async () => {
    const s = await setup();
    const admin = await member(s.c, 'admin');
    await member(s.c, 'admin', 'suspended');
    await member(s.c, 'supervisor');
    const writer = await apiKey(s.c, ['campaigns.write'], 'Campaign drafts');
    await s.contact('+919820008101', 'Asha');
    await s.contact('+919820008102', 'Ravi');
    await s.contact('+919820008103', 'Meena', false);
    const id = await s.draft('Festive sale');
    const version = await versionOf(id);
    // A refused submission emails nobody.
    await expect(
      apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: version + 1 }),
    ).rejects.toThrow('This draft has changed since you read it');
    expect(await approvalEmails(s.c.tenant.id)).toEqual([]);

    await apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: version });
    const expected = campaignApprovalNotice({
      campaignName: 'Festive sale',
      submitter: { kind: 'key', name: 'Campaign drafts' },
      pending: 2,
      total: 3,
      startsAt: null,
      timeZone: 'Asia/Kolkata',
    });
    expect(expected.lines.slice(0, 3)).toEqual([
      "The API key “Campaign drafts” submitted the campaign “Festive sale”, and it waits for a member's approval.",
      'It would be sent to 2 of the 3 contacts in its audience.',
      'Once approved, it starts at once.',
    ]);
    const sent = await approvalEmails(s.c.tenant.id);
    // The owner and the active administrator approve and send campaigns; the suspended
    // administrator, the supervisor, the marketer and the agent do not.
    expect(sent.map((e) => e.to).sort()).toEqual([admin.email, s.c.owner.email].sort());
    for (const [email, userId] of [
      [admin.email, admin.id],
      [s.c.owner.email, s.c.owner.id],
    ] as const) {
      expect(sent.find((e) => e.to === email)).toEqual({
        to: email,
        dedupeKey: `campaign-approval:${id}:${version + 1}:${userId}`,
        kind: 'tenant.notice',
        companyName: await companyName(s.c),
        subject: 'Campaign “Festive sale” waits for your approval',
        lines: expected.lines,
        url: `http://localhost:3000/c/${s.c.tenant.slug}/campaigns/${id}`,
        actionLabel: 'Review campaign',
      });
    }

    // A retry is answered as it is and emails nobody again, nor does a withdrawal.
    await apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: version });
    await apiWithdrawCampaign(writeDeps(), writer, id);
    expect(await approvalEmails(s.c.tenant.id)).toHaveLength(2);
    // Submitted again, it is a new submission at a new version: each approver hears of it.
    const again = await versionOf(id);
    await apiSubmitCampaign(submitDeps(), writer, id, { expectedVersion: again });
    const all = await approvalEmails(s.c.tenant.id);
    expect(
      all
        .map((e) => e.dedupeKey)
        .slice(2)
        .sort(),
    ).toEqual(
      [admin.id, s.c.owner.id].map((u) => `campaign-approval:${id}:${again + 1}:${u}`).sort(),
    );
  });

  it("emails a member's submission to the other approvers when the company requires approval, and nobody when it starts at once", async () => {
    const s = await setup();
    const admin = await member(s.c, 'admin');
    const writer = await apiKey(s.c, ['campaigns.write'], 'Campaign drafts');
    await s.contact('+919820008111', 'Asha');
    // Without approval a member's submission starts: nobody is asked to approve it.
    expect((await s.campaigns.getSettings(s.owner)).approvalRequired).toBe(false);
    const flash = await s.draft('Flash sale');
    await s.campaigns.submitCampaign(s.owner, flash, { expectedVersion: 1 }, {});
    expect(
      (
        await fx.query<{ status: string }>(`SELECT status FROM app.campaigns WHERE id = $1`, [
          flash,
        ])
      )[0]?.status,
    ).toBe('scheduled');
    expect(await approvalEmails(s.c.tenant.id)).toEqual([]);

    await s.campaigns.updateSettings(
      s.owner,
      { approvalRequired: true, cap: null, costCurrency: null },
      {},
    );
    // The marketer's submission goes to the owner and the administrator, naming the marketer.
    const byMarketer = await s.draft('Diwali offer');
    await s.campaigns.submitCampaign(
      await fx.ctx(s.c, s.c.marketer),
      byMarketer,
      { expectedVersion: 1 },
      {},
    );
    const first = await approvalEmails(s.c.tenant.id);
    expect(first.map((e) => e.to).sort()).toEqual([admin.email, s.c.owner.email].sort());
    expect(first[0]?.lines).toEqual(
      campaignApprovalNotice({
        campaignName: 'Diwali offer',
        submitter: { kind: 'member', name: 'Marketer' },
        pending: 1,
        total: 1,
        startsAt: null,
        timeZone: 'Asia/Kolkata',
      }).lines,
    );

    // The owner's own submission, set to start later in London, goes to the administrator only,
    // with the start in the campaign's time zone.
    const byOwner = await s.draft('Winter launch');
    const local = `${new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)}T09:30`;
    await apiUpdateCampaign(deps(), writer, byOwner, {
      expectedVersion: 1,
      schedule: { kind: 'later', local, timezone: 'Europe/London' },
    });
    const edited = await versionOf(byOwner);
    await s.campaigns.submitCampaign(s.owner, byOwner, { expectedVersion: edited }, {});
    const [scheduled] = await fx.query<{ scheduled_at: Date }>(
      `SELECT scheduled_at FROM app.campaigns WHERE id = $1`,
      [byOwner],
    );
    const second = (await approvalEmails(s.c.tenant.id)).slice(2);
    expect(second).toEqual([
      expect.objectContaining({
        to: admin.email,
        dedupeKey: `campaign-approval:${byOwner}:${edited + 1}:${admin.id}`,
        subject: 'Campaign “Winter launch” waits for your approval',
        lines: campaignApprovalNotice({
          campaignName: 'Winter launch',
          submitter: { kind: 'member', name: 'Owner' },
          pending: 1,
          total: 1,
          startsAt: scheduled!.scheduled_at,
          timeZone: 'Europe/London',
        }).lines,
        url: `http://localhost:3000/c/${s.c.tenant.slug}/campaigns/${byOwner}`,
      }),
    ]);
    expect(second[0]?.lines[2]).toMatch(
      /^Once approved, it starts at \d+ \w+ \d{4} at 09:30 (GMT|BST), or at once/,
    );
  });

  it('emails the member who submitted a campaign when an approver approves it, sends it back or takes it back, and nobody for their own withdrawal (ADR-205)', async () => {
    const s = await setup();
    await s.contact('+919820008121', 'Asha');
    await s.campaigns.updateSettings(
      s.owner,
      { approvalRequired: true, cap: null, costCurrency: null },
      {},
    );
    const marketer = await fx.ctx(s.c, s.c.marketer);
    const writer = await apiKey(s.c, ['campaigns.write'], 'Campaign drafts');
    const submit = async (
      name: string,
      schedule?: { kind: 'later'; local: string; timezone: string },
    ) => {
      const id = await s.draft(name);
      if (schedule) await apiUpdateCampaign(deps(), writer, id, { expectedVersion: 1, schedule });
      await s.campaigns.submitCampaign(marketer, id, { expectedVersion: await versionOf(id) }, {});
      return id;
    };
    // Approved with a note, set to start later in London: the start in the campaign's time zone.
    const local = `${new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)}T09:30`;
    const approved = await submit('Diwali offer', {
      kind: 'later',
      local,
      timezone: 'Europe/London',
    });
    await s.campaigns.approveCampaign(s.owner, approved, { note: 'Looks good' }, {});
    const [launched] = await fx.query<{ scheduled_at: Date; version: number }>(
      `SELECT scheduled_at, version FROM app.campaigns WHERE id = $1`,
      [approved],
    );
    // Sent back with a note; taken back by the owner; taken back by the marketer, who is told
    // nothing about their own withdrawal.
    const rejected = await submit('Weekend sale');
    await s.campaigns.rejectCampaign(s.owner, rejected, { note: 'Use the new offer' }, {});
    const withdrawn = await submit('Flash sale');
    await s.campaigns.withdrawCampaign(s.owner, withdrawn, {});
    const own = await submit('Clearance');
    await s.campaigns.withdrawCampaign(marketer, own, {});

    const email = async (id: string, notice: { subject: string; lines: string[] }) => ({
      to: s.c.marketer.email,
      dedupeKey: `campaign-review:${id}:${await versionOf(id)}:${s.c.marketer.id}`,
      kind: 'tenant.notice',
      companyName: await companyName(s.c),
      ...notice,
      url: `http://localhost:3000/c/${s.c.tenant.slug}/campaigns/${id}`,
      actionLabel: 'Open campaign',
    });
    const review = { reviewer: 'Owner', startsAt: null, timeZone: 'Asia/Kolkata' };
    expect(await versionOf(approved)).toBe(launched!.version);
    expect(await campaignEmails(s.c.tenant.id, 'campaign-review')).toEqual([
      await email(
        approved,
        campaignReviewNotice({
          ...review,
          campaignName: 'Diwali offer',
          outcome: 'approved',
          note: 'Looks good',
          startsAt: launched!.scheduled_at,
          timeZone: 'Europe/London',
        }),
      ),
      await email(
        rejected,
        campaignReviewNotice({
          ...review,
          campaignName: 'Weekend sale',
          outcome: 'rejected',
          note: 'Use the new offer',
        }),
      ),
      await email(
        withdrawn,
        campaignReviewNotice({
          ...review,
          campaignName: 'Flash sale',
          outcome: 'withdrawn',
          note: null,
        }),
      ),
    ]);
  });

  it("emails nobody about a key's submission, or a submitter who is no longer an active member (ADR-205)", async () => {
    const s = await setup();
    await s.contact('+919820008131', 'Asha');
    const writer = await apiKey(s.c, ['campaigns.write'], 'Campaign drafts');
    // No member submitted a key's submission: its integration reads campaign.status_changed.
    const byKey = await s.draft('Festive sale');
    await apiSubmitCampaign(submitDeps(), writer, byKey, {
      expectedVersion: await versionOf(byKey),
    });
    await s.campaigns.approveCampaign(s.owner, byKey, {}, {});
    // The marketer is suspended after submitting: their campaign is sent back without an email.
    await s.campaigns.updateSettings(
      s.owner,
      { approvalRequired: true, cap: null, costCurrency: null },
      {},
    );
    const byMarketer = await s.draft('Diwali offer');
    await s.campaigns.submitCampaign(
      await fx.ctx(s.c, s.c.marketer),
      byMarketer,
      { expectedVersion: 1 },
      {},
    );
    await fx.query(
      `UPDATE app.memberships SET status = 'suspended' WHERE tenant_id = $1 AND user_id = $2`,
      [s.c.tenant.id, s.c.marketer.id],
    );
    await s.campaigns.rejectCampaign(s.owner, byMarketer, { note: 'Not this week' }, {});
    expect(await campaignEmails(s.c.tenant.id, 'campaign-review')).toEqual([]);
    // Both submissions were still emailed to the approver (ADR-204).
    expect((await approvalEmails(s.c.tenant.id)).map((e) => e.to)).toEqual([
      s.c.owner.email,
      s.c.owner.email,
    ]);
  });
});
