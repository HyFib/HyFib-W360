import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FieldIssue } from '@w360/core';
import { sql, type SQL } from '@w360/db';
import { linkButtons, type SendSpec } from '../templates/definition';
import { checkVariables, type CampaignVariables } from './variables';

/**
 * A/B template variants for campaigns (ADR-405), up to five (ADR-410). A campaign's own template and
 * mapping are variant A; a draft may add variants B to E, each a template of the same number's
 * WhatsApp account with its own mapping, sent to the share of the recipients the member chooses
 * (10% to 90% in steps of 5). A gets the rest, which must be at least 10% too.
 *
 * Each recipient's variant comes from a stable hash of the campaign and the contact, given when the
 * audience is taken and recorded on its recipient row: the same contact in the same campaign always
 * gets the same variant, and the shares are close to the chosen ones for large audiences. Nothing
 * here picks a winner: results per variant are descriptive counts.
 */
export const VARIANT_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;
export type VariantLabel = (typeof VARIANT_LABELS)[number];

/** The most variants a campaign tests, A included (ADR-410): A to E. */
export const MAX_VARIANTS = VARIANT_LABELS.length;

/**
 * The most variants a web server lets a draft have when its deployment does not say otherwise
 * (`CAMPAIGN_VARIANTS_MAX`, ADR-410): two, as the release before builds. A deployment raises it
 * only once no web server or worker of that release is left (DEPLOYMENT).
 */
export const DEFAULT_VARIANTS_LIMIT = 2;

/** Each variant's share of the recipients, in percent: from 10 to 90 in steps of 5, A's too. */
export const VARIANT_SHARE = { min: 10, max: 90, step: 5 } as const;

/** The shares a member chooses from, in percent. */
export const VARIANT_SHARES: readonly number[] = Array.from(
  { length: (VARIANT_SHARE.max - VARIANT_SHARE.min) / VARIANT_SHARE.step + 1 },
  (_, i) => VARIANT_SHARE.min + i * VARIANT_SHARE.step,
);

export const variantShareSchema = z
  .number()
  .int()
  .min(
    VARIANT_SHARE.min,
    `Give each variant ${VARIANT_SHARE.min}% to ${VARIANT_SHARE.max}% of the recipients`,
  )
  .max(
    VARIANT_SHARE.max,
    `Give each variant ${VARIANT_SHARE.min}% to ${VARIANT_SHARE.max}% of the recipients`,
  )
  .refine(
    (n) => n % VARIANT_SHARE.step === 0,
    `Choose each variant's share in steps of ${VARIANT_SHARE.step}%`,
  );

/** How a draft's variant after A is given: its template, its mapping and its share. */
export const variantInputSchema = z.object({
  templateId: z.uuid().nullable(),
  variables: z.unknown(),
  sharePercent: variantShareSchema,
});
export type VariantInput = z.infer<typeof variantInputSchema>;

const lastLabel = VARIANT_LABELS[MAX_VARIANTS - 1];

/** A draft's variants after A, in label order (B, C, …): at most four (ADR-410). */
export const variantsInputSchema = z
  .array(variantInputSchema)
  .max(
    MAX_VARIANTS - 1,
    `A campaign tests at most ${MAX_VARIANTS} templates, variants A to ${lastLabel}`,
  );

/** The label of the variant after A at `index` (0 is B). */
export function variantLabelAt(index: number): VariantLabel {
  const label = VARIANT_LABELS[index + 1];
  if (!label) throw new Error(`A campaign has no variant after A at ${index}`);
  return label;
}

/** A recorded variant read back: the column admits A to Z, and HyFib writes A to E only. */
export function parseVariantLabel(value: string): VariantLabel {
  const label = VARIANT_LABELS.find((l) => l === value);
  if (!label) throw new Error(`Unknown campaign variant ${JSON.stringify(value)}`);
  return label;
}

/**
 * What is wrong with a draft's variants after A, given their shares in label order (ADR-410), or
 * null: at most `MAX_VARIANTS` in all, each share from 10% to 90% in steps of 5, and A's rest at
 * least 10%, so the shares sum to 100% with no variant below 10%. The path names the field as a
 * draft's `variants` gives it (`variants.1.sharePercent` for C's share).
 */
export function variantSetIssue(shares: readonly number[]): FieldIssue | null {
  if (shares.length + 1 > MAX_VARIANTS)
    return {
      path: 'variants',
      message: `A campaign tests at most ${MAX_VARIANTS} templates, variants A to ${lastLabel}.`,
    };
  for (const [i, share] of shares.entries()) {
    const parsed = variantShareSchema.safeParse(share);
    if (!parsed.success)
      return {
        path: `variants.${i}.sharePercent`,
        message: `Variant ${variantLabelAt(i)}: ${parsed.error.issues[0]?.message ?? 'Choose a valid share'}.`,
      };
  }
  const taken = shares.reduce((sum, share) => sum + share, 0);
  if (100 - taken < VARIANT_SHARE.min)
    return {
      path: 'variants',
      message: `Variant A needs at least ${VARIANT_SHARE.min}% of the recipients: the other variants take ${taken}%.`,
    };
  return null;
}

/** `variantSetIssue`'s message alone. */
export function variantSetProblem(shares: readonly number[]): string | null {
  return variantSetIssue(shares)?.message ?? null;
}

/**
 * The refusal of a draft that would test more templates than this web server allows now (ADR-410):
 * `limit` is `CAMPAIGN_VARIANTS_MAX`, two until the deployment has no server of the release before.
 */
