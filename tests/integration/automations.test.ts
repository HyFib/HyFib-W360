import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgBoss, type Job } from 'pg-boss';
import { isAppError, sha256Hex, systemClock, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope, type Database } from '@w360/db';
import {
  advanceAutomationRun,
  apiSendText,
  apiSetConversationStatus,
  applyAutomationRetention,
  authenticateApiToken,
  authorizeJob,
  createApiKeysService,
  createAutomationService,
  createBusinessHoursService,
  createContactsService,
  createInboxService,
  createReportsService,
  createTeamsService,
  findDueAutomationRuns,
  MAX_STEP_FAILURES,
  PgBossJobQueue,
  processSendIntent,
  queueTextMessage,
  routeDueConversations,
  signalAutomationRun,
  type AutomationTrigger,
  type JobQueue,
  type TenantContext,
} from '@w360/domain';
import { connectTestDatabases } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Automations against real PostgreSQL, pg-boss and the test-only Graph stand-in: immutable
 * versions and pinned runs, a full flow with buttons, answers, contact updates and hand-off, the
 * bot/human hand-off lock (no competing responses), restart and lost-signal recovery, timers,
 * budgets, opt-out, erasure, test runs and company isolation.
 */
let fx: WhatsAppFixture;
beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  await fx?.close();
});

const rate = { capacity: 1000, refillPerSecond: 1000 };
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;
const later = (ms: number): Clock => ({ now: () => new Date(Date.now() + ms) });

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

function automations(db: Database = fx.dbs.app) {
  return createAutomationService({ db, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
}

const keyword = (...keywords: string[]): AutomationTrigger => ({
  type: 'keyword',
  keywords,
  match: 'contains',
  hours: 'any',
  cooldownMinutes: 0,
});

function menuGraph(options: { label?: string; teamId?: string | null } = {}) {
  return {
    version: 1,
    start: 'menu',
    nodes: [
      {
        id: 'menu',
        type: 'ask_buttons',
        header: 'Acme support',
        body: `Hi {{name}}, how can we help?${options.label ? ` ${options.label}` : ''}`,
        footer: 'Tap a button',
        buttons: [
          { title: 'Order status', next: 'order' },
          { title: 'Talk to us', next: 'agent' },
        ],
        saveAs: 'topic',
        retryText: null,
        retries: 1,
        noMatchNext: 'agent',
        timeoutMinutes: 60,
        timeoutNext: 'bye',
      },
      {
        id: 'order',
        type: 'ask_text',
        text: 'What is your order number?',
        saveAs: 'order_no',
        format: 'number',
        retryText: 'Please send the number only.',
        retries: 1,
        invalidNext: 'agent',
        timeoutMinutes: 30,
        timeoutNext: 'bye',
        next: 'thanks',
      },
      {
        id: 'thanks',
        type: 'send_text',
        text: 'Thanks, we will check order {{answer.order_no}}.',
        next: 'tag',
      },
      {
        id: 'tag',
        type: 'update_contact',
        action: { kind: 'add_tag', tag: 'Order enquiry' },
        next: null,
      },
      { id: 'agent', type: 'send_text', text: 'Connecting you to our team.', next: 'handoff' },
      { id: 'handoff', type: 'handoff', teamId: options.teamId ?? null },
      { id: 'bye', type: 'end' },
    ],
  };
}

async function publish(
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
  const published = await svc.publishAutomation(owner, {
    id,
    expectedVersion: saved.version,
    note: null,
  });
  return { id, version: published.version, number: published.versionNumber };
}

async function inbound(c: Company, from: string, text: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, text }] }));
  return conversationOf(c, from);
}

async function conversationOf(c: Company, from: string) {
  const [row] = await fx.query<{ id: string }>(
    `SELECT cv.id FROM app.conversations cv
       JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
      WHERE cv.tenant_id = $1 AND i.wa_id = $2`,
    [c.tenant.id, from],
  );
  if (!row) throw new Error('conversation not created');
  return row.id;
}

interface RunRow {
  id: string;
  status: string;
  end_reason: string | null;
  version_id: string;
  current_node_id: string | null;
  waiting_for: string | null;
  input_message_id: string | null;
  step_count: number;
  message_count: number;
  variables: Record<string, string>;
  mode: string;
  trigger_type: string;
  next_step_at: Date | null;
}

async function runsOf(conversationId: string) {
  return fx.query<RunRow & Record<string, unknown>>(
    `SELECT id, status, end_reason, version_id, current_node_id, waiting_for, input_message_id,
            step_count, message_count, variables, mode, trigger_type, next_step_at
       FROM app.automation_runs WHERE conversation_id = $1 ORDER BY started_at, id`,
    [conversationId],
  );
}

async function onlyRun(conversationId: string) {
  const runs = await runsOf(conversationId);
  expect(runs).toHaveLength(1);
  return runs[0] as RunRow;
}

function runnerDeps(clock: Clock = systemClock, jobs: JobQueue = fx.jobs(), db = fx.dbs.app) {
  return { db, jobs, signer: fx.signer, clock, keyring: fx.keyring };
}

async function advance(c: Company, runId: string, clock: Clock = systemClock) {
  return advanceAutomationRun(
    runnerDeps(clock),
    authorizedTenantScope(c.tenant.id, null),
    runId,
    null,
  );
}

/**
 * Advances a run the way the worker and the send pipeline do together: each queued bot message is
 * sent through the send worker (the Graph stand-in accepts it) before the run takes its next step,
 * until the run waits for the customer or a timer, or ends.
 */
async function drive(
  c: Company,
  conversationId: string,
  runId: string,
  clock: Clock = systemClock,
) {
  let steps = 0;
  for (let i = 0; i < 50; i += 1) {
    const result = await advance(c, runId, clock);
    steps += result.steps;
    if (result.outcome !== 'sending') return { outcome: result.outcome, steps };
    await sendQueued(c, conversationId);
  }
  throw new Error('the run did not settle');
}

