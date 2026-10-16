import { z } from 'zod';
import { notFound } from '@w360/core';
import { CSAT_SKIP_REASONS, RATE_CATEGORIES, eq, tenants } from '@w360/db';
import {
  DEAL_FIELD_FILTER_MAX_LENGTH,
  dealFieldFilterRefusal,
  parseDealFieldFilterParam,
  requireDealFieldFilter,
  type ResolvedDealFieldFilter,
} from '../crm/deal-field-filter';
import { loadDealFields } from '../crm/deal-fields';
import type { OutboundDeps } from '../messaging/outbound';
import { PERIOD_PRESETS, periodInputSchema, resolvePeriod } from '../reports/period';
import { AUTOMATION_OUTCOMES, readReport, type Report } from '../reports/service';
import { parseInput } from '../validation';
import { assertScope, type ApiContext } from './context';
import { apiDealFieldFilterMessage, assertCrmInPlan } from './deals';
import { apiPipelineForecastSchema, toApiPipelineForecast } from './pipeline-forecast';

/**
 * The Reports page's numbers through the public API (ADR-297), read with `reports.read`: the same
 * reader, for the same period in the company's time zone and in one snapshot, so the two agree.
 * Members are named by id and name only, as `GET /members` names them; estimated Meta charges are
 * given in millionths of the currency, as the exports give them. The deals section may be filtered
 * by a choice or yes/no deal field as `GET /deals` is (ADR-396), with `deals.read` too.
 */

/** How `GET /reports` takes a filter of its deals section by a choice or yes/no field (ADR-396). */
export const API_REPORT_FIELD_FILTER_DESCRIPTION =
  'Only the deals with this value of a choice or yes/no custom deal field (GET /deal-fields) count in the `deals` section: its closed deals, win rate, time to win, open deals and forecasts. Every other section is unchanged. Written as `GET /deals` takes it: `<key>:<value>`, with one of a choice field’s options (in any case), `yes` or `no` for a yes/no field, or nothing after the colon for the deals without a value. It needs the `deals.read` scope as well and the CRM in the company’s plan, as GET /deal-fields does (403 otherwise). A key or option the company’s fields do not have, a field of another type or a value written otherwise is refused with 422 naming `field`, never ignored; so is an empty `field`, so leave the parameter out to count every deal.';

/**
 * What `GET /reports` takes: a period, as the Reports page's form chooses it, and a filter of the
 * deals section by a choice or yes/no field (ADR-396).
 */
export const apiReportQuerySchema = periodInputSchema
  .extend({
    field: z
      .string()
      .max(DEAL_FIELD_FILTER_MAX_LENGTH, apiDealFieldFilterMessage('malformed'))
      .optional()
      .describe(API_REPORT_FIELD_FILTER_DESCRIPTION),
  })
  .strict();

const count = z.number().int().min(0);
const seconds = z.number().min(0).nullable();
const day = z.string().describe('A calendar day of the company’s time zone, YYYY-MM-DD.');
const ratio = z
  .object({ numerator: count, denominator: count })
  .describe('A rate as its parts: `numerator` out of `denominator` (0 out of 0 when none).');

const messagingCounts = {
  inbound: count.describe('Messages customers sent.'),
  outbound: count.describe('Messages the company sent, whoever sent them.'),
  byMember: count.describe('Sent by members from the inbox.'),
  byCampaign: count.describe('Sent by campaigns.'),
  byOther: count.describe('Sent by automations, the API and other senders.'),
  canceled: count.describe('Canceled before they were sent.'),
  inProgress: count.describe('Not yet handed to WhatsApp.'),
  sent: count.describe('Last reported sent.'),
  delivered: count.describe('Last reported delivered.'),
  read: count.describe('Last reported read.'),
  failed: count.describe('Failed.'),
  unknown: count.describe('Handed to WhatsApp without a status reported since.'),
};

const automationCounts = {
  started: count,
  active: count.describe('Still running.'),
  completed: count,
  handed_off: count.describe('Handed to people.'),
  taken_over: count.describe('Taken over by a member.'),
  stopped: count,
  failed: count,
};

