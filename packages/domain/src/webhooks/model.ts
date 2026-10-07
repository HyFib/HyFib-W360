import type {
  AutomationEndReason,
  ChannelStatus,
  ContactSource,
  WebhookCampaignStatus,
  WebhookConsentChange,
  WebhookContactPart,
  WebhookConversationStatus,
  WebhookEventType,
  WebhookMessageSender,
  WebhookMessageStatus,
  WebhookOrderStatus,
  WebhookRunEndStatus,
  WebhookReceivedMessageType,
  WebhookRunTrigger,
  WebhookTemplateStatus,
} from '@w360/db';

export type {
  AutomationEndReason,
  ContactSource,
  WebhookCampaignStatus,
  WebhookConsentChange,
  WebhookContactPart,
  WebhookConversationStatus,
  WebhookEventType,
  WebhookMessageSender,
  WebhookMessageStatus,
  WebhookOrderStatus,
  WebhookRunEndStatus,
  WebhookReceivedMessageType,
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
  'contact.merged',
  'automation.run_started',
  'automation.run_ended',
  'order.received',
  'order.status_changed',
  'campaign.status_changed',
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'deal.owner_changed',
  'deal.status_changed',
  'task.created',
  'task.updated',
  'task.assignee_changed',
  'task.status_changed',
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
    'contact.merged': {
      label: 'Contacts merged',
      description:
        'A member merged two contacts of the same person: the event names the contact merged and deleted, and gives the contact it was merged into.',
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
    'deal.created': {
      label: 'Deal added',
      description: 'A CRM deal was added: by a member, an automation or an API key.',
    },
    'deal.updated': {
      label: 'Deal details',
      description:
        'A CRM deal’s title, value or expected close date changed: by a member or an API key, or by its contact’s erasure, which retitles it.',
    },
    'deal.stage_changed': {
      label: 'Deal stage',
      description:
        'A CRM deal moved to another stage of its pipeline, or to another pipeline: by a member, an automation or an API key.',
    },
    'deal.owner_changed': {
      label: 'Deal owner',
      description:
        'A CRM deal was given to another member, or left without an owner: by a member or an API key.',
    },
    'deal.status_changed': {
      label: 'Deal won, lost or reopened',
      description:
        'A CRM deal was won, lost or reopened: by a member, an automation or an API key.',
    },
    'task.created': {
      label: 'Task added',
      description: 'A CRM task was added: by a member, an automation or an API key.',
    },
    'task.updated': {
      label: 'Task details',
      description:
        'A CRM task’s title, notes, due time or reminder changed: by a member or an API key.',
    },
    'task.assignee_changed': {
      label: 'Task assignee',
      description: 'A CRM task was given to another member: by a member or an API key.',
    },
    'task.status_changed': {
      label: 'Task done, cancelled or reopened',
      description: 'A CRM task was completed, cancelled or reopened: by a member or an API key.',
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

/**
 * Whether an endpoint with these events and parts takes changes of custom fields (ADR-184): it takes
 * `contact.updated` for every part (null) or for `fields` among others, and can choose fields.
 */
export function webhookTakesFieldChanges(
  eventTypes: readonly WebhookEventType[],
  parts: readonly WebhookContactPart[] | null,
): boolean {
  return eventTypes.includes('contact.updated') && (parts === null || parts.includes('fields'));
}

/** A custom field of the company, which an endpoint can choose to take the changes of (ADR-184). */
export interface WebhookFieldChoice {
  key: string;
  label: string;
}

/** A custom field an endpoint takes the changes of (ADR-184), as stored. */
export interface WebhookEndpointField {
  key: string;
  /** The field's label; null for a field deleted since it was chosen. */
  label: string | null;
}

/** A field as Settings → Webhooks lists it: its label and key. */
export const webhookFieldText = (field: WebhookEndpointField): string =>
  field.label === null ? `${field.key} (deleted)` : `${field.label} (${field.key})`;

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

/**
 * The consent changes an endpoint taking `consent.changed` can choose (ADR-189): the event's
 * purpose and action, marketing first, as the contact page lists consent.
 */
export const WEBHOOK_CONSENT_CHANGES = [
  'marketing_opt_in',
  'marketing_opt_out',
  'utility_opt_in',
  'utility_opt_out',
] as const satisfies readonly WebhookConsentChange[];

/** How Settings names a consent change (ADR-189). */
export const WEBHOOK_CONSENT_CHANGE_LABELS: Record<WebhookConsentChange, string> = {
  marketing_opt_in: 'Marketing opt-ins',
  marketing_opt_out: 'Marketing opt-outs',
  utility_opt_in: 'Utility opt-ins',
  utility_opt_out: 'Utility opt-outs',
};

/**
 * Where a contact came from (`contact.source`), which an endpoint taking `contact.created` can
 * choose (ADR-190), in the order contacts' sources are defined.
 */
export const WEBHOOK_CONTACT_SOURCES = [
  'whatsapp',
  'manual',
  'import',
  'api',
  'store',
] as const satisfies readonly ContactSource[];

/** How Settings names where a contact came from (ADR-190). */
export const WEBHOOK_CONTACT_SOURCE_LABELS: Record<ContactSource, string> = {
  whatsapp: 'Wrote on WhatsApp',
  manual: 'Added in the app',
  import: 'Imported from a file',
  api: 'Added through the API',
  store: 'From a store',
};

/**
 * The types a received message has, which an endpoint taking `message.received` can choose
 * (ADR-191), in the order message types are defined; `template` is only sent, never received.
 */
export const WEBHOOK_RECEIVED_MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'button',
  'reaction',
  'order',
  'system',
  'unsupported',
] as const satisfies readonly WebhookReceivedMessageType[];

/** How Settings names a received message's type (ADR-191). */
export const WEBHOOK_RECEIVED_MESSAGE_TYPE_LABELS: Record<WebhookReceivedMessageType, string> = {
  text: 'Text',
  image: 'Photos',
  video: 'Videos',
  audio: 'Audio',
  document: 'Documents',
  sticker: 'Stickers',
  location: 'Locations',
  contacts: 'Contact cards',
  interactive: 'Replies to buttons and lists',
  button: 'Template button replies',
  reaction: 'Reactions',
  order: 'Orders',
  system: 'WhatsApp account updates',
  unsupported: 'Unsupported messages',
};

/**
 * The reasons a run ends for (`run.endReason`) by the end they belong to (ADR-192), as automations
 * define them, in the order of `WEBHOOK_RUN_END_STATUSES`.
 */
export const WEBHOOK_RUN_END_REASONS_BY_END = {
  completed: ['end_node', 'no_next'],
  handed_off: ['handoff_node'],
  taken_over: ['agent_replied', 'assigned', 'take_over', 'api_replied'],
  stopped: [
    'stopped_by_member',
    'conversation_resolved',
    'opted_out',
    'contact_erased',
    'automation_archived',
    'stopped_by_api',
  ],
  failed: [
    'budget_steps',
    'budget_loop',
    'budget_messages',
    'budget_http',
    'expired',
    'send_blocked',
    'send_failed',
    'error',
  ],
} as const satisfies Record<WebhookRunEndStatus, readonly AutomationEndReason[]>;

/**
 * The reasons a run ends for, which an endpoint taking `automation.run_ended` can choose (ADR-192),
 * grouped by end.
 */
export const WEBHOOK_RUN_END_REASONS = WEBHOOK_RUN_END_STATUSES.flatMap(
  (end) => WEBHOOK_RUN_END_REASONS_BY_END[end],
) as unknown as readonly [AutomationEndReason, ...AutomationEndReason[]];

/**
 * Whether an endpoint taking these ends (null: every end) takes runs that end for `reason`
 * (ADR-192): its end reasons narrow the ends it takes, and are chosen only among theirs.
 */
export function webhookRunEndTakesReason(
  ends: readonly WebhookRunEndStatus[] | null,
  reason: AutomationEndReason,
): boolean {
  return (ends ?? WEBHOOK_RUN_END_STATUSES).some((end) =>
    (WEBHOOK_RUN_END_REASONS_BY_END[end] as readonly AutomationEndReason[]).includes(reason),
  );
}

/**
 * The reasons Settings shows ticked for an endpoint's end reasons (ADR-192): those it names, and
 * every reason of an end it names none of (null: of every end), as its events are taken.
 */
export function webhookRunEndReasonsTicked(
  stored: readonly AutomationEndReason[] | null,
): AutomationEndReason[] {
  return WEBHOOK_RUN_END_STATUSES.flatMap((end) => {
    const reasons: readonly AutomationEndReason[] = WEBHOOK_RUN_END_REASONS_BY_END[end];
    const named = reasons.filter((reason) => stored?.includes(reason));
    return named.length > 0 ? named : [...reasons];
  });
}

/**
 * The end reasons Settings sends for the reasons ticked (ADR-192): for each end taken (null: every
 * end), those ticked unless every reason of the end is; null when no end is narrowed.
 */
export function webhookRunEndReasonsChosen(
  ends: readonly WebhookRunEndStatus[] | null,
  ticked: readonly AutomationEndReason[],
): AutomationEndReason[] | null {
  const chosen = WEBHOOK_RUN_END_STATUSES.filter((end) => !ends || ends.includes(end)).flatMap(
    (end) => {
      const reasons: readonly AutomationEndReason[] = WEBHOOK_RUN_END_REASONS_BY_END[end];
      const kept = reasons.filter((reason) => ticked.includes(reason));
      return kept.length < reasons.length ? kept : [];
    },
  );
  return chosen.length > 0 ? chosen : null;
}

/** How Settings names the reason a run ended for (ADR-192), as the run pages say it. */
export const WEBHOOK_RUN_END_REASON_LABELS: Record<AutomationEndReason, string> = {
  end_node: 'Reached an End step',
  no_next: 'Reached a step with nothing after it',
  handoff_node: 'Handed the conversation to people',
  agent_replied: 'A member replied',
  assigned: 'Assigned to a member',
  take_over: 'A member took it over',
  api_replied: 'A reply was sent through the API',
  stopped_by_member: 'Stopped by a member',
  conversation_resolved: 'The conversation was resolved',
  opted_out: 'The customer opted out',
  contact_erased: 'The contact was erased',
  automation_archived: 'The automation was archived',
  stopped_by_api: 'Stopped through the API',
  budget_steps: 'Step limit reached',
  budget_loop: 'Loop limit reached',
  budget_messages: 'Message limit reached',
  budget_http: 'Web request limit reached',
  expired: 'Older than 7 days',
  send_blocked: 'A message could not be sent',
  send_failed: 'A message did not reach the customer',
  error: 'Could not continue',
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
  /** The custom fields an endpoint can choose to take the changes of (ADR-184): every field. */
  contactFields: 50,
  /** The campaigns an endpoint can choose to take the statuses and changes of (ADR-185). */
  campaigns: 50,
  /** The newest campaigns Settings offers to choose from (ADR-185); the API takes any of them. */
  campaignChoices: 200,
  /** The CRM pipelines an endpoint can choose to take the deals' events of (ADR-263). */
  pipelines: 50,
  /** The CRM stages an endpoint can choose to take the deals' events of (ADR-264). */
  stages: 50,
  /** The members an endpoint can choose to take the events of the deals they own (ADR-265). */
  owners: 50,
  /** The members an endpoint can choose to take the events of their assigned tasks (ADR-266). */
  taskAssignees: 50,
  /** The contact tags an endpoint can choose to take the conversations' events of (ADR-267). */
  contactTags: 50,
  /** The conversation tags an endpoint can choose to take the conversations' events of (ADR-273). */
  conversationTags: 50,
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
 * (ADR-170): a campaign's are on the number it sends from. Consent, contact, template, deal and
 * task events belong to no number.
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
 * The events of a campaign, which an endpoint can take for chosen campaigns (ADR-185): the statuses
 * of the messages it sent, and its own changes.
 */
export const WEBHOOK_CAMPAIGN_EVENTS = [
  'message.status',
  'campaign.status_changed',
] as const satisfies readonly WebhookEventType[];

/**
 * A campaign of the company, which an endpoint can choose to take the statuses and changes of
 * (ADR-185). Campaigns are kept until the company is deleted, so a list never names one that is
 * gone.
 */
export interface WebhookCampaignChoice {
  id: string;
  name: string;
  status: WebhookCampaignStatus;
}

/** A campaign an endpoint takes the events of (ADR-185), as stored. */
export interface WebhookEndpointCampaign {
  id: string;
  name: string;
  /** Null only for a campaign that could not be read, which keeping campaigns rules out. */
  status: WebhookCampaignStatus | null;
}

/** A campaign as Settings → Webhooks names it: its name and status. */
export const webhookCampaignText = (campaign: WebhookEndpointCampaign): string =>
  campaign.status === null
    ? campaign.name
    : `${campaign.name} (${WEBHOOK_CAMPAIGN_STATUS_LABELS[campaign.status]})`;

/** Whether an endpoint with these events takes events of campaigns, and can choose campaigns. */
export function webhookTakesCampaignEvents(eventTypes: readonly WebhookEventType[]): boolean {
  return WEBHOOK_CAMPAIGN_EVENTS.some((type) => eventTypes.includes(type));
}

/**
 * The events of a CRM deal, which an endpoint can take for chosen pipelines (ADR-263), stages
 * (ADR-264) and owners (ADR-265): a deal's event belongs to the pipeline and stage it gives
 * (`deal.pipelineId` and `deal.stageId`, as the event's step left the deal), and a move to the
 * pipeline and stage it left as well; to the deal's owner when it happens, and a change of owner
 * (ADR-269) to the owner it left as well. A change of details (ADR-275) is one of them.
 */
export const WEBHOOK_PIPELINE_EVENTS = [
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'deal.owner_changed',
  'deal.status_changed',
] as const satisfies readonly WebhookEventType[];

/**
 * A CRM pipeline the company uses, which an endpoint can choose to take the deals' events of
 * (ADR-263). The API also takes an archived one; Settings lists one only while an endpoint names
 * it.
 */
export interface WebhookPipelineChoice {
  id: string;
  name: string;
}

/** A pipeline an endpoint takes the deals' events of (ADR-263), as stored. */
export interface WebhookEndpointPipeline {
  id: string;
  name: string;
  /**
   * An archived pipeline has no open deal and takes none until it is restored, so it sends nothing
   * meanwhile; it stays chosen. Pipelines are never deleted.
   */
  archived: boolean;
}

/** A pipeline as Settings → Webhooks names it. */
export const webhookPipelineText = (pipeline: { name: string; archived?: boolean }): string =>
  pipeline.archived ? `${pipeline.name} (archived)` : pipeline.name;

/** Whether an endpoint with these events takes deal events, and can choose pipelines and stages. */
export function webhookTakesPipelineEvents(eventTypes: readonly WebhookEventType[]): boolean {
  return WEBHOOK_PIPELINE_EVENTS.some((type) => eventTypes.includes(type));
}

/**
 * A stage in use of a CRM pipeline the company uses, which an endpoint can choose to take the deals'
 * events of (ADR-264). The API also takes a removed stage, or one of an archived pipeline; Settings
 * lists one only while an endpoint names it.
 */
export interface WebhookStageChoice {
  id: string;
  name: string;
  pipelineId: string;
  pipelineName: string;
}

/** A stage an endpoint takes the deals' events of (ADR-264), as stored. */
export interface WebhookEndpointStage {
  id: string;
  name: string;
  pipelineName: string;
  /**
   * A removed stage holds no deal and takes none (stages are archived when removed and cannot be
   * restored), so it sends nothing; it stays chosen. Stages are never deleted.
   */
  removed: boolean;
  /** Its pipeline is archived: no open deal, none until the pipeline is restored. */
  pipelineArchived: boolean;
}

/**
 * A member who can own deals (active, with access to the CRM), whom an endpoint can choose to take
 * the events of the deals they own (ADR-265). A deal's events belong to its owner when they happen.
 */
export interface WebhookOwnerChoice {
  id: string;
  name: string;
}

/** A member an endpoint takes the events of the deals they own (ADR-265), as stored. */
export interface WebhookEndpointOwner {
  id: string;
  /** Null only for a membership the company no longer had, which cannot happen: they are kept. */
  name: string | null;
  /**
   * Whether the member can own deals now. One who left, was suspended or removed, or lost access to
   * the CRM stays chosen, and matches only the deals they still own.
   */
  active: boolean;
}

/** A deal owner as Settings → Webhooks lists them. */
export const webhookOwnerText = (owner: WebhookEndpointOwner): string => {
  const name = owner.name ?? 'Unknown member';
  return owner.active ? name : `${name} (no longer uses the CRM)`;
};

/** A stage as Settings → Webhooks names it: its pipeline and name. */
export const webhookStageText = (stage: {
  name: string;
  pipelineName: string;
  removed?: boolean;
  pipelineArchived?: boolean;
}): string => {
  const text = `${stage.pipelineName}: ${stage.name}`;
  if (stage.removed) return `${text} (removed)`;
  return stage.pipelineArchived ? `${text} (archived pipeline)` : text;
};

/**
 * The events of a CRM task, which an endpoint can take for chosen assignees (ADR-266): a task's
 * events belong to the member it is assigned to when they happen, and a change of assignee
 * (ADR-274) to the member it left as well; a change of details (ADR-276) is one of them. Tasks are
 * assigned to the members who can own deals, so an assignee is chosen and stored as a deal owner
 * is (`WebhookOwnerChoice`, `WebhookEndpointOwner`, `webhookOwnerText`).
 */
export const WEBHOOK_TASK_EVENTS = [
  'task.created',
  'task.updated',
  'task.assignee_changed',
  'task.status_changed',
] as const satisfies readonly WebhookEventType[];

/** Whether an endpoint with these events takes task events, and can choose assignees. */
export function webhookTakesTaskEvents(eventTypes: readonly WebhookEventType[]): boolean {
  return WEBHOOK_TASK_EVENTS.some((type) => eventTypes.includes(type));
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
