import type { DealFieldType } from '@w360/db';
import { coerceFieldValue, type AttributeValue } from '../contacts/fields';

/**
 * Custom deal field values as members type them (ADR-373, ADR-385), with no server dependencies:
 * deal forms, CSV import and the automation builder's checks (ADR-386) read values with the same
 * code, in the browser and on the server.
 */

/** What reading a typed value needs to know about its field. */
export interface DealFieldShape {
  label: string;
  type: DealFieldType;
  /** A choice field's options, in order; null for every other type. */
  options: readonly string[] | null;
}

/** Options compare ignoring case, as CSV import matches them. */
export const dealFieldOptionKey = (option: string) => option.toLowerCase();

/**
 * Converts a value typed in a form or a CSV cell to the field's type, as contact fields are; an
 * empty value removes it (`value: null`). A choice takes one of its options whatever the case, and
 * is stored as the option is written.
 */
export function coerceDealFieldValue(
  field: DealFieldShape,
  raw: string,
): { ok: true; value: AttributeValue | null } | { ok: false; message: string } {
  if (field.type !== 'choice')
    return coerceFieldValue({ label: field.label, type: field.type }, raw);
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  const key = dealFieldOptionKey(value);
  const option = (field.options ?? []).find((candidate) => dealFieldOptionKey(candidate) === key);
  return option === undefined
    ? { ok: false, message: `${field.label} must be one of its options.` }
    : { ok: true, value: option };
}