/** The company's report for a period, as `GET /reports` gives it. */
export const apiReportSchema = z.object({
  period: z.object({
    preset: z.enum([...PERIOD_PRESETS, 'custom']),
    timeZone: z.string().describe('The company’s time zone: its calendar days cut the period.'),
    from: day.describe('The first day.'),
    to: day.describe('The last day, included.'),
    start: z.iso.datetime().describe('Midnight at the start of the first day.'),
    end: z.iso.datetime().describe('Midnight after the last day (excluded).'),
    days: z.array(day),
    inProgress: z.boolean().describe('Whether the period includes today, so it is not over yet.'),
  }),
  generatedAt: z.iso.datetime().describe('When the report was read: every number is from then.'),
  messaging: z.object({
    totals: z
      .object(messagingCounts)
      .describe('Messages of the period, by when HyFib recorded them.'),
    rates: z.object({ sent: ratio, delivered: ratio, read: ratio, failure: ratio }),
    days: z.array(z.object({ day, ...messagingCounts })),
    failureCodes: z
      .array(z.object({ code: z.string(), count }))
      .describe('Failed messages by the error code Meta gave.'),
  }),
  costs: z
    .object({
      currency: z
        .string()
        .nullable()
        .describe('The company’s billing currency (Settings → Messaging); null when not chosen.'),
      rateCards: z
        .array(z.object({ id: z.uuid(), effectiveFrom: z.iso.datetime() }))
        .describe('The rate cards the estimate priced messages with.'),
      delivered: count.describe('Messages delivered in the period: the only ones Meta charges.'),
      billable: count.describe('Of them, those Meta reported billable.'),
      free: count.describe('Those Meta reported free.'),
      notReported: count.describe('Those Meta has not reported pricing for yet.'),
      priced: count.describe('Those the estimate priced.'),
      estimatedMicros: count.describe(
        'The estimate, in millionths of the currency’s main unit (1,000,000 is ₹1 for INR).',
      ),
      lines: z.array(
        z.object({
          category: z.enum(RATE_CATEGORIES),
          market: z.string(),
          messages: count,
          estimatedMicros: count,
        }),
      ),
      unpriced: z
        .object({
          noCurrency: count,
          noRateCard: count,
          otherCategory: count,
          marketUnknown: count,
          noPrice: count,
        })
        .describe('Billable messages the estimate could not price, by why.'),
    })
    .describe('Estimated Meta charges: an estimate from the published rates, not an invoice.'),
  inbox: z.object({
    targetMinutes: z
      .number()
      .int()
      .nullable()
      .describe('The company’s first-response target; null without one.'),
    teamTargets: z
      .array(
        z.object({
          teamId: z.uuid().describe('The team, as `GET /teams` names it.'),
          name: z.string(),
          targetMinutes: z.number().int().min(1),
        }),
      )
      .describe(
        'Teams with their own first-response target, by name: their conversations are measured against it instead of the company’s.',
      ),
    businessHours: z
      .boolean()
      .describe('Business hours are on: the target and business-hours times count opening hours.'),
    teamBusinessHours: z
      .array(
        z.object({
          teamId: z.uuid().describe('The team, as `GET /teams` names it.'),
          name: z.string(),
        }),
      )
      .describe(
        'While business hours are on, the teams with their own weekly schedule, by name: their conversations count business time by it instead of the company’s schedule (closed days are the team’s own when it is in `teamClosedDays`, else the company’s).',
      ),
    teamClosedDays: z
      .array(
        z.object({
          teamId: z.uuid().describe('The team, as `GET /teams` names it.'),
          name: z.string(),
        }),
      )
      .describe(
        'While business hours are on, the teams with their own closed days, by name: their conversations skip the team’s closed days instead of the company’s when counting business time.',
      ),
    now: z
      .object({
        open: count,
        unassigned: count,
        waiting: count.describe('Conversations whose customer waits for a member’s reply.'),
        oldestWaitSeconds: seconds,
        windowsClosing: count,
        windowsClosed: count,
        overTarget: count
          .nullable()
          .describe(
            'Waiting past their target (their team’s or the company’s); null when neither the company nor a team has one.',
          ),
        byAssignee: z.array(
          z.object({
            memberId: z
              .uuid()
              .nullable()
              .describe('The member, as `GET /members` names them; null for nobody.'),
            name: z.string().nullable(),
            waiting: count,
            oldestWaitSeconds: z.number().min(0),
          }),
        ),
      })
      .describe('The inbox when the report was read, whatever the period.'),
    turns: z
      .object({
        started: count,
        answered: count,
        resolvedWithoutReply: count,
        waiting: count,
        medianSeconds: seconds,
        p90Seconds: seconds,
        businessMedianSeconds: seconds.describe('Null when business hours are off.'),
        businessP90Seconds: seconds.describe('Null when business hours are off.'),
        buckets: z.object({ upTo5m: count, upTo1h: count, upTo24h: count, over24h: count }),
        withinTarget: ratio
          .nullable()
          .describe(
            'Each turn against its team’s target or the company’s; null without any target.',
          ),
      })
      .describe('Reply turns started in the period: a customer waiting for a member’s reply.'),
    resolution: z.object({ resolved: count, medianSeconds: seconds, p90Seconds: seconds }),
    days: z.array(
      z.object({
        day,
        started: count,
        answered: count,
        resolvedWithoutReply: count,
        waiting: count,
        medianSeconds: seconds,
        businessMedianSeconds: seconds,
        casesResolved: count,
        medianResolutionSeconds: seconds,
      }),
    ),
  }),
  csat: z.object({
    enabled: z.boolean().describe('Whether the company sends satisfaction surveys now.'),
    surveys: count,
    sent: count,
    skipped: z
      .object(Object.fromEntries(CSAT_SKIP_REASONS.map((r) => [r, count])))
      .describe('Surveys not sent, by why.'),
    delivered: count,
    answered: count,
    ratings: z.object({ best: count, middle: count, worst: count }),
    responseRate: ratio,
    score: ratio.describe('Best ratings out of answers.'),
    days: z.array(
      z.object({
        day,
        surveys: count,
        sent: count,
        skipped: count,
        delivered: count,
        answered: count,
        best: count,
        middle: count,
        worst: count,
      }),
    ),
  }),
  automations: z.object({
    totals: z
      .object(automationCounts)
      .describe('Runs started in the period; test runs are left out.'),
    shares: z
      .object(Object.fromEntries(AUTOMATION_OUTCOMES.map((o) => [o, ratio])))
      .describe('Each outcome’s share of the finished runs.'),
    failures: z.array(z.object({ reason: z.string(), runs: count })),
    automations: z.array(z.object({ id: z.uuid(), name: z.string(), ...automationCounts })),
    days: z.array(z.object({ day, ...automationCounts })),
  }),
  deals: z
    .object({
      won: z.array(z.object({ currency: z.string(), deals: count, valueMinor: count })),
      lost: z.array(z.object({ currency: z.string(), deals: count, valueMinor: count })),
      winRate: ratio.describe('Deals won out of deals closed in the period.'),
      medianSecondsToWin: seconds.describe('From creation to win; null when none was won.'),
      pipelines: z
        .array(
          z.object({
            id: z.uuid(),
            name: z.string(),
            currency: z.string(),
            stages: z.array(
              z.object({ id: z.uuid(), name: z.string(), deals: count, valueMinor: count }),
            ),
            forecast: apiPipelineForecastSchema.describe(
              'As `GET /pipelines/{id}/forecast` gives it, of the deals `field` matches when it is sent.',
            ),
          }),
        )
        .describe('Open deals now, by pipeline and stage.'),
      days: z
        .array(
          z.object({
            day,
            currency: z.string(),
            won: count,
            wonValueMinor: count,
            lost: count,
            lostValueMinor: count,
          }),
        )
        .describe('Closed deals by day and currency; days without any are left out.'),
      field: z
        .string()
        .nullable()
        .describe(
          'The deal field filter every figure of this section follows, as `<key>:<value>` with the option as the company writes it (`yes` or `no` for a yes/no field, nothing after the colon for the deals without a value); null when every deal is counted.',
        ),
    })
    .describe(
      'CRM deals: those closed in the period and those open now. With `field`, every figure here counts only the deals it matches.',
    ),
  members: z
    .array(
      z.object({
        memberId: z.uuid().describe('As `GET /members` names them.'),
        name: z.string(),
        replies: count,
        templates: count,
        turnsAnswered: count,
        medianSeconds: seconds,
        resolved: count,
        csatAnswered: count,
        csatBest: count,
      }),
    )
    .describe('Each member’s activity in the period, quiet members who can reply included.'),
  campaigns: z.object({
    rows: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        status: z.string(),
        startedAt: z.iso.datetime(),
        currency: z.string().nullable(),
        audience: count,
        skipped: count,
        queued: count,
        sent: count,
        delivered: count,
        read: count,
        failed: count,
        unknown: count,
        replied: count,
        optedOut: count,
        estimatedMicros: count.describe('Its estimated Meta charges, in millionths of `currency`.'),
        unpriced: count.describe('Its messages the estimate could not price.'),
      }),
    ),
    truncated: z.boolean().describe('More campaigns started in the period than are listed.'),
  }),
  definitions: z
    .array(
      z.object({
        key: z.string(),
        version: z.number().int(),
        label: z.string(),
        unit: z.enum(['count', 'rate', 'duration', 'money']),
        description: z.string(),
        numerator: z.string(),
        denominator: z.string().nullable(),
        window: z.string().nullable(),
        timezoneRule: z.string().nullable(),
        missingData: z.string(),
        available: z.boolean(),
      }),
    )
    .describe('What each number counts: the latest version of every metric definition.'),
});

