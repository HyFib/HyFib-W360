import { describe, expect, it } from 'vitest';
import {
  RUN_BUDGETS,
  checkGraph,
  matchTrigger,
  parseGraph,
  parseTrigger,
  renderText,
  type AutomationGraph,
} from './graph';
import {
  advance,
  botButtonId,
  initialRunState,
  parseBotButtonId,
  type RunEvent,
  type RunFacts,
  type RunState,
  type StepResult,
} from './interpreter';

const RUN = '0190a3e4-1111-7000-8000-000000000001';
const NOW = new Date('2026-09-26T10:00:00Z');
const facts: RunFacts = {
  contactName: 'Asha',
  companyName: 'Acme',
  tags: new Set(['vip']),
  fields: { orders: 3, city: 'Pune' },
  businessOpen: true,
};

function graphOf(input: unknown): AutomationGraph {
  const parsed = parseGraph(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.graph;
}

const support = graphOf({
  version: 1,
  start: 'menu',
  nodes: [
    {
      id: 'menu',
      type: 'ask_buttons',
      header: null,
      body: 'Hi {{name}}, how can {{company}} help?',
      footer: null,
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
      text: 'Your order number?',
      saveAs: 'order_no',
      format: 'number',
      retryText: 'Numbers only, please.',
      retries: 1,
      invalidNext: 'agent',
      timeoutMinutes: 30,
      timeoutNext: 'bye',
      next: 'thanks',
    },
    {
      id: 'thanks',
      type: 'send_text',
      text: 'Thanks, order {{answer.order_no}} noted.',
      next: 'tag',
    },
    {
      id: 'tag',
      type: 'update_contact',
      action: { kind: 'add_tag', tag: 'Asked Order' },
      next: null,
    },
    { id: 'agent', type: 'handoff', teamId: null },
    { id: 'bye', type: 'end' },
  ],
});

function step(graph: AutomationGraph, state: RunState, event: RunEvent, f = facts): StepResult {
  return advance({ graph, state, event, facts: f, runId: RUN, now: NOW });
}

/** Runs `continue` steps until the run waits or ends. */
function runUntilStop(graph: AutomationGraph, state: RunState, f = facts) {
  const results: StepResult[] = [];
  let current = state;
  for (let i = 0; i < 500; i += 1) {
    const r = step(graph, current, { kind: 'continue' }, f);
    results.push(r);
    current = r.state;
    if (r.status !== 'running') break;
  }
  return { results, last: results.at(-1) as StepResult };
}

describe('automation graph checks', () => {
  it('reports missing targets, unreachable steps, unsaved answers and unknown placeholders', () => {
    const graph = graphOf({
      version: 1,
      start: 'a',
      nodes: [
        { id: 'a', type: 'send_text', text: 'Hello {{answer.city}} {{agent}}', next: 'missing' },
        { id: 'orphan', type: 'end' },
      ],
    });
    const issues = checkGraph(graph);
    expect(issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/does not exist \(missing\)/),
        expect.stringMatching(/\{\{answer\.city\}\} is not saved/),
        expect.stringMatching(/Unknown placeholder \{\{agent\}\}/),
      ]),
    );
    expect(issues).toContainEqual({
      level: 'warning',
      nodeId: 'orphan',
      message: 'No step leads here.',
    });
    expect(checkGraph(support).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('rejects loops that never wait and accepts loops through a question', () => {
    const busy = graphOf({
      version: 1,
      start: 'a',
      nodes: [
        { id: 'a', type: 'send_text', text: 'ping', next: 'b' },
        {
          id: 'b',
          type: 'condition',
          match: 'all',
          rules: [{ kind: 'business_hours', op: 'open' }],
          then: 'a',
          else: null,
        },
      ],
    });
    expect(checkGraph(busy)).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: expect.stringMatching(/a → b form a loop/),
      }),
    );
    const self = graphOf({
      version: 1,
      start: 'a',
      nodes: [
        { id: 'a', type: 'update_contact', action: { kind: 'add_tag', tag: 'x' }, next: 'a' },
      ],
    });
    expect(checkGraph(self).some((i) => /loop/.test(i.message))).toBe(true);
    const asking = graphOf({
      version: 1,
      start: 'q',
      nodes: [
        {
          id: 'q',
          type: 'ask_text',
          text: 'Again?',
          saveAs: 'a',
          format: 'any',
          retryText: null,
          retries: 0,
          invalidNext: null,
          timeoutMinutes: 5,
          timeoutNext: null,
          next: 'q',
        },
      ],
    });
    expect(checkGraph(asking).some((i) => /loop/.test(i.message))).toBe(false);
  });

  it('checks teams and contact fields when the company’s lists are given', () => {
    const graph = graphOf({
      version: 1,
      start: 'set',
      nodes: [
        {
          id: 'set',
          type: 'update_contact',
          action: { kind: 'set_field', field: 'plan', value: 'gold' },
          next: 'h',
        },
        { id: 'h', type: 'handoff', teamId: '0190a3e4-2222-7000-8000-000000000002' },
      ],
    });
    const messages = checkGraph(graph, { teamIds: new Set(), fieldKeys: new Set(['city']) }).map(
      (i) => i.message,
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        'The contact field “plan” does not exist.',
        'The team no longer exists.',
      ]),
    );
  });

  it('enforces WhatsApp’s interactive message limits', () => {
    const tooMany = parseGraph({
      version: 1,
      start: 'q',
      nodes: [
        {
          id: 'q',
          type: 'ask_buttons',
          header: null,
          body: 'x'.repeat(1025),
          footer: null,
          buttons: [
            { title: 'One', next: null },
            { title: 'one', next: null },
            { title: 'A title longer than twenty', next: null },
            { title: 'Four', next: null },
          ],
          saveAs: null,
          retryText: null,
          retries: 0,
          noMatchNext: null,
          timeoutMinutes: 10,
          timeoutNext: null,
        },
      ],
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      const messages = tooMany.issues.map((i) => i.message);
      expect(messages).toEqual(
        expect.arrayContaining([
          'The question is limited to 1024 characters.',
          'WhatsApp allows at most 3 buttons.',
          'WhatsApp limits button titles to 20 characters.',
        ]),
      );
      expect(tooMany.issues.every((i) => i.nodeId === 'q')).toBe(true);
    }
  });
});

