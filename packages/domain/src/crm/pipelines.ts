import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  crmDeals,
  crmPipelines,
  crmStages,
  eq,
  isNull,
  isUniqueViolation,
  outerColumn,
  sql,
  type Database,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { parseInput } from '../validation';
import { CRM_LIMITS, trimmed, uuidSchema, versionConflict } from './common';
import { isCurrency } from './money';

export interface StageSummary {
  id: string;
  name: string;
  position: number;
  archived: boolean;
  openDeals: number;
  /** The chance, in whole percent, that the stage's open deals are won (ADR-242); null: not set. */
  winPercent: number | null;
}

export interface PipelineSummary {
  id: string;
  name: string;
  currency: string;
  position: number;
  archived: boolean;
  version: number;
  /** Added by a key through the API (ADR-286) rather than by a member. */
  addedThroughApi: boolean;
  /** Stages in board order; archived stages last. */
  stages: StageSummary[];
}

/** A stage's chance of winning its open deals (ADR-242): a whole percentage, or null for none. */
export const winPercentSchema = z
  .number('Enter the chance as a whole percentage.')
  .int('Enter the chance as a whole percentage.')
  .min(0, 'A chance is between 0 and 100%.')
  .max(100, 'A chance is between 0 and 100%.')
  .nullable();

/** A new pipeline's stage: its name, or its name and chance of winning. */
export const newStageSchema = z.union([
  trimmed(40, 'a stage name').transform((name) => ({ name, winPercent: null })),
  z.object({ name: trimmed(40, 'a stage name'), winPercent: winPercentSchema.default(null) }),
]);

export const createPipelineSchema = z.object({
  name: trimmed(60, 'a pipeline name'),
  currency: z.string().trim().toUpperCase().refine(isCurrency, 'Choose a currency.'),
  stages: z
    .array(newStageSchema)
    .min(1, 'Add at least one stage.')
    .max(CRM_LIMITS.stages, `A pipeline has at most ${CRM_LIMITS.stages} stages.`),
});

export const updatePipelineSchema = z.object({
  id: uuidSchema,
  expectedVersion: z.number().int().min(1),
  name: trimmed(60, 'a pipeline name'),
  stages: z
    .array(
      z.object({
        id: uuidSchema.nullable(),
        name: trimmed(40, 'a stage name'),
        /** Absent: a kept stage keeps its chance, a new one has none. */
        winPercent: winPercentSchema.optional(),
      }),
    )
    .min(1, 'Add at least one stage.')
    .max(CRM_LIMITS.stages, `A pipeline has at most ${CRM_LIMITS.stages} stages.`),
});

const versionSchema = z.object({ id: uuidSchema, expectedVersion: z.number().int().min(1) });

/** A new pipeline as Settings and `POST /pipelines` give it. */
export type NewPipeline = z.infer<typeof createPipelineSchema>;

/** Who adds a pipeline: a member in Settings, or a key through the API (ADR-286). */
export type PipelineCreator = { membershipId: string } | { apiKeyId: string };

/**
 * The version a change expects: a pipeline at another version is refused with `stale`'s error, or
 * the one members see in Settings.
 */
export interface ExpectedVersion {
  version: number;
  stale?: (current: number) => AppError;
}

/**
 * A change of a pipeline's name and stages, as Settings and `PATCH /pipelines/{id}` give it: the
 * stages in board order, those with an id kept with their deals, new ones without one, and the
 * active stages left out archived (only when no open deal is in them). Without `name` the name
 * stays; without `stages` the stages stay as they are (the API only; Settings gives both).
 */
export interface PipelineChange {
  id: string;
  expected?: ExpectedVersion;
  name?: string;
  stages?: readonly { id: string | null; name: string; winPercent?: number | null }[];
}

export interface PipelineUpdate {
  version: number;
  /** False only when the caller asked to keep an unchanged pipeline as it is. */
  changed: boolean;
  /** The active stages after the change. */
  stages: number;
  /** Stages the change added, and stages it archived. */
  added: number;
  removed: number;
}

function assertDistinct(names: readonly string[]) {
  const seen = new Set<string>();
  for (const n of names) {
    const key = n.toLocaleLowerCase('en');
    if (seen.has(key)) throw new AppError('validation_failed', `Two stages are named “${n}”.`);
    seen.add(key);
  }
}

function pipelineLimitReached(): AppError {
  return new AppError(
    'conflict',
    `A company can use at most ${CRM_LIMITS.pipelines} pipelines. Archive one first.`,
  );
}

