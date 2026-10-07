import { describe, expect, it } from 'vitest';
import {
  NODE_TYPES,
  NODE_TYPE_LABELS,
  RUN_BUDGETS,
  SESSION_MESSAGE_NODE_TYPES,
  checkGraph,
  edgesOf,
  parseGraph,
  type AutomationGraph,
} from './graph';
import { advance, initialRunState, type RunFacts, type RunState } from './interpreter';

/** Steps that send one of the company's WhatsApp forms (ADR-248). */

const RUN = '0190a3e4-1111-7000-8000-000000000001';
const FLOW = '0190a3e4-2222-7000-8000-000000000002';
const WABA = '0190a3e4-3333-7000-8000-000000000003';
const OTHER_WABA = '0190a3e4-4444-7000-8000-000000000004';
const NOW = new Date('2026-10-06T10:00:00Z');
const facts: RunFacts = {
  contactName: 'Asha Rao',
  companyName: 'Acme',
  tags: new Set(),
  conversationTags: new Set(),
  fields: {},
  businessOpen: true,
};

const graphInput = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  start: 'form',
  nodes: [
    {
      id: 'form',
      type: 'send_flow',
      flowId: FLOW,
      header: 'Book a visit',
      body: 'Hi {{name}}, pick a time that suits you.',
      footer: 'Takes a minute',
      cta: 'Open the form',
      next: 'bye',
      ...overrides,
    },
    { id: 'bye', type: 'send_text', text: 'Thanks!', next: null },
  ],
});

function graphOf(input: unknown): AutomationGraph {
  const parsed = parseGraph(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.graph;
}

const run = (graph: AutomationGraph, state: Partial<RunState> = {}) =>
  advance({
    graph,
    state: { ...initialRunState(graph), ...state },
    event: { kind: 'continue' },
    facts,
    runId: RUN,
    now: NOW,
  });

const flowsRef = (flow: { whatsappAccountId: string; sendable: boolean } | null) =>
  new Map(flow ? [[FLOW, flow]] : []);

describe('steps that send a form (ADR-248)', () => {
  it('is a session message step with one way on', () => {
    const graph = graphOf(graphInput());
    expect(NODE_TYPES).toContain('send_flow');
    expect(NODE_TYPE_LABELS.send_flow).toBe('Send a form');
    expect(SESSION_MESSAGE_NODE_TYPES.has('send_flow')).toBe(true);
    expect(edgesOf(graph.nodes[0]!)).toEqual([{ label: 'next', target: 'bye' }]);
  });

  it('takes a form, a message and a button text; the header and footer are optional', () => {
    expect(graphOf(graphInput({ header: '  ', footer: null })).nodes[0]).toMatchObject({
      header: null,
      footer: null,
    });
    for (const bad of [
      { flowId: 'booking' },
      { body: ' ' },
      { body: 'x'.repeat(1025) },
      { cta: '' },
      { cta: 'x'.repeat(31) },
      { header: 'x'.repeat(61) },
      { footer: 'x'.repeat(61) },
    ]) {
      expect(parseGraph(graphInput(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('needs a published form of the automation’s WhatsApp account', () => {
    const graph = graphOf(graphInput());
    const issues = (
      flow: { whatsappAccountId: string; sendable: boolean } | null,
      account: string | null,
    ) =>
      checkGraph(graph, { flows: flowsRef(flow), channelWhatsappAccountId: account }).map(
        (i) => i.message,
      );
    expect(issues({ whatsappAccountId: WABA, sendable: true }, WABA)).toEqual([]);
    // Any number: the run checks the number's account when it sends.
    expect(issues({ whatsappAccountId: WABA, sendable: true }, null)).toEqual([]);
    expect(issues(null, WABA)).toEqual(['The form no longer exists.']);
    expect(issues({ whatsappAccountId: WABA, sendable: false }, WABA)).toEqual([
      'Publish the form before an automation sends it.',
    ]);
    expect(issues({ whatsappAccountId: OTHER_WABA, sendable: true }, WABA)).toEqual([
      'Choose a form of the WhatsApp account of the automation’s number.',
    ]);
    // Without the company's forms (in the browser before they load), nothing to check.
    expect(checkGraph(graph)).toEqual([]);
  });

  it('follows the rules of a message: answers saved first, a customer reply first after an order', () => {
    const early = graphOf(graphInput({ body: 'Your size: {{answer.size}}' }));
    expect(checkGraph(early).map((i) => [i.level, i.nodeId, i.message])).toEqual([
      ['error', 'form', '{{answer.size}} is not saved by any question or web request.'],
    ]);
    const graph = graphOf(graphInput());
    expect(
      checkGraph(graph, { storeEvent: true }).some(
        (i) => i.level === 'error' && i.nodeId === 'form',
      ),
    ).toBe(true);
  });

  it('sends the form with its message filled in, counts it as a message and moves on', () => {
    const result = run(graphOf(graphInput()));
    expect(result).toMatchObject({
      effects: [
        {
          kind: 'send_flow',
          flowId: FLOW,
          header: 'Book a visit',
          body: 'Hi Asha Rao, pick a time that suits you.',
          footer: 'Takes a minute',
          cta: 'Open the form',
        },
      ],
      status: 'running',
      state: { nodeId: 'bye', messages: 1 },
      log: { nodeId: 'form', nodeType: 'send_flow', outcome: 'sent' },
    });
    // A message that fills in nothing is not sent; a run at its message budget fails.
    expect(run(graphOf(graphInput({ body: '{{answer.size}}' })))).toMatchObject({
      effects: [],
      status: 'failed',
      log: { detail: 'empty_message' },
    });
    expect(run(graphOf(graphInput()), { messages: RUN_BUDGETS.maxMessages })).toMatchObject({
      effects: [],
      status: 'failed',
      endReason: 'budget_messages',
    });
  });
});