async function stepLog(runId: string) {
  return fx.query<{
    seq: number;
    outcome: string;
    node_id: string | null;
    branch: string | null;
    detail: string | null;
  }>(
    `SELECT seq, outcome, node_id, branch, detail FROM app.automation_run_steps WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
}

async function botMessages(conversationId: string) {
  return fx.query<{
    id: string;
    type: string;
    content: Record<string, unknown>;
    status: string;
    external_message_id: string | null;
    error_code: string | null;
  }>(
    `SELECT id, type, content, status, external_message_id, error_code FROM app.messages
      WHERE conversation_id = $1 AND sender_type = 'bot' ORDER BY created_at, id`,
    [conversationId],
  );
}

/** Sends every queued message of the conversation through the send worker and the stand-in. */
async function sendQueued(c: Company, conversationId: string) {
  const intents = await fx.query<{ id: string; actor_user_id: string | null }>(
    `SELECT s.id, s.actor_user_id FROM app.send_intents s
       JOIN app.messages m ON m.tenant_id = s.tenant_id AND m.id = s.message_id
      WHERE m.conversation_id = $1 AND s.state = 'queued' ORDER BY s.created_at`,
    [conversationId],
  );
  const outcomes = [];
  for (const intent of intents) {
    const result = await processSendIntent(
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
    outcomes.push(result.outcome);
  }
  return outcomes;
}

function tap(c: Company, from: string, buttonId: string, title: string, contextId: string) {
  return fx.deliver(
    fx.messagesBody(c, {
      messages: [
        {
          waId: from,
          type: 'interactive',
          extra: {
            interactive: { type: 'button_reply', button_reply: { id: buttonId, title } },
            context: { from: '919000000000', id: contextId },
          },
        },
      ],
    }),
  );
}

async function buttonsOf(conversationId: string) {
  const messages = await botMessages(conversationId);
  const last = messages.filter((m) => m.type === 'interactive').at(-1);
  if (!last) throw new Error('no buttons message');
  const [intent] = await fx.query<{
    request: { interactive: { action: { buttons: { reply: { id: string; title: string } }[] } } };
  }>(`SELECT request FROM app.send_intents WHERE message_id = $1`, [last.id]);
  return {
    message: last,
    buttons: intent!.request.interactive.action.buttons.map((b) => b.reply),
  };
}

async function turns(conversationId: string) {
  return fx.query<{
    start_reason: string;
    end_reason: string | null;
    first_message_id: string | null;
  }>(
    `SELECT start_reason, end_reason, first_message_id FROM app.conversation_turns
      WHERE conversation_id = $1 ORDER BY started_at, id`,
    [conversationId],
  );
}

async function conversation(conversationId: string) {
  const [row] = await fx.query<{
    version: number;
    status: string;
    assigned_membership_id: string | null;
    team_id: string | null;
  }>(
    `SELECT version, status, assigned_membership_id, team_id FROM app.conversations WHERE id = $1`,
    [conversationId],
  );
  return row!;
}

describe('automation versions', () => {
  it('publishes immutable versions and keeps each run on the version it started with', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = automations();
    const first = await publish(
      owner,
      'Support menu',
      keyword('menu'),
      menuGraph({ label: '(v1)' }),
    );
    expect(first.number).toBe(1);

    const alice = waId();
    const conv1 = await inbound(c, alice, 'show me the menu');
    const run1 = await onlyRun(conv1);
    expect(run1).toMatchObject({ status: 'running', trigger_type: 'keyword', mode: 'live' });
    expect((await advance(c, run1.id)).outcome).toBe('waiting');
    expect((await botMessages(conv1))[0]?.content).toMatchObject({
      header: 'Acme support',
      body: 'Hi Priya Customer, how can we help? (v1)',
      footer: 'Tap a button',
      buttons: ['Order status', 'Talk to us'],
    });

    // Publish version 2; the run in progress keeps version 1's graph.
    const detail = await svc.getAutomation(owner, first.id);
    const saved = await svc.updateAutomation(owner, {
      id: first.id,
      expectedVersion: detail.version,
      name: 'Support menu',
      description: 'Main menu',
      channelAccountId: c.channelAccountId,
      trigger: keyword('menu'),
      graph: menuGraph({ label: '(v2)' }),
    });
    const second = await svc.publishAutomation(owner, {
      id: first.id,
      expectedVersion: saved.version,
      note: 'Clearer greeting',
    });
    expect(second.versionNumber).toBe(2);
    await expectAppError(
      svc.publishAutomation(owner, { id: first.id, expectedVersion: second.version, note: null }),
      'conflict',
      /Nothing changed since version 2/,
    );

    const { message, buttons } = await buttonsOf(conv1);
    expect(await sendQueued(c, conv1)).toEqual(['accepted']);
    const [sent] = await fx.query<{ external_message_id: string }>(
      `SELECT external_message_id FROM app.messages WHERE id = $1`,
      [message.id],
    );
    const talk = buttons.find((b) => b.title === 'Talk to us');
    await tap(c, alice, talk!.id, 'Talk to us', sent!.external_message_id);
    expect((await drive(c, conv1, run1.id)).outcome).toBe('ended');
    const ended = await onlyRun(conv1);
    expect(ended).toMatchObject({
      status: 'handed_off',
      end_reason: 'handoff_node',
      version_id: run1.version_id,
    });

    // A new conversation starts on version 2.
    const conv2 = await inbound(c, waId(), 'menu please');
    const run2 = await onlyRun(conv2);
    expect(run2.version_id).not.toBe(run1.version_id);
    await advance(c, run2.id);
    expect((await botMessages(conv2))[0]?.content).toMatchObject({
      body: 'Hi Priya Customer, how can we help? (v2)',
    });
    const versions = (await svc.getAutomation(owner, first.id)).versions;
    expect(versions.map((v) => [v.number, v.active, v.note])).toEqual([
      [2, true, 'Clearer greeting'],
      [1, false, null],
    ]);

    // Versions and the step log cannot be changed, even by the table owner.
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.automation_versions SET note = 'x' WHERE automation_id = $1`,
        [first.id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      fx.dbs.adminPool.query(`DELETE FROM app.automation_run_steps WHERE run_id = $1`, [run1.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      fx.dbs.adminPool.query(`UPDATE app.automation_runs SET step_count = 0 WHERE id = $1`, [
        run1.id,
      ]),
    ).rejects.toThrow(/ended automation run cannot change/);
    // Its pending message and HTTP call count are frozen too (lost in 0022, restored in 0028).
    for (const change of [
      `pending_message_id = (SELECT m.id FROM app.messages m
         WHERE m.tenant_id = r.tenant_id AND m.conversation_id = r.conversation_id LIMIT 1)`,
      'http_call_count = r.http_call_count + 1',
    ]) {
      await expect(
        fx.dbs.adminPool.query(`UPDATE app.automation_runs r SET ${change} WHERE r.id = $1`, [
          run1.id,
        ]),
      ).rejects.toThrow(/ended automation run cannot change/);
    }
  });

  it('saves drafts with problems but publishes only a draft without errors, with the right roles', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    const agent = await fx.ctx(c, c.agent);
    const svc = automations();
    await expectAppError(svc.createAutomation(agent, { name: 'Nope' }), 'forbidden');
    const { id } = await svc.createAutomation(marketer, { name: 'Welcome' });
    const broken = await svc.updateAutomation(marketer, {
      id,
      expectedVersion: 0,
      name: 'Welcome',
      description: null,
      channelAccountId: null,
      trigger: { type: 'conversation_started', hours: 'any', cooldownMinutes: 60 },
      graph: {
        version: 1,
        start: 'hi',
        nodes: [{ id: 'hi', type: 'send_text', text: 'Hello {{answer.city}}', next: 'gone' }],
      },
    });
    expect(broken.issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual([
      '“next” goes to a step that does not exist (gone).',
      '{{answer.city}} is not saved by any question or web request.',
    ]);
    await expectAppError(
      svc.publishAutomation(marketer, { id, expectedVersion: broken.version, note: null }),
      'forbidden',
    );
    await expectAppError(
      svc.publishAutomation(owner, { id, expectedVersion: broken.version, note: null }),
      'precondition_failed',
      /Fix the automation first/,
    );
    // Stale editors are refused; structural problems are refused before saving.
    await expectAppError(
      svc.updateAutomation(marketer, {
        id,
        expectedVersion: 0,
        name: 'Welcome',
        description: null,
        channelAccountId: null,
        trigger: { type: 'any_message', hours: 'any', cooldownMinutes: 0 },
        graph: { version: 1, start: 'x', nodes: [{ id: 'x', type: 'end' }] },
      }),
      'conflict',
    );
    await expectAppError(
      svc.updateAutomation(marketer, {
        id,
        expectedVersion: broken.version,
        name: 'Welcome',
        description: null,
        channelAccountId: null,
        trigger: { type: 'any_message', hours: 'any', cooldownMinutes: 0 },
        graph: {
          version: 1,
          start: 'x',
          nodes: [{ id: 'x', type: 'send_text', text: 'x'.repeat(4097), next: null }],
        },
      }),
      'validation_failed',
      /limited to 4096/,
    );
    // A draft that never ran can be deleted; a published one is archived instead.
    await svc.deleteAutomation(marketer, { id, expectedVersion: broken.version });
    const kept = await publish(owner, 'Kept', keyword('hello'), menuGraph());
    await expectAppError(
      svc.deleteAutomation(owner, { id: kept.id, expectedVersion: kept.version }),
      'conflict',
      /Archive it instead/,
    );
    const analystView = await svc.listAutomations(owner);
    expect(analystView.map((a) => [a.name, a.status, a.activeVersion])).toEqual([
      ['Kept', 'active', 1],
    ]);
  });
});

