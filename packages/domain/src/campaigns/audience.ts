import {
  SKIP_REASONS,
  contacts,
  sql,
  type ConsentPurpose,
  type SQL,
  type SkipReason,
  type Tx,
} from '@w360/db';
import type { VariantLabel } from './variants';

/**
 * Audience evaluation for campaigns. The same classification is used for the review screen (counts
 * only) and for the snapshot (one INSERT … SELECT), so what a member reviews is what is frozen.
 * Every recipient is classified again, with fresh data, when the runner queues them.
 */
export const MAX_AUDIENCE = 50_000;

export interface AudienceRules {
  tenantId: string;
  whatsappAccountId: string;
  purpose: ConsentPurpose;
  requireMarketingOptIn: boolean;
  /** Custom-field keys read by the variables without a fallback. */
  requiredFields: string[];
}

/** The contact's number on the campaign's WABA ('+' + WhatsApp id, when E.164-shaped). */
function waPhoneSql(whatsappAccountId: string): SQL {
  return sql`(select '+' || i.wa_id from app.contact_identities i
    where i.tenant_id = ${contacts.tenantId} and i.contact_id = ${contacts.id}
      and i.whatsapp_account_id = ${whatsappAccountId} and i.wa_id ~ '^[1-9][0-9]{6,14}$'
    order by i.created_at limit 1)`;
}

/**
 * FROM clause: contacts with `w.wa_phone` and `x.reason` (null when the contact can be sent to
 * now, otherwise the skip reason), filtered by `where`.
 */
function classifiedContacts(rules: AudienceRules, where: SQL): SQL {
  const consent = sql`(select cc.status from app.contact_consents cc
    where cc.tenant_id = ${contacts.tenantId} and cc.contact_id = ${contacts.id} and cc.purpose = ${rules.purpose})`;
  const missing =
    rules.requiredFields.length > 0
      ? sql.join(
          rules.requiredFields.map((key) => sql`(${contacts.attributes} -> ${key}) is null`),
          sql` or `,
        )
      : sql`false`;
  const needsOptIn = rules.purpose === 'marketing' && rules.requireMarketingOptIn;
  return sql`${contacts}
    cross join lateral (select ${waPhoneSql(rules.whatsappAccountId)} as wa_phone) w
    cross join lateral (select case
      when ${contacts.phoneE164} is null and w.wa_phone is null then 'no_phone'
      when exists (select 1 from app.suppressions s where s.tenant_id = ${contacts.tenantId}
                     and s.phone_e164 in (${contacts.phoneE164}, w.wa_phone)) then 'suppressed'
      when ${consent} = 'opted_out' then 'opted_out'
      when ${needsOptIn ? sql`${consent} is distinct from 'opted_in'` : sql`false`} then 'no_marketing_opt_in'
      when ${missing} then 'missing_variable'
      else null end as reason) x
    where ${where}`;
}

export async function countAudience(tx: Tx, where: SQL): Promise<number> {
  const res = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from ${contacts} where ${where}`,
  );
  return res.rows[0]?.n ?? 0;
}

export interface AudienceBreakdown {
  total: number;
  eligible: number;
  skipped: Partial<Record<SkipReason, number>>;
}

export async function classifyAudience(
  tx: Tx,
  rules: AudienceRules,
  where: SQL,
): Promise<AudienceBreakdown> {
  const res = await tx.execute<{ reason: string | null; n: number }>(
    sql`select x.reason, count(*)::int as n from ${classifiedContacts(rules, where)} group by x.reason`,
  );
  const out: AudienceBreakdown = { total: 0, eligible: 0, skipped: {} };
  for (const row of res.rows) {
    out.total += row.n;
    if (row.reason === null) out.eligible += row.n;
    else if ((SKIP_REASONS as readonly string[]).includes(row.reason))
      out.skipped[row.reason as SkipReason] = row.n;
  }
  return out;
}

/** Recipient numbers of the contacts that can be sent to now (for cost estimates). */
export async function eligiblePhones(tx: Tx, rules: AudienceRules, where: SQL): Promise<string[]> {
  const res = await tx.execute<{ phone: string }>(
    sql`select coalesce(w.wa_phone, ${contacts.phoneE164}) as phone
          from ${classifiedContacts(rules, where)} and x.reason is null`,
  );
  return res.rows.map((r) => r.phone);
}

/**
 * One variant's share of an audience (ADR-405): its label, its rules (consent purpose, required
 * fields) and the condition that a contact falls into it (null: the whole audience, for a campaign
 * without variants, whose recipients are all A).
 */
export interface AudienceArm {
  label: VariantLabel;
  rules: AudienceRules;
  filter: SQL | null;
}

/** The audience's condition narrowed to one variant's contacts. */
export function armWhere(arm: Pick<AudienceArm, 'filter'>, where: SQL): SQL {
  return arm.filter ? sql`(${where}) and ${arm.filter}` : where;
}

export interface SnapshotCounts {
  total: number;
  pending: number;
  skipped: number;
}

/**
 * Freezes the audience: one recipient row per matching contact, pending or skipped, each with its
 * variant, classified by its variant's rules (ADR-405). Each contact falls into exactly one arm, so
 * the recipients are the audience's contacts once each.
 */
export async function insertSnapshot(
  tx: Tx,
  campaignId: string,
  arms: readonly AudienceArm[],
  where: SQL,
): Promise<SnapshotCounts & { byVariant: Partial<Record<VariantLabel, SnapshotCounts>> }> {
  const byVariant: Partial<Record<VariantLabel, SnapshotCounts>> = {};
  let total = 0;
  let pending = 0;
  for (const arm of arms) {
    const res = await tx.execute<{ total: number; pending: number }>(sql`
      with inserted as (
        insert into app.campaign_recipients (id, tenant_id, campaign_id, contact_id, state, skip_reason, variant)
        select gen_random_uuid(), ${contacts.tenantId}, ${campaignId}::uuid, ${contacts.id},
               case when x.reason is null then 'pending' else 'skipped' end, x.reason, ${arm.label}
          from ${classifiedContacts(arm.rules, armWhere(arm, where))}
        returning state)
      select count(*)::int as total, (count(*) filter (where state = 'pending'))::int as pending
        from inserted`);
    const armTotal = res.rows[0]?.total ?? 0;
    const armPending = res.rows[0]?.pending ?? 0;
    byVariant[arm.label] = { total: armTotal, pending: armPending, skipped: armTotal - armPending };
    total += armTotal;
    pending += armPending;
  }
  return { total, pending, skipped: total - pending, byVariant };
}
