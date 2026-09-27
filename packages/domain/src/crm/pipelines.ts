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
}

export interface PipelineSummary {
  id: string;
  name: string;
  currency: string;
  position: number;
  archived: boolean;
  version: number;
  /** Stages in board order; archived stages last. */
  stages: StageSummary[];
}

const stageNames = z
  .array(trimmed(40, 'a stage name'))
  .min(1, 'Add at least one stage.')
  .max(CRM_LIMITS.stages, `A pipeline has at most ${CRM_LIMITS.stages} stages.`);

const createSchema = z.object({
  name: trimmed(60, 'a pipeline name'),
  currency: z.string().trim().toUpperCase().refine(isCurrency, 'Choose a currency.'),
  stages: stageNames,
});

const updateSchema = z.object({
  id: uuidSchema,
  expectedVersion: z.number().int().min(1),
  name: trimmed(60, 'a pipeline name'),
  stages: z
    .array(z.object({ id: uuidSchema.nullable(), name: trimmed(40, 'a stage name') }))
    .min(1, 'Add at least one stage.')
    .max(CRM_LIMITS.stages, `A pipeline has at most ${CRM_LIMITS.stages} stages.`),
});

const versionSchema = z.object({ id: uuidSchema, expectedVersion: z.number().int().min(1) });

function assertDistinct(names: readonly string[]) {
  const seen = new Set<string>();
  for (const n of names) {
    const key = n.toLocaleLowerCase('en');
    if (seen.has(key)) throw new AppError('validation_failed', `Two stages are named “${n}”.`);
    seen.add(key);
  }
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
      openDeals: sql<number>`(select count(*)::int from app.crm_deals d
        where d.tenant_id = ${crmStages.tenantId} and d.stage_id = ${crmStages.id} and d.status = 'open')`,
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
    stages: stages
      .filter((s) => s.pipelineId === p.id)
      .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null))
      .map((s) => ({
        id: s.id,
        name: s.name,
        position: s.position,
        archived: s.archivedAt !== null,
        openDeals: s.openDeals,
      })),
  }));
}

