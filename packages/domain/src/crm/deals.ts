import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  conversations,
  crmActivities,
  crmDeals,
  crmPipelines,
  crmStages,
  crmTasks,
  DEAL_STATUSES,
  desc,
  eq,
  exactTimestamp,
  inArray,
  isNull,
  sql,
  type CrmActivityKind,
  type Database,
  type DealStatus,
  type Tx,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, can, type TenantContext } from '../authz/context';
import { CSV_BOM, csvLine } from '../contacts/csv';
import type { NumberViewer } from '../contacts/number-masking';
import { canSeeConversation } from '../messaging/outbound';
import { parseInput } from '../validation';
import {
  CRM_LIMITS,
  addActivity,
  assertCrmMember,
  assertLiveContact,
  contactRefs,
  lockContact,
  memberRefs,
  trimmed,
  uuidSchema,
  versionConflict,
  type ContactRef,
  type MemberRef,
} from './common';
import { DEAL_CSV_COLUMNS, dealCsvLine } from './deals-csv';
import { currencyDigits, parseAmountToMinor } from './money';
import { loadPipelines, type PipelineSummary, type StageSummary } from './pipelines';
import { tasksWhere, type TaskItem } from './tasks';

export interface DealCard {
  id: string;
  title: string;
  valueMinor: number | null;
  currency: string;
  pipelineId: string;
  stageId: string;
  status: DealStatus;
  owner: MemberRef | null;
  contact: ContactRef;
  expectedCloseOn: string | null;
  stageEnteredAt: string;
  closedAt: string | null;
  openTasks: number;
  version: number;
}

export interface BoardColumn {
  stage: StageSummary;
  deals: DealCard[];
  /** All open deals in the stage (the list may be cut at CRM_LIMITS.boardDealsPerStage). */
  count: number;
  valueMinor: number;
}

export interface Board {
  pipeline: PipelineSummary;
  pipelines: PipelineSummary[];
  columns: BoardColumn[];
}

export interface ActivityItem {
  id: string;
  kind: CrmActivityKind;
  data: Record<string, unknown>;
  body: string | null;
  actor: MemberRef | null;
  dealId: string | null;
  dealTitle: string | null;
  taskId: string | null;
  taskTitle: string | null;
  createdAt: string;
}

export interface DealDetail extends DealCard {
  pipelineName: string;
  stageName: string;
  lostReason: string | null;
  closedBy: MemberRef | null;
  createdAt: string;
  createdBy: MemberRef | null;
  /** Only for members who can see the conversation. */
  conversationId: string | null;
  tasks: { open: TaskItem[]; done: TaskItem[] };
  timeline: ActivityItem[];
}

