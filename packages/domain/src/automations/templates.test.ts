import { describe, expect, it } from 'vitest';
import {
  RUN_BUDGETS,
  checkGraph,
  describeTrigger,
  matchTrigger,
  parseGraph,
  parseTrigger,
  renderText,
  type AutomationGraph,
  type TemplateReference,
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

/** Template steps, the store-event trigger and order placeholders (ADR-050). */

const RUN = '0190a3e4-2222-7000-8000-000000000002';
const NOW = new Date('2026-09-28T10:00:00Z');
const TEMPLATE = '0190a3e4-3333-7000-8000-000000000003';
const WABA = '0190a3e4-4444-7000-8000-000000000004';

const order = {
  number: '#1001',
  customer_name: 'Nila Customer',
  total: '₹1,499.00',
  items: 'Lavender candle and 1 more',
  status_url: 'https://shop.example/orders/1001',
  tracking_number: null,
  carrier: null,
  tracking_url: null,
  store: 'Cora Candles',
};
const facts: RunFacts = {
  contactName: 'Nila',
  companyName: 'Cora',
  tags: new Set(),
  conversationTags: new Set(),
  fields: {},
  businessOpen: true,
  order,
};

function graphOf(input: unknown): AutomationGraph {
  const parsed = parseGraph(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.graph;
}

const confirm = {
  id: 'confirm',
  type: 'ask_template',
  templateId: TEMPLATE,
  header: [],
  body: ['{{order.customer_name}}', '{{order.number}}'],
  buttons: [
    { index: 0, title: 'Track order', next: 'track' },
    { index: 2, title: 'Talk to us', next: 'people' },
  ],
  saveAs: 'choice',
  replyNext: 'people',
  timeoutMinutes: 120,
  timeoutNext: 'bye',
};

const storeGraph = graphOf({
  version: 1,
  start: 'confirm',
  nodes: [
    confirm,
    {
      id: 'track',
      type: 'send_text',
      text: 'Track {{order.number}}: {{order.status_url}}',
      next: null,
    },
    { id: 'people', type: 'handoff', teamId: null },
    { id: 'bye', type: 'end' },
  ],
});

const templateRef: TemplateReference = {
  name: 'order_confirmed',
  category: 'UTILITY',
  status: 'approved',
  whatsappAccountId: WABA,
  unsupported: null,
  headerParams: 0,
  bodyParams: 2,
  links: [],
  quickReplies: [
    { index: 0, title: 'Track order' },
    { index: 2, title: 'Talk to us' },
  ],
};

function step(graph: AutomationGraph, state: RunState, event: RunEvent, f = facts): StepResult {
  return advance({ graph, state, event, facts: f, runId: RUN, now: NOW });
}

describe('store-event trigger', () => {
  it('parses, never matches a customer message and describes itself', () => {
    const parsed = parseTrigger({ type: 'store_event' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(matchTrigger(parsed.trigger, { text: 'hi', newCase: true })).toBeNull();
    expect(describeTrigger(parsed.trigger)).toBe('Started by a store’s order messages');
  });
});

describe('bot button ids', () => {
  it('carry a template button position up to 9', () => {
    const id = botButtonId(RUN, 'confirm', 1, 9);
    expect(parseBotButtonId(id)).toEqual({ runId: RUN, nodeId: 'confirm', visit: 1, index: 9 });
    expect(parseBotButtonId(`w360bot:${RUN}:confirm:1:10`)).toBeNull();
    expect(id.length).toBeLessThanOrEqual(84);
  });
});

describe('template step parsing', () => {
  it('reports an empty variable as a check error (so a draft can still be saved)', () => {
    const graph = graphOf({
      version: 1,
      start: 'a',
      nodes: [
        {
          id: 'a',
          type: 'send_template',
          templateId: TEMPLATE,
          header: [],
          body: ['', 'x'],
          next: null,
        },
      ],
    });
    expect(checkGraph(graph).map((i) => [i.level, i.message])).toEqual([
      ['error', 'Fill in every variable of the template.'],
    ]);
  });

  it('refuses two branches for one button and over-long variables', () => {
    const twice = parseGraph({
      version: 1,
      start: 'a',
      nodes: [
        {
          ...confirm,
          id: 'a',
          buttons: [
            { index: 0, title: 'One', next: null },
            { index: 0, title: 'Two', next: null },
          ],
        },
      ],
    });
    expect(twice.ok).toBe(false);
    const long = parseGraph({
      version: 1,
      start: 'a',
      nodes: [
        {
          id: 'a',
          type: 'send_template',
          templateId: TEMPLATE,
          header: [],
          body: ['x'.repeat(1001)],
          next: null,
        },
      ],
    });
    expect(long.ok).toBe(false);
  });
});

describe('the ends of links (ADR-229)', () => {
  const linked = (links: string[]) =>
    graphOf({
      version: 1,
      start: 'notify',
      nodes: [
        {
          id: 'notify',
          type: 'send_template',
          templateId: TEMPLATE,
          header: [],
          body: ['{{order.customer_name}}', '{{order.number}}'],
          links,
          next: 'bye',
        },
        { id: 'bye', type: 'end' },
      ],
    });
  const reference: TemplateReference = {
    ...templateRef,
    quickReplies: [],
    links: [{ index: 0, text: 'Track', url: 'https://shop.example/track/{{1}}' }],
  };
  const issues = (graph: AutomationGraph) =>
    checkGraph(graph, { templates: new Map([[TEMPLATE, reference]]), storeEvent: true })
      .filter((i) => i.level === 'error')
      .map((i) => i.message);

  it('fill each link with placeholders, kept as rendered, and fail without one', () => {
    const graph = linked(['  {{order.items}}\n\nnow ']);
    expect(issues(graph)).toEqual([]);
    const sent = step(graph, initialRunState(graph), { kind: 'continue' });
    // White space inside is kept: whether the link can end with it is checked when queued.
    expect(sent.effects[0]).toMatchObject({
      kind: 'send_template',
      body: ['Nila Customer', '#1001'],
      links: ['Lavender candle and 1 more\n\nnow'],
    });
    const empty = linked(['{{order.tracking_number}}']);
    const failed = step(empty, initialRunState(empty), { kind: 'continue' });
    expect(failed.status).toBe('failed');
    expect(failed.log.detail).toBe('missing_variable');
    expect(failed.effects).toEqual([]);
  });

  it('are counted with the variables, and versions saved before have none', () => {
    expect(issues(linked([]))[0]).toBe(
      'The template “order_confirmed” has 3 variables: fill in each one.',
    );
    expect(issues(linked(['a', 'b']))[0]).toMatch(/has 3 variables/);
    const old = graphOf({
      version: 1,
      start: 'a',
      nodes: [
        { id: 'a', type: 'send_template', templateId: TEMPLATE, header: [], body: [], next: null },
      ],
    });
    expect(old.nodes[0]).toMatchObject({ links: [] });
    expect(
      parseGraph({
        version: 1,
        start: 'a',
        nodes: [
          {
            id: 'a',
            type: 'send_template',
            templateId: TEMPLATE,
            header: [],
            body: [],
            links: ['a', 'b', 'c'],
            next: null,
          },
        ],
      }).ok,
    ).toBe(false);
  });
});

describe('order placeholders', () => {
  it('render from the order, empty where it has no value or there is no order', () => {
    const values = { contactName: 'Nila', companyName: 'Cora', variables: {}, order };
    expect(renderText('{{order.number}} {{ORDER.total}} x{{order.carrier}}x', values)).toBe(
      '#1001 ₹1,499.00 xx',
    );
    expect(renderText('{{order.number}}', { ...values, order: null })).toBe('');
    // Not an order field: left as written (the checks refuse it).
    expect(renderText('{{order.colour}}', values)).toBe('{{order.colour}}');
  });
});

describe('send_template', () => {
  const graph = graphOf({
    version: 1,
    start: 'notify',
    nodes: [
      {
        id: 'notify',
        type: 'send_template',
        templateId: TEMPLATE,
        header: ['{{order.store}}'],
        body: ['{{name}}', '{{order.items}}\n\n  now', '{{answer.missing}}'],
        next: 'bye',
      },
      { id: 'bye', type: 'end' },
    ],
  });

  it('fails without sending when a variable is empty', () => {
    const result = step(graph, initialRunState(graph), { kind: 'continue' });
    expect(result.status).toBe('failed');
    expect(result.log.detail).toBe('missing_variable');
    expect(result.effects).toEqual([]);
  });

  it('sends the template with its variables on one line and continues', () => {
    const state = { ...initialRunState(graph), variables: { missing: 'here' } };
    const result = step(graph, state, { kind: 'continue' });
    expect(result.status).toBe('running');
    expect(result.state.nodeId).toBe('bye');
    expect(result.state.messages).toBe(1);
    expect(result.effects).toEqual([
      {
        kind: 'send_template',
        templateId: TEMPLATE,
        header: ['Cora Candles'],
        body: ['Nila', 'Lavender candle and 1 more now', 'here'],
        links: [],
        ask: false,
        buttons: [],
      },
    ]);
  });

  it('counts against the message budget', () => {
    const state = {
      ...initialRunState(graph),
      variables: { missing: 'here' },
      messages: RUN_BUDGETS.maxMessages,
    };
    const result = step(graph, state, { kind: 'continue' });
    expect(result.status).toBe('failed');
    expect(result.endReason).toBe('budget_messages');
  });
});

describe('ask_template', () => {
  const asked = step(storeGraph, initialRunState(storeGraph), { kind: 'continue' });

  it('sends with a payload per quick-reply button and waits for the reply', () => {
    expect(asked.status).toBe('waiting');
    expect(asked.state.waiting).toEqual({
      for: 'reply',
      until: new Date(NOW.getTime() + 120 * 60_000),
    });
    expect(asked.effects).toEqual([
      {
        kind: 'send_template',
        templateId: TEMPLATE,
        header: [],
        body: ['Nila Customer', '#1001'],
        links: [],
        ask: true,
        buttons: [
          { index: 0, title: 'Track order', payload: botButtonId(RUN, 'confirm', 1, 0) },
          { index: 2, title: 'Talk to us', payload: botButtonId(RUN, 'confirm', 1, 2) },
        ],
      },
    ]);
  });

  const reply = (text: string | null, buttonId: string | null): RunEvent => ({
    kind: 'reply',
    reply: { type: buttonId ? 'button' : 'text', text, buttonId },
  });

  it('follows the tapped button and saves its text', () => {
    const result = step(
      storeGraph,
      asked.state,
      reply('Talk to us', botButtonId(RUN, 'confirm', 1, 2)),
    );
    expect(result.state.nodeId).toBe('people');
    expect(result.state.variables).toEqual({ choice: 'Talk to us' });
    expect(result.log).toMatchObject({ outcome: 'answered', branch: 'Talk to us' });
  });

  it('accepts a button text typed as a reply', () => {
    const result = step(storeGraph, asked.state, reply('track ORDER', null));
    expect(result.state.nodeId).toBe('track');
    expect(result.state.variables).toEqual({ choice: 'Track order' });
  });

  it('treats a tap from another visit or step as another reply', () => {
    for (const stale of [
      botButtonId(RUN, 'confirm', 2, 0),
      botButtonId(RUN, 'other', 1, 0),
      botButtonId('0190a3e4-9999-7000-8000-000000000009', 'confirm', 1, 0),
    ]) {
      const result = step(storeGraph, asked.state, reply('Track order', stale));
      expect(result.state.nodeId).toBe('people');
      expect(result.log.branch).toBe('other reply');
      expect(result.state.variables).toEqual({});
    }
  });

  it('takes the no-reply branch at the deadline', () => {
    const result = step(storeGraph, asked.state, { kind: 'deadline' });
    expect(result.state.nodeId).toBe('bye');
    expect(result.log).toMatchObject({ outcome: 'timed_out', branch: 'no reply' });
  });

  it('without buttons, any reply takes the reply branch', () => {
    const graph = graphOf({
      version: 1,
      start: 'ask',
      nodes: [
        { ...confirm, id: 'ask', buttons: [], saveAs: null, replyNext: 'bye' },
        { id: 'bye', type: 'end' },
      ],
    });
    const waiting = step(graph, initialRunState(graph), { kind: 'continue' });
    expect(waiting.effects[0]).toMatchObject({ kind: 'send_template', ask: true, buttons: [] });
    const result = step(graph, waiting.state, reply('Yes please', null));
    expect(result.state.nodeId).toBe('bye');
    expect(result.log.branch).toBe('reply');
  });
});

describe('checks for automations started by order messages', () => {
  const refs = { storeEvent: true, templates: new Map([[TEMPLATE, templateRef]]) };
  const errors = (graph: AutomationGraph, r: Parameters<typeof checkGraph>[1] = refs) =>
    checkGraph(graph, r).filter((i) => i.level === 'error');

  it('accept messages after the customer replied, and refuse them before', () => {
    expect(errors(storeGraph)).toEqual([]);
    const early = graphOf({
      version: 1,
      start: 'hello',
      nodes: [{ id: 'hello', type: 'send_text', text: 'Hi', next: null }],
    });
    expect(errors(early)).toEqual([
      expect.objectContaining({
        nodeId: 'hello',
        message: expect.stringContaining('only templates until the customer replies'),
      }),
    ]);
    // The same graph started by a customer message is fine.
    expect(errors(early, { templates: refs.templates })).toEqual([]);
  });

  it('carry a reply through the steps that follow it', () => {
    const graph = graphOf({
      version: 1,
      start: 'confirm',
      nodes: [
        {
          ...confirm,
          buttons: [
            { index: 0, title: 'Track order', next: 'tag' },
            { index: 2, title: 'Talk to us', next: 'people' },
          ],
        },
        { id: 'tag', type: 'update_contact', action: { kind: 'add_tag', tag: 'x' }, next: 'pause' },
        { id: 'pause', type: 'wait', minutes: 5, next: 'late' },
        { id: 'late', type: 'send_text', text: 'Here it is', next: null },
        { id: 'people', type: 'handoff', teamId: null },
        { id: 'bye', type: 'end' },
      ],
    });
    expect(errors(graph)).toEqual([]);
  });

  it('count a timeout as no reply, and an other reply as a reply', () => {
    const graph = graphOf({
      version: 1,
      start: 'confirm',
      nodes: [
        { ...confirm, replyNext: 'thanks', timeoutNext: 'nudge' },
        { id: 'track', type: 'send_text', text: 'Tracking soon', next: null },
        { id: 'people', type: 'handoff', teamId: null },
        {
          id: 'thanks',
          type: 'ask_text',
          text: 'Anything else?',
          saveAs: 'more',
          format: 'any',
          retryText: null,
          retries: 0,
          invalidNext: null,
          timeoutMinutes: 60,
          timeoutNext: null,
          next: null,
        },
        { id: 'nudge', type: 'send_text', text: 'Still there?', next: null },
      ],
    });
    const found = errors(graph);
    expect(found.map((i) => i.nodeId)).toEqual(['nudge']);
  });

  it('refuse a message reached by any path without a reply (paths join)', () => {
    const graph = graphOf({
      version: 1,
      start: 'confirm',
      nodes: [
        {
          ...confirm,
          buttons: [
            { index: 0, title: 'Track order', next: 'wait' },
            { index: 2, title: 'Talk to us', next: 'people' },
          ],
          timeoutNext: 'wait',
        },
        { id: 'wait', type: 'wait', minutes: 5, next: 'late' },
        { id: 'late', type: 'send_text', text: 'Here it is', next: null },
        { id: 'people', type: 'handoff', teamId: null },
      ],
    });
    expect(errors(graph).map((i) => i.nodeId)).toEqual(['late']);
  });

  it('warn about a hand-off before a reply', () => {
    const graph = graphOf({
      version: 1,
      start: 'notify',
      nodes: [
        {
          id: 'notify',
          type: 'send_template',
          templateId: TEMPLATE,
          header: [],
          body: ['a', 'b'],
          next: 'people',
        },
        { id: 'people', type: 'handoff', teamId: null },
      ],
    });
    const issues = checkGraph(graph, refs);
    expect(issues).toEqual([
      expect.objectContaining({
        level: 'warning',
        nodeId: 'people',
        message: expect.stringContaining('before the customer replies'),
      }),
    ]);
  });

  it('allow order fields only in automations started by order messages', () => {
    const graph = graphOf({
      version: 1,
      start: 'confirm',
      nodes: [
        { ...confirm, body: ['{{order.number}}', '{{order.colour}}'] },
        { id: 'track', type: 'send_text', text: 'x', next: null },
        { id: 'people', type: 'handoff', teamId: null },
        { id: 'bye', type: 'end' },
      ],
    });
    expect(errors(graph).map((i) => i.message)).toEqual([
      'Unknown placeholder {{order.colour}}. Use {{name}}, {{company}}, {{answer.<name>}} or {{order.<field>}}.',
    ]);
    expect(errors(graph, { templates: refs.templates }).map((i) => i.message)).toEqual([
      '{{order.number}} is an order field: order fields work only in automations started by a store’s order messages.',
      'Unknown placeholder {{order.colour}}. Use {{name}}, {{company}} or {{answer.<name>}}.',
    ]);
  });

  it('check the template against the company’s copy', () => {
    const check = (ref: Partial<TemplateReference> | null, extra: object = {}) =>
      errors(storeGraph, {
        ...refs,
        ...extra,
        templates: new Map(ref === null ? [] : [[TEMPLATE, { ...templateRef, ...ref }]]),
      }).map((i) => i.message);
    expect(check(null)).toEqual(['The template no longer exists. Choose another one.']);
    expect(check({ status: 'paused' })).toEqual([
      'The template “order_confirmed” is not approved by Meta (paused).',
    ]);
    expect(check({ category: 'AUTHENTICATION' })).toEqual([
      'Choose a utility or marketing template.',
    ]);
    expect(check({ unsupported: 'This template uses named variables.' })).toEqual([
      'This template uses named variables.',
    ]);
    expect(check({ bodyParams: 3 })).toEqual([
      'The template “order_confirmed” has 3 variables: fill in each one.',
    ]);
    expect(check({ quickReplies: [{ index: 0, title: 'Track order' }] })).toEqual([
      'The template’s quick-reply buttons changed: choose the template again to update the branches.',
    ]);
    // A quick reply added after the step's buttons has no branch either.
    expect(
      check({
        quickReplies: [...templateRef.quickReplies, { index: 3, title: 'Cancel my order' }],
      }),
    ).toEqual([
      'The template’s quick-reply buttons changed: choose the template again to update the branches.',
    ]);
    expect(
      check({
        quickReplies: [
          { index: 0, title: 'Track' },
          { index: 2, title: 'Talk to us' },
        ],
      }),
    ).toHaveLength(1);
    expect(check({}, { channelWhatsappAccountId: '0190a3e4-5555-7000-8000-000000000005' })).toEqual(
      ['The template belongs to another WhatsApp account than the automation’s number.'],
    );
  });

  it('save a template answer only on its button branches', () => {
    const graph = graphOf({
      version: 1,
      start: 'confirm',
      nodes: [
        { ...confirm, replyNext: 'echo' },
        { id: 'track', type: 'send_text', text: 'You chose {{answer.choice}}', next: null },
        { id: 'people', type: 'handoff', teamId: null },
        { id: 'echo', type: 'send_text', text: 'Choice: {{answer.choice}}', next: null },
        { id: 'bye', type: 'end' },
      ],
    });
    const issues = checkGraph(graph, refs);
    expect(issues.filter((i) => i.nodeId === 'track')).toEqual([]);
    expect(issues.filter((i) => i.nodeId === 'echo').map((i) => i.message)).toEqual([
      '{{answer.choice}} is used before any question saves it.',
    ]);
  });

  it('count an asking template step as waiting in loops', () => {
    const graph = graphOf({
      version: 1,
      start: 'confirm',
      nodes: [
        { ...confirm, buttons: [], saveAs: null, replyNext: 'confirm', timeoutNext: 'confirm' },
      ],
    });
    expect(checkGraph(graph, refs).filter((i) => i.message.includes('loop'))).toEqual([]);
  });
});

describe('messages after a day without the customer', () => {
  const refs = { templates: new Map([[TEMPLATE, templateRef]]) };
  const dayWarnings = (nodes: unknown[]) =>
    checkGraph(graphOf({ version: 1, start: 'first', nodes }), refs)
      .filter((i) => i.message.startsWith('After about 24 hours'))
      .map((i) => i.nodeId);
  const followUp = {
    id: 'follow',
    type: 'send_template',
    templateId: TEMPLATE,
    header: [],
    body: ['{{name}}', '{{company}}'],
    next: null,
  };

  it('warn only when a message that is not a template can follow before a reply', () => {
    // A day's wait, then a text: WhatsApp refuses it.
    expect(
      dayWarnings([
        { id: 'first', type: 'wait', minutes: 1440, next: 'late' },
        { id: 'late', type: 'send_text', text: 'Still there?', next: null },
      ]),
    ).toEqual(['first']);
    // A day's wait, then a template (drip follow-ups): fine, also through a short wait.
    expect(
      dayWarnings([
        { id: 'first', type: 'wait', minutes: 1440, next: 'pause' },
        { id: 'pause', type: 'wait', minutes: 5, next: 'follow' },
        followUp,
      ]),
    ).toEqual([]);
    // A template question after the wait: a text on its reply branches is fine, on its timeout not.
    const ask = { ...confirm, id: 'ask', body: ['{{name}}', '{{company}}'], timeoutNext: 'late' };
    const nodes = [
      { id: 'first', type: 'wait', minutes: 1440, next: 'ask' },
      { ...ask, replyNext: 'thanks', timeoutNext: null },
      { id: 'track', type: 'send_text', text: 'Tracking', next: null },
      { id: 'people', type: 'handoff', teamId: null },
      { id: 'thanks', type: 'send_text', text: 'Thanks', next: null },
    ];
    expect(dayWarnings(nodes)).toEqual([]);
    expect(
      dayWarnings([
        nodes[0],
        { ...ask, replyNext: 'thanks' },
        ...nodes.slice(2),
        { id: 'late', type: 'send_text', text: 'Still there?', next: null },
      ]),
    ).toEqual(['first']);
  });

  it('follow the timeout of a question that waits a day', () => {
    const question = {
      id: 'first',
      type: 'ask_text',
      text: 'Your email?',
      saveAs: 'email',
      format: 'email',
      retryText: null,
      retries: 0,
      invalidNext: null,
      timeoutMinutes: 1440,
      next: null,
    };
    expect(
      dayWarnings([
        { ...question, timeoutNext: 'late' },
        { id: 'late', type: 'send_text', text: 'Still there?', next: null },
      ]),
    ).toEqual(['first']);
    expect(dayWarnings([{ ...question, timeoutNext: 'follow' }, followUp])).toEqual([]);
    expect(dayWarnings([{ ...question, timeoutNext: null }])).toEqual([]);
  });
});
