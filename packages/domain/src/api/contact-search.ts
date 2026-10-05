import { z } from 'zod';
import { AppError, notFound } from '@w360/core';
import {
  CONTACT_SOURCES,
  and,
  campaigns,
  eq,
  inArray,
  sql,
  tenants,
  type ContactFieldType,
  type SQL,
  type Tx,
} from '@w360/db';
import {
  CAMPAIGN_OUTCOMES,
  FIELD_COMPARISONS,
  LAST_MESSAGE_COMPARISONS,
  LAST_MESSAGE_DAYS,
  NAME_COMPARISONS,
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
 * those of segments (P3-04); the two that read conversations and campaigns also need the scope that
 * reads them (ADR-126). They are checked by segments' rules and turned into SQL by segments' own
 * function, so a key and a segment with the same conditions find the same contacts. Pages are those
 * of `GET /contacts` (ADR-113). A search can also hold groups of conditions, which segments do not
 * (ADR-164).
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
      type: z.literal('name'),
      op: z
        .enum(NAME_COMPARISONS)
        .describe(
          'The contact’s name, as a text field’s value: is_set, is_not_set, equals, not_equals, contains. A name of spaces only counts as none.',
        ),
      value: z
        .string()
        .max(200)
        .optional()
        .describe(
          'The name to compare with, for equals, not_equals and contains (is_set and is_not_set take none): compared whatever its case; contains looks for it as written, never as a pattern. not_equals also finds contacts without a name.',
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
  z
    .object({
      type: z.literal('last_message'),
      op: z
        .enum(LAST_MESSAGE_COMPARISONS)
        .describe(
          'within_days: contacts who wrote in the last `days` days; not_within_days: the others, contacts who never wrote included. Needs conversations.read too.',
        ),
      days: z.number().int().min(LAST_MESSAGE_DAYS.min).max(LAST_MESSAGE_DAYS.max),
    })
    .strict(),
  z
    .object({
      type: z.literal('campaign'),
      campaignId: z.uuid().describe('One of the company’s campaigns (GET /campaigns).'),
      outcome: z
        .enum(CAMPAIGN_OUTCOMES)
        .describe(
          'What happened to the campaign’s message to the contact, among the recipients it was sent to: delivered (or read), not_delivered (failed or not delivered yet), read, replied (a reply was counted for it: the last campaign message the contact was sent in the 72 hours before replying), or not_replied (delivered, without a reply). Needs campaigns.read too.',
        ),
    })
    .strict(),
]);

/**
 * Conditions a contact matches together, all of them or any, as one condition of the search
 * (ADR-164). A group holds conditions, not groups.
 */
const apiSearchGroupSchema = z
  .object({
    type: z.literal('group'),
    match: z
      .enum(['all', 'any'])
      .describe('all: a contact matches every condition of the group; any: at least one of them.'),
    conditions: z.array(apiSearchConditionSchema).min(1).max(SEGMENT_LIMITS.conditions),
  })
  .strict();

const apiSearchItemSchema = z.discriminatedUnion('type', [
  ...apiSearchConditionSchema.options,
  apiSearchGroupSchema,
]);

/** The conditions of a search, those in groups included. */
const conditionCount = (items: readonly ApiSearchItem[]) =>
  items.reduce((n, item) => n + (item.type === 'group' ? item.conditions.length : 1), 0);

/**
 * A search: 1 to 20 conditions or groups of them, at most 20 conditions in all, which a contact
 * matches all of or any of, and the page to read.
 */
export const apiContactSearchSchema = z
  .object({
    match: z
      .enum(['all', 'any'])
      .default('all')
      .describe('all: a contact matches every condition; any: at least one of them.'),
    conditions: z
      .array(apiSearchItemSchema)
      .min(1)
      .max(SEGMENT_LIMITS.conditions)
      .refine(
        (items) => conditionCount(items) <= SEGMENT_LIMITS.conditions,
        `At most ${SEGMENT_LIMITS.conditions} conditions in all, those in groups included.`,
      )
      .describe(
        `Conditions, or groups of conditions a contact matches together (all of them or any): at most ${SEGMENT_LIMITS.conditions} conditions in all, those in groups included. A group holds conditions, not groups.`,
      ),
    limit: z.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
  })
  .strict();

type ApiSearchCondition = z.infer<typeof apiSearchConditionSchema>;
type ApiSearchItem = z.infer<typeof apiSearchItemSchema>;

