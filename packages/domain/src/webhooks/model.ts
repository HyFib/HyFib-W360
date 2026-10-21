import type {
  AutomationEndReason,
  ChannelStatus,
  ContactFieldType,
  ContactSource,
  WebhookCampaignStatus,
  WebhookCodAnswer,
  WebhookOrderMessageEvent,
  WebhookOrderMessageSkipReason,
  WebhookCartReminder,
  WebhookCartReminderSkipReason,
  WebhookCampaignSkipReason,
  WebhookOAuthClientAuth,
  WebhookOAuthKeyAlgorithm,
  SkipReason,
  WebhookConsentChange,
  WebhookContactPart,
  WebhookConversationStatus,
  WebhookCrmChangeMaker,
  WebhookEventType,
  WebhookMessageSender,
  WebhookMessageStatus,
  WebhookOrderChangeMaker,
  WebhookOrderStatus,
  WebhookPaymentLinkStatus,
  WebhookDealStatus,
  WebhookTaskStatus,
  WebhookDealDetail,
  WebhookTaskDetail,
  WebhookRunEndStatus,
  WebhookRunStepOutcome,
  WebhookRunStepNodeType,
  WebhookReceivedMessageType,
  WebhookRunTrigger,
  WebhookSurveyScore,
  WebhookTemplateStatus,
} from '@w360/db';
import {
  coerceFieldValue,
  validDate,
  type AttributeValue,
  type FieldShape,
} from '../contacts/fields';
import type { CartEvent, StoreMessageSkipReason } from '../stores/messages-model';

