import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { parseRateCardCsv } from './rate-cards';

// Test values only; they are not Meta prices.
const CSV = [
  'market,calling_codes,marketing,utility,authentication,authentication_international,service',
  'Testland,91,0.5,0.1,0.1,,0',
  '"Rest of Test Region",880; 94 977,1.25,,,,',
].join('\n');

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isAppError(error)) return error.publicMessage;
    throw error;
  }
  throw new Error('expected a validation error');
}

describe('parseRateCardCsv', () => {
  it('reads markets, calling codes and prices in micros (empty cells mean no price)', () => {
    expect(parseRateCardCsv(CSV)).toEqual({
      markets: [
        {
          market: 'Testland',
          prefixes: ['91'],
          prices: { marketing: 500_000, utility: 100_000, authentication: 100_000, service: 0 },
        },
        {
          market: 'Rest of Test Region',
          prefixes: ['880', '94', '977'],
          prices: { marketing: 1_250_000 },
        },
      ],
    });
  });

  it('refuses duplicate markets or calling codes, bad prices and rows without prices', () => {
    const header = 'market,calling_codes,marketing';
    expect(message(() => parseRateCardCsv(`${header}\nA,91,1\nA,92,1`))).toMatch(/appears twice/);
    expect(message(() => parseRateCardCsv(`${header}\nA,91,1\nB,91,1`))).toMatch(
      /already used by A/,
    );
    expect(message(() => parseRateCardCsv(`${header}\nA,091,1`))).toMatch(/not a calling code/);
    expect(message(() => parseRateCardCsv(`${header}\nA,91,abc`))).toMatch(/not a number/);
    expect(message(() => parseRateCardCsv(`${header}\nA,91,`))).toMatch(/no price/);
    expect(message(() => parseRateCardCsv('name,codes\nA,91'))).toMatch(/market,calling_codes/);
    expect(message(() => parseRateCardCsv('market,calling_codes\nA,91'))).toMatch(/price column/);
  });
});
