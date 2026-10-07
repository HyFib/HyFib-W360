import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  asc,
  contacts,
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
  type DealStatus,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { addActivity, crmChangedBy, memberRefs } from '../crm/common';
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
  /** Moves on with every change; `PATCH /deals/{id}` takes it as `expectedVersion` (ADR-255). */
  version: number;
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
  version: crmDeals.version,
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
  version: row.version,
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

/** One of the company's deals, or null when it has none with this id. */
async function readApiDeal(tx: Tx, tenantId: string, dealId: string): Promise<ApiDeal | null> {
  const [found] = await tx
    .select(dealColumns)
    .from(crmDeals)
    .innerJoin(crmPipelines, pipelineOfDeal)
    .where(and(eq(crmDeals.tenantId, tenantId), eq(crmDeals.id, dealId)));
  return found ? toApiDeal(found) : null;
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
    const [ref] = await tx
      .select({ contactId: crmDeals.contactId })
      .from(crmDeals)
      .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, dealId)));
    if (!ref) return null;
    const [contact] = await tx
      .select({ erasedAt: contacts.erasedAt })
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, ref.contactId)))
      .for('key share');
    const [current] = await tx
      .select()
      .from(crmDeals)
      .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, dealId)))
      .for('update');
    if (!current) return null;
    // A merge moved the deal to another contact between the reads: its contact is not locked.
    if (!contact || current.contactId !== ref.contactId) {
      throw new AppError('conflict', 'The deal moved to another contact meanwhile; try again.');
    }
    if (data.expectedVersion !== undefined && data.expectedVersion !== current.version) {
      throw new AppError(
        'conflict',
        `The deal changed since version ${data.expectedVersion}; its version is ${current.version}. Read it again.`,
      );
    }
    const erased = contact.erasedAt !== null;
    const detailsGiven =
      data.title !== undefined ||
      data.valueMinor !== undefined ||
      data.ownerId !== undefined ||
      data.expectedCloseOn !== undefined;
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
