import { createHash } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { sql, type Tx } from '@w360/db';
import { sendSpecFor, toMetaComponents, type TemplateDefinition } from '../templates/definition';
import { combineEstimates, estimateFromTable, type RateTable } from './costs';
import { campaignVariantAnalytics, campaignVariantResultsSchema } from './results';
import {
  assertVariantTemplatesApproved,
  campaignApprovalNotice,
  emptyVariantProblem,
  nextCampaignVariants,
  prepareCampaignDraft,
  sumBreakdowns,
  updateCampaignSchema,
  type CampaignDraftInput,
} from './service';
import {
  DEFAULT_VARIANTS_LIMIT,
  MAX_VARIANTS,
  VARIANT_LABELS,
  VARIANT_SHARES,
  assignVariant,
  parseVariantLabel,
  variantBucket,
  variantConditionSql,
  variantInputSchema,
  variantLabelAt,
  variantLimitProblem,
  variantOfBucket,
  variantRanges,
  variantSendable,
  variantSetProblem,
  variantShareSchema,
  variantTemplateProblems,
  variantsInputSchema,
} from './variants';

/** A uuid-shaped id made from `seed` (deterministic, spread like random ids). */
function idFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const campaignId = idFrom('campaign-1');
const contacts = Array.from({ length: 10_000 }, (_, i) => idFrom(`contact-${i}`));

describe('variant assignment (ADR-405)', () => {
  it('gives a contact the same variant every time, and the bucket the hash names', () => {
    for (const contactId of contacts.slice(0, 200)) {
      const first = assignVariant(campaignId, contactId, [30]);
      expect(assignVariant(campaignId, contactId, [30])).toBe(first);
      // Upper-case ids (as some callers write them) hash as PostgreSQL writes uuids.
      expect(assignVariant(campaignId.toUpperCase(), contactId.toUpperCase(), [30])).toBe(first);
    }
    // The bucket is the first 32 bits of MD5("campaign:contact") modulo 100.
    const contactId = contacts[0]!;
    const digest = createHash('md5').update(`${campaignId}:${contactId}`).digest('hex');
    expect(variantBucket(campaignId, contactId)).toBe(parseInt(digest.slice(0, 8), 16) % 100);
    // Another campaign splits the same contacts differently.
    const other = idFrom('campaign-2');
    const differ = contacts
      .slice(0, 1000)
      .filter((c) => assignVariant(campaignId, c, [50]) !== assignVariant(other, c, [50]));
    expect(differ.length).toBeGreaterThan(400);
  });

  it('gives B the first share of buckets and A the rest; without B everyone is A', () => {
    expect(variantOfBucket(0, [10])).toBe('B');
    expect(variantOfBucket(9, [10])).toBe('B');
    expect(variantOfBucket(10, [10])).toBe('A');
    expect(variantOfBucket(89, [90])).toBe('B');
    expect(variantOfBucket(90, [90])).toBe('A');
    expect(variantOfBucket(0, [])).toBe('A');
    expect(variantOfBucket(99, [])).toBe('A');
    expect(contacts.every((c) => assignVariant(campaignId, c, []) === 'A')).toBe(true);
  });

  it('splits 10,000 contacts close to each share', () => {
    const deviations: number[] = [];
    for (const share of VARIANT_SHARES) {
      const b = contacts.filter((c) => assignVariant(campaignId, c, [share]) === 'B').length;
      const observed = (b / contacts.length) * 100;
      deviations.push(Math.abs(observed - share));
      // A binomial standard deviation is at most 0.5 points at n = 10,000: 1.5 points is three.
      expect(Math.abs(observed - share), `share ${share}%`).toBeLessThan(1.5);
    }
    // For these ids the largest deviation is 0.89 points (B at 50.89% of a 50% share), as ADR-405
    // records; any change to the hash would change it.
    expect(Math.max(...deviations)).toBeCloseTo(0.89, 5);
  });

  it('keeps a contact in B when the share grows (buckets are nested)', () => {
    for (const c of contacts.slice(0, 500)) {
      if (assignVariant(campaignId, c, [20]) === 'B')
        expect(assignVariant(campaignId, c, [50])).toBe('B');
    }
  });

  it('takes shares from 10% to 90% in steps of 5 only', () => {
    expect(VARIANT_SHARES).toEqual([
      10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90,
    ]);
    for (const share of VARIANT_SHARES)
      expect(variantShareSchema.safeParse(share).success).toBe(true);
    for (const share of [0, 5, 9, 12, 33, 95, 100, 50.5, '50'])
      expect(variantShareSchema.safeParse(share).success, String(share)).toBe(false);
    expect(
      variantInputSchema.safeParse({ templateId: null, variables: {}, sharePercent: 25 }).success,
    ).toBe(true);
    expect(
      variantInputSchema.safeParse({ templateId: 'nope', variables: {}, sharePercent: 25 }).success,
    ).toBe(false);
  });
});

