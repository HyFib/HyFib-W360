import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  CAMPAIGN_REPLY_HOURS,
  advanceAutomationRun,
  createAutomationService,
  processSendIntent,
  type AutomationTrigger,
  type TenantContext,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Automations started by replies to a campaign (ADR-414) against real PostgreSQL and the test-only
 * Graph stand-in: a quoting reply or a quick-reply tap on a campaign message starts the automation
 * that names it (or any campaign, or its button), ranked above keywords; the campaign message is
 * found by its WAMID, of the same contact and number, within 72 hours of its queueing; exactly one
 * run starts when automations or replies compete; what the run answers is recorded once and read by
 * {{campaign.*}}, by the run's page (to members who can read campaigns) and by test runs; saving,
 * publishing and testing need `campaigns.read`; the new table's tenant rules.
 */
let fx: WhatsAppFixture;
beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  await fx?.close();
});

const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;
const rate = { capacity: 1000, refillPerSecond: 1000 };

const automations = () =>
  createAutomationService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
  });

const replyTrigger = (
  campaignId: string | null,
  button: string | null = null,
  extra: Partial<{ hours: 'any' | 'open' | 'closed'; cooldownMinutes: number }> = {},
): AutomationTrigger => ({
  type: 'campaign_reply',
  campaignId,
  button,
  hours: 'any',
  cooldownMinutes: 0,
  ...extra,
});
const keyword = (word: string): AutomationTrigger => ({
  type: 'keyword',
  keywords: [word],
  match: 'contains',
  hours: 'any',
  cooldownMinutes: 0,
});
const sayGraph = (text: string) => ({
  version: 1,
  start: 'say',
  nodes: [{ id: 'say', type: 'send_text', text, next: null }],
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

const without = (ctx: TenantContext, ...permissions: string[]): TenantContext => ({
  ...ctx,
  permissions: new Set([...ctx.permissions].filter((p) => !permissions.includes(p))),
});

/** A saved draft of the company (its issues returned). */
async function draft(
  owner: TenantContext,
  name: string,
  trigger: AutomationTrigger,
  graph: unknown,
  channelAccountId: string | null = null,
) {
  const svc = automations();
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

/** A published automation of the company. */
async function publish(
  owner: TenantContext,
  name: string,
  trigger: AutomationTrigger,
  graph: unknown = sayGraph(`Hello from ${name}.`),
  channelAccountId: string | null = null,
) {
  const saved = await draft(owner, name, trigger, graph, channelAccountId);
  expect(saved.issues.filter((i) => i.level === 'error')).toEqual([]);
  await automations().publishAutomation(owner, {
    id: saved.id,
    expectedVersion: saved.version,
    note: null,
  });
  return saved.id;
}

/** A customer's first message (no automation answers it): their conversation and contact. */
async function customer(c: Company, from = waId()) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, text: 'Hello there' }] }));
  const [row] = await fx.query<{ conversation_id: string; contact_id: string }>(
    `SELECT cv.id AS conversation_id, cv.contact_id FROM app.conversations cv
       JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
      WHERE cv.tenant_id = $1 AND cv.channel_account_id = $2 AND i.wa_id = $3`,
    [c.tenant.id, c.channelAccountId, from],
  );
  if (!row) throw new Error('conversation not created');
  return { from, conversationId: row.conversation_id, contactId: row.contact_id };
}

async function campaign(c: Company, name: string, status = 'completed') {
  const id = uuidv7();
  await fx.query(
    `INSERT INTO app.campaigns (id, tenant_id, name, status, channel_account_id, timezone)
     VALUES ($1, $2, $3, $4, $5, 'Asia/Kolkata')`,
    [id, c.tenant.id, name, status, c.channelAccountId],
  );
  return id;
}

/**
 * A campaign message to the customer that WhatsApp accepted, queued `hoursAgo` hours ago, of a
 * variant; its WAMID. `sender` 'agent' stores a member's message with no recipient row instead.
 */
