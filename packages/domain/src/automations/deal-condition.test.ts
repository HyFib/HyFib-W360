import { describe, expect, it } from 'vitest';
import {
  COMPARISONS,
  DEAL_FIELD_COMPARISONS,
  NODE_TYPES,
  checkGraph,
  dealFieldRuleValue,
  parseGraph,
  usesDealConditions,
  type AutomationGraph,
  type DealFieldRule,
  type GraphReferences,
} from './graph';
import {
  advance,
  evaluateDealFieldRule,
  evaluateRule,
  initialRunState,
  type DealFacts,
  type RunFacts,
} from './interpreter';
import type { DealFieldShape } from '../crm/deal-field-values';

/** Conditions on the custom fields of the run's contact's open CRM deal (ADR-393). */

const RUN = '0190a3e4-1111-7000-8000-000000000001';
const PIPELINE = '0190a3e4-4444-7000-8000-000000000004';
const STAGE = '0190a3e4-5555-7000-8000-000000000005';
const OTHER_PIPELINE = '0190a3e4-8888-7000-8000-000000000008';
const NOW = new Date('2026-10-16T10:00:00Z');

const DEAL_FIELDS: Record<string, DealFieldShape> = {
  region: { label: 'Region', type: 'text', options: null },
  budget: { label: 'Budget', type: 'number', options: null },
  visit: { label: 'Visit', type: 'date', options: null },
  trial: { label: 'Trial', type: 'boolean', options: null },
  tier: { label: 'Tier', type: 'choice', options: ['Gold', 'Silver', 'Bronze'] },
};
const dealFields = new Map(Object.entries(DEAL_FIELDS));

const refs: GraphReferences = {
  crmPipelines: new Map([[PIPELINE, { currency: 'INR', stageIds: new Set([STAGE]) }]]),
  dealFields,
};

const baseFacts: RunFacts = {
  contactName: 'Asha Rao',
  companyName: 'Acme',
  tags: new Set(),
  conversationTags: new Set(),
  fields: {},
  businessOpen: true,
};

/** Facts with one open deal holding `attributes` in the pipeline. */
const withDeal = (attributes: Record<string, string | number | boolean>): RunFacts => ({
  ...baseFacts,
  deals: new Map<string, DealFacts>([[PIPELINE, { ok: true, attributes }]]),
  dealFields,
});

const rule = (overrides: Partial<DealFieldRule> = {}): DealFieldRule => ({
  kind: 'deal_field',
  pipelineId: PIPELINE,
  field: 'region',
  op: 'equals',
  value: 'North',
  ...overrides,
});

const graphInput = (rules: unknown[], match: 'all' | 'any' = 'all') => ({
  version: 1,
  start: 'check',
  nodes: [
    { id: 'check', type: 'condition', match, rules, then: 'yes', else: 'no' },
    { id: 'yes', type: 'send_text', text: 'Gold service.', next: null },
    { id: 'no', type: 'send_text', text: 'Standard service.', next: null },
  ],
});

