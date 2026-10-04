import type { WebhookContactPart, WebhookEventType, WebhookMessageStatus } from '@w360/db';

export type { WebhookContactPart, WebhookEventType, WebhookMessageStatus } from '@w360/db';

/**
 * Outgoing webhooks (P5-09, ADR-053, ADR-074, ADR-078, ADR-085, ADR-087, ADR-094): the parts the
 * settings page and the services share. Pure definitions without server dependencies, so pages can
 * use them in the browser.
 */

export const WEBHOOK_EVENT_KEYS = [
  'message.received',
  'message.status',
  'consent.changed',
  'template.status_changed',
  'conversation.status_changed',
  'conversation.assignment_changed',
  'conversation.team_changed',
  'contact.created',
  'contact.updated',
  'contact.erased',
  'automation.run_started',
  'automation.run_ended',
  'order.received',
  'order.status_changed',
  'campaign.status_changed',
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
    'conversation.status_changed': {
      label: 'Conversation status',
      description:
        'A conversation was resolved, reopened or set to pending, by a member, an automation, an API key or the contact writing again.',
    },
    'conversation.assignment_changed': {
      label: 'Conversation assignment',
      description:
        'A member was assigned to a conversation, it moved to another member, or it went back to nobody.',
    },
    'conversation.team_changed': {
      label: 'Conversation team',
      description:
        'A conversation was placed in a team, moved to another or taken out of one: by routing, a member, an automation, an API key or the team being deleted.',
    },
    'contact.created': {
      label: 'Contact added',
      description:
        'A contact was added: by a first message, a member, an import, the API or a store.',
    },
    'contact.updated': {
      label: 'Contact changed',
      description:
        'A contact’s name, number, email, tags or custom field values changed. The event says which.',
    },
    'contact.erased': {
      label: 'Contact erased',
      description:
        'A contact was erased. Take it to delete your copy: the event carries no personal data.',
    },
    'automation.run_started': {
      label: 'Automation started',
      description:
        'An automation started in a conversation: from a customer message, a store’s order event or a call through the API. Members’ test runs are not sent.',
    },
    'automation.run_ended': {
      label: 'Automation ended',
      description:
        'An automation run ended: completed, handed to people, taken over, stopped or failed, with the reason.',
    },
    'order.received': {
      label: 'Order received',
      description:
        'A customer sent a cart from your WhatsApp catalog: the order with its items, total and note.',
    },
    'order.status_changed': {
      label: 'Order status',
      description:
        'A WhatsApp order was confirmed, fulfilled or cancelled, is waiting for payment, was paid through its Payment Link, or went back to confirmed when the link ended unpaid.',
    },
    'campaign.status_changed': {
      label: 'Campaign status',
      description:
        'A campaign was submitted for approval, sent back to draft, scheduled, started, paused, resumed, completed or cancelled, by a member or as it ran.',
    },
  };

/** The statuses a `message.status` event carries, in the order a message reaches them. */
export const WEBHOOK_MESSAGE_STATUSES = [
  'accepted',
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
  'canceled',
  'unknown_outcome',
] as const satisfies readonly WebhookMessageStatus[];

/** How Settings names each status an endpoint can choose (ADR-119). */
export const WEBHOOK_MESSAGE_STATUS_LABELS: Record<WebhookMessageStatus, string> = {
  accepted: 'Accepted by WhatsApp',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  played: 'Played',
  failed: 'Failed',
  canceled: 'Canceled',
  unknown_outcome: 'Outcome unknown',
};

/**
 * The parts of a contact whose change a `contact.updated` endpoint can choose (ADR-123), as the
 * event names them; `fields` takes a change of any custom field (`fields.<key>`).
 */
export const WEBHOOK_CONTACT_PARTS = [
  'name',
  'phone',
  'email',
  'tags',
  'fields',
] as const satisfies readonly WebhookContactPart[];

/** How Settings names each part an endpoint can choose (ADR-123). */
export const WEBHOOK_CONTACT_PART_LABELS: Record<WebhookContactPart, string> = {
  name: 'Name',
  phone: 'Number',
  email: 'Email',
  tags: 'Tags',
  fields: 'Custom field values',
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
  /** Failed deliveries replayed in one call at most (ADR-095); another call queues the next ones. */
  replayBatch: 500,
  /** An endpoint's own headers (ADR-118): how many, and how long a value can be. */
  headers: 5,
  headerValueLength: 1000,
  /** The automations an endpoint can choose to take the runs of (ADR-145). */
  automations: 20,
} as const;

/** The events of automation runs, which an endpoint can take for chosen automations (ADR-145). */
export const WEBHOOK_AUTOMATION_EVENTS = [
  'automation.run_started',
  'automation.run_ended',
] as const satisfies readonly WebhookEventType[];

/** An automation an endpoint takes the runs of (ADR-145). */
export interface WebhookEndpointAutomation {
  id: string;
  name: string;
  archived: boolean;
}

/** An automation an endpoint can choose (ADR-145): published, so it cannot be deleted. */
export interface WebhookAutomationChoice {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
}

/** Whether an endpoint with these events takes automation runs, and can choose automations. */
export function webhookTakesAutomationRuns(eventTypes: readonly WebhookEventType[]): boolean {
  return WEBHOOK_AUTOMATION_EVENTS.some((type) => eventTypes.includes(type));
}

/**
 * The periods Settings → Webhooks replays failed deliveries from (ADR-095), up to the deliveries
 * HyFib keeps. The API takes any time instead.
 */
export const WEBHOOK_REPLAY_PERIODS = [
  { key: '1h', label: 'the last hour', hours: 1 },
  { key: '24h', label: 'the last 24 hours', hours: 24 },
  { key: '7d', label: 'the last 7 days', hours: 7 * 24 },
  { key: '30d', label: 'the last 30 days', hours: WEBHOOK_LIMITS.retentionDays * 24 },
] as const;

export type WebhookReplayPeriod = (typeof WEBHOOK_REPLAY_PERIODS)[number]['key'];

/** What a replay of failed deliveries did, in the words Settings → Webhooks shows it. */
export function webhookReplaySummary(result: { queued: number; more: boolean }): string {
  if (result.queued === 0) return 'No failed deliveries to replay from that period.';
  const queued =
    result.queued === 1 ? 'Replaying 1 delivery.' : `Replaying ${result.queued} deliveries.`;
  return result.more
    ? `${queued} More failed deliveries remain: replay again to queue the next ones.`
    : queued;
}

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

/**
 * What a member sees for a delivery's last error code. An attempt leaves a status or a code, never
 * both; a code that ended the delivery without an attempt (`endpoint_disabled`, `event_gone`,
 * `interrupted`, `payload_failed`) says more than the status an earlier attempt left.
 */
export function webhookErrorLabel(code: string | null, status: number | null): string | null {
  if (code === null) return status === null ? null : `HTTP ${status}`;
  switch (code) {
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
      return 'What the event is about no longer exists';
    case 'payload_failed':
      return 'HyFib could not prepare the request';
    default:
      return code;
  }
}
