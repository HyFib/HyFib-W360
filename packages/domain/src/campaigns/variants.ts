import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sql, type SQL } from '@w360/db';
import { linkButtons, type SendSpec } from '../templates/definition';
import { checkVariables, type CampaignVariables } from './variables';

/**
 * A/B template variants for campaigns (ADR-405). A campaign's own template and mapping are variant
 * A; a draft may add variant B, a second template of the same number's WhatsApp account with its
 * own mapping, sent to the share of the recipients the member chooses (10% to 90% in steps of 5).
 * The data model (app.campaign_variants, labels B to Z) is open to more variants; HyFib builds two.
 *
 * Each recipient's variant comes from a stable hash of the campaign and the contact, given when the
 * audience is taken and recorded on its recipient row: the same contact in the same campaign always
 * gets the same variant, and the shares are close to the chosen ones for large audiences. Nothing
 * here picks a winner: results per variant are descriptive counts.
 */
export const VARIANT_LABELS = ['A', 'B'] as const;
export type VariantLabel = (typeof VARIANT_LABELS)[number];

/** B's share of the recipients, in percent: from 10 to 90 in steps of 5. */
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
    `Give variant B ${VARIANT_SHARE.min}% to ${VARIANT_SHARE.max}% of the recipients`,
  )
  .max(
    VARIANT_SHARE.max,
    `Give variant B ${VARIANT_SHARE.min}% to ${VARIANT_SHARE.max}% of the recipients`,
  )
  .refine(
    (n) => n % VARIANT_SHARE.step === 0,
    `Choose variant B's share in steps of ${VARIANT_SHARE.step}%`,
  );

/** How a draft's variant B is given: its template, its mapping and its share. */
export const variantInputSchema = z.object({
  templateId: z.uuid().nullable(),
  variables: z.unknown(),
  sharePercent: variantShareSchema,
});
export type VariantInput = z.infer<typeof variantInputSchema>;

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

/** The variant of a bucket: B for the first `shareB` buckets, A for the rest. */
export function variantOfBucket(bucket: number, shareB: number | null): VariantLabel {
  return shareB !== null && bucket < shareB ? 'B' : 'A';
}

/** A recipient's variant in a campaign whose variant B takes `shareB` percent (null: no B). */
export function assignVariant(
  campaignId: string,
  contactId: string,
  shareB: number | null,
): VariantLabel {
  return variantOfBucket(variantBucket(campaignId, contactId), shareB);
}

/** `variantBucket` in SQL, for the contact id `contactId` (a uuid expression). */
export function variantBucketSql(campaignId: string, contactId: SQL): SQL {
  return sql`((('x' || lpad(substr(md5(${campaignId.toLowerCase()}::text || ':' || (${contactId})::text), 1, 8), 16, '0'))::bit(64)::bigint) % ${VARIANT_BUCKETS})`;
}

/** The SQL condition that a contact falls into `label` when B takes `shareB` percent. */
export function variantConditionSql(
  campaignId: string,
  contactId: SQL,
  label: VariantLabel,
  shareB: number,
): SQL {
  const bucket = variantBucketSql(campaignId, contactId);
  return label === 'B' ? sql`${bucket} < ${shareB}` : sql`${bucket} >= ${shareB}`;
}

/** The template facts a variant's checks read. */
export interface VariantTemplate {
  status: string;
  whatsappAccountId: string;
  spec: SendSpec;
}

/**
 * What blocks one variant: its template chosen, approved by Meta, of the number's WhatsApp account
 * and sendable, and its mapping complete. With variant B, each problem names its variant
 * ("Variant B: …"); without it (`label` null) the wording is the one campaigns always had.
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
