import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_LIMITS,
  NODE_TYPES,
  NODE_TYPE_LABELS,
  checkGraph,
  dealValueMinor,
  edgesOf,
  parseGraph,
  type AutomationGraph,
} from './graph';
import { advance, initialRunState, type RunFacts } from './interpreter';

/** Steps that create a CRM deal for the run's contact (ADR-245). */

const RUN = '0190a3e4-1111-7000-8000-000000000001';
const PIPELINE = '0190a3e4-4444-7000-8000-000000000004';
const STAGE = '0190a3e4-5555-7000-8000-000000000005';
const OTHER_PIPELINE = '0190a3e4-6666-7000-8000-000000000006';
const OTHER_STAGE = '0190a3e4-7777-7000-8000-000000000007';
const OWNER = '0190a3e4-2222-7000-8000-000000000002';
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
  start: 'deal',
  nodes: [
    {
      id: 'deal',
      type: 'create_deal',
      title: 'Kettles for {{name}}',
      pipelineId: PIPELINE,
      stageId: STAGE,
      value: '2,500.50',
      ownerMembershipId: OWNER,
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
  crmMemberIds: new Set([OWNER]),
  crmPipelines: new Map([
    [PIPELINE, { currency: 'INR', stageIds: new Set([STAGE]) }],
    [OTHER_PIPELINE, { currency: 'JPY', stageIds: new Set([OTHER_STAGE]) }],
  ]),
};

const run = (graph: AutomationGraph, variables: Record<string, string> = {}) =>
  advance({
    graph,
    state: { ...initialRunState(graph), variables },
    event: { kind: 'continue' },
    facts,
    runId: RUN,
    now: NOW,
  });

describe('steps that create a CRM deal (ADR-245)', () => {
  it('is a step type with one way on', () => {
    const graph = graphOf(graphInput());
    expect(NODE_TYPES).toContain('create_deal');
    expect(NODE_TYPE_LABELS.create_deal).toBe('Create a CRM deal');
    expect(edgesOf(graph.nodes[0]!)).toEqual([{ label: 'next', target: 'bye' }]);
    expect(AUTOMATION_LIMITS.dealTitleLength).toBe(120);
    expect(AUTOMATION_LIMITS.dealValueLength).toBe(24);
  });

  it('takes a title, a stage, an optional value as typed and an optional owner', () => {
    expect(parseGraph(graphInput({ value: null, ownerMembershipId: null })).ok).toBe(true);
    // An empty value is no value; a value is kept as typed, trimmed.
    expect(graphOf(graphInput({ value: '  ' })).nodes[0]).toMatchObject({ value: null });
    expect(graphOf(graphInput({ value: ' 2500 ' })).nodes[0]).toMatchObject({ value: '2500' });
    for (const bad of [
      { title: ' ' },
      { title: 'x'.repeat(121) },
      { value: '1'.repeat(25) },
      { pipelineId: 'sales' },
      { stageId: null },
      { ownerMembershipId: 'someone' },
    ]) {
      expect(parseGraph(graphInput(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('reads the value in the pipeline’s currency, exactly', () => {
    expect(dealValueMinor(null, 'INR')).toBeNull();
    expect(dealValueMinor('2,500.50', 'INR')).toBe(250050);
    expect(dealValueMinor('2500.505', 'INR')).toBeUndefined();
    expect(dealValueMinor('10', 'JPY')).toBe(10);
    expect(dealValueMinor('1.5', 'JPY')).toBeUndefined();
    expect(dealValueMinor('-5', 'INR')).toBeUndefined();
    expect(dealValueMinor('lots', 'INR')).toBeUndefined();
    // As much as a deal can hold, and not a minor unit more.
    expect(dealValueMinor('10000000000000.00', 'INR')).toBe(1_000_000_000_000_000);
    expect(dealValueMinor('10000000000000.01', 'INR')).toBeUndefined();
  });

  it('needs an active stage of an active pipeline, a value in its currency and an owner who can use the CRM', () => {
    expect(checkGraph(graphOf(graphInput()), refs)).toEqual([]);
    const errors = (overrides: Record<string, unknown>) =>
      checkGraph(graphOf(graphInput(overrides)), refs).map((i) => [i.level, i.nodeId, i.message]);
    const stage = ['error', 'deal', 'Choose an active stage of an active pipeline for the deal.'];
    expect(errors({ stageId: OTHER_STAGE })).toEqual([stage]);
    expect(errors({ pipelineId: OTHER_PIPELINE, value: null })).toEqual([stage]);
    expect(errors({ pipelineId: '0190a3e4-8888-7000-8000-000000000008' })).toEqual([stage]);
    expect(errors({ value: '12.345' })).toEqual([
      ['error', 'deal', 'Enter the deal’s value as an amount in INR, or leave it empty.'],
    ]);
    expect(errors({ pipelineId: OTHER_PIPELINE, stageId: OTHER_STAGE, value: '2,500.50' })).toEqual(
      [['error', 'deal', 'Enter the deal’s value as an amount in JPY, or leave it empty.']],
    );
    expect(errors({ ownerMembershipId: '0190a3e4-9999-7000-8000-000000000009' })).toEqual([
      ['error', 'deal', 'Choose an active member who can use the CRM to own the deal, or nobody.'],
    ]);
    expect(errors({ ownerMembershipId: null })).toEqual([]);
    // Placeholders in the title follow the rules of a message's.
    expect(errors({ title: 'Size {{answer.size}}' })).toEqual([
      ['error', 'deal', '{{answer.size}} is not saved by any question or web request.'],
    ]);
    // Without the company's pipelines and members (in the browser before they load), nothing.
    expect(checkGraph(graphOf(graphInput({ stageId: OTHER_STAGE })))).toEqual([]);
  });

  it('creates the deal with its title filled in, on one line, and moves on', () => {
    const graph = graphOf(graphInput({ title: 'Kettles for {{name}}:\n {{answer.size}}' }));
    expect(run(graph, { size: 'large' })).toMatchObject({
      effects: [
        {
          kind: 'create_deal',
          title: 'Kettles for Asha Rao: large',
          pipelineId: PIPELINE,
          stageId: STAGE,
          value: '2,500.50',
          ownerMembershipId: OWNER,
        },
      ],
      status: 'running',
      state: { nodeId: 'bye' },
      log: { nodeId: 'deal', nodeType: 'create_deal', outcome: 'created' },
    });
    const long = graphOf(graphInput({ title: '{{answer.size}}' }));
    const title = (run(long, { size: 'k'.repeat(300) }).effects[0] as { title: string }).title;
    expect([...title]).toHaveLength(AUTOMATION_LIMITS.dealTitleLength);
    expect((run(long).effects[0] as { title: string }).title).toBe('');
  });
});