/** A pipeline name another active pipeline has, as a conflict; any other error as it is. */
export function pipelineNameError(error: unknown): unknown {
  return isUniqueViolation(error, 'crm_pipelines_name_uq')
    ? new AppError('conflict', 'Another pipeline already has this name.')
    : error;
}

/** Pipelines of the company with their stages and open-deal counts. */
export async function loadPipelines(
  tx: Tx,
  tenantId: string,
  options: { includeArchived: boolean },
): Promise<PipelineSummary[]> {
  const pipelines = await tx
    .select()
    .from(crmPipelines)
    .where(
      and(
        eq(crmPipelines.tenantId, tenantId),
        options.includeArchived ? undefined : isNull(crmPipelines.archivedAt),
      ),
    )
    .orderBy(asc(crmPipelines.position), asc(sql`lower(${crmPipelines.name})`));
  if (pipelines.length === 0) return [];
  const stages = await tx
    .select({
      id: crmStages.id,
      pipelineId: crmStages.pipelineId,
      name: crmStages.name,
      position: crmStages.position,
      archivedAt: crmStages.archivedAt,
      winPercent: crmStages.winPercent,
      openDeals: sql<number>`(select count(*)::int from app.crm_deals d
        where d.tenant_id = ${outerColumn(crmStages.tenantId)}
          and d.stage_id = ${outerColumn(crmStages.id)} and d.status = 'open')`,
    })
    .from(crmStages)
    .where(eq(crmStages.tenantId, tenantId))
    .orderBy(asc(crmStages.position), asc(crmStages.createdAt));
  return pipelines.map((p) => ({
    id: p.id,
    name: p.name,
    currency: p.currency,
    position: p.position,
    archived: p.archivedAt !== null,
    version: p.version,
    addedThroughApi: p.createdByApiKeyId !== null,
    stages: stages
      .filter((s) => s.pipelineId === p.id)
      .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null))
      .map((s) => ({
        id: s.id,
        name: s.name,
        position: s.position,
        archived: s.archivedAt !== null,
        openDeals: s.openDeals,
        winPercent: s.winPercent,
      })),
  }));
}

async function lockPipeline(tx: Tx, tenantId: string, id: string, expected?: ExpectedVersion) {
  const [row] = await tx
    .select()
    .from(crmPipelines)
    .where(and(eq(crmPipelines.tenantId, tenantId), eq(crmPipelines.id, id)))
    .for('update');
  if (!row) throw notFound('Pipeline');
  if (expected && row.version !== expected.version) {
    throw expected.stale ? expected.stale(row.version) : versionConflict();
  }
  return row;
}

/** Serialises pipeline creation and restores in a company (the limit counts active pipelines). */
async function lockPipelineCount(tx: Tx, tenantId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}|crm_pipelines`}, 0))`,
  );
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(crmPipelines)
    .where(and(eq(crmPipelines.tenantId, tenantId), isNull(crmPipelines.archivedAt)));
  return row?.n ?? 0;
}

/**
 * Adds a pipeline with its stages (Settings, and keys since ADR-286): at most
 * `CRM_LIMITS.pipelines` active ones, placed last. The caller audits it, and maps a name in use
 * with `pipelineNameError`.
 */
export async function writeCreatePipeline(
  tx: Tx,
  tenantId: string,
  data: NewPipeline,
  by: PipelineCreator,
): Promise<string> {
  assertDistinct(data.stages.map((s) => s.name));
  const active = await lockPipelineCount(tx, tenantId);
  if (active >= CRM_LIMITS.pipelines) throw pipelineLimitReached();
  const id = uuidv7();
  await tx.insert(crmPipelines).values({
    id,
    tenantId,
    name: data.name,
    currency: data.currency,
    position: active,
    createdByMembershipId: 'membershipId' in by ? by.membershipId : null,
    createdByApiKeyId: 'apiKeyId' in by ? by.apiKeyId : null,
  });
  await tx.insert(crmStages).values(
    data.stages.map((stage, position) => ({
      id: uuidv7(),
      tenantId,
      pipelineId: id,
      name: stage.name,
      winPercent: stage.winPercent,
      position,
    })),
  );
  return id;
}

/** Whether `stages` would leave the active stages as they are: same order, names and chances. */
function sameStages(
  active: readonly { id: string; name: string; winPercent: number | null }[],
  stages: NonNullable<PipelineChange['stages']>,
): boolean {
  return (
    active.length === stages.length &&
    stages.every((s, i) => {
      const current = active[i];
      return (
        current !== undefined &&
        s.id === current.id &&
        s.name === current.name &&
        (s.winPercent === undefined || s.winPercent === current.winPercent)
      );
    })
  );
}

