import { describe, expect, it } from 'vitest';
import { GraphClient } from './graph';
import {
  BUSINESS_USE_CASE_USAGE_HEADER,
  MAX_REGAIN_ACCESS_MINUTES,
  MAX_USAGE_BUSINESS_IDS,
  MAX_USAGE_HEADER_CHARS,
  highestUsagePercent,
  parseBusinessUseCaseUsage,
} from './usage-header';

/**
 * Meta's `x-business-use-case-usage` header (research M-027, M-200, ADR-399): read leniently and
 * within bounds, keeping only each WABA's `whatsapp_business_management` entry.
 */
const WABA = '102290129340398';
const OTHER = '200000000000001';

const entry = (type: string, values: Record<string, unknown> = {}) => ({
  type,
  call_count: 1,
  total_cputime: 1,
  total_time: 1,
  estimated_time_to_regain_access: 0,
  ...values,
});

const header = (value: unknown) => JSON.stringify(value);

describe('parseBusinessUseCaseUsage', () => {
  it("reads the example in Meta's OpenAPI description", () => {
    // The spec's example, verbatim (components/headers, business-messaging-api_v23.0.yaml).
    const usage = parseBusinessUseCaseUsage(
      '{"102290129340398":[{"type":"whatsapp_business_management","call_count":1,"total_cputime":1,"total_time":1,"estimated_time_to_regain_access":0},{"type":"whatsapp","call_count":1,"total_cputime":1,"total_time":1,"estimated_time_to_regain_access":0}]}',
    );
    expect(usage).toEqual(
      new Map([[WABA, { callCount: 1, totalCputime: 1, totalTime: 1, regainAccessMinutes: 0 }]]),
    );
  });

  it('gives nothing for an absent, empty, oversized or malformed header', () => {
    expect(parseBusinessUseCaseUsage(null)).toBeNull();
    expect(parseBusinessUseCaseUsage(undefined)).toBeNull();
    expect(parseBusinessUseCaseUsage('')).toBeNull();
    expect(parseBusinessUseCaseUsage('{"102290129340398":[{"type":')).toBeNull();
    expect(parseBusinessUseCaseUsage('not json')).toBeNull();
    expect(parseBusinessUseCaseUsage('null')).toBeNull();
    expect(parseBusinessUseCaseUsage('42')).toBeNull();
    expect(parseBusinessUseCaseUsage('"text"')).toBeNull();
    expect(parseBusinessUseCaseUsage(header([entry('whatsapp_business_management')]))).toBeNull();
    const padded = header({ [WABA]: [entry('whatsapp_business_management')] }).padEnd(
      MAX_USAGE_HEADER_CHARS + 1,
      ' ',
    );
    expect(parseBusinessUseCaseUsage(padded)).toBeNull();
    // Exactly at the bound it is read (JSON allows the trailing spaces).
    expect(parseBusinessUseCaseUsage(padded.slice(0, MAX_USAGE_HEADER_CHARS))?.get(WABA)).toEqual({
      callCount: 1,
      totalCputime: 1,
      totalTime: 1,
      regainAccessMinutes: 0,
    });
  });

  it('reads several business ids, each on its own', () => {
    const usage = parseBusinessUseCaseUsage(
      header({
        [WABA]: [entry('whatsapp_business_management', { call_count: 40 })],
        [OTHER]: [
          entry('whatsapp', { call_count: 99 }),
          entry('whatsapp_business_management', {
            total_time: 97,
            estimated_time_to_regain_access: 5,
          }),
        ],
      }),
    );
    expect(usage?.get(WABA)).toEqual({
      callCount: 40,
      totalCputime: 1,
      totalTime: 1,
      regainAccessMinutes: 0,
    });
    expect(usage?.get(OTHER)).toEqual({
      callCount: 1,
      totalCputime: 1,
      totalTime: 97,
      regainAccessMinutes: 5,
    });
  });

  it('ignores ids without a management entry, other types and entries of the wrong shape', () => {
    expect(parseBusinessUseCaseUsage(header({ [WABA]: [entry('whatsapp')] }))).toBeNull();
    expect(
      parseBusinessUseCaseUsage(
        header({
          [WABA]: [
            null,
            7,
            'whatsapp_business_management',
            [entry('whatsapp_business_management')],
            { type: 'WHATSAPP_BUSINESS_MANAGEMENT', call_count: 50 },
            { type: 'whatsapp_business_management' },
            { type: 'whatsapp_business_management', call_count: 'many', total_time: -3 },
          ],
          'not-an-id': [entry('whatsapp_business_management')],
          '': [entry('whatsapp_business_management')],
          ['__proto__']: [entry('whatsapp_business_management')],
          [OTHER]: { type: 'whatsapp_business_management', call_count: 10 },
        }),
      ),
    ).toBeNull();
  });

  it('keeps the readable counters of an entry and takes the rest as zero', () => {
    const usage = parseBusinessUseCaseUsage(
      header({
        [WABA]: [
          {
            type: 'whatsapp_business_management',
            call_count: 30,
            total_cputime: null,
            total_time: 'NaN',
          },
        ],
      }),
    );
    expect(usage?.get(WABA)).toEqual({
      callCount: 30,
      totalCputime: 0,
      totalTime: 0,
      regainAccessMinutes: 0,
    });
  });

  it('reads numbers written as text, and refuses text that is not a plain number', () => {
    const usage = parseBusinessUseCaseUsage(
      header({
        [WABA]: [
          entry('whatsapp_business_management', {
            call_count: '42',
            total_cputime: '7.2',
            total_time: '1e3',
            estimated_time_to_regain_access: ' 5',
          }),
        ],
      }),
    );
    // 7.2 rounds up; '1e3' and ' 5' are not plain numbers and count as zero.
    expect(usage?.get(WABA)).toEqual({
      callCount: 42,
      totalCputime: 8,
      totalTime: 0,
      regainAccessMinutes: 0,
    });
  });

  it('caps huge values and ignores negative and non-finite ones', () => {
    const usage = parseBusinessUseCaseUsage(
      `{"${WABA}":[{"type":"whatsapp_business_management","call_count":1e308,"total_cputime":-5,"total_time":1e999,"estimated_time_to_regain_access":99999999}]}`,
    );
    // 1e999 parses as Infinity: not finite, so not usage.
    expect(usage?.get(WABA)).toEqual({
      callCount: 100,
      totalCputime: 0,
      totalTime: 0,
      regainAccessMinutes: MAX_REGAIN_ACCESS_MINUTES,
    });
    const fractions = parseBusinessUseCaseUsage(
      header({
        [WABA]: [
          entry('whatsapp_business_management', {
            call_count: 0.1,
            estimated_time_to_regain_access: 0.5,
          }),
        ],
      }),
    );
    // A fraction of a minute still pauses: rounded up, never down to "not throttled".
    expect(fractions?.get(WABA)?.callCount).toBe(1);
    expect(fractions?.get(WABA)?.regainAccessMinutes).toBe(1);
  });

  it('takes the higher of each value when an id has two management entries', () => {
    const usage = parseBusinessUseCaseUsage(
      header({
        [WABA]: [
          entry('whatsapp_business_management', { call_count: 80, total_time: 5 }),
          entry('whatsapp_business_management', {
            call_count: 10,
            total_time: 60,
            estimated_time_to_regain_access: 3,
          }),
        ],
      }),
    );
    expect(usage?.get(WABA)).toEqual({
      callCount: 80,
      totalCputime: 1,
      totalTime: 60,
      regainAccessMinutes: 3,
    });
  });

  it('reads at most the bounded number of ids', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < MAX_USAGE_BUSINESS_IDS + 5; i += 1) {
      many[String(300000000000000 + i)] = [entry('whatsapp_business_management')];
    }
    expect(parseBusinessUseCaseUsage(header(many))?.size).toBe(MAX_USAGE_BUSINESS_IDS);
  });

  it('gives the highest percentage of a reading', () => {
    expect(
      highestUsagePercent({
        callCount: 10,
        totalCputime: 91,
        totalTime: 40,
        regainAccessMinutes: 0,
      }),
    ).toBe(91);
    expect(
      highestUsagePercent({
        callCount: 10,
        totalCputime: 9,
        totalTime: 40,
        regainAccessMinutes: 0,
      }),
    ).toBe(40);
  });
});