export type {
  AutomationEndReason,
  ContactSource,
  WebhookCampaignStatus,
  WebhookCodAnswer,
  WebhookOrderMessageEvent,
  WebhookOrderMessageSkipReason,
  WebhookCartReminder,
  WebhookCartReminderSkipReason,
  WebhookCampaignSkipReason,
  WebhookOAuthClientAuth,
  WebhookOAuthKeyAlgorithm,
  WebhookConsentChange,
  WebhookContactPart,
  WebhookConversationStatus,
  WebhookCrmChangeMaker,
  WebhookEventType,
  WebhookMessageSender,
  WebhookMessageStatus,
  WebhookOrderChangeMaker,
  WebhookOrderStatus,
  WebhookPaymentLinkStatus,
  WebhookDealStatus,
  WebhookTaskStatus,
  WebhookDealDetail,
  WebhookTaskDetail,
  WebhookRunEndStatus,
  WebhookRunStepOutcome,
  WebhookRunStepNodeType,
  WebhookReceivedMessageType,
  WebhookRunTrigger,
  WebhookSurveyScore,
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
  'satisfaction_survey.answered',
  'contact.created',
  'contact.updated',
  'contact.erased',
  'contact.merged',
  'automation.run_started',
  'automation.run_ended',
  'automation.run_step',
  'order.received',
  'order.status_changed',
  'payment_link.status_changed',
  'store_order.cod_answered',
  'store_order.message_skipped',
  'store_order.message_sent',
  'store_checkout.reminder_skipped',
  'store_checkout.reminder_sent',
  'campaign.status_changed',
  'campaign.recipient_skipped',
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'deal.owner_changed',
  'deal.status_changed',
  'task.created',
  'task.updated',
  'task.assignee_changed',
  'task.status_changed',
  'note.created',
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
    'satisfaction_survey.answered': {
      label: 'Satisfaction survey answered',
      description:
        'A customer answered the satisfaction survey sent when a member resolved their conversation, by tapping one of its three buttons.',
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
        'An automation started in a conversation: from a customer message, a store’s order event, a call through the API or an enrolment of the contact (by a member or an API key). Members’ test runs are not sent.',
    },
    'automation.run_ended': {
      label: 'Automation ended',
      description:
        'An automation run ended: completed, handed to people, taken over, stopped or failed, with the reason.',
    },
    'automation.run_step': {
      label: 'Automation step',
      description:
        'An automation run took a step: it sent a message, asked a question and had it answered, took a branch, waited, called a web address, changed a contact or the CRM, or was stopped, taken over or failed. Members’ test runs are not sent.',
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
    'payment_link.status_changed': {
      label: 'Payment Link status',
      description:
        'A Payment Link for a WhatsApp order was created at Razorpay (sent in the chat or not), partly paid, paid, expired or cancelled, or Razorpay could not create it.',
    },
    'store_order.cod_answered': {
      label: 'Cash on delivery answered',
      description:
        'A customer confirmed or cancelled a cash on delivery order from a connected store by tapping a button of its confirmation message, or changed their answer.',
    },
    'store_order.message_skipped': {
      label: 'Order message skipped',
      description:
        'A connected store’s message about an order (placed, cash on delivery confirmation, shipped, delivered or cancelled) was not sent: a test order, an event HyFib saw too late, an order placed message the cash on delivery confirmation replaced, or a check that failed when it was due, such as a customer who opted out or an order without a phone number.',
    },
    'store_order.message_sent': {
      label: 'Order message sent',
      description:
        'A connected store’s message about an order (placed, cash on delivery confirmation, shipped, delivered or cancelled) went out: its template message was queued for WhatsApp, whose statuses follow as message status events, or the automation its rule chose started.',
    },
    'store_checkout.reminder_skipped': {
      label: 'Cart reminder skipped',
      description:
        'A connected Shopify store’s cart reminder (the first or the second) about a checkout a customer left was not sent when it was due: the checkout was completed or too old, an order was placed since, the first reminder was not sent, or a check failed, such as a customer without a number or marketing opt-in, or the frequency cap.',
    },
    'store_checkout.reminder_sent': {
      label: 'Cart reminder sent',
      description:
        'A connected Shopify store’s cart reminder (the first or the second) about a checkout a customer left went out: its template message was queued for WhatsApp, whose statuses follow as message status events.',
    },
    'campaign.status_changed': {
      label: 'Campaign status',
      description:
        'A campaign was submitted for approval, sent back to draft, scheduled, started, paused, resumed, completed or cancelled, by a member or as it ran.',
    },
    'campaign.recipient_skipped': {
      label: 'Campaign recipient skipped',
      description:
        'A campaign did not send its message to a contact in its audience: the contact had no number, was suppressed, opted out, had no marketing opt-in, was missing a variable’s value or was erased, or the frequency cap, a spending cap without a price for their number or the end of the sending period stopped it. Those skipped when the audience was taken are reported when the campaign starts.',
    },
    'deal.created': {
      label: 'Deal added',
      description: 'A CRM deal was added: by a member, an automation or an API key.',
    },
    'deal.updated': {
      label: 'Deal details',
      description:
        'A CRM deal’s title, value, expected close date, custom field values or products changed: by a member, a deal import or an API key, its custom field values by an automation too, its products when a member or an API key adds or removes one, or by its contact’s erasure, which retitles it and clears its values.',
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
    'note.created': {
      label: 'Note added',
      description:
        'A note was added to a CRM contact’s or deal’s timeline: by a member or an API key.',
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

/**
 * A custom field of the company, which an endpoint can choose to take the changes of (ADR-184) or
 * name values of (ADR-332, read by its type).
 */
export interface WebhookFieldChoice {
  key: string;
  label: string;
  type: ContactFieldType;
  /** A choice field's options, in order; null for every other type (ADR-407). */
  options: string[] | null;
}

/** A field as the readers of Settings → Webhooks' inputs need it; options only for a choice. */
type WebhookInputField = {
  label: string;
  type: ContactFieldType;
  options?: readonly string[] | null;
};

const shape = (field: WebhookInputField): FieldShape => ({
  label: field.label,
  type: field.type,
  options: field.options ?? null,
});

/** A custom field an endpoint takes the changes of (ADR-184), as stored. */
export interface WebhookEndpointField {
  key: string;
  /** The field's label; null for a field deleted since it was chosen. */
  label: string | null;
}

/** A field as Settings → Webhooks lists it: its label and key. */
export const webhookFieldText = (field: WebhookEndpointField): string =>
  field.label === null ? `${field.key} (deleted)` : `${field.label} (${field.key})`;

/**
 * A condition on a custom field whose added and changed contacts an endpoint takes, one of three
 * kinds: an exact value of the field's type, as contacts keep them (text, a number, a date as
 * YYYY-MM-DD, or true or false for yes/no; ADR-332); a word or phrase a text field's value contains,
 * whatever its case; or a range of a number or date field's values, either end or both, the ends
 * included (ADR-335).
 */
export type WebhookContactFieldValue =
  | { key: string; value: AttributeValue }
  | { key: string; contains: string }
  | { key: string; atLeast?: number | string; atMost?: number | string };

/** A condition's range, when it is one (ADR-335). */
export type WebhookContactFieldRange = {
  key: string;
  atLeast?: number | string;
  atMost?: number | string;
};

/** Whether a condition is an exact value, a word or a range. */
export const webhookContactFieldKind = (
  pair: WebhookContactFieldValue,
): 'value' | 'contains' | 'range' =>
  'value' in pair ? 'value' : 'contains' in pair ? 'contains' : 'range';

/**
 * What tells a condition apart from the others (ADR-332, ADR-335): text compared whatever its case,
 * as the database compares it with the contacts' values, numbers as numbers, and a range by its
 * ends and their kinds.
 */
export function webhookContactFieldValueId(pair: WebhookContactFieldValue): string {
  if ('value' in pair) {
    return `${pair.key}:${typeof pair.value}:${
      typeof pair.value === 'string' ? pair.value.toLowerCase() : String(pair.value)
    }`;
  }
  if ('contains' in pair) return `${pair.key}:contains:${pair.contains.toLowerCase()}`;
  // The ends' kinds too, so that 10000 and "10000" are not one end.
  const end = (value: number | string | undefined) =>
    value === undefined ? '' : `${typeof value}:${value}`;
  return `${pair.key}:range:${end(pair.atLeast)}:${end(pair.atMost)}`;
}

/** A value as Settings → Webhooks shows it: yes or no for true and false, else as kept. */
export const webhookFieldValueText = (value: AttributeValue): string =>
  typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);

/**
 * A condition as Settings → Webhooks shows it (ADR-335): a value as kept, a word in quotes after
 * "containing", and a range from its start to its end, "at least" or "from" its start alone and
 * "at most" or "until" its end alone, as numbers and dates read.
 */
export function webhookContactFieldConditionText(pair: WebhookContactFieldValue): string {
  if ('value' in pair) return webhookFieldValueText(pair.value);
  if ('contains' in pair) return `containing "${pair.contains}"`;
  const date = typeof (pair.atLeast ?? pair.atMost) === 'string';
  if (pair.atLeast !== undefined && pair.atMost !== undefined) {
    return `${pair.atLeast} to ${pair.atMost}`;
  }
  if (pair.atLeast !== undefined) return `${date ? 'from' : 'at least'} ${pair.atLeast}`;
  return `${date ? 'until' : 'at most'} ${pair.atMost ?? ''}`;
}

/**
 * The conditions an endpoint takes the added and changed contacts of, as Settings → Webhooks names
 * them (ADR-332, ADR-335): each field by its label, or by its key and "(deleted)" for one deleted
 * since, with its values, words and ranges in the order given.
 */
export function webhookContactEventFieldValuesText(
  pairs: readonly WebhookContactFieldValue[],
  labels: ReadonlyMap<string, string>,
): string {
  const byKey = new Map<string, string[]>();
  for (const pair of pairs) {
    byKey.set(pair.key, [...(byKey.get(pair.key) ?? []), webhookContactFieldConditionText(pair)]);
  }
  return [...byKey]
    .map(([key, texts]) => `${labels.get(key) ?? `${key} (deleted)`}: ${texts.join(', ')}`)
    .join('; ');
}

/**
 * Whether Settings → Webhooks can show a stored value in its field's input and read it back as it
 * is (ADR-332): a boolean for a yes/no field, a number for a number field, a real date for a date
 * field and text on one line for a text field. Any other value the endpoint holds (of a field
 * deleted and added again with another type, or text on several lines given through the API) is
 * listed apart and kept as it is, so saving the form never turns it into another value. A choice
 * field's value is ticked among its options (ADR-407), so it is editable while it is one of them,
 * written as the field lists it.
 */
export function webhookFieldValueEditable(
  type: ContactFieldType,
  value: AttributeValue,
  options: readonly string[] | null = null,
): boolean {
  switch (type) {
    case 'choice':
      return typeof value === 'string' && (options ?? []).includes(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    case 'date':
      return typeof value === 'string' && validDate(value);
    case 'text':
      return typeof value === 'string' && !/[\r\n]/.test(value);
  }
}

/**
 * Whether Settings → Webhooks can show a stored condition in its field's inputs as it is (ADR-335):
 * a value as `webhookFieldValueEditable` says; a word on one line for a text field; a range of
 * numbers for a number field or of real dates for a date field. Settings shows one range a field,
 * so a field's other ranges are listed apart and kept as they are (decided by the form).
 */
export function webhookFieldConditionEditable(
  type: ContactFieldType,
  pair: WebhookContactFieldValue,
  options: readonly string[] | null = null,
): boolean {
  if ('value' in pair) return webhookFieldValueEditable(type, pair.value, options);
  if ('contains' in pair) return type === 'text' && !/[\r\n]/.test(pair.contains);
  const ends = [pair.atLeast, pair.atMost].filter((end) => end !== undefined);
  if (type === 'number') return ends.every((end) => typeof end === 'number');
  if (type === 'date') return ends.every((end) => typeof end === 'string' && validDate(end));
  return false;
}

/**
 * The values Settings → Webhooks reads for a text, number or date field (ADR-332): one a line,
 * each read as a member's entry of the field is (`coerceFieldValue`, which trims it, a carriage
 * return included), blank lines skipped. Yes/no and choice fields are ticked instead.
 */
export function webhookFieldValuesFromLines(
  field: WebhookInputField,
  text: string,
): { ok: true; values: AttributeValue[] } | { ok: false; message: string } {
  const values: AttributeValue[] = [];
  for (const line of text.split('\n')) {
    const read = coerceFieldValue(shape(field), line);
    if (!read.ok) return read;
    if (read.value !== null) values.push(read.value);
  }
  return { ok: true, values };
}

/**
 * The words Settings → Webhooks reads for a text field (ADR-335): one a line, trimmed as a text
 * value is, blank lines skipped.
 */
export function webhookFieldWordsFromLines(
  field: { label: string },
  text: string,
): { ok: true; words: string[] } | { ok: false; message: string } {
  const words: string[] = [];
  for (const line of text.split('\n')) {
    const read = coerceFieldValue({ label: field.label, type: 'text', options: null }, line);
    if (!read.ok) return read;
    if (typeof read.value === 'string') words.push(read.value);
  }
  return { ok: true, words };
}

/**
 * The range Settings → Webhooks reads for a number or date field (ADR-335): its start and its end
 * read as a member's entry of the field is, either left blank; null when both are. The service
 * checks that the start is not after the end.
 */
export function webhookFieldRangeFromInputs(
  field: { key: string; label: string; type: ContactFieldType },
  start: string,
  end: string,
): { ok: true; range: WebhookContactFieldRange | null } | { ok: false; message: string } {
  const read = (
    raw: string,
  ): { ok: true; end: number | string | undefined } | { ok: false; message: string } => {
    if (field.type !== 'number' && field.type !== 'date') {
      return { ok: false, message: `${field.label} takes no range.` };
    }
    const value = coerceFieldValue(shape(field), raw);
    if (!value.ok) return value;
    if (typeof value.value === 'boolean') {
      return { ok: false, message: `${field.label} takes no range.` };
    }
    return { ok: true, end: value.value ?? undefined };
  };
  const from = read(start);
  if (!from.ok) return from;
  const to = read(end);
  if (!to.ok) return to;
  if (from.end === undefined && to.end === undefined) return { ok: true, range: null };
  return {
    ok: true,
    range: {
      key: field.key,
      ...(from.end !== undefined ? { atLeast: from.end } : {}),
      ...(to.end !== undefined ? { atMost: to.end } : {}),
    },
  };
}

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
 * Who made the order status changes `order.status_changed` reports, which an endpoint can choose
 * (ADR-322), in the order Settings lists them, as the event's `changedBy` names them.
 */
export const WEBHOOK_ORDER_CHANGE_MAKERS = [
  'member',
  'api',
  'payment_link',
] as const satisfies readonly WebhookOrderChangeMaker[];

/** How Settings names each maker of an order status change an endpoint can choose (ADR-322). */
export const WEBHOOK_ORDER_CHANGE_MAKER_LABELS: Record<WebhookOrderChangeMaker, string> = {
  member: 'Members',
  api: 'API keys',
  payment_link: 'Payment Links',
};

/**
 * The statuses a `payment_link.status_changed` event reports, which an endpoint can choose
 * (ADR-308), in the order Orders lists them; a link that is `creating` sends no event.
 */
export const WEBHOOK_PAYMENT_LINK_STATUSES = [
  'created',
  'partially_paid',
  'paid',
  'expired',
  'cancelled',
  'failed',
] as const satisfies readonly WebhookPaymentLinkStatus[];

/** How Settings names each Payment Link status an endpoint can choose (ADR-308), as Orders does. */
export const WEBHOOK_PAYMENT_LINK_STATUS_LABELS: Record<WebhookPaymentLinkStatus, string> = {
  created: 'Waiting for payment',
  partially_paid: 'Partly paid',
  paid: 'Paid',
  expired: 'Expired',
  cancelled: 'Cancelled',
  failed: 'Not created',
};

/**
 * The answers a `store_order.cod_answered` event reports, which an endpoint can choose (ADR-349),
 * in the order the store's confirmation offers them.
 */
export const WEBHOOK_COD_ANSWERS = [
  'confirmed',
  'cancelled',
] as const satisfies readonly WebhookCodAnswer[];

/** How Settings names each answer an endpoint can choose (ADR-349), as an order's page does. */
export const WEBHOOK_COD_ANSWER_LABELS: Record<WebhookCodAnswer, string> = {
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
};

/**
 * The order messages a `store_order.message_skipped` or `store_order.message_sent` event is about,
 * which an endpoint can choose (ADR-352, ADR-353), in the order a store's order messages list them.
 */
export const WEBHOOK_ORDER_MESSAGE_EVENTS = [
  'order_placed',
  'cod_confirmation',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
] as const satisfies readonly WebhookOrderMessageEvent[];

/** How Settings names each order message an endpoint can choose (ADR-352), as Stores does. */
export const WEBHOOK_ORDER_MESSAGE_EVENT_LABELS: Record<WebhookOrderMessageEvent, string> = {
  order_placed: 'Order placed',
  cod_confirmation: 'Cash on delivery confirmation',
  order_shipped: 'Order shipped',
  order_delivered: 'Order delivered',
  order_cancelled: 'Order cancelled',
};

/**
 * The reasons a `store_order.message_skipped` event gives, which an endpoint can choose (ADR-354),
 * in the order a store's Messages page explains them: every reason a store's message can be
 * skipped for but the six that concern cart reminders only, which only
 * `store_checkout.reminder_skipped` gives (ADR-355).
 */
export const WEBHOOK_ORDER_MESSAGE_SKIP_REASONS = [
  'test_order',
  'too_late',
  'cash_on_delivery',
  'rule_disabled',
  'store_disconnected',
  'no_opt_in',
  'order_deleted',
  'order_cancelled',
  'customer_erased',
  'no_phone',
  'contact_erased',
  'suppressed',
  'opted_out',
  'no_marketing_opt_in',
  'template_unavailable',
  'channel_unavailable',
  'missing_variable',
  'template_changed',
  'frequency_capped',
  'automation_unavailable',
  'conversation_assigned',
  'automation_busy',
  'automation_limit',
  'not_in_plan',
  'automation_quota',
] as const satisfies readonly WebhookOrderMessageSkipReason[];

/**
 * The cart reminders a `store_checkout.reminder_skipped` or `store_checkout.reminder_sent` event is
 * about (ADR-355), which an endpoint can choose (ADR-361): a Shopify store's first reminder about a
 * checkout a customer left, and the second.
 */
export const WEBHOOK_CART_REMINDERS = [
  'cart_reminder',
  'cart_second_reminder',
] as const satisfies readonly (WebhookCartReminder & CartEvent)[];

/**
 * The reasons a `store_checkout.reminder_skipped` event gives (ADR-355), in the order a store's
 * Messages page explains them: the checks a cart reminder goes through when it is due. Never the
 * reasons only order messages are skipped for (a test order, a late or replaced event, the order
 * deleted or cancelled, an automation's): reminders are recorded waiting and send no automation.
 * Nor `checkout_deleted`: a reminder is deleted with its checkout, so none is ever skipped for it.
 */
export const WEBHOOK_CART_REMINDER_SKIP_REASONS = [
  'rule_disabled',
  'store_disconnected',
  'no_opt_in',
  'customer_erased',
  'no_phone',
  'contact_erased',
  'suppressed',
  'opted_out',
  'no_marketing_opt_in',
  'template_unavailable',
  'channel_unavailable',
  'missing_variable',
  'template_changed',
  'checkout_completed',
  'order_placed',
  'first_reminder_not_sent',
  'cart_too_old',
  'not_marketing_template',
  'frequency_capped',
  'not_in_plan',
] as const satisfies readonly (WebhookCartReminderSkipReason & StoreMessageSkipReason)[];

/**
 * The reasons a `campaign.recipient_skipped` event gives (ADR-358), which an endpoint can choose
 * (ADR-359), in the order 0006 lists them: every reason a campaign skips a recipient for, when its
 * audience is taken (no number, suppressed, opted out, no marketing opt-in, a missing variable) or
 * as it sends (those again, an erased contact, the frequency cap, no price under a spending cap,
 * the end of its sending period).
 */
export const WEBHOOK_CAMPAIGN_SKIP_REASONS = [
  'contact_erased',
  'no_phone',
  'suppressed',
  'opted_out',
  'no_marketing_opt_in',
  'missing_variable',
  'frequency_capped',
  'cost_unknown',
  'expired',
] as const satisfies readonly (WebhookCampaignSkipReason & SkipReason)[];

/**
 * The statuses a `deal.status_changed` event reports, which an endpoint can choose (ADR-309), in
 * the order the CRM lists them: `open` is a deal reopened.
 */
export const WEBHOOK_DEAL_STATUSES = [
  'open',
  'won',
  'lost',
] as const satisfies readonly WebhookDealStatus[];

/** How Settings names each deal status an endpoint can choose (ADR-309): the change it reports. */
export const WEBHOOK_DEAL_STATUS_LABELS: Record<WebhookDealStatus, string> = {
  open: 'Reopened',
  won: 'Won',
  lost: 'Lost',
};

/**
 * The statuses a `task.status_changed` event reports, which an endpoint can choose (ADR-309), in
 * the order the CRM lists them: `open` is a task reopened.
 */
export const WEBHOOK_TASK_STATUSES = [
  'open',
  'done',
  'cancelled',
] as const satisfies readonly WebhookTaskStatus[];

/** How Settings names each task status an endpoint can choose (ADR-309): the change it reports. */
export const WEBHOOK_TASK_STATUS_LABELS: Record<WebhookTaskStatus, string> = {
  open: 'Reopened',
  done: 'Done',
  cancelled: 'Cancelled',
};

/**
 * The details whose change a `deal.updated` endpoint can choose (ADR-310), in the order the event's
 * `changes` lists them.
 */
export const WEBHOOK_DEAL_DETAILS = [
  'title',
  'valueMinor',
  'expectedCloseOn',
  'fields',
  'items',
] as const satisfies readonly WebhookDealDetail[];

/**
 * How Settings names each deal detail an endpoint can choose (ADR-310), as the deal form does;
 * `fields` is any custom field value (ADR-390) and `items` any product added or removed (ADR-397),
 * as the deal's timeline names them.
 */
export const WEBHOOK_DEAL_DETAIL_LABELS: Record<WebhookDealDetail, string> = {
  title: 'Title',
  valueMinor: 'Value',
  expectedCloseOn: 'Expected close date',
  fields: 'Custom fields',
  items: 'Products',
};

/**
 * The details whose change a `task.updated` endpoint can choose (ADR-310), in the order the event's
 * `changes` lists them.
 */
export const WEBHOOK_TASK_DETAILS = [
  'title',
  'notes',
  'dueAt',
  'remindAt',
] as const satisfies readonly WebhookTaskDetail[];

/** How Settings names each task detail an endpoint can choose (ADR-310). */
export const WEBHOOK_TASK_DETAIL_LABELS: Record<WebhookTaskDetail, string> = {
  title: 'Title',
  notes: 'Notes',
  dueAt: 'Due time',
  remindAt: 'Reminder',
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
 * The outcomes a run's step can have, which an endpoint taking `automation.run_step` can choose
 * (ADR-327), in the order the run's log names them (as the event's `step.outcome` does).
 */
export const WEBHOOK_RUN_STEP_OUTCOMES = [
  'started',
  'sent',
  'asked',
  'answered',
  'retried',
  'timed_out',
  'branched',
  'updated',
  'waiting',
  'resumed',
  'handed_off',
  'completed',
  'failed',
  'stopped',
  'taken_over',
  'requested',
  'responded',
  'created',
  'skipped',
  'moved',
  'closed',
] as const satisfies readonly WebhookRunStepOutcome[];

/** How Settings names each step outcome an endpoint can choose (ADR-327), as a run's page does. */
export const WEBHOOK_RUN_STEP_OUTCOME_LABELS: Record<WebhookRunStepOutcome, string> = {
  started: 'Started',
  sent: 'Sent a message',
  asked: 'Asked the customer',
  answered: 'Got an answer',
  retried: 'Asked again',
  timed_out: 'No reply in time',
  branched: 'Checked a condition',
  updated: 'Updated details',
  waiting: 'Started waiting',
  resumed: 'Wait ended',
  handed_off: 'Handed off',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  taken_over: 'Taken over',
  requested: 'Made a web request',
  responded: 'Web request finished',
  created: 'Created in the CRM',
  skipped: 'Skipped the step',
  moved: 'Moved the deal',
  closed: 'Closed the deal',
};

/**
 * The kinds of automation node whose steps an endpoint taking `automation.run_step` can choose
 * (ADR-328), in the order the automation builder lists them (as the event's `step.nodeType` names
 * them), then `outside_node` for the steps outside a node (the run starting, being stopped or taken
 * over, or failing between steps), whose `step.nodeType` is null. Every one of them takes every
 * step, as null does.
 */
export const WEBHOOK_RUN_STEP_NODE_TYPES = [
  'send_text',
  'ask_buttons',
  'ask_text',
  'send_template',
  'ask_template',
  'send_flow',
  'send_products',
  'condition',
  'update_contact',
  'update_conversation',
  'http_request',
  'create_task',
  'create_deal',
  'move_deal',
  'close_deal',
  'update_deal_fields',
  'wait',
  'handoff',
  'end',
  'outside_node',
] as const satisfies readonly WebhookRunStepNodeType[];

/**
 * How Settings names each kind of step an endpoint can choose (ADR-328), as the automation builder
 * names its nodes.
 */
export const WEBHOOK_RUN_STEP_NODE_TYPE_LABELS: Record<WebhookRunStepNodeType, string> = {
  send_text: 'Send a message',
  ask_buttons: 'Ask with buttons',
  ask_text: 'Ask a question',
  send_template: 'Send a template',
  ask_template: 'Ask with a template',
  send_flow: 'Send a form',
  send_products: 'Send products',
  condition: 'Condition',
  update_contact: 'Update contact',
  update_conversation: 'Tag the conversation',
  http_request: 'Call a web address',
  create_task: 'Create a CRM task',
  create_deal: 'Create a CRM deal',
  move_deal: 'Move the CRM deal',
  close_deal: 'Close the CRM deal',
  update_deal_fields: 'Update deal fields',
  wait: 'Wait',
  handoff: 'Hand off to people',
  end: 'End',
  outside_node:
    'Outside a step (the run starting, being stopped or taken over, or failing between steps)',
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
  'campaign_reply',
] as const satisfies readonly WebhookRunTrigger[];

/** How Settings names what started a run (ADR-183), as the automation pages name triggers. */
export const WEBHOOK_RUN_TRIGGER_LABELS: Record<WebhookRunTrigger, string> = {
  keyword: 'Keyword',
  conversation_started: 'New conversation',
  any_message: 'Any message',
  store_event: 'Order messages',
  api: 'API or a member’s enrolment',
  campaign_reply: 'Reply to a campaign',
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
 * A word or phrase an endpoint looks for in the received messages it takes (ADR-337), as Settings
 * and the API read it: trimmed, 1 to 100 characters, and without control characters, a line break
 * among them, nor the line and paragraph separators. The database's check is looser (only C0 and
 * C1 control characters, and a space at either end), so this is the rule.
 */
export function webhookMessageWord(
  raw: string,
): { ok: true; word: string } | { ok: false; message: string } {
  const word = raw.trim();
  if (!word) return { ok: false, message: 'Give each word or phrase as text, not blank.' };
  if (word.length > WEBHOOK_LIMITS.messageWordLength) {
    return {
      ok: false,
      message: `Give words and phrases of at most ${WEBHOOK_LIMITS.messageWordLength} characters.`,
    };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(word)) {
    return {
      ok: false,
      message: 'Give words and phrases without line breaks or control characters.',
    };
  }
  return { ok: true, word };
}

/**
 * The words and phrases Settings → Webhooks takes for received messages (ADR-337), one a line,
 * each read by `webhookMessageWord`, blank lines skipped, at most 50 given and each kept once
 * whatever its case.
 */
export function webhookMessageWordsFromLines(
  text: string,
): { ok: true; words: string[] } | { ok: false; message: string } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  // Counted as given, before a word given twice is dropped, as the services count a list.
  if (lines.length > WEBHOOK_LIMITS.messageWords) {
    return {
      ok: false,
      message: `Give at most ${WEBHOOK_LIMITS.messageWords} words and phrases.`,
    };
  }
  const words: string[] = [];
  for (const line of lines) {
    const read = webhookMessageWord(line);
    if (!read.ok) return read;
    if (!words.some((word) => word.toLowerCase() === read.word.toLowerCase())) {
      words.push(read.word);
    }
  }
  return { ok: true, words };
}

/** Words and phrases as Settings → Webhooks names them (ADR-337): each in quotes. */
export const webhookMessageWordsText = (words: readonly string[]): string =>
  words.map((word) => `"${word}"`).join(', ');

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
  /**
   * The stores an endpoint can choose to take the cash on delivery answers (ADR-349), the skipped
   * (ADR-352) and sent (ADR-353) order messages and the cart reminders (ADR-355) of: a company has at
   * most 5 at once, and a store removed since it was chosen stays on the list.
   */
  stores: 20,
  /** The newest campaigns Settings offers to choose from (ADR-185); the API takes any of them. */
  campaignChoices: 200,
  /**
   * The largest body a delivery sends, in bytes: 256 KiB, written out so that its type is the
   * number itself (`WebhookEgressClient`) (ADR-395; 64 KiB, the egress guard's default, before). A deal event with 50 products of the longest names fits with room to spare.
   */
  requestBytes: 262_144,
  /** The CRM pipelines an endpoint can choose to take the deals' events of (ADR-263). */
  pipelines: 50,
  /** The CRM stages an endpoint can choose to take the deals' events of (ADR-264). */
  stages: 50,
  /** The members an endpoint can choose to take the events of the deals they own (ADR-265). */
  owners: 50,
  /** The members an endpoint can choose to take the events of their assigned tasks (ADR-266). */
  taskAssignees: 50,
  /** The CRM pipelines an endpoint can choose to take the events of their deals' tasks (ADR-303). */
  taskPipelines: 50,
  /** The CRM stages an endpoint can choose to take the events of their deals' tasks (ADR-304). */
  taskStages: 50,
  /** The members an endpoint can choose to take the events of the tasks of their deals (ADR-304). */
  taskDealOwners: 50,
  /** The CRM pipelines whose deals' notes' events an endpoint can choose to take (ADR-305). */
  notePipelines: 50,
  /** The CRM stages whose deals' notes' events an endpoint can choose to take (ADR-305). */
  noteStages: 50,
  /** The members whose deals' notes' events an endpoint can choose to take (ADR-305). */
  noteDealOwners: 50,
  /** The members credited with satisfaction survey answers an endpoint can choose (ADR-311). */
  surveyAssignees: 50,
  /** The teams whose conversations' survey answers an endpoint can choose (ADR-311). */
  surveyTeams: 50,
  /** The contact tags whose survey answers an endpoint can choose (ADR-312). */
  surveyContactTags: 50,
  /** The conversation tags whose survey answers an endpoint can choose (ADR-312). */
  surveyConversationTags: 50,
  /** The contact tags whose added and changed contacts an endpoint can choose (ADR-316). */
  contactEventTags: 50,
  /** The custom field values whose added and changed contacts an endpoint can choose (ADR-332). */
  contactEventFieldValues: 50,
  /**
   * And their bytes as JSON in all (ADR-332), set for the 8 KiB of metadata an audit entry holds;
   * since ADR-336 the entry as a whole is kept within it (`webhookEndpointAuditMetadata`).
   */
  contactEventFieldValuesBytes: 4000,
  /** The API keys whose automation runs an endpoint can choose (ADR-319): a company's most keys. */
  runApiKeys: 20,
  /** The API keys whose sent messages' statuses an endpoint can choose (ADR-320), as for runs. */
  messageApiKeys: 20,
  /** The API keys whose CRM changes an endpoint can leave out (ADR-321), as for runs. */
  crmExcludedApiKeys: 20,
  /** The API keys whose order changes an endpoint can leave out (ADR-323), as for runs. */
  orderExcludedApiKeys: 20,
  /** The API keys whose Payment Links' changes an endpoint can choose (ADR-324), as for runs. */
  paymentLinkApiKeys: 20,
  /** The contact tags an endpoint can choose to take the conversations' events of (ADR-267). */
  contactTags: 50,
  /** The conversation tags an endpoint can choose to take the conversations' events of (ADR-273). */
  conversationTags: 50,
  /** The words and phrases an endpoint can look for in received messages (ADR-337). */
  messageWords: 50,
  messageWordLength: 100,
  /**
   * An endpoint's OAuth client (ADR-173): its identifier, secret and scope, short enough that the
   * Basic header stays within what the egress client sends, and the longest token kept.
   */
  oauthClientIdLength: 200,
  oauthClientSecretLength: 500,
  oauthScopeLength: 500,
  oauthTokenLength: 4000,
  /**
   * The most an endpoint's audit entry may take as jsonb, counted by `jsonbSize` (ADR-336): below
   * the 8 KiB of metadata an audit entry holds (0001), with room for the source the API adds.
   */
  auditMetadataBytes: 7000,
} as const;

/**
 * The events of automation runs, which an endpoint can take for chosen automations (ADR-145): a
 * run's start, its end and its steps (ADR-326).
 */
export const WEBHOOK_AUTOMATION_EVENTS = [
  'automation.run_started',
  'automation.run_ended',
  'automation.run_step',
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
 * An API key of the company that works and was not rotated, which an endpoint can choose to take
 * the runs it starts (ADR-319, a key holding `automations.start`) or the statuses of the messages
 * it sends (ADR-320, a key that sends, replies or asks for payment). The API also takes a revoked,
 * expired or rotated key that holds the scope; Settings lists one only while an endpoint names it.
 */
export interface WebhookApiKeyChoice {
  id: string;
  name: string;
  keyPrefix: string;
}

/** An API key an endpoint names for runs (ADR-319) or messages' statuses (ADR-320), as stored. */
export interface WebhookEndpointApiKey {
  id: string;
  /** Null only for a key the company no longer had, which cannot happen: keys are never deleted. */
  name: string | null;
  keyPrefix: string | null;
  /**
   * Whether the key works now. A revoked or expired key starts and sends no more, though its runs
   * still end and its messages' statuses still change, and a rotated key's runs and messages match
   * the key that replaced it: it stays chosen.
   */
  state: 'active' | 'revoked' | 'expired' | null;
}

/** An API key as Settings → Webhooks names it, as it names the key that added an endpoint. */
export const webhookApiKeyText = (key: WebhookEndpointApiKey): string => {
  if (!key.name || !key.keyPrefix) return 'Unknown API key';
  const named = `“${key.name}” (${key.keyPrefix}_…)`;
  return key.state === 'revoked' || key.state === 'expired' ? `${named}, ${key.state}` : named;
};

/**
 * The events that happen on a WhatsApp number, which an endpoint can take for chosen numbers
 * (ADR-170): a campaign's, and its skipped recipients' (ADR-358), are on the number it sends from, a
 * Payment Link's on its order's (ADR-285), a survey's answer on its conversation's (ADR-293), a
 * run's step on its run's (ADR-326), a cash on delivery answer on its confirmation's (ADR-348), a
 * sent order message (ADR-353) or cart reminder (ADR-355) on the number it went from. Consent,
 * contact, template, skipped order message (ADR-351), skipped cart reminder (ADR-355), deal, task
 * and note events belong to no number.
 */
export const WEBHOOK_CHANNEL_EVENTS = [
  'message.received',
  'message.status',
  'conversation.status_changed',
  'conversation.assignment_changed',
  'conversation.team_changed',
  'satisfaction_survey.answered',
  'automation.run_started',
  'automation.run_ended',
  'automation.run_step',
  'order.received',
  'order.status_changed',
  'payment_link.status_changed',
  'store_order.cod_answered',
  'store_order.message_sent',
  'store_checkout.reminder_sent',
  'campaign.status_changed',
  'campaign.recipient_skipped',
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
 * of the messages it sent, its own changes, and the recipients it skipped (ADR-358).
 */
export const WEBHOOK_CAMPAIGN_EVENTS = [
  'message.status',
  'campaign.status_changed',
  'campaign.recipient_skipped',
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

/**
 * A connected store of the company, which an endpoint can choose to take the cash on delivery
 * answers (ADR-349) and skipped order messages (ADR-352) of.
 */
export interface WebhookStoreChoice {
  id: string;
  /** Its name as the store gives it, else its address (`webhookStoreLabel`). */
  label: string;
}

/** A store an endpoint takes the answers, order messages and cart reminders of, as stored. */
export interface WebhookEndpointStore {
  id: string;
  /** Its name or address; null for a store removed since it was chosen, which matches nothing. */
  label: string | null;
}

/** How a store is named for an endpoint (ADR-349): its name as the store gives it, else its address. */
export const webhookStoreLabel = (store: { name: string | null; storeUrl: string }): string =>
  store.name?.trim() || store.storeUrl;

/** A store as Settings → Webhooks lists it. */
export const webhookStoreText = (store: WebhookEndpointStore): string =>
  store.label ?? 'A removed store';

/**
 * The events of a store's orders and checkouts, which the stores an endpoint names narrow: cash on
 * delivery answers (ADR-349), skipped (ADR-352) and sent (ADR-353) order messages, and skipped and
 * sent cart reminders (ADR-355).
 */
export const WEBHOOK_STORE_EVENTS = [
  'store_order.cod_answered',
  'store_order.message_skipped',
  'store_order.message_sent',
  'store_checkout.reminder_skipped',
  'store_checkout.reminder_sent',
] as const satisfies readonly WebhookEventType[];

/** Whether an endpoint with these events takes events of stores, and can choose stores. */
export function webhookTakesStoreEvents(eventTypes: readonly WebhookEventType[]): boolean {
  return WEBHOOK_STORE_EVENTS.some((type) => eventTypes.includes(type));
}

/**
 * The events of a store's order messages, which the order messages an endpoint names narrow:
 * skipped (ADR-352) and sent (ADR-353).
 */
export const WEBHOOK_ORDER_MESSAGE_TYPES = [
  'store_order.message_skipped',
  'store_order.message_sent',
] as const satisfies readonly WebhookEventType[];

/** Whether an endpoint with these events takes events of order messages, and can choose them. */
export function webhookTakesOrderMessages(eventTypes: readonly WebhookEventType[]): boolean {
  return WEBHOOK_ORDER_MESSAGE_TYPES.some((type) => eventTypes.includes(type));
}

/**
 * The events of a store's cart reminders, which the cart reminders an endpoint names narrow
 * (ADR-361): skipped and sent (ADR-355).
 */
export const WEBHOOK_CART_REMINDER_TYPES = [
  'store_checkout.reminder_skipped',
  'store_checkout.reminder_sent',
] as const satisfies readonly WebhookEventType[];

/** Whether an endpoint with these events takes events of cart reminders, and can choose them. */
export function webhookTakesCartReminders(eventTypes: readonly WebhookEventType[]): boolean {
  return WEBHOOK_CART_REMINDER_TYPES.some((type) => eventTypes.includes(type));
}

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
 * is (`WebhookOwnerChoice`, `WebhookEndpointOwner`, `webhookOwnerText`). They can also be taken for
 * the tasks of the deals in chosen pipelines (ADR-303) or stages, or owned by chosen members
 * (ADR-304), chosen and stored as the deals' pipelines, stages and owners are
 * (`WebhookPipelineChoice`, `WebhookEndpointPipeline`, `webhookPipelineText`, and the stages' and
 * owners' own).
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
 * Whether an endpoint with these events takes note events (ADR-280), and can choose the pipelines,
 * stages and owners of the notes' deals (ADR-305), chosen and stored as the deals' are
 * (`WebhookPipelineChoice`, `WebhookEndpointPipeline`, `webhookPipelineText`, and the stages' and
 * owners' own).
 */
export function webhookTakesNoteEvents(eventTypes: readonly WebhookEventType[]): boolean {
  return eventTypes.includes('note.created');
}

/**
 * Who made the changes the deal, task and note events report, which an endpoint can choose
 * (ADR-306), in the order Settings lists them, as the events' `changedBy` and a note's `writtenBy`
 * name them: an addition's maker is whoever added the deal or task, a note's whoever wrote it.
 */
export const WEBHOOK_CRM_CHANGE_MAKERS = [
  'member',
  'automation',
  'api',
] as const satisfies readonly WebhookCrmChangeMaker[];

/** How Settings names each maker an endpoint can choose (ADR-306). */
export const WEBHOOK_CRM_CHANGE_MAKER_LABELS: Record<WebhookCrmChangeMaker, string> = {
  member: 'Members',
  automation: 'Automations',
  api: 'API keys',
};

/**
 * The scores of the satisfaction survey answers an endpoint can choose (ADR-307), in the order
 * Settings lists them, as the survey's `score` gives them: 3 for the first (best) button, 2 for the
 * second, 1 for the third, whatever the company's buttons say.
 */
export const WEBHOOK_SURVEY_SCORES = [3, 2, 1] as const satisfies readonly WebhookSurveyScore[];

/** How Settings names each score an endpoint can choose (ADR-307). */
export const WEBHOOK_SURVEY_SCORE_LABELS: Record<WebhookSurveyScore, string> = {
  3: 'First button (best)',
  2: 'Second button',
  1: 'Third button',
};

/**
 * Whether an endpoint with these events takes deal, task or note events, and can choose who made
 * the changes they report (ADR-306).
 */
export function webhookTakesCrmChanges(eventTypes: readonly WebhookEventType[]): boolean {
  return (
    webhookTakesPipelineEvents(eventTypes) ||
    webhookTakesTaskEvents(eventTypes) ||
    webhookTakesNoteEvents(eventTypes)
  );
}

/**
 * The members that name a key pair's certificate in its JWK when it has one (ADR-372): the
 * certificate's DER as base64 (RFC 7517 section 4.7) and its SHA-1 and SHA-256 thumbprints,
 * base64url (sections 4.8 and 4.9).
 */
export interface WebhookOAuthJwkCertificate {
  x5c?: [string];
  x5t?: string;
  'x5t#S256'?: string;
}

/**
 * The public key of a client that signs with a key pair, as a JWK (RFC 7517): the RSA modulus and
 * exponent (RFC 7518 section 6.3, ADR-367) or, for ES256, the curve and the point (section 6.2,
 * ADR-371); its key id, what it is for, the algorithm it signs with, and its certificate, if it has
 * one (ADR-372).
 */
export type WebhookOAuthPublicJwk = (
  | { kty: 'RSA'; n: string; e: string; kid: string; use: 'sig'; alg: 'RS256' | 'PS256' }
  | { kty: 'EC'; crv: 'P-256'; x: string; y: string; kid: string; use: 'sig'; alg: 'ES256' }
) &
  WebhookOAuthJwkCertificate;

/**
 * The self-signed certificate HyFib made for a key pair (ADR-372), for authorization servers that
 * register a certificate rather than a bare key: as PEM, its thumbprints as assertions name them
 * (`x5t`, SHA-1, and `x5t#S256`, SHA-256, of its DER, base64url) and when it is valid (ISO 8601).
 * Public, like the key it holds.
 */
export interface WebhookOAuthCertificate {
  pem: string;
  x5t: string;
  x5tS256: string;
  validFrom: string;
  validTo: string;
}

/**
 * The public key a `private_key_jwt` client's assertions are checked with (ADR-367), which the
 * company registers with its authorization server: its key id (the JWK thumbprint of RFC 7638,
 * named in each assertion's `kid` header), the key as a JWK and as SPKI PEM, and the certificate
 * made for it, or null: none was asked for (ADR-372). Public: shown, never the private key.
 */
export interface WebhookOAuthPublicKey {
  keyId: string;
  jwk: WebhookOAuthPublicJwk;
  pem: string;
  certificate: WebhookOAuthCertificate | null;
}

/**
 * Where an endpoint gets OAuth access tokens and as which client (ADR-173); its secret or private
 * keys are never shown.
 */
export interface WebhookEndpointOAuth {
  tokenUrl: string;
  clientId: string;
  /** The scope it asks for (space-separated values), or none. */
  scope: string | null;
  /** How the client authenticates to the authorization server (ADR-357). */
  clientAuthentication: WebhookOAuthClientAuth;
  /** The public key of a client that signs with a key pair (ADR-367); null for any other. */
  publicKey: WebhookOAuthPublicKey | null;
  /**
   * The public key of that client's next key pair, to register before it is used (ADR-368); null
   * without one.
   */
  nextPublicKey: WebhookOAuthPublicKey | null;
  /**
   * The audience a client that signs JWTs names in them instead of its token URL (ADR-369); null
   * for the token URL, and for any other client.
   */
  assertionAudience: string | null;
  /**
   * The public id of the JWKS URL serving a client's public keys (ADR-370), for the page to build
   * the URL from; null for a client that does not sign with a key pair.
   */
  jwksId: string | null;
}

/** What a client's JWKS URL is for, as Settings → Webhooks says (ADR-370). */
export const WEBHOOK_OAUTH_JWKS_HINT =
  'Or give the authorization server this URL: it serves the public key in use and the next one, so the server picks up a next key pair by itself.';

/** What a key pair's certificate is for, as Settings → Webhooks says where one is asked for (ADR-372). */
export const WEBHOOK_OAUTH_CERTIFICATE_HINT =
  'For an authorization server that registers a certificate rather than a key, such as Microsoft Entra ID (which takes RSA keys: choose PS256 or RS256). HyFib makes a self-signed certificate holding the new public key, valid for a year, and names it in each JWT’s x5t and x5t#S256 headers. Register it before HyFib signs with the key pair, and switch to a next one before it expires.';

/**
 * What a change does with the next key pair of a client that signs with a key pair (ADR-368): make
 * one (another replaces one not yet used), use it in place of the pair in use, which goes, or drop
 * it unused.
 */
export const WEBHOOK_OAUTH_NEXT_KEY_ACTIONS = ['make', 'use', 'drop'] as const;
export type WebhookOAuthNextKeyAction = (typeof WEBHOOK_OAUTH_NEXT_KEY_ACTIONS)[number];

/**
 * The algorithms a key pair can be made to sign with (ADR-371, RFC 7518 section 3), the default
 * first: RS256 and PS256 with an RSA key, ES256 with an elliptic-curve key on P-256.
 */
export const WEBHOOK_OAUTH_KEY_ALGORITHM_CHOICES = [
  'RS256',
  'PS256',
  'ES256',
] as const satisfies readonly WebhookOAuthKeyAlgorithm[];

/** How Settings → Webhooks names each algorithm a key pair can sign with (ADR-371). */
export const WEBHOOK_OAUTH_KEY_ALGORITHM_LABELS: Record<WebhookOAuthKeyAlgorithm, string> = {
  RS256: 'RS256: RSA with PKCS #1 v1.5 padding (the default)',
  PS256: 'PS256: RSA with PSS padding',
  ES256: 'ES256: ECDSA on the P-256 curve',
};

/**
 * How an endpoint's OAuth client can authenticate to its authorization server (ADR-357), the
 * default first: its identifier and secret in an HTTP Basic header, or as form parameters in the
 * request body (RFC 6749 section 2.3.1, as RFC 7591 names the two); or, no secret sent, a JWT as a
 * client assertion (RFC 7523), signed with the secret (ADR-366) or with a private key HyFib keeps
 * (ADR-367), as OpenID Connect Core 1.0 section 9 names the two.
 */
export const WEBHOOK_OAUTH_CLIENT_AUTHENTICATIONS = [
  'client_secret_basic',
  'client_secret_post',
  'client_secret_jwt',
  'private_key_jwt',
] as const satisfies readonly WebhookOAuthClientAuth[];

/** Whether a client proves itself with a signed JWT, sending no secret (ADR-366, ADR-367). */
export const webhookOAuthSignsJwts = (method: WebhookOAuthClientAuth) =>
  method === 'client_secret_jwt' || method === 'private_key_jwt';

/** How Settings → Webhooks names each way a client authenticates (ADR-357, ADR-366, ADR-367). */
export const WEBHOOK_OAUTH_CLIENT_AUTHENTICATION_LABELS: Record<WebhookOAuthClientAuth, string> = {
  client_secret_basic: 'Its ID and secret in an Authorization header (HTTP Basic)',
  client_secret_post: 'Its ID and secret in the request body (client_id and client_secret)',
  client_secret_jwt: 'A JWT signed with the secret, which is never sent (client_secret_jwt)',
  private_key_jwt: 'A JWT signed with a key pair HyFib keeps, no secret (private_key_jwt)',
};

/**
 * How Settings → Webhooks describes an endpoint's OAuth client (ADR-173, ADR-357, ADR-366,
 * ADR-367), the next key pair it has not used yet (ADR-368), each key's algorithm (ADR-371) and
 * certificate (ADR-372), and the audience its JWTs name (ADR-369).
 */
export function webhookOAuthText(oauth: WebhookEndpointOAuth): string {
  const host = webhookHost(oauth.tokenUrl) ?? oauth.tokenUrl;
  const scope = oauth.scope ? `, scope ${oauth.scope}` : '';
  const key = ({ keyId, jwk, certificate }: WebhookOAuthPublicKey) =>
    `key ${keyId}, ${jwk.alg}${certificate ? `, certificate valid until ${certificate.validTo.slice(0, 10)}` : ''}`;
  const keys = [
    ...(oauth.publicKey ? [key(oauth.publicKey)] : []),
    ...(oauth.nextPublicKey ? [`next ${key(oauth.nextPublicKey)}, not used yet`] : []),
  ];
  const audience = oauth.assertionAudience ? ` addressed to ${oauth.assertionAudience}` : '';
  const how =
    oauth.clientAuthentication === 'client_secret_post'
      ? ', its ID and secret sent in the request body'
      : oauth.clientAuthentication === 'client_secret_jwt'
        ? `, proving it holds the secret with a signed JWT${audience}`
        : oauth.clientAuthentication === 'private_key_jwt'
          ? `, signing JWTs${audience} with HyFib’s private key${keys.length ? ` (${keys.join('; ')})` : ''}`
          : '';
  return `OAuth access tokens from ${host}, as client ${oauth.clientId}${scope}${how}`;
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
  if (rest === 'secret_too_short') {
    return 'No access token: the client secret is too short to sign a JWT (at least 32 bytes)';
  }
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