/**
 * Every valid set of shares for the variants after A (ADR-410): one to four variants, each 10% to
 * 90% in steps of 5, leaving A at least 10%. 17 sets of two variants, 120 of three, 455 of four and
 * 1,001 of five: 1,593 in all.
 */
function allShareSets(): number[][] {
  const out: number[][] = [];
  const grow = (shares: number[]) => {
    if (shares.length > 0) out.push(shares);
    if (shares.length === MAX_VARIANTS - 1) return;
    const taken = shares.reduce((sum, s) => sum + s, 0);
    for (let share = 10; taken + share <= 90; share += 5) grow([...shares, share]);
  };
  grow([]);
  return out;
}

/** The 0.999 quantile of the chi-square distribution with 1 to 4 degrees of freedom. */
const CHI_SQUARE_999 = [10.828, 13.816, 16.266, 18.467];

describe('variant assignment for up to five variants (ADR-410)', () => {
  const sets = allShareSets();
  // Each contact's bucket, counted once: a set of shares only regroups the 100 buckets.
  const histogramOf = (id: string) => {
    const h = new Array<number>(100).fill(0);
    for (const c of contacts) h[variantBucket(id, c)]! += 1;
    return h;
  };
  const countsOf = (histogram: number[], shares: number[]) => {
    const counts = new Map<string, number>();
    for (const [bucket, n] of histogram.entries()) {
      const label = variantOfBucket(bucket, shares);
      counts.set(label, (counts.get(label) ?? 0) + n);
    }
    return counts;
  };

  it('labels the variants after A B to E, and lays their buckets end to end with A last', () => {
    expect(VARIANT_LABELS).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(MAX_VARIANTS).toBe(5);
    expect([0, 1, 2, 3].map(variantLabelAt)).toEqual(['B', 'C', 'D', 'E']);
    expect(() => variantLabelAt(4)).toThrow();
    expect(variantRanges([30, 25, 15])).toEqual([
      { label: 'B', from: 0, to: 30 },
      { label: 'C', from: 30, to: 55 },
      { label: 'D', from: 55, to: 70 },
      { label: 'A', from: 70, to: 100 },
    ]);
    // With B alone, ADR-405's rule exactly: B below its share, A from it.
    expect(variantRanges([40])).toEqual([
      { label: 'B', from: 0, to: 40 },
      { label: 'A', from: 40, to: 100 },
    ]);
    expect(variantRanges([])).toEqual([{ label: 'A', from: 0, to: 100 }]);
    for (const [bucket, label] of [
      [0, 'B'],
      [29, 'B'],
      [30, 'C'],
      [54, 'C'],
      [55, 'D'],
      [69, 'D'],
      [70, 'A'],
      [99, 'A'],
    ] as const)
      expect(variantOfBucket(bucket, [30, 25, 15]), String(bucket)).toBe(label);
    expect(() => variantOfBucket(100, [30])).toThrow(/outside/);
    expect(() => variantOfBucket(-1, [30])).toThrow(/outside/);
  });

  it('enumerates every valid set of shares', () => {
    expect(sets).toHaveLength(17 + 120 + 455 + 1001);
    for (const shares of sets) expect(variantSetProblem(shares), String(shares)).toBeNull();
  });

  it('gives a two-variant campaign the split ADR-405 gave it', () => {
    for (const share of VARIANT_SHARES)
      for (const c of contacts.slice(0, 300)) {
        const bucket = variantBucket(campaignId, c);
        expect(assignVariant(campaignId, c, [share])).toBe(bucket < share ? 'B' : 'A');
      }
  });

  it('gives a contact the same variant every time, whatever the number of variants', () => {
    for (const shares of [[20], [20, 20], [20, 20, 20], [20, 20, 20, 20], [10, 35, 15]])
      for (const c of contacts.slice(0, 200)) {
        const first = assignVariant(campaignId, c, shares);
        expect(assignVariant(campaignId, c, shares)).toBe(first);
        expect(assignVariant(campaignId.toUpperCase(), c.toUpperCase(), shares)).toBe(first);
        expect(first).toBe(variantOfBucket(variantBucket(campaignId, c), shares));
      }
    // Adding a variant takes its buckets from A only: B keeps its contacts, C's come from A.
    for (const c of contacts.slice(0, 1000)) {
      const two = assignVariant(campaignId, c, [30]);
      const three = assignVariant(campaignId, c, [30, 20]);
      if (two === 'B') expect(three).toBe('B');
      if (three === 'C') expect(two).toBe('A');
    }
  });

  it('splits 10,000 contacts within three standard deviations of every share, for every set', () => {
    const histogram = histogramOf(campaignId);
    expect(histogram.reduce((sum, n) => sum + n, 0)).toBe(contacts.length);
    const n = contacts.length;
    let largest = { deviation: 0, from: 0, to: 0 };
    for (const shares of sets) {
      const counts = countsOf(histogram, shares);
      let chi = 0;
      for (const { label, from, to } of variantRanges(shares)) {
        const share = to - from;
        const p = share / 100;
        const observed = counts.get(label) ?? 0;
        // Each variant's count is binomial (n, p): within three of its own standard deviations.
        const sd = Math.sqrt(n * p * (1 - p));
        expect(Math.abs(observed - n * p), `${shares} ${label}`).toBeLessThan(3 * sd);
        chi += (observed - n * p) ** 2 / (n * p);
        const deviation = Math.abs((observed / n) * 100 - share);
        if (deviation > largest.deviation) largest = { deviation, from, to };
      }
      // And jointly: Pearson's statistic below the chi-square's 0.999 quantile (k - 1 degrees).
      expect(chi, String(shares)).toBeLessThan(CHI_SQUARE_999[shares.length - 1]!);
    }
    // For these ids the largest deviation of any variant in any set is 1.12 points, for the
    // variant given buckets 50 to 89 (38.88% of a 40% share, 2.3 standard deviations: C in B 50%,
    // C 40%, A 10%), as ADR-410 records; any change to the hash or the ranges changes it.
    expect(largest.deviation).toBeCloseTo(1.12, 5);
    expect(largest).toMatchObject({ from: 50, to: 90 });
  });

  it('stays within ADR-405’s 1.5 points for two other campaigns, for every set', () => {
    for (const seed of ['campaign-2', 'campaign-3']) {
      const histogram = histogramOf(idFrom(seed));
      for (const shares of sets) {
        const counts = countsOf(histogram, shares);
        for (const r of variantRanges(shares)) {
          const observed = ((counts.get(r.label) ?? 0) / contacts.length) * 100;
          // Three times the largest binomial standard deviation at n = 10,000 (0.5 points).
          expect(Math.abs(observed - (r.to - r.from)), `${seed} ${shares} ${r.label}`).toBeLessThan(
            1.5,
          );
        }
      }
    }
  });

  it('selects the same buckets in SQL as in TypeScript', () => {
    const render = (shares: number[], label: (typeof VARIANT_LABELS)[number]) =>
      new PgDialect().sqlToQuery(variantConditionSql(campaignId, sql`c.id`, label, shares));
    const c = render([30, 25], 'C');
    expect(c.sql).toContain('md5(');
    expect(c.params).toEqual(expect.arrayContaining([30, 55, campaignId]));
    expect(c.sql).toMatch(/>= \$\d+ and .* < \$\d+\)$/);
    const a = render([30, 25], 'A');
    expect(a.params).toEqual(expect.arrayContaining([55, 100]));
    expect(() => render([30], 'C')).toThrow(/no variant C/);
  });
});

