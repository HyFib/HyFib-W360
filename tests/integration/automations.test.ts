import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { PgBoss, type Job } from 'pg-boss';
import { isAppError, sha256Hex, systemClock, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope, type Database } from '@w360/db';
import {
  localDateAfter,
  advanceAutomationRun,
  apiSendReaction,
  apiSendText,
  apiUpdateConversation,
  applyAutomationRetention,
  authenticateApiToken,
  authorizeJob,
  createApiKeysService,
  createAutomationService,
  createBusinessHoursService,
  createContactsService,
  createCrmService,
  createInboxService,
  createPlanAdminService,
  createReportsService,
  createTeamsService,
  dayOf,
  findDueAutomationRuns,
  MAX_STEP_FAILURES,
  PgBossJobQueue,
  RUN_CSV_COLUMNS,
  processSendIntent,
  queueTextMessage,
  routeDueConversations,
  signalAutomationRun,
  type AutomationTrigger,
  type JobQueue,
  type PlatformActor,
  type TenantContext,
} from '@w360/domain';
import { connectTestDatabases, createUser } from './helpers';
import {
  nextExternalId,
  startWhatsAppFixture,
  type Company,
  type WhatsAppFixture,
} from './whatsapp-fixture';

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

let planCodes = 0;
/** Moves the company to a published plan with `modules` (P5-01), as platform staff would. */
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
  const { id: planId } = await plans.createPlan(actor, {
    code: `au-${Date.now().toString(36)}-${planCodes}`,
    name: 'Automations plan',
    price: '999',
    intervalMonths: '1',
    trialDays: '0',
    graceDays: '7',
    seatsIncluded: '10',
    numbersIncluded: '5',
    modules,
  });
  await plans.publishPlan(actor, planId);
  const view = await plans.tenantPlan(actor, c.tenant.id);
  await plans.setTenantPlan(actor, {
    tenantId: c.tenant.id,
    version: view.state.version,
    status: 'active',
    planId,
    periodStart: dayOf(new Date(), 'Asia/Kolkata'),
    periodEnd: dayOf(new Date(Date.now() + 30 * 86_400_000), 'Asia/Kolkata'),
    reason: 'Plan for the automation tests',
  });
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