async function campaignMessage(
  c: Company,
  to: { conversationId: string; contactId: string },
  campaignId: string,
  options: { hoursAgo?: number; variant?: string; sender?: 'campaign' | 'agent' } = {},
) {
  const wamid = `wamid.out.${randomBytes(8).toString('hex')}`;
  const messageId = uuidv7();
  const sender = options.sender ?? 'campaign';
  await fx.query(
    `INSERT INTO app.messages (id, tenant_id, conversation_id, channel_account_id, direction, type,
       content, status, sender_type, external_message_id)
     VALUES ($1, $2, $3, $4, 'outbound', $5, '{}'::jsonb, 'delivered', $6, $7)`,
    [
      messageId,
      c.tenant.id,
      to.conversationId,
      c.channelAccountId,
      sender === 'campaign' ? 'template' : 'text',
      sender,
      wamid,
    ],
  );
  if (sender === 'campaign') {
    await fx.query(
      `INSERT INTO app.campaign_recipients (id, tenant_id, campaign_id, contact_id, state,
         message_id, queued_at, variant)
       VALUES ($1, $2, $3, $4, 'queued', $5, now() - make_interval(secs => $6), $7)`,
      [
        uuidv7(),
        c.tenant.id,
        campaignId,
        to.contactId,
        messageId,
        (options.hoursAgo ?? 1) * 3600,
        options.variant ?? 'A',
      ],
    );
  }
  return wamid;
}

/** The customer taps a quick-reply button of the message `contextId` names. */
const tap = (c: Company, from: string, contextId: string, text: string, id?: string) =>
  fx.deliver(
    fx.messagesBody(c, {
      messages: [
        { id, waId: from, type: 'button', extra: { button: { text, payload: text } }, contextId },
      ],
    }),
  );

/** The customer replies quoting the message `contextId` names (or none). */
const reply = (c: Company, from: string, text: string, contextId?: string, id?: string) =>
  fx.deliver(fx.messagesBody(c, { messages: [{ id, waId: from, text, contextId }] }));

const runsIn = (conversationId: string) =>
  fx.query<{ id: string; automation_id: string; trigger_type: string; status: string }>(
    `SELECT id, automation_id, trigger_type, status FROM app.automation_runs
      WHERE conversation_id = $1 ORDER BY started_at, id`,
    [conversationId],
  );

const answered = (runId: string) =>
  fx.query<{ campaign_id: string; variant: string | null; button_text: string | null }>(
    `SELECT campaign_id, variant, button_text FROM app.automation_run_campaigns WHERE run_id = $1`,
    [runId],
  );

/** Advances a run the way the worker does, sending what it queues, until it waits or ends. */
async function driveRun(c: Company, runId: string) {
  for (let i = 0; i < 20; i += 1) {
    const result = await advanceAutomationRun(
      {
        db: fx.dbs.app,
        jobs: fx.jobs(),
        signer: fx.signer,
        clock: systemClock,
        keyring: fx.keyring,
      },
      authorizedTenantScope(c.tenant.id, null),
      runId,
      null,
    );
    const intents = await fx.query<{ id: string; actor_user_id: string | null }>(
      `SELECT id, actor_user_id FROM app.send_intents WHERE tenant_id = $1 AND state = 'queued'
        ORDER BY created_at`,
      [c.tenant.id],
    );
    for (const intent of intents) {
      await processSendIntent(
        {
          db: fx.dbs.app,
          keyring: fx.keyring,
          graph: fx.graph,
          clock: systemClock,
          rate,
          jobs: fx.jobs(),
          signer: fx.signer,
        },
        authorizedTenantScope(c.tenant.id, intent.actor_user_id),
        intent.id,
      );
    }
    if (intents.length === 0 && result.outcome !== 'sending' && result.outcome !== 'yielded') {
      return result.outcome;
    }
  }
  throw new Error('the run did not settle');
}

const botTexts = (conversationId: string) =>
  fx.query<{ text: string }>(
    `SELECT content ->> 'text' AS text FROM app.messages
      WHERE conversation_id = $1 AND sender_type = 'bot' ORDER BY created_at, id`,
    [conversationId],
  );

