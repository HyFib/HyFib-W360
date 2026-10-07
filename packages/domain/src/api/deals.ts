import { z } from 'zod';
import { AppError, notFound } from '@w360/core';
import {
  and,
  asc,
  crmDeals,
  crmPipelines,
  crmStages,
  DEAL_STATUSES,
  desc,
  eq,
  exactTimestamp,
  inArray,
  isNull,
  sql,
  type DealStatus,
  type Tx,
} from '@w360/db';
import type { OutboundDeps } from '../messaging/outbound';
import { loadEntitlements } from '../plans/entitlements';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * CRM pipelines and deals through the public API (ADR-253), read with `deals.read`: the pipelines
 * with their stages and each stage's chance of winning, and the deals as the CRM board and the deal
 * page show them, with the contact, the conversation and the owner by id only. Notes, tasks and the
 * timeline are never read, nor the contact's name or number (`contacts.read` reads those). A key
 * needs the CRM in the company's plan. An erased contact's deals are read as erasure leaves them:
 * renamed, without a lost reason.
 */

const page = {
  limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
  cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
};

export const apiPipelineListQuerySchema = z.object(page).strict();

export const apiDealListQuerySchema = z
  .object({
    ...page,
    pipelineId: z.uuid().optional().describe('Only the deals of this pipeline.'),
    stageId: z.uuid().optional().describe('Only the deals in this stage.'),
    status: z.enum(DEAL_STATUSES).optional().describe('Only the deals with this status.'),
    contactId: z.uuid().optional().describe('Only the deals of this contact.'),
    ownerId: z
      .union([z.uuid(), z.literal('none')])
      .optional()
      .describe('Only the deals this member owns, or `none` for those without an owner.'),
    updatedSince: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        'Only deals changed at or after this time (created, edited, moved, closed or reopened, moved to another contact by a merge, or renamed when their contact was erased).',
      ),
  })
  .strict();

export interface ApiPipelineStage {
  id: string;
  name: string;
  /** The stage's place on the board, from the left. */
  position: number;
  archived: boolean;
  /** The chance, in whole percent, that the stage's open deals are won (ADR-242); null: not set. */
  winPercent: number | null;
}

export interface ApiPipeline {
  id: string;
  name: string;
  /** ISO 4217: the currency of every deal's value in the pipeline. */
  currency: string;
  /** The pipeline's place among the company's pipelines in the app. */
  position: number;
  archived: boolean;
  /** The stages in board order, archived ones last. */
  stages: ApiPipelineStage[];
  createdAt: string;
}

