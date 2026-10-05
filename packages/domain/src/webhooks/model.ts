import type {
  ChannelStatus,
  WebhookCampaignStatus,
  WebhookContactPart,
  WebhookConversationStatus,
  WebhookEventType,
  WebhookMessageSender,
  WebhookMessageStatus,
  WebhookOrderStatus,
  WebhookRunEndStatus,
  WebhookRunTrigger,
  WebhookTemplateStatus,
} from '@w360/db';

export type {
  WebhookCampaignStatus,
  WebhookContactPart,
  WebhookConversationStatus,
  WebhookEventType,
  WebhookMessageSender,
  WebhookMessageStatus,
  WebhookOrderStatus,
  WebhookRunEndStatus,
  WebhookRunTrigger,
  WebhookTemplateStatus,
} from '@w360/db';

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
        'A conversation was resolved or reopened, by a member, an automation, an API key or the contact writing again.',
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
        'A contact’s name, number, email, tags or custom field values changed. The event says which, and which tags were added or removed.',
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
 * Who sent a message, as a `message.status` event's `message.sentBy` says (ADR-172): a member, an
 * automation, a campaign, the API, or HyFib itself (store order updates and satisfaction surveys).
 */
export const WEBHOOK_MESSAGE_SENDERS = [
  'agent',
  'bot',
  'campaign',
  'api',
  'system',
] as const satisfies readonly WebhookMessageSender[];

/** How Settings names each sender an endpoint can choose (ADR-172). */
export const WEBHOOK_MESSAGE_SENDER_LABELS: Record<WebhookMessageSender, string> = {
  agent: 'Members',
  bot: 'Automations',
  campaign: 'Campaigns',
  api: 'The API',
  system: 'HyFib (store order updates and satisfaction surveys)',
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

/**
 * The statuses a `campaign.status_changed` event reports, which an endpoint can choose (ADR-146),
 * in the order a campaign reaches them.
 */
export const WEBHOOK_CAMPAIGN_STATUSES = [
  'draft',
  'pending_approval',
  'scheduled',
  'running',
  'paused',
  'completed',
  'canceled',
] as const satisfies readonly WebhookCampaignStatus[];

/** How Settings names each campaign status an endpoint can choose (ADR-146), as Campaigns does. */
export const WEBHOOK_CAMPAIGN_STATUS_LABELS: Record<WebhookCampaignStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Waiting for approval',
  scheduled: 'Scheduled',
  running: 'Sending',
  paused: 'Paused',
  completed: 'Completed',
  canceled: 'Cancelled',
};

/**
 * The statuses an `order.status_changed` event reports, which an endpoint can choose (ADR-147), in
 * the order an order reaches them; `received` is reported only by `order.received`.
 */
export const WEBHOOK_ORDER_STATUSES = [
  'confirmed',
  'awaiting_payment',
  'paid',
  'fulfilled',
  'cancelled',
] as const satisfies readonly WebhookOrderStatus[];

/** How Settings names each order status an endpoint can choose (ADR-147), as Orders does. */
export const WEBHOOK_ORDER_STATUS_LABELS: Record<WebhookOrderStatus, string> = {
  confirmed: 'Confirmed',
  awaiting_payment: 'Waiting for payment',
  paid: 'Paid',
  fulfilled: 'Fulfilled',
  cancelled: 'Cancelled',
};

/**
 * The statuses a `template.status_changed` event reports, which an endpoint can choose (ADR-148), in
 * the order Templates lists them: Meta's review states, then the deletion and Meta's limits.
 */
export const WEBHOOK_TEMPLATE_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
  'in_appeal',
  'flagged',
  'archived',
  'deleted',
  'limit_exceeded',
  'locked',
] as const satisfies readonly WebhookTemplateStatus[];

/** How Settings names each template status an endpoint can choose (ADR-148), as Templates does. */
export const WEBHOOK_TEMPLATE_STATUS_LABELS: Record<WebhookTemplateStatus, string> = {
  pending: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
  paused: 'Paused by Meta',
  disabled: 'Disabled by Meta',
  in_appeal: 'In appeal',
  flagged: 'Flagged',
  archived: 'Archived',
  deleted: 'Deleted',
  limit_exceeded: 'Limit exceeded',
  locked: 'Locked',
};