describe('the variants a draft may have (ADR-410)', () => {
  it('takes at most five variants, shares of 10% to 90%, and leaves A at least 10%', () => {
    expect(variantSetProblem([])).toBeNull();
    expect(variantSetProblem([90])).toBeNull();
    expect(variantSetProblem([20, 20, 20, 20])).toBeNull();
    expect(variantSetProblem([30, 30, 30])).toBeNull();
    expect(variantSetProblem([10, 10, 10, 10, 10])).toBe(
      'A campaign tests at most 5 templates, variants A to E.',
    );
    expect(variantSetProblem([30, 30, 35])).toBe(
      'Variant A needs at least 10% of the recipients: the other variants take 95%.',
    );
    expect(variantSetProblem([50, 50])).toBe(
      'Variant A needs at least 10% of the recipients: the other variants take 100%.',
    );
    expect(variantSetProblem([20, 5])).toBe(
      'Variant C: Give each variant 10% to 90% of the recipients.',
    );
    expect(variantSetProblem([20, 22])).toBe(
      "Variant C: Choose each variant's share in steps of 5%.",
    );
    expect(variantsInputSchema.safeParse([]).success).toBe(true);
    const one = { templateId: null, variables: {}, sharePercent: 10 };
    expect(variantsInputSchema.safeParse([one, one, one, one]).success).toBe(true);
    expect(variantsInputSchema.safeParse([one, one, one, one, one]).success).toBe(false);
  });

  it('reads back the labels HyFib writes, and refuses any other', () => {
    for (const label of VARIANT_LABELS) expect(parseVariantLabel(label)).toBe(label);
    for (const bad of ['F', 'Z', 'a', '', 'AB']) expect(() => parseVariantLabel(bad)).toThrow();
  });

  const base: CampaignDraftInput = {
    name: 'Festive sale',
    channelAccountId: null,
    templateId: null,
    variables: { header: [], body: [], buttons: [] },
    audience: { kind: 'none' },
    schedule: { kind: 'now', timezone: 'Asia/Kolkata' },
    window: null,
    ratePerMinute: null,
    maxMessages: null,
    budget: null,
    stopAfterHours: 24,
  };
  const v = (sharePercent: number) => ({
    templateId: null,
    variables: { header: [], body: [] },
    sharePercent,
  });
  const stored = (label: 'B' | 'C' | 'D' | 'E', sharePercent: number) => ({
    label,
    templateId: null,
    variables: { header: [], body: [], buttons: [] },
    sharePercent,
  });

  it('prepares a list of variants, B first, or B alone, never both', () => {
    expect(prepareCampaignDraft(base).variants).toEqual({ kind: 'keep' });
    expect(prepareCampaignDraft({ ...base, variants: [v(30), v(20)] }).variants).toMatchObject({
      kind: 'replace',
      variants: [{ sharePercent: 30 }, { sharePercent: 20 }],
    });
    expect(prepareCampaignDraft({ ...base, variants: [] }).variants).toEqual({
      kind: 'replace',
      variants: [],
    });
    expect(prepareCampaignDraft({ ...base, variants: null }).variants).toEqual({
      kind: 'replace',
      variants: [],
    });
    // ADR-405's variantB: null removes every variant, given it sets B alone.
    expect(prepareCampaignDraft({ ...base, variantB: null }).variants).toEqual({
      kind: 'replace',
      variants: [],
    });
    expect(prepareCampaignDraft({ ...base, variantB: v(40) }).variants).toMatchObject({
      kind: 'setB',
      variant: { sharePercent: 40 },
    });
    expect(() => prepareCampaignDraft({ ...base, variantB: v(40), variants: [] })).toThrow(
      'Give either variantB or variants, not both.',
    );
    expect(() => prepareCampaignDraft({ ...base, variants: [v(40), v(40), v(15)] })).toThrow(
      'Variant A needs at least 10% of the recipients: the other variants take 95%.',
    );
    // Each variant's mapping is checked as A's, and the problem names its variant.
    expect(() =>
      prepareCampaignDraft({
        ...base,
        variants: [v(20), { ...v(20), variables: { body: [{ source: 'nope' }] } }],
      }),
    ).toThrow('Variant C: Choose a value for every template variable.');
    expect(
      updateCampaignSchema.shape.variants.safeParse([v(10), v(10), v(10), v(10), v(10)]).success,
    ).toBe(false);
  });

  it('grows past this server’s limit never, keeps C to E when B alone changes, and trims freely', () => {
    expect(DEFAULT_VARIANTS_LIMIT).toBe(2);
    const three = {
      kind: 'replace' as const,
      variants: [v(30), v(20)].map((x) => ({
        ...x,
        variables: { header: [], body: [], buttons: [] },
      })),
    };
    // Two variants (A and B) is what the release before builds: always allowed.
    expect(
      nextCampaignVariants([], { ...three, variants: three.variants.slice(0, 1) }, 2).problem,
    ).toBeNull();
    // A third needs a limit of three or more.
    expect(nextCampaignVariants([], three, 2).problem).toBe(variantLimitProblem(2));
    expect(variantLimitProblem(2)).toBe(
      'A campaign can test at most 2 templates for now, variants A to B.',
    );
    expect(nextCampaignVariants([], three, 3).problem).toBeNull();
    expect(nextCampaignVariants([stored('B', 30)], three, 2).problem).toBe(variantLimitProblem(2));
    // A draft that already has three (the limit lowered for a rollback) can be edited or trimmed.
    const had = [stored('B', 30), stored('C', 20)];
    expect(nextCampaignVariants(had, three, 2).problem).toBeNull();
    expect(nextCampaignVariants(had, { kind: 'replace', variants: [] }, 2)).toEqual({
      variants: [],
      problem: null,
    });
    // B alone keeps the variants after it, so a client of ADR-405 never drops them.
    const setB = {
      kind: 'setB' as const,
      variant: {
        templateId: null,
        variables: { header: [], body: [], buttons: [] },
        sharePercent: 45,
      },
    };
    const next = nextCampaignVariants(had, setB, 5);
    expect(next.problem).toBeNull();
    expect(next.variants.map((x) => x.sharePercent)).toEqual([45, 20]);
    // … and its share is checked with theirs.
    expect(
      nextCampaignVariants(had, { ...setB, variant: { ...setB.variant, sharePercent: 75 } }, 5)
        .problem,
    ).toBe('Variant A needs at least 10% of the recipients: the other variants take 95%.');
    expect(nextCampaignVariants([], setB, 2).variants.map((x) => x.sharePercent)).toEqual([45]);
  });
});

