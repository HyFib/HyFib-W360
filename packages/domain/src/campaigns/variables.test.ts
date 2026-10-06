import { describe, expect, it } from 'vitest';
import { TEMPLATE_LIMITS } from '../templates/definition';
import {
  campaignVariablesSchema,
  checkVariables,
  fieldsWithoutFallback,
  resolveVariables,
} from './variables';
import {
  formatMicros,
  formatUnitPrice,
  marketFor,
  microsToMinor,
  parseAmountToMicros,
  priceFor,
  type RateTable,
} from './costs';

describe('campaign variables', () => {
  const variables = campaignVariablesSchema.parse({
    header: [{ source: 'static', value: 'Diwali offer' }],
    body: [
      { source: 'name', fallback: 'there' },
      { source: 'field', key: 'city', fallback: 'your city' },
      { source: 'field', key: 'points' },
    ],
  });

  it('fills values from the contact, with fallbacks', () => {
    expect(
      resolveVariables(variables, {
        displayName: '  Asha\nRao ',
        attributes: { city: 'Pune', points: 120 },
      }),
    ).toEqual({
      ok: true,
      params: { header: ['Diwali offer'], body: ['Asha Rao', 'Pune', '120'], buttons: [] },
    });
    expect(
      resolveVariables(variables, { displayName: null, attributes: { points: true } }),
    ).toEqual({
      ok: true,
      params: { header: ['Diwali offer'], body: ['there', 'your city', 'Yes'], buttons: [] },
    });
  });

  it('clips a value to the parameter limit without splitting an emoji (ADR-133)', () => {
    // Meta would get half of the emoji where the limit falls between its two halves.
    const city = `${'x'.repeat(TEMPLATE_LIMITS.parameterValue - 1)}😀 and more`;
    expect(
      resolveVariables(variables, { displayName: 'Asha', attributes: { city, points: 1 } }),
    ).toEqual({
      ok: true,
      params: {
        header: ['Diwali offer'],
        body: ['Asha', 'x'.repeat(TEMPLATE_LIMITS.parameterValue - 1), '1'],
        buttons: [],
      },
    });
    expect(
      resolveVariables(
        { header: [{ source: 'field', key: 'city' }], body: [], buttons: [] },
        { displayName: null, attributes: { city } },
      ),
    ).toEqual({
      ok: true,
      params: { header: ['x'.repeat(TEMPLATE_LIMITS.parameterValue - 1)], body: [], buttons: [] },
    });
  });

  it('reports a variable without a value and without a fallback', () => {
    expect(resolveVariables(variables, { displayName: 'Asha', attributes: {} })).toEqual({
      ok: false,
      missing: 'body.3',
    });
    expect(fieldsWithoutFallback(variables)).toEqual(['points']);
  });

  it('checks a mapping against the template and the company fields', () => {
    const spec = { headerParams: 1, bodyParams: 3 };
    expect(checkVariables(variables, spec, new Set(['city', 'points']))).toBeNull();
    expect(
      checkVariables(variables, { headerParams: 0, bodyParams: 3 }, new Set(['city', 'points'])),
    ).toMatch(/every template variable/);
    expect(checkVariables(variables, spec, new Set(['city']))).toMatch(/no longer exists/);
  });

  it('fills the ends of links, using the fallback for a value a link cannot end with (ADR-229)', () => {
    const links = [
      { index: 1, text: 'Track', url: 'https://shop.example/track/{{1}}' },
      { index: 2, text: 'Rate', url: 'https://shop.example/rate?o={{1}}' },
    ];
    const linked = campaignVariablesSchema.parse({
      body: [{ source: 'name', fallback: 'there' }],
      buttons: [
        { source: 'field', key: 'order_no', fallback: 'latest' },
        { source: 'static', value: 'wa-campaign' },
      ],
    });
    const contact = (orderNo: unknown) => ({
      displayName: 'Asha Rao',
      attributes: orderNo === undefined ? {} : { order_no: orderNo },
    });
    expect(resolveVariables(linked, contact('A-1001'), links)).toEqual({
      ok: true,
      params: { header: [], body: ['Asha Rao'], buttons: ['A-1001', 'wa-campaign'] },
    });
    expect(resolveVariables(linked, contact(4217), links)).toMatchObject({
      params: { buttons: ['4217', 'wa-campaign'] },
    });
    // A value with spaces, too long, or none: the fallback.
    for (const value of ['A 1001', 'x'.repeat(TEMPLATE_LIMITS.parameterValue + 1), undefined, '']) {
      expect(
        resolveVariables(linked, contact(value), links),
        String(value).slice(0, 20),
      ).toMatchObject({
        params: { buttons: ['latest', 'wa-campaign'] },
      });
    }
    // Without a usable fallback the recipient is missing the variable; so without the links.
    const strict = campaignVariablesSchema.parse({
      buttons: [{ source: 'name', fallback: 'no name' }],
    });
    expect(resolveVariables(strict, contact('x'), links.slice(0, 1))).toEqual({
      ok: false,
      missing: 'buttons.1',
    });
    expect(resolveVariables(linked, contact('A-1001'))).toEqual({
      ok: false,
      missing: 'buttons.1',
    });
    expect(
      fieldsWithoutFallback(
        campaignVariablesSchema.parse({ buttons: [{ source: 'field', key: 'order_no' }] }),
      ),
    ).toEqual(['order_no']);
  });

  it('checks the ends of links: one source each, fixed values and fallbacks a link can end with', () => {
    const links = [{ index: 0, text: 'Track', url: 'https://shop.example/track/{{1}}' }];
    const spec = { headerParams: 0, bodyParams: 0, links };
    const check = (buttons: unknown[]) =>
      checkVariables(campaignVariablesSchema.parse({ buttons }), spec, new Set(['order_no']));
    expect(check([{ source: 'field', key: 'order_no' }])).toBeNull();
    expect(check([{ source: 'field', key: 'order_no', fallback: 'latest' }])).toBeNull();
    expect(check([{ source: 'static', value: 'A-1' }])).toBeNull();
    expect(check([])).toMatch(/every template variable/);
    expect(check([{ source: 'field', key: 'gone' }])).toMatch(/no longer exists/);
    expect(check([{ source: 'static', value: 'A 1' }])).toBe(
      'Track: The end of a link cannot contain spaces.',
    );
    expect(check([{ source: 'field', key: 'order_no', fallback: 'a b' }])).toBe(
      'Track (fallback): The end of a link cannot contain spaces.',
    );
    expect(check([{ source: 'name', fallback: 'friend of ours' }])).toMatch(/^Track \(fallback\)/);
    expect(
      checkVariables(
        campaignVariablesSchema.parse({ buttons: [{ source: 'static', value: 'A-1' }] }),
        { headerParams: 0, bodyParams: 0 },
        new Set(),
      ),
    ).toMatch(/every template variable/);
    expect(
      campaignVariablesSchema.safeParse({
        buttons: [1, 2, 3].map((n) => ({ source: 'static', value: String(n) })),
      }).success,
    ).toBe(false);
  });

  it('rejects malformed mappings', () => {
    expect(
      campaignVariablesSchema.safeParse({ body: [{ source: 'field', key: 'Bad Key' }] }).success,
    ).toBe(false);
    expect(
      campaignVariablesSchema.safeParse({ body: [{ source: 'name', fallback: '' }] }).success,
    ).toBe(false);
  });
});

