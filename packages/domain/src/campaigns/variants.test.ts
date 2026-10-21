import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sendSpecFor, toMetaComponents, type TemplateDefinition } from '../templates/definition';
import { combineEstimates, estimateFromTable, type RateTable } from './costs';
import { campaignApprovalNotice, emptyVariantProblem, sumBreakdowns } from './service';
import {
  VARIANT_SHARES,
  assignVariant,
  variantBucket,
  variantInputSchema,
  variantOfBucket,
  variantSendable,
  variantShareSchema,
  variantTemplateProblems,
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
      const first = assignVariant(campaignId, contactId, 30);
      expect(assignVariant(campaignId, contactId, 30)).toBe(first);
      // Upper-case ids (as some callers write them) hash as PostgreSQL writes uuids.
      expect(assignVariant(campaignId.toUpperCase(), contactId.toUpperCase(), 30)).toBe(first);
    }
    // The bucket is the first 32 bits of MD5("campaign:contact") modulo 100.
    const contactId = contacts[0]!;
    const digest = createHash('md5').update(`${campaignId}:${contactId}`).digest('hex');
    expect(variantBucket(campaignId, contactId)).toBe(parseInt(digest.slice(0, 8), 16) % 100);
    // Another campaign splits the same contacts differently.
    const other = idFrom('campaign-2');
    const differ = contacts
      .slice(0, 1000)
      .filter((c) => assignVariant(campaignId, c, 50) !== assignVariant(other, c, 50));
    expect(differ.length).toBeGreaterThan(400);
  });

  it('gives B the first share of buckets and A the rest; without B everyone is A', () => {
    expect(variantOfBucket(0, 10)).toBe('B');
    expect(variantOfBucket(9, 10)).toBe('B');
    expect(variantOfBucket(10, 10)).toBe('A');
    expect(variantOfBucket(89, 90)).toBe('B');
    expect(variantOfBucket(90, 90)).toBe('A');
    expect(variantOfBucket(0, null)).toBe('A');
    expect(contacts.every((c) => assignVariant(campaignId, c, null) === 'A')).toBe(true);
  });

  it('splits 10,000 contacts close to each share', () => {
    const deviations: number[] = [];
    for (const share of VARIANT_SHARES) {
      const b = contacts.filter((c) => assignVariant(campaignId, c, share) === 'B').length;
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
      if (assignVariant(campaignId, c, 20) === 'B')
        expect(assignVariant(campaignId, c, 50)).toBe('B');
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