describe('results per variant (ADR-410)', () => {
  it('counts each of the campaign’s variants, as many as it tests, over its recipients only', async () => {
    const audiences: Record<string, number> = { A: 40, B: 35, C: 25 };
    const asked: string[] = [];
    const tx = {
      execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
        const { params } = new PgDialect().sqlToQuery(query);
        const label = params.find((p) => typeof p === 'string' && /^[A-E]$/.test(p)) as string;
        asked.push(label);
        return {
          rows: [
            {
              audience: audiences[label],
              queued: audiences[label],
              skip_reasons: [],
              failure_codes: [],
            },
          ],
        };
      },
    } as unknown as Tx;
    const results = await campaignVariantAnalytics(tx, 'tenant', 'campaign', ['A', 'B', 'C']);
    expect(asked).toEqual(['A', 'B', 'C']);
    expect(results.map((r) => [r.variant, r.analytics.audience])).toEqual([
      ['A', 40],
      ['B', 35],
      ['C', 25],
    ]);
    // A two-variant campaign reports two, never empty C to E.
    expect((await campaignVariantAnalytics(tx, 'tenant', 'campaign', ['A', 'B'])).length).toBe(2);
    // The API takes C to E as variants of the results, with A's share of at least 10%.
    const shape = campaignVariantResultsSchema.shape;
    for (const label of VARIANT_LABELS) expect(shape.variant.safeParse(label).success).toBe(true);
    expect(shape.variant.safeParse('F').success).toBe(false);
    expect(shape.sharePercent.safeParse(10).success).toBe(true);
  });
});