/** A condition of the search with its place, like `conditions.2.conditions.1`. */
interface PlacedCondition {
  condition: ApiSearchCondition;
  place: string;
}

/** Every condition of the search, those in groups included, with its place. */
function placedConditions(items: readonly ApiSearchItem[]): PlacedCondition[] {
  return items.flatMap((item, i) =>
    item.type === 'group'
      ? item.conditions.map((condition, j) => ({
          condition,
          place: `conditions.${i}.conditions.${j}`,
        }))
      : [{ condition: item, place: `conditions.${i}` }],
  );
}

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
 * A condition of the search as a segment condition, checked against the company's fields with
 * segments' rules. A problem is refused naming the condition's part, like `conditions.1.key`.
 */
function segmentCondition(
  c: ApiSearchCondition,
  place: string,
  fields: ReadonlyMap<string, ContactFieldType>,
): SegmentCondition {
  const at = (part: string) => `${place}.${part}`;
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
    case 'name': {
      const value = c.value?.trim();
      if (value !== undefined && !comparisonTakesValue(c.op)) {
        throw invalid(at('value'), `${c.op} takes no value.`);
      }
      if (comparisonTakesValue(c.op) && !value) {
        throw invalid(at('value'), `${c.op} needs a name to compare with.`);
      }
      return { type: 'name', op: c.op, value };
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
}

/**
 * The search as SQL over app.contacts: each condition turned into SQL by segments' own function, a
 * group as a segment with its own `match`, all joined by the search's `match` (ADR-164).
 */
export function contactSearchSql(
  match: 'all' | 'any',
  items: readonly ({ match: 'all' | 'any'; conditions: SegmentCondition[] } | SegmentCondition)[],
  timezone: string,
  fields: ReadonlyMap<string, ContactFieldType>,
): SQL {
  const parts = items.map((item) =>
    'conditions' in item
      ? segmentConditionsSql(item, timezone, fields)
      : segmentConditionsSql({ match: 'all', conditions: [item] }, timezone, fields),
  );
  return sql`(${sql.join(parts, match === 'all' ? sql` and ` : sql` or `)})`;
}

/**
 * Refuses a campaign condition naming a campaign the company does not have, as segments do, naming
 * the condition's `campaignId`; another company's campaign reads as one that does not exist.
 */
async function assertCampaignsExist(
  tx: Tx,
  tenantId: string,
  conditions: readonly PlacedCondition[],
): Promise<void> {
  const named = conditions.flatMap(({ condition: c }) =>
    c.type === 'campaign' ? [c.campaignId] : [],
  );
  if (named.length === 0) return;
  const found = new Set(
    (
      await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.tenantId, tenantId), inArray(campaigns.id, named)))
    ).map((r) => r.id),
  );
  for (const { condition: c, place } of conditions) {
    if (c.type === 'campaign' && !found.has(c.campaignId)) {
      throw invalid(
        `${place}.campaignId`,
        'The company has no campaign with this id (GET /campaigns).',
      );
    }
  }
}

/**
 * The company's contacts matching the conditions, newest first, on the pages `GET /contacts` reads
 * (ADR-113): each reads at most API_CONTACT_SEARCH_WINDOW contacts, and both of its reads see one
 * snapshot. A `last_message` condition also needs `conversations.read`, and a `campaign` condition
 * `campaigns.read` (ADR-126). It only reads, so it needs no Idempotency-Key and records nothing.
 */
export async function apiSearchContacts(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  input: unknown,
): Promise<{ data: ApiContact[]; nextCursor: string | null }> {
  assertScope(ctx, 'contacts.read');
  const q = parseInput(apiContactSearchSchema, input);
  const placed = placedConditions(q.conditions);
  if (placed.some(({ condition }) => condition.type === 'last_message')) {
    assertScope(ctx, 'conversations.read');
  }
  if (placed.some(({ condition }) => condition.type === 'campaign')) {
    assertScope(ctx, 'campaigns.read');
  }
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const fields = await loadFieldTypes(tx, ctx.tenant.id);
      const items = q.conditions.map((item, i) =>
        item.type === 'group'
          ? {
              match: item.match,
              conditions: item.conditions.map((c, j) =>
                segmentCondition(c, `conditions.${i}.conditions.${j}`, fields),
              ),
            }
          : segmentCondition(item, `conditions.${i}`, fields),
      );
      await assertCampaignsExist(tx, ctx.tenant.id, placed);
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
        filters: [contactSearchSql(q.match, items, company.timezone, fields)],
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
