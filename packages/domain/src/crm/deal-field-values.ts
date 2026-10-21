import type { DealFieldType } from '@w360/db';
import { coerceFieldValue, fieldOptionKey, type AttributeValue } from '../contacts/fields';

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

/** Options compare ignoring case, as CSV import matches them (as contact fields' do, ADR-407). */
export const dealFieldOptionKey = fieldOptionKey;

/**
 * Converts a value typed in a form or a CSV cell to the field's type, as contact fields are (the
 * same function since ADR-407); an empty value removes it (`value: null`). A choice takes one of its
 * options whatever the case, and is stored as the option is written.
 */
export function coerceDealFieldValue(
  field: DealFieldShape,
  raw: string,
): { ok: true; value: AttributeValue | null } | { ok: false; message: string } {
  return coerceFieldValue(field, raw);
}