async function lockPipeline(tx: Tx, tenantId: string, id: string, expectedVersion: number) {
  const [row] = await tx
    .select()
    .from(crmPipelines)
    .where(and(eq(crmPipelines.tenantId, tenantId), eq(crmPipelines.id, id)))
    .for('update');
  if (!row) throw notFound('Pipeline');
  if (row.version !== expectedVersion) throw versionConflict();
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
      const data = parseInput(createSchema, input);
      assertDistinct(data.stages);
      try {
        return await db.run(ctx.scope, async (tx) => {
          const active = await lockPipelineCount(tx, ctx.tenant.id);
          if (active >= CRM_LIMITS.pipelines) {
            throw new AppError(
              'conflict',
              `A company can use at most ${CRM_LIMITS.pipelines} pipelines. Archive one first.`,
            );
          }
          const id = uuidv7();
          await tx.insert(crmPipelines).values({
            id,
            tenantId: ctx.tenant.id,
            name: data.name,
            currency: data.currency,
            position: active,
            createdByMembershipId: ctx.membership.id,
          });
          await tx.insert(crmStages).values(
            data.stages.map((name, position) => ({
              id: uuidv7(),
              tenantId: ctx.tenant.id,
              pipelineId: id,
              name,
              position,
            })),
          );
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
        if (isUniqueViolation(error, 'crm_pipelines_name_uq')) {
          throw new AppError('conflict', 'Another pipeline already has this name.');
        }
        throw error;
      }
    },

    /**
     * Renames the pipeline and sets its stages in order: stages listed with an id keep their deals,
     * new stages have no id, and stages left out are archived (only when no open deal is in them).
     */
    async updatePipeline(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(updateSchema, input);
      assertDistinct(data.stages.map((s) => s.name));
      try {
        return await db.run(ctx.scope, async (tx) => {
          const pipeline = await lockPipeline(tx, ctx.tenant.id, data.id, data.expectedVersion);
          if (pipeline.archivedAt) throw new AppError('conflict', 'Restore the pipeline first.');
          const existing = await tx
            .select({ id: crmStages.id, name: crmStages.name, archivedAt: crmStages.archivedAt })
            .from(crmStages)
            .where(and(eq(crmStages.tenantId, ctx.tenant.id), eq(crmStages.pipelineId, data.id)));
          const byId = new Map(existing.map((s) => [s.id, s]));
          const kept = new Set<string>();
          for (const s of data.stages) {
            if (s.id === null) continue;
            const current = byId.get(s.id);
            if (!current || current.archivedAt) {
              throw new AppError(
                'validation_failed',
                `The stage “${s.name}” is not in this pipeline.`,
              );
            }
            kept.add(s.id);
          }
          const now = clock.now();
          const removed = existing.filter((s) => !s.archivedAt && !kept.has(s.id));
          for (const s of removed) {
            const [open] = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(crmDeals)
              .where(
                and(
                  eq(crmDeals.tenantId, ctx.tenant.id),
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
              .where(and(eq(crmStages.tenantId, ctx.tenant.id), eq(crmStages.id, s.id)));
          }
          let position = 0;
          for (const s of data.stages) {
            if (s.id === null) {
              await tx.insert(crmStages).values({
                id: uuidv7(),
                tenantId: ctx.tenant.id,
                pipelineId: data.id,
                name: s.name,
                position,
              });
            } else {
              await tx
                .update(crmStages)
                .set({ name: s.name, position })
                .where(and(eq(crmStages.tenantId, ctx.tenant.id), eq(crmStages.id, s.id)));
            }
            position += 1;
          }
          const version = pipeline.version + 1;
          await tx
            .update(crmPipelines)
            .set({ name: data.name, version })
            .where(and(eq(crmPipelines.tenantId, ctx.tenant.id), eq(crmPipelines.id, data.id)));
          await recordAudit(
            tx,
            ctx,
            {
              action: 'crm.pipeline_updated',
              subjectType: 'crm_pipeline',
              subjectId: data.id,
              metadata: {
                stages: data.stages.length,
                added: data.stages.filter((s) => s.id === null).length,
                removed: removed.length,
              },
            },
            meta,
          );
          return { version };
        });
      } catch (error) {
        if (isUniqueViolation(error, 'crm_pipelines_name_uq')) {
          throw new AppError('conflict', 'Another pipeline already has this name.');
        }
        throw error;
      }
    },

    /** Archives a pipeline without open deals; its closed deals stay in reports. */
    async archivePipeline(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(versionSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const pipeline = await lockPipeline(tx, ctx.tenant.id, data.id, data.expectedVersion);
        if (pipeline.archivedAt) return { version: pipeline.version };
        const [open] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(crmDeals)
          .where(
            and(
              eq(crmDeals.tenantId, ctx.tenant.id),
              eq(crmDeals.pipelineId, data.id),
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
          .set({ archivedAt: clock.now(), version })
          .where(and(eq(crmPipelines.tenantId, ctx.tenant.id), eq(crmPipelines.id, data.id)));
        await recordAudit(
          tx,
          ctx,
          { action: 'crm.pipeline_archived', subjectType: 'crm_pipeline', subjectId: data.id },
          meta,
        );
        return { version };
      });
    },

    async restorePipeline(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(versionSchema, input);
      try {
        return await db.run(ctx.scope, async (tx) => {
          const active = await lockPipelineCount(tx, ctx.tenant.id);
          const pipeline = await lockPipeline(tx, ctx.tenant.id, data.id, data.expectedVersion);
          if (!pipeline.archivedAt) return { version: pipeline.version };
          if (active >= CRM_LIMITS.pipelines) {
            throw new AppError(
              'conflict',
              `A company can use at most ${CRM_LIMITS.pipelines} pipelines. Archive one first.`,
            );
          }
          const version = pipeline.version + 1;
          await tx
            .update(crmPipelines)
            .set({ archivedAt: null, version })
            .where(and(eq(crmPipelines.tenantId, ctx.tenant.id), eq(crmPipelines.id, data.id)));
          await recordAudit(
            tx,
            ctx,
            { action: 'crm.pipeline_restored', subjectType: 'crm_pipeline', subjectId: data.id },
            meta,
          );
          return { version };
        });
      } catch (error) {
        if (isUniqueViolation(error, 'crm_pipelines_name_uq')) {
          throw new AppError('conflict', 'Another pipeline already has this name.');
        }
        throw error;
      }
    },
  };
}
