import type { WebhookEventType } from '@w360/db';

export type { WebhookEventType } from '@w360/db';

/**
 * Outgoing webhooks (P5-09, ADR-053): the parts the settings page and the services share. Pure
 * definitions without server dependencies, so pages can use them in the browser.
 */

export const WEBHOOK_EVENT_KEYS = [
  'message.received',
  'message.status',
  'consent.changed',
  'template.status_changed',
] as const satisfies readonly WebhookEventType[];

export const WEBHOOK_EVENT_INFO: Record<WebhookEventType, { label: string; description: string }> =
  {
    'message.received': {
      label: 'Message received',
      description: 'A contact sent a message to one of your WhatsApp numbers.',
    },
    'message.status': {
      label: 'Message status',
      description:
        'A message you sent was accepted by WhatsApp, sent, delivered, read, failed or canceled.',
    },
    'consent.changed': {
      label: 'Consent changed',
      description: 'A contact opted in or out, whoever recorded it.',
    },
    'template.status_changed': {
      label: 'Template status',
      description: 'Meta approved, rejected, paused or disabled a template, or it was deleted.',
    },
  };

export const WEBHOOK_LIMITS = {
  endpoints: 10,
  urlLength: 2048,
  descriptionLength: 200,
  /** Attempts per delivery before it fails. */
  attempts: 8,
  /** How long the previous secret still signs after a rotation. */
  previousSecretHours: 24,
  /** An endpoint failing without a success for this long is disabled at its next failure. */
  disableAfterHours: 72,
  retentionDays: 30,
} as const;

/** The wait after each failed attempt: after the first, 1 minute; after the seventh, 24 hours. */
export const WEBHOOK_RETRY_SECONDS = [60, 300, 1_800, 7_200, 21_600, 43_200, 86_400] as const;

/** Seconds until the next attempt after attempt number `attempt` failed; null when none is left. */
export function webhookRetryDelaySeconds(attempt: number): number | null {
  if (attempt >= WEBHOOK_LIMITS.attempts) return null;
  return WEBHOOK_RETRY_SECONDS[attempt - 1] ?? null;
}

/** An endpoint URL's host, the only part of it that audit entries and notices name. */
export function webhookHost(url: string): string | null {
  return URL.canParse(url) ? new URL(url).hostname : null;
}

/** What a member sees for a delivery's last error code. */
export function webhookErrorLabel(code: string | null, status: number | null): string | null {
  if (status !== null) return `HTTP ${status}`;
  switch (code) {
    case null:
      return null;
    case 'timeout':
      return 'No answer within 10 seconds';
    case 'dns_failed':
      return 'The host name did not resolve';
    case 'address_blocked':
      return 'The address is private or reserved';
    case 'connect_failed':
      return 'Could not connect';
    case 'network_error':
      return 'The connection broke';
    case 'response_too_large':
      return 'The answer was too large';
    case 'invalid_status':
      return 'The answer had no valid HTTP status';
    case 'interrupted':
      return 'The attempt was interrupted';
    case 'endpoint_disabled':
      return 'The endpoint was turned off';
    case 'event_gone':
      return 'The message no longer exists';
    default:
      return code;
  }
}
