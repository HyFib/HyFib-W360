import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  CONTACT_SOURCES,
  and,
  asc,
  campaigns,
  contactFields,
  contacts,
  eq,
  isNull,
  segments,
  sql,
  type ContactFieldType,
  type Database,
  type SQL,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { NUMBER_RE, normalizeTag, validDate } from '../contacts/fields';
import { likePattern, parseInput } from '../validation';

/**
 * Saved dynamic segments: a list of conditions over contacts, combined with "all" or "any",
 * evaluated whenever the segment is used (a campaign freezes the result in its snapshot).
 * Conditions compile to parameterised SQL; field keys, tags and values are never spliced into the
 * query text. Erased contacts never match.
 */
export const SEGMENT_LIMITS = { conditions: 20, previewSample: 10 } as const;

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** How a field condition compares; which comparisons apply depends on the field's type. */
export const FIELD_COMPARISONS = [
  'is_set',
  'is_not_set',
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
  'before',
  'after',
  'is_true',
  'is_false',
] as const;
export type FieldComparison = (typeof FIELD_COMPARISONS)[number];

/**
 * How a `name` condition compares the contact's name (ADR-143): as a text field's value is, with a
 * name of spaces only read as none.
 */
export const NAME_COMPARISONS = [
  'is_set',
  'is_not_set',
  'equals',
  'not_equals',
  'contains',
] as const;

/** Whether a contact wrote within the last days (the `last_message` condition), and how far back. */
export const LAST_MESSAGE_COMPARISONS = ['within_days', 'not_within_days'] as const;
export const LAST_MESSAGE_DAYS = { min: 1, max: 365 } as const;
/** What happened to a campaign's message to a contact (the `campaign` condition). */
export const CAMPAIGN_OUTCOMES = [
  'delivered',
  'not_delivered',
  'read',
  'replied',
  'not_replied',
] as const;

const conditionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tag'),
    op: z.enum(['has', 'not_has']),
    tag: z.string().trim().min(1, 'Enter a tag').max(40),
  }),
  z.object({
    type: z.literal('consent'),
    purpose: z.enum(['marketing', 'utility']),
    status: z.enum(['opted_in', 'opted_out', 'not_recorded']),
  }),
  z.object({
    type: z.literal('field'),
    key: z.string().regex(FIELD_KEY_RE, 'Choose a field'),
    op: z.enum(FIELD_COMPARISONS),
    value: z.string().trim().max(200).optional(),
  }),
  z.object({
    type: z.literal('name'),
    op: z.enum(NAME_COMPARISONS),
    value: z.string().trim().max(200).optional(),
  }),
  z.object({
    type: z.literal('created'),
    op: z.enum(['before', 'after']),
    date: z.string().regex(DATE_RE, 'Use a date written as YYYY-MM-DD'),
  }),
  z.object({ type: z.literal('source'), source: z.enum(CONTACT_SOURCES) }),
  z.object({
    type: z.literal('last_message'),
    op: z.enum(LAST_MESSAGE_COMPARISONS),
    days: z.coerce.number().int().min(LAST_MESSAGE_DAYS.min).max(LAST_MESSAGE_DAYS.max),
  }),
  z.object({
    type: z.literal('calling_code'),
    prefix: z.string().regex(/^[1-9][0-9]{0,3}$/, 'Enter a country calling code, digits only'),
  }),
  z.object({
    type: z.literal('campaign'),
    campaignId: z.uuid(),
    outcome: z.enum(CAMPAIGN_OUTCOMES),
  }),
]);
export type SegmentCondition = z.infer<typeof conditionSchema>;

export const segmentDefinitionSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z
    .array(conditionSchema)
    .min(1, 'Add at least one condition')
    .max(SEGMENT_LIMITS.conditions),
});
export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;