export interface ContactCrm {
  contact: ContactRef;
  deals: DealCard[];
  tasks: TaskItem[];
  timeline: ActivityItem[];
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.')
  // The date parser rolls impossible dates over (31 February becomes 3 March): require a round trip.
  .refine((d) => {
    const at = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === d;
  }, 'Enter a valid date.');

const valueSchema = z.string().trim().max(40, 'Enter a shorter amount.');

const createSchema = z.object({
  contactId: uuidSchema,
  conversationId: uuidSchema.nullable().default(null),
  pipelineId: uuidSchema,
  stageId: uuidSchema,
  title: trimmed(120, 'a title'),
  value: valueSchema.default(''),
  ownerMembershipId: uuidSchema.nullable().default(null),
  expectedCloseOn: dateSchema.nullable().default(null),
});

const updateSchema = z.object({
  id: uuidSchema,
  expectedVersion: z.number().int().min(1),
  title: trimmed(120, 'a title'),
  value: valueSchema,
  ownerMembershipId: uuidSchema.nullable(),
  expectedCloseOn: dateSchema.nullable(),
});

const moveSchema = z.object({
  id: uuidSchema,
  expectedVersion: z.number().int().min(1),
  stageId: uuidSchema,
  pipelineId: uuidSchema.nullable().default(null),
});

const closeSchema = z.object({
  id: uuidSchema,
  expectedVersion: z.number().int().min(1),
  outcome: z.enum(['won', 'lost']),
  lostReason: z
    .string()
    .trim()
    .max(200, 'The reason is limited to 200 characters.')
    .nullable()
    .default(null),
});

const versionSchema = z.object({ id: uuidSchema, expectedVersion: z.number().int().min(1) });

const noteSchema = z
  .object({
    contactId: uuidSchema.nullable().default(null),
    dealId: uuidSchema.nullable().default(null),
    body: trimmed(4000, 'a note'),
  })
  .refine((n) => n.contactId !== null || n.dealId !== null, 'Choose a contact or a deal.');

const boardSchema = z.object({
  pipelineId: uuidSchema.nullable().default(null),
  owner: z
    .union([z.literal('all'), z.literal('mine'), z.literal('none'), uuidSchema])
    .default('all'),
});

const listSchema = z.object({
  status: z.enum(['open', 'won', 'lost']).nullable().default(null),
  pipelineId: uuidSchema.nullable().default(null),
  cursor: z.string().max(200).nullable().default(null),
});

const LIST_PAGE = 50;

/** A deal export (ADR-239): the board's or a list's filters, each optional. */
export const dealExportSchema = z.object({
  status: z.enum(DEAL_STATUSES).optional(),
  pipelineId: uuidSchema.optional(),
  owner: boardSchema.shape.owner,
});

/** Deals read per batch of an export, each batch in its own read-only transaction. */
export const DEAL_EXPORT_BATCH = 500;

function parseValue(text: string, currency: string): number | null {
  if (!text) return null;
  const minor = parseAmountToMinor(text, currency);
  if (minor === null) {
    const digits = currencyDigits(currency);
    throw new AppError(
      'validation_failed',
      digits === 0
        ? `Enter the value in ${currency} as a whole number.`
        : `Enter the value in ${currency} with at most ${digits} decimals.`,
    );
  }
  return minor;
}

function ownerFilter(ctx: TenantContext, owner: string) {
  if (owner === 'all') return undefined;
  if (owner === 'mine') return eq(crmDeals.ownerMembershipId, ctx.membership.id);
  if (owner === 'none') return isNull(crmDeals.ownerMembershipId);
  return eq(crmDeals.ownerMembershipId, owner);
}

type DealRow = typeof crmDeals.$inferSelect;

async function dealCards(
  tx: Tx,
  tenantId: string,
  rows: DealRow[],
  currencies: ReadonlyMap<string, string>,
  viewer: NumberViewer,
): Promise<DealCard[]> {
  if (rows.length === 0) return [];
  const members = await memberRefs(
    tx,
    tenantId,
    rows.map((r) => r.ownerMembershipId),
  );
  const people = await contactRefs(
    tx,
    tenantId,
    rows.map((r) => r.contactId),
    viewer,
  );
  const counts = await tx
    .select({ dealId: crmTasks.dealId, n: sql<number>`count(*)::int` })
    .from(crmTasks)
    .where(
      and(
        eq(crmTasks.tenantId, tenantId),
        eq(crmTasks.status, 'open'),
        inArray(
          crmTasks.dealId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .groupBy(crmTasks.dealId);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    valueMinor: r.valueMinor,
    currency: currencies.get(r.pipelineId) ?? 'INR',
    pipelineId: r.pipelineId,
    stageId: r.stageId,
    status: r.status,
    owner: r.ownerMembershipId ? (members.get(r.ownerMembershipId) ?? null) : null,
    contact: people.get(r.contactId) ?? { id: r.contactId, name: null, phone: null, erased: true },
    expectedCloseOn: r.expectedCloseOn,
    stageEnteredAt: r.stageEnteredAt.toISOString(),
    closedAt: r.closedAt?.toISOString() ?? null,
    openTasks: counts.find((c) => c.dealId === r.id)?.n ?? 0,
    version: r.version,
  }));
}

async function pipelineCurrencies(tx: Tx, tenantId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ id: crmPipelines.id, currency: crmPipelines.currency })
    .from(crmPipelines)
    .where(eq(crmPipelines.tenantId, tenantId));
  return new Map(rows.map((r) => [r.id, r.currency]));
}

