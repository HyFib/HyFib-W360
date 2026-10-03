import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, type TenantScope } from '@w360/db';
import {
  RECIPIENT_OUTCOMES,
  apiGetCampaign,
  apiListCampaignRecipients,
  apiListCampaigns,
  apiListMessages,
  apiSearchContacts,
  authenticateApiToken,
  createApiKeysService,
  createCampaignsService,
  createConsentService,
  createContactsService,
  createSegmentsService,
  createTemplatesService,
  processSendIntent,
  processTemplateSubmit,
  runCampaignTick,
  syncTemplates,
  type ApiCampaignRecipient,
  type ApiContext,
  type ApiScope,
  type RecipientOutcome,
  type TemplateDefinition,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Reading campaigns through the public API (ADR-125) against real PostgreSQL and the Graph
 * stand-in: the company's campaigns newest first with their counters, in one status or all, on
 * exact pages; one campaign with its results counted as members' campaign page counts them, from
 * the send pipeline, delivery statuses, a reply and a STOP, and a cancelled one's recipients; null
 * results for a draft; never another company's campaigns; refusals without the scope or with a bad
 * filter. Also finding contacts by what happened to a campaign's message to them, which needs
 * contacts.read and campaigns.read (ADR-126), and listing a campaign's recipients with what
 * happened to each, by the results' own outcomes, erased contacts left out (ADR-127).
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