const FIELD_OPS: Record<ContactFieldType, ReadonlySet<FieldComparison>> = {
  text: new Set(['is_set', 'is_not_set', 'equals', 'not_equals', 'contains']),
  number: new Set(['is_set', 'is_not_set', 'equals', 'not_equals', 'greater_than', 'less_than']),
  date: new Set(['is_set', 'is_not_set', 'equals', 'before', 'after']),
  boolean: new Set(['is_set', 'is_not_set', 'is_true', 'is_false']),
};
const VALUE_OPS: ReadonlySet<FieldComparison> = new Set([
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
  'before',
  'after',
]);

/** The comparisons that apply to a type of field, in the order segments offer them. */
export const fieldComparisonsFor = (type: ContactFieldType): FieldComparison[] =>
  FIELD_COMPARISONS.filter((op) => FIELD_OPS[type].has(op));

/** Whether a comparison compares with a value (`equals`, `before` …) rather than none (`is_set`). */
export const comparisonTakesValue = (op: FieldComparison): boolean => VALUE_OPS.has(op);

export type FieldConditionProblem = 'comparison' | 'value_missing' | 'not_number' | 'not_date';

/**
 * What keeps a field condition from applying to a field of this type, or null: a comparison of
 * another type, no value where the comparison needs one, or a value that is not a number (as
 * members type numbers) or not a real date. Segments and contact searches through the API
 * (ADR-117) check conditions with these rules, each in its own words.
 */
export function fieldConditionProblem(
  type: ContactFieldType,
  op: FieldComparison,
  value: string | undefined,
): FieldConditionProblem | null {
  if (!FIELD_OPS[type].has(op)) return 'comparison';
  if (!VALUE_OPS.has(op)) return null;
  const v = value ?? '';
  if (!v) return 'value_missing';
  if (type === 'number' && !NUMBER_RE.test(v)) return 'not_number';
  if (type === 'date' && !validDate(v)) return 'not_date';
  return null;
}

const FIELD_PROBLEM_MESSAGES: Record<FieldConditionProblem, (type: ContactFieldType) => string> = {
  comparison: (type) => `That comparison does not apply to ${type} fields.`,
  value_missing: () => 'Enter a value to compare with.',
  not_number: () => 'Enter a number.',
  not_date: () => 'Enter a date written as YYYY-MM-DD.',
};

/**
 * Checks a parsed definition against the company's fields and campaigns. Returns the first problem
 * as a member-facing message, or null.
 */
export async function checkSegmentDefinition(
  tx: Tx,
  tenantId: string,
  def: SegmentDefinition,
  fields: ReadonlyMap<string, ContactFieldType>,
): Promise<string | null> {
  for (const c of def.conditions) {
    if (c.type === 'tag' && !normalizeTag(c.tag).ok) return `“${c.tag}” is not a valid tag.`;
    if (c.type === 'field') {
      const type = fields.get(c.key);
      if (!type) return 'A condition uses a custom field that does not exist.';
      const problem = fieldConditionProblem(type, c.op, c.value);
      if (problem) return FIELD_PROBLEM_MESSAGES[problem](type);
    }
    if (c.type === 'name' && comparisonTakesValue(c.op) && !c.value) {
      return 'Enter a name to compare with.';
    }
    // The schema checks the form only; 30 February would fail in the query.
    if (c.type === 'created' && !validDate(c.date)) return 'Enter a date written as YYYY-MM-DD.';
    if (c.type === 'campaign') {
      const [row] = await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, c.campaignId)));
      if (!row) return 'A condition refers to a campaign that does not exist.';
    }
  }
  return null;
}

