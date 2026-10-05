import { describe, expect, it } from 'vitest';
import { TEMPLATE_LIMITS } from '../templates/definition';
import {
  AUTOMATION_LIMITS,
  RUN_BUDGETS,
  checkGraph,
  encodeHeaderValue,
  httpHeaderText,
  matchTrigger,
  parseGraph,
  parseTrigger,
  renderText,
  type AutomationGraph,
} from './graph';
import { valueAtPath } from './http';
import {
  acceptAnswer,
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

  it('checks that answers are saved on the way to the steps that use them', () => {
    const ask = (id: string, next: string | null, timeoutNext: string | null) => ({
      id,
      type: 'ask_text',
      text: 'Your email?',
      saveAs: 'email',
      format: 'email',
      retryText: null,
      retries: 0,
      invalidNext: 'late',
      timeoutMinutes: 30,
      timeoutNext,
      next,
    });
    // The first message uses an answer only a later question saves; the timeout and invalid-answer
    // paths reach steps without it; one step is reached both ways.
    const graph = graphOf({
      version: 1,
      start: 'hello',
      nodes: [
        { id: 'hello', type: 'send_text', text: 'Hi {{answer.email}}', next: 'q' },
        ask('q', 'thanks', 'late'),
        { id: 'thanks', type: 'send_text', text: 'Saved {{answer.email}}.', next: 'check' },
        { id: 'late', type: 'send_text', text: 'No email from {{answer.email}}', next: 'check' },
        {
          id: 'check',
          type: 'condition',
          rules: [{ kind: 'answer', variable: 'email', op: 'contains', value: '@' }],
          match: 'all',
          then: 'known',
          else: 'maybe',
        },
        { id: 'known', type: 'send_text', text: 'We will write to {{answer.email}}.', next: null },
        {
          id: 'maybe',
          type: 'condition',
          rules: [{ kind: 'answer', variable: 'email', op: 'is_set', value: null }],
          match: 'all',
          then: 'bye',
          else: 'bye',
        },
        { id: 'bye', type: 'end' },
      ],
    });
    const issues = checkGraph(graph).map((i) => [i.level, i.nodeId, i.message]);
    expect(issues).toContainEqual([
      'error',
      'hello',
      '{{answer.email}} is used before any question saves it.',
    ]);
    expect(issues).toContainEqual([
      'error',
      'late',
      '{{answer.email}} is used before any question saves it.',
    ]);
    expect(issues).toContainEqual([
      'warning',
      'check',
      'The answer “email” can be unset here: some paths reach this step without saving it.',
    ]);
    expect(issues).toContainEqual([
      'warning',
      'known',
      '{{answer.email}} can be empty here: some paths reach this step without saving it.',
    ]);
    // After the answered edge the answer is always there; “is set” may test a skipped answer.
    expect(issues.filter(([, nodeId]) => nodeId === 'thanks' || nodeId === 'maybe')).toEqual([]);

    // A loop back to the question keeps the answer available only where every path saved it.
    const loop = graphOf({
      version: 1,
      start: 'q',
      nodes: [
        ask('q', 'thanks', 'q'),
        { id: 'thanks', type: 'send_text', text: 'Saved {{answer.email}}.', next: null },
        { id: 'late', type: 'end' },
      ],
    });
    expect(checkGraph(loop).filter((i) => i.message.includes('answer'))).toEqual([]);
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

  it('clips long messages and template variables without splitting an emoji (ADR-133)', () => {
    // Text whose clip falls between the two halves of an emoji, which Meta would get half of.
    const cutAt = (n: number) => `${'x'.repeat(n)}😀 and more`;
    const message = graphOf({
      version: 1,
      start: 'm',
      nodes: [{ id: 'm', type: 'send_text', text: '{{name}}', next: null }],
    });
    const longName = { ...facts, contactName: cutAt(AUTOMATION_LIMITS.textLength - 2) };
    expect(step(message, initialRunState(message), { kind: 'continue' }, longName).effects).toEqual(
      [{ kind: 'send_text', text: `${'x'.repeat(AUTOMATION_LIMITS.textLength - 2)}…` }],
    );
    const template = graphOf({
      version: 1,
      start: 't',
      nodes: [
        {
          id: 't',
          type: 'send_template',
          templateId: '0190a3e4-3333-7000-8000-000000000003',
          header: [],
          body: ['{{name}}'],
          next: null,
        },
      ],
    });
    const longValue = { ...facts, contactName: cutAt(TEMPLATE_LIMITS.parameterValue - 2) };
    expect(
      step(template, initialRunState(template), { kind: 'continue' }, longValue).effects,
    ).toEqual([
      expect.objectContaining({
        kind: 'send_template',
        body: [`${'x'.repeat(TEMPLATE_LIMITS.parameterValue - 2)}…`],
      }),
    ]);
    // An answer, and a value saved from a response, are clipped to the answer limit the same way.
    const answer = cutAt(AUTOMATION_LIMITS.answerLength - 1);
    expect(acceptAnswer('any', { type: 'text', text: answer, buttonId: null })).toBe(
      'x'.repeat(AUTOMATION_LIMITS.answerLength - 1),
    );
    expect(valueAtPath({ data: { status: answer } }, 'data.status')).toBe(
      'x'.repeat(AUTOMATION_LIMITS.answerLength - 1),
    );
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

describe('automation HTTP step', () => {
  const order = (overrides: Record<string, unknown> = {}) =>
    graphOf({
      version: 1,
      start: 'ask',
      nodes: [
        {
          id: 'ask',
          type: 'ask_text',
          text: 'Your order number?',
          saveAs: 'order_no',
          format: 'number',
          retryText: null,
          retries: 0,
          invalidNext: null,
          timeoutMinutes: 30,
          timeoutNext: null,
          next: 'call',
        },
        {
          id: 'call',
          type: 'http_request',
          method: 'POST',
          url: 'https://api.shop.example/orders/{{answer.order_no}}?who={{name}}',
          headers: [{ name: 'Authorization', value: 'Bearer {{secret.shop_token}}' }],
          body: '{"order": "{{answer.order_no}}", "note": "{{name}}"}',
          save: [{ path: 'data.status', saveAs: 'status' }],
          next: 'tell',
          failureNext: 'agent',
          ...overrides,
        },
        { id: 'tell', type: 'send_text', text: 'Your order is {{answer.status}}.', next: null },
        { id: 'agent', type: 'handoff', teamId: null },
      ],
    });
  const refs = {
    allowedDomains: ['api.shop.example', 'hooks.partner.example'],
    secrets: new Map([['shop_token', 'api.shop.example']]),
  };
  const errors = (graph: AutomationGraph, r: Parameters<typeof checkGraph>[1] = refs) =>
    checkGraph(graph, r)
      .filter((i) => i.level === 'error')
      .map((i) => i.message);

  it('checks the address, allowed domains, secrets, the body and saved values', () => {
    expect(errors(order())).toEqual([]);
    // A value saved from a response may be missing, so using it later is only a warning.
    expect(checkGraph(order(), refs)).toContainEqual(
      expect.objectContaining({ level: 'warning', nodeId: 'tell' }),
    );
    expect(errors(order({ url: 'http://api.shop.example/x' }))).toContain(
      'Use an https:// address.',
    );
    expect(
      errors(order({ url: 'http://api.shop.example/x' }), { ...refs, allowInsecureHttp: true }),
    ).toEqual([]);
    expect(errors(order({ url: 'https://{{answer.order_no}}.example/x' }))).toContain(
      'The host name cannot contain placeholders.',
    );
    expect(errors(order({ url: 'https://evil.example/x' }))[0]).toMatch(/not an allowed domain/);
    expect(errors(order(), { ...refs, allowedDomains: ['*.shop.example'] })).toEqual([]);
    expect(errors(order(), { ...refs, allowedDomains: ['*.api.shop.example'] })[0]).toMatch(
      /not an allowed domain/,
    );
    expect(errors(order(), { ...refs, secrets: new Map() })[0]).toMatch(
      /secret “shop_token” does not exist/,
    );
    // A secret is only sent to the domain it was saved for, even if another domain is allowed.
    expect(errors(order({ url: 'https://hooks.partner.example/orders' }))).toContain(
      'The secret “shop_token” can only be sent to api.shop.example.',
    );
    expect(
      errors(order(), {
        ...refs,
        allowedDomains: ['*.shop.example'],
        secrets: new Map([['shop_token', '*.shop.example']]),
      }),
    ).toEqual([]);
    expect(errors(order({ url: 'https://api.shop.example/x?t={{secret.shop_token}}' }))).toContain(
      'Secrets can only be used in header values ({{secret.shop_token}}).',
    );
    expect(errors(order({ body: '{"order": {{answer.order_no}}}' }))).toContain(
      'The body must be JSON, with placeholders inside quotes.',
    );
    expect(errors(order({ method: 'GET' }))).toContain('GET requests have no body.');
    expect(errors(order({ url: 'https://user:pw@api.shop.example/x' }))).toContain(
      'Put credentials in a header, not in the address.',
    );
    expect(
      errors(
        order({
          save: [
            { path: 'data.a', saveAs: 'status' },
            { path: 'data.b', saveAs: 'status' },
          ],
        }),
      ),
    ).toContain('Save each value under a different name.');
    // Headers HyFib owns, and line breaks, are refused when the graph is parsed.
    for (const header of [
      { name: 'Host', value: 'internal' },
      { name: 'Proxy-Authorization', value: 'x' },
      { name: 'X-Note', value: 'a\r\nX-Injected: 1' },
    ]) {
      const raw = JSON.parse(JSON.stringify(order())) as { nodes: Record<string, unknown>[] };
      raw.nodes[1] = { ...raw.nodes[1], headers: [header] };
      expect(parseGraph(raw).ok, header.name).toBe(false);
    }
  });

  it('renders the request, waits for its result and saves values only on success', () => {
    const graph = order();
    const odd = { ...facts, contactName: 'Asha "A" & Co/x' };
    const asked = runUntilStop(graph, initialRunState(graph), odd).last;
    const answered = step(
      graph,
      asked.state,
      { kind: 'reply', reply: { type: 'text', text: '4217', buttonId: null } },
      odd,
    );
    const calling = step(graph, answered.state, { kind: 'continue' }, odd);
    expect(calling).toMatchObject({
      status: 'waiting',
      log: { outcome: 'requested', nodeId: 'call' },
      state: {
        httpCalls: 1,
        waiting: { for: 'http', until: new Date('2026-09-26T10:02:00Z') },
      },
    });
    const [effect] = calling.effects;
    expect(effect).toMatchObject({
      kind: 'http_request',
      method: 'POST',
      url: 'https://api.shop.example/orders/4217?who=Asha%20%22A%22%20%26%20Co%2Fx',
      // The call record keeps the path as written: never the customer's values.
      path: '/orders/{{answer.order_no}}',
      // Secrets stay references: the worker fills them in when it makes the request.
      headers: [{ name: 'Authorization', parts: [{ text: 'Bearer ' }, { secret: 'shop_token' }] }],
      save: [{ path: 'data.status', saveAs: 'status' }],
    });
    expect(JSON.parse((effect as { body: string }).body)).toEqual({
      order: '4217',
      note: 'Asha "A" & Co/x',
    });
    // Customer messages do not answer a request.
    expect(
      step(graph, calling.state, {
        kind: 'reply',
        reply: { type: 'text', text: 'hello?', buttonId: null },
      }).noop,
    ).toBe(true);

    const success = step(graph, calling.state, {
      kind: 'http_result',
      ok: true,
      values: { status: 'shipped', other: 'ignored' },
      detail: '200',
    });
    expect(success).toMatchObject({
      status: 'running',
      log: { outcome: 'responded', branch: 'success', detail: '200' },
      state: { nodeId: 'tell' },
    });
    expect(success.state.variables).toEqual({ order_no: '4217', status: 'shipped' });
    expect(step(graph, success.state, { kind: 'continue' }).effects).toEqual([
      { kind: 'send_text', text: 'Your order is shipped.' },
    ]);

    // A saved value is clipped to the answer limit without splitting an emoji (ADR-133).
    const long = `${'x'.repeat(AUTOMATION_LIMITS.answerLength - 1)}😀`;
    expect(
      step(graph, calling.state, {
        kind: 'http_result',
        ok: true,
        values: { status: long },
        detail: '200',
      }).state.variables,
    ).toEqual({ order_no: '4217', status: 'x'.repeat(AUTOMATION_LIMITS.answerLength - 1) });

    const failure = step(graph, calling.state, {
      kind: 'http_result',
      ok: false,
      values: { status: 'leaked' },
      detail: '503',
    });
    expect(failure).toMatchObject({
      log: { outcome: 'responded', branch: 'failure', detail: '503' },
      state: { nodeId: 'agent', variables: { order_no: '4217' } },
    });
    expect(step(graph, calling.state, { kind: 'deadline' })).toMatchObject({
      log: { outcome: 'responded', branch: 'failure', detail: 'no_result' },
      state: { nodeId: 'agent' },
    });
  });

  it('never reads customer text in a header as a secret, and encodes it for the header', () => {
    const graph = order({
      headers: [
        { name: 'Authorization', value: 'Bearer {{secret.shop_token}}' },
        { name: 'X-Customer', value: '{{name}} / {{answer.order_no}}' },
      ],
    });
    // A profile name is chosen by the customer: here it tries to pull in the company's secret.
    const hostile = { ...facts, contactName: '{{secret.shop_token}}\r\nX-Evil: 1' };
    const state: RunState = {
      ...initialRunState(graph),
      nodeId: 'call',
      variables: { order_no: 'பிரியா 50%' },
    };
    const [effect] = step(graph, state, { kind: 'continue' }, hostile).effects;
    expect(effect).toMatchObject({
      kind: 'http_request',
      headers: [
        { name: 'Authorization', parts: [{ text: 'Bearer ' }, { secret: 'shop_token' }] },
        {
          name: 'X-Customer',
          // One text part: the value stays text, line breaks and other scripts are encoded.
          parts: [
            {
              text:
                '{{secret.shop_token}}%0D%0AX-Evil: 1 / ' + encodeURIComponent('பிரியா') + ' 50%25',
            },
          ],
        },
      ],
    });
    expect(encodeHeaderValue('Zoë 😀')).toBe(
      `Zo${encodeURIComponent('ë')} ${encodeURIComponent('😀')}`,
    );
    expect(httpHeaderText([{ text: 'Bearer ' }, { secret: 'shop_token' }])).toBe(
      'Bearer {{secret.shop_token}}',
    );
    // Header values in the step itself are printable ASCII only.
    const raw = JSON.parse(JSON.stringify(order())) as { nodes: Record<string, unknown>[] };
    raw.nodes[1] = { ...raw.nodes[1], headers: [{ name: 'X-Note', value: 'Zoë' }] };
    expect(parseGraph(raw).ok).toBe(false);
  });

  it('limits HTTP calls per run', () => {
    const graph = order();
    const state: RunState = {
      ...initialRunState(graph),
      nodeId: 'call',
      httpCalls: RUN_BUDGETS.maxHttpCalls,
      variables: { order_no: '1' },
    };
    expect(step(graph, state, { kind: 'continue' })).toMatchObject({
      status: 'failed',
      endReason: 'budget_http',
    });
  });
});