const marketing: TemplateDefinition = {
  category: 'MARKETING',
  header: { type: 'none' },
  body: { text: 'Hello {{1}}, our sale starts today.', examples: ['Asha'] },
  footer: null,
  buttons: [],
};
const utility: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'none' },
  body: { text: 'Your order is ready.', examples: [] },
  footer: null,
  buttons: [],
};

function templateOf(definition: TemplateDefinition, over: { status?: string; waba?: string } = {}) {
  return {
    status: over.status ?? 'approved',
    whatsappAccountId: over.waba ?? 'waba-1',
    spec: sendSpecFor(definition.category, toMetaComponents(definition)),
  };
}

describe('checks per variant (ADR-405)', () => {
  const channel = { whatsappAccountId: 'waba-1' };
  const nameVar = {
    header: [],
    body: [{ source: 'name' as const, fallback: 'there' }],
    buttons: [],
  };
  const none = { header: [], body: [], buttons: [] };
  const fields = new Set<string>();

  it('word a campaign without B as campaigns always did', () => {
    expect(variantTemplateProblems(null, null, channel, none, fields)).toEqual([
      'Choose an approved template.',
    ]);
    expect(
      variantTemplateProblems(
        null,
        templateOf(marketing, { status: 'pending' }),
        channel,
        nameVar,
        fields,
      ),
    ).toEqual(['The template is not approved by Meta.']);
    expect(variantTemplateProblems(null, templateOf(marketing), channel, nameVar, fields)).toEqual(
      [],
    );
  });

  it('name the variant each problem is about', () => {
    expect(variantTemplateProblems('B', null, channel, none, fields)).toEqual([
      'Variant B: Choose an approved template.',
    ]);
    expect(
      variantTemplateProblems(
        'B',
        templateOf(marketing, { status: 'rejected' }),
        channel,
        nameVar,
        fields,
      ),
    ).toEqual(['Variant B: The template is not approved by Meta.']);
    expect(
      variantTemplateProblems('B', templateOf(utility, { waba: 'waba-2' }), channel, none, fields),
    ).toEqual([
      'Variant B: The template belongs to another WhatsApp account than the chosen number.',
    ]);
    // Its own mapping: B's template takes one body variable that is not filled.
    expect(variantTemplateProblems('B', templateOf(marketing), channel, none, fields)).toEqual([
      'Variant B: Choose a value for every template variable.',
    ]);
    expect(
      variantTemplateProblems(
        'A',
        templateOf(marketing),
        channel,
        { header: [], body: [{ source: 'field', key: 'city' }], buttons: [] },
        fields,
      ),
    ).toEqual(['Variant A: A variable uses a custom field that no longer exists.']);
    expect(variantTemplateProblems('A', templateOf(utility), channel, none, fields)).toEqual([]);
  });

  it('let the runner send a variant only while its template takes its mapping', () => {
    expect(variantSendable(templateOf(marketing), channel, nameVar)).toBe(true);
    expect(variantSendable(templateOf(marketing), channel, none)).toBe(false);
    expect(variantSendable(templateOf(marketing, { status: 'paused' }), channel, nameVar)).toBe(
      false,
    );
    expect(variantSendable(templateOf(marketing, { waba: 'waba-9' }), channel, nameVar)).toBe(
      false,
    );
    expect(variantSendable(null, channel, nameVar)).toBe(false);
  });
});

