import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  asc,
  contacts,
  crmActivities,
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
  type CrmActivityKind,
  type CrmChanger,
  type DealFieldType,
  type DealStatus,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { addActivity, crmChangedBy, crmCreatedBy, memberRefs } from '../crm/common';
import {
  apiMergedDealAttributes,
  keptDealAttributes,
  loadDealFields,
  lockedDealFields,
  sameAttributes,
} from '../crm/deal-fields';
import { MAX_DEAL_MINOR } from '../crm/money';
import type { OutboundDeps } from '../messaging/outbound';
import { loadEntitlements } from '../plans/entitlements';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiContactNotFound } from './contact-view';
import { apiActor, assertScope, type ApiContext } from './context';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';
import { API_LIMITS } from './model';

/**
 * CRM pipelines and deals through the public API (ADR-253), read with `deals.read`: the pipelines
 * with their stages and each stage's chance of winning, and the deals as the CRM board and the deal
 * page show them, with the contact, the conversation and the owner by id only. Notes, tasks and the
 * timeline are never read, nor the contact's name or number (`contacts.read` reads those). A key
 * needs the CRM in the company's plan. An erased contact's deals are read as erasure leaves them:
 * renamed, without a lost reason. With `deals.write` a key creates deals as members do (ADR-254).
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

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Give the deal a title.')
  .max(120, 'A title is limited to 120 characters.');

const valueMinorSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_DEAL_MINOR)
  .nullable()
  .describe('The deal’s value in the pipeline currency’s minor units (paise for INR).');

const ownerIdSchema = z
  .uuid()
  .nullable()
  .describe('The member who owns the deal: an active member who can use the CRM (GET /members).');

const expectedCloseOnSchema = z.iso
  .date()
  .nullable()
  .describe('The day the deal is expected to close.');

const dealFieldValuesSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe(
    'Custom deal field values by field key (GET /deal-fields), each of its field’s type: text, a number, a date as YYYY-MM-DD, true/false, or one of a choice field’s options written exactly as listed; null removes a value. Keys left out keep their values.',
  );

/** What `POST /deals` takes: the contact, the pipeline and the deal, as members create one. */
export const apiCreateDealSchema = z
  .object({
    contactId: z.uuid().describe('The customer the deal is with, as GET /contacts gives them.'),
    pipelineId: z.uuid().describe('One of the company’s active pipelines (GET /pipelines).'),
    stageId: z
      .uuid()
      .optional()
      .describe('An active stage of the pipeline; without one, its first active stage.'),
    title: titleSchema,
    valueMinor: valueMinorSchema.optional(),
    ownerId: ownerIdSchema.optional(),
    expectedCloseOn: expectedCloseOnSchema.optional(),
    fields: dealFieldValuesSchema.optional(),
  })
  .strict();

/**
 * What `PATCH /deals/{id}` takes (ADR-255): any of the deal's details, a stage of its pipeline, and
 * a status that closes or reopens it, from the version expected when one is given.
 */
export const apiUpdateDealSchema = z
  .object({
    title: titleSchema.optional(),
    valueMinor: valueMinorSchema.optional(),
    ownerId: ownerIdSchema.optional(),
    expectedCloseOn: expectedCloseOnSchema.optional(),
    fields: dealFieldValuesSchema.optional(),
    pipelineId: z
      .uuid()
      .optional()
      .describe(
        'Moves the open deal to this active pipeline: to `stageId`, or the pipeline’s first active stage. A deal with a value moves only to a pipeline of its currency.',
      ),
    stageId: z
      .uuid()
      .optional()
      .describe('Moves the open deal to this active stage of its pipeline, or of `pipelineId`.'),
    status: z
      .enum(DEAL_STATUSES)
      .optional()
      .describe('`won` or `lost` closes the open deal; `open` reopens a closed one.'),
    lostReason: z
      .string()
      .trim()
      .max(200, 'The reason is limited to 200 characters.')
      .nullable()
      .optional()
      .describe('With `status` `lost`: why the deal was lost, as members write it.'),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Change the deal only at this `version`: a deal changed since is refused with 409 (read it again).',
      ),
  })
  .strict()
  .refine((change) => Object.keys(change).some((key) => key !== 'expectedVersion'), {
    message: 'Give at least one change: a detail, `pipelineId`, `stageId` or `status`.',
  })
  .refine((change) => !change.lostReason || change.status === 'lost', {
    message: 'A lost reason goes with `status` `lost`.',
    path: ['lostReason'],
  });

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
  /** Moves on with every change; `PATCH /pipelines/{id}` takes it as `expectedVersion` (ADR-286). */
  version: number;
  /** Who added the pipeline (ADR-286): a member (never which) or a key, by its id. */
  createdBy: 'member' | 'api';
  createdByApiKeyId: string | null;
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
  /** Its custom field values by field key (ADR-373), only of fields the company still has. */
  fields: Record<string, string | number | boolean>;
  stageEnteredAt: string;
  lostReason: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Moves on with every change; `PATCH /deals/{id}` takes it as `expectedVersion` (ADR-255). */
  version: number;
  /**
   * Who made the latest change the deal events report (ADR-278), with the key for `api`; null
   * while the deal is as it was added and when the change did not record its maker (ADR-277).
   */
  changedBy: CrmChanger | null;
  changedByApiKeyId: string | null;
  /** Who added the deal (ADR-282): a member (never which), an automation's run or a key. */
  createdBy: CrmChanger;
  createdByApiKeyId: string | null;
}