function graphOf(input: unknown): AutomationGraph {
  const parsed = parseGraph(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.graph;
}

/** The condition's error messages with these references. */
const errorsOf = (rules: unknown[], references: GraphReferences = refs) =>
  checkGraph(graphOf(graphInput(rules)), references)
    .filter((issue) => issue.nodeId === 'check' && issue.level === 'error')
    .map((issue) => issue.message);

/** Whether the rule holds on a deal with these values, and the note it gives. */
const check = (r: Partial<DealFieldRule>, attributes: Record<string, string | number | boolean>) =>
  evaluateDealFieldRule(rule(r), withDeal(attributes));

const holds = (r: Partial<DealFieldRule>, attributes: Record<string, string | number | boolean>) =>
  check(r, attributes).result;

const runOnce = (graph: AutomationGraph, facts: RunFacts) =>
  advance({
    graph,
    state: initialRunState(graph),
    event: { kind: 'continue' },
    facts,
    runId: RUN,
    now: NOW,
  });

describe('the deal field rule of a condition (ADR-393)', () => {
  it('is a rule kind of the condition node, not a new kind of step', () => {
    const graph = graphOf(graphInput([rule()]));
    expect(graph.nodes[0]).toMatchObject({ type: 'condition', rules: [rule()] });
    expect(NODE_TYPES).not.toContain('deal_field');
    expect(usesDealConditions(graph)).toBe(true);
    expect(usesDealConditions(graphOf(graphInput([{ kind: 'business_hours', op: 'open' }])))).toBe(
      false,
    );
  });

  it('names a pipeline by id, a deal field by key and a comparison; the value is trimmed', () => {
    expect(graphOf(graphInput([rule({ value: '  North  ' })])).nodes[0]).toMatchObject({
      rules: [{ value: 'North' }],
    });
    expect(parseGraph(graphInput([rule({ op: 'is_set', value: null })])).ok).toBe(true);
    for (const bad of [
      { pipelineId: 'sales' },
      { pipelineId: null },
      { field: 'Region' },
      { field: '' },
      { op: 'before' },
      { value: 'x'.repeat(201) },
    ]) {
      expect(parseGraph(graphInput([{ ...rule(), ...bad }])).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseGraph(graphInput([{ ...rule(), value: 'x'.repeat(200) }])).ok).toBe(true);
  });

  it('takes the comparisons of its field’s type, reusing the condition’s comparisons', () => {
    expect(DEAL_FIELD_COMPARISONS).toEqual({
      text: ['equals', 'not_equals', 'contains', 'is_set', 'is_not_set'],
      number: ['equals', 'not_equals', 'greater_than', 'less_than', 'is_set', 'is_not_set'],
      date: ['equals', 'not_equals', 'less_than', 'greater_than', 'is_set', 'is_not_set'],
      boolean: ['equals', 'is_set', 'is_not_set'],
      choice: ['equals', 'not_equals', 'is_set', 'is_not_set'],
    });
    for (const list of Object.values(DEAL_FIELD_COMPARISONS)) {
      for (const op of list) expect(COMPARISONS).toContain(op);
    }
  });

  it('reads its value as the deal’s form reads a typed value', () => {
    expect(dealFieldRuleValue({ op: 'equals', value: 'North' }, DEAL_FIELDS.region!)).toEqual({
      ok: true,
      value: 'North',
    });
    expect(
      dealFieldRuleValue({ op: 'greater_than', value: '2500.5' }, DEAL_FIELDS.budget!),
    ).toEqual({ ok: true, value: 2500.5 });
    expect(
      dealFieldRuleValue({ op: 'less_than', value: '2026-11-01' }, DEAL_FIELDS.visit!),
    ).toEqual({ ok: true, value: '2026-11-01' });
    expect(dealFieldRuleValue({ op: 'equals', value: 'No' }, DEAL_FIELDS.trial!)).toEqual({
      ok: true,
      value: false,
    });
    // A choice in any case, as the option is written.
    expect(dealFieldRuleValue({ op: 'equals', value: 'gOLD' }, DEAL_FIELDS.tier!)).toEqual({
      ok: true,
      value: 'Gold',
    });
    expect(dealFieldRuleValue({ op: 'is_not_set', value: 'ignored' }, DEAL_FIELDS.tier!)).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe('publishing checks of deal field rules (ADR-393)', () => {
  it('accept a rule for each type and comparison it takes', () => {
    const values: Record<string, string> = {
      region: 'North',
      budget: '10',
      visit: '2026-11-01',
      trial: 'yes',
      tier: 'Silver',
    };
    for (const [key, field] of Object.entries(DEAL_FIELDS)) {
      for (const op of DEAL_FIELD_COMPARISONS[field.type]) {
        const value = op === 'is_set' || op === 'is_not_set' ? null : values[key]!;
        expect(errorsOf([rule({ field: key, op, value })]), `${key} ${op}`).toEqual([]);
      }
    }
  });

  it('refuse a pipeline that is not active, and a field the company does not have', () => {
    expect(errorsOf([rule({ pipelineId: OTHER_PIPELINE })])).toEqual([
      'Choose an active pipeline for the deal the rule checks.',
    ]);
    expect(errorsOf([rule({ field: 'seats' })])).toEqual([
      'The deal field “seats” does not exist.',
    ]);
    expect(errorsOf([rule()], { ...refs, dealFields: new Map() })).toEqual([
      'Add deal fields in the settings of pipelines first.',
    ]);
  });

  it('refuse a comparison the field’s type does not take', () => {
    for (const [field, op] of [
      ['region', 'greater_than'],
      ['region', 'less_than'],
      ['budget', 'contains'],
      ['visit', 'contains'],
      ['trial', 'not_equals'],
      ['trial', 'contains'],
      ['tier', 'contains'],
      ['tier', 'greater_than'],
    ] as const) {
      const label = DEAL_FIELDS[field]!.label;
      expect(errorsOf([rule({ field, op, value: 'x' })]), `${field} ${op}`).toEqual([
        `${label} cannot be compared that way. Choose another comparison.`,
      ]);
    }
  });

  it('refuse a value the field does not take, or none where one is needed', () => {
    expect(errorsOf([rule({ field: 'budget', op: 'greater_than', value: 'ten' })])).toEqual([
      'Budget must be a number.',
    ]);
    expect(errorsOf([rule({ field: 'visit', op: 'less_than', value: '2026-02-30' })])).toEqual([
      'Visit must be a date written as YYYY-MM-DD.',
    ]);
    expect(errorsOf([rule({ field: 'visit', value: '01/11/2026' })])).toEqual([
      'Visit must be a date written as YYYY-MM-DD.',
    ]);
    expect(errorsOf([rule({ field: 'trial', value: 'maybe' })])).toEqual([
      'Trial must be yes or no.',
    ]);
    expect(errorsOf([rule({ field: 'tier', value: 'Platinum' })])).toEqual([
      'Tier must be one of its options.',
    ]);
    expect(errorsOf([rule({ value: null })])).toEqual(['A rule is missing its value.']);
    expect(errorsOf([rule({ value: '' })])).toEqual(['A rule is missing its value.']);
    // Without the company's definitions (a draft checked alone), only a missing value is named.
    expect(errorsOf([rule({ value: '' })], {})).toEqual(['A rule is missing its value.']);
    expect(errorsOf([rule({ field: 'seats', op: 'contains', value: 'x' })], {})).toEqual([]);
  });

  it('take placeholders as written: they are not filled in', () => {
    // Text compares with the braces; a number with a placeholder is not a number.
    expect(errorsOf([rule({ value: '{{answer.region}}' })])).toEqual([]);
    expect(errorsOf([rule({ field: 'budget', value: '{{answer.budget}}' })])).toEqual([
      'Budget must be a number.',
    ]);
  });
});

describe('evaluating deal field rules (ADR-393)', () => {
  it('compares text ignoring case, as contact field rules do', () => {
    expect(holds({ value: 'north' }, { region: 'North' })).toBe(true);
    expect(holds({ value: 'South' }, { region: 'North' })).toBe(false);
    expect(holds({ op: 'not_equals', value: 'SOUTH' }, { region: 'North' })).toBe(true);
    expect(holds({ op: 'not_equals', value: 'NORTH' }, { region: 'North' })).toBe(false);
    expect(holds({ op: 'contains', value: 'ORT' }, { region: 'North' })).toBe(true);
    expect(holds({ op: 'contains', value: 'east' }, { region: 'North' })).toBe(false);
    expect(holds({ op: 'is_set', value: null }, { region: 'North' })).toBe(true);
    expect(holds({ op: 'is_not_set', value: null }, { region: 'North' })).toBe(false);
    // A deal without the value: empty, and "is not" holds as for contact fields.
    expect(holds({ op: 'is_not_set', value: null }, {})).toBe(true);
    expect(holds({ op: 'is_set', value: null }, {})).toBe(false);
    expect(holds({ value: 'North' }, {})).toBe(false);
    expect(holds({ op: 'not_equals', value: 'North' }, {})).toBe(true);
    expect(holds({ op: 'contains', value: 'N' }, {})).toBe(false);
  });

  it('compares numbers as numbers, not as text', () => {
    const budget = (op: DealFieldRule['op'], value: string, actual?: number) =>
      holds({ field: 'budget', op, value }, actual === undefined ? {} : { budget: actual });
    // As text "9" would come after "10".
    expect(budget('greater_than', '10', 9)).toBe(false);
    expect(budget('less_than', '10', 9)).toBe(true);
    expect(budget('greater_than', '9', 10)).toBe(true);
    expect(budget('greater_than', '10', 10)).toBe(false);
    expect(budget('less_than', '10', 10)).toBe(false);
    // Written as members type numbers: 2500.50 is 2500.5.
    expect(budget('equals', '2500.50', 2500.5)).toBe(true);
    expect(budget('equals', '2500', 2500.5)).toBe(false);
    expect(budget('not_equals', '2500', 2500.5)).toBe(true);
    expect(budget('not_equals', '2500.5', 2500.5)).toBe(false);
    expect(budget('less_than', '0', -3)).toBe(true);
    // Without a value only "is not" and "is empty" hold.
    expect(budget('greater_than', '0')).toBe(false);
    expect(budget('less_than', '0')).toBe(false);
    expect(budget('equals', '0')).toBe(false);
    expect(budget('not_equals', '0')).toBe(true);
    expect(holds({ field: 'budget', op: 'is_not_set', value: null }, {})).toBe(true);
    expect(holds({ field: 'budget', op: 'is_set', value: null }, { budget: 0 })).toBe(true);
  });

  it('compares dates as days: on, not on, before and after', () => {
    const visit = (op: DealFieldRule['op'], value: string, actual?: string) =>
      holds({ field: 'visit', op, value }, actual === undefined ? {} : { visit: actual });
    expect(visit('equals', '2026-11-01', '2026-11-01')).toBe(true);
    expect(visit('equals', '2026-11-02', '2026-11-01')).toBe(false);
    expect(visit('not_equals', '2026-11-02', '2026-11-01')).toBe(true);
    expect(visit('not_equals', '2026-11-01', '2026-11-01')).toBe(false);
    expect(visit('less_than', '2026-11-01', '2026-10-31')).toBe(true);
    expect(visit('less_than', '2026-11-01', '2026-11-01')).toBe(false);
    expect(visit('greater_than', '2026-11-01', '2026-11-02')).toBe(true);
    expect(visit('greater_than', '2026-11-01', '2026-11-01')).toBe(false);
    // Across a year and a month of fewer days.
    expect(visit('less_than', '2027-01-01', '2026-12-31')).toBe(true);
    expect(visit('greater_than', '2026-02-28', '2026-03-01')).toBe(true);
    expect(visit('less_than', '2026-11-01')).toBe(false);
    expect(visit('greater_than', '2026-11-01')).toBe(false);
    expect(visit('not_equals', '2026-11-01')).toBe(true);
  });

  it('reads yes/no as yes, no or not set', () => {
    const trial = (value: string | null, op: DealFieldRule['op'], actual?: boolean) =>
      holds({ field: 'trial', op, value }, actual === undefined ? {} : { trial: actual });
    expect(trial('yes', 'equals', true)).toBe(true);
    expect(trial('yes', 'equals', false)).toBe(false);
    expect(trial('no', 'equals', false)).toBe(true);
    expect(trial('no', 'equals', true)).toBe(false);
    // Not set is neither yes nor no.
    expect(trial('yes', 'equals')).toBe(false);
    expect(trial('no', 'equals')).toBe(false);
    expect(trial(null, 'is_not_set')).toBe(true);
    expect(trial(null, 'is_not_set', false)).toBe(false);
    expect(trial(null, 'is_set', false)).toBe(true);
  });

  it('matches a choice to its option as stored, whatever the case the rule wrote', () => {
    const tier = (value: string | null, op: DealFieldRule['op'], actual?: string) =>
      holds({ field: 'tier', op, value }, actual === undefined ? {} : { tier: actual });
    expect(tier('gold', 'equals', 'Gold')).toBe(true);
    expect(tier('Silver', 'equals', 'Gold')).toBe(false);
    expect(tier('SILVER', 'not_equals', 'Gold')).toBe(true);
    expect(tier('gold', 'not_equals', 'Gold')).toBe(false);
    expect(tier('Gold', 'equals')).toBe(false);
    expect(tier('Gold', 'not_equals')).toBe(true);
    expect(tier(null, 'is_set', 'Bronze')).toBe(true);
    expect(tier(null, 'is_not_set')).toBe(true);
  });

  it('does not hold without exactly one open deal, whatever the comparison, and says why', () => {
    const none: RunFacts = {
      ...baseFacts,
      deals: new Map<string, DealFacts>([[PIPELINE, { ok: false, note: 'deal_not_open' }]]),
      dealFields,
    };
    const several: RunFacts = {
      ...none,
      deals: new Map<string, DealFacts>([[PIPELINE, { ok: false, note: 'deal_ambiguous' }]]),
    };
    for (const r of [
      rule(),
      rule({ op: 'is_not_set', value: null }),
      rule({ op: 'not_equals', value: 'South' }),
    ]) {
      expect(evaluateDealFieldRule(r, none)).toEqual({ result: false, note: 'deal_not_open' });
      expect(evaluateDealFieldRule(r, several)).toEqual({ result: false, note: 'deal_ambiguous' });
    }
    // A pipeline the facts do not name reads as having no open deal there.
    expect(evaluateDealFieldRule(rule({ pipelineId: OTHER_PIPELINE }), withDeal({}))).toEqual({
      result: false,
      note: 'deal_not_open',
    });
    expect(evaluateDealFieldRule(rule(), baseFacts)).toEqual({
      result: false,
      note: 'deal_not_open',
    });
    // The runner's other notes pass through (the plan, an erased contact, an archived pipeline).
    for (const note of ['crm_not_in_plan', 'contact_erased', 'deal_stage_unavailable']) {
      expect(
        evaluateDealFieldRule(rule(), {
          ...none,
          deals: new Map<string, DealFacts>([[PIPELINE, { ok: false, note }]]),
        }),
      ).toEqual({ result: false, note });
    }
  });

  it('fails safe when the field was deleted or its value no longer fits since publishing', () => {
    const deleted: RunFacts = {
      ...withDeal({ region: 'North' }),
      dealFields: new Map([['tier', DEAL_FIELDS.tier!]]),
    };
    for (const op of ['equals', 'not_equals', 'is_not_set'] as const) {
      expect(evaluateDealFieldRule(rule({ op }), deleted)).toEqual({
        result: false,
        note: 'deal_field_missing:region',
      });
    }
    // Gold removed from the options: even "is not Gold" does not hold.
    const removed: RunFacts = {
      ...withDeal({ tier: 'Silver' }),
      dealFields: new Map([['tier', { ...DEAL_FIELDS.tier!, options: ['Silver', 'Bronze'] }]]),
    };
    expect(
      evaluateDealFieldRule(rule({ field: 'tier', op: 'not_equals', value: 'Gold' }), removed),
    ).toEqual({ result: false, note: 'deal_rule_invalid:tier' });
    // A comparison the type does not take (a graph not checked) fails safe too.
    expect(check({ field: 'trial', op: 'not_equals', value: 'yes' }, { trial: false })).toEqual({
      result: false,
      note: 'deal_rule_invalid:trial',
    });
  });

  it('reads only the deal’s own values, never inherited properties', () => {
    const facts: RunFacts = {
      ...withDeal({}),
      dealFields: new Map([['constructor', { label: 'Ctor', type: 'text', options: null }]]),
    };
    expect(
      evaluateDealFieldRule(rule({ field: 'constructor', op: 'is_set', value: null }), facts),
    ).toEqual({ result: false, note: null });
  });

  it('is evaluated through evaluateRule like the other rules', () => {
    expect(evaluateRule(rule(), withDeal({ region: 'North' }), {})).toBe(true);
    expect(evaluateRule(rule(), withDeal({ region: 'South' }), {})).toBe(false);
  });
});

describe('conditions with deal field rules in a run (ADR-393)', () => {
  it('branch on the deal’s value, with no note when the deal was read', () => {
    const graph = graphOf(graphInput([rule({ field: 'tier', value: 'gold' })]));
    const gold = runOnce(graph, withDeal({ tier: 'Gold' }));
    expect(gold.log).toMatchObject({ outcome: 'branched', branch: 'yes', detail: null });
    expect(gold.state.nodeId).toBe('yes');
    const silver = runOnce(graph, withDeal({ tier: 'Silver' }));
    expect(silver.log).toMatchObject({ outcome: 'branched', branch: 'no', detail: null });
    expect(silver.state.nodeId).toBe('no');
  });

  it('take the other branch without a deal, noting the first rule that could not read one', () => {
    const graph = graphOf(
      graphInput([
        rule({ op: 'is_not_set', value: null }),
        rule({ pipelineId: OTHER_PIPELINE, field: 'tier', value: 'Gold' }),
      ]),
    );
    const facts: RunFacts = {
      ...baseFacts,
      dealFields,
      deals: new Map<string, DealFacts>([
        [PIPELINE, { ok: false, note: 'deal_ambiguous' }],
        [OTHER_PIPELINE, { ok: false, note: 'deal_not_open' }],
      ]),
    };
    expect(runOnce(graph, facts).log).toMatchObject({
      branch: 'no',
      detail: 'deal_ambiguous',
    });
  });

  it('combine with other rules: any rule may still lead to yes, with the note kept', () => {
    const graph = graphOf(
      graphInput(
        [rule({ field: 'trial', value: 'yes' }), { kind: 'business_hours', op: 'open' }],
        'any',
      ),
    );
    const result = runOnce(graph, { ...withDeal({}), dealFields: new Map() });
    expect(result.log).toMatchObject({ branch: 'yes', detail: 'deal_field_missing:trial' });
    expect(result.effects).toEqual([]);
  });
});