function fieldSql(c: Extract<SegmentCondition, { type: 'field' }>, type: ContactFieldType): SQL {
  const json = sql`(${contacts.attributes} -> ${c.key})`;
  const text = sql`(${contacts.attributes} ->> ${c.key})`;
  const num = sql`(case when jsonb_typeof(${json}) = 'number' then ${text}::numeric end)`;
  const v = c.value ?? '';
  switch (c.op) {
    case 'is_set':
      return sql`${json} is not null`;
    case 'is_not_set':
      return sql`${json} is null`;
    case 'is_true':
      return sql`${json} = 'true'::jsonb`;
    case 'is_false':
      return sql`${json} = 'false'::jsonb`;
    case 'contains':
      return sql`${text} ilike ${likePattern(v)}`;
    case 'greater_than':
      return sql`${num} > ${v}::numeric`;
    case 'less_than':
      return sql`${num} < ${v}::numeric`;
    case 'before':
      return sql`${text} < ${v}`;
    case 'after':
      return sql`${text} > ${v}`;
    case 'equals':
      if (type === 'number') return sql`${num} = ${v}::numeric`;
      if (type === 'date') return sql`${text} = ${v}`;
      return sql`lower(${text}) = lower(${v})`;
    case 'not_equals':
      if (type === 'number') return sql`${num} is distinct from ${v}::numeric`;
      return sql`${json} is null or lower(${text}) <> lower(${v})`;
  }
}

function nameSql(c: Extract<SegmentCondition, { type: 'name' }>): SQL {
  // WhatsApp profile names are kept as sent, so a name of spaces only reads as none.
  const name = sql`nullif(btrim(${contacts.displayName}), '')`;
  const v = c.value ?? '';
  switch (c.op) {
    case 'is_set':
      return sql`${name} is not null`;
    case 'is_not_set':
      return sql`${name} is null`;
    case 'equals':
      return sql`lower(${name}) = lower(${v})`;
    case 'not_equals':
      return sql`${name} is null or lower(${name}) <> lower(${v})`;
    case 'contains':
      return sql`${contacts.displayName} ilike ${likePattern(v)}`;
  }
}

function conditionSql(
  c: SegmentCondition,
  timezone: string,
  fields: ReadonlyMap<string, ContactFieldType>,
): SQL {
  switch (c.type) {
    case 'tag': {
      const tag = normalizeTag(c.tag);
      const exists = sql`exists (select 1 from app.contact_tags t where t.tenant_id = ${contacts.tenantId}
        and t.contact_id = ${contacts.id} and t.tag = ${tag.ok ? tag.tag : c.tag})`;
      return c.op === 'has' ? exists : sql`not ${exists}`;
    }
    case 'consent': {
      const status = sql`(select cc.status from app.contact_consents cc where cc.tenant_id = ${contacts.tenantId}
        and cc.contact_id = ${contacts.id} and cc.purpose = ${c.purpose})`;
      return c.status === 'not_recorded' ? sql`${status} is null` : sql`${status} = ${c.status}`;
    }
    case 'field': {
      const type = fields.get(c.key);
      // Unknown fields are refused by checkSegmentDefinition; match nothing if one slips through.
      return type ? fieldSql(c, type) : sql`false`;
    }
    case 'name':
      return nameSql(c);
    case 'created': {
      // A date in the company's time zone: "before 2026-10-01" means before its local midnight.
      const midnight = sql`((${c.date}::date)::timestamp at time zone ${timezone})`;
      return c.op === 'before'
        ? sql`${contacts.createdAt} < ${midnight}`
        : sql`${contacts.createdAt} >= ${midnight} + interval '1 day'`;
    }
    case 'source':
      return sql`${contacts.source} = ${c.source}`;
    case 'last_message': {
      const exists = sql`exists (select 1 from app.conversations cv where cv.tenant_id = ${contacts.tenantId}
        and cv.contact_id = ${contacts.id}
        and cv.last_inbound_at > now() - make_interval(days => ${c.days}))`;
      return c.op === 'within_days' ? exists : sql`not ${exists}`;
    }
    case 'calling_code':
      return sql`${contacts.phoneE164} like ${`+${c.prefix}%`}`;
    case 'campaign': {
      const outcome = {
        delivered: sql`m.status in ('delivered', 'read', 'played')`,
        not_delivered: sql`(m.status is null or m.status not in ('delivered', 'read', 'played'))`,
        read: sql`m.status in ('read', 'played')`,
        replied: sql`r.replied_at is not null`,
        not_replied: sql`m.status in ('delivered', 'read', 'played') and r.replied_at is null`,
      }[c.outcome];
      return sql`exists (select 1 from app.campaign_recipients r
        left join app.messages m on m.tenant_id = r.tenant_id and m.id = r.message_id
        where r.tenant_id = ${contacts.tenantId} and r.campaign_id = ${c.campaignId}
          and r.contact_id = ${contacts.id} and r.state = 'queued' and ${outcome})`;
    }
  }
}

