import { z } from 'zod';
import { SKIP_REASONS, sql, type SkipReason, type SQL, type Tx } from '@w360/db';
import { ATTRIBUTION_WINDOW_HOURS } from './attribution';
import { RECIPIENT_OUTCOME_SQL } from './outcomes';
import { VARIANT_LABELS, type VariantLabel } from './variants';

/**
 * A campaign's results as members' campaign page counts them, as `GET /campaigns/{id}` answers them
 * (ADR-125) and as campaign events carry them (ADR-150).
 */
export interface CampaignAnalytics {
  audience: number;
  pending: number;
  skipped: number;
  canceled: number;
  queued: number;
  inProgress: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  unknown: number;
  messageCanceled: number;
  replied: number;
  optedOut: number;
  estimateMicros: number;
  estimateMissing: number;
  skipReasons: { reason: SkipReason; count: number }[];
  failureCodes: { code: string; count: number }[];
}

/**
 * Counts a campaign's results in one statement, so the counts, the skip reasons and the failure
 * codes come from one snapshot whatever the caller's isolation: a webhook delivery counts them in
 * its claim, at read committed (ADR-150). Skip reasons come commonest first, failure codes are the
 * 10 commonest; ties are ordered by reason or code, a failure without a code after the codes it
 * ties with (so it is the one left out when the tenth place is tied).
 */
export async function campaignAnalytics(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  /** Only the recipients given this variant (ADR-405); every recipient when left out. */
  variant?: VariantLabel,
): Promise<CampaignAnalytics> {
  const o = RECIPIENT_OUTCOME_SQL;
  const only = (alias: SQL) => (variant ? sql` and ${alias}.variant = ${variant}` : sql``);
  const res = await tx.execute<Record<string, unknown>>(sql`
    select count(*)::int as audience,
      (count(*) filter (where ${o.pending}))::int as pending,
      (count(*) filter (where ${o.skipped}))::int as skipped,
      (count(*) filter (where ${o.canceled}))::int as canceled,
      (count(*) filter (where ${o.queued}))::int as queued,
      (count(*) filter (where ${o.in_progress}))::int as in_progress,
      (count(*) filter (where ${o.sent}))::int as sent,
      (count(*) filter (where ${o.delivered}))::int as delivered,
      (count(*) filter (where ${o.read}))::int as read,
      (count(*) filter (where ${o.failed}))::int as failed,
      (count(*) filter (where ${o.unknown}))::int as unknown,
      (count(*) filter (where ${o.message_canceled}))::int as message_canceled,
      (count(*) filter (where ${o.replied}))::int as replied,
      (count(*) filter (where ${o.opted_out}))::int as opted_out,
      coalesce(sum(r.estimated_cost_micros) filter (where r.state = 'queued'), 0)::bigint as estimate_micros,
      (count(*) filter (where r.state = 'queued' and r.estimated_cost_micros is null))::int as estimate_missing,
      (select coalesce(json_agg(json_build_object('reason', s.reason, 'count', s.count)
                                order by s.count desc, s.reason), '[]'::json)
         from (select sr.skip_reason as reason, count(*)::int as count
                 from app.campaign_recipients sr
                where sr.tenant_id = ${tenantId} and sr.campaign_id = ${campaignId}
                  and sr.state = 'skipped' and sr.skip_reason is not null${only(sql`sr`)}
                group by sr.skip_reason) s) as skip_reasons,
      (select coalesce(json_agg(json_build_object('code', coalesce(f.code, 'unknown'), 'count', f.count)
                                order by f.count desc, f.code nulls last), '[]'::json)
         from (select fm.error_code as code, count(*)::int as count
                 from app.campaign_recipients fr
                 join app.messages fm on fm.tenant_id = fr.tenant_id and fm.id = fr.message_id
                where fr.tenant_id = ${tenantId} and fr.campaign_id = ${campaignId}
                  and fm.status = 'failed'${only(sql`fr`)}
                group by fm.error_code
                order by count(*) desc, fm.error_code nulls last
                limit 10) f) as failure_codes
    from app.campaign_recipients r
    left join app.messages m on m.tenant_id = r.tenant_id and m.id = r.message_id
    where r.tenant_id = ${tenantId} and r.campaign_id = ${campaignId}${only(sql`r`)}`);
  const row = res.rows[0] ?? {};
  const n = (k: string) => Number(row[k] ?? 0);
  const listOf = <T>(k: string): T[] => {
    const value = row[k];
    if (!Array.isArray(value)) throw new Error(`The campaign's ${k} did not come back as a list.`);
    return value as T[];
  };
  return {
    audience: n('audience'),
    pending: n('pending'),
    skipped: n('skipped'),
    canceled: n('canceled'),
    queued: n('queued'),
    inProgress: n('in_progress'),
    sent: n('sent'),
    delivered: n('delivered'),
    read: n('read'),
    failed: n('failed'),
    unknown: n('unknown'),
    messageCanceled: n('message_canceled'),
    replied: n('replied'),
    optedOut: n('opted_out'),
    estimateMicros: n('estimate_micros'),
    estimateMissing: n('estimate_missing'),
    skipReasons: listOf<{ reason: SkipReason; count: number }>('skip_reasons'),
    failureCodes: listOf<{ code: string; count: number }>('failure_codes'),
  };
}

