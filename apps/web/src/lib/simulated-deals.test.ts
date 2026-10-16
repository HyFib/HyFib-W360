import { describe, expect, it } from 'vitest';
import {
  advance,
  initialRunState,
  parseGraph,
  type AutomationGraph,
} from '@w360/domain/automation-model';
import { simulatedDeals, typedPairs, withPair } from './simulated-deals';

/** The simulator's deal for conditions on deal fields (ADR-393). */

const SALES = '0190a3e4-4444-7000-8000-000000000004';
const ARCHIVED = '0190a3e4-8888-7000-8000-000000000008';
const FIELDS = [
  { key: 'tier', label: 'Tier', type: 'choice' as const, options: ['Gold', 'Silver'] },
  { key: 'seats', label: 'Seats', type: 'number' as const, options: null },
  { key: 'trial', label: 'Trial', type: 'boolean' as const, options: null },
];

function graphOf(rules: unknown[]): AutomationGraph {
  const parsed = parseGraph({
    version: 1,
    start: 'check',
    nodes: [
      { id: 'check', type: 'condition', match: 'all', rules, then: 'yes', else: null },
      { id: 'yes', type: 'end' },
    ],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.graph;
}

const tierIsGold = {
  kind: 'deal_field',
  pipelineId: SALES,
  field: 'tier',
  op: 'equals',
  value: 'gold',
};

describe('the simulated deal (ADR-393)', () => {
  it('reads typed lines as the deal’s form reads values, leaving out what no field takes', () => {
    const { deals, ignored } = simulatedDeals(
      {
        deals: 'one',
        dealValues: 'tier=gold\nseats = 3\ntrial=maybe\nregion=North\nnot a line\ntrial=',
      },
      graphOf([tierIsGold]),
      [{ id: SALES }],
      FIELDS,
    );
    expect(deals.get(SALES)).toEqual({ ok: true, attributes: { tier: 'Gold', seats: 3 } });
    // The last line for trial (empty: no value) wins; what is left out is listed with why.
    expect(ignored).toEqual([{ key: 'region', message: 'no deal field has this key' }]);
    expect(
      simulatedDeals(
        { deals: 'one', dealValues: 'seats=three\ntier=Platinum\ntrial=maybe' },
        graphOf([tierIsGold]),
        [{ id: SALES }],
        FIELDS,
      ).ignored,
    ).toEqual([
      { key: 'seats', message: 'Seats must be a number.' },
      { key: 'tier', message: 'Tier must be one of its options.' },
      { key: 'trial', message: 'Trial must be yes or no.' },
    ]);
  });

  it('gives no deal or several in every pipeline, and an inactive pipeline as archived', () => {
    const graph = graphOf([tierIsGold, { ...tierIsGold, pipelineId: ARCHIVED }]);
    expect(
      simulatedDeals({ deals: 'none', dealValues: 'tier=Gold' }, graph, [{ id: SALES }], FIELDS)
        .deals,
    ).toEqual(
      new Map([
        [SALES, { ok: false, note: 'deal_not_open' }],
        [ARCHIVED, { ok: false, note: 'deal_stage_unavailable' }],
      ]),
    );
    expect(
      simulatedDeals(
        { deals: 'several', dealValues: '' },
        graph,
        [{ id: SALES }],
        FIELDS,
      ).deals.get(SALES),
    ).toEqual({ ok: false, note: 'deal_ambiguous' });
  });

  it('lets the interpreter branch on it as a run would', () => {
    const graph = graphOf([tierIsGold]);
    const branch = (dealValues: string, deals: 'one' | 'none' = 'one') =>
      advance({
        graph,
        state: initialRunState(graph),
        event: { kind: 'continue' },
        facts: {
          contactName: null,
          companyName: 'Acme',
          tags: new Set(),
          conversationTags: new Set(),
          fields: {},
          businessOpen: true,
          deals: simulatedDeals({ deals, dealValues }, graph, [{ id: SALES }], FIELDS).deals,
          dealFields: new Map(FIELDS.map((f) => [f.key, f])),
        },
        runId: '00000000-0000-4000-8000-000000000000',
        now: new Date('2026-10-16T10:00:00Z'),
      }).log;
    expect(branch('tier=Gold')).toMatchObject({ branch: 'yes', detail: null });
    expect(branch('tier=Silver')).toMatchObject({ branch: 'no', detail: null });
    expect(branch('tier=Gold', 'none')).toMatchObject({ branch: 'no', detail: 'deal_not_open' });
  });

  it('takes the values a step sets, so later conditions read them', () => {
    expect(typedPairs('a=1\nb = 2 \na=3')).toEqual(
      new Map([
        ['a', '3'],
        ['b', '2'],
      ]),
    );
    expect(withPair('tier=Silver\nseats=3', 'tier', 'Gold')).toBe('seats=3\ntier=Gold');
    expect(withPair('tier=Silver\n\nseats=3', 'tier', null)).toBe('seats=3');
    expect(withPair('', 'tier', 'Gold')).toBe('tier=Gold');
    // Another key that starts the same is kept.
    expect(withPair('tiers=2', 'tier', 'Gold')).toBe('tiers=2\ntier=Gold');
  });
});