/** Timeline entries (newest first) for a contact or a deal. */
async function timeline(
  tx: Tx,
  tenantId: string,
  filter: { contactId: string } | { dealId: string },
): Promise<ActivityItem[]> {
  const rows = await tx
    .select()
    .from(crmActivities)
    .where(
      and(
        eq(crmActivities.tenantId, tenantId),
        'contactId' in filter
          ? eq(crmActivities.contactId, filter.contactId)
          : eq(crmActivities.dealId, filter.dealId),
      ),
    )
    .orderBy(desc(crmActivities.createdAt), desc(crmActivities.id))
    .limit(CRM_LIMITS.timeline);
  const actors = await memberRefs(
    tx,
    tenantId,
    rows.map((r) => r.actorMembershipId),
  );
  const dealIds = [...new Set(rows.map((r) => r.dealId).filter((x): x is string => x !== null))];
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter((x): x is string => x !== null))];
  const deals =
    dealIds.length > 0
      ? await tx
          .select({ id: crmDeals.id, title: crmDeals.title })
          .from(crmDeals)
          .where(and(eq(crmDeals.tenantId, tenantId), inArray(crmDeals.id, dealIds)))
      : [];
  const tasks =
    taskIds.length > 0
      ? await tx
          .select({ id: crmTasks.id, title: crmTasks.title })
          .from(crmTasks)
          .where(and(eq(crmTasks.tenantId, tenantId), inArray(crmTasks.id, taskIds)))
      : [];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    data: r.data,
    body: r.body,
    actor: r.actorMembershipId ? (actors.get(r.actorMembershipId) ?? null) : null,
    dealId: r.dealId,
    dealTitle: deals.find((d) => d.id === r.dealId)?.title ?? null,
    taskId: r.taskId,
    taskTitle: tasks.find((t) => t.id === r.taskId)?.title ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function lockDeal(tx: Tx, tenantId: string, id: string, expectedVersion: number) {
  const [deal] = await tx
    .select()
    .from(crmDeals)
    .where(and(eq(crmDeals.tenantId, tenantId), eq(crmDeals.id, id)))
    .for('update');
  if (!deal) throw notFound('Deal');
  if (deal.version !== expectedVersion) throw versionConflict();
  return deal;
}

/**
 * Locks a deal for a change, after locking its contact against erasure (the order erasure uses:
 * contact, then deals). A deal's contact never changes, so reading it before the locks is safe.
 */
async function lockDealForChange(tx: Tx, tenantId: string, id: string, expectedVersion: number) {
  const [ref] = await tx
    .select({ contactId: crmDeals.contactId })
    .from(crmDeals)
    .where(and(eq(crmDeals.tenantId, tenantId), eq(crmDeals.id, id)));
  if (!ref) throw notFound('Deal');
  const { erased } = await lockContact(tx, tenantId, ref.contactId);
  const deal = await lockDeal(tx, tenantId, id, expectedVersion);
  return { deal, erased };
}

/**
 * Shares the pipeline row for the rest of the transaction and returns it. Settings changes lock the
 * pipeline FOR UPDATE before they count open deals and archive its stages or the pipeline itself, so
 * they wait for a deal writer holding this lock, and a writer that had to wait sees their result.
 * Take it before reading stages: the stage read is then a new statement, whose snapshot includes a
 * change that just committed. (Locking stage rows as well would invert the settings change's order,
 * pipeline then stages, and deadlock.)
 */
async function sharePipeline(tx: Tx, tenantId: string, pipelineId: string) {
  const [pipeline] = await tx
    .select({ archivedAt: crmPipelines.archivedAt, currency: crmPipelines.currency })
    .from(crmPipelines)
    .where(and(eq(crmPipelines.tenantId, tenantId), eq(crmPipelines.id, pipelineId)))
    .for('share');
  return pipeline ?? null;
}

async function activeStage(tx: Tx, tenantId: string, pipelineId: string, stageId: string) {
  const pipeline = await sharePipeline(tx, tenantId, pipelineId);
  if (!pipeline) throw new AppError('validation_failed', 'Choose a stage of the pipeline.');
  if (pipeline.archivedAt) throw new AppError('conflict', 'This pipeline is archived.');
  const [stage] = await tx
    .select({ archivedAt: crmStages.archivedAt })
    .from(crmStages)
    .where(
      and(
        eq(crmStages.tenantId, tenantId),
        eq(crmStages.id, stageId),
        eq(crmStages.pipelineId, pipelineId),
      ),
    );
  if (!stage) throw new AppError('validation_failed', 'Choose a stage of the pipeline.');
  if (stage.archivedAt) throw new AppError('conflict', 'This stage was removed.');
  return { currency: pipeline.currency };
}