describe('automation runs', () => {
  it('runs buttons, a validated answer and a contact update, and hands off to a team', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const teamsService = createTeamsService({ db: fx.dbs.app, clock: systemClock });
    const { teamId } = await teamsService.createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      memberIds: [agent.membership.id],
      channelIds: [],
    });
    await teamsService.setAvailability(agent, { available: true });
    await publish(owner, 'Menu', keyword('menu'), menuGraph({ teamId }));

    // Order path: buttons, invalid then valid number, thanks, tag; ends without a waiting customer.
    const bob = waId();
    const conv = await inbound(c, bob, 'Menu');
    const run = await onlyRun(conv);
    expect(await turns(conv)).toEqual([
      { start_reason: 'customer', end_reason: 'automated', first_message_id: expect.any(String) },
    ]);
    await advance(c, run.id);
    const { message, buttons } = await buttonsOf(conv);
    expect(await sendQueued(c, conv)).toEqual(['accepted']);
    const [sent] = await fx.query<{ external_message_id: string }>(
      `SELECT external_message_id FROM app.messages WHERE id = $1`,
      [message.id],
    );
    await tap(c, bob, buttons[0]!.id, 'Order status', sent!.external_message_id);
    expect((await onlyRun(conv)).input_message_id).not.toBeNull();
    expect((await advance(c, run.id)).outcome).toBe('waiting');
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: bob, text: 'soon please' }] }));
    // The run holds until Meta accepts its question, then handles the reply.
    expect((await advance(c, run.id)).outcome).toBe('not_due');
    await sendQueued(c, conv);
    await advance(c, run.id);
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: bob, text: ' 4512 ' }] }));
    await sendQueued(c, conv);
    expect((await drive(c, conv, run.id)).outcome).toBe('ended');

    const done = await onlyRun(conv);
    expect(done).toMatchObject({
      status: 'completed',
      end_reason: 'no_next',
      variables: { topic: 'Order status', order_no: '4512' },
      message_count: 4,
    });
    expect((await botMessages(conv)).map((m) => m.content.text ?? m.content.body)).toEqual([
      'Hi Priya Customer, how can we help?',
      'What is your order number?',
      'Please send the number only.',
      'Thanks, we will check order 4512.',
    ]);
    expect((await stepLog(run.id)).map((s) => [s.outcome, s.node_id, s.branch])).toEqual([
      ['started', null, null],
      ['asked', 'menu', null],
      ['answered', 'menu', 'Order status'],
      ['asked', 'order', null],
      ['retried', 'order', null],
      ['answered', 'order', 'answer'],
      ['sent', 'thanks', null],
      ['updated', 'tag', null],
    ]);
    const tags = await fx.query<{ tag: string }>(
      `SELECT t.tag FROM app.contact_tags t JOIN app.conversations cv
          ON cv.tenant_id = t.tenant_id AND cv.contact_id = t.contact_id WHERE cv.id = $1`,
      [conv],
    );
    expect(tags.map((t) => t.tag)).toEqual(['order enquiry']);
    // The bot answered everything: nobody is waiting, nothing was routed.
    expect((await turns(conv)).filter((t) => t.end_reason === null)).toEqual([]);
    expect(await conversation(conv)).toMatchObject({ assigned_membership_id: null, team_id: null });

    // Hand-off path: the conversation joins the team and round robin assigns the agent; the
    // customer now waits for a person from the hand-off.
    const carol = waId();
    const conv2 = await inbound(c, carol, 'menu');
    const run2 = await onlyRun(conv2);
    // Routing leaves bot-handled conversations alone, including the minute sweep.
    await fx.dbs.adminPool.query(`UPDATE app.conversations SET team_id = $1 WHERE id = $2`, [
      teamId,
      conv2,
    ]);
    await routeDueConversations(fx.dbs.app);
    expect((await conversation(conv2)).assigned_membership_id).toBeNull();
    await advance(c, run2.id);
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: carol, text: 'talk to us' }] }));
    await sendQueued(c, conv2);
    expect((await drive(c, conv2, run2.id)).outcome).toBe('ended');
    expect(await onlyRun(conv2)).toMatchObject({
      status: 'handed_off',
      end_reason: 'handoff_node',
    });
    expect(await conversation(conv2)).toMatchObject({
      team_id: teamId,
      assigned_membership_id: agent.membership.id,
    });
    expect(await turns(conv2)).toEqual([
      { start_reason: 'customer', end_reason: 'automated', first_message_id: expect.any(String) },
      { start_reason: 'handoff', end_reason: null, first_message_id: null },
    ]);
    // The member's reply answers the hand-off turn.
    await queueTextMessage(runnerDeps(), agent, {
      conversationId: conv2,
      text: 'Hi Carol, how can I help?',
      clientKey: `k${randomInt(1e9)}xxxxxxxx`,
    });
    expect((await turns(conv2)).at(-1)).toMatchObject({
      start_reason: 'handoff',
      end_reason: 'replied',
    });
  });

  it('never lets the bot and a person answer at once', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await publish(owner, 'Menu', keyword('menu'), menuGraph());
    const inbox = createInboxService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });

    // A member replies while the bot's question is still queued: the run ends and the bot's
    // message is cancelled before it leaves.
    const dan = waId();
    const conv = await inbound(c, dan, 'menu');
    const run = await onlyRun(conv);
    await advance(c, run.id);
    await queueTextMessage(runnerDeps(), owner, {
      conversationId: conv,
      text: 'Hello Dan, I can help you directly.',
      clientKey: `k${randomInt(1e9)}xxxxxxxx`,
    });
    expect(await onlyRun(conv)).toMatchObject({
      status: 'taken_over',
      end_reason: 'agent_replied',
    });
    expect((await botMessages(conv)).map((m) => [m.status, m.error_code])).toEqual([
      ['canceled', 'bot_stopped'],
    ]);
    expect(await sendQueued(c, conv)).toEqual(['accepted']);
    const toDan = fx.standIn.state.requests.filter(
      (r) => (r.body as { to?: unknown } | undefined)?.to === dan,
    );
    expect(toDan.map((r) => (r.body as { type: string }).type)).toEqual(['text']);
    // A late automation job does nothing, and the customer's next message goes to the member.
    expect((await advance(c, run.id)).outcome).toBe('idle');
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: dan, text: 'menu' }] }));
    expect(await runsOf(conv)).toHaveLength(1);
    expect((await turns(conv)).at(-1)).toMatchObject({
      start_reason: 'customer',
      end_reason: null,
    });

    // Take over: the run ends and the member gets the conversation.
    const eve = waId();
    const conv2 = await inbound(c, eve, 'menu');
    await advance(c, (await onlyRun(conv2)).id);
    await automations().takeOver(agent, conv2);
    expect(await onlyRun(conv2)).toMatchObject({ status: 'taken_over', end_reason: 'take_over' });
    expect((await conversation(conv2)).assigned_membership_id).toBe(agent.membership.id);
    expect((await turns(conv2)).at(-1)).toMatchObject({
      start_reason: 'handoff',
      end_reason: null,
    });
    await expectAppError(automations().takeOver(agent, conv2), 'conflict');

    // Assigning a person ends the run; resolving stops it without a waiting turn.
    const fay = waId();
    const conv3 = await inbound(c, fay, 'menu');
    await advance(c, (await onlyRun(conv3)).id);
    await inbox.assign(owner, {
      conversationId: conv3,
      membershipId: agent.membership.id,
      expectedVersion: (await conversation(conv3)).version,
    });
    expect(await onlyRun(conv3)).toMatchObject({ status: 'taken_over', end_reason: 'assigned' });
    const gus = waId();
    const conv4 = await inbound(c, gus, 'menu');
    await advance(c, (await onlyRun(conv4)).id);
    await inbox.setStatus(owner, {
      conversationId: conv4,
      status: 'resolved',
      expectedVersion: (await conversation(conv4)).version,
    });
    expect(await onlyRun(conv4)).toMatchObject({
      status: 'stopped',
      end_reason: 'conversation_resolved',
    });
    expect((await turns(conv4)).filter((t) => t.end_reason === null)).toEqual([]);
  });

  it('lets a reply through the public API take the conversation over from the bot, which then waits for a member (ADR-070)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await publish(owner, 'Menu', keyword('menu'), menuGraph());
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Helpdesk', scopes: ['messages.reply'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');

    // The integration replies while the bot's question is still queued: the run ends as taken
    // over and the bot's message is cancelled before it leaves.
    const hal = waId();
    const conv = await inbound(c, hal, 'menu');
    const run = await onlyRun(conv);
    await advance(c, run.id);
    expect((await botMessages(conv)).map((m) => m.status)).toEqual(['queued']);
    const reply = await apiSendText(
      runnerDeps(),
      key,
      { type: 'text', to: `+${hal}`, text: 'Hi Hal, your order ships today.' },
      { key: 'reply-1', requestHash: sha256Hex('reply-1') },
    );
    expect(reply.status).toBe(201);
    expect(await onlyRun(conv)).toMatchObject({ status: 'taken_over', end_reason: 'api_replied' });
    const [ended] = await fx.query<{ ended_by_membership_id: string | null }>(
      'SELECT ended_by_membership_id FROM app.automation_runs WHERE id = $1',
      [run.id],
    );
    expect(ended?.ended_by_membership_id).toBeNull();
    expect((await stepLog(run.id)).at(-1)).toMatchObject({
      outcome: 'taken_over',
      detail: 'api_replied',
    });
    expect((await botMessages(conv)).map((m) => [m.status, m.error_code])).toEqual([
      ['canceled', 'bot_stopped'],
    ]);
    // Not an answer from a person: the conversation now waits for a member.
    expect((await turns(conv)).at(-1)).toMatchObject({
      start_reason: 'handoff',
      end_reason: null,
    });
    expect((await conversation(conv)).assigned_membership_id).toBeNull();

    // Only the integration's text leaves; a late automation job does nothing.
    expect(await sendQueued(c, conv)).toEqual(['accepted']);
    const toHal = fx.standIn.state.requests.filter(
      (r) => (r.body as { to?: unknown } | undefined)?.to === hal,
    );
    expect(toHal.map((r) => r.body)).toEqual([
      expect.objectContaining({
        type: 'text',
        text: { body: 'Hi Hal, your order ships today.', preview_url: false },
      }),
    ]);
    expect((await advance(c, run.id)).outcome).toBe('idle');

    // A member's reply answers the hand-off turn.
    await queueTextMessage(runnerDeps(), agent, {
      conversationId: conv,
      text: 'Hal, anything else I can help with?',
      clientKey: `k${randomInt(1e9)}xxxxxxxx`,
    });
    expect((await turns(conv)).at(-1)).toMatchObject({
      start_reason: 'handoff',
      end_reason: 'replied',
    });
  });

  it('stops the bot when the public API resolves the conversation, leaving no waiting turn (ADR-075)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Menu', keyword('menu'), menuGraph());
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Helpdesk', scopes: ['conversations.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');

    // The integration resolves while the bot's question is still queued: the run stops and the
    // bot's message is cancelled before it leaves.
    const ivy = waId();
    const conv = await inbound(c, ivy, 'menu');
    const run = await onlyRun(conv);
    await advance(c, run.id);
    expect((await botMessages(conv)).map((m) => m.status)).toEqual(['queued']);
    const resolved = await apiSetConversationStatus(runnerDeps(), key, conv, {
      status: 'resolved',
    });
    expect(resolved.status).toBe('resolved');
    expect(await onlyRun(conv)).toMatchObject({
      status: 'stopped',
      end_reason: 'conversation_resolved',
    });
    const [ended] = await fx.query<{ ended_by_membership_id: string | null }>(
      'SELECT ended_by_membership_id FROM app.automation_runs WHERE id = $1',
      [run.id],
    );
    expect(ended?.ended_by_membership_id).toBeNull();
    expect((await stepLog(run.id)).at(-1)).toMatchObject({
      outcome: 'stopped',
      detail: 'conversation_resolved',
    });
    expect((await botMessages(conv)).map((m) => [m.status, m.error_code])).toEqual([
      ['canceled', 'bot_stopped'],
    ]);
    expect((await turns(conv)).filter((t) => t.end_reason === null)).toEqual([]);
    expect(await sendQueued(c, conv)).toEqual([]);
    expect((await advance(c, run.id)).outcome).toBe('idle');
  });

  it('applies business-hours filters, cooldowns and the hourly cap, and skips assigned conversations', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const hello = {
      version: 1,
      start: 'hi',
      nodes: [{ id: 'hi', type: 'send_text', text: 'We are closed now.', next: null }],
    };
    // Business hours on, open all day every day, with yesterday, today and tomorrow closed (in the
    // company's time zone): the business is closed while this test runs.
    const hours = createBusinessHoursService({ db: fx.dbs.app, clock: systemClock });
    await hours.updateBusinessHours(owner, { enabled: true, days: Array(7).fill('00:00-24:00') });
    const localDay = (offsetDays: number) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: owner.tenant.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(Date.now() + offsetDays * 86_400_000));
    for (const offset of [-1, 0, 1]) {
      await hours.addHoliday(owner, { day: localDay(offset), name: `Closed ${offset}` });
    }
    await publish(
      owner,
      'While open',
      { type: 'any_message', hours: 'open', cooldownMinutes: 0 },
      { ...hello, nodes: [{ id: 'hi', type: 'send_text', text: 'We are open.', next: null }] },
    );
    await publish(
      owner,
      'Out of office',
      { type: 'any_message', hours: 'closed', cooldownMinutes: 30 },
      hello,
    );
    const ann = waId();
    const conv = await inbound(c, ann, 'hello?');
    const first = await onlyRun(conv);
    const [started] = await fx.query<{ name: string }>(
      `SELECT a.name FROM app.automations a JOIN app.automation_runs r ON r.automation_id = a.id WHERE r.id = $1`,
      [first.id],
    );
    expect(started?.name).toBe('Out of office');
    expect((await drive(c, conv, first.id)).outcome).toBe('ended');
    // Within the 30-minute cooldown the same automation does not start again.
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: ann, text: 'anyone there?' }] }));
    expect(await runsOf(conv)).toHaveLength(1);

    // A keyword automation without a cooldown starts every time, up to 10 runs per hour in one
    // conversation (bot-to-bot loops).
    await publish(owner, 'Ping', keyword('ping'), hello);
    const bea = waId();
    for (let i = 0; i < 11; i += 1) {
      await fx.deliver(fx.messagesBody(c, { messages: [{ waId: bea, text: 'ping' }] }));
      const runs = await runsOf(await conversationOf(c, bea));
      const last = runs.at(-1);
      if (last && (last.status === 'running' || last.status === 'waiting'))
        await drive(c, await conversationOf(c, bea), last.id);
    }
    expect(await runsOf(await conversationOf(c, bea))).toHaveLength(10);

    // A conversation assigned to a member is theirs: no automation starts.
    const cyd = waId();
    const conv3 = await inbound(c, cyd, 'first message');
    for (const r of await runsOf(conv3)) await drive(c, conv3, r.id);
    await fx.dbs.adminPool.query(
      `UPDATE app.conversations SET assigned_membership_id = $1 WHERE id = $2`,
      [owner.membership.id, conv3],
    );
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: cyd, text: 'ping' }] }));
    expect((await runsOf(conv3)).filter((r) => r.trigger_type === 'keyword')).toEqual([]);
  });

  it('starts one run when messages arrive at the same time', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Menu', keyword('menu'), menuGraph());
    const hal = waId();
    await Promise.all([
      fx.deliver(fx.messagesBody(c, { messages: [{ waId: hal, text: 'menu' }] })),
      fx.deliver(fx.messagesBody(c, { messages: [{ waId: hal, text: 'menu please' }] })),
      fx.deliver(fx.messagesBody(c, { messages: [{ waId: hal, text: 'the menu' }] })),
    ]);
    const conv = await conversationOf(c, hal);
    expect(await runsOf(conv)).toHaveLength(1);
  });

  it('resumes after a crash or a lost signal from the stored position, sending each message once', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Menu', keyword('menu'), menuGraph());
    const ivy = waId();
    const conv = await inbound(c, ivy, 'menu');
    const run = await onlyRun(conv);

    // A worker that fails inside the step (here: the send job cannot be written) leaves nothing.
    const failing: JobQueue = {
      async enqueue(tx, queue, envelope, options) {
        if (queue === QUEUES.messageSend.name) throw new Error('simulated crash');
        return fx.jobs().enqueue(tx, queue, envelope, options);
      },
      async enqueueMany(tx, queue, jobs) {
        return fx.jobs().enqueueMany(tx, queue, jobs);
      },
    };
    await expect(
      advanceAutomationRun(
        runnerDeps(systemClock, failing),
        authorizedTenantScope(c.tenant.id, null),
        run.id,
        null,
      ),
    ).rejects.toThrow('simulated crash');
    expect(await onlyRun(conv)).toMatchObject({
      status: 'running',
      current_node_id: 'menu',
      step_count: 0,
    });
    expect(await botMessages(conv)).toEqual([]);
    expect((await stepLog(run.id)).map((s) => s.outcome)).toEqual(['started']);

    // A real consumer (worker 1) processes the start signal, then stops without warning. Signals
    // left in the queue by earlier tests would only keep this test's consumers busy.
    await fx.dbs.adminPool.query(`DELETE FROM pgboss.job WHERE name = $1 AND data->>'ref' <> $2`, [
      QUEUES.automationRun.name,
      run.id,
    ]);
    const worker1 = await startConsumer();
    await waitFor(async () => (await onlyRun(conv)).status === 'waiting');
    await worker1.kill();
    expect(await botMessages(conv)).toHaveLength(1);

    // The customer answers while no worker runs, and the signal is lost too.
    await sendQueued(c, conv);
    const { message, buttons } = await buttonsOf(conv);
    const [sent] = await fx.query<{ external_message_id: string }>(
      `SELECT external_message_id FROM app.messages WHERE id = $1`,
      [message.id],
    );
    await tap(c, ivy, buttons[1]!.id, 'Talk to us', sent!.external_message_id);
    await fx.dbs.adminPool.query(`DELETE FROM pgboss.job WHERE name = $1 AND data->>'ref' = $2`, [
      QUEUES.automationRun.name,
      run.id,
    ]);
    await fx.dbs.adminPool.query(
      `UPDATE app.automation_runs SET next_step_at = now() - interval '1 minute' WHERE id = $1`,
      [run.id],
    );

    // After the restart the sweep finds the run and a new worker (new pool, new consumer)
    // finishes it from the stored position.
    const due = await findDueAutomationRuns(fx.dbs.app);
    expect(due).toContainEqual({ tenantId: c.tenant.id, runId: run.id, actorUserId: null });
    const worker2 = await startConsumer();
    for (const item of due.filter((d) => d.runId === run.id)) {
      await signalAutomationRun({ jobs: fx.jobs(), signer: fx.signer }, null, {
        tenantId: item.tenantId,
        runId: item.runId,
        actorUserId: item.actorUserId,
        key: 'sweep:test',
      });
    }
    // The new worker sends the next message and holds the run until Meta accepts it.
    await waitFor(async () => (await botMessages(conv)).length === 2);
    expect((await onlyRun(conv)).status).toBe('running');
    expect(await sendQueued(c, conv)).toEqual(['accepted']);
    await waitFor(async () => (await onlyRun(conv)).status === 'handed_off');
    await worker2.kill();
    expect((await botMessages(conv)).map((m) => m.content.text ?? m.content.body)).toEqual([
      'Hi Priya Customer, how can we help?',
      'Connecting you to our team.',
    ]);
    expect((await stepLog(run.id)).map((s) => [s.seq, s.outcome])).toEqual([
      [0, 'started'],
      [1, 'asked'],
      [2, 'answered'],
      [3, 'sent'],
      [4, 'handed_off'],
    ]);
  });

  it('fails a run whose step keeps raising an error, and passes the conversation to people', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Menu', keyword('menu'), menuGraph());
    const from = waId();
    const conv = await inbound(c, from, 'menu');
    const run = await onlyRun(conv);
    const broken: JobQueue = {
      async enqueue(tx, queue, envelope, options) {
        if (queue === QUEUES.messageSend.name) throw new Error('simulated persistent failure');
        return fx.jobs().enqueue(tx, queue, envelope, options);
      },
      async enqueueMany(tx, queue, jobs) {
        return fx.jobs().enqueueMany(tx, queue, jobs);
      },
    };
    const attempt = () =>
      advanceAutomationRun(
        runnerDeps(systemClock, broken),
        authorizedTenantScope(c.tenant.id, null),
        run.id,
        null,
      );
    const state = async () => {
      const [row] = await fx.query<{ status: string; failures: number }>(
        `SELECT status, failures FROM app.automation_runs WHERE id = $1`,
        [run.id],
      );
      return row;
    };

    // Each attempt still fails the job with its error; the run only counts the attempts, and a
    // step that succeeds starts the count again.
    await expect(attempt()).rejects.toThrow('simulated persistent failure');
    await expect(attempt()).rejects.toThrow('simulated persistent failure');
    expect(await state()).toEqual({ status: 'running', failures: 2 });
    expect(await advance(c, run.id)).toEqual({ outcome: 'waiting', steps: 1 });
    expect(await state()).toEqual({ status: 'waiting', failures: 0 });

    // Meta accepts the question and the customer answers (that step commits); sending the next
    // message keeps failing.
    await sendQueued(c, conv);
    await inbound(c, from, 'Talk to us');
    for (let i = 1; i < MAX_STEP_FAILURES; i += 1) {
      await expect(attempt()).rejects.toThrow('simulated persistent failure');
      expect(await state()).toEqual({ status: 'running', failures: i });
    }
    await expect(attempt()).rejects.toThrow('simulated persistent failure');
    expect(await onlyRun(conv)).toMatchObject({ status: 'failed', end_reason: 'error' });
    expect((await stepLog(run.id)).map((s) => [s.outcome, s.detail])).toEqual([
      ['started', 'keyword'],
      ['asked', null],
      ['answered', null],
      ['failed', 'step_error'],
    ]);
    expect(await botMessages(conv)).toHaveLength(1);
    // The conversation is back with people: a hand-off turn is open and no run holds it.
    expect((await turns(conv)).at(-1)).toMatchObject({ start_reason: 'handoff', end_reason: null });
    const inbox = createInboxService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    expect((await inbox.getConversation(owner, conv)).automation).toBeNull();
    // Later signals find nothing to do.
    expect(await attempt()).toEqual({ outcome: 'idle', steps: 0 });
  });

  it('waits for Meta to accept each message, and hands over when one does not reach the customer', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Hello', keyword('hello'), {
      version: 1,
      start: 'hi',
      nodes: [
        { id: 'hi', type: 'send_text', text: 'Hi there!', next: 'bye' },
        { id: 'bye', type: 'end' },
      ],
    });
    await publish(owner, 'Menu', keyword('menu'), menuGraph());

    // After queuing its message the run holds: no further step, and no completion, until Meta
    // accepts the message.
    const conv = await inbound(c, waId(), 'hello');
    const run = await onlyRun(conv);
    expect(await advance(c, run.id)).toEqual({ outcome: 'sending', steps: 1 });
    expect(await advance(c, run.id)).toEqual({ outcome: 'not_due', steps: 0 });
    expect(await onlyRun(conv)).toMatchObject({ status: 'running', current_node_id: 'bye' });
    // Meta rejects it: the run fails instead of completing, and the conversation goes to people.
    fx.standIn.state.sendQueue.push({
      kind: 'error',
      status: 400,
      code: 131026,
      title: 'Message undeliverable',
    });
    expect(await sendQueued(c, conv)).toEqual(['failed']);
    // The send worker signalled the run in the same transaction (no wait for the sweep).
    const signals = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND singleton_key LIKE $2`,
      [QUEUES.automationRun.name, `${run.id}:s:%`],
    );
    expect(signals[0]!.n).toBe(1);
    expect((await advance(c, run.id)).outcome).toBe('ended');
    expect(await onlyRun(conv)).toMatchObject({ status: 'failed', end_reason: 'send_failed' });
    expect((await stepLog(run.id)).at(-1)).toMatchObject({
      outcome: 'failed',
      detail: 'failed:131026',
    });
    expect((await turns(conv)).at(-1)).toMatchObject({ start_reason: 'handoff', end_reason: null });

    // A failure Meta reports later ends a run that is waiting for the customer's reply.
    const zed = waId();
    const conv2 = await inbound(c, zed, 'menu');
    const run2 = await onlyRun(conv2);
    expect((await advance(c, run2.id)).outcome).toBe('waiting');
    expect(await sendQueued(c, conv2)).toEqual(['accepted']);
    expect((await advance(c, run2.id)).outcome).toBe('not_due');
    expect(await onlyRun(conv2)).toMatchObject({ status: 'waiting', waiting_for: 'reply' });
    const [question] = await botMessages(conv2);
    await fx.deliver(
      fx.messagesBody(c, {
        statuses: [
          {
            id: question!.external_message_id,
            status: 'failed',
            timestamp: String(Math.floor(Date.now() / 1000)),
            recipient_id: zed,
            errors: [{ code: 131026, title: 'Message undeliverable' }],
          },
        ],
      }),
    );
    expect((await advance(c, run2.id)).outcome).toBe('ended');
    expect(await onlyRun(conv2)).toMatchObject({ status: 'failed', end_reason: 'send_failed' });

    // A message Meta has not accepted after 10 minutes fails the run, and is cancelled so it
    // cannot go out late.
    const conv3 = await inbound(c, waId(), 'hello');
    const run3 = await onlyRun(conv3);
    expect((await advance(c, run3.id)).outcome).toBe('sending');
    expect((await advance(c, run3.id, later(9 * 60_000))).outcome).toBe('not_due');
    expect((await advance(c, run3.id, later(11 * 60_000))).outcome).toBe('ended');
    expect(await onlyRun(conv3)).toMatchObject({ status: 'failed', end_reason: 'send_failed' });
    expect((await stepLog(run3.id)).at(-1)).toMatchObject({ detail: 'send_timeout' });
    expect((await botMessages(conv3)).map((m) => m.status)).toEqual(['canceled']);
  });

  it('waits on timers and reply deadlines and fails runs that exceed a budget', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Follow up', keyword('follow'), {
      version: 1,
      start: 'wait',
      nodes: [
        { id: 'wait', type: 'wait', minutes: 5, next: 'ping' },
        { id: 'ping', type: 'send_text', text: 'Following up, {{name}}.', next: 'ask' },
        {
          id: 'ask',
          type: 'ask_text',
          text: 'Anything else?',
          saveAs: 'more',
          format: 'any',
          retryText: null,
          retries: 0,
          invalidNext: null,
          timeoutMinutes: 10,
          timeoutNext: 'bye',
          next: null,
        },
        { id: 'bye', type: 'send_text', text: 'Bye for now.', next: null },
      ],
    });
    const conv = await inbound(c, waId(), 'follow up please');
    const run = await onlyRun(conv);
    expect((await advance(c, run.id)).outcome).toBe('waiting');
    expect(await onlyRun(conv)).toMatchObject({ waiting_for: 'timer', current_node_id: 'wait' });
    expect((await advance(c, run.id)).outcome).toBe('not_due');
    expect((await drive(c, conv, run.id, later(6 * 60_000))).outcome).toBe('waiting');
    expect(await onlyRun(conv)).toMatchObject({ waiting_for: 'reply', current_node_id: 'ask' });
    await sendQueued(c, conv);
    expect((await advance(c, run.id, later(7 * 60_000))).outcome).toBe('not_due');
    expect((await drive(c, conv, run.id, later(17 * 60_000))).outcome).toBe('ended');
    expect((await botMessages(conv)).map((m) => m.content.text)).toEqual([
      'Following up, Priya Customer.',
      'Anything else?',
      'Bye for now.',
    ]);
    expect((await stepLog(run.id)).map((s) => s.outcome)).toEqual([
      'started',
      'waiting',
      'resumed',
      'sent',
      'asked',
      'timed_out',
      'sent',
    ]);

    // A loop through a timer that never ends fails at the loop budget and returns to people.
    await publish(owner, 'Pinger', keyword('ping'), {
      version: 1,
      start: 'ping',
      nodes: [
        { id: 'ping', type: 'send_text', text: 'Ping', next: 'pause' },
        { id: 'pause', type: 'wait', minutes: 1, next: 'ping' },
      ],
    });
    const conv2 = await inbound(c, waId(), 'ping');
    const run2 = await onlyRun(conv2);
    let outcome = await drive(c, conv2, run2.id);
    for (let i = 1; i <= 30 && outcome.outcome !== 'ended'; i += 1) {
      outcome = await drive(c, conv2, run2.id, later(i * 61_000));
    }
    expect(await onlyRun(conv2)).toMatchObject({
      status: 'failed',
      end_reason: 'budget_loop',
      message_count: 20,
    });
    expect((await turns(conv2)).at(-1)).toMatchObject({
      start_reason: 'handoff',
      end_reason: null,
    });
  });

  it('stops on an opt-out, clears answers on erasure, and fails when the window has closed', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Menu', keyword('menu'), menuGraph());

    const jon = waId();
    const conv = await inbound(c, jon, 'menu');
    const run = await onlyRun(conv);
    await advance(c, run.id);
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: jon, text: 'STOP' }] }));
    expect(await onlyRun(conv)).toMatchObject({
      status: 'stopped',
      end_reason: 'opted_out',
      input_message_id: null,
    });
    expect((await botMessages(conv)).map((m) => m.status)).toEqual(['canceled']);
    expect((await turns(conv)).at(-1)).toMatchObject({ start_reason: 'handoff', end_reason: null });

    // A marketing opt-out stops the run too: it is never taken as the answer to a question.
    const ria = waId();
    const convM = await inbound(c, ria, 'menu');
    const runM = await onlyRun(convM);
    await advance(c, runM.id);
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: ria, text: 'Stop promotions' }] }));
    expect(await onlyRun(convM)).toMatchObject({
      status: 'stopped',
      end_reason: 'opted_out',
      input_message_id: null,
    });

    // Erasure clears captured answers and stops the contact's active run.
    const kim = waId();
    const conv2 = await inbound(c, kim, 'menu');
    const run2 = await onlyRun(conv2);
    await advance(c, run2.id);
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: kim, text: 'order status' }] }));
    await sendQueued(c, conv2);
    await drive(c, conv2, run2.id);
    expect((await onlyRun(conv2)).variables).toEqual({ topic: 'Order status' });
    const [contact] = await fx.query<{ contact_id: string }>(
      `SELECT contact_id FROM app.conversations WHERE id = $1`,
      [conv2],
    );
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: contact!.contact_id,
      suppress: false,
    });
    expect(await onlyRun(conv2)).toMatchObject({
      status: 'stopped',
      end_reason: 'contact_erased',
      variables: {},
    });
    expect((await turns(conv2)).filter((t) => t.end_reason === null)).toEqual([]);

    // A step that must send after the 24-hour window fails and passes the conversation to people.
    const lee = waId();
    const conv3 = await inbound(c, lee, 'menu');
    const run3 = await onlyRun(conv3);
    await advance(c, run3.id);
    await sendQueued(c, conv3);
    expect((await advance(c, run3.id, later(25 * 3600_000))).outcome).toBe('ended');
    expect(await onlyRun(conv3)).toMatchObject({ status: 'completed', end_reason: 'end_node' });
    const conv4 = await inbound(c, waId(), 'menu');
    const run4 = await onlyRun(conv4);
    expect((await advance(c, run4.id, later(25 * 3600_000))).outcome).toBe('ended');
    expect(await onlyRun(conv4)).toMatchObject({ status: 'failed', end_reason: 'send_blocked' });
    expect((await stepLog(run4.id)).at(-1)).toMatchObject({
      outcome: 'failed',
      detail: 'window_closed',
    });
  });

  it('runs test versions of a draft on a conversation the member can see', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const svc = automations();
    const { id } = await svc.createAutomation(owner, { name: 'Draft bot' });
    const saved = await svc.updateAutomation(owner, {
      id,
      expectedVersion: 0,
      name: 'Draft bot',
      description: null,
      channelAccountId: null,
      trigger: { type: 'any_message', hours: 'any', cooldownMinutes: 0 },
      graph: {
        version: 1,
        start: 'hi',
        nodes: [{ id: 'hi', type: 'send_text', text: 'Test hello', next: null }],
      },
    });
    const conv = await inbound(c, waId(), 'hi');
    expect(await runsOf(conv)).toEqual([]);
    await expectAppError(
      svc.startTestRun(agent, { id, expectedVersion: saved.version, conversationId: conv }),
      'forbidden',
    );
    const { runId } = await svc.startTestRun(owner, {
      id,
      expectedVersion: saved.version,
      conversationId: conv,
    });
    await expectAppError(
      svc.startTestRun(owner, { id, expectedVersion: saved.version, conversationId: conv }),
      'conflict',
      /already handling/,
    );
    const tick = () =>
      advanceAutomationRun(
        runnerDeps(),
        authorizedTenantScope(c.tenant.id, c.owner.id),
        runId,
        c.owner.id,
      );
    // The message goes out; the run completes once Meta has accepted it.
    expect((await tick()).outcome).toBe('sending');
    expect(await onlyRun(conv)).toMatchObject({ status: 'running', current_node_id: null });
    expect(await sendQueued(c, conv)).toEqual(['accepted']);
    expect((await tick()).outcome).toBe('ended');
    expect(await onlyRun(conv)).toMatchObject({
      mode: 'test',
      trigger_type: 'test',
      status: 'completed',
    });
    expect((await botMessages(conv)).map((m) => m.content.text)).toEqual(['Test hello']);
    const [intent] = await fx.query<{ actor_user_id: string }>(
      `SELECT s.actor_user_id FROM app.send_intents s JOIN app.messages m ON m.id = s.message_id
        WHERE m.conversation_id = $1 AND m.sender_type = 'bot'`,
      [conv],
    );
    expect(intent?.actor_user_id).toBe(c.owner.id);
    // An unchanged draft reuses its test snapshot; a published version list stays empty.
    await svc.startTestRun(owner, { id, expectedVersion: saved.version, conversationId: conv });
    const snapshots = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.automation_versions WHERE automation_id = $1 AND kind = 'test'`,
      [id],
    );
    expect(snapshots[0]!.n).toBe(1);
    expect((await svc.getAutomation(owner, id)).versions).toEqual([]);
    const detail = await svc.getRun(owner, runId);
    expect(detail).toMatchObject({ mode: 'test', startedByName: 'Owner', conversationId: conv });
    expect(detail.log.map((s) => s.outcome)).toEqual(['started', 'sent']);

    // A tester who may no longer run tests stops their run at its next step, before it sends.
    await fx.query(
      `UPDATE app.memberships SET roles = '{marketer,supervisor}' WHERE tenant_id = $1 AND user_id = $2`,
      [c.tenant.id, c.marketer.id],
    );
    const tester = await fx.ctx(c, c.marketer);
    const conv2 = await inbound(c, waId(), 'hi again');
    const second = await svc.startTestRun(tester, {
      id,
      expectedVersion: saved.version,
      conversationId: conv2,
    });
    await fx.query(
      `UPDATE app.memberships SET roles = '{marketer}' WHERE tenant_id = $1 AND user_id = $2`,
      [c.tenant.id, c.marketer.id],
    );
    expect(
      (
        await advanceAutomationRun(
          runnerDeps(),
          authorizedTenantScope(c.tenant.id, c.marketer.id),
          second.runId,
          c.marketer.id,
        )
      ).outcome,
    ).toBe('ended');
    expect(await onlyRun(conv2)).toMatchObject({ status: 'failed', end_reason: 'error' });
    expect((await stepLog(second.runId)).at(-1)).toMatchObject({
      outcome: 'failed',
      detail: 'tester_not_permitted',
    });
    expect(await botMessages(conv2)).toEqual([]);
  });

  it('reports automation outcomes and leaves automated time out of reply times', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Hello', keyword('hello'), {
      version: 1,
      start: 'hi',
      nodes: [{ id: 'hi', type: 'send_text', text: 'Hi there!', next: null }],
    });
    await publish(owner, 'Menu', keyword('menu'), menuGraph());
    const conv1 = await inbound(c, waId(), 'hello');
    await drive(c, conv1, (await onlyRun(conv1)).id);
    const pat = waId();
    const conv2 = await inbound(c, pat, 'menu');
    await advance(c, (await onlyRun(conv2)).id);
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: pat, text: 'talk to us' }] }));
    await sendQueued(c, conv2);
    await drive(c, conv2, (await onlyRun(conv2)).id);
    await inbound(c, waId(), 'menu');
    // A test run is not a customer-started run.
    const conv4 = await inbound(c, waId(), 'hi');
    const svc = automations();
    const draft = await svc.createAutomation(owner, { name: 'Draft' });
    await svc.startTestRun(owner, { id: draft.id, expectedVersion: 0, conversationId: conv4 });

    const report = await createReportsService({ db: fx.dbs.app, clock: systemClock }).getReport(
      owner,
      { preset: 'last_7_days' },
    );
    expect(report.automations.totals).toEqual({
      started: 3,
      active: 1,
      completed: 1,
      handed_off: 1,
      taken_over: 0,
      stopped: 0,
      failed: 0,
    });
    expect(report.automations.shares.completed).toEqual({ numerator: 1, denominator: 2 });
    expect(report.automations.automations.map((a) => [a.name, a.started, a.active])).toEqual([
      ['Menu', 2, 1],
      ['Hello', 1, 0],
    ]);
    // Four customer messages opened turns that automations (the test run too) took over; they are
    // left out. Only the hand-off turn counts, and it is waiting for a member.
    expect(report.inbox.turns).toMatchObject({ started: 1, answered: 0, waiting: 1 });
    expect(report.inbox.now.waiting).toBe(1);
    const csv = await createReportsService({ db: fx.dbs.app, clock: systemClock }).exportSection(
      owner,
      { preset: 'last_7_days' },
      'automations',
    );
    expect(csv.body.split('\r\n')[0]).toContain('runs_started');
  });

  it('starts no run while the company is suspended, and applies retention to ended runs', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Menu', keyword('menu'), menuGraph());
    await fx.dbs.adminPool.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [
      c.tenant.id,
    ]);
    const conv = await inbound(c, waId(), 'menu');
    expect(await runsOf(conv)).toEqual([]);
    await fx.dbs.adminPool.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [
      c.tenant.id,
    ]);

    // An ended run with a captured answer: answers go after 30 days, the run after 180.
    const moe = waId();
    const conv2 = await inbound(c, moe, 'menu');
    const run = await onlyRun(conv2);
    await advance(c, run.id);
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: moe, text: 'talk to us' }] }));
    await sendQueued(c, conv2);
    await drive(c, conv2, run.id);
    expect(await onlyRun(conv2)).toMatchObject({
      status: 'handed_off',
      variables: { topic: 'Talk to us' },
    });
    // Backdating needs the retention setting (ended runs are guarded).
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('w360.allow_retention_purge', 'on', true)`);
      await client.query(
        `UPDATE app.automation_runs SET started_at = started_at - interval '31 days',
                ended_at = ended_at - interval '31 days' WHERE id = $1`,
        [run.id],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await applyAutomationRetention(fx.dbs.app);
    expect(await onlyRun(conv2)).toMatchObject({ status: 'handed_off', variables: {} });
    const client2 = await fx.dbs.adminPool.connect();
    try {
      await client2.query('BEGIN');
      await client2.query(`SELECT set_config('w360.allow_retention_purge', 'on', true)`);
      await client2.query(
        `UPDATE app.automation_runs SET started_at = started_at - interval '150 days',
                ended_at = ended_at - interval '150 days' WHERE id = $1`,
        [run.id],
      );
      await client2.query('COMMIT');
    } finally {
      client2.release();
    }
    await applyAutomationRetention(fx.dbs.app);
    expect(await runsOf(conv2)).toEqual([]);
    expect(await stepLog(run.id)).toEqual([]);
  });

  it('keeps automations and runs inside their company', async () => {
    const a = await fx.company();
    const b = await fx.company();
    const ownerA = await fx.ctx(a, a.owner);
    const ownerB = await fx.ctx(b, b.owner);
    const { id } = await publish(ownerA, 'Menu', keyword('menu'), menuGraph());
    const conv = await inbound(a, waId(), 'menu');
    const run = await onlyRun(conv);
    const svc = automations();
    await expectAppError(svc.getAutomation(ownerB, id), 'not_found');
    await expectAppError(svc.getRun(ownerB, run.id), 'not_found');
    await expectAppError(svc.stopRun(ownerB, run.id), 'not_found');
    expect((await svc.listRuns(ownerB, {})).runs).toEqual([]);
    expect((await svc.listRuns(ownerA, {})).runs.map((r) => r.id)).toEqual([run.id]);
    // A job for company B carrying company A's run finds nothing.
    expect((await advance(b, run.id)).outcome).toBe('idle');
    expect((await onlyRun(conv)).step_count).toBe(0);
    // Company B's customer saying "menu" starts nothing in either company.
    const convB = await inbound(b, waId(), 'menu');
    expect(await runsOf(convB)).toEqual([]);
    // Stopping from the automation page returns the conversation to people.
    await svc.stopRun(ownerA, run.id);
    expect(await onlyRun(conv)).toMatchObject({
      status: 'stopped',
      end_reason: 'stopped_by_member',
    });
  });
});

// A consumer shaped like the worker's automation handler, with its own pool and pg-boss instance.
async function startConsumer() {
  const dbs = connectTestDatabases({ appPoolMax: 3 });
  const boss = new PgBoss({
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
  const jobs = new PgBossJobQueue(boss);
  await boss.work(
    QUEUES.automationRun.name,
    { batchSize: 1, pollingIntervalSeconds: 0.5 },
    async ([job]: Job<unknown>[]) => {
      if (!job) return;
      const auth = await authorizeJob({ db: dbs.app, signer: fx.signer }, job.data, {
        expectedKind: 'automation.run',
        requireActiveTenant: true,
        requireActiveActor: true,
      });
      if (auth.outcome !== 'authorized' || !auth.scope) return;
      await advanceAutomationRun(
        { db: dbs.app, jobs, signer: fx.signer, clock: systemClock, keyring: fx.keyring },
        auth.scope,
        auth.envelope.ref,
        auth.envelope.actorUserId,
      );
    },
  );
  return {
    async kill() {
      await boss.stop({ graceful: false, close: true });
      await dbs.close();
    },
  };
}

/** Polls a condition (every 100 ms, up to 20 s); jobs run asynchronously in pg-boss. */
async function waitFor(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met within 20 s');
}
