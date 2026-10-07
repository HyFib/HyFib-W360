import { z } from 'zod';
import { AppError, notFound } from '@w360/core';
import { recordSystemAudit } from '../audit';
import { CRM_LIMITS, trimmed } from '../crm/common';
import { isCurrency } from '../crm/money';
import {
  pipelineNameError,
  winPercentSchema,
  writeArchivePipeline,
  writeCreatePipeline,
  writeRestorePipeline,
  writeUpdatePipeline,
  type ExpectedVersion,
} from '../crm/pipelines';
import type { OutboundDeps } from '../messaging/outbound';
import { parseInput } from '../validation';
import { apiActor, assertScope, type ApiContext } from './context';
import { assertCrmInPlan, readApiPipeline } from './deals';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';

/**
 * Managing CRM pipelines through the public API (ADR-286), with `pipelines.manage`: adding them with
 * their stages, renaming them, changing their stages and chances, and archiving and restoring them,
 * through the writes Settings → Pipelines uses, so the same limits and checks hold, audited as done
 * by the key. Pipelines are never deleted, here or in the app.
 */

const pipelineNameSchema = trimmed(60, 'a pipeline name');
const stageNameSchema = trimmed(40, 'a stage name');
const stagesSchema = <T extends z.ZodType>(stage: T) =>
  z
    .array(stage)
    .min(1, 'Add at least one stage.')
    .max(CRM_LIMITS.stages, `A pipeline has at most ${CRM_LIMITS.stages} stages.`);

const chanceSchema = winPercentSchema.describe(
  'The chance, in whole percent, that the stage’s open deals are won, which the board and Reports weigh them by; null for none.',
);

/** What `POST /pipelines` takes: a pipeline as members add one in Settings. */
export const apiCreatePipelineSchema = z
  .object({
    name: pipelineNameSchema.describe(
      'Unique, ignoring case, among the company’s active pipelines; up to 60 characters.',
    ),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isCurrency, 'Choose a currency.')
      .describe(
        'ISO 4217, like INR: the currency of every deal’s value in the pipeline. It never changes.',
      ),
    stages: stagesSchema(
      z.object({ name: stageNameSchema, winPercent: chanceSchema.optional() }).strict(),
    ).describe(
      'The stages in board order, from the left, with names unique in the pipeline ignoring case (up to 40 characters); won and lost are outcomes, not stages.',
    ),
  })
  .strict();

/**
 * What `PATCH /pipelines/{id}` takes: a new name, the stages as they should be, or archiving or
 * restoring the pipeline (on its own), from the version expected when one is given.
 */
export const apiUpdatePipelineSchema = z
  .object({
    name: pipelineNameSchema
      .optional()
      .describe('Unique, ignoring case, among the company’s active pipelines.'),
    stages: stagesSchema(
      z
        .object({
          id: z
            .uuid()
            .optional()
            .describe(
              'An active stage of the pipeline to keep, with its deals; none for a new one.',
            ),
          name: stageNameSchema,
          winPercent: chanceSchema
            .optional()
            .describe(
              'The chance, in whole percent, that the stage’s open deals are won; null for none. Left out, a kept stage keeps its chance and a new one has none.',
            ),
        })
        .strict(),
    )
      .optional()
      .describe(
        'All the pipeline’s stages, in board order: a stage with an `id` is kept (renamed, moved or given another chance), a stage without one is added, and an active stage left out is removed from the board (archived), which needs it to hold no open deals. Names are unique in the pipeline, ignoring case.',
      ),
    archived: z
      .boolean()
      .optional()
      .describe(
        '`true` archives the pipeline, which needs it to hold no open deals; `false` restores it, within the company’s limit of active pipelines.',
      ),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Change the pipeline only at this `version`: one changed since is refused with 409 (read it again).',
      ),
  })
  .strict()
  .refine(
    (change) =>
      change.name !== undefined || change.stages !== undefined || change.archived !== undefined,
    { message: 'Give at least one change: `name`, `stages` or `archived`.' },
  )
  .refine(
    (change) =>
      change.archived === undefined || (change.name === undefined && change.stages === undefined),
    {
      message:
        'Archive or restore a pipeline on its own, and rename it or change its stages in another request.',
      path: ['archived'],
    },
  );

/** The version a request expects, refused with the API's wording when the pipeline moved on. */
function expectedVersion(version: number | undefined): ExpectedVersion | undefined {
  if (version === undefined) return undefined;
  return {
    version,
    stale: (current) =>
      new AppError(
        'conflict',
        `The pipeline changed since version ${version}; its version is ${current}. Read it again.`,
      ),
  };
}

