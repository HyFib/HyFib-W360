import { sql, type Tx } from '@w360/db';

/**
 * Campaign attribution (docs/ARCHITECTURE.md §6B, metric definitions in migration 0007): a reply
 * or a marketing opt-out counts for the most recent campaign message queued to the same contact in
 * the 72 hours before it ("last touch"), once. Replies are matched per WhatsApp number; opt-outs
 * apply to the contact. Reactions and system notices are not replies. Meta timestamps are whole
 * seconds, so the queueing time is compared at second precision.
 */
export const ATTRIBUTION_WINDOW_HOURS = 72;

const DELIVERY_STATUSES = sql`('accepted', 'sent', 'delivered', 'read', 'played')`;

export async function attributeCampaignReply(
  tx: Tx,
  input: { tenantId: string; contactId: string; channelAccountId: string; at: Date },
): Promise<void> {
  const at = input.at.toISOString();
  await tx.execute(sql`
    update app.campaign_recipients r set replied_at = ${at}::timestamptz
     where r.tenant_id = ${input.tenantId} and r.replied_at is null
       and r.id = (
         select r2.id from app.campaign_recipients r2
           join app.messages m on m.tenant_id = r2.tenant_id and m.id = r2.message_id
          where r2.tenant_id = ${input.tenantId} and r2.contact_id = ${input.contactId}
            and r2.state = 'queued' and m.channel_account_id = ${input.channelAccountId}
            and m.status in ${DELIVERY_STATUSES}
            and date_trunc('second', r2.queued_at) <= ${at}::timestamptz
            and r2.queued_at > ${at}::timestamptz - make_interval(hours => ${ATTRIBUTION_WINDOW_HOURS})
          order by r2.queued_at desc
          limit 1)`);
}

export async function attributeCampaignOptOut(
  tx: Tx,
  input: { tenantId: string; contactId: string; at: Date },
): Promise<void> {
  const at = input.at.toISOString();
  await tx.execute(sql`
    update app.campaign_recipients r set opted_out_at = ${at}::timestamptz
     where r.tenant_id = ${input.tenantId} and r.opted_out_at is null
       and r.id = (
         select r2.id from app.campaign_recipients r2
          where r2.tenant_id = ${input.tenantId} and r2.contact_id = ${input.contactId}
            and r2.state = 'queued'
            and date_trunc('second', r2.queued_at) <= ${at}::timestamptz
            and r2.queued_at > ${at}::timestamptz - make_interval(hours => ${ATTRIBUTION_WINDOW_HOURS})
          order by r2.queued_at desc
          limit 1)`);
}
