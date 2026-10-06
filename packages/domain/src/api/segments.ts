import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  contacts,
  desc,
  eq,
  exactTimestamp,
  isNull,
  segments,
  sql,
  tenants,
  type ContactFieldType,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import {
  SEGMENT_LIMITS,
  checkSegmentDefinition,
  loadFieldTypes,
  segmentDefinitionSchema,
  segmentNameRefusal,
  segmentWhere,
} from '../campaigns/segments';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiSearchConditionSchema, apiSegmentConditions } from './contact-search';
import { apiActor, assertScope, type ApiContext } from './context';
import type { ApiResponse, IdempotencyInput } from './idempotency';
import { API_LIMITS } from './model';
import { idempotent } from './resources';

/**
 * Reading saved segments through the public API (ADR-206). A draft's audience can be one of the
 * company's segments (ADR-186), and keys find them here, as members' Segments page lists them, with
 * `campaigns.read`, the permission members read segments with. A segment's conditions are given in
 * the words `POST /contacts/search` and drafts take, checked by segments' rules as members' segment
 * page checks them; one segment also says how many contacts match it now, counted by segments' own
 * SQL. Counts only: a key finds the contacts with `POST /contacts/search` and `contacts.read`.
 * Keys with `campaigns.write` also create, change and archive segments as members do (ADR-207).
 */

export const apiSegmentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
  })
  .strict();

const apiSegmentDefinitionSchema = z.object({
  match: z
    .enum(['all', 'any'])
    .describe('all: a contact matches every condition; any: at least one of them.'),
  conditions: z
    .array(apiSearchConditionSchema)
    .describe("Its conditions, in the words POST /contacts/search and drafts' audiences take."),
});