describe('cost estimates', () => {
  const table: RateTable = {
    cardId: 'card',
    currency: 'INR',
    effectiveFrom: new Date('2026-10-01T00:00:00Z'),
    prefixes: [
      { prefix: '1876', market: 'Jamaica' },
      { prefix: '91', market: 'India' },
      { prefix: '1', market: 'North America' },
    ],
    prices: new Map([
      ['India|marketing', 861_000],
      ['India|utility', 125_000],
      ['North America|marketing', 2_100_000],
    ]),
  };

  it('uses the longest matching calling-code prefix', () => {
    expect(marketFor(table, '+919876543210')).toBe('India');
    expect(marketFor(table, '+18765550100')).toBe('Jamaica');
    expect(marketFor(table, '+12025550100')).toBe('North America');
    expect(marketFor(table, '+447700900123')).toBeNull();
    expect(marketFor(table, null)).toBeNull();
    expect(priceFor(table, 'India', 'marketing')).toBe(861_000);
    expect(priceFor(table, 'Jamaica', 'marketing')).toBeNull();
    expect(priceFor(table, null, 'marketing')).toBeNull();
  });

  it('does exact amount arithmetic in micros', () => {
    expect(parseAmountToMicros('2500')).toBe(2_500_000_000);
    expect(parseAmountToMicros('0.861')).toBe(861_000);
    expect(parseAmountToMicros('12.1234567')).toBeNull();
    expect(parseAmountToMicros('-5')).toBeNull();
    expect(parseAmountToMicros('0')).toBeNull();
    // 0.861 INR rounds half up to 86 paise; 0.865 to 87.
    expect(microsToMinor(861_000, 'INR')).toBe(86);
    expect(microsToMinor(865_000, 'INR')).toBe(87);
    // Currencies without minor units round to whole units.
    expect(microsToMinor(1_500_000, 'JPY')).toBe(2);
    expect(formatMicros(2_583_000, 'INR')).toBe('₹2.58');
    expect(formatUnitPrice(861_000, 'INR')).toBe('0.861 INR');
    expect(formatUnitPrice(1_000_000, 'USD')).toBe('1.00 USD');
    // A currency without minor units shows a whole price without a trailing point.
    expect(formatUnitPrice(2_000_000, 'JPY')).toBe('2 JPY');
    expect(formatUnitPrice(2_500_000, 'JPY')).toBe('2.5 JPY');
  });
});
