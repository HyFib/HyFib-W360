import { sql, type SQL } from '@w360/db';

/**
 * What happened to a campaign's recipients, as `campaignAnalytics` counts them for members'
 * campaign page and the API's results (ADR-125) and as the API lists them (ADR-127). Each is a
 * condition over a recipient `r` (app.campaign_recipients) and its message `m` (app.messages, left
 * joined), so a list and its count cannot disagree.
 */
export const RECIPIENT_OUTCOMES = [
  'pending',
  'skipped',
  'canceled',
  'queued',
  'in_progress',
  'sent',
  'delivered',
  'read',
  'failed',
  'unknown',
  'message_canceled',
  'replied',
  'opted_out',
] as const;
export type RecipientOutcome = (typeof RECIPIENT_OUTCOMES)[number];

const delivered = sql`m.status in ('delivered', 'read', 'played')`;

export const RECIPIENT_OUTCOME_SQL: Readonly<Record<RecipientOutcome, SQL>> = {
  pending: sql`r.state = 'pending'`,
  skipped: sql`r.state = 'skipped'`,
  canceled: sql`r.state = 'canceled'`,
  queued: sql`r.state = 'queued'`,
  in_progress: sql`r.state = 'queued' and m.status in ('queued', 'sending', 'accepted')`,
  sent: sql`r.state = 'queued' and m.status in ('sent', 'delivered', 'read', 'played')`,
  delivered: sql`r.state = 'queued' and ${delivered}`,
  read: sql`r.state = 'queued' and m.status in ('read', 'played')`,
  failed: sql`r.state = 'queued' and m.status = 'failed'`,
  unknown: sql`r.state = 'queued' and m.status = 'unknown_outcome'`,
  // Replies and opt-outs count among delivered recipients only (ADR-125); a message canceled
  // before it was sent counts whatever the recipient's state.
  message_canceled: sql`m.status = 'canceled'`,
  replied: sql`r.replied_at is not null and ${delivered}`,
  opted_out: sql`r.opted_out_at is not null and ${delivered}`,
};