export type ApiReport = z.infer<typeof apiReportSchema>;

/** The report as the API gives it: times as ISO strings, members by id and name. */
export function toApiReport(report: Report): ApiReport {
  const { period, costs, inbox, deals, campaigns } = report;
  return {
    period: {
      preset: period.preset,
      timeZone: period.timezone,
      from: period.from,
      to: period.to,
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      days: period.days,
      inProgress: period.inProgress,
    },
    generatedAt: report.generatedAt.toISOString(),
    messaging: report.messaging,
    costs: {
      currency: costs.currency,
      rateCards: costs.cards.map((c) => ({
        id: c.id,
        effectiveFrom: c.effectiveFrom.toISOString(),
      })),
      delivered: costs.delivered,
      billable: costs.billable,
      free: costs.free,
      notReported: costs.notReported,
      priced: costs.priced,
      estimatedMicros: costs.totalMicros,
      lines: costs.lines.map((l) => ({
        category: l.category,
        market: l.market,
        messages: l.count,
        estimatedMicros: l.micros,
      })),
      unpriced: costs.unpriced,
    },
    inbox: {
      ...inbox,
      teamTargets: inbox.teamTargets.map((t) => ({
        teamId: t.teamId,
        name: t.name,
        targetMinutes: t.minutes,
      })),
      now: {
        ...inbox.now,
        byAssignee: inbox.now.byAssignee.map((a) => ({
          memberId: a.membershipId,
          name: a.name,
          waiting: a.waiting,
          oldestWaitSeconds: a.oldestWaitSeconds,
        })),
      },
    },
    csat: report.csat,
    automations: report.automations,
    deals: {
      ...deals,
      // The filter's address text as resolved, never the internal record (ADR-396).
      field: deals.field ? deals.field.param : null,
      pipelines: deals.pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        currency: p.currency,
        stages: p.stages,
        forecast: toApiPipelineForecast(p, period.timezone, report.generatedAt, p.forecast),
      })),
    },
    members: report.agents.map((a) => ({
      memberId: a.membershipId,
      name: a.name,
      replies: a.replies,
      templates: a.templates,
      turnsAnswered: a.turnsAnswered,
      medianSeconds: a.medianSeconds,
      resolved: a.resolved,
      csatAnswered: a.csatAnswered,
      csatBest: a.csatBest,
    })),
    campaigns: {
      rows: campaigns.rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        currency: r.currency,
        audience: r.audience,
        skipped: r.skipped,
        queued: r.queued,
        sent: r.sent,
        delivered: r.delivered,
        read: r.read,
        failed: r.failed,
        unknown: r.unknown,
        replied: r.replied,
        optedOut: r.optedOut,
        estimatedMicros: r.estimateMicros,
        unpriced: r.estimateMissing,
      })),
      truncated: campaigns.truncated,
    },
    definitions: report.definitions.map((d) => ({
      key: d.key,
      version: d.version,
      label: d.label,
      unit: d.unit,
      description: d.description,
      numerator: d.numerator,
      denominator: d.denominator,
      window: d.window,
      timezoneRule: d.timezoneRule,
      missingData: d.missingData,
      available: d.available,
    })),
  };
}