/**
 * A checked definition's conditions as one condition over app.contacts, all or any of them, without
 * the company or erasure (contact searches through the API add those, ADR-117).
 */
export function segmentConditionsSql(
  def: SegmentDefinition,
  timezone: string,
  fields: ReadonlyMap<string, ContactFieldType>,
): SQL {
  const parts = def.conditions.map((c) => sql`(${conditionSql(c, timezone, fields)})`);
  return sql`(${sql.join(parts, def.match === 'all' ? sql` and ` : sql` or `)})`;
}

/** WHERE conditions (over app.contacts) for a checked definition, erased contacts excluded. */
export function segmentWhere(
  tenantId: string,
  def: SegmentDefinition,
  timezone: string,
  fields: ReadonlyMap<string, ContactFieldType>,
): SQL {
  return sql`${contacts.tenantId} = ${tenantId} and ${contacts.erasedAt} is null and ${segmentConditionsSql(def, timezone, fields)}`;
}

export async function loadFieldTypes(
  tx: Tx,
  tenantId: string,
): Promise<Map<string, ContactFieldType>> {
  const rows = await tx
    .select({ key: contactFields.key, type: contactFields.type })
    .from(contactFields)
    .where(eq(contactFields.tenantId, tenantId));
  return new Map(rows.map((r) => [r.key, r.type]));
}

/** Parses a stored or submitted definition and checks it; throws a validation error otherwise. */
export async function parseSegmentDefinition(
  tx: Tx,
  tenantId: string,
  raw: unknown,
): Promise<SegmentDefinition> {
  const def = parseInput(segmentDefinitionSchema, raw);
  const problem = await checkSegmentDefinition(
    tx,
    tenantId,
    def,
    await loadFieldTypes(tx, tenantId),
  );
  if (problem) throw new AppError('validation_failed', problem);
  return def;
}

export const saveSegmentSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  definition: z.unknown(),
});

export const updateSegmentSchema = saveSegmentSchema.extend({
  expectedVersion: z.number().int().min(0),
});

export interface SegmentPreview {
  count: number;
  /** A few matching contacts; empty when the member may not read contacts. */
  sample: { id: string; displayName: string | null; phoneE164: string | null }[];
}

