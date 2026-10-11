/**
 * Codes failed messages carry: Meta's error codes (or an answer's HTTP status when it carried no
 * code), and HyFib's own for a send refused before it left or whose last attempt could not reach
 * Meta. `official` marks HyFib's codes and Meta's confirmed in its error table
 * (docs/research/meta-whatsapp.md M-062); others come from third-party code (M-063). Campaign pages
 * and the operations console's failed sends by reason (ADR-347) and their CSV (ADR-365) read them:
 * pure data, so the browser and the server say the same words.
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
    label:
      'The last attempt could not connect to Meta and no retries were left, so the message was not sent.',
    official: true,
  },
  unknown: {
    label: 'Unknown outcome: the connection dropped after the request left.',
    official: true,
  },
};

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