/** Pipelines, deals and tasks are the CRM's: a plan without it reads none through the API. */
export async function assertCrmInPlan(tx: Tx, tenantId: string): Promise<void> {
  const entitlements = await loadEntitlements(tx, tenantId);
  if (!entitlements.modules.has('crm')) {
    throw new AppError('forbidden', "Your company's plan does not include the CRM.", {
      details: { apiReason: 'not_in_plan' },
    });
  }
}

const pipelineColumns = {
  id: crmPipelines.id,
  name: crmPipelines.name,
  currency: crmPipelines.currency,
  position: crmPipelines.position,
  archivedAt: crmPipelines.archivedAt,
  version: crmPipelines.version,
  createdByApiKeyId: crmPipelines.createdByApiKeyId,
  createdAt: crmPipelines.createdAt,
};

export interface PipelineRow {
  id: string;
  name: string;
  currency: string;
  position: number;
  archivedAt: Date | null;
  version: number;
  createdByApiKeyId: string | null;
  createdAt: Date;
}

/** A pipeline row and its stages as the API gives them. */
export function toApiPipeline(p: PipelineRow, stages: ApiPipelineStage[]): ApiPipeline {
  return {
    id: p.id,
    name: p.name,
    currency: p.currency,
    position: p.position,
    archived: p.archivedAt !== null,
    stages,
    version: p.version,
    createdBy: p.createdByApiKeyId ? 'api' : 'member',
    createdByApiKeyId: p.createdByApiKeyId,
    createdAt: p.createdAt.toISOString(),
  };
}

