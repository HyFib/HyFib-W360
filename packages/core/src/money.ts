/**
 * Money is represented as integer minor units (bigint) plus an ISO 4217 currency code. Floating
 * point is never used for money. Only currencies the platform is configured to settle are listed.
 */
export const SUPPORTED_CURRENCIES = {
  INR: { exponent: 2, symbol: '₹' },
  USD: { exponent: 2, symbol: '$' },
} as const;

export type CurrencyCode = keyof typeof SUPPORTED_CURRENCIES;

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return Object.hasOwn(SUPPORTED_CURRENCIES, code);
}

export interface Money {
  amountMinor: bigint;
  currency: CurrencyCode;
}

export function money(amountMinor: bigint | number, currency: CurrencyCode): Money {
  const value = typeof amountMinor === 'number' ? BigInt(amountMinor) : amountMinor;
  if (typeof amountMinor === 'number' && !Number.isSafeInteger(amountMinor)) {
    throw new RangeError('Money amounts must be safe integers in minor units');
  }
  return { amountMinor: value, currency };
}

/** Parses a decimal major-unit string ("1234.50") into minor units without floating point. */
export function parseMajorUnits(input: string, currency: CurrencyCode): bigint {
  const { exponent } = SUPPORTED_CURRENCIES[currency];
  const trimmed = input.trim();
  const match = /^(-)?(\d{1,15})(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new RangeError(`Invalid amount "${input}"`);
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > exponent)
    throw new RangeError(`Amount "${input}" has too many decimal places`);
  const minor =
    BigInt(whole ?? '0') * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  return sign ? -minor : minor;
}

/** Formats minor units as a plain decimal string ("1234.50"). */
export function formatMinorUnits(amountMinor: bigint, currency: CurrencyCode): string {
  const { exponent } = SUPPORTED_CURRENCIES[currency];
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  const base = 10n ** BigInt(exponent);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${whole.toString()}${exponent > 0 ? `.${fraction}` : ''}`;
}

/** Human display, e.g. `₹1,234.50`. Grouping uses the en-IN convention for INR. */
export function displayMoney(amountMinor: bigint, currency: CurrencyCode): string {
  const plain = formatMinorUnits(amountMinor, currency);
  const negative = plain.startsWith('-');
  const [whole = '0', fraction] = (negative ? plain.slice(1) : plain).split('.');
  const grouped =
    currency === 'INR'
      ? whole.replace(/(\d)(?=(\d\d)+\d$)/g, '$1,')
      : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = SUPPORTED_CURRENCIES[currency].symbol;
  return `${negative ? '-' : ''}${symbol}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Multiplies minor units by a rational rate expressed as a decimal string with rounding half-up.
 * Used for rate-card estimates (e.g. unit price 0.8631 per message).
 */
export function multiplyByDecimal(amountMinor: bigint, factor: string): bigint {
  if (amountMinor < 0n) return -multiplyByDecimal(-amountMinor, factor);
  const match = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(factor.trim());
  if (!match) throw new RangeError(`Invalid factor "${factor}"`);
  const [, whole, fraction = ''] = match;
  const scale = 10n ** BigInt(fraction.length);
  const numerator = amountMinor * (BigInt(whole ?? '0') * scale + BigInt(fraction || '0'));
  const q = numerator / scale;
  const r = numerator % scale;
  return r * 2n >= scale ? q + 1n : q;
}