describe('costs per variant (ADR-405)', () => {
  const table: RateTable = {
    cardId: 'card',
    currency: 'INR',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    prefixes: [
      { prefix: '971', market: 'United Arab Emirates' },
      { prefix: '91', market: 'India' },
    ],
    prices: new Map([
      ['India|marketing', 862_500],
      ['India|utility', 115_000],
      ['United Arab Emirates|marketing', 1_725_000],
      ['United Arab Emirates|utility', 657_000],
    ]),
  };

  it("price each variant's recipients at its own template's category, once each", () => {
    const a = estimateFromTable(table, 'MARKETING', [
      '+919800000001',
      '+919800000002',
      '+971500000001',
    ]);
    const b = estimateFromTable(table, 'UTILITY', ['+919800000003', '+14155550100']);
    expect(a).toEqual({
      currency: 'INR',
      totalMicros: 862_500 * 2 + 1_725_000,
      pricedCount: 3,
      unpricedCount: 0,
      byMarket: [
        { market: 'India', count: 2, micros: 1_725_000 },
        { market: 'United Arab Emirates', count: 1, micros: 1_725_000 },
      ],
    });
    expect(b).toMatchObject({ totalMicros: 115_000, pricedCount: 1, unpricedCount: 1 });
    const total = combineEstimates([a, b]);
    // Every recipient counted once: 4 priced plus 1 without a price, the sum of the two.
    expect(total).toEqual({
      currency: 'INR',
      totalMicros: 862_500 * 2 + 1_725_000 + 115_000,
      pricedCount: 4,
      unpricedCount: 1,
      byMarket: [
        { market: 'India', count: 3, micros: 1_840_000 },
        { market: 'United Arab Emirates', count: 1, micros: 1_725_000 },
      ],
    });
    expect(Number.isInteger(total?.totalMicros)).toBe(true);
    // A campaign without B: the one estimate unchanged.
    expect(combineEstimates([a])).toEqual(a);
    expect(combineEstimates([])).toBeNull();
    expect(() => combineEstimates([a, { ...b, currency: 'USD' }])).toThrow(/currencies/);
  });
});