/** Pipelines as the API gives them, with their stages read in the caller's transaction. */
async function withStages(
  tx: Tx,
  tenantId: string,
  rows: readonly PipelineRow[],
): Promise<ApiPipeline[]> {
  const stages = new Map<string, ApiPipelineStage[]>();
  if (rows.length > 0) {
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
          eq(crmStages.tenantId, tenantId),
          inArray(
            crmStages.pipelineId,
            rows.map((p) => p.id),
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
  return rows.map((p) => toApiPipeline(p, stages.get(p.id) ?? []));
}

/** One of the company's pipelines as the API gives it (ADR-286), or null. */
export async function readApiPipeline(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<ApiPipeline | null> {
  const rows = await tx
    .select(pipelineColumns)
    .from(crmPipelines)
    .where(and(eq(crmPipelines.tenantId, tenantId), eq(crmPipelines.id, id)));
  const [pipeline] = await withStages(tx, tenantId, rows);
  return pipeline ?? null;
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
        .select({ ...pipelineColumns, cursorAt: exactTimestamp(crmPipelines.createdAt) })
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
      return {
        data: await withStages(tx, ctx.tenant.id, shown),
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
  version: crmDeals.version,
  changedBy: crmDeals.changedBy,
  changedByApiKeyId: crmDeals.changedByApiKeyId,
  createdByAutomationId: crmDeals.createdByAutomationId,
  createdByApiKeyId: crmDeals.createdByApiKeyId,
  attributes: crmDeals.attributes,
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
  version: number;
  changedBy: CrmChanger | null;
  changedByApiKeyId: string | null;
  createdByAutomationId: string | null;
  createdByApiKeyId: string | null;
  attributes: Record<string, string | number | boolean>;
}

const toApiDeal = (row: DealRow, dealFields: readonly { key: string }[]): ApiDeal => ({
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
  fields: keptDealAttributes(dealFields, row.attributes),
  stageEnteredAt: row.stageEnteredAt.toISOString(),
  lostReason: row.lostReason,
  closedAt: row.closedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  version: row.version,
  changedBy: row.changedBy,
  changedByApiKeyId: row.changedByApiKeyId,
  ...crmCreatedBy(row.createdByAutomationId, row.createdByApiKeyId),
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
      const dealFields = await loadDealFields(tx, ctx.tenant.id);
      return {
        data: shown.map((row) => toApiDeal(row, dealFields)),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** A custom deal field as the API answers it (ADR-373), a choice with its options (ADR-385). */
export interface ApiDealField {
  key: string;
  label: string;
  type: DealFieldType;
  /** A choice field's options, in order; null for every other type. */
  options: string[] | null;
  createdAt: string;
}

/**
 * The company's custom deal fields (ADR-373), oldest first: the keys deals' `fields` take. Defined in
 * Settings → Pipelines; only reads, so it records nothing.
 */
export async function apiListDealFields(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
): Promise<ApiDealField[]> {
  assertScope(ctx, 'deals.read');
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      return (await loadDealFields(tx, ctx.tenant.id)).map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        options: field.options,
        createdAt: field.createdAt.toISOString(),
      }));
    },
    { accessMode: 'read only' },
  );
}

/** One of the company's deals, or null when it has none with this id. */
async function readApiDeal(tx: Tx, tenantId: string, dealId: string): Promise<ApiDeal | null> {
  const [found] = await tx
    .select(dealColumns)
    .from(crmDeals)
    .innerJoin(crmPipelines, pipelineOfDeal)
    .where(and(eq(crmDeals.tenantId, tenantId), eq(crmDeals.id, dealId)));
  return found ? toApiDeal(found, await loadDealFields(tx, tenantId)) : null;
}

/** One of the company's deals. */
export async function apiGetDeal(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  dealId: string,
): Promise<ApiDeal> {
  assertScope(ctx, 'deals.read');
  if (!z.uuid().safeParse(dealId).success) throw notFound('Deal');
  const deal = await deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      return readApiDeal(tx, ctx.tenant.id, dealId);
    },
    { accessMode: 'read only' },
  );
  if (!deal) throw notFound('Deal');
  return deal;
}

/** What `GET /deals/{id}/history` takes (ADR-281). */
export const apiDealHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
  })
  .strict();

/**
 * The deal's timeline entries its history gives (ADR-281), and the name of each: the changes the
 * deal events report (ADR-256, ADR-269, ADR-275), never its notes or its tasks' entries.
 */
export const API_DEAL_HISTORY_TYPES = {
  deal_created: 'created',
  deal_updated: 'updated',
  stage_changed: 'stage_changed',
  owner_changed: 'owner_changed',
  deal_won: 'won',
  deal_lost: 'lost',
  deal_reopened: 'reopened',
} as const satisfies Partial<Record<CrmActivityKind, string>>;

export type ApiDealHistoryType =
  (typeof API_DEAL_HISTORY_TYPES)[keyof typeof API_DEAL_HISTORY_TYPES];

/** The timeline's names of a deal's details and the names its history gives them, as its events do. */
export const API_DEAL_HISTORY_DETAILS = {
  title: 'title',
  value: 'valueMinor',
  expected_close_on: 'expectedCloseOn',
} as const;

export type ApiDealHistoryDetail =
  (typeof API_DEAL_HISTORY_DETAILS)[keyof typeof API_DEAL_HISTORY_DETAILS];

/** One change of a deal, as `GET /deals/{id}/history` gives it (ADR-281). */
export interface ApiDealHistoryEntry {
  id: string;
  type: ApiDealHistoryType;
  createdAt: string;
  /** Who made it: a member (never which), an automation's run or a key; null when none is known. */
  changedBy: CrmChanger | null;
  changedByApiKeyId: string | null;
  /** `created`: the stage it was added in; `stage_changed`: the stage it moved to. */
  stageId: string | null;
  pipelineId: string | null;
  /** `stage_changed`: the stage it left, and its pipeline. */
  previousStageId: string | null;
  previousPipelineId: string | null;
  /** `owner_changed`: the member it was given to (null: nobody) and the one before. */
  ownerId: string | null;
  previousOwnerId: string | null;
  /** `updated`: what changed, in the order deal events name it. */
  changes: ApiDealHistoryDetail[] | null;
  /** `created` and `won`: the value then; `updated`: the new value, when the value changed. */
  valueMinor: number | null;
  /** `updated`: the value before, when the value changed. */
  previousValueMinor: number | null;
}

