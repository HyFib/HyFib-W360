/**
 * Deal amounts: integers in the minor unit of an ISO 4217 currency (paise, cents, fils...). Pure
 * functions without server dependencies, so the CRM pages can use them in the browser. The number
 * of decimals comes from the ISO 4217 data in the JavaScript runtime (ICU), never from floats.
 */

/** Largest amount a deal can hold, in minor units (matches the database check). */
export const MAX_DEAL_MINOR = 1_000_000_000_000_000;

/** Whether `code` is an ISO 4217 currency this runtime knows. */
export function isCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && Intl.supportedValuesOf('currency').includes(code);
}

/** Decimal places of the currency's minor unit (2 for INR and USD, 0 for JPY, 3 for BHD). */
export function currencyDigits(currency: string): number {
  return (
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * Parses an amount typed in major units ("2500", "2,500.50") into minor units, exactly. Returns
 * null when the text is not a non-negative amount with at most the currency's decimals.
 */
export function parseAmountToMinor(text: string, currency: string): number | null {
  const cleaned = text.trim().replace(/[,\s]/g, '');
  const digits = currencyDigits(currency);
  const m = /^(\d{1,16})(?:\.(\d+))?$/.exec(cleaned);
  if (!m) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > digits) return null;
  const minor =
    BigInt(m[1] as string) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0');
  if (minor > BigInt(MAX_DEAL_MINOR)) return null;
  return Number(minor);
}

/** The amount in major units as plain text for form fields ("2500.50"), without grouping. */
export function minorToInput(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  if (digits === 0) return String(minor);
  const text = String(minor).padStart(digits + 1, '0');
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** Formats minor units for display, e.g. "₹2,500.50". */
export function formatMinor(minor: number, currency: string, locale = 'en-IN'): string {
  const digits = currencyDigits(currency);
  // Doubles hold these amounts (below 2^53 minor units) closely enough to round to the minor unit.
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(minorToInput(minor, currency)));
}