const count = (description: string) => z.number().int().describe(description);

/** The results in the API's words: `GET /campaigns/{id}` (ADR-125) and campaign events (ADR-150). */
export const campaignResultsSchema = z.object({
  audience: count('Recipients: the contacts in the audience taken when it was submitted.'),
  pending: count('Recipients not processed yet.'),
  skipped: count('Recipients skipped, with the reasons in skipReasons.'),
  canceled: count('Recipients left out because the campaign was canceled before their turn.'),
  queued: count('Recipients whose message was queued.'),
  inProgress: count('Queued messages not sent yet.'),
  sent: count('Messages WhatsApp sent (delivered and read ones included).'),
  delivered: count('Messages delivered (read ones included).'),
  read: count('Messages read (or played).'),
  failed: count('Messages that failed, with the commonest codes in failureCodes.'),
  unknown: count(
    'Messages whose sending outcome is unknown: the call to WhatsApp ended without an answer, and they are never sent again blindly.',
  ),
  messagesCanceled: count('Queued messages canceled before they were sent.'),
  replied: count(
    `Delivered recipients who replied. A reply counts once, for the last campaign message (of any campaign) sent to the contact from the same number in the ${ATTRIBUTION_WINDOW_HOURS} hours before it.`,
  ),
  optedOut: count(
    `Delivered recipients who opted out of marketing. An opt-out counts once, for the last campaign message (of any campaign) sent to the contact in the ${ATTRIBUTION_WINDOW_HOURS} hours before it.`,
  ),
  skipReasons: z
    .array(z.object({ reason: z.enum(SKIP_REASONS), count: z.number().int() }))
    .describe('Skipped recipients by reason, the commonest first, ties in alphabetical order.'),
  failureCodes: z
    .array(z.object({ code: z.string(), count: z.number().int() }))
    .describe(
      'Failed messages by WhatsApp error code (unknown when WhatsApp gave none), the 10 commonest, the commonest first, ties ordered by code as text with unknown after the codes it ties with.',
    ),
});
export type CampaignResults = z.infer<typeof campaignResultsSchema>;

/** The counted results in the API's words; never the cost estimate members see. */
export function toCampaignResults(counted: CampaignAnalytics): CampaignResults {
  return {
    audience: counted.audience,
    pending: counted.pending,
    skipped: counted.skipped,
    canceled: counted.canceled,
    queued: counted.queued,
    inProgress: counted.inProgress,
    sent: counted.sent,
    delivered: counted.delivered,
    read: counted.read,
    failed: counted.failed,
    unknown: counted.unknown,
    messagesCanceled: counted.messageCanceled,
    replied: counted.replied,
    optedOut: counted.optedOut,
    skipReasons: counted.skipReasons,
    failureCodes: counted.failureCodes,
  };
}

/** One variant's results (ADR-405), counted as the campaign's are, over its recipients only. */
export interface CampaignVariantAnalytics {
  variant: VariantLabel;
  analytics: CampaignAnalytics;
}

/**
 * Each variant's results side by side (ADR-405), in one repeatable snapshot only when the caller's
 * transaction gives one: each is `campaignAnalytics` over the recipients given that variant, so the
 * variants' counts add up to the campaign's. Descriptive counts: no winner, no significance.
 */
export async function campaignVariantAnalytics(
  tx: Tx,
  tenantId: string,
  campaignId: string,
): Promise<CampaignVariantAnalytics[]> {
  const out: CampaignVariantAnalytics[] = [];
  for (const variant of VARIANT_LABELS) {
    out.push({ variant, analytics: await campaignAnalytics(tx, tenantId, campaignId, variant) });
  }
  return out;
}

/** One variant's results in the API's words (ADR-405), as `GET /campaigns/{id}` gives them. */
export const campaignVariantResultsSchema = z.object({
  variant: z
    .enum(VARIANT_LABELS)
    .describe('A: the campaign’s own template (templateId); B: its second template.'),
  templateId: z.uuid().nullable(),
  templateName: z.string().nullable(),
  sharePercent: z
    .number()
    .int()
    .min(10)
    .max(90)
    .describe(
      'The share of the audience the variant was given, in percent: each recipient’s variant comes from a stable hash of the campaign and the contact, so the counts are close to it but rarely equal.',
    ),
  results: campaignResultsSchema.describe(
    'Counted as the campaign’s results are, over the recipients given this variant only, so the two variants’ counts add up to the campaign’s. Descriptive counts: HyFib picks no winner and computes no significance.',
  ),
});
export type CampaignVariantResults = z.infer<typeof campaignVariantResultsSchema>;