/**
 * The statuses a `conversation.status_changed` change reaches, which an endpoint can choose
 * (ADR-149), in the order the inbox lists them; nothing sets a conversation `pending` (ADR-075).
 */
export const WEBHOOK_CONVERSATION_STATUSES = [
  'open',
  'resolved',
] as const satisfies readonly WebhookConversationStatus[];

/** How Settings names each conversation status an endpoint can choose (ADR-149), as the inbox does. */
export const WEBHOOK_CONVERSATION_STATUS_LABELS: Record<WebhookConversationStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
};

/**
 * The statuses a run ends with, which an endpoint taking `automation.run_ended` can choose
 * (ADR-151), in the order an automation's runs list them; a run's active statuses end nothing.
 */
export const WEBHOOK_RUN_END_STATUSES = [
  'completed',
  'handed_off',
  'taken_over',
  'stopped',
  'failed',
] as const satisfies readonly WebhookRunEndStatus[];

/** How Settings names each way a run ends (ADR-151), as an automation's runs name them. */
export const WEBHOOK_RUN_END_STATUS_LABELS: Record<WebhookRunEndStatus, string> = {
  completed: 'Completed',
  handed_off: 'Handed off',
  taken_over: 'Taken over',
  stopped: 'Stopped',
  failed: 'Failed',
};

/**
 * What starts a live run (ADR-078), which an endpoint taking run events can choose (ADR-183), in the
 * order the automation builder lists triggers; members' test runs send no events.
 */
export const WEBHOOK_RUN_TRIGGERS = [
  'keyword',
  'conversation_started',
  'any_message',
  'store_event',
  'api',
] as const satisfies readonly WebhookRunTrigger[];