export function dealOperations(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;
  const inboxReader = (ctx: TenantContext) =>
    can(ctx, 'inbox.read_all') || can(ctx, 'inbox.read_assigned');

  return {
    /** The open deals of one pipeline by stage; null when the company has no pipeline yet. */
    async board(ctx: TenantContext, input: unknown = {}): Promise<Board | null> {
      assertCan(ctx, 'crm.read');
      const data = parseInput(boardSchema, input);
      return db.run(
        ctx.scope,
        async (tx) => {
          const pipelines = await loadPipelines(tx, ctx.tenant.id, { includeArchived: false });
          const pipeline = data.pipelineId
            ? pipelines.find((p) => p.id === data.pipelineId)
            : pipelines[0];
          if (!pipeline) {
            if (data.pipelineId) throw notFound('Pipeline');
            return null;
          }
          const where = and(
            eq(crmDeals.tenantId, ctx.tenant.id),
            eq(crmDeals.pipelineId, pipeline.id),
            eq(crmDeals.status, 'open'),
            ownerFilter(ctx, data.owner),
          );
          const totals = await tx
            .select({
              stageId: crmDeals.stageId,
              n: sql<number>`count(*)::int`,
              value: sql<string>`coalesce(sum(${crmDeals.valueMinor}), 0)::text`,
            })
            .from(crmDeals)
            .where(where)
            .groupBy(crmDeals.stageId);
          const ranked = await tx
            .select({
              id: crmDeals.id,
              rank: sql<number>`row_number() over (partition by ${crmDeals.stageId} order by ${crmDeals.stageEnteredAt} desc, ${crmDeals.id} desc)`,
            })
            .from(crmDeals)
            .where(where);
          const shown = ranked
            .filter((r) => r.rank <= CRM_LIMITS.boardDealsPerStage)
            .map((r) => r.id);
          const rows =
            shown.length > 0
              ? await tx
                  .select()
                  .from(crmDeals)
                  .where(and(eq(crmDeals.tenantId, ctx.tenant.id), inArray(crmDeals.id, shown)))
                  .orderBy(desc(crmDeals.stageEnteredAt), desc(crmDeals.id))
              : [];
          const cards = await dealCards(
            tx,
            ctx.tenant.id,
            rows,
            new Map([[pipeline.id, pipeline.currency]]),
            ctx,
          );
          return {
            pipeline,
            pipelines,
            columns: pipeline.stages
              .filter((s) => !s.archived)
              .map((stage) => {
                const total = totals.find((t) => t.stageId === stage.id);
                return {
                  stage,
                  deals: cards.filter((c) => c.stageId === stage.id),
                  count: total?.n ?? 0,
                  valueMinor: Number(total?.value ?? 0),
                };
              }),
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** Deals across pipelines, most recently changed first (for won, lost and all-deal lists). */
    async listDeals(ctx: TenantContext, input: unknown = {}) {
      assertCan(ctx, 'crm.read');
      const data = parseInput(listSchema, input);
      let cursor: { at: Date; id: string } | null = null;
      if (data.cursor) {
        const [iso, id] = Buffer.from(data.cursor, 'base64url').toString('utf8').split('|');
        const at = iso ? new Date(iso) : null;
        if (!at || Number.isNaN(at.getTime()) || !id || !uuidSchema.safeParse(id).success) {
          throw new AppError('validation_failed', 'Invalid cursor.');
        }
        cursor = { at, id };
      }
      // Keyset on the millisecond: JavaScript dates cannot carry PostgreSQL's microseconds, so the
      // order and the cursor both use the time truncated to milliseconds (ties broken by id).
      const changedAt = sql<Date>`date_trunc('milliseconds', ${crmDeals.updatedAt})`;
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({ deal: crmDeals, changedAt })
            .from(crmDeals)
            .where(
              and(
                eq(crmDeals.tenantId, ctx.tenant.id),
                data.status ? eq(crmDeals.status, data.status) : undefined,
                data.pipelineId ? eq(crmDeals.pipelineId, data.pipelineId) : undefined,
                cursor
                  ? sql`(${changedAt}, ${crmDeals.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(desc(changedAt), desc(crmDeals.id))
            .limit(LIST_PAGE + 1);
          const page = rows.slice(0, LIST_PAGE);
          const last = page.at(-1);
          return {
            deals: await dealCards(
              tx,
              ctx.tenant.id,
              page.map((r) => r.deal),
              await pipelineCurrencies(tx, ctx.tenant.id),
              ctx,
            ),
            nextCursor:
              rows.length > LIST_PAGE && last
                ? Buffer.from(`${new Date(last.changedAt).toISOString()}|${last.deal.id}`).toString(
                    'base64url',
                  )
                : null,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * The deals the board or a list shows as CSV (ADR-239), newest first, streamed in batches,
     * with their filters (a status, a pipeline, an owner). They carry customers' names and numbers,
     * so they need `contacts.export` too; numbers are shown as the member may see them (ADR-226).
     * Audited before the first line.
     */
    async *exportDeals(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): AsyncGenerator<string> {
      assertCan(ctx, 'crm.read');
      assertCan(ctx, 'contacts.export');
      const data = parseInput(dealExportSchema, input ?? {});
      await db.run(ctx.scope, async (tx) => {
        if (data.pipelineId) {
          const [pipeline] = await tx
            .select({ id: crmPipelines.id })
            .from(crmPipelines)
            .where(
              and(eq(crmPipelines.tenantId, ctx.tenant.id), eq(crmPipelines.id, data.pipelineId)),
            );
          if (!pipeline) throw notFound('Pipeline');
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'crm.deals_exported',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: {
              status: data.status ?? null,
              pipelineId: data.pipelineId ?? null,
              owner: data.owner,
            },
          },
          meta,
        );
      });
      yield CSV_BOM + csvLine(DEAL_CSV_COLUMNS);
      let before: { at: string; id: string } | null = null;
      for (;;) {
        const cursor: { at: string; id: string } | null = before;
        const batch: { lines: string[]; next: { at: string; id: string } | null } = await db.run(
          ctx.scope,
          async (tx) => {
            // Exact to the microsecond, so a batch never ends between two deals created in the same
            // millisecond.
            const rows = await tx
              .select({ deal: crmDeals, cursorAt: exactTimestamp(crmDeals.createdAt) })
              .from(crmDeals)
              .where(
                and(
                  eq(crmDeals.tenantId, ctx.tenant.id),
                  data.status ? eq(crmDeals.status, data.status) : undefined,
                  data.pipelineId ? eq(crmDeals.pipelineId, data.pipelineId) : undefined,
                  ownerFilter(ctx, data.owner),
                  cursor
                    ? sql`(${crmDeals.createdAt}, ${crmDeals.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
                    : undefined,
                ),
              )
              .orderBy(desc(crmDeals.createdAt), desc(crmDeals.id))
              .limit(DEAL_EXPORT_BATCH);
            const deals = rows.map((r) => r.deal);
            const last = rows.at(-1);
            const cards = await dealCards(
              tx,
              ctx.tenant.id,
              deals,
              await pipelineCurrencies(tx, ctx.tenant.id),
              ctx,
            );
            const pipelines = await loadPipelines(tx, ctx.tenant.id, { includeArchived: true });
            const stages = new Map(
              pipelines.flatMap((p) => p.stages.map((st) => [st.id, st.name])),
            );
            const names = new Map(pipelines.map((p) => [p.id, p.name]));
            return {
              lines: deals.map((deal, i) => {
                const card = cards[i];
                return dealCsvLine({
                  id: deal.id,
                  title: deal.title,
                  pipelineName: names.get(deal.pipelineId) ?? '',
                  stageName: stages.get(deal.stageId) ?? '',
                  status: deal.status,
                  currency: card?.currency ?? '',
                  valueMinor: deal.valueMinor,
                  ownerName: card?.owner?.name ?? null,
                  contactName: card?.contact.name ?? null,
                  contactPhone: card?.contact.phone ?? null,
                  contactErased: card?.contact.erased ?? true,
                  expectedCloseOn: deal.expectedCloseOn,
                  createdAt: deal.createdAt,
                  stageEnteredAt: deal.stageEnteredAt,
                  closedAt: deal.closedAt,
                  lostReason: deal.lostReason,
                  openTasks: card?.openTasks ?? 0,
                });
              }),
              // The next batch starts after this one's last deal, unless this one was the last.
              next:
                rows.length === DEAL_EXPORT_BATCH && last
                  ? { at: last.cursorAt, id: last.deal.id }
                  : null,
            };
          },
          { accessMode: 'read only' },
        );
        if (batch.lines.length > 0) yield batch.lines.join('');
        if (!batch.next) break;
        before = batch.next;
      }
    },

    async getDeal(ctx: TenantContext, id: string): Promise<DealDetail> {
      assertCan(ctx, 'crm.read');
      if (!uuidSchema.safeParse(id).success) throw notFound('Deal');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [row] = await tx
            .select({
              deal: crmDeals,
              pipelineName: crmPipelines.name,
              currency: crmPipelines.currency,
              stageName: crmStages.name,
              assigned: conversations.assignedMembershipId,
            })
            .from(crmDeals)
            .innerJoin(
              crmPipelines,
              and(
                eq(crmPipelines.tenantId, crmDeals.tenantId),
                eq(crmPipelines.id, crmDeals.pipelineId),
              ),
            )
            .innerJoin(
              crmStages,
              and(eq(crmStages.tenantId, crmDeals.tenantId), eq(crmStages.id, crmDeals.stageId)),
            )
            .leftJoin(
              conversations,
              and(
                eq(conversations.tenantId, crmDeals.tenantId),
                eq(conversations.id, crmDeals.conversationId),
              ),
            )
            .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, id)));
          if (!row) throw notFound('Deal');
          const [card] = await dealCards(
            tx,
            ctx.tenant.id,
            [row.deal],
            new Map([[row.deal.pipelineId, row.currency]]),
            ctx,
          );
          const people = await memberRefs(tx, ctx.tenant.id, [
            row.deal.closedByMembershipId,
            row.deal.createdByMembershipId,
          ]);
          const visible =
            row.deal.conversationId !== null &&
            inboxReader(ctx) &&
            canSeeConversation(ctx, row.assigned);
          return {
            ...(card as DealCard),
            pipelineName: row.pipelineName,
            stageName: row.stageName,
            lostReason: row.deal.lostReason,
            closedBy: row.deal.closedByMembershipId
              ? (people.get(row.deal.closedByMembershipId) ?? null)
              : null,
            createdAt: row.deal.createdAt.toISOString(),
            createdBy: people.get(row.deal.createdByMembershipId) ?? null,
            conversationId: visible ? row.deal.conversationId : null,
            tasks: {
              open: await tasksWhere(tx, ctx.tenant.id, { dealId: id, status: 'open' }, ctx),
              done: await tasksWhere(tx, ctx.tenant.id, { dealId: id, status: 'done' }, ctx),
            },
            timeline: await timeline(tx, ctx.tenant.id, { dealId: id }),
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** Deals, open tasks and timeline of a contact (contact page and inbox side panel). */
    async contactCrm(ctx: TenantContext, contactId: string): Promise<ContactCrm> {
      assertCan(ctx, 'crm.read');
      if (!uuidSchema.safeParse(contactId).success) throw notFound('Contact');
      return db.run(
        ctx.scope,
        async (tx) => {
          const contact = (await contactRefs(tx, ctx.tenant.id, [contactId], ctx)).get(contactId);
          if (!contact) throw notFound('Contact');
          const rows = await tx
            .select()
            .from(crmDeals)
            .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.contactId, contactId)))
            .orderBy(sql`${crmDeals.status} = 'open' desc`, desc(crmDeals.updatedAt))
            .limit(50);
          return {
            contact,
            deals: await dealCards(
              tx,
              ctx.tenant.id,
              rows,
              await pipelineCurrencies(tx, ctx.tenant.id),
              ctx,
            ),
            tasks: await tasksWhere(tx, ctx.tenant.id, { contactId, status: 'open' }, ctx),
            timeline: await timeline(tx, ctx.tenant.id, { contactId }),
          };
        },
        { accessMode: 'read only' },
      );
    },

    async createDeal(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'crm.write');
      const data = parseInput(createSchema, input);
      return db.run(ctx.scope, async (tx) => {
        await assertLiveContact(tx, ctx.tenant.id, data.contactId);
        if (data.conversationId) {
          const [conv] = await tx
            .select({
              contactId: conversations.contactId,
              assigned: conversations.assignedMembershipId,
            })
            .from(conversations)
            .where(
              and(
                eq(conversations.tenantId, ctx.tenant.id),
                eq(conversations.id, data.conversationId),
              ),
            );
          if (
            !conv ||
            conv.contactId !== data.contactId ||
            !inboxReader(ctx) ||
            !canSeeConversation(ctx, conv.assigned)
          ) {
            throw notFound('Conversation');
          }
        }
        const { currency } = await activeStage(tx, ctx.tenant.id, data.pipelineId, data.stageId);
        if (data.ownerMembershipId)
          await assertCrmMember(tx, ctx.tenant.id, data.ownerMembershipId);
        const valueMinor = parseValue(data.value, currency);
        const now = clock.now();
        const id = uuidv7();
        await tx.insert(crmDeals).values({
          id,
          tenantId: ctx.tenant.id,
          pipelineId: data.pipelineId,
          stageId: data.stageId,
          contactId: data.contactId,
          conversationId: data.conversationId,
          title: data.title,
          valueMinor,
          ownerMembershipId: data.ownerMembershipId,
          expectedCloseOn: data.expectedCloseOn,
          stageEnteredAt: now,
          createdByMembershipId: ctx.membership.id,
        });
        await addActivity(tx, {
          tenantId: ctx.tenant.id,
          contactId: data.contactId,
          dealId: id,
          actorMembershipId: ctx.membership.id,
          kind: 'deal_created',
          data: { stageId: data.stageId, valueMinor },
          at: now,
        });
        return { id };
      });
    },

    /** Edits title, value, owner and expected close date. */
    async updateDeal(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'crm.write');
      const data = parseInput(updateSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const { deal, erased } = await lockDealForChange(
          tx,
          ctx.tenant.id,
          data.id,
          data.expectedVersion,
        );
        if (erased) {
          throw new AppError(
            'conflict',
            'The contact was erased; this deal can no longer be edited.',
          );
        }
        const [pipeline] = await tx
          .select({ currency: crmPipelines.currency })
          .from(crmPipelines)
          .where(
            and(eq(crmPipelines.tenantId, ctx.tenant.id), eq(crmPipelines.id, deal.pipelineId)),
          );
        const valueMinor = parseValue(data.value, pipeline?.currency ?? 'INR');
        const fields: string[] = [];
        if (data.title !== deal.title) fields.push('title');
        if (valueMinor !== deal.valueMinor) fields.push('value');
        if (data.expectedCloseOn !== deal.expectedCloseOn) fields.push('expected_close_on');
        const ownerChanged = data.ownerMembershipId !== deal.ownerMembershipId;
        if (fields.length === 0 && !ownerChanged) return { version: deal.version };
        if (ownerChanged && data.ownerMembershipId) {
          await assertCrmMember(tx, ctx.tenant.id, data.ownerMembershipId);
        }
        const now = clock.now();
        const version = deal.version + 1;
        await tx
          .update(crmDeals)
          .set({
            title: data.title,
            valueMinor,
            expectedCloseOn: data.expectedCloseOn,
            ownerMembershipId: data.ownerMembershipId,
            version,
          })
          .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, deal.id)));
        if (fields.length > 0) {
          await addActivity(tx, {
            tenantId: ctx.tenant.id,
            contactId: deal.contactId,
            dealId: deal.id,
            actorMembershipId: ctx.membership.id,
            kind: 'deal_updated',
            data: {
              fields,
              ...(fields.includes('value')
                ? { valueFrom: deal.valueMinor, valueTo: valueMinor }
                : {}),
            },
            at: now,
          });
        }
        if (ownerChanged) {
          await addActivity(tx, {
            tenantId: ctx.tenant.id,
            contactId: deal.contactId,
            dealId: deal.id,
            actorMembershipId: ctx.membership.id,
            kind: 'owner_changed',
            data: { from: deal.ownerMembershipId, to: data.ownerMembershipId },
            at: now,
          });
        }
        return { version };
      });
    },

    /** Moves an open deal to another stage (of the same pipeline, or of another one in the same currency). */
    async moveDeal(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'crm.write');
      const data = parseInput(moveSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const { deal } = await lockDealForChange(tx, ctx.tenant.id, data.id, data.expectedVersion);
        if (deal.status !== 'open') throw new AppError('conflict', 'Reopen the deal to move it.');
        const pipelineId = data.pipelineId ?? deal.pipelineId;
        if (pipelineId === deal.pipelineId && data.stageId === deal.stageId) {
          return { version: deal.version };
        }
        const { currency } = await activeStage(tx, ctx.tenant.id, pipelineId, data.stageId);
        if (pipelineId !== deal.pipelineId && deal.valueMinor !== null) {
          const [current] = await tx
            .select({ currency: crmPipelines.currency })
            .from(crmPipelines)
            .where(
              and(eq(crmPipelines.tenantId, ctx.tenant.id), eq(crmPipelines.id, deal.pipelineId)),
            );
          if (current?.currency !== currency) {
            throw new AppError(
              'conflict',
              `This pipeline uses ${currency}; clear the deal's value (in ${current?.currency}) before moving it.`,
            );
          }
        }
        const now = clock.now();
        const version = deal.version + 1;
        await tx
          .update(crmDeals)
          .set({ pipelineId, stageId: data.stageId, stageEnteredAt: now, version })
          .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, deal.id)));
        await addActivity(tx, {
          tenantId: ctx.tenant.id,
          contactId: deal.contactId,
          dealId: deal.id,
          actorMembershipId: ctx.membership.id,
          kind: 'stage_changed',
          data: {
            fromStageId: deal.stageId,
            toStageId: data.stageId,
            ...(pipelineId !== deal.pipelineId
              ? { fromPipelineId: deal.pipelineId, toPipelineId: pipelineId }
              : {}),
          },
          at: now,
        });
        return { version };
      });
    },

    async closeDeal(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'crm.write');
      const data = parseInput(closeSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const { deal, erased } = await lockDealForChange(
          tx,
          ctx.tenant.id,
          data.id,
          data.expectedVersion,
        );
        if (deal.status !== 'open') throw new AppError('conflict', 'This deal is already closed.');
        const reason = data.outcome === 'lost' && data.lostReason ? data.lostReason : null;
        if (reason && erased) {
          throw new AppError(
            'validation_failed',
            'The contact was erased; close the deal without a reason.',
          );
        }
        const now = clock.now();
        const version = deal.version + 1;
        await tx
          .update(crmDeals)
          .set({
            status: data.outcome,
            closedAt: now,
            closedByMembershipId: ctx.membership.id,
            lostReason: reason,
            version,
          })
          .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, deal.id)));
        await addActivity(tx, {
          tenantId: ctx.tenant.id,
          contactId: deal.contactId,
          dealId: deal.id,
          actorMembershipId: ctx.membership.id,
          kind: data.outcome === 'won' ? 'deal_won' : 'deal_lost',
          data: data.outcome === 'won' ? { valueMinor: deal.valueMinor } : {},
          at: now,
        });
        return { version };
      });
    },

    /**
     * Reopens a closed deal in its stage, or in the pipeline's first stage when its stage was
     * removed in the meantime (stages are archived, not restorable). An archived pipeline must be
     * restored first.
     */
    async reopenDeal(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'crm.write');
      const data = parseInput(versionSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const { deal } = await lockDealForChange(tx, ctx.tenant.id, data.id, data.expectedVersion);
        if (deal.status === 'open') return { version: deal.version };
        // Like activeStage: a concurrent archive of the pipeline or a stage finishes first.
        const pipeline = await sharePipeline(tx, ctx.tenant.id, deal.pipelineId);
        if (!pipeline || pipeline.archivedAt) {
          throw new AppError(
            'conflict',
            'This deal’s pipeline is archived. Restore it in Settings → Pipelines first.',
          );
        }
        const stages = await tx
          .select({ id: crmStages.id, stageArchived: crmStages.archivedAt })
          .from(crmStages)
          .where(
            and(eq(crmStages.tenantId, ctx.tenant.id), eq(crmStages.pipelineId, deal.pipelineId)),
          )
          .orderBy(asc(crmStages.position), asc(crmStages.id));
        const current = stages.find((st) => st.id === deal.stageId);
        const stageId =
          current && !current.stageArchived
            ? deal.stageId
            : stages.find((st) => !st.stageArchived)?.id;
        if (!stageId) throw new AppError('conflict', 'This deal’s pipeline has no stages.');
        const now = clock.now();
        const version = deal.version + 1;
        await tx
          .update(crmDeals)
          .set({
            status: 'open',
            stageId,
            ...(stageId !== deal.stageId ? { stageEnteredAt: now } : {}),
            closedAt: null,
            closedByMembershipId: null,
            lostReason: null,
            version,
          })
          .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, deal.id)));
        await addActivity(tx, {
          tenantId: ctx.tenant.id,
          contactId: deal.contactId,
          dealId: deal.id,
          actorMembershipId: ctx.membership.id,
          kind: 'deal_reopened',
          at: now,
        });
        if (stageId !== deal.stageId) {
          await addActivity(tx, {
            tenantId: ctx.tenant.id,
            contactId: deal.contactId,
            dealId: deal.id,
            actorMembershipId: ctx.membership.id,
            kind: 'stage_changed',
            data: { fromStageId: deal.stageId, toStageId: stageId },
            at: now,
          });
        }
        return { version };
      });
    },

    /** A note on a contact's timeline, or on one of its deals. Notes are kept like the timeline. */
    async addNote(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'crm.write');
      const data = parseInput(noteSchema, input);
      return db.run(ctx.scope, async (tx) => {
        let contactId = data.contactId;
        if (data.dealId) {
          const [deal] = await tx
            .select({ contactId: crmDeals.contactId })
            .from(crmDeals)
            .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, data.dealId)));
          if (!deal) throw notFound('Deal');
          if (contactId && contactId !== deal.contactId) {
            throw new AppError('validation_failed', 'The deal belongs to another contact.');
          }
          contactId = deal.contactId;
        }
        if (!contactId) throw new AppError('validation_failed', 'Choose a contact or a deal.');
        await assertLiveContact(tx, ctx.tenant.id, contactId);
        const id = await addActivity(tx, {
          tenantId: ctx.tenant.id,
          contactId,
          dealId: data.dealId,
          actorMembershipId: ctx.membership.id,
          kind: 'note',
          body: data.body,
          at: clock.now(),
        });
        return { id };
      });
    },
  };
}
