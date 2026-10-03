import { z } from 'zod';
import { AppError, notFound } from '@w360/core';
import { CONTACT_SOURCES, eq, tenants, type ContactFieldType } from '@w360/db';
import {
  FIELD_COMPARISONS,
  SEGMENT_LIMITS,
  comparisonTakesValue,
  fieldComparisonsFor,
  fieldConditionProblem,
  loadFieldTypes,
  segmentConditionsSql,
  type FieldComparison,
  type FieldConditionProblem,
  type SegmentCondition,
} from '../campaigns/segments';
import { normalizeTag, validDate } from '../contacts/fields';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, parseInput } from '../validation';
import type { ApiContact } from './contact-view';
import { apiContactPage } from './contacts';
import { assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * Finding contacts with segments' conditions through the public API (ADR-117). The conditions are
 * those of segments (P3-04) less the two that read conversations or campaigns; they are checked by
 * segments' rules and turned into SQL by segments' own function, so a key and a segment with the
 * same conditions find the same contacts. Pages are those of `GET /contacts` (ADR-113).
 */

const apiSearchConditionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('field'),
      key: z.string().max(40).describe('A custom field’s key (GET /contact-fields).'),
      op: z
        .enum(FIELD_COMPARISONS)
        .describe(
          'For text: is_set, is_not_set, equals, not_equals, contains. For a number: is_set, is_not_set, equals, not_equals, greater_than, less_than. For a date: is_set, is_not_set, equals, before, after. For yes/no: is_set, is_not_set, is_true, is_false.',
        ),
      value: z
        .union([z.string().max(200), z.number()])
        .optional()
        .describe(
          'What to compare with, for every comparison but is_set, is_not_set, is_true and is_false, which take none: text, compared whatever its case (contains looks for it as written, never as a pattern); a number, or a string of one, for a number field; a date as YYYY-MM-DD for a date field. not_equals also finds contacts without a value.',
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal('tag'),
      op: z.enum(['has', 'not_has']),
      tag: z.string().max(40).describe('A tag (tags are lower-cased).'),
    })
    .strict(),
  z
    .object({
      type: z.literal('consent'),
      purpose: z.enum(['marketing', 'utility']),
      status: z
        .enum(['opted_in', 'opted_out', 'not_recorded'])
        .describe('The contact’s consent for the purpose; not_recorded when there is none.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('created'),
      op: z.enum(['before', 'after']),
      date: z
        .string()
        .max(10)
        .describe(
          'A day as YYYY-MM-DD in the company’s time zone: before finds contacts added before it began, after those added after it ended.',
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal('source'),
      source: z.enum(CONTACT_SOURCES).describe('Where the contact came from.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('calling_code'),
      prefix: z
        .string()
        .regex(/^[1-9][0-9]{0,3}$/, 'Give a country calling code: 1 to 4 digits, without +.')
        .describe('A country calling code without +, like 91: contacts whose number has it.'),
    })
    .strict(),
]);

/** A search: 1 to 20 conditions, which a contact matches all of or any of, and the page to read. */
export const apiContactSearchSchema = z
  .object({
    match: z
      .enum(['all', 'any'])
      .default('all')
      .describe('all: a contact matches every condition; any: at least one of them.'),
    conditions: z.array(apiSearchConditionSchema).min(1).max(SEGMENT_LIMITS.conditions),
    limit: z.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
  })
  .strict();

type ApiSearchCondition = z.infer<typeof apiSearchConditionSchema>;

const invalid = (path: string, message: string) =>
  new AppError('validation_failed', message, { issues: [{ path, message }] });

const FIELD_PROBLEMS: Record<
  FieldConditionProblem,
  { part: 'op' | 'value'; message: (op: FieldComparison, type: ContactFieldType) => string }
> = {
  comparison: {
    part: 'op',
    message: (op, type) =>
      `${op} does not apply to ${type} fields: use ${fieldComparisonsFor(type).join(', ')}.`,
  },
  value_missing: { part: 'value', message: (op) => `${op} needs a value to compare with.` },
  not_number: {
    part: 'value',
    message: () => 'Give a number with at most 15 digits before the point and 6 after.',
  },
  not_date: { part: 'value', message: () => 'Give a date written as YYYY-MM-DD.' },
};

/**
 * The search's conditions as segment conditions, checked against the company's fields with
 * segments' rules. A problem is refused naming the condition's part, like `conditions.1.key`.
 */
function segmentConditions(
  raw: readonly ApiSearchCondition[],
  fields: ReadonlyMap<string, ContactFieldType>,
): SegmentCondition[] {
  return raw.map((c, i): SegmentCondition => {
    const at = (part: string) => `conditions.${i}.${part}`;
    switch (c.type) {
      case 'field': {
        const type = fields.get(c.key);
        if (!type) {
          throw invalid(
            at('key'),
            `The company has no custom field with the key ${c.key} (GET /contact-fields).`,
          );
        }
        if (typeof c.value === 'number' && type !== 'number') {
          throw invalid(at('value'), `${c.key} is a ${type} field: give the value as a string.`);
        }
        const value = c.value === undefined ? undefined : String(c.value).trim();
        if (value !== undefined && !comparisonTakesValue(c.op)) {
          throw invalid(at('value'), `${c.op} takes no value.`);
        }
        const problem = fieldConditionProblem(type, c.op, value);
        if (problem) {
          const { part, message } = FIELD_PROBLEMS[problem];
          throw invalid(at(part), message(c.op, type));
        }
        return { type: 'field', key: c.key, op: c.op, value };
      }
      case 'tag': {
        const tag = normalizeTag(c.tag);
        if (!tag.ok) throw invalid(at('tag'), tag.message);
        return { type: 'tag', op: c.op, tag: tag.tag };
      }
      case 'created':
        if (!validDate(c.date)) throw invalid(at('date'), 'Give a date written as YYYY-MM-DD.');
        return c;
      default:
        return c;
    }
  });
}

/**
 * The company's contacts matching the conditions, newest first, on the pages `GET /contacts` reads
 * (ADR-113): each reads at most API_CONTACT_SEARCH_WINDOW contacts, and both of its reads see one
 * snapshot. It only reads, so it needs no Idempotency-Key and records nothing.
 */
export async function apiSearchContacts(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  input: unknown,
): Promise<{ data: ApiContact[]; nextCursor: string | null }> {
  assertScope(ctx, 'contacts.read');
  const q = parseInput(apiContactSearchSchema, input);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const fields = await loadFieldTypes(tx, ctx.tenant.id);
      const conditions = segmentConditions(q.conditions, fields);
      // `created` days are the company's, as in segments.
      const [company] = await tx
        .select({ timezone: tenants.timezone })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenant.id));
      if (!company) throw notFound('Company');
      return apiContactPage(tx, ctx.tenant.id, {
        cursor,
        limit: q.limit,
        narrow: [],
        filters: [segmentConditionsSql({ match: q.match, conditions }, company.timezone, fields)],
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