/** Whether a query names a deal field filter at all, whatever its value. */
const asksForField = (query: unknown) =>
  typeof query === 'object' && query !== null && (query as { field?: unknown }).field !== undefined;

/**
 * The company's report for a period (`MAX_PERIOD_DAYS` at most), as the Reports page reads it: in
 * the company's time zone, in one read-only snapshot. With `field`, the deals section counts only
 * the deals a choice or yes/no field's value matches (ADR-396), read as `GET /deals` reads it: it
 * needs `deals.read` (checked before the query is read) and the CRM in the plan, as
 * `GET /deal-fields` does, since it resolves against those fields; a text written otherwise is
 * refused before the transaction, and a key or value the company's fields do not resolve within
 * it, never ignored.
 */
export async function apiGetReport(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  query: unknown,
): Promise<ApiReport> {
  assertScope(ctx, 'reports.read');
  // A filter needs deals.read, checked before anything in the query is, so a key without it learns
  // nothing from how its query would be refused.
  if (asksForField(query)) assertScope(ctx, 'deals.read');
  const input = parseInput(apiReportQuerySchema, query);
  if (input.field !== undefined && parseDealFieldFilterParam(input.field) === null) {
    throw dealFieldFilterRefusal('malformed', apiDealFieldFilterMessage);
  }
  const now = deps.clock.now();
  const report = await deps.db.run(
    ctx.scope,
    async (tx) => {
      const [company] = await tx
        .select({ timezone: tenants.timezone })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenant.id));
      if (!company) throw notFound('Company');
      const period = resolvePeriod(input, company.timezone, now);
      let dealFilter: ResolvedDealFieldFilter | null = null;
      if (input.field !== undefined) {
        await assertCrmInPlan(tx, ctx.tenant.id);
        dealFilter = requireDealFieldFilter(
          await loadDealFields(tx, ctx.tenant.id),
          input.field,
          apiDealFieldFilterMessage,
        );
      }
      return readReport(tx, ctx.tenant.id, company.timezone, period, now, dealFilter);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  return toApiReport(report);
}