describe('the approval email with variants (ADR-405)', () => {
  const base = {
    campaignName: 'Festive sale',
    submitter: { kind: 'member' as const, name: 'Asha' },
    pending: 1200,
    total: 1300,
    startsAt: null,
    approveBy: null,
    timeZone: 'Asia/Kolkata',
  };

  it('names both templates, their shares and pending recipients, and no winner', () => {
    const { lines } = campaignApprovalNotice({
      ...base,
      variants: [
        { label: 'A', templateName: 'festive_sale', sharePercent: 70, pending: 845 },
        { label: 'B', templateName: 'festive_sale_short', sharePercent: 30, pending: 355 },
      ],
    });
    expect(lines).toContain(
      "It tests 2 templates side by side: A “festive_sale” (70% of the audience) to 845 contacts; B “festive_sale_short” (30% of the audience) to 355 contacts. Approving it approves both; its page shows each variant's template and counts, and picks no winner.",
    );
    expect(lines[1]).toBe('It would be sent to 1,200 of the 1,300 contacts in its audience.');
  });

  it('names every template of a campaign that tests three, and approves all of them (ADR-410)', () => {
    const { lines } = campaignApprovalNotice({
      ...base,
      variants: [
        { label: 'A', templateName: 'festive_sale', sharePercent: 50, pending: 600 },
        { label: 'B', templateName: 'festive_sale_short', sharePercent: 30, pending: 360 },
        { label: 'C', templateName: 'festive_sale_emoji', sharePercent: 20, pending: 240 },
      ],
    });
    expect(lines).toContain(
      "It tests 3 templates side by side: A “festive_sale” (50% of the audience) to 600 contacts; B “festive_sale_short” (30% of the audience) to 360 contacts; C “festive_sale_emoji” (20% of the audience) to 240 contacts. Approving it approves all 3; its page shows each variant's template and counts, and picks no winner.",
    );
  });

  it('says nothing of variants for a campaign without B', () => {
    const plain = campaignApprovalNotice(base);
    expect(campaignApprovalNotice({ ...base, variants: [] })).toEqual(plain);
    // One variant alone is not a test: nothing is said of it.
    expect(
      campaignApprovalNotice({
        ...base,
        variants: [{ label: 'A', templateName: 'festive_sale', sharePercent: 100, pending: 1200 }],
      }),
    ).toEqual(plain);
    expect(plain.lines.join(' ')).not.toContain('templates side by side');
  });

  it('splits a line with long template names into lines a notice takes', () => {
    const long = 'x'.repeat(500);
    const { lines } = campaignApprovalNotice({
      ...base,
      variants: [
        { label: 'A', templateName: long, sharePercent: 50, pending: 600 },
        { label: 'B', templateName: long, sharePercent: 50, pending: 600 },
      ],
    });
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(600);
  });
});