describe('the Graph client and the usage header', () => {
  const usageValue = header({
    [WABA]: [entry('whatsapp_business_management', { call_count: 95 })],
  });
  const client = (respond: () => Response) =>
    new GraphClient({
      baseUrl: 'https://graph.test',
      version: 'v26.0',
      fetchImpl: async () => respond(),
    });
  const withHeader = (body: unknown, status: number, value: string | null) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        ...(value !== null ? { [BUSINESS_USE_CASE_USAGE_HEADER]: value } : {}),
      },
    });
  const reading = { callCount: 95, totalCputime: 1, totalTime: 1, regainAccessMinutes: 0 };

  it('gives the usage with a success', async () => {
    const result = await client(() =>
      withHeader({ data: [{ id: '1' }] }, 200, usageValue),
    ).listPhoneNumbers(WABA, 'token');
    expect(result).toEqual({ ok: true, data: { ids: ['1'] }, usage: new Map([[WABA, reading]]) });
  });

  it('gives the usage with a failure, classified as without it', async () => {
    const body = { error: { code: 80007, message: 'rate limit', type: 'OAuthException' } };
    const plain = await client(() => withHeader(body, 400, null)).listPhoneNumbers(WABA, 'token');
    const withUsage = await client(() => withHeader(body, 400, usageValue)).listPhoneNumbers(
      WABA,
      'token',
    );
    expect(plain).not.toHaveProperty('usage');
    expect(withUsage).toEqual({ ...plain, usage: new Map([[WABA, reading]]) });
    expect(withUsage.ok === false && withUsage.kind).toBe('retryable');
  });

  it('gives the usage with an answer it cannot read', async () => {
    const result = await client(
      () =>
        new Response('<html>', {
          status: 200,
          headers: { [BUSINESS_USE_CASE_USAGE_HEADER]: usageValue },
        }),
    ).listPhoneNumbers(WABA, 'token');
    expect(result).toMatchObject({ ok: false, kind: 'unknown', title: 'unreadable_response' });
    expect(result.usage?.get(WABA)).toEqual(reading);
  });

  it('answers as before when the header is malformed or names no management entry', async () => {
    for (const value of ['{oops', header({ [WABA]: [entry('whatsapp')] }), 'x'.repeat(20_000)]) {
      const result = await client(() =>
        withHeader({ data: [{ id: '1' }] }, 200, value),
      ).listPhoneNumbers(WABA, 'token');
      expect(result).toEqual({ ok: true, data: { ids: ['1'] } });
    }
  });

  it('ignores a well-formed reading longer than the bound (a fake fetch: Node refuses such headers)', async () => {
    const valid = usageValue;
    // Padded inside the JSON: a header value's outer spaces are trimmed.
    const padded = (length: number) => `{${' '.repeat(length - valid.length)}${valid.slice(1)}`;
    const long = padded(MAX_USAGE_HEADER_CHARS + 1);
    const atBound = padded(MAX_USAGE_HEADER_CHARS);
    const over = await client(() =>
      withHeader({ data: [{ id: '1' }] }, 200, long),
    ).listPhoneNumbers(WABA, 'token');
    expect(over).toEqual({ ok: true, data: { ids: ['1'] } });
    const within = await client(() =>
      withHeader({ data: [{ id: '1' }] }, 200, atBound),
    ).listPhoneNumbers(WABA, 'token');
    expect(within.usage?.get(WABA)).toEqual(reading);
  });
});
