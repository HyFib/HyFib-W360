import { z } from 'zod';
import { notFound } from '@w360/core';
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
import {
  checkSegmentDefinition,
  loadFieldTypes,
  segmentDefinitionSchema,
  segmentWhere,
} from '../campaigns/segments';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiSearchConditionSchema } from './contact-search';
import { assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * Reading saved segments through the public API (ADR-206). A draft's audience can be one of the
 * company's segments (ADR-186), and keys find them here, as members' Segments page lists them, with
 * `campaigns.read`, the permission members read segments with. A segment's conditions are given in
 * the words `POST /contacts/search` and drafts take, checked by segments' rules as members' segment
 * page checks them; one segment also says how many contacts match it now, counted by segments' own
 * SQL. Counts only: a key finds the contacts with `POST /contacts/search` and `contacts.read`.
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
      const [row] = await tx
        .select(segmentColumns)
        .from(segments)
        .where(
          and(
            eq(segments.tenantId, ctx.tenant.id),
            eq(segments.id, segmentId),
            isNull(segments.archivedAt),
          ),
        );
      if (!row) throw notFound('Segment');
      const fields = await loadFieldTypes(tx, ctx.tenant.id);
      const { segment, usable } = await readSegment(tx, ctx.tenant.id, row, fields);
      let count: number | null = null;
      if (usable) {
        // Dates read in the company's time zone, as members' segment page reads them.
        const [company] = await tx
          .select({ timezone: tenants.timezone })
          .from(tenants)
          .where(eq(tenants.id, ctx.tenant.id));
        if (!company) throw notFound('Company');
        const [counted] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(contacts)
          .where(segmentWhere(ctx.tenant.id, usable, company.timezone, fields));
        count = counted?.count ?? 0;
      }
      return { ...segment, count };
    },
    { accessMode: 'read only' },
  );
}