export interface ApiDeal {
  id: string;
  title: string;
  pipelineId: string;
  stageId: string;
  status: DealStatus;
  /** In the pipeline currency's minor units; null when no value was given. */
  valueMinor: number | null;
  currency: string;
  contactId: string;
  conversationId: string | null;
  /** The member who owns the deal (an id from GET /members); null when it has no owner. */
  ownerId: string | null;
  /** The day the deal is expected to close, YYYY-MM-DD. */
  expectedCloseOn: string | null;
  stageEnteredAt: string;
  lostReason: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Pipelines and deals are the CRM's: a plan without it reads none through the API. */
async function assertCrmInPlan(tx: Tx, tenantId: string): Promise<void> {
  const entitlements = await loadEntitlements(tx, tenantId);
  if (!entitlements.modules.has('crm')) {
    throw new AppError('forbidden', "Your company's plan does not include the CRM.", {
      details: { apiReason: 'not_in_plan' },
    });
  }
}

/**
 * The company's pipelines, archived ones too, oldest first on exact keyset pages, each with its
 * stages. The pipelines and their stages are read in one snapshot, so a page never shows a pipeline
 * with stages from another moment.
 */
export async function apiListPipelines(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiPipeline[]; nextCursor: string | null }> {
  assertScope(ctx, 'deals.read');
  const q = parseInput(apiPipelineListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      const rows = await tx
        .select({
          id: crmPipelines.id,
          name: crmPipelines.name,
          currency: crmPipelines.currency,
          position: crmPipelines.position,
          archivedAt: crmPipelines.archivedAt,
          createdAt: crmPipelines.createdAt,
          cursorAt: exactTimestamp(crmPipelines.createdAt),
        })
        .from(crmPipelines)
        .where(
          and(
            eq(crmPipelines.tenantId, ctx.tenant.id),
            cursor
              ? sql`(${crmPipelines.createdAt}, ${crmPipelines.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(crmPipelines.createdAt), asc(crmPipelines.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      const stages = new Map<string, ApiPipelineStage[]>();
      if (shown.length > 0) {
        const stageRows = await tx
          .select({
            id: crmStages.id,
            pipelineId: crmStages.pipelineId,
            name: crmStages.name,
            position: crmStages.position,
            archivedAt: crmStages.archivedAt,
            winPercent: crmStages.winPercent,
          })
          .from(crmStages)
          .where(
            and(
              eq(crmStages.tenantId, ctx.tenant.id),
              inArray(
                crmStages.pipelineId,
                shown.map((p) => p.id),
              ),
            ),
          )
          .orderBy(
            asc(sql`${crmStages.archivedAt} is not null`),
            asc(crmStages.position),
            asc(crmStages.createdAt),
            asc(crmStages.id),
          );
        for (const { pipelineId, archivedAt, ...stage } of stageRows) {
          const item = { ...stage, archived: archivedAt !== null };
          const list = stages.get(pipelineId);
          if (list) list.push(item);
          else stages.set(pipelineId, [item]);
        }
      }
      return {
        data: shown.map((p) => ({
          id: p.id,
          name: p.name,
          currency: p.currency,
          position: p.position,
          archived: p.archivedAt !== null,
          stages: stages.get(p.id) ?? [],
          createdAt: p.createdAt.toISOString(),
        })),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

const dealColumns = {
  id: crmDeals.id,
  title: crmDeals.title,
  pipelineId: crmDeals.pipelineId,
  stageId: crmDeals.stageId,
  status: crmDeals.status,
  valueMinor: crmDeals.valueMinor,
  currency: crmPipelines.currency,
  contactId: crmDeals.contactId,
  conversationId: crmDeals.conversationId,
  ownerId: crmDeals.ownerMembershipId,
  expectedCloseOn: crmDeals.expectedCloseOn,
  stageEnteredAt: crmDeals.stageEnteredAt,
  lostReason: crmDeals.lostReason,
  closedAt: crmDeals.closedAt,
  createdAt: crmDeals.createdAt,
  updatedAt: crmDeals.updatedAt,
  cursorAt: exactTimestamp(crmDeals.createdAt),
};

interface DealRow {
  id: string;
  title: string;
  pipelineId: string;
  stageId: string;
  status: DealStatus;
  valueMinor: number | null;
  currency: string;
  contactId: string;
  conversationId: string | null;
  ownerId: string | null;
  expectedCloseOn: string | null;
  stageEnteredAt: Date;
  lostReason: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const toApiDeal = (row: DealRow): ApiDeal => ({
  id: row.id,
  title: row.title,
  pipelineId: row.pipelineId,
  stageId: row.stageId,
  status: row.status,
  valueMinor: row.valueMinor,
  currency: row.currency,
  contactId: row.contactId,
  conversationId: row.conversationId,
  ownerId: row.ownerId,
  expectedCloseOn: row.expectedCloseOn,
  stageEnteredAt: row.stageEnteredAt.toISOString(),
  lostReason: row.lostReason,
  closedAt: row.closedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** A deal's pipeline, which gives its currency (a deal's pipeline is the company's). */
const pipelineOfDeal = and(
  eq(crmPipelines.tenantId, crmDeals.tenantId),
  eq(crmPipelines.id, crmDeals.pipelineId),
);

/**
 * The company's deals, newest first by when they were created, on exact keyset pages: a page never
 * skips or repeats a deal. Filters combine. Only reads, so it records nothing.
 */
export async function apiListDeals(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiDeal[]; nextCursor: string | null }> {
  assertScope(ctx, 'deals.read');
  const q = parseInput(apiDealListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      const rows = await tx
        .select(dealColumns)
        .from(crmDeals)
        .innerJoin(crmPipelines, pipelineOfDeal)
        .where(
          and(
            eq(crmDeals.tenantId, ctx.tenant.id),
            q.pipelineId ? eq(crmDeals.pipelineId, q.pipelineId) : undefined,
            q.stageId ? eq(crmDeals.stageId, q.stageId) : undefined,
            q.status ? eq(crmDeals.status, q.status) : undefined,
            q.contactId ? eq(crmDeals.contactId, q.contactId) : undefined,
            q.ownerId === 'none'
              ? isNull(crmDeals.ownerMembershipId)
              : q.ownerId
                ? eq(crmDeals.ownerMembershipId, q.ownerId)
                : undefined,
            q.updatedSince
              ? sql`${crmDeals.updatedAt} >= ${q.updatedSince}::timestamptz`
              : undefined,
            cursor
              ? sql`(${crmDeals.createdAt}, ${crmDeals.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(crmDeals.createdAt), desc(crmDeals.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map(toApiDeal),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** One of the company's deals. */
export async function apiGetDeal(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  dealId: string,
): Promise<ApiDeal> {
  assertScope(ctx, 'deals.read');
  if (!z.uuid().safeParse(dealId).success) throw notFound('Deal');
  const row = await deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      const [found] = await tx
        .select(dealColumns)
        .from(crmDeals)
        .innerJoin(crmPipelines, pipelineOfDeal)
        .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, dealId)));
      return found ?? null;
    },
    { accessMode: 'read only' },
  );
  if (!row) throw notFound('Deal');
  return toApiDeal(row);
}