/**
 * Renames a pipeline and sets its stages (`PipelineChange`); an archived pipeline is refused until
 * it is restored. With `keepUnchanged`, a change that would leave the pipeline as it is writes
 * nothing and keeps its version; otherwise every change moves the version on, as Settings always
 * has. The caller audits it, and maps a name in use with `pipelineNameError`.
 */
export async function writeUpdatePipeline(
  tx: Tx,
  tenantId: string,
  change: PipelineChange,
  now: Date,
  options: { keepUnchanged?: boolean } = {},
): Promise<PipelineUpdate> {
  const given = change.stages;
  if (given) {
    assertDistinct(given.map((s) => s.name));
    const ids = given.flatMap((s) => (s.id === null ? [] : [s.id]));
    if (new Set(ids).size !== ids.length) {
      throw new AppError('validation_failed', 'A stage is listed twice.');
    }
  }
  const pipeline = await lockPipeline(tx, tenantId, change.id, change.expected);
  if (pipeline.archivedAt) throw new AppError('conflict', 'Restore the pipeline first.');
  const existing = await tx
    .select({
      id: crmStages.id,
      name: crmStages.name,
      position: crmStages.position,
      archivedAt: crmStages.archivedAt,
      winPercent: crmStages.winPercent,
    })
    .from(crmStages)
    .where(and(eq(crmStages.tenantId, tenantId), eq(crmStages.pipelineId, change.id)));
  const active = existing.filter((s) => !s.archivedAt).sort((a, b) => a.position - b.position);
  const byId = new Map(existing.map((s) => [s.id, s]));
  for (const s of given ?? []) {
    if (s.id === null) continue;
    const current = byId.get(s.id);
    if (!current || current.archivedAt) {
      throw new AppError('validation_failed', `The stage “${s.name}” is not in this pipeline.`);
    }
  }
  const name = change.name ?? pipeline.name;
  if (
    options.keepUnchanged &&
    name === pipeline.name &&
    (given === undefined || sameStages(active, given))
  ) {
    return {
      version: pipeline.version,
      changed: false,
      stages: active.length,
      added: 0,
      removed: 0,
    };
  }
  const kept = new Set((given ?? []).flatMap((s) => (s.id === null ? [] : [s.id])));
  const removed = given ? active.filter((s) => !kept.has(s.id)) : [];
  for (const s of removed) {
    const [open] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(crmDeals)
      .where(
        and(
          eq(crmDeals.tenantId, tenantId),
          eq(crmDeals.stageId, s.id),
          eq(crmDeals.status, 'open'),
        ),
      );
    if ((open?.n ?? 0) > 0) {
      throw new AppError(
        'conflict',
        `Move the ${open?.n} open deal${open?.n === 1 ? '' : 's'} out of “${s.name}” before removing it.`,
      );
    }
    await tx
      .update(crmStages)
      .set({ archivedAt: now })
      .where(and(eq(crmStages.tenantId, tenantId), eq(crmStages.id, s.id)));
  }
  let position = 0;
  for (const s of given ?? []) {
    if (s.id === null) {
      await tx.insert(crmStages).values({
        id: uuidv7(),
        tenantId,
        pipelineId: change.id,
        name: s.name,
        winPercent: s.winPercent ?? null,
        position,
      });
    } else {
      await tx
        .update(crmStages)
        .set({
          name: s.name,
          position,
          ...(s.winPercent !== undefined ? { winPercent: s.winPercent } : {}),
        })
        .where(and(eq(crmStages.tenantId, tenantId), eq(crmStages.id, s.id)));
    }
    position += 1;
  }
  const version = pipeline.version + 1;
  await tx
    .update(crmPipelines)
    .set({ name, version })
    .where(and(eq(crmPipelines.tenantId, tenantId), eq(crmPipelines.id, change.id)));
  return {
    version,
    changed: true,
    stages: given ? given.length : active.length,
    added: (given ?? []).filter((s) => s.id === null).length,
    removed: removed.length,
  };
}

/**
 * Archives a pipeline without open deals; its closed deals stay in reports. One already archived
 * is left as it is (`changed` false). The caller audits a change.
 */