export function variantLimitProblem(limit: number): string {
  return `A campaign can test at most ${limit} templates for now, variants A to ${VARIANT_LABELS[limit - 1] ?? 'A'}.`;
}

/** The buckets a recipient's hash falls into; a share in percent takes that many of them. */
export const VARIANT_BUCKETS = 100;

/**
 * The recipient's bucket (0 to 99): the first 32 bits of the MD5 of "campaign:contact" (ids as
 * PostgreSQL writes uuids, in lowercase) modulo 100. `variantBucketSql` computes the same in SQL.
 * MD5 is used for its spread, not as a security measure: nobody gains by guessing a bucket.
 */
export function variantBucket(campaignId: string, contactId: string): number {
  const digest = createHash('md5')
    .update(`${campaignId.toLowerCase()}:${contactId.toLowerCase()}`)
    .digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) % VARIANT_BUCKETS;
}

/** The buckets a variant takes: from `from` up to, not including, `to`. */
export interface VariantRange {
  label: VariantLabel;
  from: number;
  to: number;
}

/**
 * Each variant's buckets, given the shares of the variants after A in label order (ADR-410): B takes
 * the first `shares[0]` buckets, C the next `shares[1]`, and so on, and A the rest, last. With B
 * alone this is ADR-405's rule (B below its share, A from it), so a two-variant campaign splits as
 * it always did. Without variants (no shares) A takes every bucket.
 */
export function variantRanges(shares: readonly number[]): VariantRange[] {
  const ranges: VariantRange[] = [];
  let from = 0;
  for (const [i, share] of shares.entries()) {
    ranges.push({ label: variantLabelAt(i), from, to: from + share });
    from += share;
  }
  ranges.push({ label: 'A', from, to: VARIANT_BUCKETS });
  return ranges;
}

/** The variant of a bucket, given the shares of the variants after A in label order. */
export function variantOfBucket(bucket: number, shares: readonly number[]): VariantLabel {
  for (const range of variantRanges(shares))
    if (bucket >= range.from && bucket < range.to) return range.label;
  throw new Error(`Bucket ${bucket} is outside 0 to ${VARIANT_BUCKETS - 1}`);
}

/** A recipient's variant in a campaign whose variants after A take `shares` percent (B first). */
export function assignVariant(
  campaignId: string,
  contactId: string,
  shares: readonly number[],
): VariantLabel {
  return variantOfBucket(variantBucket(campaignId, contactId), shares);
}

/** `variantBucket` in SQL, for the contact id `contactId` (a uuid expression). */
export function variantBucketSql(campaignId: string, contactId: SQL): SQL {
  return sql`((('x' || lpad(substr(md5(${campaignId.toLowerCase()}::text || ':' || (${contactId})::text), 1, 8), 16, '0'))::bit(64)::bigint) % ${VARIANT_BUCKETS})`;
}

/**
 * The SQL condition that a contact falls into `label` when the variants after A take `shares`
 * percent (B first): its bucket within the variant's range, as `variantRanges` gives it (from
 * inclusive, to exclusive: `int4range`'s default bounds).
 */
export function variantConditionSql(
  campaignId: string,
  contactId: SQL,
  label: VariantLabel,
  shares: readonly number[],
): SQL {
  const range = variantRanges(shares).find((r) => r.label === label);
  if (!range) throw new Error(`The campaign has no variant ${label}`);
  // A half-open range, so the bucket (an MD5 per row) is computed once, not once per bound.
  return sql`(int4range(${range.from}::int, ${range.to}::int) @> (${variantBucketSql(campaignId, contactId)})::int)`;
}

/** The template facts a variant's checks read. */
export interface VariantTemplate {
  status: string;
  whatsappAccountId: string;
  spec: SendSpec;
}

/**
 * What blocks one variant: its template chosen, approved by Meta, of the number's WhatsApp account
 * and sendable, and its mapping complete. With variants, each problem names its variant
 * ("Variant C: …"); without them (`label` null) the wording is the one campaigns always had.
 */
export function variantTemplateProblems(
  label: VariantLabel | null,
  template: VariantTemplate | null,
  channel: { whatsappAccountId: string } | null,
  variables: CampaignVariables,
  fieldKeys: ReadonlySet<string>,
): string[] {
  const named = (problem: string) => (label ? `Variant ${label}: ${problem}` : problem);
  if (!template) return [named('Choose an approved template.')];
  const problems: string[] = [];
  if (template.status !== 'approved') problems.push(named('The template is not approved by Meta.'));
  if (channel && template.whatsappAccountId !== channel.whatsappAccountId)
    problems.push(
      named('The template belongs to another WhatsApp account than the chosen number.'),
    );
  if (!template.spec.supported) problems.push(named(template.spec.reason));
  else {
    const problem = checkVariables(
      variables,
      {
        headerParams: template.spec.headerParams,
        bodyParams: template.spec.bodyParams,
        links: linkButtons(template.spec.definition),
      },
      fieldKeys,
    );
    if (problem) problems.push(named(problem));
  }
  return problems;
}

/** Whether a variant's template can still be sent with its mapping (the runner's check). */
export function variantSendable(
  template: VariantTemplate | null,
  channel: { whatsappAccountId: string },
  variables: CampaignVariables,
): boolean {
  if (!template || !template.spec.supported) return false;
  return (
    template.status === 'approved' &&
    template.whatsappAccountId === channel.whatsappAccountId &&
    template.spec.headerParams === variables.header.length &&
    template.spec.bodyParams === variables.body.length &&
    template.spec.buttonParams === variables.buttons.length
  );
}
