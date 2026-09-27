/** Labels for WhatsApp Flows states (shared by the flow pages). */
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const FLOW_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft at Meta', tone: 'info' },
  PUBLISHED: { label: 'Published', tone: 'success' },
  DEPRECATED: { label: 'Deprecated', tone: 'neutral' },
  BLOCKED: { label: 'Blocked by Meta', tone: 'danger' },
  THROTTLED: { label: 'Throttled by Meta', tone: 'warning' },
};

export const FLOW_SYNC_OP: Record<string, string> = {
  create: 'Sending to Meta',
  upload: 'Sending changes to Meta',
  publish: 'Publishing',
  deprecate: 'Deprecating',
  delete: 'Deleting at Meta',
  refresh: 'Reading from Meta',
};

export const FLOW_CATEGORY_LABELS: Record<string, string> = {
  SIGN_UP: 'Sign up',
  SIGN_IN: 'Sign in',
  APPOINTMENT_BOOKING: 'Appointment booking',
  LEAD_GENERATION: 'Lead generation',
  CONTACT_US: 'Contact us',
  CUSTOMER_SUPPORT: 'Customer support',
  SURVEY: 'Survey',
  OTHER: 'Other',
};

export const ANSWER_OUTCOME: Record<string, string> = {
  applied: 'saved',
  missing: 'not answered',
  invalid: 'not saved',
  skipped: 'skipped',
};

export const KEY_UPLOAD_ERRORS: Record<string, string> = {
  signature_mismatch: 'Meta reports a signature mismatch for this key.',
  different_key: 'Meta has a different key for this number.',
  account_not_connected: 'The WhatsApp account is not connected.',
  number_inactive: 'The number is not active.',
};

/** One answer of a completed flow as plain text. */
export function flowAnswerText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
    return value.join(', ');
  }
  return JSON.stringify(value).slice(0, 300);
}