/** The pipeline as the API gives it, after a write in the same transaction. */
async function readWritten(
  tx: Parameters<typeof readApiPipeline>[0],
  tenantId: string,
  id: string,
) {
  const pipeline = await readApiPipeline(tx, tenantId, id);
  if (!pipeline) throw notFound('Pipeline');
  return pipeline;
}

/**
 * Adds a pipeline with its stages, placed after the company's other pipelines, as members add one
 * in Settings, and answers it as `GET /pipelines` gives it. Once per `Idempotency-Key` when one is
 * given.
 */
export async function apiCreatePipeline(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'pipelines.manage');
  const data = parseInput(apiCreatePipelineSchema, input);
  const now = deps.clock.now();
  try {
    return await deps.db.run(ctx.scope, async (tx) => {
      // Claimed in the pipeline's transaction, so a refused pipeline leaves the key unused.
      let claimed: string | null = null;
      if (idempotency) {
        const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
        if ('replay' in claim) return claim.replay;
        claimed = claim.claimed;
      }
      await assertCrmInPlan(tx, ctx.tenant.id);
      const stages = data.stages.map((s) => ({ name: s.name, winPercent: s.winPercent ?? null }));
      const id = await writeCreatePipeline(
        tx,
        ctx.tenant.id,
        { name: data.name, currency: data.currency, stages },
        { apiKeyId: ctx.key.id },
      );
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'crm.pipeline_created',
          subjectType: 'crm_pipeline',
          subjectId: id,
          correlationId: ctx.requestId,
          metadata: { currency: data.currency, stages: stages.length, source: 'api' },
        },
        apiActor(ctx),
      );
      const response = { status: 201, body: { data: await readWritten(tx, ctx.tenant.id, id) } };
      if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
      return { ...response, replayed: false };
    });
  } catch (error) {
    throw pipelineNameError(error);
  }
}

/**
 * Renames a pipeline, sets its stages, or archives or restores it, as members do in Settings, and
 * answers it as `GET /pipelines` gives it. A change that would leave the pipeline as it is (the same
 * name and stages, archiving an archived pipeline, restoring an active one) answers it as it is,
 * with no new version or audit entry. Once per `Idempotency-Key` when one is given.
 */
export async function apiUpdatePipeline(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  id: string,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'pipelines.manage');
  if (!z.uuid().safeParse(id).success) throw notFound('Pipeline');
  const data = parseInput(apiUpdatePipelineSchema, input);
  const now = deps.clock.now();
  const expected = expectedVersion(data.expectedVersion);
  try {
    return await deps.db.run(ctx.scope, async (tx) => {
      let claimed: string | null = null;
      if (idempotency) {
        const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
        if ('replay' in claim) return claim.replay;
        claimed = claim.claimed;
      }
      await assertCrmInPlan(tx, ctx.tenant.id);
      const audit = (action: string, metadata: Record<string, unknown>) =>
        recordSystemAudit(
          tx,
          ctx.tenant.id,
          {
            action,
            subjectType: 'crm_pipeline',
            subjectId: id,
            correlationId: ctx.requestId,
            metadata: { ...metadata, source: 'api' },
          },
          apiActor(ctx),
        );
      if (data.archived === true) {
        const result = await writeArchivePipeline(tx, ctx.tenant.id, id, expected, now);
        if (result.changed) await audit('crm.pipeline_archived', {});
      } else if (data.archived === false) {
        const result = await writeRestorePipeline(tx, ctx.tenant.id, id, expected);
        if (result.changed) await audit('crm.pipeline_restored', {});
      } else {
        const update = await writeUpdatePipeline(
          tx,
          ctx.tenant.id,
          {
            id,
            expected,
            name: data.name,
            stages: data.stages?.map((s) => ({
              id: s.id ?? null,
              name: s.name,
              winPercent: s.winPercent,
            })),
          },
          now,
          { keepUnchanged: true },
        );
        if (update.changed) {
          await audit('crm.pipeline_updated', {
            stages: update.stages,
            added: update.added,
            removed: update.removed,
          });
        }
      }
      const response = { status: 200, body: { data: await readWritten(tx, ctx.tenant.id, id) } };
      if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
      return { ...response, replayed: false };
    });
  } catch (error) {
    throw pipelineNameError(error);
  }
}
