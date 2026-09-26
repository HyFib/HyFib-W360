import { sql } from '@w360/db';

/**
 * Campaign counter values recomputed from the recipients (used when sends are released or
 * cancelled, and on resume, so the counters the caps compare cannot drift).
 */
export function recountedCounters(tenantId: string, campaignId: string) {
  return {
    queuedCount: sql`(select count(*)::int from app.campaign_recipients r
      where r.tenant_id = ${tenantId} and r.campaign_id = ${campaignId} and r.state = 'queued')`,
    skippedCount: sql`(select count(*)::int from app.campaign_recipients r
      where r.tenant_id = ${tenantId} and r.campaign_id = ${campaignId} and r.state = 'skipped')`,
    spentEstimateMicros: sql`(select coalesce(sum(r.estimated_cost_micros), 0)::bigint
      from app.campaign_recipients r
      where r.tenant_id = ${tenantId} and r.campaign_id = ${campaignId} and r.state = 'queued')`,
  };
}
