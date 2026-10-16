/** Member-facing names for campaign states, reasons and Meta error codes (server and client). */

import { FAILURE_CODES } from '@w360/domain/failure-codes';

// The failure codes' words live in the domain since ADR-365, so the console's CSV says what its
// pages say.
export { FAILURE_CODES, failureReasonLabel } from '@w360/domain/failure-codes';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending_approval: { label: 'Waiting for approval', tone: 'warning' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  running: { label: 'Sending', tone: 'info' },
  paused: { label: 'Paused', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  canceled: { label: 'Cancelled', tone: 'neutral' },
};

export const PAUSE_REASONS: Record<string, string> = {
  manual: 'Paused by a member.',
  api: 'Paused through the API.',
  budget_reached: 'The spending cap was reached. Raise it to continue.',
  message_cap_reached: 'The message cap was reached. Raise it to continue.',
  template_not_approved:
    'The template is no longer approved by Meta (or its variables changed). Queued messages were held back.',
  channel_inactive: 'The WhatsApp number is not active. Reconnect it, then resume.',
  launcher_removed:
    'The member whose authority the campaign used left the company. Another member can resume it.',
  launcher_not_permitted:
    'The member whose authority the campaign used can no longer send campaigns. Another member can resume it.',
  rate_card_missing:
    'No rate card is published for the spending cap’s currency, so costs cannot be checked.',
};

export const SKIP_REASONS: Record<string, string> = {
  contact_erased: 'Contact erased',
  no_phone: 'No WhatsApp number',
  suppressed: 'On the suppression list',
  opted_out: 'Opted out',
  no_marketing_opt_in: 'No marketing opt-in',
  missing_variable: 'Missing a variable value',
  frequency_capped: 'Over the marketing frequency cap',
  cost_unknown: 'No price for their market (spending cap)',
  expired: 'Sending period ended',
};

export function failureLabel(code: string): string {
  const known = FAILURE_CODES[code];
  if (!known) return `Meta error ${code}`;
  return known.official ? known.label : `${known.label} (meaning from third-party documentation)`;
}

export const EVENT_LABELS: Record<string, string> = {
  created: 'Created',
  edited: 'Edited',
  submitted: 'Submitted',
  withdrawn: 'Withdrawn',
  approved: 'Approved',
  rejected: 'Sent back for changes',
  scheduled: 'Scheduled',
  started: 'Started sending',
  paused: 'Paused',
  resumed: 'Resumed',
  canceled: 'Cancelled',
  completed: 'Completed',
  test_sent: 'Test sent',
};

export { formatPercent as percent } from '@w360/domain/report-format';