describe('keyword triggers with small typos (ADR-240)', () => {
  it('start on a typo only when the trigger allows them, and lose to a match without typos', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const refunds = await publish(
      owner,
      'Refunds',
      {
        type: 'keyword',
        keywords: ['refund'],
        match: 'contains',
        typos: true,
        hours: 'any',
        cooldownMinutes: 0,
      },
      menuGraph(),
    );
    const deliveries = await publish(owner, 'Deliveries', keyword('delivery'), menuGraph());
    const startedBy = (conversationId: string) =>
      fx.query<{ automation_id: string; trigger_type: string }>(
        `SELECT automation_id, trigger_type FROM app.automation_runs WHERE conversation_id = $1`,
        [conversationId],
      );

    // A typo starts the automation that allows them, as a keyword start.
    const typo = await inbound(c, waId(), 'I want a refnud');
    expect(await startedBy(typo)).toEqual([{ automation_id: refunds.id, trigger_type: 'keyword' }]);
    // Without the option, a typo starts nothing.
    const strict = await inbound(c, waId(), 'where is my delivry');
    expect(await startedBy(strict)).toEqual([]);
    // A message that matches another automation without typos starts that one.
    const both = await inbound(c, waId(), 'refnud for my delivery');
    expect(await startedBy(both)).toEqual([
      { automation_id: deliveries.id, trigger_type: 'keyword' },
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

  it('exports the runs the list shows as CSV, without customer data, audited (ADR-237)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const { id: automationId } = await publish(owner, 'Menu, main', keyword('menu'), menuGraph());
    const from = waId();
    const conv = await inbound(c, from, 'Menu');
    const run = await onlyRun(conv);
    await advance(c, run.id);
    const { status } = await onlyRun(conv);
    expect(['running', 'waiting']).toContain(status);
    const svc = automations();
    const read = async (ctx: TenantContext, input: unknown = {}) => {
      let out = '';
      for await (const chunk of svc.exportRuns(ctx, input, { ipAddress: '203.0.113.9' })) {
        out += chunk;
      }
      return out
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n');
    };

    const lines = await read(owner);
    expect(lines[0]).toBe(RUN_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(2);
    expect(lines[1]?.startsWith(`${run.id},"Menu, main",1,live,${status},`)).toBe(true);
    expect(lines[1]).toContain(',keyword,');
    // Nothing about the customer: neither the number nor the conversation.
    expect(lines[1]).not.toContain(from);
    expect(lines[1]).not.toContain(conv);
    // The list's filters apply; an unknown status is refused.
    expect(await read(owner, { automationId, status: 'active' })).toHaveLength(2);
    expect(await read(owner, { status: 'completed' })).toEqual([RUN_CSV_COLUMNS.join(',')]);
    await expectAppError(read(owner, { status: 'paused' }), 'validation_failed');
    // Agents do not read automations.
    await expectAppError(read(agent), 'forbidden');
    const audits = await fx.query<{
      metadata: { automationId: string | null; status: string | null };
    }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'automation.runs_exported' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(audits.map((a) => a.metadata)).toEqual([
      { automationId: null, status: null },
      { automationId, status: 'active' },
      { automationId: null, status: 'completed' },
    ]);
    // Another company's export holds none of these runs.
    const other = await fx.company();
    expect(await read(await fx.ctx(other, other.owner))).toEqual([RUN_CSV_COLUMNS.join(',')]);
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

  it('keeps the bot answering when the public API reacts to the customer’s message; a quoted reply takes over like any reply (ADR-082)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Menu', keyword('menu'), menuGraph());
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Helpdesk', scopes: ['messages.reply'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    const idem = (k: string) => ({ key: k, requestHash: sha256Hex(k) });

    const ivy = waId();
    const conv = await inbound(c, ivy, 'menu');
    const run = await onlyRun(conv);
    await advance(c, run.id);
    const [menu] = await fx.query<{ id: string }>(
      `SELECT id FROM app.messages WHERE conversation_id = $1 AND direction = 'inbound'`,
      [conv],
    );
    const before = { run: await onlyRun(conv), turns: await turns(conv) };
    expect((await botMessages(conv)).map((m) => m.status)).toEqual(['queued']);

    // A reaction is not an answer: the run, its queued question and the waiting turn stay.
    const reacted = await apiSendReaction(
      runnerDeps(),
      key,
      { type: 'reaction', to: `+${ivy}`, replyTo: menu!.id, emoji: '👍' },
      idem('react-1'),
    );
    expect(reacted.status).toBe(201);
    expect(await onlyRun(conv)).toEqual(before.run);
    expect(await turns(conv)).toEqual(before.turns);
    expect((await botMessages(conv)).map((m) => m.status)).toEqual(['queued']);
    expect(await sendQueued(c, conv)).toEqual(['accepted', 'accepted']);
    const toIvy = fx.standIn.state.requests.filter(
      (r) => (r.body as { to?: unknown } | undefined)?.to === ivy,
    );
    expect(toIvy.map((r) => (r.body as { type: string }).type)).toEqual([
      'interactive',
      'reaction',
    ]);
    await advance(c, run.id);
    expect((await onlyRun(conv)).status).toBe('waiting');

    // A reply that quotes the customer's message takes the conversation over, as replies do.
    await apiSendText(
      runnerDeps(),
      key,
      { type: 'text', to: `+${ivy}`, text: 'Here is the menu.', replyTo: menu!.id },
      idem('reply-1'),
    );
    expect(await onlyRun(conv)).toMatchObject({ status: 'taken_over', end_reason: 'api_replied' });
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
    const resolved = await apiUpdateConversation(runnerDeps(), key, conv, {
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

  it('hands the conversation to a member the public API assigns, and a team move leaves the bot answering (ADR-093)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await publish(owner, 'Menu', keyword('menu'), menuGraph());
    const teams = createTeamsService({ db: fx.dbs.app, clock: systemClock });
    const { teamId } = await teams.createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      memberIds: [agent.membership.id],
    });
    await teams.setAvailability(agent, { available: true });
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Router', scopes: ['conversations.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');

    const ivy = waId();
    const conv = await inbound(c, ivy, 'menu');
    const run = await onlyRun(conv);
    await advance(c, run.id);
    expect((await botMessages(conv)).map((m) => m.status)).toEqual(['queued']);
    const answering = await onlyRun(conv);

    // Moved to a round-robin team while the bot answers: routing leaves the conversation to it.
    expect(await apiUpdateConversation(runnerDeps(), key, conv, { teamId })).toMatchObject({
      teamId,
      assigned: false,
    });
    expect(await onlyRun(conv)).toMatchObject({
      status: answering.status,
      end_reason: null,
    });

    // Assigned to a member: the run is taken over and its queued message cancelled.
    expect(
      await apiUpdateConversation(runnerDeps(), key, conv, { assigneeId: agent.membership.id }),
    ).toMatchObject({ assigneeId: agent.membership.id, status: 'open' });
    expect(await onlyRun(conv)).toMatchObject({ status: 'taken_over', end_reason: 'assigned' });
    const [ended] = await fx.query<{ ended_by_membership_id: string | null }>(
      'SELECT ended_by_membership_id FROM app.automation_runs WHERE id = $1',
      [run.id],
    );
    expect(ended?.ended_by_membership_id).toBeNull();
    expect((await stepLog(run.id)).at(-1)).toMatchObject({
      outcome: 'taken_over',
      detail: 'assigned',
    });
    expect((await botMessages(conv)).map((m) => [m.status, m.error_code])).toEqual([
      ['canceled', 'bot_stopped'],
    ]);
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
      async raisePriority(tx, queue, singletonKey, priority) {
        return fx.jobs().raisePriority(tx, queue, singletonKey, priority);
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
      async raisePriority(tx, queue, singletonKey, priority) {
        return fx.jobs().raisePriority(tx, queue, singletonKey, priority);
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

describe('a run and a member changing the same tag at once (ADR-114)', () => {
  /** A company whose automation, started by "tagme", changes one tag, and a run waiting to do it. */
  async function taggingRun(action: { kind: 'add_tag' | 'remove_tag'; tag: string }) {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Tagger', keyword('tagme'), {
      version: 1,
      start: 'tag',
      nodes: [{ id: 'tag', type: 'update_contact', action, next: null }],
    });
    const conversationId = await inbound(c, waId(), 'tagme please');
    const run = await onlyRun(conversationId);
    const [row] = await fx.query<{ contact_id: string }>(
      'SELECT contact_id FROM app.conversations WHERE id = $1',
      [conversationId],
    );
    return { c, runId: run.id, contactId: row!.contact_id };
  }

  /**
   * Holds the contact for update, as the contacts page and the API do while they change its tags,
   * until the run's step waits for it; then changes the tag itself and commits. Returns how the
   * step ended.
   */
  async function whileMemberHolds(
    c: Company,
    runId: string,
    contactId: string,
    member: (holder: pg.PoolClient) => Promise<unknown>,
  ) {
    const holder: pg.PoolClient = await fx.dbs.adminPool.connect();
    let step: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM app.contacts WHERE id = $1 FOR UPDATE', [contactId]);
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      step = advance(c, runId).then(
        () => 'done',
        (error: unknown) => error,
      );
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the step is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
      await member(holder);
      await holder.query('COMMIT');
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    } finally {
      holder.release();
    }
    return step;
  }

  const tagsOf = async (contactId: string) =>
    (
      await fx.query<{ tag: string }>(
        'SELECT tag FROM app.contact_tags WHERE contact_id = $1 ORDER BY tag',
        [contactId],
      )
    ).map((r) => r.tag);

  it('removes a tag a member is removing too, one after the other, without a deadlock', async () => {
    const { c, runId, contactId } = await taggingRun({ kind: 'remove_tag', tag: 'vip' });
    await fx.query(
      `INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag) VALUES ($1, $2, $3, 'vip')`,
      [uuidv7(), c.tenant.id, contactId],
    );
    // Without the step's lock on the contact before the tag, the step would hold the tag's row
    // while its change record waits for the contact, and the member would wait for the tag's row.
    const step = await whileMemberHolds(c, runId, contactId, (holder) =>
      holder.query(
        `DELETE FROM app.contact_tags WHERE tenant_id = $1 AND contact_id = $2 AND tag = 'vip'`,
        [c.tenant.id, contactId],
      ),
    );
    expect(step).toBe('done');
    expect(await tagsOf(contactId)).toEqual([]);
  });

  it('adds a tag a member is adding too, once, without a deadlock', async () => {
    const { c, runId, contactId } = await taggingRun({ kind: 'add_tag', tag: 'hot lead' });
    const step = await whileMemberHolds(c, runId, contactId, (holder) =>
      holder.query(
        `INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag)
         VALUES ($1, $2, $3, 'hot lead') ON CONFLICT DO NOTHING`,
        [uuidv7(), c.tenant.id, contactId],
      ),
    );
    expect(step).toBe('done');
    expect(await tagsOf(contactId)).toEqual(['hot lead']);
  });
});

describe('automations that tag the conversation (ADR-222)', () => {
  /** Triage: a conversation already tagged refund ends; another is tagged refund and loses "new". */
  const triage = {
    version: 1,
    start: 'check',
    nodes: [
      {
        id: 'check',
        type: 'condition',
        match: 'all',
        rules: [{ kind: 'conversation_tag', op: 'has', tag: 'Refund' }],
        then: 'already',
        else: 'tag',
      },
      { id: 'already', type: 'end' },
      {
        id: 'tag',
        type: 'update_conversation',
        action: { kind: 'add_tag', tag: ' REFUND ' },
        next: 'untag',
      },
      {
        id: 'untag',
        type: 'update_conversation',
        action: { kind: 'remove_tag', tag: 'new' },
        next: null,
      },
    ],
  };

  const tagsOf = async (conversationId: string) =>
    (
      await fx.query<{ tag: string }>(
        'SELECT tag FROM app.conversation_tags WHERE conversation_id = $1 ORDER BY tag',
        [conversationId],
      )
    ).map((r) => r.tag);

  const tagConversation = (c: Company, conversationId: string, tags: string[]) =>
    Promise.all(
      tags.map((tag) =>
        fx.query(
          `INSERT INTO app.conversation_tags (id, tenant_id, conversation_id, tag)
           VALUES ($1, $2, $3, $4)`,
          [uuidv7(), c.tenant.id, conversationId, tag],
        ),
      ),
    );

  it('tags and untags the run’s conversation, and branches on its tags', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Triage', keyword('refund'), triage);

    // Not tagged yet: tagged refund (written as tags are), and "new" taken off.
    const fresh = await inbound(c, waId(), 'refund please');
    await tagConversation(c, fresh, ['new']);
    const [before] = await fx.query<{ updated_at: Date }>(
      'SELECT updated_at FROM app.conversations WHERE id = $1',
      [fresh],
    );
    const run = await onlyRun(fresh);
    expect((await drive(c, fresh, run.id)).outcome).toBe('ended');
    expect(await tagsOf(fresh)).toEqual(['refund']);
    expect((await stepLog(run.id)).map((s) => [s.node_id, s.outcome, s.branch, s.detail])).toEqual(
      expect.arrayContaining([
        ['check', 'branched', 'no', null],
        ['tag', 'updated', null, null],
        ['untag', 'updated', null, null],
      ]),
    );
    const [after] = await fx.query<{ updated_at: Date }>(
      'SELECT updated_at FROM app.conversations WHERE id = $1',
      [fresh],
    );
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
    const [events] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.tenant_events
        WHERE conversation_id = $1 AND type = 'conversation.tags'`,
      [fresh],
    );
    expect(events!.n).toBe(2);
    // The inbox shows the run's tag.
    const inbox = createInboxService({ db: fx.dbs.app, clock: systemClock });
    expect((await inbox.getConversation(owner, fresh)).conversation.tags).toEqual(['refund']);

    // Already tagged: the condition takes the yes branch and nothing changes.
    const tagged = await inbound(c, waId(), 'refund again');
    await tagConversation(c, tagged, ['refund', 'new']);
    const second = await onlyRun(tagged);
    await drive(c, tagged, second.id);
    expect((await stepLog(second.id)).map((s) => [s.node_id, s.branch])).toEqual(
      expect.arrayContaining([['check', 'yes']]),
    );
    expect(await tagsOf(tagged)).toEqual(['new', 'refund']);
  });

  it('leaves a conversation with 20 tags as it is, saying why in the step log', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publish(owner, 'Triage', keyword('refund'), triage);
    const full = await inbound(c, waId(), 'refund now');
    const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
    await tagConversation(c, full, twenty);
    const run = await onlyRun(full);
    expect((await drive(c, full, run.id)).outcome).toBe('ended');
    expect(await tagsOf(full)).toEqual([...twenty].sort());
    expect((await stepLog(run.id)).find((s) => s.node_id === 'tag')?.detail).toBe(
      'conversation_too_many_tags',
    );
  });
});

describe('automations that create CRM tasks (ADR-244)', () => {
  /** A callback task for `assignee`, due in 4 hours, then a message to the customer. */
  const callback = (assignee: string, task: Record<string, unknown> = {}) => ({
    version: 1,
    start: 'task',
    nodes: [
      {
        id: 'task',
        type: 'create_task',
        title: 'Call {{name}} back',
        assigneeMembershipId: assignee,
        dueInHours: 4,
        next: 'thanks',
        ...task,
      },
      { id: 'thanks', type: 'send_text', text: 'Someone will call you soon.', next: null },
    ],
  });

  const tasksOf = (tenantId: string) =>
    fx.query<{
      id: string;
      title: string;
      contact_id: string;
      assignee_membership_id: string;
      due_at: Date | null;
      status: string;
      created_by_membership_id: string | null;
      created_by_automation_id: string | null;
    }>(
      `SELECT id, title, contact_id, assignee_membership_id, due_at, status,
              created_by_membership_id, created_by_automation_id
         FROM app.crm_tasks WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );

  it('creates the task for the chosen member about the run’s contact, as the automation', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const { id: automationId } = await publish(
      owner,
      'Callbacks',
      keyword('call me'),
      callback(agent.membership.id),
    );
    const conversationId = await inbound(c, waId(), 'please call me');
    const run = await onlyRun(conversationId);
    const before = Date.now();
    expect((await drive(c, conversationId, run.id)).outcome).toBe('ended');
    const after = Date.now();

    const [contact] = await fx.query<{ contact_id: string }>(
      'SELECT contact_id FROM app.conversations WHERE id = $1',
      [conversationId],
    );
    const tasks = await tasksOf(c.tenant.id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task).toMatchObject({
      title: 'Call Priya Customer back',
      contact_id: contact!.contact_id,
      assignee_membership_id: agent.membership.id,
      status: 'open',
      created_by_membership_id: null,
      created_by_automation_id: automationId,
    });
    expect(task.due_at!.getTime()).toBeGreaterThanOrEqual(before + 4 * 3_600_000);
    expect(task.due_at!.getTime()).toBeLessThanOrEqual(after + 4 * 3_600_000);
    // On the contact's CRM timeline, created by no member, naming the automation and the run.
    expect(
      await fx.query(
        `SELECT kind, actor_membership_id, data FROM app.crm_activities
          WHERE tenant_id = $1 AND task_id = $2`,
        [c.tenant.id, task.id],
      ),
    ).toEqual([
      {
        kind: 'task_created',
        actor_membership_id: null,
        data: { automationId, runId: run.id },
      },
    ]);
    expect((await stepLog(run.id)).map((s) => [s.node_id, s.outcome, s.detail])).toEqual(
      expect.arrayContaining([
        ['task', 'created', null],
        ['thanks', 'sent', null],
      ]),
    );
  });

  it('emails the member a reminder when the task is due, when the step asks (ADR-246)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await publish(
      owner,
      'Callbacks',
      keyword('call me'),
      callback(agent.membership.id, { remind: true }),
    );
    const conversationId = await inbound(c, waId(), 'call me tomorrow');
    const run = await onlyRun(conversationId);
    expect((await drive(c, conversationId, run.id)).outcome).toBe('ended');
    const [task] = await fx.query<{
      id: string;
      due_at: Date;
      remind_at: Date | null;
      reminder_state: string;
    }>(`SELECT id, due_at, remind_at, reminder_state FROM app.crm_tasks WHERE tenant_id = $1`, [
      c.tenant.id,
    ]);
    expect(task).toMatchObject({ reminder_state: 'pending', remind_at: task!.due_at });
    // The reminder job waits for the due time, as for a member's task with a reminder.
    const [job] = await fx.query<{ start_after: Date }>(
      `SELECT start_after FROM pgboss.job WHERE name = $1 AND singleton_key = $2`,
      [QUEUES.crmReminder.name, `${task!.id}:${task!.due_at.getTime()}`],
    );
    expect(job?.start_after).toEqual(task!.due_at);
  });

  it('creates no task for a member who can no longer use the CRM, says why and goes on', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await publish(owner, 'Callbacks', keyword('call me'), callback(agent.membership.id));
    await fx.query(`UPDATE app.memberships SET status = 'suspended' WHERE id = $1`, [
      agent.membership.id,
    ]);
    const conversationId = await inbound(c, waId(), 'call me please');
    const run = await onlyRun(conversationId);
    expect((await drive(c, conversationId, run.id)).outcome).toBe('ended');
    expect(await tasksOf(c.tenant.id)).toEqual([]);
    const log = await stepLog(run.id);
    expect(log.find((s) => s.node_id === 'task')).toMatchObject({
      outcome: 'skipped',
      detail: 'task_assignee_unavailable',
    });
    expect(log.find((s) => s.node_id === 'thanks')?.outcome).toBe('sent');
  });

  it('is published only for an active member who can use the CRM, by a member who may edit the CRM', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    // A marketer cannot use the CRM: no task can be for them.
    await expectAppError(
      publish(owner, 'Callbacks', keyword('call me'), callback(marketer.membership.id)),
      'precondition_failed',
      /active member who can use the CRM/,
    );
    // A member whose roles do not let them edit the CRM cannot publish or test a task step.
    const agent = await fx.ctx(c, c.agent);
    const noCrm: TenantContext = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((p) => p !== 'crm.write')),
    };
    // (Each attempt creates its automation before publishing, so each has a name of its own.)
    await expectAppError(
      publish(noCrm, 'Agent callbacks', keyword('call me'), callback(agent.membership.id)),
      'forbidden',
      /permission to edit the CRM/,
    );
  });
});