describe('automation triggers', () => {
  it('ranks exact keywords above contained keywords, new conversations and any message', () => {
    const keyword = parseTrigger({
      type: 'keyword',
      keywords: [' Order Status!', 'order status', 'menu'],
      match: 'contains',
      hours: 'any',
      cooldownMinutes: 0,
    });
    expect(keyword.ok && keyword.trigger.type === 'keyword' && keyword.trigger.keywords).toEqual([
      'order status',
      'menu',
    ]);
    if (!keyword.ok) return;
    expect(matchTrigger(keyword.trigger, { text: 'ORDER status', newCase: false })).toBe(0);
    expect(
      matchTrigger(keyword.trigger, { text: 'what is my order status?', newCase: false }),
    ).toBe(1);
    expect(matchTrigger(keyword.trigger, { text: 'menus', newCase: false })).toBeNull();
    const exact = parseTrigger({
      type: 'keyword',
      keywords: ['menu'],
      match: 'exact',
      hours: 'any',
      cooldownMinutes: 0,
    });
    if (!exact.ok) throw new Error('trigger');
    expect(matchTrigger(exact.trigger, { text: 'show the menu', newCase: false })).toBeNull();
    expect(matchTrigger(exact.trigger, { text: 'Menu.', newCase: false })).toBe(0);
    expect(
      matchTrigger(
        { type: 'conversation_started', hours: 'any', cooldownMinutes: 0 },
        { text: 'hi', newCase: true },
      ),
    ).toBe(2);
    expect(
      matchTrigger(
        { type: 'conversation_started', hours: 'any', cooldownMinutes: 0 },
        { text: 'hi', newCase: false },
      ),
    ).toBeNull();
    expect(
      matchTrigger(
        { type: 'any_message', hours: 'any', cooldownMinutes: 0 },
        { text: null, newCase: false },
      ),
    ).toBe(3);
    expect(
      parseTrigger({
        type: 'keyword',
        keywords: ['!!!'],
        match: 'exact',
        hours: 'any',
        cooldownMinutes: 0,
      }),
    ).toEqual({
      ok: false,
      message: 'Keywords need at least one letter or digit.',
    });
  });
});