export function createSegmentsService(deps: { db: Database; clock: Clock }) {
  const { db } = deps;

  async function preview(
    tx: Tx,
    ctx: TenantContext,
    def: SegmentDefinition,
  ): Promise<SegmentPreview> {
    const where = segmentWhere(
      ctx.tenant.id,
      def,
      ctx.tenant.timezone,
      await loadFieldTypes(tx, ctx.tenant.id),
    );
    const [counted] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(where);
    const sample = can(ctx, 'contacts.read')
      ? await tx
          .select({
            id: contacts.id,
            displayName: contacts.displayName,
            phoneE164: contacts.phoneE164,
          })
          .from(contacts)
          .where(where)
          .orderBy(asc(contacts.createdAt), asc(contacts.id))
          .limit(SEGMENT_LIMITS.previewSample)
      : [];
    return { count: counted?.count ?? 0, sample };
  }

  return {
    async listSegments(ctx: TenantContext) {
      assertCan(ctx, 'campaigns.read');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: segments.id,
              name: segments.name,
              definition: segments.definition,
              version: segments.version,
              updatedAt: segments.updatedAt,
            })
            .from(segments)
            .where(and(eq(segments.tenantId, ctx.tenant.id), isNull(segments.archivedAt)))
            .orderBy(asc(segments.name)),
        { accessMode: 'read only' },
      );
    },

    async getSegment(ctx: TenantContext, segmentId: string) {
      assertCan(ctx, 'campaigns.read');
      if (!z.uuid().safeParse(segmentId).success) throw notFound('Segment');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [row] = await tx
            .select()
            .from(segments)
            .where(and(eq(segments.tenantId, ctx.tenant.id), eq(segments.id, segmentId)));
          if (!row || row.archivedAt) throw notFound('Segment');
          const def = segmentDefinitionSchema.safeParse(row.definition);
          const fields = await loadFieldTypes(tx, ctx.tenant.id);
          const problem = def.success
            ? await checkSegmentDefinition(tx, ctx.tenant.id, def.data, fields)
            : 'This segment’s conditions can no longer be read.';
          return {
            ...row,
            problem,
            preview: def.success && !problem ? await preview(tx, ctx, def.data) : null,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** Counts (and, with contact access, samples) the contacts a definition matches now. */
    async previewDefinition(ctx: TenantContext, raw: unknown): Promise<SegmentPreview> {
      assertCan(ctx, 'campaigns.read');
      return db.run(
        ctx.scope,
        async (tx) => preview(tx, ctx, await parseSegmentDefinition(tx, ctx.tenant.id, raw)),
        { accessMode: 'read only' },
      );
    },

    async createSegment(ctx: TenantContext, input: unknown, meta: RequestMeta) {
      assertCan(ctx, 'campaigns.write');
      const data = parseInput(saveSegmentSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const def = await parseSegmentDefinition(tx, ctx.tenant.id, data.definition);
        const id = uuidv7();
        await tx.insert(segments).values({
          id,
          tenantId: ctx.tenant.id,
          name: data.name,
          definition: def,
          createdByUserId: ctx.user.id,
          updatedByUserId: ctx.user.id,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'segment.created',
            subjectType: 'segment',
            subjectId: id,
            metadata: { conditions: def.conditions.length },
          },
          meta,
        );
        return { id };
      });
    },

    async updateSegment(ctx: TenantContext, segmentId: string, input: unknown, meta: RequestMeta) {
      assertCan(ctx, 'campaigns.write');
      if (!z.uuid().safeParse(segmentId).success) throw notFound('Segment');
      const data = parseInput(updateSegmentSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const def = await parseSegmentDefinition(tx, ctx.tenant.id, data.definition);
        const [row] = await tx
          .update(segments)
          .set({
            name: data.name,
            definition: def,
            version: sql`${segments.version} + 1`,
            updatedByUserId: ctx.user.id,
          })
          .where(
            and(
              eq(segments.tenantId, ctx.tenant.id),
              eq(segments.id, segmentId),
              isNull(segments.archivedAt),
              eq(segments.version, data.expectedVersion),
            ),
          )
          .returning({ id: segments.id });
        if (!row) {
          throw new AppError(
            'conflict',
            'Someone else changed this segment. Reload the page to see their version.',
          );
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'segment.updated',
            subjectType: 'segment',
            subjectId: segmentId,
            metadata: { conditions: def.conditions.length },
          },
          meta,
        );
        return { id: segmentId };
      });
    },

    /** Archived segments disappear from lists; campaigns that used them keep their snapshots. */
    async archiveSegment(ctx: TenantContext, segmentId: string, meta: RequestMeta) {
      assertCan(ctx, 'campaigns.write');
      if (!z.uuid().safeParse(segmentId).success) throw notFound('Segment');
      await db.run(ctx.scope, async (tx) => {
        const [row] = await tx
          .update(segments)
          .set({ archivedAt: deps.clock.now(), updatedByUserId: ctx.user.id })
          .where(
            and(
              eq(segments.tenantId, ctx.tenant.id),
              eq(segments.id, segmentId),
              isNull(segments.archivedAt),
            ),
          )
          .returning({ id: segments.id });
        if (!row) throw notFound('Segment');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'segment.archived',
            subjectType: 'segment',
            subjectId: segmentId,
          },
          meta,
        );
      });
    },
  };
}

export type SegmentsService = ReturnType<typeof createSegmentsService>;