describe('automations that create CRM deals (ADR-245)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });

  /** A company with a Sales pipeline (INR) and an automation that opens a deal in its first stage. */
  async function setup(
    options: {
      owner?: (c: Company) => Promise<string | null>;
      value?: string | null;
      closeInDays?: number;
    } = {},
  ) {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id: pipelineId } = await crm().createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New', 'Qualified'],
    });
    const [pipeline] = (await crm().listPipelines(owner)).filter((p) => p.id === pipelineId);
    const stageId = pipeline!.stages[0]!.id;
    const dealOwner = options.owner ? await options.owner(c) : null;
    const { id: automationId } = await publish(owner, 'Leads', keyword('price'), {
      version: 1,
      start: 'deal',
      nodes: [
        {
          id: 'deal',
          type: 'create_deal',
          title: 'Kettles for {{name}}',
          pipelineId,
          stageId,
          value: options.value === undefined ? '2,500.50' : options.value,
          ownerMembershipId: dealOwner,
          ...(options.closeInDays === undefined ? {} : { closeInDays: options.closeInDays }),
          next: 'thanks',
        },
        { id: 'thanks', type: 'send_text', text: 'We will send you a quote.', next: null },
      ],
    });
    return { c, owner, pipelineId, stageId, automationId };
  }

  const dealsOf = (tenantId: string) =>
    fx.query<{
      id: string;
      title: string;
      pipeline_id: string;
      stage_id: string;
      contact_id: string;
      conversation_id: string | null;
      value_minor: string | null;
      owner_membership_id: string | null;
      status: string;
      created_by_membership_id: string | null;
      created_by_automation_id: string | null;
    }>(
      `SELECT id, title, pipeline_id, stage_id, contact_id, conversation_id, value_minor,
              owner_membership_id, status, created_by_membership_id, created_by_automation_id
         FROM app.crm_deals WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );

  it('creates the deal for the run’s contact and conversation, as the automation, once while it is open', async () => {
    const s = await setup({
      owner: async (c) => (await fx.ctx(c, c.agent)).membership.id,
      closeInDays: 30,
    });
    const agent = await fx.ctx(s.c, s.c.agent);
    const from = waId();
    const conversationId = await inbound(s.c, from, 'what is the price?');
    const run = await onlyRun(conversationId);
    const before = new Date();
    expect((await drive(s.c, conversationId, run.id)).outcome).toBe('ended');
    const after = new Date();
    const [contact] = await fx.query<{ contact_id: string }>(
      'SELECT contact_id FROM app.conversations WHERE id = $1',
      [conversationId],
    );
    const deals = await dealsOf(s.c.tenant.id);
    expect(deals).toEqual([
      expect.objectContaining({
        title: 'Kettles for Priya Customer',
        pipeline_id: s.pipelineId,
        stage_id: s.stageId,
        contact_id: contact!.contact_id,
        conversation_id: conversationId,
        value_minor: '250050',
        owner_membership_id: agent.membership.id,
        status: 'open',
        created_by_membership_id: null,
        created_by_automation_id: s.automationId,
      }),
    ]);
    // Expected to close 30 days after the step ran, on the company's calendar (ADR-247).
    const [close] = await fx.query<{ close_on: string }>(
      'SELECT expected_close_on::text AS close_on FROM app.crm_deals WHERE id = $1',
      [deals[0]!.id],
    );
    expect([
      localDateAfter(before, 'Asia/Kolkata', 30),
      localDateAfter(after, 'Asia/Kolkata', 30),
    ]).toContain(close!.close_on);
    expect(
      await fx.query(
        `SELECT kind, actor_membership_id, data FROM app.crm_activities
          WHERE tenant_id = $1 AND deal_id = $2`,
        [s.c.tenant.id, deals[0]!.id],
      ),
    ).toEqual([
      {
        kind: 'deal_created',
        actor_membership_id: null,
        data: {
          stageId: s.stageId,
          valueMinor: 250050,
          automationId: s.automationId,
          runId: run.id,
        },
      },
    ]);
    // The deal page says an automation created it.
    const detail = await crm().getDeal(s.owner, deals[0]!.id);
    expect(detail).toMatchObject({ createdBy: null, createdByAutomation: true });

    // The customer asks again: the open deal is not created twice, and the run goes on.
    const again = await inbound(s.c, from, 'price again please');
    const runs = await runsOf(again);
    const second = runs.at(-1)!;
    expect((await drive(s.c, again, second.id)).outcome).toBe('ended');
    expect(await dealsOf(s.c.tenant.id)).toHaveLength(1);
    const log = await stepLog(second.id);
    expect(log.find((st) => st.node_id === 'deal')).toMatchObject({
      outcome: 'skipped',
      detail: 'deal_already_open',
    });
    expect(log.find((st) => st.node_id === 'thanks')?.outcome).toBe('sent');
  });

  it('leaves out an owner who can no longer use the CRM, and skips an archived stage', async () => {
    const s = await setup({
      owner: async (c) => (await fx.ctx(c, c.agent)).membership.id,
      value: null,
    });
    const agent = await fx.ctx(s.c, s.c.agent);
    await fx.query(`UPDATE app.memberships SET status = 'suspended' WHERE id = $1`, [
      agent.membership.id,
    ]);
    const conversationId = await inbound(s.c, waId(), 'price?');
    const run = await onlyRun(conversationId);
    expect((await drive(s.c, conversationId, run.id)).outcome).toBe('ended');
    expect(await dealsOf(s.c.tenant.id)).toEqual([
      expect.objectContaining({ owner_membership_id: null, value_minor: null }),
    ]);
    expect((await stepLog(run.id)).find((st) => st.node_id === 'deal')).toMatchObject({
      outcome: 'created',
      detail: 'deal_owner_unavailable',
    });

    // The pipeline is archived: another customer's run creates nothing and goes on.
    await fx.query(`UPDATE app.crm_pipelines SET archived_at = now() WHERE id = $1`, [
      s.pipelineId,
    ]);
    const other = await inbound(s.c, waId(), 'price please');
    const otherRun = await onlyRun(other);
    expect((await drive(s.c, other, otherRun.id)).outcome).toBe('ended');
    expect(await dealsOf(s.c.tenant.id)).toHaveLength(1);
    expect((await stepLog(otherRun.id)).find((st) => st.node_id === 'deal')).toMatchObject({
      outcome: 'skipped',
      detail: 'deal_stage_unavailable',
    });
  });

  it('is published only with an active stage, a value in the pipeline’s currency and an owner who can use the CRM', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    const { id: pipelineId } = await crm().createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New'],
    });
    const [pipeline] = (await crm().listPipelines(owner)).filter((p) => p.id === pipelineId);
    const stageId = pipeline!.stages[0]!.id;
    const graph = (deal: Record<string, unknown>) => ({
      version: 1,
      start: 'deal',
      nodes: [
        {
          id: 'deal',
          type: 'create_deal',
          title: 'Deal',
          pipelineId,
          stageId,
          value: null,
          ownerMembershipId: null,
          next: null,
          ...deal,
        },
      ],
    });
    await expectAppError(
      publish(owner, 'Leads', keyword('price'), graph({ value: '12.345' })),
      'precondition_failed',
      /amount in INR/,
    );
    // (Each attempt creates its automation before publishing, so each has a name of its own.)
    await expectAppError(
      publish(
        owner,
        'Owned leads',
        keyword('price'),
        graph({ ownerMembershipId: marketer.membership.id }),
      ),
      'precondition_failed',
      /own the deal/,
    );
    await fx.query(`UPDATE app.crm_stages SET archived_at = now() WHERE id = $1`, [stageId]);
    await expectAppError(
      publish(owner, 'Archived leads', keyword('price'), graph({})),
      'precondition_failed',
      /active stage of an active pipeline/,
    );
  });

  it('creates no task or deal once the plan leaves out the CRM, says why and goes on (ADR-249)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const { id: pipelineId } = await crm().createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New'],
    });
    const [pipeline] = (await crm().listPipelines(owner)).filter((p) => p.id === pipelineId);
    const graph = {
      version: 1,
      start: 'task',
      nodes: [
        {
          id: 'task',
          type: 'create_task',
          title: 'Call {{name}}',
          assigneeMembershipId: agent.membership.id,
          dueInHours: null,
          next: 'deal',
        },
        {
          id: 'deal',
          type: 'create_deal',
          title: 'Kettles for {{name}}',
          pipelineId,
          stageId: pipeline!.stages[0]!.id,
          value: null,
          ownerMembershipId: null,
          next: 'move',
        },
        // A step that moves the deal (ADR-250) follows the plan too.
        {
          id: 'move',
          type: 'move_deal',
          pipelineId,
          stageId: pipeline!.stages[0]!.id,
          next: 'thanks',
        },
        { id: 'thanks', type: 'send_text', text: 'We will be in touch.', next: null },
      ],
    };
    await publish(owner, 'Leads', keyword('price'), graph);
    // Platform staff move the company to a plan without the CRM.
    await onPlan(c, ['automations', 'flows']);

    const conversationId = await inbound(c, waId(), 'price please');
    const run = await onlyRun(conversationId);
    expect((await drive(c, conversationId, run.id)).outcome).toBe('ended');
    expect(
      await fx.query('SELECT id FROM app.crm_tasks WHERE tenant_id = $1', [c.tenant.id]),
    ).toEqual([]);
    expect(await dealsOf(c.tenant.id)).toEqual([]);
    const log = await stepLog(run.id);
    for (const nodeId of ['task', 'deal', 'move']) {
      expect(
        log.find((st) => st.node_id === nodeId),
        nodeId,
      ).toMatchObject({
        outcome: 'skipped',
        detail: 'crm_not_in_plan',
      });
    }
    expect(log.find((st) => st.node_id === 'thanks')?.outcome).toBe('sent');
    // Nor can such steps be published, whatever the member's roles.
    await expectAppError(
      publish(await fx.ctx(c, c.owner), 'More leads', keyword('quote'), graph),
      'forbidden',
      /does not include CRM/,
    );
  });

  it('moves the contact’s open deal as the automation, and nothing when it cannot tell which (ADR-250)', async () => {
    const s = await setup();
    const [pipeline] = (await crm().listPipelines(s.owner)).filter((p) => p.id === s.pipelineId);
    const qualified = pipeline!.stages[1]!.id;
    const { id: moverId } = await publish(s.owner, 'Payments', keyword('paid'), {
      version: 1,
      start: 'move',
      nodes: [
        {
          id: 'move',
          type: 'move_deal',
          pipelineId: s.pipelineId,
          stageId: qualified,
          next: 'thanks',
        },
        { id: 'thanks', type: 'send_text', text: 'Thank you for paying.', next: null },
      ],
    });
    const moveOf = async (runId: string) =>
      (await stepLog(runId)).find((st) => st.node_id === 'move');
    const runIn = async (conversationId: string) => {
      const run = (await runsOf(conversationId)).at(-1)!;
      expect((await drive(s.c, conversationId, run.id)).outcome).toBe('ended');
      return run;
    };

    // A customer without a deal: nothing moves, and the run goes on.
    const stranger = await runIn(await inbound(s.c, waId(), 'I paid'));
    expect(await moveOf(stranger.id)).toMatchObject({
      outcome: 'skipped',
      detail: 'deal_not_open',
    });
    expect((await stepLog(stranger.id)).find((st) => st.node_id === 'thanks')?.outcome).toBe(
      'sent',
    );

    // A customer asks the price (their deal is created), then pays: the deal moves.
    const from = waId();
    const conversationId = await inbound(s.c, from, 'what is the price?');
    await runIn(conversationId);
    const [deal] = await dealsOf(s.c.tenant.id);
    const row = async (id: string) =>
      (
        await fx.query<{ stage_id: string; version: number; stage_entered_at: Date }>(
          'SELECT stage_id, version, stage_entered_at FROM app.crm_deals WHERE id = $1',
          [id],
        )
      )[0]!;
    const before = await row(deal!.id);
    await inbound(s.c, from, 'I have paid');
    const mover = await runIn(conversationId);
    expect(await moveOf(mover.id)).toMatchObject({ outcome: 'moved', detail: null });
    const moved = await row(deal!.id);
    expect(moved).toMatchObject({ stage_id: qualified, version: before.version + 1 });
    expect(moved.stage_entered_at.getTime()).toBeGreaterThan(before.stage_entered_at.getTime());
    // On the deal's timeline as a member's move is, by the automation.
    expect(
      await fx.query(
        `SELECT actor_membership_id, data FROM app.crm_activities
          WHERE deal_id = $1 AND kind = 'stage_changed'`,
        [deal!.id],
      ),
    ).toEqual([
      {
        actor_membership_id: null,
        data: {
          fromStageId: s.stageId,
          toStageId: qualified,
          automationId: moverId,
          runId: mover.id,
        },
      },
    ]);

    // Paying again: the deal is already there.
    await inbound(s.c, from, 'paid again');
    const again = await runIn(conversationId);
    expect(await moveOf(again.id)).toMatchObject({ outcome: 'skipped', detail: 'deal_in_stage' });

    // A member opens a second deal for the customer in the pipeline: which one is meant is not
    // known, so nothing moves.
    const { id: second } = await crm().createDeal(s.owner, {
      contactId: deal!.contact_id,
      pipelineId: s.pipelineId,
      stageId: s.stageId,
      title: 'Spare kettle',
    });
    await inbound(s.c, from, 'paid for both');
    const both = await runIn(conversationId);
    expect(await moveOf(both.id)).toMatchObject({ outcome: 'skipped', detail: 'deal_ambiguous' });
    expect((await row(second)).stage_id).toBe(s.stageId);
    expect((await row(deal!.id)).version).toBe(moved.version);
  });

  it('is published only with an active stage, by a member who may edit the CRM (ADR-250)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id: pipelineId } = await crm().createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New', 'Won'],
    });
    const [pipeline] = (await crm().listPipelines(owner)).filter((p) => p.id === pipelineId);
    const graph = {
      version: 1,
      start: 'move',
      nodes: [
        {
          id: 'move',
          type: 'move_deal',
          pipelineId,
          stageId: pipeline!.stages[1]!.id,
          next: null,
        },
      ],
    };
    const noCrm: TenantContext = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((p) => p !== 'crm.write')),
    };
    await expectAppError(
      publish(noCrm, 'Payments', keyword('paid'), graph),
      'forbidden',
      /permission to edit the CRM/,
    );
    await fx.query(`UPDATE app.crm_stages SET archived_at = now() WHERE id = $1`, [
      pipeline!.stages[1]!.id,
    ]);
    // (Each attempt creates its automation before publishing, so each has a name of its own.)
    await expectAppError(
      publish(owner, 'Archived payments', keyword('paid'), graph),
      'precondition_failed',
      /to move the deal to/,
    );
  });
});

describe('automations that send a form (ADR-248)', () => {
  /** A form of the company's WhatsApp account, at Meta with `status`. */
  async function form(c: Company, status = 'PUBLISHED') {
    const id = uuidv7();
    const metaFlowId = nextExternalId();
    const publicId = Array.from(
      { length: 16 },
      () => 'abcdefghijklmnopqrstuvwxyz234567'[randomInt(32)],
    ).join('');
    await fx.query(
      `INSERT INTO app.flows (id, tenant_id, whatsapp_account_id, public_id, name, categories,
         flow_json, json_version, first_screen, meta_flow_id, meta_status, created_by_membership_id)
       VALUES ($1, $2, $3, $4, 'Booking', ARRAY['APPOINTMENT_BOOKING'], '{}', '7.2', 'START', $5, $6, $7)`,
      [
        id,
        c.tenant.id,
        c.whatsappAccountId,
        publicId,
        metaFlowId,
        status,
        c.tenant.ownerMembershipId,
      ],
    );
    return { id, metaFlowId };
  }

  const booking = (flowId: string) => ({
    version: 1,
    start: 'form',
    nodes: [
      {
        id: 'form',
        type: 'send_flow',
        flowId,
        header: null,
        body: 'Hi {{name}}, pick a time.',
        footer: null,
        cta: 'Book now',
        next: null,
      },
    ],
  });

  it('sends the form with a new token for the conversation, as the automation', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const flow = await form(c);
    await publish(owner, 'Bookings', keyword('book'), booking(flow.id));
    const conversationId = await inbound(c, waId(), 'book a visit');
    const run = await onlyRun(conversationId);
    const before = Date.now();
    expect((await drive(c, conversationId, run.id)).outcome).toBe('ended');
    const [sent] = await fx.query<{
      id: string;
      type: string;
      content: { flow: Record<string, unknown>; automationRunId: string };
      sender_type: string;
    }>(
      `SELECT id, type, content, sender_type FROM app.messages
        WHERE conversation_id = $1 AND direction = 'outbound'`,
      [conversationId],
    );
    expect(sent).toMatchObject({
      type: 'interactive',
      sender_type: 'bot',
      content: {
        flow: {
          id: flow.id,
          name: 'Booking',
          mode: 'published',
          body: 'Hi Priya Customer, pick a time.',
          cta: 'Book now',
        },
        automationRunId: run.id,
      },
    });
    const [record] = await fx.query<{
      flow_id: string;
      contact_id: string;
      token: string;
      mode: string;
      sent_by_membership_id: string | null;
      expires_at: Date;
    }>(
      `SELECT flow_id, contact_id, token, mode, sent_by_membership_id, expires_at
         FROM app.flow_sends WHERE message_id = $1`,
      [sent!.id],
    );
    expect(record).toMatchObject({
      flow_id: flow.id,
      mode: 'published',
      sent_by_membership_id: null,
    });
    expect(record!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record!.expires_at.getTime()).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
    // Sent to WhatsApp as Meta's form message, with the token and the published mode.
    const [intent] = await fx.query<{ request: Record<string, unknown> }>(
      'SELECT request FROM app.send_intents WHERE message_id = $1',
      [sent!.id],
    );
    expect(intent!.request).toMatchObject({
      interactive: {
        type: 'flow',
        body: { text: 'Hi Priya Customer, pick a time.' },
        action: {
          name: 'flow',
          parameters: {
            flow_id: flow.metaFlowId,
            flow_cta: 'Book now',
            flow_token: record!.token,
            mode: 'published',
          },
        },
      },
    });
    expect((await stepLog(run.id)).map((st) => [st.node_id, st.outcome])).toEqual(
      expect.arrayContaining([['form', 'sent']]),
    );
  });

  it('does not send a form that is no longer published: the run passes the conversation to people', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const flow = await form(c);
    await publish(owner, 'Bookings', keyword('book'), booking(flow.id));
    await fx.query(`UPDATE app.flows SET meta_status = 'DEPRECATED' WHERE id = $1`, [flow.id]);
    const conversationId = await inbound(c, waId(), 'book please');
    const run = await onlyRun(conversationId);
    expect((await drive(c, conversationId, run.id)).outcome).toBe('ended');
    expect(await onlyRun(conversationId)).toMatchObject({
      status: 'failed',
      end_reason: 'send_blocked',
    });
    expect((await stepLog(run.id)).find((st) => st.node_id === 'form')).toMatchObject({
      outcome: 'failed',
      detail: 'flow_unavailable',
    });
    expect(
      await fx.query('SELECT id FROM app.flow_sends WHERE conversation_id = $1', [conversationId]),
    ).toEqual([]);
  });

  it('is published only with a published form', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const draft = await form(c, 'DRAFT');
    await expectAppError(
      publish(owner, 'Bookings', keyword('book'), booking(draft.id)),
      'precondition_failed',
      /Publish the form/,
    );
  });

  it('sends no form, and publishes no form step, when the plan leaves out WhatsApp Flows', async () => {
    const c = await fx.company();
    const flow = await form(c);
    await publish(await fx.ctx(c, c.owner), 'Bookings', keyword('book'), booking(flow.id));
    // Platform staff move the company to a plan with automations but without forms.
    await onPlan(c, ['automations']);

    // The automation still runs, but its form is not sent: the run passes the conversation on.
    const conversationId = await inbound(c, waId(), 'book a table');
    const run = await onlyRun(conversationId);
    expect((await drive(c, conversationId, run.id)).outcome).toBe('ended');
    expect(await onlyRun(conversationId)).toMatchObject({
      status: 'failed',
      end_reason: 'send_blocked',
    });
    expect((await stepLog(run.id)).find((st) => st.node_id === 'form')).toMatchObject({
      outcome: 'failed',
      detail: 'flows_not_in_plan',
    });
    expect(
      await fx.query('SELECT id FROM app.flow_sends WHERE conversation_id = $1', [conversationId]),
    ).toEqual([]);
    // Nor can a form step be published, as a form cannot be sent in the inbox.
    await expectAppError(
      publish(await fx.ctx(c, c.owner), 'More bookings', keyword('visit'), booking(flow.id)),
      'forbidden',
      /does not include WhatsApp Flows/,
    );
  });
});

/** Polls a condition (every 100 ms, up to 20 s); jobs run asynchronously in pg-boss. */
async function waitFor(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met within 20 s');
}
