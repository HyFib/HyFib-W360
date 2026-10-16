import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_LIMITS,
  NODE_TYPES,
  NODE_TYPE_LABELS,
  SESSION_MESSAGE_NODE_TYPES,
  WAITING_NODE_TYPES,
  checkGraph,
  edgesOf,
  parseGraph,
  type AutomationGraph,
  type GraphReferences,
} from './graph';
import { advance, initialRunState, type RunFacts } from './interpreter';
import { MAX_DEAL_ATTRIBUTES_BYTES, stepDealAttributes } from '../crm/deal-fields';
import type { DealFieldShape } from '../crm/deal-field-values';

/** Steps that set custom field values on the run's contact's open CRM deal (ADR-386). */

const RUN = '0190a3e4-1111-7000-8000-000000000001';
const PIPELINE = '0190a3e4-4444-7000-8000-000000000004';
const STAGE = '0190a3e4-5555-7000-8000-000000000005';
const OTHER_PIPELINE = '0190a3e4-8888-7000-8000-000000000008';
const NOW = new Date('2026-10-16T10:00:00Z');
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
  start: 'fields',
  nodes: [
    {
      id: 'fields',
      type: 'update_deal_fields',
      pipelineId: PIPELINE,
      values: [
        { field: 'tier', value: 'Gold' },
        { field: 'budget', value: '{{answer.budget}}' },
      ],
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

const DEAL_FIELDS: Record<string, DealFieldShape> = {
  region: { label: 'Region', type: 'text', options: null },
  budget: { label: 'Budget', type: 'number', options: null },
  visit: { label: 'Visit', type: 'date', options: null },
  trial: { label: 'Trial', type: 'boolean', options: null },
  tier: { label: 'Tier', type: 'choice', options: ['Gold', 'Silver', 'Bronze'] },
};

const refs: GraphReferences = {
  crmPipelines: new Map([[PIPELINE, { currency: 'INR', stageIds: new Set([STAGE]) }]]),
  dealFields: new Map(Object.entries(DEAL_FIELDS)),
};

/** The graph's errors and warnings for the step, with a question saving `budget` before it. */
const issuesOf = (overrides: Record<string, unknown>, references: GraphReferences = refs) => {
  const input = graphInput(overrides);
  return checkGraph(
    graphOf({
      ...input,
      start: 'ask',
      nodes: [
        {
          id: 'ask',
          type: 'ask_text',
          text: 'Your budget?',
          saveAs: 'budget',
          format: 'any',
          retryText: null,
          retries: 0,
          invalidNext: null,
          timeoutMinutes: 60,
          timeoutNext: null,
          next: 'fields',
        },
        ...input.nodes,
      ],
    }),
    references,
  ).filter((issue) => issue.nodeId === 'fields');
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

describe('steps that set deal fields (ADR-386)', () => {
  it('is a step type with one way on, not a message and not waiting', () => {
    const graph = graphOf(graphInput());
    expect(NODE_TYPES).toContain('update_deal_fields');
    // Listed with the other deal steps, before waiting.
    expect(NODE_TYPES.indexOf('update_deal_fields')).toBe(NODE_TYPES.indexOf('close_deal') + 1);
    expect(NODE_TYPE_LABELS.update_deal_fields).toBe('Update deal fields');
    expect(SESSION_MESSAGE_NODE_TYPES.has('update_deal_fields')).toBe(false);
    expect(WAITING_NODE_TYPES.has('update_deal_fields')).toBe(false);
    expect(edgesOf(graph.nodes[0]!)).toEqual([{ label: 'next', target: 'bye' }]);
  });

  it('takes a pipeline and up to 20 fields with values of up to 500 characters, trimmed', () => {
    expect(AUTOMATION_LIMITS.dealFieldValues).toBe(20);
    expect(
      graphOf(graphInput({ values: [{ field: 'region', value: '  North  ' }] })).nodes[0],
    ).toMatchObject({ values: [{ field: 'region', value: 'North' }] });
    // A value left empty (clears the field) and no values at all (checked with the graph) parse.
    expect(
      graphOf(graphInput({ values: [{ field: 'region', value: '   ' }] })).nodes[0],
    ).toMatchObject({ values: [{ field: 'region', value: '' }] });
    expect(parseGraph(graphInput({ values: [] })).ok).toBe(true);
    expect(
      parseGraph(graphInput({ values: [{ field: 'region', value: 'x'.repeat(500) }] })).ok,
    ).toBe(true);
    const twenty = Array.from({ length: 20 }, (_, i) => ({ field: `f${i}`, value: '' }));
    expect(parseGraph(graphInput({ values: twenty })).ok).toBe(true);
    for (const bad of [
      { pipelineId: 'sales' },
      { pipelineId: null },
      { values: [...twenty, { field: 'f20', value: '' }] },
      { values: [{ field: 'Region', value: 'North' }] },
      { values: [{ field: '', value: 'North' }] },
      { values: [{ field: 'region', value: 'x'.repeat(501) }] },
      { values: [{ field: 'region' }] },
      { values: [{ field: 'region', value: 3 }] },
      { values: null },
    ]) {
      expect(parseGraph(graphInput(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(
      parseGraph(graphInput({ values: [...twenty, { field: 'f20', value: '' }] })),
    ).toMatchObject({ ok: false, issues: [{ message: 'A step sets at most 20 deal fields.' }] });
  });

  it('checks the pipeline, the fields and the values without placeholders with the graph', () => {
    expect(issuesOf({})).toEqual([]);
    const error = (message: string) => ({ level: 'error', nodeId: 'fields', message });
    expect(issuesOf({ pipelineId: OTHER_PIPELINE })).toEqual([
      error('Choose an active pipeline for the deal to update.'),
    ]);
    expect(issuesOf({ values: [] })).toEqual([error('Choose at least one deal field to set.')]);
    expect(
      issuesOf({
        values: [
          { field: 'tier', value: 'Gold' },
          { field: 'tier', value: 'Silver' },
        ],
      }),
    ).toEqual([error('Set each deal field once: “tier” is set twice.')]);
    expect(issuesOf({ values: [{ field: 'seats', value: '3' }] })).toEqual([
      error('The deal field “seats” does not exist.'),
    ]);
    // A company without deal fields is told to add them, not that each row's field is unknown.
    expect(issuesOf({}, { ...refs, dealFields: new Map() })).toEqual([
      error('Add deal fields in the settings of pipelines first.'),
    ]);
    // Each value is read as a member types it in the deal's form.
    for (const [field, value, message] of [
      ['budget', 'lots', 'Budget must be a number.'],
      ['budget', '2,500', 'Budget must be a number.'],
      ['visit', '2026-02-30', 'Visit must be a date written as YYYY-MM-DD.'],
      ['visit', '16/10/2026', 'Visit must be a date written as YYYY-MM-DD.'],
      ['trial', 'maybe', 'Trial must be yes or no.'],
      ['tier', 'Platinum', 'Tier must be one of its options.'],
      ['region', 'x'.repeat(500), null],
    ] as const) {
      expect(issuesOf({ values: [{ field, value }] }), `${field}: ${value}`).toEqual(
        message ? [error(message)] : [],
      );
    }
    for (const [field, value] of [
      ['budget', '2500.50'],
      ['budget', '-3'],
      ['visit', '2026-10-31'],
      ['trial', 'yes'],
      ['trial', 'No'],
      ['tier', 'silver'],
      ['region', 'North {{name}}'],
      // Empty clears the field, whatever its type.
      ['tier', ''],
      ['visit', ''],
    ] as const) {
      expect(issuesOf({ values: [{ field, value }] }), `${field}: ${value}`).toEqual([]);
    }
  });

  it('leaves values with placeholders to the run, and checks the placeholders as other texts', () => {
    // Placeholders may fill in a value the field takes: checked when the step runs.
    for (const [field, value] of [
      ['budget', '{{answer.budget}}'],
      ['visit', '{{answer.budget}}'],
      ['trial', '{{answer.budget}}'],
      ['tier', '{{answer.budget}}'],
    ] as const) {
      expect(issuesOf({ values: [{ field, value }] }), field).toEqual([]);
    }
    // Only placeholders is no warning: an empty result changes nothing and says so.
    expect(issuesOf({ values: [{ field: 'region', value: '{{name}}' }] })).toEqual([]);
    expect(issuesOf({ values: [{ field: 'region', value: '{{nickname}}' }] })).toEqual([
      {
        level: 'error',
        nodeId: 'fields',
        message:
          'Unknown placeholder {{nickname}}. Use {{name}}, {{company}} or {{answer.<name>}}.',
      },
    ]);
    expect(
      issuesOf({ values: [{ field: 'region', value: '{{answer.city}}' }] }).map((i) => i.message),
    ).toEqual(['{{answer.city}} is not saved by any question or web request.']);
    expect(
      issuesOf({ values: [{ field: 'region', value: '{{order.number}}' }] }).map((i) => i.message),
    ).toEqual([
      '{{order.number}} is an order field: order fields work only in automations started by a store’s order messages.',
    ]);
  });

  it('checks only what it is given: without the company’s fields or pipelines, nothing of theirs', () => {
    const unknown = {
      pipelineId: OTHER_PIPELINE,
      values: [
        { field: 'seats', value: '3' },
        { field: 'tier', value: 'Platinum' },
      ],
    };
    expect(issuesOf(unknown, {})).toEqual([]);
    expect(issuesOf(unknown, { dealFields: refs.dealFields }).map((i) => i.message)).toEqual([
      'The deal field “seats” does not exist.',
      'Tier must be one of its options.',
    ]);
    expect(issuesOf(unknown, { crmPipelines: refs.crmPipelines }).map((i) => i.message)).toEqual([
      'Choose an active pipeline for the deal to update.',
    ]);
    // No field at all is an error whatever is known.
    expect(issuesOf({ values: [] }, {}).map((i) => i.message)).toEqual([
      'Choose at least one deal field to set.',
    ]);
  });

  it('renders each value and goes on; empty values clear, empty results stay empty', () => {
    const graph = graphOf(
      graphInput({
        values: [
          { field: 'tier', value: 'Gold' },
          { field: 'budget', value: '{{answer.budget}}' },
          { field: 'region', value: '' },
          { field: 'visit', value: '{{answer.visit}}' },
          { field: 'trial', value: '  {{answer.trial}} ' },
        ],
      }),
    );
    expect(run(graph, { budget: ' 2500 ', trial: 'yes' })).toMatchObject({
      effects: [
        {
          kind: 'update_deal_fields',
          pipelineId: PIPELINE,
          values: [
            { field: 'tier', value: 'Gold' },
            { field: 'budget', value: '2500' },
            { field: 'region', value: null },
            // Its placeholder filled in nothing: the runner changes nothing and says so.
            { field: 'visit', value: '' },
            { field: 'trial', value: 'yes' },
          ],
        },
      ],
      status: 'running',
      state: { nodeId: 'bye', messages: 0 },
      log: { nodeId: 'fields', nodeType: 'update_deal_fields', outcome: 'updated' },
    });
    // A value is clipped to 500 characters once filled in, as a contact field's is.
    const long = run(
      graphOf(graphInput({ values: [{ field: 'region', value: 'Near {{answer.city}}' }] })),
      { city: 'x'.repeat(600) },
    );
    const effect = long.effects[0];
    expect(effect?.kind === 'update_deal_fields' ? effect.values[0]?.value : null).toHaveLength(
      AUTOMATION_LIMITS.fieldValueLength,
    );
    // The contact's name and the company.
    expect(
      run(graphOf(graphInput({ values: [{ field: 'region', value: '{{name}} at {{company}}' }] })))
        .effects,
    ).toEqual([
      {
        kind: 'update_deal_fields',
        pipelineId: PIPELINE,
        values: [{ field: 'region', value: 'Asha Rao at Acme' }],
      },
    ]);
  });
});

describe('a deal’s values after a step sets some (ADR-386)', () => {
  const fields = Object.entries(DEAL_FIELDS).map(([key, field]) => ({ key, ...field }));
  const current = { region: 'North', tier: 'Silver', budget: 100 };

  it('merges the values set over the current ones, read as the deal’s form reads them', () => {
    expect(
      stepDealAttributes(fields, current, [
        { field: 'tier', value: 'gold' },
        { field: 'budget', value: '2500.5' },
        { field: 'visit', value: '2026-10-31' },
        { field: 'trial', value: 'Yes' },
      ]),
    ).toEqual({
      ok: true,
      attributes: {
        region: 'North',
        // A choice is stored as the option is written.
        tier: 'Gold',
        budget: 2500.5,
        visit: '2026-10-31',
        trial: true,
      },
    });
    expect(stepDealAttributes(fields, current, [{ field: 'trial', value: 'no' }])).toEqual({
      ok: true,
      attributes: { ...current, trial: false },
    });
  });

  it('clears a field for a value left empty, and drops values of fields that no longer exist', () => {
    expect(
      stepDealAttributes(fields, { ...current, seats: 4 }, [
        { field: 'tier', value: null },
        { field: 'visit', value: null },
      ]),
    ).toEqual({ ok: true, attributes: { region: 'North', budget: 100 } });
  });

  it('changes nothing, naming the first field it cannot set, when one value cannot be set', () => {
    const note = (given: { field: string; value: string | null }[]) =>
      stepDealAttributes(fields, current, given);
    expect(note([{ field: 'seats', value: '3' }])).toEqual({
      ok: false,
      note: 'deal_field_missing:seats',
    });
    expect(note([{ field: 'region', value: '' }])).toEqual({
      ok: false,
      note: 'deal_field_empty:region',
    });
    expect(note([{ field: 'region', value: '   ' }])).toEqual({
      ok: false,
      note: 'deal_field_empty:region',
    });
    for (const [field, value] of [
      ['tier', 'Platinum'],
      ['budget', 'lots'],
      ['visit', '2026-02-30'],
      ['trial', 'maybe'],
      ['region', 'x'.repeat(501)],
    ] as const) {
      expect(note([{ field, value }]), field).toEqual({
        ok: false,
        note: `deal_field_invalid:${field}`,
      });
    }
    // In the order given: a good value before a bad one is not set either.
    expect(
      note([
        { field: 'tier', value: 'Gold' },
        { field: 'budget', value: 'lots' },
        { field: 'seats', value: '3' },
      ]),
    ).toEqual({ ok: false, note: 'deal_field_invalid:budget' });
    // Options changed since the step was published.
    const fewer = fields.map((f) => (f.key === 'tier' ? { ...f, options: ['Silver'] } : f));
    expect(stepDealAttributes(fewer, current, [{ field: 'tier', value: 'Gold' }])).toEqual({
      ok: false,
      note: 'deal_field_invalid:tier',
    });
  });

  it('refuses values over the bound on a deal’s values in all', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      key: `f${i}`,
      label: `F${i}`,
      type: 'text' as const,
      options: null,
    }));
    const full = Object.fromEntries(many.slice(0, 24).map((f) => [f.key, 'x'.repeat(490)]));
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(MAX_DEAL_ATTRIBUTES_BYTES);
    expect(stepDealAttributes(many, full, [{ field: 'f24', value: 'x'.repeat(490) }])).toEqual({
      ok: false,
      note: 'deal_fields_too_large',
    });
    expect(stepDealAttributes(many, full, [{ field: 'f0', value: null }])).toMatchObject({
      ok: true,
    });
  });
});