export async function writeArchivePipeline(
  tx: Tx,
  tenantId: string,
  id: string,
  expected: ExpectedVersion | undefined,
  now: Date,
): Promise<{ version: number; changed: boolean }> {
  const pipeline = await lockPipeline(tx, tenantId, id, expected);
  if (pipeline.archivedAt) return { version: pipeline.version, changed: false };
  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(crmDeals)
    .where(
      and(
        eq(crmDeals.tenantId, tenantId),
        eq(crmDeals.pipelineId, id),
        eq(crmDeals.status, 'open'),
      ),
    );
  if ((open?.n ?? 0) > 0) {
    throw new AppError(
      'conflict',
      `Close or move the ${open?.n} open deal${open?.n === 1 ? '' : 's'} in this pipeline first.`,
    );
  }
  const version = pipeline.version + 1;
  await tx
    .update(crmPipelines)
    .set({ archivedAt: now, version })
    .where(and(eq(crmPipelines.tenantId, tenantId), eq(crmPipelines.id, id)));
  return { version, changed: true };
}

/**
 * Restores an archived pipeline, within `CRM_LIMITS.pipelines` active ones. One not archived is
 * left as it is (`changed` false). The caller audits a change, and maps a name another active
 * pipeline took meanwhile with `pipelineNameError`.
 */
export async function writeRestorePipeline(
  tx: Tx,
  tenantId: string,
  id: string,
  expected: ExpectedVersion | undefined,
): Promise<{ version: number; changed: boolean }> {
  const active = await lockPipelineCount(tx, tenantId);
  const pipeline = await lockPipeline(tx, tenantId, id, expected);
  if (!pipeline.archivedAt) return { version: pipeline.version, changed: false };
  if (active >= CRM_LIMITS.pipelines) throw pipelineLimitReached();
  const version = pipeline.version + 1;
  await tx
    .update(crmPipelines)
    .set({ archivedAt: null, version })
    .where(and(eq(crmPipelines.tenantId, tenantId), eq(crmPipelines.id, id)));
  return { version, changed: true };
}

export function pipelineOperations(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;
  return {
    async listPipelines(ctx: TenantContext, options: { includeArchived?: boolean } = {}) {
      assertCan(ctx, 'crm.read');
      return db.run(
        ctx.scope,
        (tx) =>
          loadPipelines(tx, ctx.tenant.id, { includeArchived: options.includeArchived ?? false }),
        { accessMode: 'read only' },
      );
    },

    /** Pipelines and stages are company settings. */
    async createPipeline(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(createPipelineSchema, input);
      try {
        return await db.run(ctx.scope, async (tx) => {
          const id = await writeCreatePipeline(tx, ctx.tenant.id, data, {
            membershipId: ctx.membership.id,
          });
          await recordAudit(
            tx,
            ctx,
            {
              action: 'crm.pipeline_created',
              subjectType: 'crm_pipeline',
              subjectId: id,
              metadata: { currency: data.currency, stages: data.stages.length },
            },
            meta,
          );
          return { id };
        });
      } catch (error) {
        throw pipelineNameError(error);
      }
    },

    /**
     * Renames the pipeline and sets its stages in order: stages listed with an id keep their deals,
     * new stages have no id, and stages left out are archived (only when no open deal is in them).
     */
    async updatePipeline(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(updatePipelineSchema, input);
      try {
        return await db.run(ctx.scope, async (tx) => {
          const update = await writeUpdatePipeline(
            tx,
            ctx.tenant.id,
            {
              id: data.id,
              expected: { version: data.expectedVersion },
              name: data.name,
              stages: data.stages,
            },
            clock.now(),
          );
          await recordAudit(
            tx,
            ctx,
            {
              action: 'crm.pipeline_updated',
              subjectType: 'crm_pipeline',
              subjectId: data.id,
              metadata: { stages: update.stages, added: update.added, removed: update.removed },
            },
            meta,
          );
          return { version: update.version };
        });
      } catch (error) {
        throw pipelineNameError(error);
      }
    },

    /** Archives a pipeline without open deals; its closed deals stay in reports. */
    async archivePipeline(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(versionSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const result = await writeArchivePipeline(
          tx,
          ctx.tenant.id,
          data.id,
          { version: data.expectedVersion },
          clock.now(),
        );
        if (result.changed) {
          await recordAudit(
            tx,
            ctx,
            { action: 'crm.pipeline_archived', subjectType: 'crm_pipeline', subjectId: data.id },
            meta,
          );
        }
        return { version: result.version };
      });
    },

    async restorePipeline(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(versionSchema, input);
      try {
        return await db.run(ctx.scope, async (tx) => {
          const result = await writeRestorePipeline(tx, ctx.tenant.id, data.id, {
            version: data.expectedVersion,
          });
          if (result.changed) {
            await recordAudit(
              tx,
              ctx,
              { action: 'crm.pipeline_restored', subjectType: 'crm_pipeline', subjectId: data.id },
              meta,
            );
          }
          return { version: result.version };
        });
      } catch (error) {
        throw pipelineNameError(error);
      }
    },
  };
}
