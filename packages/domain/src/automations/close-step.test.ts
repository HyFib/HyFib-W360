import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_LIMITS,
  NODE_TYPES,
  NODE_TYPE_LABELS,
  SESSION_MESSAGE_NODE_TYPES,
  checkGraph,
  edgesOf,
  parseGraph,
  type AutomationGraph,
} from './graph';
import { advance, initialRunState, type RunFacts } from './interpreter';

/** Steps that close the run's contact's open CRM deal as won or lost (ADR-251). */

const RUN = '0190a3e4-1111-7000-8000-000000000001';
const PIPELINE = '0190a3e4-4444-7000-8000-000000000004';
const STAGE = '0190a3e4-5555-7000-8000-000000000005';
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
  start: 'close',
  nodes: [
    {
      id: 'close',
      type: 'close_deal',
      pipelineId: PIPELINE,
      outcome: 'lost',
      lostReason: 'No reply to the quote',
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

const run = (graph: AutomationGraph) =>
  advance({
    graph,
    state: initialRunState(graph),
    event: { kind: 'continue' },
    facts,
    runId: RUN,
    now: NOW,
  });

describe('steps that close a CRM deal (ADR-251)', () => {
  it('is a step type with one way on, not a message', () => {
    const graph = graphOf(graphInput());
    expect(NODE_TYPES).toContain('close_deal');
    expect(NODE_TYPE_LABELS.close_deal).toBe('Close the CRM deal');
    expect(SESSION_MESSAGE_NODE_TYPES.has('close_deal')).toBe(false);
    expect(edgesOf(graph.nodes[0]!)).toEqual([{ label: 'next', target: 'bye' }]);
  });

  it('takes a pipeline, won or lost, and a reason of up to 200 characters, trimmed', () => {
    expect(AUTOMATION_LIMITS.dealLostReasonLength).toBe(200);
    expect(graphOf(graphInput({ lostReason: '  Too expensive  ' })).nodes[0]).toMatchObject({
      lostReason: 'Too expensive',
    });
    expect(graphOf(graphInput({ lostReason: ' ' })).nodes[0]).toMatchObject({ lostReason: null });
    expect(parseGraph(graphInput({ lostReason: 'x'.repeat(200) })).ok).toBe(true);
    for (const bad of [
      { pipelineId: 'sales' },
      { outcome: 'open' },
      { outcome: null },
      { lostReason: 'x'.repeat(201) },
    ]) {
      expect(parseGraph(graphInput(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('needs an active pipeline', () => {
    const refs = {
      crmPipelines: new Map([[PIPELINE, { currency: 'INR', stageIds: new Set([STAGE]) }]]),
    };
    expect(checkGraph(graphOf(graphInput()), refs)).toEqual([]);
    expect(
      checkGraph(graphOf(graphInput({ pipelineId: '0190a3e4-8888-7000-8000-000000000008' })), refs),
    ).toEqual([
      {
        level: 'error',
        nodeId: 'close',
        message: 'Choose an active pipeline for the deal to close.',
      },
    ]);
    // Without the company's pipelines (in the browser before they load), nothing to check.
    expect(
      checkGraph(graphOf(graphInput({ pipelineId: '0190a3e4-8888-7000-8000-000000000008' }))),
    ).toEqual([]);
  });

  it('closes the deal and goes on, with a reason only when it is lost', () => {
    expect(run(graphOf(graphInput()))).toMatchObject({
      effects: [
        {
          kind: 'close_deal',
          pipelineId: PIPELINE,
          outcome: 'lost',
          lostReason: 'No reply to the quote',
        },
      ],
      status: 'running',
      state: { nodeId: 'bye', messages: 0 },
      log: { nodeId: 'close', nodeType: 'close_deal', outcome: 'closed' },
    });
    // A reason left on a step changed to won is not used.
    expect(run(graphOf(graphInput({ outcome: 'won' }))).effects).toEqual([
      { kind: 'close_deal', pipelineId: PIPELINE, outcome: 'won', lostReason: null },
    ]);
  });
});