describe('automation interpreter', () => {
  it('asks with buttons, follows a tap, validates a typed answer and ends', () => {
    let state = initialRunState(support);
    const asked = step(support, state, { kind: 'continue' });
    expect(asked.status).toBe('waiting');
    expect(asked.log).toMatchObject({ nodeId: 'menu', outcome: 'asked' });
    expect(asked.effects).toEqual([
      {
        kind: 'send_buttons',
        header: null,
        body: 'Hi Asha, how can Acme help?',
        footer: null,
        buttons: [
          { id: botButtonId(RUN, 'menu', 1, 0), title: 'Order status' },
          { id: botButtonId(RUN, 'menu', 1, 1), title: 'Talk to us' },
        ],
      },
    ]);
    expect(asked.state.waiting?.until.toISOString()).toBe('2026-09-26T11:00:00.000Z');
    state = asked.state;

    const tapped = step(support, state, {
      kind: 'reply',
      reply: { type: 'button', text: 'Order status', buttonId: botButtonId(RUN, 'menu', 1, 0) },
    });
    expect(tapped).toMatchObject({
      status: 'running',
      log: { outcome: 'answered', branch: 'Order status' },
    });
    expect(tapped.state.variables).toEqual({ topic: 'Order status' });
    state = tapped.state;

    const question = step(support, state, { kind: 'continue' });
    expect(question.effects).toEqual([{ kind: 'send_text', text: 'Your order number?' }]);
    state = question.state;
    const invalid = step(support, state, {
      kind: 'reply',
      reply: { type: 'text', text: 'soon please', buttonId: null },
    });
    expect(invalid).toMatchObject({ status: 'waiting', log: { outcome: 'retried' } });
    expect(invalid.effects).toEqual([{ kind: 'send_text', text: 'Numbers only, please.' }]);
    const valid = step(support, invalid.state, {
      kind: 'reply',
      reply: { type: 'text', text: ' 4512 ', buttonId: null },
    });
    expect(valid).toMatchObject({
      status: 'running',
      log: { outcome: 'answered', branch: 'answer' },
    });

    const rest = runUntilStop(support, valid.state);
    expect(rest.results.map((r) => r.log.outcome)).toEqual(['sent', 'updated']);
    expect(rest.results[0]?.effects).toEqual([
      { kind: 'send_text', text: 'Thanks, order 4512 noted.' },
    ]);
    expect(rest.results[1]?.effects).toEqual([{ kind: 'add_tag', tag: 'asked order' }]);
    expect(rest.last).toMatchObject({ status: 'completed', endReason: 'no_next' });
    expect(rest.last.state.messages).toBe(4);
  });

  it('matches a typed button title, repeats the question once, then takes the other branch', () => {
    const asked = step(support, initialRunState(support), { kind: 'continue' });
    const typed = step(support, asked.state, {
      kind: 'reply',
      reply: { type: 'text', text: 'talk TO us!', buttonId: null },
    });
    expect(typed).toMatchObject({ log: { branch: 'Talk to us' }, state: { nodeId: 'agent' } });

    const unclear = step(support, asked.state, {
      kind: 'reply',
      reply: { type: 'text', text: 'hmm', buttonId: null },
    });
    expect(unclear.log.outcome).toBe('retried');
    expect(unclear.effects[0]).toMatchObject({
      kind: 'send_buttons',
      body: 'Hi Asha, how can Acme help?',
    });
    const still = step(support, unclear.state, {
      kind: 'reply',
      reply: { type: 'other', text: null, buttonId: null },
    });
    expect(still).toMatchObject({
      log: { outcome: 'answered', branch: 'other reply' },
      state: { nodeId: 'agent' },
    });
    const handoff = step(support, still.state, { kind: 'continue' });
    expect(handoff).toMatchObject({
      status: 'handed_off',
      endReason: 'handoff_node',
      effects: [{ kind: 'handoff', teamId: null }],
    });
  });

  it('ignores a tap from an earlier visit or another run and times out', () => {
    const asked = step(support, initialRunState(support), { kind: 'continue' });
    const stale = step(support, asked.state, {
      kind: 'reply',
      reply: { type: 'button', text: 'Order status', buttonId: botButtonId(RUN, 'menu', 7, 0) },
    });
    expect(stale.log.outcome).toBe('retried');
    const otherRun = step(support, asked.state, {
      kind: 'reply',
      reply: {
        type: 'button',
        text: 'Order status',
        buttonId: botButtonId('0190a3e4-9999-7000-8000-000000000009', 'menu', 1, 0),
      },
    });
    expect(otherRun.log.outcome).toBe('retried');
    const timeout = step(support, asked.state, { kind: 'deadline' });
    expect(timeout).toMatchObject({
      log: { outcome: 'timed_out', branch: 'no reply' },
      state: { nodeId: 'bye' },
    });
    expect(step(support, timeout.state, { kind: 'continue' })).toMatchObject({
      status: 'completed',
      endReason: 'end_node',
    });
    expect(parseBotButtonId(botButtonId(RUN, 'menu', 12, 2))).toEqual({
      runId: RUN,
      nodeId: 'menu',
      visit: 12,
      index: 2,
    });
    expect(parseBotButtonId('w360csat:x:1')).toBeNull();
  });

  it('evaluates conditions on answers, fields, tags and business hours', () => {
    const graph = graphOf({
      version: 1,
      start: 'c',
      nodes: [
        {
          id: 'c',
          type: 'condition',
          match: 'all',
          rules: [
            { kind: 'field', field: 'orders', op: 'greater_than', value: '2' },
            { kind: 'tag', op: 'has', tag: 'VIP' },
            { kind: 'business_hours', op: 'open' },
          ],
          then: 'yes',
          else: 'no',
        },
        { id: 'yes', type: 'end' },
        { id: 'no', type: 'end' },
      ],
    });
    expect(step(graph, initialRunState(graph), { kind: 'continue' })).toMatchObject({
      log: { branch: 'yes' },
      state: { nodeId: 'yes' },
    });
    const closed = step(
      graph,
      initialRunState(graph),
      { kind: 'continue' },
      { ...facts, businessOpen: false },
    );
    expect(closed.state.nodeId).toBe('no');
    const fewOrders = step(
      graph,
      initialRunState(graph),
      { kind: 'continue' },
      { ...facts, fields: { orders: 'two' } },
    );
    expect(fewOrders.state.nodeId).toBe('no');
  });

  it('waits on a timer and ignores replies while waiting', () => {
    const graph = graphOf({
      version: 1,
      start: 'w',
      nodes: [
        { id: 'w', type: 'wait', minutes: 90, next: 'm' },
        { id: 'm', type: 'send_text', text: 'Still there, {{name}}?', next: null },
      ],
    });
    const waiting = step(graph, initialRunState(graph), { kind: 'continue' });
    expect(waiting).toMatchObject({ status: 'waiting', log: { outcome: 'waiting' } });
    expect(waiting.state.waiting).toEqual({
      for: 'timer',
      until: new Date('2026-09-26T11:30:00Z'),
    });
    expect(
      step(graph, waiting.state, {
        kind: 'reply',
        reply: { type: 'text', text: 'hi', buttonId: null },
      }).noop,
    ).toBe(true);
    const resumed = step(graph, waiting.state, { kind: 'deadline' });
    expect(resumed).toMatchObject({
      status: 'running',
      log: { outcome: 'resumed' },
      state: { nodeId: 'm', waiting: null },
    });
    expect(
      step(graph, resumed.state, { kind: 'continue' }, { ...facts, contactName: null }).effects,
    ).toEqual([{ kind: 'send_text', text: 'Still there, ?' }]);
  });

  it('fails runs that exhaust a budget or cannot render a message', () => {
    const loop = graphOf({
      version: 1,
      start: 'q',
      nodes: [
        {
          id: 'q',
          type: 'ask_text',
          text: 'Again?',
          saveAs: 'a',
          format: 'any',
          retryText: null,
          retries: 0,
          invalidNext: null,
          timeoutMinutes: 5,
          timeoutNext: null,
          next: 'q',
        },
      ],
    });
    let state = initialRunState(loop);
    let last: StepResult | null = null;
    for (let i = 0; i < 100; i += 1) {
      last = step(loop, state, { kind: 'continue' });
      if (last.status !== 'waiting') break;
      last = step(loop, last.state, {
        kind: 'reply',
        reply: { type: 'text', text: 'yes', buttonId: null },
      });
      state = last.state;
    }
    expect(last).toMatchObject({ status: 'failed', endReason: 'budget_loop' });
    expect(state.visits.q).toBe(RUN_BUDGETS.maxVisitsPerNode);

    const exhausted = step(
      loop,
      { ...initialRunState(loop), steps: RUN_BUDGETS.maxSteps },
      { kind: 'continue' },
    );
    expect(exhausted).toMatchObject({ status: 'failed', endReason: 'budget_steps' });
    const talkative = step(
      loop,
      { ...initialRunState(loop), messages: RUN_BUDGETS.maxMessages },
      { kind: 'continue' },
    );
    expect(talkative).toMatchObject({ status: 'failed', endReason: 'budget_messages' });

    const empty = graphOf({
      version: 1,
      start: 'm',
      nodes: [{ id: 'm', type: 'send_text', text: '{{name}}', next: null }],
    });
    expect(checkGraph(empty)).toContainEqual(
      expect.objectContaining({ level: 'warning', nodeId: 'm' }),
    );
    expect(
      step(empty, initialRunState(empty), { kind: 'continue' }, { ...facts, contactName: null }),
    ).toMatchObject({
      status: 'failed',
      endReason: 'error',
      log: { detail: 'empty_message' },
    });
    expect(
      step(support, { ...initialRunState(support), nodeId: 'gone' }, { kind: 'continue' }),
    ).toMatchObject({
      status: 'failed',
      log: { detail: 'missing_node' },
    });
  });

  it('renders placeholders case-insensitively and leaves unknown ones', () => {
    expect(
      renderText('{{ Name }} / {{COMPANY}} / {{answer.city}} / {{answer.none}} / {{x}}', {
        contactName: 'Asha',
        companyName: 'Acme',
        variables: { city: 'Pune' },
      }),
    ).toBe('Asha / Acme / Pune /  / {{x}}');
  });
});
