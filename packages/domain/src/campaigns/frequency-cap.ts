import { sql, type Tx } from '@w360/db';
import { loadCampaignSettings } from './service';

/**
 * The company's marketing frequency cap outside campaigns (store messages, automation template
 * steps): marketing templates a contact received in the cap's period, counted like the campaign
 * runner counts them (ADR-049, ADR-050).
 */

/**
 * Takes the campaign runner's company lock (campaigns/runner.ts), so a count and the send that
 * follows cannot race a campaign past the cap. `try` returns false instead of waiting: the campaign
 * runner holds this lock while it writes conversations, so a caller that already holds a
 * conversation's row lock must never wait for it (that would be a deadlock).
 */
export async function lockCampaignSends(
  tx: Tx,
  tenantId: string,
  mode: 'wait' | 'try',
): Promise<boolean> {
  const key = `campaign-runner:${tenantId}`;
  if (mode === 'wait') {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return true;
  }
  const res = await tx.execute<{ ok: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as ok`,
  );
  return res.rows[0]?.ok === true;
}

/** Whether the contact already received the company's maximum of marketing templates. */
export async function marketingCapReached(
  tx: Tx,
  tenantId: string,
  contactId: string,
  now: Date,
): Promise<boolean> {
  const settings = await loadCampaignSettings(tx, tenantId);
  if (!settings.capCount || !settings.capDays) return false;
  const res = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n
      from app.messages m
      join app.conversations cv on cv.tenant_id = m.tenant_id and cv.id = m.conversation_id
      join app.message_templates t on t.tenant_id = m.tenant_id and t.id = m.template_id
     where m.tenant_id = ${tenantId} and cv.contact_id = ${contactId}
       and m.direction = 'outbound' and t.category = 'MARKETING'
       and m.status not in ('failed', 'canceled')
       and m.created_at > ${now.toISOString()}::timestamptz - make_interval(days => ${settings.capDays})`);
  return (res.rows[0]?.n ?? 0) >= settings.capCount;
}