describe('automations started by replies to a campaign (ADR-414)', () => {
  it('start on a quick-reply tap or a quoting reply, record the campaign, variant and button, and fill in {{campaign.*}}', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const tapper = await customer(c);
    const quoter = await customer(c);
    const diwali = await campaign(c, 'Diwali offers');
    const tapped = await campaignMessage(c, tapper, diwali, { variant: 'B' });
    const quoted = await campaignMessage(c, quoter, diwali, { variant: 'C' });
    const automationId = await publish(
      owner,
      'Diwali follow-up',
      replyTrigger(diwali),
      sayGraph(
        'Thanks for answering {{campaign.name}} ({{campaign.variant}}) [{{campaign.button}}]',
      ),
    );

    await tap(c, tapper.from, tapped, 'Yes, call me');
    const [tapRun] = await runsIn(tapper.conversationId);
    expect(tapRun).toMatchObject({ automation_id: automationId, trigger_type: 'campaign_reply' });
    expect(await answered(tapRun!.id)).toEqual([
      { campaign_id: diwali, variant: 'B', button_text: 'Yes, call me' },
    ]);
    expect(await driveRun(c, tapRun!.id)).toBe('ended');
    expect(await botTexts(tapper.conversationId)).toEqual([
      { text: 'Thanks for answering Diwali offers (B) [Yes, call me]' },
    ]);

    await reply(c, quoter.from, 'Is this still on?', quoted);
    const [quoteRun] = await runsIn(quoter.conversationId);
    expect(quoteRun).toMatchObject({ automation_id: automationId, trigger_type: 'campaign_reply' });
    expect(await answered(quoteRun!.id)).toEqual([
      { campaign_id: diwali, variant: 'C', button_text: null },
    ]);
    // The campaign's name is read when the step runs.
    await fx.query(`UPDATE app.campaigns SET name = 'Diwali week' WHERE id = $1`, [diwali]);
    expect(await driveRun(c, quoteRun!.id)).toBe('ended');
    expect(await botTexts(quoter.conversationId)).toEqual([
      { text: 'Thanks for answering Diwali week (C) []' },
    ]);
    // The run's step log names the trigger, as for the other triggers.
    const [started] = await fx.query<{ detail: string }>(
      `SELECT detail FROM app.automation_run_steps WHERE run_id = $1 AND outcome = 'started'`,
      [quoteRun!.id],
    );
    expect(started?.detail).toBe('campaign_reply');
  });

  it('rank every reply to a campaign above keywords: the chosen campaign and button, the chosen campaign, any campaign with the button, any campaign', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const p1 = await customer(c);
    const p2 = await customer(c);
    const p3 = await customer(c);
    const p4 = await customer(c);
    const p5 = await customer(c);
    const diwali = await campaign(c, 'Diwali');
    const summer = await campaign(c, 'Summer');
    // Names sort against the ranks, so the rank decides, never the name.
    const names = {
      keyword: await publish(owner, 'A keyword', keyword('yes')),
      anyCampaign: await publish(owner, 'B any campaign', replyTrigger(null)),
      anyYes: await publish(owner, 'C any campaign, Yes', replyTrigger(null, 'Yes')),
      diwali: await publish(owner, 'D Diwali', replyTrigger(diwali)),
      diwaliYes: await publish(owner, 'E Diwali, Yes', replyTrigger(diwali, 'Yes')),
    };
    const startedBy = async (conversationId: string) => {
      const runs = await runsIn(conversationId);
      expect(runs).toHaveLength(1);
      return runs[0]!.automation_id;
    };
    await tap(c, p1.from, await campaignMessage(c, p1, diwali), 'yes ');
    expect(await startedBy(p1.conversationId)).toBe(names.diwaliYes);
    await tap(c, p2.from, await campaignMessage(c, p2, diwali), 'No');
    expect(await startedBy(p2.conversationId)).toBe(names.diwali);
    await tap(c, p3.from, await campaignMessage(c, p3, summer), 'Yes');
    expect(await startedBy(p3.conversationId)).toBe(names.anyYes);
    await reply(c, p4.from, 'yes please', await campaignMessage(c, p4, summer));
    expect(await startedBy(p4.conversationId)).toBe(names.anyCampaign);
    // Without a campaign message, the keyword starts as before.
    await reply(c, p5.from, 'yes please');
    expect(await startedBy(p5.conversationId)).toBe(names.keyword);
    expect((await runsIn(p5.conversationId))[0]?.trigger_type).toBe('keyword');
  });

  it(`take a reply as one to the campaign for ${CAMPAIGN_REPLY_HOURS} hours after its queueing, only to a campaign message of the same contact and number`, async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const diwali = await campaign(c, 'Diwali');
    const fresh = await customer(c);
    const old = await customer(c);
    const member = await customer(c);
    const otherContact = await customer(c);
    const otherNumber = await customer(c);
    const fallback = await publish(owner, 'Any message', {
      type: 'any_message',
      hours: 'any',
      cooldownMinutes: 0,
    });
    const follow = await publish(owner, 'Diwali follow-up', replyTrigger(diwali));
    const startedBy = async (conversationId: string) =>
      (await runsIn(conversationId)).map((r) => [r.automation_id, r.trigger_type]);

    // Queued 71 hours ago: a reply to the campaign.
    await tap(c, fresh.from, await campaignMessage(c, fresh, diwali, { hoursAgo: 71 }), 'Yes');
    expect(await startedBy(fresh.conversationId)).toEqual([[follow, 'campaign_reply']]);
    // Queued 73 hours ago: any other message.
    await tap(c, old.from, await campaignMessage(c, old, diwali, { hoursAgo: 73 }), 'Yes');
    expect(await startedBy(old.conversationId)).toEqual([[fallback, 'any_message']]);
    // A member's message is not a campaign's.
    await reply(
      c,
      member.from,
      'About this',
      await campaignMessage(c, member, diwali, { sender: 'agent' }),
    );
    expect(await startedBy(member.conversationId)).toEqual([[fallback, 'any_message']]);
    // Another contact's campaign message, named by its WAMID, is not this contact's.
    const theirs = await campaignMessage(c, fresh, diwali);
    await tap(c, otherContact.from, theirs, 'Yes');
    expect(await startedBy(otherContact.conversationId)).toEqual([[fallback, 'any_message']]);
    // A WAMID of the company's other number is not found on this one.
    const second = await fx.addNumber(c);
    const onSecond = await customer(second, otherNumber.from);
    const wamid = await campaignMessage(second, onSecond, diwali);
    await tap(c, otherNumber.from, wamid, 'Yes');
    expect(await startedBy(otherNumber.conversationId)).toEqual([[fallback, 'any_message']]);
  });

  it('keep the cooldown and the automation’s number, like the other message triggers', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const diwali = await campaign(c, 'Diwali');
    const second = await fx.addNumber(c);
    const elsewhere = await publish(
      owner,
      'A on the second number',
      replyTrigger(null),
      sayGraph('Second number.'),
      second.channelAccountId,
    );
    const here = await publish(
      owner,
      'B Diwali',
      replyTrigger(diwali, null, { cooldownMinutes: 60 }),
      sayGraph('Thanks!'),
      c.channelAccountId,
    );
    const person = await customer(c);
    await tap(c, person.from, await campaignMessage(c, person, diwali), 'Yes');
    const runs = await runsIn(person.conversationId);
    expect(runs.map((r) => r.automation_id)).toEqual([here]);
    expect(runs.map((r) => r.automation_id)).not.toContain(elsewhere);
    expect(await driveRun(c, runs[0]!.id)).toBe('ended');
    // Within the cooldown a second reply starts nothing.
    await tap(c, person.from, await campaignMessage(c, person, diwali), 'Yes');
    expect(await runsIn(person.conversationId)).toHaveLength(1);
  });

  it('start exactly one run when automations or replies compete, and while the campaign is still sending', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const sending = await campaign(c, 'Flash sale', 'running');
    // Two automations of the same rank: the name decides, one run starts.
    const first = await publish(owner, 'A follow-up', replyTrigger(sending));
    await publish(owner, 'B follow-up', replyTrigger(sending));
    const person = await customer(c);
    // Other recipients are still pending: the campaign keeps sending while this one answers.
    const pendingContact = await customer(c);
    await fx.query(
      `INSERT INTO app.campaign_recipients (id, tenant_id, campaign_id, contact_id, state)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [uuidv7(), c.tenant.id, sending, pendingContact.contactId],
    );
    const wamid = await campaignMessage(c, person, sending);
    // The tap and a quoting reply arrive together, each in a webhook of its own; the same tap is
    // also delivered twice.
    const tapId = `wamid.in.${randomBytes(6).toString('hex')}`;
    await Promise.all([
      tap(c, person.from, wamid, 'Yes', tapId),
      tap(c, person.from, wamid, 'Yes', tapId),
      reply(c, person.from, 'and also', wamid),
    ]);
    const runs = await runsIn(person.conversationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ automation_id: first, trigger_type: 'campaign_reply' });
    expect(await answered(runs[0]!.id)).toHaveLength(1);
    const [status] = await fx.query<{ status: string }>(
      'SELECT status FROM app.campaigns WHERE id = $1',
      [sending],
    );
    expect(status?.status).toBe('running');
  });

  it('need the permission to see campaigns to save, publish or test, and take only a campaign of the company and its number', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const blind = without(owner, 'campaigns.read');
    const diwali = await campaign(c, 'Diwali');
    const theirs = await campaign(other, 'Theirs');
    const svc = automations();

    await expectAppError(
      draft(blind, 'No campaigns', replyTrigger(null), sayGraph('Hi')),
      'forbidden',
      /needs the permission to see campaigns/,
    );
    // Another company's campaign is refused like an unknown one.
    await expectAppError(
      draft(owner, 'Theirs', replyTrigger(theirs), sayGraph('Hi')),
      'validation_failed',
      /Choose a campaign of this company/,
    );
    // A member who cannot see campaigns publishes or tests nothing started by them.
    const saved = await draft(owner, 'Diwali', replyTrigger(diwali), sayGraph('Hi'));
    expect(saved.issues).toEqual([]);
    await expectAppError(
      svc.publishAutomation(blind, { id: saved.id, expectedVersion: saved.version, note: null }),
      'forbidden',
      /Publishing an automation started by replies to a campaign/,
    );
    const person = await customer(c);
    await expectAppError(
      svc.startTestRun(blind, {
        id: saved.id,
        expectedVersion: saved.version,
        conversationId: person.conversationId,
      }),
      'forbidden',
      /Testing an automation started by replies to a campaign/,
    );
    // The editor offers campaigns only to members who can see them.
    expect((await svc.getAutomation(owner, saved.id)).options.campaigns).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: diwali, name: 'Diwali' })]),
    );
    expect((await svc.getAutomation(blind, saved.id)).options.campaigns).toBeNull();
    // A campaign of another number never reaches an automation limited to this one.
    const second = await fx.addNumber(c);
    await fx.query('UPDATE app.campaigns SET channel_account_id = $2 WHERE id = $1', [
      diwali,
      second.channelAccountId,
    ]);
    const limited = await draft(
      owner,
      'Limited',
      replyTrigger(diwali),
      sayGraph('Hi'),
      c.channelAccountId,
    );
    expect(limited.issues.map((i) => [i.level, i.message])).toEqual([
      [
        'error',
        '“Diwali” sends from another WhatsApp number, so replies to it never reach this automation. Choose its number or every number.',
      ],
    ]);
    await expectAppError(
      svc.publishAutomation(owner, {
        id: limited.id,
        expectedVersion: limited.version,
        note: null,
      }),
      'precondition_failed',
    );
    // A member who cannot see campaigns never reads the campaign's name: not in the editor's
    // checks, and not in a refusal to publish or test (the permission is checked first).
    expect(JSON.stringify(await svc.getAutomation(owner, limited.id))).toContain('Diwali');
    const blindView = await svc.getAutomation(blind, limited.id);
    expect(JSON.stringify(blindView)).not.toContain('Diwali');
    expect(blindView.issues).toEqual([]);
    for (const attempt of [
      () =>
        svc.publishAutomation(blind, {
          id: limited.id,
          expectedVersion: limited.version,
          note: null,
        }),
      () =>
        svc.startTestRun(blind, {
          id: limited.id,
          expectedVersion: limited.version,
          conversationId: person.conversationId,
        }),
    ]) {
      try {
        await attempt();
        throw new Error('expected a refusal');
      } catch (error) {
        expect(isAppError(error) && error.code, String(error)).toBe('forbidden');
        expect(JSON.stringify(error)).not.toContain('Diwali');
        expect(String(error)).not.toContain('Diwali');
      }
    }
  });

  it('name the campaign on a run’s page only to members who can read campaigns, its button only to those who can see the conversation, and in test runs', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const diwali = await campaign(c, 'Diwali');
    const automationId = await publish(owner, 'Diwali follow-up', replyTrigger(diwali, 'Yes'));
    const person = await customer(c);
    await tap(c, person.from, await campaignMessage(c, person, diwali, { variant: 'B' }), 'Yes');
    const [run] = await runsIn(person.conversationId);
    if (!run) throw new Error('no run started');
    const svc = automations();
    expect((await svc.getRun(owner, run.id)).campaign).toEqual({
      hidden: false,
      id: diwali,
      name: 'Diwali',
      variant: 'B',
      buttonText: 'Yes',
    });
    expect((await svc.getRun(without(owner, 'campaigns.read'), run.id)).campaign).toEqual({
      hidden: true,
    });
    const outsider = without(owner, 'inbox.read_all', 'inbox.read_assigned');
    expect((await svc.getRun(outsider, run.id)).campaign).toEqual({
      hidden: false,
      id: diwali,
      name: 'Diwali',
      variant: 'B',
      buttonText: null,
    });
    expect(await driveRun(c, run.id)).toBe('ended');

    // A test run of the draft acts as a reply to the chosen campaign, with its button and no variant.
    const tester = await customer(c);
    const detail = await svc.getAutomation(owner, automationId);
    const test = await svc.startTestRun(owner, {
      id: automationId,
      expectedVersion: detail.version,
      conversationId: tester.conversationId,
    });
    expect(await answered(test.runId)).toEqual([
      { campaign_id: diwali, variant: null, button_text: 'Yes' },
    ]);
    expect((await svc.getRun(owner, test.runId)).campaign).toMatchObject({
      hidden: false,
      variant: null,
      buttonText: 'Yes',
    });
  });

  it('keep what a run answers in a table of the company’s rows only, written once and deleted with its run', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const diwali = await campaign(c, 'Diwali');
    await publish(owner, 'Diwali follow-up', replyTrigger(diwali));
    const person = await customer(c);
    await tap(c, person.from, await campaignMessage(c, person, diwali), 'Yes');
    const [run] = await runsIn(person.conversationId);
    if (!run) throw new Error('no run started');

    // Row security: the other company's scope sees nothing of it.
    const seen = await fx.dbs.app.run(authorizedTenantScope(other.tenant.id, null), (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM app.automation_run_campaigns`),
    );
    expect(seen.rows[0]?.n).toBe(0);
    const [rls] = await fx.query<{ forced: boolean; enabled: boolean }>(
      `SELECT relforcerowsecurity AS forced, relrowsecurity AS enabled FROM pg_class
        WHERE oid = 'app.automation_run_campaigns'::regclass`,
    );
    expect(rls).toEqual({ forced: true, enabled: true });
    // The company role reads and writes rows, never changes or deletes them.
    const grants = await fx.query<{ privilege: string; ok: boolean }>(
      `SELECT p AS privilege, has_table_privilege('w360_app', 'app.automation_run_campaigns', p) AS ok
         FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p ORDER BY p`,
    );
    expect(grants).toEqual([
      { privilege: 'DELETE', ok: false },
      { privilege: 'INSERT', ok: true },
      { privilege: 'SELECT', ok: true },
      { privilege: 'TRUNCATE', ok: false },
      { privilege: 'UPDATE', ok: false },
    ]);
    // Even the table's owner cannot change a row.
    await expect(
      fx.query(`UPDATE app.automation_run_campaigns SET variant = 'Z' WHERE run_id = $1`, [run.id]),
    ).rejects.toThrow();
    // Another company's campaign cannot be named (composite key).
    await expect(
      fx.query(
        `INSERT INTO app.automation_run_campaigns (id, tenant_id, run_id, campaign_id, variant)
         VALUES ($1, $2, $3, $4, 'A')`,
        [uuidv7(), other.tenant.id, run.id, diwali],
      ),
    ).rejects.toThrow(/automation_run_campaigns_run_fk|automation_run_campaigns_campaign_fk/);
    // Variants A to Z and button texts of 1 to 60 characters, each refused by its own check, on a
    // run that has no row yet (a keyword's), so the one-row-per-run key cannot be what refuses them.
    await publish(owner, 'Zebra', keyword('zebra'));
    const plain = await customer(c);
    await reply(c, plain.from, 'zebra please');
    const [keywordRun] = await runsIn(plain.conversationId);
    expect(keywordRun?.trigger_type).toBe('keyword');
    expect(await answered(keywordRun!.id)).toEqual([]);
    const insert = (runId: string, variant: string | null, button: string | null) =>
      fx.query(
        `INSERT INTO app.automation_run_campaigns (id, tenant_id, run_id, campaign_id, variant, button_text)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv7(), c.tenant.id, runId, diwali, variant, button],
      );
    for (const [variant, button, check] of [
      ['a', null, 'automation_run_campaigns_variant_check'],
      ['AB', null, 'automation_run_campaigns_variant_check'],
      ['A', '', 'automation_run_campaigns_button_text_check'],
      ['A', 'x'.repeat(61), 'automation_run_campaigns_button_text_check'],
    ] as const) {
      await expect(insert(keywordRun!.id, variant, button), `${variant} ${button}`).rejects.toThrow(
        new RegExp(check),
      );
    }
    // The bounds themselves are taken, and a second row for the same run is refused by the key.
    await insert(keywordRun!.id, 'Z', 'x'.repeat(60));
    await expect(insert(keywordRun!.id, 'A', null)).rejects.toThrow(
      /automation_run_campaigns_run_uq/,
    );
    await expect(insert(run.id, null, null)).rejects.toThrow(/automation_run_campaigns_run_uq/);
    // The runs' trigger check takes the new trigger and still refuses unknown ones (0324).
    const [check] = await fx.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'app.automation_runs'::regclass AND conname = 'automation_runs_trigger_type_check'`,
    );
    expect(check?.definition).toContain("'campaign_reply'::text");
    expect(check?.definition).toContain("'store_event'::text");
    // Deleted with its run (retention), and before the runs when the company is deleted.
    await fx.query(
      `SET LOCAL w360.allow_retention_purge = 'on'; DELETE FROM app.automation_runs WHERE id = '${run.id}'`,
    );
    const left = await answered(run.id);
    expect(left).toEqual([]);
    const [step] = await fx.query<{ ordinal: number }>(
      `SELECT ordinal FROM ops.tenant_deletion_steps
        WHERE 'app.automation_run_campaigns'::regclass = ANY (tables)`,
    );
    expect(step?.ordinal).toBe(688);
  });

  it('find the campaign message with index lookups only', async () => {
    const c = await fx.company();
    const person = await customer(c);
    const diwali = await campaign(c, 'Diwali');
    const wamid = await campaignMessage(c, person, diwali);
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT r.campaign_id, r.variant FROM app.messages m
           JOIN app.campaign_recipients r ON r.tenant_id = m.tenant_id AND r.message_id = m.id
          WHERE m.tenant_id = $1 AND m.channel_account_id = $2 AND m.external_message_id = $3
            AND m.direction = 'outbound' AND r.contact_id = $4 AND r.queued_at IS NOT NULL
          LIMIT 1`,
        [c.tenant.id, c.channelAccountId, wamid, person.contactId],
      );
      const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toContain('messages_external_uq');
      expect(text).not.toMatch(/Seq Scan/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
