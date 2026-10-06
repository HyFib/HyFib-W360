import { MAX_TAGS_PER_CONTACT } from './fields';

/**
 * Adding or removing one tag on every contact the contacts page's filters match (ADR-213), in one
 * transaction holding those contacts' locks. The member confirms the count they saw: a change of
 * the matches meanwhile refuses the edit rather than tagging contacts nobody reviewed.
 */

/** The most contacts one edit may match; more must be narrowed by the filters first. */
export const BULK_TAG_LIMIT = 10_000;

export interface BulkTagResult {
  action: 'add' | 'remove';
  tag: string;
  /** Contacts the filters matched. */
  matched: number;
  /** Contacts the tag was added to or removed from. */
  changed: number;
  /** Contacts that already had the tag (adding) or did not have it (removing). */
  unchanged: number;
  /** Contacts left without the tag because they already have the most a contact can have. */
  atLimit: number;
}

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** What a bulk tag edit did, for the member who made it. */
export function bulkTagSummary(result: BulkTagResult): string {
  if (result.action === 'remove') {
    return [
      `Removed “${result.tag}” from ${count(result.changed, 'contact', 'contacts')}.`,
      ...(result.unchanged
        ? [`${count(result.unchanged, 'contact', 'contacts')} did not have it.`]
        : []),
    ].join(' ');
  }
  return [
    `Added “${result.tag}” to ${count(result.changed, 'contact', 'contacts')}.`,
    ...(result.unchanged
      ? [`${count(result.unchanged, 'contact', 'contacts')} already had it.`]
      : []),
    ...(result.atLimit
      ? [
          `${count(result.atLimit, 'contact', 'contacts')} already ${result.atLimit === 1 ? 'has' : 'have'} ${MAX_TAGS_PER_CONTACT} tags, the most a contact can have, so ${result.atLimit === 1 ? 'it was' : 'they were'} left as ${result.atLimit === 1 ? 'it was' : 'they were'}.`,
        ]
      : []),
  ].join(' ');
}
