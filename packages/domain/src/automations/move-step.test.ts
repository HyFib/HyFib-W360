import { describe, expect, it } from 'vitest';
import {
  NODE_TYPES,
  NODE_TYPE_LABELS,
  SESSION_MESSAGE_NODE_TYPES,
  checkGraph,
  edgesOf,
  parseGraph,
  type AutomationGraph,
} from './graph';
import { advance, initialRunState, type RunFacts } from './interpreter';

/** Steps that move the run's contact's open CRM deal to another stage (ADR-250). */

const RUN = '0190a3e4-1111-7000-8000-000000000001';
const PIPELINE = '0190a3e4-4444-7000-8000-000000000004';
const STAGE = '0190a3e4-5555-7000-8000-000000000005';
const OTHER_PIPELINE = '0190a3e4-6666-7000-8000-000000000006';
const OTHER_STAGE = '0190a3e4-7777-7000-8000-000000000007';
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
  start: 'move',
  nodes: [
    {
      id: 'move',
      type: 'move_deal',
      pipelineId: PIPELINE,
      stageId: STAGE,
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

const refs = {
  crmPipelines: new Map([
    [PIPELINE, { currency: 'INR', stageIds: new Set([STAGE]) }],
    [OTHER_PIPELINE, { currency: 'INR', stageIds: new Set([OTHER_STAGE]) }],
  ]),
};

describe('steps that move a CRM deal (ADR-250)', () => {
  it('is a step type with one way on, not a message', () => {
    const graph = graphOf(graphInput());
    expect(NODE_TYPES).toContain('move_deal');
    expect(NODE_TYPE_LABELS.move_deal).toBe('Move the CRM deal');
    expect(SESSION_MESSAGE_NODE_TYPES.has('move_deal')).toBe(false);
    expect(edgesOf(graph.nodes[0]!)).toEqual([{ label: 'next', target: 'bye' }]);
  });

  it('takes a pipeline and a stage', () => {
    for (const bad of [{ pipelineId: 'sales' }, { stageId: null }, { stageId: 'won' }]) {
      expect(parseGraph(graphInput(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('needs an active stage of the active pipeline', () => {
    expect(checkGraph(graphOf(graphInput()), refs)).toEqual([]);
    const stage = {
      level: 'error',
      nodeId: 'move',
      message: 'Choose an active stage of an active pipeline to move the deal to.',
    };
    // Another pipeline's stage, an archived (absent) pipeline.
    expect(checkGraph(graphOf(graphInput({ stageId: OTHER_STAGE })), refs)).toEqual([stage]);
    expect(
      checkGraph(graphOf(graphInput({ pipelineId: '0190a3e4-8888-7000-8000-000000000008' })), refs),
    ).toEqual([stage]);
    // Without the company's pipelines (in the browser before they load), nothing to check.
    expect(checkGraph(graphOf(graphInput({ stageId: OTHER_STAGE })))).toEqual([]);
  });

  it('moves the deal and goes on, without counting a message', () => {
    expect(
      advance({
        graph: graphOf(graphInput()),
        state: initialRunState(graphOf(graphInput())),
        event: { kind: 'continue' },
        facts,
        runId: RUN,
        now: NOW,
      }),
    ).toMatchObject({
      effects: [{ kind: 'move_deal', pipelineId: PIPELINE, stageId: STAGE }],
      status: 'running',
      state: { nodeId: 'bye', messages: 0 },
      log: { nodeId: 'move', nodeType: 'move_deal', outcome: 'moved' },
    });
  });
});