export const apiSegmentSchema = z.object({
  id: z.uuid().describe("The segment's id, which a draft's audience takes as `segmentId`."),
  name: z.string(),
  definition: apiSegmentDefinitionSchema
    .nullable()
    .describe('Its conditions; null when they can no longer be read, which `problem` then says.'),
  problem: z
    .string()
    .nullable()
    .describe(
      "Why it cannot be used now, as members' segment page says: a condition on a custom field that no longer exists or no longer takes its comparison, a tag or a date that is not valid, a campaign that does not exist, or conditions that can no longer be read. A draft with this audience cannot be submitted until a member fixes the segment. Null when there is none.",
    ),
  version: z.number().int().describe('Raised by every change members make to it.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ApiSegment = z.infer<typeof apiSegmentSchema>;

export const apiSegmentDetailSchema = apiSegmentSchema.extend({
  count: z
    .number()
    .int()
    .nullable()
    .describe(
      "How many contacts match it now, erased contacts left out, as members' segment page counts them; null when it has a problem.",
    ),
});
export type ApiSegmentDetail = z.infer<typeof apiSegmentDetailSchema>;

const segmentColumns = {
  id: segments.id,
  name: segments.name,
  definition: segments.definition,
  version: segments.version,
  createdAt: segments.createdAt,
  updatedAt: segments.updatedAt,
  cursorAt: exactTimestamp(segments.createdAt),
};

type SegmentRow = {
  id: string;
  name: string;
  definition: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

const UNREADABLE = 'This segment’s conditions can no longer be read.';

/** A stored segment in the API's words, checked as members' segment page checks it. */
async function readSegment(
  tx: Tx,
  tenantId: string,
  row: SegmentRow,
  fields: ReadonlyMap<string, ContactFieldType>,
) {
  const def = segmentDefinitionSchema.safeParse(row.definition);
  const problem = def.success
    ? await checkSegmentDefinition(tx, tenantId, def.data, fields)
    : UNREADABLE;
  const segment: ApiSegment = {
    id: row.id,
    name: row.name,
    definition: def.success ? (def.data as unknown as NonNullable<ApiSegment['definition']>) : null,
    problem,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return { segment, usable: def.success && !problem ? def.data : null };
}

/** The company's segments that are not archived, newest first, on keyset pages (ADR-206). */
export async function apiListSegments(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiSegment[]; nextCursor: string | null }> {
  assertScope(ctx, 'campaigns.read');
  const q = parseInput(apiSegmentListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select(segmentColumns)
        .from(segments)
        .where(
          and(
            eq(segments.tenantId, ctx.tenant.id),
            isNull(segments.archivedAt),
            cursor
              ? sql`(${segments.createdAt}, ${segments.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(segments.createdAt), desc(segments.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const fields = await loadFieldTypes(tx, ctx.tenant.id);
      const data: ApiSegment[] = [];
      for (const row of shown)
        data.push((await readSegment(tx, ctx.tenant.id, row, fields)).segment);
      const last = shown.at(-1);
      return {
        data,
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** One segment of the company that is not archived, counted now; null when there is none. */
async function readApiSegmentDetail(
  tx: Tx,
  tenantId: string,
  segmentId: string,
): Promise<ApiSegmentDetail | null> {
  const [row] = await tx
    .select(segmentColumns)
    .from(segments)
    .where(
      and(eq(segments.tenantId, tenantId), eq(segments.id, segmentId), isNull(segments.archivedAt)),
    );
  if (!row) return null;
  const fields = await loadFieldTypes(tx, tenantId);
  const { segment, usable } = await readSegment(tx, tenantId, row, fields);
  let count: number | null = null;
  if (usable) {
    // Dates read in the company's time zone, as members' segment page reads them.
    const [company] = await tx
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!company) throw notFound('Company');
    const [counted] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(segmentWhere(tenantId, usable, company.timezone, fields));
    count = counted?.count ?? 0;
  }
  return { ...segment, count };
}

/**
 * One of the company's segments that is not archived (ADR-206), with how many contacts match it
 * now, counted in the snapshot its row is read in; archived segments and other companies' are not
 * found.
 */
export async function apiGetSegment(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  segmentId: string,
): Promise<ApiSegmentDetail> {
  assertScope(ctx, 'campaigns.read');
  if (!z.uuid().safeParse(segmentId).success) throw notFound('Segment');
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const segment = await readApiSegmentDetail(tx, ctx.tenant.id, segmentId);
      if (!segment) throw notFound('Segment');
      return segment;
    },
    { accessMode: 'read only' },
  );
}

// Writing segments (ADR-207) ------------------------------------------------------------------

const apiSegmentNameField = z
  .string()
  .trim()
  .min(1, 'Name the segment')
  .max(80, 'Keep the name to 80 characters')
  .describe(
    'Shown to members on the Segments page; no other segment of the company that is not archived has it, whatever its case.',
  );

const apiSegmentDefinitionInputSchema = z
  .object({
    match: z
      .enum(['all', 'any'])
      .default('all')
      .describe('all: a contact matches every condition; any: at least one of them.'),
    conditions: z
      .array(apiSearchConditionSchema)
      .min(1, 'Add at least one condition')
      .max(SEGMENT_LIMITS.conditions)
      .describe(
        `1 to ${SEGMENT_LIMITS.conditions} conditions, in the words POST /contacts/search takes them, without groups.`,
      ),
  })
  .strict();

export const apiCreateSegmentSchema = z
  .object({
    name: apiSegmentNameField,
    definition: apiSegmentDefinitionInputSchema.describe('Who it holds.'),
  })
  .strict();

export const apiUpdateSegmentSchema = z
  .object({
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'The version you read (GET /segments/{id}); when given, a segment changed since is refused with 409.',
      ),
    name: apiSegmentNameField.optional(),
    definition: apiSegmentDefinitionInputSchema
      .optional()
      .describe('Who it holds now: these conditions replace its conditions.'),
  })
  .strict()
  .refine(
    (data) => data.name !== undefined || data.definition !== undefined,
    'Give a name or conditions to change',
  );

/** The name and the conditions as a key gave them, checked as a search checks them. */
async function segmentWrite(
  tx: Tx,
  tenantId: string,
  given: { name?: string; definition?: z.infer<typeof apiSegmentDefinitionInputSchema> },
) {
  return {
    ...(given.name !== undefined ? { name: given.name } : {}),
    ...(given.definition
      ? {
          definition: {
            match: given.definition.match,
            conditions: await apiSegmentConditions(
              tx,
              tenantId,
              given.definition.conditions,
              'definition.conditions',
            ),
          },
        }
      : {}),
  };
}

/**
 * Creates one of the company's segments (ADR-207), as members create them on the Segments page,
 * with `campaigns.write`, the permission members create segments with: its conditions are checked
 * as a search's are, naming the condition a problem is in, and a name another segment has is
 * refused with 409. One segment per `Idempotency-Key`: a retry answers with the segment as first
 * created. The audit names the key.
 */
export async function apiCreateSegment(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'campaigns.write');
  const given = parseInput(apiCreateSegmentSchema, input);
  try {
    return await deps.db.run(ctx.scope, async (tx) => {
      const conditions = await apiSegmentConditions(
        tx,
        ctx.tenant.id,
        given.definition.conditions,
        'definition.conditions',
      );
      return idempotent(tx, ctx, idempotency, deps.clock.now(), async () => {
        const id = uuidv7();
        await tx.insert(segments).values({
          id,
          tenantId: ctx.tenant.id,
          name: given.name,
          definition: { match: given.definition.match, conditions },
          createdByUserId: null,
          updatedByUserId: null,
        });
        await recordSystemAudit(
          tx,
          ctx.tenant.id,
          {
            action: 'segment.created',
            subjectType: 'segment',
            subjectId: id,
            metadata: { conditions: conditions.length, source: 'api' },
            correlationId: ctx.requestId,
          },
          apiActor(ctx),
        );
        return { status: 201, body: { data: await readApiSegmentDetail(tx, ctx.tenant.id, id) } };
      });
    });
  } catch (error) {
    throw segmentNameRefusal(error);
  }
}

/**
 * Changes one of the company's segments that is not archived (ADR-207), as members change them:
 * the name or the conditions given, each left out kept, its version raised. When
 * `expectedVersion` is given, a segment changed since is refused with 409; so is a name another
 * segment has. A retry sets the same again. Campaigns already submitted keep the audience they
 * were submitted with; drafts with this segment take its new conditions. The audit names the key.
 */
export async function apiUpdateSegment(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  segmentId: string,
  input: unknown,
): Promise<ApiSegmentDetail> {
  assertScope(ctx, 'campaigns.write');
  if (!z.uuid().safeParse(segmentId).success) throw notFound('Segment');
  const { expectedVersion, ...given } = parseInput(apiUpdateSegmentSchema, input);
  try {
    return await deps.db.run(ctx.scope, async (tx) => {
      const [row] = await tx
        .select({ version: segments.version })
        .from(segments)
        .where(
          and(
            eq(segments.tenantId, ctx.tenant.id),
            eq(segments.id, segmentId),
            isNull(segments.archivedAt),
          ),
        )
        .for('update');
      if (!row) throw notFound('Segment');
      if (expectedVersion !== undefined && row.version !== expectedVersion) {
        throw new AppError(
          'conflict',
          `This segment has changed since you read it: its version is ${row.version}. Read it again and give the version it has.`,
        );
      }
      const write = await segmentWrite(tx, ctx.tenant.id, given);
      await tx
        .update(segments)
        .set({ ...write, version: sql`${segments.version} + 1`, updatedByUserId: null })
        .where(and(eq(segments.tenantId, ctx.tenant.id), eq(segments.id, segmentId)));
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'segment.updated',
          subjectType: 'segment',
          subjectId: segmentId,
          metadata: {
            ...(write.definition ? { conditions: write.definition.conditions.length } : {}),
            source: 'api',
          },
          correlationId: ctx.requestId,
        },
        apiActor(ctx),
      );
      const segment = await readApiSegmentDetail(tx, ctx.tenant.id, segmentId);
      if (!segment) throw notFound('Segment');
      return segment;
    });
  } catch (error) {
    throw segmentNameRefusal(error);
  }
}

/**
 * Archives one of the company's segments (ADR-207), as members archive them: it leaves the lists
 * and reads, campaigns already submitted keep their audience, and drafts with it cannot be
 * submitted until they take another audience. A segment already archived is answered as it is, so
 * a retry is harmless; another company's is not found. The audit names the key.
 */
export async function apiArchiveSegment(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  segmentId: string,
): Promise<{ id: string; archived: true }> {
  assertScope(ctx, 'campaigns.write');
  if (!z.uuid().safeParse(segmentId).success) throw notFound('Segment');
  return deps.db.run(ctx.scope, async (tx) => {
    const [row] = await tx
      .select({ archivedAt: segments.archivedAt })
      .from(segments)
      .where(and(eq(segments.tenantId, ctx.tenant.id), eq(segments.id, segmentId)))
      .for('update');
    if (!row) throw notFound('Segment');
    if (!row.archivedAt) {
      await tx
        .update(segments)
        .set({ archivedAt: deps.clock.now(), updatedByUserId: null })
        .where(and(eq(segments.tenantId, ctx.tenant.id), eq(segments.id, segmentId)));
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'segment.archived',
          subjectType: 'segment',
          subjectId: segmentId,
          metadata: { source: 'api' },
          correlationId: ctx.requestId,
        },
        apiActor(ctx),
      );
    }
    return { id: segmentId, archived: true as const };
  });
}