/** A timeline row as the history reads it: whether a member made it, never which. */
export interface DealHistoryRow {
  id: string;
  kind: CrmActivityKind;
  data: Record<string, unknown>;
  byMember: boolean;
  createdAt: Date;
}

const text = (value: unknown) => (typeof value === 'string' ? value : null);
const minor = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

/**
 * A deal's timeline row as its history gives it (ADR-281): who made the change (a member, never
 * which; an automation's run; or a key by the id the row names) and what it changed, with the
 * pipeline of each stage (`pipelineOf`). Rows of other kinds are never given.
 */
export function toApiDealHistoryEntry(
  row: DealHistoryRow,
  pipelineOf: (stageId: string | null) => string | null,
): ApiDealHistoryEntry {
  const type = API_DEAL_HISTORY_TYPES[row.kind as keyof typeof API_DEAL_HISTORY_TYPES];
  const { data } = row;
  const apiKeyId = text(data.apiKeyId);
  const changedBy: CrmChanger | null = row.byMember
    ? 'member'
    : text(data.automationId)
      ? 'automation'
      : apiKeyId
        ? 'api'
        : null;
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const changes =
    type === 'updated'
      ? (Object.keys(API_DEAL_HISTORY_DETAILS) as (keyof typeof API_DEAL_HISTORY_DETAILS)[])
          .filter((field) => fields.includes(field))
          .map((field) => API_DEAL_HISTORY_DETAILS[field])
      : null;
  const valueChanged = changes?.includes('valueMinor') ?? false;
  const stageId =
    type === 'created'
      ? text(data.stageId)
      : type === 'stage_changed'
        ? text(data.toStageId)
        : null;
  const previousStageId = type === 'stage_changed' ? text(data.fromStageId) : null;
  return {
    id: row.id,
    type,
    createdAt: row.createdAt.toISOString(),
    changedBy,
    changedByApiKeyId: changedBy === 'api' ? apiKeyId : null,
    stageId,
    pipelineId: pipelineOf(stageId),
    previousStageId,
    previousPipelineId: pipelineOf(previousStageId),
    ownerId: type === 'owner_changed' ? text(data.to) : null,
    previousOwnerId: type === 'owner_changed' ? text(data.from) : null,
    changes,
    valueMinor:
      type === 'created' || type === 'won'
        ? minor(data.valueMinor)
        : valueChanged
          ? minor(data.valueTo)
          : null,
    previousValueMinor: valueChanged ? minor(data.valueFrom) : null,
  };
}

/**
 * A deal's history (ADR-281): the changes its events report, by members, automations and keys,
 * newest first on exact keyset pages, a page never skipping or repeating one. Erasing a contact
 * deletes its timeline, so an erased contact's deal has no history. A change of a deal's custom
 * fields (ADR-373) or products (ADR-375) alone is not given, as deal events do not report it.
 * Only reads.
 */
