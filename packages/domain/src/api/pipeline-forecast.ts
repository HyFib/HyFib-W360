import { z } from 'zod';
import { notFound } from '@w360/core';
import { and, crmPipelines, crmStages, eq, isNull, tenants } from '@w360/db';
import {
  CLOSE_BUCKETS,
  forecastByMonth,
  forecastMonths,
  readForecastGroups,
  type CloseBucket,
  type MonthForecast,
} from '../crm/forecast';
import type { OutboundDeps } from '../messaging/outbound';
import { assertScope, type ApiContext } from './context';
import { assertCrmInPlan } from './deals';

/**
 * A CRM pipeline's weighted forecast through the public API (ADR-288), read with `deals.read`: its
 * open deals by the month they are expected to close, each stage's value weighed by its chance of
 * winning, as Reports shows it (ADR-252) and with the same reader and arithmetic, so the two agree.
 */

/** A CRM pipeline's weighted forecast (ADR-288). */
export const apiPipelineForecastSchema = z.object({
  pipelineId: z.uuid(),
  currency: z.string().describe('ISO 4217, like INR: the currency of every value.'),
  timeZone: z
    .string()
    .describe('The company’s time zone, like Asia/Kolkata: the months are its calendar months.'),
  months: z
    .array(z.string())
    .length(3)
    .describe('This month and the next two, YYYY-MM: the months of the first three buckets.'),
  asOf: z.iso.datetime().describe('When the forecast was read.'),
  hasChances: z
    .boolean()
    .describe(
      'Whether any active stage of the pipeline has a chance of winning; without one nothing is weighed and every `weightedMinor` is null.',
    ),
  buckets: z
    .array(
      z.object({
        bucket: z
          .enum(CLOSE_BUCKETS)
          .describe(
            'When the deals are expected to close: `this_month` (dates already past included, as on the board), `next_month`, `month_after`, `later`, or `undated`.',
          ),
        deals: z.number().int().min(0),
        valueMinor: z
          .number()
          .int()
          .min(0)
          .describe(
            'Their value in the currency’s minor units (paise for INR); deals without a value count 0.',
          ),
        weightedMinor: z
          .number()
          .int()
          .min(0)
          .nullable()
          .describe(
            'Each stage’s value in the bucket times its chance, rounded to the minor unit; stages without a chance add nothing. Null when no stage has a chance.',
          ),
      }),
    )
    .describe('The five buckets, always in this order: `this_month` to `undated`.'),
  dealsWithoutChance: z
    .number()
    .int()
    .min(0)
    .describe('Deals counted in the buckets but not weighed: their stage has no chance.'),
});

/** One column of the forecast: open deals expected to close in it. */
export interface ApiForecastBucket {
  /** This month (dates already past included), the next two months, later, or without a date. */
  bucket: CloseBucket;
  deals: number;
  /** Their value, in the pipeline currency's minor units (deals without a value count 0). */
  valueMinor: number;
  /**
   * Each stage's value in the bucket times its chance of winning, rounded to the minor unit;
   * stages without a chance add nothing. Null when no active stage of the pipeline has a chance.
   */
  weightedMinor: number | null;
}

/** A pipeline's weighted forecast, as `GET /pipelines/{id}/forecast` gives it. */
export interface ApiPipelineForecast {
  pipelineId: string;
  /** ISO 4217: the currency of every value. */
  currency: string;
  /** The company's time zone: the months are its calendar months. */
  timeZone: string;
  /** This month and the next two, YYYY-MM. */
  months: [string, string, string];
  /** When the forecast was read. */
  asOf: string;
  /** Whether any active stage of the pipeline has a chance; without one nothing is weighed. */
  hasChances: boolean;
  buckets: ApiForecastBucket[];
  /** Deals counted in the buckets but not weighed: their stage has no chance. */
  dealsWithoutChance: number;
}

/** The forecast as the API gives it: weighted values only where a stage has a chance. */
export function toApiPipelineForecast(
  pipeline: { id: string; currency: string },
  timeZone: string,
  asOf: Date,
  forecast: MonthForecast,
): ApiPipelineForecast {
  return {
    pipelineId: pipeline.id,
    currency: pipeline.currency,
    timeZone,
    months: forecast.months,
    asOf: asOf.toISOString(),
    hasChances: forecast.hasChances,
    buckets: forecast.buckets.map((b) => ({
      bucket: b.bucket,
      deals: b.deals,
      valueMinor: b.valueMinor,
      weightedMinor: forecast.hasChances ? b.weightedMinor : null,
    })),
    dealsWithoutChance: forecast.dealsWithoutChance,
  };
}

/**
 * The weighted forecast of one of the company's pipelines, now: its open deals in active stages by
 * expected close month in the company's time zone. An archived pipeline holds no open deals, so its
 * forecast is empty. Read in one read-only snapshot, so the deals and the stages' chances agree.
 */
export async function apiGetPipelineForecast(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  id: string,
): Promise<ApiPipelineForecast> {
  assertScope(ctx, 'deals.read');
  if (!z.uuid().safeParse(id).success) throw notFound('Pipeline');
  const now = deps.clock.now();
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      const [pipeline] = await tx
        .select({ id: crmPipelines.id, currency: crmPipelines.currency })
        .from(crmPipelines)
        .where(and(eq(crmPipelines.tenantId, ctx.tenant.id), eq(crmPipelines.id, id)));
      if (!pipeline) throw notFound('Pipeline');
      const [company] = await tx
        .select({ timezone: tenants.timezone })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenant.id));
      if (!company) throw notFound('Company');
      // Every active stage's chance, with open deals or not, as the board and Reports read them.
      const stages = await tx
        .select({ winPercent: crmStages.winPercent })
        .from(crmStages)
        .where(
          and(
            eq(crmStages.tenantId, ctx.tenant.id),
            eq(crmStages.pipelineId, id),
            isNull(crmStages.archivedAt),
          ),
        );
      const groups = await readForecastGroups(tx, ctx.tenant.id, id);
      const forecast = forecastByMonth(
        groups,
        forecastMonths(now, company.timezone),
        stages.map((s) => s.winPercent),
      );
      return toApiPipelineForecast(pipeline, company.timezone, now, forecast);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