/** How Settings names what started a run (ADR-183), as the automation pages name triggers. */
export const WEBHOOK_RUN_TRIGGER_LABELS: Record<WebhookRunTrigger, string> = {
  keyword: 'Keyword',
  conversation_started: 'New conversation',
  any_message: 'Any message',
  store_event: 'Order messages',
  api: 'API',
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
  /** The WhatsApp numbers an endpoint can choose to take the events of (ADR-170). */
  channels: 100,
  /** The teams an endpoint can choose to take the conversations' events of (ADR-174). */
  teams: 50,
  /** The templates an endpoint can choose to take the statuses and changes of (ADR-175). */
  templates: 50,
  /** The members an endpoint can choose to take the assigned conversations' events of (ADR-181). */
  assignees: 50,
  /**
   * An endpoint's OAuth client (ADR-173): its identifier, secret and scope, short enough that the
   * Basic header stays within what the egress client sends, and the longest token kept.
   */
  oauthClientIdLength: 200,
  oauthClientSecretLength: 500,
  oauthScopeLength: 500,
  oauthTokenLength: 4000,
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
 * The events that happen on a WhatsApp number, which an endpoint can take for chosen numbers
 * (ADR-170): a campaign's are on the number it sends from. Consent, contact and template events
 * belong to no number.
 */
export const WEBHOOK_CHANNEL_EVENTS = [
  'message.received',
  'message.status',
  'conversation.status_changed',
  'conversation.assignment_changed',
  'conversation.team_changed',
  'automation.run_started',
  'automation.run_ended',
  'order.received',
  'order.status_changed',
  'campaign.status_changed',
] as const satisfies readonly WebhookEventType[];

/**
 * A WhatsApp number of the company, which an endpoint can choose to take the events of (ADR-170).
 * Any of its numbers can be chosen: they are never deleted, only disconnected.
 */
export interface WebhookChannelChoice {
  id: string;
  /** Its verified name and number as WhatsApp shows them; Meta's id for it until they are known. */
  label: string;
  status: ChannelStatus;
}

/** A WhatsApp number an endpoint takes the events of (ADR-170). */
export interface WebhookEndpointChannel {
  id: string;
  label: string;
  /** Null only for a number the company no longer had, which cannot happen: numbers are kept. */
  status: ChannelStatus | null;
}

/**
 * The events of a conversation, which an endpoint can take for chosen teams' conversations
 * (ADR-174): its messages and its changes. A conversation's team is the one it is in when the event
 * happens; `conversation.team_changed` belongs to the team it left as well.
 */
export const WEBHOOK_TEAM_EVENTS = [
  'message.received',
  'message.status',
  'conversation.status_changed',
  'conversation.assignment_changed',
  'conversation.team_changed',
] as const satisfies readonly WebhookEventType[];

/** A team of the company, which an endpoint can choose to take the conversations' events of. */
export interface WebhookTeamChoice {
  id: string;
  name: string;
}

/** A team an endpoint takes the conversations' events of (ADR-174), as stored. */
export interface WebhookEndpointTeam {
  id: string;
  /** The team's name; null for a team deleted since it was chosen, which matches nothing. */
  name: string | null;
}

/** A team as Settings → Webhooks lists it. */
export const webhookTeamText = (team: WebhookEndpointTeam): string => team.name ?? 'A deleted team';

/** Whether an endpoint with these events takes events of conversations, and can choose teams. */
export function webhookTakesTeamEvents(eventTypes: readonly WebhookEventType[]): boolean {
  return WEBHOOK_TEAM_EVENTS.some((type) => eventTypes.includes(type));
}

/**
 * A member conversations can be assigned to (active, with a role that reads and answers them), whom
 * an endpoint can choose to take the events of the conversations assigned to (ADR-181): the events
 * of `WEBHOOK_TEAM_EVENTS`. A conversation's member is the one it is assigned to when the event
 * happens; `conversation.assignment_changed` belongs to the member it left as well.
 */
export interface WebhookAssigneeChoice {
  id: string;
  name: string;
}

/** A member an endpoint takes the assigned conversations' events of (ADR-181), as stored. */
export interface WebhookEndpointAssignee {
  id: string;
  /** Null only for a membership the company no longer had, which cannot happen: they are kept. */
  name: string | null;
  /**
   * Whether conversations can be assigned to the member now. One who left, was suspended or
   * removed, or lost the role that answers them stays chosen, and matches nothing while holding no
   * conversation.
   */
  assignable: boolean;
}

/** A member as Settings → Webhooks lists them. */
export const webhookAssigneeText = (assignee: WebhookEndpointAssignee): string => {
  const name = assignee.name ?? 'Unknown member';
  return assignee.assignable ? name : `${name} (no longer takes conversations)`;
};

/**
 * The events of a template, which an endpoint can take for chosen templates (ADR-175): the statuses
 * of the messages sent with it, and its own changes.
 */
export const WEBHOOK_TEMPLATE_EVENTS = [
  'message.status',
  'template.status_changed',
] as const satisfies readonly WebhookEventType[];

/**
 * A template of the company, which an endpoint can choose to take the statuses and changes of
 * (ADR-175). Templates are never deleted, so a list never names one that is gone.
 */
export interface WebhookTemplateChoice {
  id: string;
  name: string;
  language: string;
}

/** A template as Settings → Webhooks names it: its name and language. */
export const webhookTemplateText = (template: { name: string; language: string }): string =>
  `${template.name} (${template.language})`;

/** Whether an endpoint with these events takes events of templates, and can choose templates. */
export function webhookTakesTemplateEvents(eventTypes: readonly WebhookEventType[]): boolean {
  return WEBHOOK_TEMPLATE_EVENTS.some((type) => eventTypes.includes(type));
}

/**
 * Where an endpoint gets OAuth access tokens and as which client (ADR-173); its secret is never
 * shown.
 */
export interface WebhookEndpointOAuth {
  tokenUrl: string;
  clientId: string;
  /** The scope it asks for (space-separated values), or none. */
  scope: string | null;
}

/** How Settings → Webhooks describes an endpoint's OAuth client (ADR-173). */
export function webhookOAuthText(oauth: WebhookEndpointOAuth): string {
  const host = webhookHost(oauth.tokenUrl) ?? oauth.tokenUrl;
  const scope = oauth.scope ? `, scope ${oauth.scope}` : '';
  return `OAuth access tokens from ${host}, as client ${oauth.clientId}${scope}`;
}

/** How Settings → Webhooks notes a number that is not active, as Settings → Channels names it. */
export const WEBHOOK_CHANNEL_STATUS_NOTES: Record<ChannelStatus, string | null> = {
  onboarding: 'setting up',
  active: null,
  needs_reconnect: 'reconnect needed',
  disconnected: 'disconnected',
  failed: 'setup failed',
};

/** A number as Settings → Webhooks lists it: its label, and its status unless it is active. */
export function webhookChannelText(channel: {
  label: string;
  status: ChannelStatus | null;
}): string {
  const note = channel.status ? WEBHOOK_CHANNEL_STATUS_NOTES[channel.status] : null;
  return note ? `${channel.label} (${note})` : channel.label;
}

/** Whether an endpoint with these events takes events of numbers, and can choose numbers. */
export function webhookTakesChannelEvents(eventTypes: readonly WebhookEventType[]): boolean {
  return WEBHOOK_CHANNEL_EVENTS.some((type) => eventTypes.includes(type));
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

/**
 * How a failed delivery's last attempt went, to replay only some failures (ADR-159): answered with
 * a server error (HTTP 5xx), refused (HTTP 4xx), answered otherwise (HTTP 1xx or 3xx: redirects are
 * not followed), not validly answered (a timeout, a host or address that failed, a broken
 * connection, an answer too large or without a valid status, an interrupted attempt, or no access
 * token from the endpoint's authorization server, ADR-173, so it was not called), or ended
 * without an attempt (the endpoint was off, or HyFib could not prepare the request). A code says
 * more than a status, as in `webhookErrorLabel`.
 */
export const WEBHOOK_FAILURE_KINDS = [
  'server_error',
  'client_error',
  'other_answer',
  'no_answer',
  'not_attempted',
] as const;

export type WebhookFailureKind = (typeof WEBHOOK_FAILURE_KINDS)[number];

export const WEBHOOK_FAILURE_LABELS: Record<WebhookFailureKind, string> = {
  server_error: 'Server errors (HTTP 5xx)',
  client_error: 'Refused (HTTP 4xx)',
  other_answer: 'Other answers (HTTP 1xx or 3xx)',
  no_answer: 'No valid answer (timeouts, connection errors, no access token)',
  not_attempted: 'Not attempted (endpoint off, request not prepared)',
};

/** The codes that end a delivery without an attempt; `event_gone` ones are never replayed. */
export const WEBHOOK_UNATTEMPTED_ERRORS = ['endpoint_disabled', 'payload_failed'] as const;

/** What a replay of failed deliveries did, in the words Settings → Webhooks shows it. */
export function webhookReplaySummary(result: { queued: number; more: boolean }): string {
  if (result.queued === 0) return 'No failed deliveries to replay from that period.';
  const queued =
    result.queued === 1 ? 'Replaying 1 delivery.' : `Replaying ${result.queued} deliveries.`;
  return result.more
    ? `${queued} More failed deliveries remain: replay again to queue the next ones.`
    : queued;
}

/**
 * What a replay of every endpoint's failed deliveries did (ADR-160), with how many deliveries each
 * endpoint that queued some will receive, by its host, in the words Settings → Webhooks shows it.
 */
export function webhookReplayAllSummary(result: {
  queued: number;
  more: boolean;
  endpoints: readonly { host: string | null; queued: number }[];
}): string {
  if (result.queued === 0) return webhookReplaySummary(result);
  const queued =
    result.queued === 1 ? 'Replaying 1 delivery' : `Replaying ${result.queued} deliveries`;
  const where = result.endpoints
    .filter((e) => e.queued > 0)
    .map((e) => `${e.queued} to ${e.host ?? 'an endpoint'}`)
    .join(', ');
  return result.more
    ? `${queued}: ${where}. More failed deliveries remain: replay again to queue the next ones.`
    : `${queued}: ${where}.`;
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
      return webhookOAuthErrorLabel(code) ?? code;
  }
}

/**
 * What a member sees when an endpoint's OAuth client got no access token (ADR-173), so the
 * endpoint was not called; null for another code.
 */
function webhookOAuthErrorLabel(code: string): string | null {
  if (!code.startsWith('oauth_token_')) return null;
  const rest = code.slice('oauth_token_'.length);
  if (rest === 'invalid') return 'The authorization server gave no usable access token';
  const refused = /^refused(?:_(\d{3}))?$/.exec(rest);
  if (refused) {
    const status = refused[1] ? ` (HTTP ${refused[1]})` : '';
    return `The authorization server refused an access token${status}`;
  }
  // The token request failed as a delivery can: its label, where it has one.
  const label = webhookErrorLabel(rest, null);
  return label && label !== rest
    ? `No access token: ${label.charAt(0).toLowerCase()}${label.slice(1)}`
    : `No access token (${rest})`;
}
