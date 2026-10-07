import type { AttributeValue } from './fields';

/**
 * Setting one custom field to one value, or clearing it, on every contact the contacts page's
 * filters match (ADR-238), with the locks, the limit and the count check of bulk tag edits
 * (ADR-213). The value is checked against the field's type as one contact's edit checks it.
 */

export interface BulkFieldResult {
  key: string;
  label: string;
  /** The value set, as stored; null when the field was cleared. */
  value: AttributeValue | null;
  /** Contacts the filters matched. */
  matched: number;
  /** Contacts whose value was set or cleared. */
  changed: number;
  /** Contacts that already had the value (setting) or had no value (clearing). */
  unchanged: number;
}

/** The longest value a summary repeats; a longer one is cut short with an ellipsis. */
const SHOWN_VALUE_LENGTH = 60;

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

function shownValue(value: AttributeValue): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  // Characters, not UTF-16 units, so an emoji is never cut in half.
  const chars = Array.from(String(value));
  return chars.length > SHOWN_VALUE_LENGTH
    ? `${chars.slice(0, SHOWN_VALUE_LENGTH).join('')}…`
    : chars.join('');
}

/** What a bulk field edit did, for the member who made it. */
export function bulkFieldSummary(result: BulkFieldResult): string {
  if (result.value === null) {
    return [
      `Cleared “${result.label}” on ${count(result.changed, 'contact', 'contacts')}.`,
      ...(result.unchanged
        ? [`${count(result.unchanged, 'contact', 'contacts')} had no value.`]
        : []),
    ].join(' ');
  }
  return [
    `Set “${result.label}” to “${shownValue(result.value)}” on ${count(result.changed, 'contact', 'contacts')}.`,
    ...(result.unchanged
      ? [`${count(result.unchanged, 'contact', 'contacts')} already had this value.`]
      : []),
  ].join(' ');
}