export async function apiListDealHistory(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  dealId: string,
  query: unknown,
): Promise<{ data: ApiDealHistoryEntry[]; nextCursor: string | null }> {
  assertScope(ctx, 'deals.read');
  if (!z.uuid().safeParse(dealId).success) throw notFound('Deal');
  const q = parseInput(apiDealHistoryQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  const history = await deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      const [deal] = await tx
        .select({ id: crmDeals.id })
        .from(crmDeals)
        .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, dealId)));
      if (!deal) return null;
      const rows = await tx
        .select({
          id: crmActivities.id,
          kind: crmActivities.kind,
          data: crmActivities.data,
          // Whether a member made it, never which.
          byMember: sql<boolean>`(${crmActivities.actorMembershipId} IS NOT NULL)`,
          createdAt: crmActivities.createdAt,
          cursorAt: exactTimestamp(crmActivities.createdAt),
        })
        .from(crmActivities)
        .where(
          and(
            eq(crmActivities.tenantId, ctx.tenant.id),
            eq(crmActivities.dealId, dealId),
            inArray(
              crmActivities.kind,
              Object.keys(API_DEAL_HISTORY_TYPES) as (keyof typeof API_DEAL_HISTORY_TYPES)[],
            ),
            // A change of custom fields (ADR-373) or products (ADR-375) alone names none of the
            // details history gives.
            sql`(${crmActivities.kind} <> 'deal_updated' or coalesce(${crmActivities.data} -> 'fields', '[]'::jsonb) ?| array['title', 'value', 'expected_close_on'])`,
            cursor
              ? sql`(${crmActivities.createdAt}, ${crmActivities.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(crmActivities.createdAt), desc(crmActivities.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      // Each stage's pipeline: stages are archived, never deleted, nor moved to another pipeline.
      const stageIds = [
        ...new Set(
          shown.flatMap((r) =>
            [r.data.stageId, r.data.toStageId, r.data.fromStageId]
              .map(text)
              .filter((id): id is string => id !== null && z.uuid().safeParse(id).success),
          ),
        ),
      ];
      const pipelines = new Map(
        stageIds.length > 0
          ? (
              await tx
                .select({ id: crmStages.id, pipelineId: crmStages.pipelineId })
                .from(crmStages)
                .where(and(eq(crmStages.tenantId, ctx.tenant.id), inArray(crmStages.id, stageIds)))
            ).map((stage) => [stage.id, stage.pipelineId])
          : [],
      );
      const last = shown.at(-1);
      return {
        data: shown.map((row) =>
          toApiDealHistoryEntry(row, (stageId) =>
            stageId ? (pipelines.get(stageId) ?? null) : null,
          ),
        ),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
  if (!history) throw notFound('Deal');
  return history;
}

/** A refused value, named by the field that gave it (a deal's or a task's). */
export const invalidField = (path: string, message: string) =>
  new AppError('validation_failed', message, { issues: [{ path, message }] });

/**
 * The stage a new deal enters: the one given, or the pipeline's first active stage. The pipeline is
 * shared until the deal is in, so archiving it or a stage of it (members lock it to update) waits,
 * as for members' deals.
 */
async function entryStage(
  tx: Tx,
  tenantId: string,
  pipelineId: string,
  stageId: string | undefined,
): Promise<string> {
  const [pipeline] = await tx
    .select({ archivedAt: crmPipelines.archivedAt })
    .from(crmPipelines)
    .where(and(eq(crmPipelines.tenantId, tenantId), eq(crmPipelines.id, pipelineId)))
    .for('share');
  if (!pipeline) {
    throw invalidField(
      'pipelineId',
      'Give the id of one of the company’s pipelines (GET /pipelines).',
    );
  }
  if (pipeline.archivedAt) {
    throw new AppError('conflict', 'This pipeline is archived: members restore it in the app.');
  }
  const stages = await tx
    .select({ id: crmStages.id, archivedAt: crmStages.archivedAt })
    .from(crmStages)
    .where(and(eq(crmStages.tenantId, tenantId), eq(crmStages.pipelineId, pipelineId)))
    .orderBy(asc(crmStages.position), asc(crmStages.id));
  if (stageId === undefined) {
    const first = stages.find((s) => s.archivedAt === null);
    if (!first) throw new AppError('conflict', 'This pipeline has no stages.');
    return first.id;
  }
  const stage = stages.find((s) => s.id === stageId);
  if (!stage) {
    throw invalidField('stageId', 'Give the id of a stage of the pipeline (GET /pipelines).');
  }
  if (stage.archivedAt) throw new AppError('conflict', 'This stage was removed from the pipeline.');
  return stage.id;
}

/**
 * Creates a deal as members do on the board (ADR-254), recorded as created by the key: in an active
 * stage of an active pipeline (its first when none is given), for a contact that exists and was not
 * erased, owned by an active member who can use the CRM or by nobody. Its `deal_created` activity
 * has no member actor and names the key, so the timeline says it came through the API; the audit
 * log names the key. With an Idempotency-Key a retry answers the first response.
 */
export async function apiCreateDeal(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'deals.write');
  const data = parseInput(apiCreateDealSchema, input);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    // Claimed in the deal's transaction, so a refused deal leaves the key unused (ADR-052).
    let claimed: string | null = null;
    if (idempotency) {
      const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
      if ('replay' in claim) return claim.replay;
      claimed = claim.claimed;
    }
    await assertCrmInPlan(tx, ctx.tenant.id);
    // Locked against erasure until the deal is in, as members' deals lock it.
    const [contact] = await tx
      .select({ erasedAt: contacts.erasedAt })
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, data.contactId)))
      .for('key share');
    if (!contact || contact.erasedAt) {
      throw await apiContactNotFound(tx, ctx.tenant.id, data.contactId);
    }
    const stageId = await entryStage(tx, ctx.tenant.id, data.pipelineId, data.stageId);
    const ownerId = data.ownerId ?? null;
    if (ownerId && !(await memberRefs(tx, ctx.tenant.id, [ownerId])).get(ownerId)?.active) {
      throw invalidField(
        'ownerId',
        'Give the id of an active member who can use the CRM (GET /members).',
      );
    }
    const attributes = data.fields
      ? apiMergedDealAttributes(await lockedDealFields(tx, ctx.tenant.id), {}, data.fields)
      : {};
    const id = uuidv7();
    const valueMinor = data.valueMinor ?? null;
    await tx.insert(crmDeals).values({
      id,
      tenantId: ctx.tenant.id,
      pipelineId: data.pipelineId,
      stageId,
      contactId: data.contactId,
      title: data.title,
      valueMinor,
      ownerMembershipId: ownerId,
      expectedCloseOn: data.expectedCloseOn ?? null,
      attributes,
      stageEnteredAt: now,
      createdByApiKeyId: ctx.key.id,
    });
    await addActivity(tx, {
      tenantId: ctx.tenant.id,
      contactId: data.contactId,
      dealId: id,
      actorMembershipId: null,
      kind: 'deal_created',
      data: { stageId, valueMinor, apiKeyId: ctx.key.id },
      at: now,
    });
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'crm.deal_created',
        subjectType: 'crm_deal',
        subjectId: id,
        correlationId: ctx.requestId,
        metadata: { pipelineId: data.pipelineId, stageId, source: 'api' },
      },
      apiActor(ctx),
    );
    const deal = await readApiDeal(tx, ctx.tenant.id, id);
    if (!deal) throw notFound('Deal');
    const response = { status: 201, body: { data: deal } };
    if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
    return { ...response, replayed: false };
  });
}

/** A moved or reopened deal's pipeline, shared until the change is in (see entryStage). */
async function sharedActivePipeline(tx: Tx, tenantId: string, pipelineId: string) {
  const [pipeline] = await tx
    .select({ archivedAt: crmPipelines.archivedAt })
    .from(crmPipelines)
    .where(and(eq(crmPipelines.tenantId, tenantId), eq(crmPipelines.id, pipelineId)))
    .for('share');
  if (!pipeline || pipeline.archivedAt) {
    throw new AppError(
      'conflict',
      'This deal’s pipeline is archived: members restore it in the app first.',
    );
  }
  return tx
    .select({ id: crmStages.id, archivedAt: crmStages.archivedAt })
    .from(crmStages)
    .where(and(eq(crmStages.tenantId, tenantId), eq(crmStages.pipelineId, pipelineId)))
    .orderBy(asc(crmStages.position), asc(crmStages.id));
}

/**
 * Locks one of the company's deals for a change through the API, after its contact (the order
 * erasure takes them in), refused when it changed since `expectedVersion` (when one is given) or a
 * merge moved it to another contact between the reads. Null when the company has no such deal.
 */
export async function lockApiDeal(
  tx: Tx,
  tenantId: string,
  dealId: string,
  expectedVersion: number | undefined,
) {
  const [ref] = await tx
    .select({ contactId: crmDeals.contactId })
    .from(crmDeals)
    .where(and(eq(crmDeals.tenantId, tenantId), eq(crmDeals.id, dealId)));
  if (!ref) return null;
  const [contact] = await tx
    .select({ erasedAt: contacts.erasedAt })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, ref.contactId)))
    .for('key share');
  const [deal] = await tx
    .select()
    .from(crmDeals)
    .where(and(eq(crmDeals.tenantId, tenantId), eq(crmDeals.id, dealId)))
    .for('update');
  if (!deal) return null;
  // A merge moved the deal to another contact between the reads: its contact is not locked.
  if (!contact || deal.contactId !== ref.contactId) {
    throw new AppError('conflict', 'The deal moved to another contact meanwhile; try again.');
  }
  if (expectedVersion !== undefined && expectedVersion !== deal.version) {
    throw new AppError(
      'conflict',
      `The deal changed since version ${expectedVersion}; its version is ${deal.version}. Read it again.`,
    );
  }
  return { deal, erased: contact.erasedAt !== null };
}

/**
 * Changes one of the company's deals as members do on the board and the deal page (ADR-255), in one
 * transaction with the deal's contact and then its row locked (the order erasure takes them in): a
 * closed deal is reopened (in its stage, or the pipeline's first active one when its stage was
 * removed), the open deal moved to another active stage of its pipeline or to another active
 * pipeline (ADR-257: to a stage of it or its first active one, a deal with a value only to a
 * pipeline of its currency), its title, value, owner and expected close date changed (not once its
 * contact is erased), and the open deal closed as won or lost, in that order, with the version
 * moving on once. A deal already as asked is answered as it is, so a retry changes nothing; a
 * closed deal is not moved or closed the other way until it is reopened. Each change is on the
 * deal's timeline without a member actor, naming the key, and the audit log records it as the key.
 */
export async function apiUpdateDeal(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  dealId: string,
  input: unknown,
): Promise<ApiDeal> {
  assertScope(ctx, 'deals.write');
  if (!z.uuid().safeParse(dealId).success) throw notFound('Deal');
  const data = parseInput(apiUpdateDealSchema, input);
  const now = deps.clock.now();
  const deal = await deps.db.run(ctx.scope, async (tx) => {
    await assertCrmInPlan(tx, ctx.tenant.id);
    // The fields before the deal, as a field's deletion takes them (ADR-373).
    const dealFields = data.fields ? await lockedDealFields(tx, ctx.tenant.id) : [];
    const locked = await lockApiDeal(tx, ctx.tenant.id, dealId, data.expectedVersion);
    if (!locked) return null;
    const { deal: current, erased } = locked;
    const detailsGiven =
      data.title !== undefined ||
      data.valueMinor !== undefined ||
      data.ownerId !== undefined ||
      data.expectedCloseOn !== undefined ||
      data.fields !== undefined;
    if (erased && detailsGiven) {
      throw new AppError(
        'conflict',
        'The contact was erased, so this deal’s details can no longer be changed.',
      );
    }
    if (erased && data.lostReason) {
      throw invalidField('lostReason', 'The contact was erased; close the deal without a reason.');
    }

    const next = { ...current };
    const changes: string[] = [];
    const activities: { kind: CrmActivityKind; data: Record<string, unknown> }[] = [];

    if (data.status === 'open' && next.status !== 'open') {
      const stages = await sharedActivePipeline(tx, ctx.tenant.id, next.pipelineId);
      const kept = stages.find((s) => s.id === next.stageId && s.archivedAt === null);
      const stageId = kept?.id ?? stages.find((s) => s.archivedAt === null)?.id;
      if (!stageId) throw new AppError('conflict', 'This deal’s pipeline has no stages.');
      activities.push({ kind: 'deal_reopened', data: {} });
      if (stageId !== next.stageId) {
        activities.push({
          kind: 'stage_changed',
          data: { fromStageId: next.stageId, toStageId: stageId },
        });
        Object.assign(next, { stageId, stageEnteredAt: now });
      }
      Object.assign(next, {
        status: 'open',
        closedAt: null,
        closedByMembershipId: null,
        lostReason: null,
      });
      changes.push('status');
    }

    const pipelineId = data.pipelineId ?? next.pipelineId;
    const otherPipeline = pipelineId !== next.pipelineId;
    if (otherPipeline || (data.stageId !== undefined && data.stageId !== next.stageId)) {
      if (next.status !== 'open') {
        throw new AppError('conflict', 'Reopen the deal to move it (`status` `open`).');
      }
      let stageId: string;
      if (otherPipeline) {
        // Another pipeline (ADR-257), as members move deals: its stage, or its first active one,
        // and the deal's value only in the currency it is in.
        stageId = await entryStage(tx, ctx.tenant.id, pipelineId, data.stageId);
        if (next.valueMinor !== null) {
          const currencies = new Map(
            (
              await tx
                .select({ id: crmPipelines.id, currency: crmPipelines.currency })
                .from(crmPipelines)
                .where(
                  and(
                    eq(crmPipelines.tenantId, ctx.tenant.id),
                    inArray(crmPipelines.id, [next.pipelineId, pipelineId]),
                  ),
                )
            ).map((row) => [row.id, row.currency]),
          );
          const from = currencies.get(next.pipelineId);
          const to = currencies.get(pipelineId);
          if (from !== to) {
            throw new AppError(
              'conflict',
              `This pipeline uses ${to}; clear the deal's value (in ${from}) before moving it: \`valueMinor\` \`null\` in a request of its own.`,
            );
          }
        }
      } else {
        const stages = await sharedActivePipeline(tx, ctx.tenant.id, next.pipelineId);
        const stage = stages.find((s) => s.id === data.stageId);
        if (!stage) {
          throw invalidField(
            'stageId',
            'Give the id of a stage of the deal’s pipeline (GET /pipelines).',
          );
        }
        if (stage.archivedAt) {
          throw new AppError('conflict', 'This stage was removed from the pipeline.');
        }
        stageId = stage.id;
      }
      activities.push({
        kind: 'stage_changed',
        data: {
          fromStageId: next.stageId,
          toStageId: stageId,
          ...(otherPipeline ? { fromPipelineId: next.pipelineId, toPipelineId: pipelineId } : {}),
        },
      });
      Object.assign(next, { pipelineId, stageId, stageEnteredAt: now });
      changes.push(...(otherPipeline ? ['pipeline', 'stage'] : ['stage']));
    }

    const fields: string[] = [];
    if (data.title !== undefined && data.title !== next.title) {
      fields.push('title');
      next.title = data.title;
    }
    const valueFrom = next.valueMinor;
    if (data.valueMinor !== undefined && data.valueMinor !== next.valueMinor) {
      fields.push('value');
      next.valueMinor = data.valueMinor;
    }
    if (data.expectedCloseOn !== undefined && data.expectedCloseOn !== next.expectedCloseOn) {
      fields.push('expected_close_on');
      next.expectedCloseOn = data.expectedCloseOn;
    }
    if (data.fields) {
      const attributes = apiMergedDealAttributes(dealFields, next.attributes, data.fields);
      if (!sameAttributes(attributes, next.attributes)) {
        fields.push('custom_fields');
        next.attributes = attributes;
      }
    }
    if (fields.length > 0) {
      activities.push({
        kind: 'deal_updated',
        data: {
          fields,
          ...(fields.includes('value') ? { valueFrom, valueTo: next.valueMinor } : {}),
        },
      });
      changes.push(...fields);
    }
    if (data.ownerId !== undefined && data.ownerId !== next.ownerMembershipId) {
      if (
        data.ownerId &&
        !(await memberRefs(tx, ctx.tenant.id, [data.ownerId])).get(data.ownerId)?.active
      ) {
        throw invalidField(
          'ownerId',
          'Give the id of an active member who can use the CRM (GET /members).',
        );
      }
      activities.push({
        kind: 'owner_changed',
        data: { from: next.ownerMembershipId, to: data.ownerId },
      });
      next.ownerMembershipId = data.ownerId;
      changes.push('owner');
    }

    if (data.status === 'won' || data.status === 'lost') {
      if (next.status === 'open') {
        const reason = data.status === 'lost' && data.lostReason ? data.lostReason : null;
        activities.push(
          data.status === 'won'
            ? { kind: 'deal_won', data: { valueMinor: next.valueMinor } }
            : { kind: 'deal_lost', data: {} },
        );
        Object.assign(next, {
          status: data.status,
          closedAt: now,
          closedByMembershipId: null,
          lostReason: reason,
        });
        changes.push('status');
      } else if (next.status !== data.status) {
        throw new AppError(
          'conflict',
          `This deal is already ${next.status}: reopen it first (\`status\` \`open\`).`,
        );
      }
    }

    if (activities.length > 0) {
      await tx
        .update(crmDeals)
        .set({
          pipelineId: next.pipelineId,
          stageId: next.stageId,
          stageEnteredAt: next.stageEnteredAt,
          status: next.status,
          title: next.title,
          valueMinor: next.valueMinor,
          ownerMembershipId: next.ownerMembershipId,
          expectedCloseOn: next.expectedCloseOn,
          attributes: next.attributes,
          lostReason: next.lostReason,
          closedAt: next.closedAt,
          closedByMembershipId: next.closedByMembershipId,
          version: current.version + 1,
          ...crmChangedBy({ apiKeyId: ctx.key.id }),
        })
        .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, current.id)));
      for (const activity of activities) {
        await addActivity(tx, {
          tenantId: ctx.tenant.id,
          contactId: current.contactId,
          dealId: current.id,
          actorMembershipId: null,
          kind: activity.kind,
          data: { ...activity.data, apiKeyId: ctx.key.id },
          at: now,
        });
      }
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'crm.deal_updated',
          subjectType: 'crm_deal',
          subjectId: current.id,
          correlationId: ctx.requestId,
          metadata: { changes, source: 'api' },
        },
        apiActor(ctx),
      );
    }
    return readApiDeal(tx, ctx.tenant.id, current.id);
  });
  if (!deal) throw notFound('Deal');
  return deal;
}