describe("a review's audience from its variants' (ADR-405)", () => {
  it('adds up the variants’ disjoint parts, skip reasons by reason', () => {
    expect(
      sumBreakdowns([
        { total: 7, eligible: 5, skipped: { opted_out: 2 } },
        { total: 5, eligible: 2, skipped: { opted_out: 1, no_marketing_opt_in: 2 } },
      ]),
    ).toEqual({ total: 12, eligible: 7, skipped: { opted_out: 3, no_marketing_opt_in: 2 } });
    expect(sumBreakdowns([])).toEqual({ total: 0, eligible: 0, skipped: {} });
  });

  it('names a variant none of whose contacts can receive the campaign', () => {
    expect(emptyVariantProblem('B')).toBe(
      'Variant B: no contact in its share of the audience can receive the campaign now.',
    );
  });
});

describe('approving and resuming check every variant’s template (ADR-410)', () => {
  /** A transaction answering each read, in order, with the next rows given. */
  function answering(answers: unknown[][]) {
    const queue = [...answers];
    const chain = {
      from: () => chain,
      where: () => {
        const rows = queue.shift();
        if (!rows) throw new Error('an unexpected read');
        return Object.assign(Promise.resolve(rows), {
          orderBy: () => Promise.resolve(rows),
          groupBy: () => Promise.resolve(rows),
        });
      },
    };
    return { tx: { select: () => chain } as unknown as Tx, unread: () => queue.length };
  }
  const template = (id: string, status: string) => ({
    id,
    name: `t_${id}`,
    language: 'en',
    category: 'UTILITY',
    status,
    whatsappAccountId: 'waba-1',
    components: toMetaComponents(utility),
  });
  const row = (label: string, templateId: string) => ({
    label,
    templateId,
    variables: { header: [], body: [], buttons: [] },
    sharePercent: 20,
  });
  const c = { tenantId: 'tenant', id: 'campaign', templateId: 'a' };

  it('names a third variant whose template is no longer approved while it has pending recipients', async () => {
    const reads = answering([
      [row('B', 'b'), row('C', 'c')],
      [
        { variant: 'A', n: 3 },
        { variant: 'B', n: 2 },
        { variant: 'C', n: 1 },
      ],
      [template('a', 'approved')],
      [template('b', 'approved')],
      [template('c', 'paused')],
    ]);
    await expect(assertVariantTemplatesApproved(reads.tx, c, 'is no longer')).rejects.toThrow(
      'Variant C’s template is no longer approved by Meta.',
    );
    expect(reads.unread()).toBe(0);
  });

  it('skips a finished variant, and words a campaign without variants as before', async () => {
    const finished = answering([
      [row('B', 'b'), row('C', 'c')],
      [
        { variant: 'A', n: 3 },
        { variant: 'B', n: 2 },
      ],
      [template('a', 'approved')],
      [template('b', 'approved')],
    ]);
    await expect(assertVariantTemplatesApproved(finished.tx, c, 'is not')).resolves.toBeUndefined();
    expect(finished.unread()).toBe(0);
    const plain = answering([[], [template('a', 'paused')]]);
    await expect(assertVariantTemplatesApproved(plain.tx, c, 'is not')).rejects.toThrow(
      'The template is not approved by Meta.',
    );
  });
});
