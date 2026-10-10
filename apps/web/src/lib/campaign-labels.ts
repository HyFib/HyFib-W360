/** Member-facing names for campaign states, reasons and Meta error codes (server and client). */
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

/**
 * Codes failed messages carry: Meta's error codes, and HyFib's own for a send refused before it
 * left. `official` marks HyFib's codes and Meta's confirmed in its error table
 * (docs/research/meta-whatsapp.md M-062); others come from third-party code (M-063). Campaign pages
 * and the operations console's failed sends by reason (ADR-347) read them.
 */
export const FAILURE_CODES: Record<string, { label: string; official: boolean }> = {
  '131049': {
    label:
      'Meta limited marketing messages to this customer. Wait at least 24 hours before trying again.',
    official: true,
  },
  '131050': {
    label: 'The customer stopped marketing messages from this business.',
    official: true,
  },
  '130429': { label: 'The number’s sending throughput limit was reached.', official: true },
  '131056': { label: 'Too many messages to this customer in a short time.', official: true },
  '131026': { label: 'Message undeliverable.', official: false },
  '131048': { label: 'Spam rate limit reached.', official: false },
  '131042': { label: 'A payment issue on the WhatsApp Business Account.', official: false },
  '132015': { label: 'The template is paused by Meta.', official: false },
  '132016': { label: 'The template is disabled by Meta.', official: false },
  opted_out: { label: 'The contact opted out before sending.', official: true },
  suppressed: { label: 'The number was suppressed before sending.', official: true },
  no_marketing_opt_in: { label: 'No marketing opt-in at sending time.', official: true },
  contact_erased: { label: 'The contact was erased before sending.', official: true },
  template_not_approved: {
    label: 'The template was not approved at sending time.',
    official: true,
  },
  company_suspended: { label: 'The company was suspended.', official: true },
  sender_removed: { label: 'The sending member left the company.', official: true },
  window_closed: {
    label: 'The 24-hour customer service window closed before the message could be sent.',
    official: true,
  },
  no_credential: {
    label: 'The WhatsApp account had no stored credential; it needs reconnecting.',
    official: true,
  },
  retryable: {
    label: 'No attempt could connect to Meta, so the message was not sent.',
    official: true,
  },
  unknown: {
    label: 'Unknown outcome: the connection dropped after the request left.',
    official: true,
  },
};

export function failureLabel(code: string): string {
  const known = FAILURE_CODES[code];
  if (!known) return `Meta error ${code}`;
  return known.official ? known.label : `${known.label} (meaning from third-party documentation)`;
}

/**
 * A reason in the operations console's failed sends by reason (ADR-347), its code in a column of its
 * own: `null` for the codes left over together, `''` for failures recorded without a code, and a
 * code without a recorded meaning says so rather than guess one (a number may be Meta's code or,
 * when Meta's answer carried none, its HTTP status).
 */
export function failureReasonLabel(code: string | null, codes: number): string {
  if (code === null) return `${codes} other ${codes === 1 ? 'code' : 'codes'}`;
  if (code === '') return 'Failed without a code';
  const known = FAILURE_CODES[code];
  if (!known) return 'Not described here';
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

export function percent(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  return `${Math.round((numerator / denominator) * 1000) / 10}%`;
}
