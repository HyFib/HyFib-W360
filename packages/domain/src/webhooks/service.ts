import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock, type Keyring } from '@w360/core';
import { EgressError, parseEgressUrl, type EgressPolicy } from '@w360/core/egress';
import {
  and,
  apiKeys,
  asc,
  automationVersions,
  automations,
  campaigns,
  channelAccounts,
  contactFields,
  crmPipelines,
  crmStages,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  memberships,
  messageTemplates,
  sql,
  teams,
  users,
  webhookDeliveries,
  webhookEndpoints,
  webhookEvents,
  type ContactSource,
  type Database,
  type Tx,
  type WebhookDeliveryState,
  type WebhookEventType,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import { CONTACT_FIELD_KEY_RE } from '../contacts/field-definitions';
import { normalizeTag } from '../contacts/fields';
import { crmMembers, memberRefs } from '../crm/common';
import { INBOX_WORKER_ROLES } from '../inbox/routing';
import { parseInput } from '../validation';
import {
  WEBHOOK_CAMPAIGN_STATUSES,
  WEBHOOK_CONTACT_PARTS,
  WEBHOOK_CONVERSATION_STATUSES,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_FAILURE_KINDS,
  WEBHOOK_LIMITS,
  WEBHOOK_ORDER_STATUSES,
  WEBHOOK_RUN_END_STATUSES,
  WEBHOOK_RUN_TRIGGERS,
  WEBHOOK_CONSENT_CHANGES,
  WEBHOOK_CONTACT_SOURCES,
  WEBHOOK_RECEIVED_MESSAGE_TYPES,
  WEBHOOK_RUN_END_REASONS,
  WEBHOOK_MESSAGE_SENDERS,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_REPLAY_PERIODS,
  WEBHOOK_TEMPLATE_STATUSES,
  WEBHOOK_UNATTEMPTED_ERRORS,
  webhookHost,
  webhookTakesAutomationRuns,
  webhookTakesCampaignEvents,
  webhookTakesChannelEvents,
  webhookTakesFieldChanges,
  webhookTakesPipelineEvents,
  webhookRunEndTakesReason,
  webhookTakesTaskEvents,
  webhookTakesTeamEvents,
  webhookTakesTemplateEvents,
  type WebhookAssigneeChoice,
  type WebhookAutomationChoice,
  type WebhookCampaignChoice,
  type WebhookCampaignStatus,
  type WebhookChannelChoice,
  type WebhookContactPart,
  type WebhookConversationStatus,
  type WebhookEndpointAssignee,
  type WebhookEndpointAutomation,
  type WebhookEndpointCampaign,
  type WebhookEndpointChannel,
  type WebhookEndpointField,
  type WebhookFieldChoice,
  type WebhookEndpointOAuth,
  type WebhookEndpointOwner,
  type WebhookEndpointPipeline,
  type WebhookEndpointStage,
  type WebhookEndpointTeam,
  type WebhookFailureKind,
  type WebhookMessageSender,
  type WebhookMessageStatus,
  type WebhookOrderStatus,
  type WebhookRunEndStatus,
  type WebhookRunTrigger,
  type WebhookConsentChange,
  type WebhookReceivedMessageType,
  type AutomationEndReason,
  type WebhookOwnerChoice,
  type WebhookPipelineChoice,
  type WebhookStageChoice,
  type WebhookTeamChoice,
  type WebhookTemplateChoice,
  type WebhookTemplateStatus,
} from './model';
import {
  webhookOAuthSecretAad,
  WEBHOOK_OAUTH_CLIENT_RE,
  WEBHOOK_OAUTH_SCOPE_RE,
  type WebhookOAuthClient,
} from './oauth';

/** Binds an endpoint's secret to its company, the endpoint and the secret's version. */
export const webhookSecretAad = (tenantId: string, endpointId: string, version: number) =>
  `webhook-secret:${tenantId}:${endpointId}:${version}`;

/** Binds an endpoint's own headers to its company and the endpoint (ADR-118). */
export const webhookHeadersAad = (tenantId: string, endpointId: string) =>
  `webhook-headers:${tenantId}:${endpointId}`;

/** A header an endpoint's receiver asks for (ADR-118); the value is a secret. */
export interface WebhookHeader {
  name: string;
  value: string;
}

const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,59}$/;
// Printable ASCII; an empty value is refused by its own message.
const HEADER_VALUE_RE = /^[\x20-\x7e]*$/;
/**
 * Headers HyFib sets on a delivery or that describe its body or connection; with `proxy-*` and
 * HyFib's own `w360-*`. An endpoint's headers never replace these.
 */
const RESERVED_WEBHOOK_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-encoding',
  'user-agent',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'accept-encoding',
]);

/** Whether a header name is one an endpoint cannot set. */
export function reservedWebhookHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    RESERVED_WEBHOOK_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('w360-')
  );
}

/** The headers an endpoint sends with each delivery: replaces the list it had (ADR-118). */
export const webhookHeadersSchema = z
  .array(
    z
      .object({
        name: z
          .string()
          .trim()
          .regex(HEADER_NAME_RE, 'Header names use letters, digits and - (at most 60).')
          .refine((name) => !reservedWebhookHeader(name), 'HyFib sets this header itself.'),
        value: z
          .string()
          .trim()
          .min(1, 'Enter the header’s value.')
          .max(
            WEBHOOK_LIMITS.headerValueLength,
            `Header values are limited to ${WEBHOOK_LIMITS.headerValueLength} characters.`,
          )
          .regex(
            HEADER_VALUE_RE,
            'Header values use printable ASCII characters, without line breaks.',
          ),
      })
      .strict(),
  )
  .max(WEBHOOK_LIMITS.headers, `An endpoint can have at most ${WEBHOOK_LIMITS.headers} headers.`)
  .refine(
    (headers) => new Set(headers.map((h) => h.name.toLowerCase())).size === headers.length,
    'Give each header once.',
  );

/**
 * An endpoint's OAuth client (ADR-173): the token endpoint of its receiver's authorization server,
 * the client identifier and secret that server issued, and the scope to ask for, if any (empty or
 * left out: none). A change may leave the secret out to keep the stored one while the token URL
 * stays the same.
 */
export const webhookOAuthSchema = z
  .object({
    tokenUrl: z
      .string({ error: 'Enter the token URL' })
      .trim()
      .min(1, 'Enter the token URL')
      .max(WEBHOOK_LIMITS.urlLength, 'The token URL is too long'),
    clientId: z
      .string({ error: 'Enter the client ID' })
      .trim()
      .min(1, 'Enter the client ID')
      .max(
        WEBHOOK_LIMITS.oauthClientIdLength,
        `Client IDs are limited to ${WEBHOOK_LIMITS.oauthClientIdLength} characters.`,
      )
      .regex(WEBHOOK_OAUTH_CLIENT_RE, 'Client IDs use printable ASCII characters.'),
    clientSecret: z
      .string({ error: 'Enter the client secret.' })
      .trim()
      .min(1, 'Enter the client secret.')
      .max(
        WEBHOOK_LIMITS.oauthClientSecretLength,
        `Client secrets are limited to ${WEBHOOK_LIMITS.oauthClientSecretLength} characters.`,
      )
      .regex(WEBHOOK_OAUTH_CLIENT_RE, 'Client secrets use printable ASCII characters.')
      .optional(),
    scope: z
      .string()
      .trim()
      .max(
        WEBHOOK_LIMITS.oauthScopeLength,
        `Scopes are limited to ${WEBHOOK_LIMITS.oauthScopeLength} characters.`,
      )
      .refine(
        (scope) => scope === '' || WEBHOOK_OAUTH_SCOPE_RE.test(scope),
        'Separate the scope’s values with single spaces; they cannot hold quotes or backslashes.',
      )
      .transform((scope) => scope || null)
      .nullable()
      .optional(),
  })
  .strict();
export type WebhookOAuthInput = z.output<typeof webhookOAuthSchema>;

export const WEBHOOK_OAUTH_SECRET_NEEDED = 'Enter the client secret.';
export const WEBHOOK_OAUTH_SECRET_FOR_NEW_URL =
  'Enter the client secret again: it is sent to the token URL, which changed.';
export const WEBHOOK_OAUTH_AUTHORIZATION =
  'An endpoint that gets OAuth tokens sends them as its Authorization header: remove that header, or the OAuth client.';

/**
 * The columns that keep an endpoint's headers: the names as written, and names and values sealed
 * with the keyring, bound to the company and the endpoint. No headers keep nothing sealed.
 */
export function sealWebhookHeaders(
  keyring: Keyring,
  tenantId: string,
  endpointId: string,
  headers: readonly WebhookHeader[],
): { headerNames: string[]; headersCiphertext: string | null } {
  if (headers.length === 0) return { headerNames: [], headersCiphertext: null };
  return {
    headerNames: headers.map((h) => h.name),
    headersCiphertext: keyring.encrypt(
      JSON.stringify(headers.map((h) => [h.name, h.value])),
      webhookHeadersAad(tenantId, endpointId),
    ),
  };
}

/**
 * An endpoint's headers, opened for a delivery. Throws when the keyring cannot open them (a key
 * the platform no longer holds) or they are not what `sealWebhookHeaders` keeps.
 */
export function openWebhookHeaders(
  keyring: Keyring,
  tenantId: string,
  endpointId: string,
  ciphertext: string | null,
): Record<string, string> {
  if (ciphertext === null) return {};
  const pairs: unknown = JSON.parse(
    keyring.decryptString(ciphertext, webhookHeadersAad(tenantId, endpointId)),
  );
  const headers: Record<string, string> = {};
  if (!Array.isArray(pairs)) throw new Error('Sealed webhook headers are not a list');
  for (const pair of pairs) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== 'string' ||
      typeof pair[1] !== 'string' ||
      reservedWebhookHeader(pair[0])
    ) {
      throw new Error('Sealed webhook headers hold something other than headers');
    }
    headers[pair[0]] = pair[1];
  }
  return headers;
}

/**
 * The `message.status` statuses an endpoint takes (ADR-119), in the order a message reaches them;
 * null takes every status, including statuses added later.
 */
export const webhookMessageStatusesSchema = z
  .array(z.enum(WEBHOOK_MESSAGE_STATUSES, { error: 'Choose message statuses from the list.' }))
  .min(1, 'Choose at least one message status, or take every status.')
  .max(WEBHOOK_MESSAGE_STATUSES.length, 'Give each message status once.')
  .transform((chosen) => WEBHOOK_MESSAGE_STATUSES.filter((status) => chosen.includes(status)))
  .nullable();

export const WEBHOOK_STATUSES_NEED_THE_EVENT =
  'Choose message statuses only for an endpoint that receives Message status.';

/**
 * The statuses an endpoint keeps after it is added or changed: every status (null) unless it takes
 * `message.status`; then those given, or else the ones it had.
 */
export function webhookMessageStatusesFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly WebhookMessageStatus[] | null | undefined,
  current: readonly WebhookMessageStatus[] | null,
): WebhookMessageStatus[] | null {
  if (!eventTypes.includes('message.status')) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * Who sent the messages whose `message.status` an endpoint takes (ADR-172), in the order Settings
 * lists them; null takes every sender.
 */
export const webhookMessageSendersSchema = z
  .array(z.enum(WEBHOOK_MESSAGE_SENDERS, { error: 'Choose who sent the messages from the list.' }))
  .min(1, 'Choose at least one sender, or take the statuses of every message.')
  .max(WEBHOOK_MESSAGE_SENDERS.length, 'Give each sender once.')
  .transform((chosen) => WEBHOOK_MESSAGE_SENDERS.filter((sender) => chosen.includes(sender)))
  .nullable();

export const WEBHOOK_SENDERS_NEED_THE_EVENT =
  'Choose who sent the messages only for an endpoint that receives Message status.';

/**
 * The senders an endpoint keeps after it is added or changed: every sender (null) unless it takes
 * `message.status`; then those given, or else the ones it had.
 */
export function webhookMessageSendersFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly WebhookMessageSender[] | null | undefined,
  current: readonly WebhookMessageSender[] | null,
): WebhookMessageSender[] | null {
  if (!eventTypes.includes('message.status')) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * The statuses a campaign reaches that an endpoint takes as `campaign.status_changed` (ADR-146), in
 * the order a campaign reaches them; null takes every status.
 */
export const webhookCampaignStatusesSchema = z
  .array(z.enum(WEBHOOK_CAMPAIGN_STATUSES, { error: 'Choose campaign statuses from the list.' }))
  .min(1, 'Choose at least one campaign status, or take every status.')
  .max(WEBHOOK_CAMPAIGN_STATUSES.length, 'Give each campaign status once.')
  .transform((chosen) => WEBHOOK_CAMPAIGN_STATUSES.filter((status) => chosen.includes(status)))
  .nullable();

export const WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT =
  'Choose campaign statuses only for an endpoint that receives Campaign status.';

/**
 * The campaign statuses an endpoint keeps after it is added or changed: every status (null) unless
 * it takes `campaign.status_changed`; then those given, or else the ones it had.
 */
export function webhookCampaignStatusesFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly WebhookCampaignStatus[] | null | undefined,
  current: readonly WebhookCampaignStatus[] | null,
): WebhookCampaignStatus[] | null {
  if (!eventTypes.includes('campaign.status_changed')) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * The statuses an order reaches that an endpoint takes as `order.status_changed` (ADR-147), in the
 * order an order reaches them; null takes every status.
 */
export const webhookOrderStatusesSchema = z
  .array(z.enum(WEBHOOK_ORDER_STATUSES, { error: 'Choose order statuses from the list.' }))
  .min(1, 'Choose at least one order status, or take every status.')
  .max(WEBHOOK_ORDER_STATUSES.length, 'Give each order status once.')
  .transform((chosen) => WEBHOOK_ORDER_STATUSES.filter((status) => chosen.includes(status)))
  .nullable();

export const WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT =
  'Choose order statuses only for an endpoint that receives Order status.';

/**
 * The order statuses an endpoint keeps after it is added or changed: every status (null) unless it
 * takes `order.status_changed`; then those given, or else the ones it had.
 */
export function webhookOrderStatusesFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly WebhookOrderStatus[] | null | undefined,
  current: readonly WebhookOrderStatus[] | null,
): WebhookOrderStatus[] | null {
  if (!eventTypes.includes('order.status_changed')) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * The template statuses an endpoint takes as `template.status_changed` (ADR-148), in the order
 * Templates lists them; null takes every status.
 */
export const webhookTemplateStatusesSchema = z
  .array(z.enum(WEBHOOK_TEMPLATE_STATUSES, { error: 'Choose template statuses from the list.' }))
  .min(1, 'Choose at least one template status, or take every status.')
  .max(WEBHOOK_TEMPLATE_STATUSES.length, 'Give each template status once.')
  .transform((chosen) => WEBHOOK_TEMPLATE_STATUSES.filter((status) => chosen.includes(status)))
  .nullable();

export const WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT =
  'Choose template statuses only for an endpoint that receives Template status.';

/**
 * The template statuses an endpoint keeps after it is added or changed: every status (null) unless
 * it takes `template.status_changed`; then those given, or else the ones it had.
 */
export function webhookTemplateStatusesFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly WebhookTemplateStatus[] | null | undefined,
  current: readonly WebhookTemplateStatus[] | null,
): WebhookTemplateStatus[] | null {
  if (!eventTypes.includes('template.status_changed')) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * The statuses a conversation reaches that an endpoint takes as `conversation.status_changed`
 * (ADR-149), in the order the inbox lists them; null takes every status.
 */
export const webhookConversationStatusesSchema = z
  .array(
    z.enum(WEBHOOK_CONVERSATION_STATUSES, { error: 'Choose conversation statuses from the list.' }),
  )
  .min(1, 'Choose at least one conversation status, or take every status.')
  .max(WEBHOOK_CONVERSATION_STATUSES.length, 'Give each conversation status once.')
  .transform((chosen) => WEBHOOK_CONVERSATION_STATUSES.filter((status) => chosen.includes(status)))
  .nullable();

export const WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT =
  'Choose conversation statuses only for an endpoint that receives Conversation status.';

/**
 * The conversation statuses an endpoint keeps after it is added or changed: every status (null)
 * unless it takes `conversation.status_changed`; then those given, or else the ones it had.
 */
export function webhookConversationStatusesFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly WebhookConversationStatus[] | null | undefined,
  current: readonly WebhookConversationStatus[] | null,
): WebhookConversationStatus[] | null {
  if (!eventTypes.includes('conversation.status_changed')) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * The statuses a run ended with that an endpoint takes as `automation.run_ended` (ADR-151), in the
 * order an automation's runs list them; null takes every end.
 */
export const webhookRunEndStatusesSchema = z
  .array(z.enum(WEBHOOK_RUN_END_STATUSES, { error: 'Choose how runs ended from the list.' }))
  .min(1, 'Choose at least one way a run ends, or take every end.')
  .max(WEBHOOK_RUN_END_STATUSES.length, 'Give each way a run ends once.')
  .transform((chosen) => WEBHOOK_RUN_END_STATUSES.filter((status) => chosen.includes(status)))
  .nullable();

export const WEBHOOK_RUN_END_STATUSES_NEED_THE_EVENT =
  'Choose how runs ended only for an endpoint that receives Automation ended.';

/**
 * The run end statuses an endpoint keeps after it is added or changed: every end (null) unless it
 * takes `automation.run_ended`; then those given, or else the ones it had.
 */
export function webhookRunEndStatusesFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly WebhookRunEndStatus[] | null | undefined,
  current: readonly WebhookRunEndStatus[] | null,
): WebhookRunEndStatus[] | null {
  if (!eventTypes.includes('automation.run_ended')) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * What started the runs whose events an endpoint takes (ADR-183), in the order the automation
 * builder lists triggers; null takes every run's.
 */
export const webhookRunTriggersSchema = z
  .array(z.enum(WEBHOOK_RUN_TRIGGERS, { error: 'Choose what started the runs from the list.' }))
  .min(1, 'Choose at least one way a run starts, or take every run.')
  .max(WEBHOOK_RUN_TRIGGERS.length, 'Give each way a run starts once.')
  .transform((chosen) => WEBHOOK_RUN_TRIGGERS.filter((trigger) => chosen.includes(trigger)))
  .nullable();

export const WEBHOOK_RUN_TRIGGERS_NEED_THE_EVENTS =
  'Choose what started the runs only for an endpoint that receives Automation started or Automation ended.';

/**
 * The run triggers an endpoint keeps after it is added or changed: every run (null) unless it takes
 * a run event; then those given, or else the ones it had.
 */
export function webhookRunTriggersFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly WebhookRunTrigger[] | null | undefined,
  current: readonly WebhookRunTrigger[] | null,
): WebhookRunTrigger[] | null {
  if (!webhookTakesAutomationRuns(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * The consent changes an endpoint takes as `consent.changed` (ADR-189), by purpose and action, in
 * the order Settings lists them; null takes every change.
 */
export const webhookConsentChangesSchema = z
  .array(z.enum(WEBHOOK_CONSENT_CHANGES, { error: 'Choose consent changes from the list.' }))
  .min(1, 'Choose at least one consent change, or take every change.')
  .max(WEBHOOK_CONSENT_CHANGES.length, 'Give each consent change once.')
  .transform((chosen) => WEBHOOK_CONSENT_CHANGES.filter((change) => chosen.includes(change)))
  .nullable();

export const WEBHOOK_CONSENT_CHANGES_NEED_THE_EVENT =
  'Choose consent changes only for an endpoint that receives Consent changed.';

/**
 * The consent changes an endpoint keeps after it is added or changed: every change (null) unless
 * it takes `consent.changed`; then those given, or else the ones it had.
 */
export function webhookConsentChangesFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly WebhookConsentChange[] | null | undefined,
  current: readonly WebhookConsentChange[] | null,
): WebhookConsentChange[] | null {
  if (!eventTypes.includes('consent.changed')) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * Where the contacts whose `contact.created` an endpoint takes came from (ADR-190), in the order
 * contacts' sources are defined; null takes every contact.
 */
export const webhookContactSourcesSchema = z
  .array(
    z.enum(WEBHOOK_CONTACT_SOURCES, { error: 'Choose where contacts came from from the list.' }),
  )
  .min(1, 'Choose at least one place contacts come from, or take every contact.')
  .max(WEBHOOK_CONTACT_SOURCES.length, 'Give each place contacts come from once.')
  .transform((chosen) => WEBHOOK_CONTACT_SOURCES.filter((source) => chosen.includes(source)))
  .nullable();

export const WEBHOOK_CONTACT_SOURCES_NEED_THE_EVENT =
  'Choose where contacts came from only for an endpoint that receives Contact added.';

/**
 * The contact sources an endpoint keeps after it is added or changed: every contact (null) unless
 * it takes `contact.created`; then those given, or else the ones it had.
 */
export function webhookContactSourcesFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly ContactSource[] | null | undefined,
  current: readonly ContactSource[] | null,
): ContactSource[] | null {
  if (!eventTypes.includes('contact.created')) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * The types of the received messages an endpoint takes as `message.received` (ADR-191), in the
 * order message types are defined; null takes every type.
 */
export const webhookMessageTypesSchema = z
  .array(z.enum(WEBHOOK_RECEIVED_MESSAGE_TYPES, { error: 'Choose message types from the list.' }))
  .min(1, 'Choose at least one message type, or take every message.')
  .max(WEBHOOK_RECEIVED_MESSAGE_TYPES.length, 'Give each message type once.')
  .transform((chosen) => WEBHOOK_RECEIVED_MESSAGE_TYPES.filter((type) => chosen.includes(type)))
  .nullable();

export const WEBHOOK_MESSAGE_TYPES_NEED_THE_EVENT =
  'Choose message types only for an endpoint that receives Message received.';

/**
 * The message types an endpoint keeps after it is added or changed: every type (null) unless it
 * takes `message.received`; then those given, or else the ones it had.
 */
export function webhookMessageTypesFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly WebhookReceivedMessageType[] | null | undefined,
  current: readonly WebhookReceivedMessageType[] | null,
): WebhookReceivedMessageType[] | null {
  if (!eventTypes.includes('message.received')) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * The reasons the runs an endpoint takes as `automation.run_ended` ended for (ADR-192), grouped by
 * end; null takes every reason. A list narrows the ends it names reasons of (the ends chosen,
 * ADR-151, narrow the others), and holds reasons of the ends taken only.
 */
export const webhookRunEndReasonsSchema = z
  .array(z.enum(WEBHOOK_RUN_END_REASONS, { error: 'Choose end reasons from the list.' }))
  .min(1, 'Choose at least one end reason, or take every end.')
  .max(WEBHOOK_RUN_END_REASONS.length, 'Give each end reason once.')
  .transform((chosen) => WEBHOOK_RUN_END_REASONS.filter((reason) => chosen.includes(reason)))
  .nullable();

export const WEBHOOK_RUN_END_REASONS_NEED_THE_EVENT =
  'Choose end reasons only for an endpoint that receives Automation ended.';

export const WEBHOOK_RUN_END_REASONS_NEED_THE_ENDS =
  'Choose end reasons only of the ends the endpoint receives.';

/** A list naming a reason of an end the endpoint does not take is refused (ADR-192). */
export const webhookRunEndReasonsNeedTheEnds = () =>
  new AppError('validation_failed', WEBHOOK_RUN_END_REASONS_NEED_THE_ENDS, {
    issues: [{ path: 'runEndReasons', message: WEBHOOK_RUN_END_REASONS_NEED_THE_ENDS }],
  });

/**
 * The end reasons an endpoint keeps after it is added or changed, given the ends it keeps: every
 * reason (null) unless it takes `automation.run_ended`; then those given, or else those it had of
 * the ends it keeps (none left: every reason).
 */
export function webhookRunEndReasonsFor(
  eventTypes: readonly WebhookEventType[],
  ends: readonly WebhookRunEndStatus[] | null,
  given: readonly AutomationEndReason[] | null | undefined,
  current: readonly AutomationEndReason[] | null,
): AutomationEndReason[] | null {
  if (!eventTypes.includes('automation.run_ended')) return null;
  if (given !== undefined) return given ? [...given] : null;
  const kept = current?.filter((reason) => webhookRunEndTakesReason(ends, reason)) ?? [];
  return kept.length > 0 ? kept : null;
}

/**
 * The parts of a contact whose change an endpoint takes as `contact.updated` (ADR-123), in the
 * order Settings lists them; null takes every change, including parts added later.
 */
export const webhookContactPartsSchema = z
  .array(z.enum(WEBHOOK_CONTACT_PARTS, { error: 'Choose contact parts from the list.' }))
  .min(1, 'Choose at least one contact part, or take every change.')
  .max(WEBHOOK_CONTACT_PARTS.length, 'Give each contact part once.')
  .transform((chosen) => WEBHOOK_CONTACT_PARTS.filter((part) => chosen.includes(part)))
  .nullable();

export const WEBHOOK_PARTS_NEED_THE_EVENT =
  'Choose contact parts only for an endpoint that receives Contact changed.';

/**
 * The parts an endpoint keeps after it is added or changed: every change (null) unless it takes
 * `contact.updated`; then those given, or else the ones it had.
 */
export function webhookContactPartsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly WebhookContactPart[] | null | undefined,
  current: readonly WebhookContactPart[] | null,
): WebhookContactPart[] | null {
  if (!eventTypes.includes('contact.updated')) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * The custom fields whose changes an endpoint takes as `contact.updated` (ADR-184), by key (as
 * GET /contact-fields lists them), each once; null takes every field's, including fields added
 * later.
 */
export const webhookContactFieldKeysSchema = z
  .array(
    z
      .string({ error: 'Choose fields from the list.' })
      .regex(CONTACT_FIELD_KEY_RE, 'Choose fields from the list.'),
  )
  .min(1, 'Choose at least one field, or take every field.')
  .max(WEBHOOK_LIMITS.contactFields, `Choose at most ${WEBHOOK_LIMITS.contactFields} fields.`)
  .transform((keys) => [...new Set(keys)])
  .nullable();

export const WEBHOOK_FIELDS_NEED_THE_PART =
  'Choose fields only for an endpoint that receives Contact changed with custom field values.';

export const WEBHOOK_FIELDS_NOT_FOUND = 'Choose fields of this company.';

/** A list of fields given for an endpoint that takes no field changes is refused (ADR-184). */
export const webhookFieldsNeedThePart = () =>
  new AppError('validation_failed', WEBHOOK_FIELDS_NEED_THE_PART, {
    issues: [{ path: 'contactFieldKeys', message: WEBHOOK_FIELDS_NEED_THE_PART }],
  });

/**
 * The fields an endpoint keeps after it is added or changed, given the parts it keeps: every field
 * (null) unless it takes field changes; then those given, or else the ones it had.
 */
export function webhookContactFieldKeysFor(
  eventTypes: readonly WebhookEventType[],
  parts: readonly WebhookContactPart[] | null,
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesFieldChanges(eventTypes, parts)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * Refuses fields a list adds to an endpoint unless each is one of the company's (ADR-184). Fields
 * the endpoint's list already held may have been deleted since, and stay. `tx` is in the company's
 * scope.
 */
export async function assertWebhookContactFields(
  tx: Tx,
  tenantId: string,
  keys: readonly string[] | null | undefined,
  held: readonly string[] | null = null,
): Promise<void> {
  const added = (keys ?? []).filter((key) => !held?.includes(key));
  if (added.length === 0) return;
  const rows = await tx
    .select({ key: contactFields.key })
    .from(contactFields)
    .where(and(eq(contactFields.tenantId, tenantId), inArray(contactFields.key, added)));
  const found = new Set(rows.map((r) => r.key));
  const index = (keys ?? []).findIndex((key) => added.includes(key) && !found.has(key));
  if (index === -1) return;
  throw new AppError('validation_failed', WEBHOOK_FIELDS_NOT_FOUND, {
    issues: [{ path: `contactFieldKeys.${index}`, message: WEBHOOK_FIELDS_NOT_FOUND }],
  });
}

/**
 * The automations whose runs an endpoint takes as `automation.run_started` and
 * `automation.run_ended` (ADR-145), each once; null takes every automation, including automations
 * published later.
 */
export const webhookAutomationIdsSchema = z
  .array(z.uuid({ error: 'Choose automations from the list.' }))
  .min(1, 'Choose at least one automation, or take every automation.')
  .max(WEBHOOK_LIMITS.automations, `Choose at most ${WEBHOOK_LIMITS.automations} automations.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS =
  'Choose automations only for an endpoint that receives Automation started or Automation ended.';

export const WEBHOOK_AUTOMATIONS_NOT_PUBLISHED =
  'Choose automations of this company that have been published.';

/**
 * The automations an endpoint keeps after it is added or changed: every automation (null) unless it
 * takes an automation run event; then those given, or else the ones it had.
 */
export function webhookAutomationIdsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesAutomationRuns(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * Refuses automations given for an endpoint unless each is the company's and has a published
 * version (ADR-145). Such an automation cannot be deleted (its versions keep it), only archived, so
 * a list never names an automation that is gone. `tx` is in the company's scope.
 */
export async function assertWebhookAutomations(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null | undefined,
): Promise<void> {
  if (!ids || ids.length === 0) return;
  const rows = await tx
    .selectDistinct({ id: automationVersions.automationId })
    .from(automationVersions)
    .where(
      and(
        eq(automationVersions.tenantId, tenantId),
        inArray(automationVersions.automationId, [...ids]),
        eq(automationVersions.kind, 'published'),
      ),
    );
  const published = new Set(rows.map((r) => r.id));
  const index = ids.findIndex((id) => !published.has(id));
  if (index === -1) return;
  throw new AppError('validation_failed', WEBHOOK_AUTOMATIONS_NOT_PUBLISHED, {
    issues: [{ path: `automationIds.${index}`, message: WEBHOOK_AUTOMATIONS_NOT_PUBLISHED }],
  });
}

/**
 * The WhatsApp numbers whose events an endpoint takes (ADR-170), each once; null takes every
 * number, including numbers connected later.
 */
export const webhookChannelIdsSchema = z
  .array(z.uuid({ error: 'Choose numbers from the list.' }))
  .min(1, 'Choose at least one number, or take every number.')
  .max(WEBHOOK_LIMITS.channels, `Choose at most ${WEBHOOK_LIMITS.channels} numbers.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const WEBHOOK_CHANNELS_NEED_THE_EVENTS =
  'Choose numbers only for an endpoint that receives message, conversation, automation, order or campaign events.';

export const WEBHOOK_CHANNELS_NOT_FOUND = 'Choose WhatsApp numbers of this company.';

/**
 * The numbers an endpoint keeps after it is added or changed: every number (null) unless it takes
 * an event of a number; then those given, or else the ones it had.
 */
export function webhookChannelIdsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesChannelEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * Refuses numbers given for an endpoint unless each is the company's (ADR-170). A company's
 * numbers are never deleted, only disconnected, so a list never names one that is gone. `tx` is in
 * the company's scope.
 */
export async function assertWebhookChannels(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null | undefined,
): Promise<void> {
  if (!ids || ids.length === 0) return;
  const rows = await tx
    .select({ id: channelAccounts.id })
    .from(channelAccounts)
    .where(and(eq(channelAccounts.tenantId, tenantId), inArray(channelAccounts.id, [...ids])));
  const found = new Set(rows.map((r) => r.id));
  const index = ids.findIndex((id) => !found.has(id));
  if (index === -1) return;
  throw new AppError('validation_failed', WEBHOOK_CHANNELS_NOT_FOUND, {
    issues: [{ path: `channelIds.${index}`, message: WEBHOOK_CHANNELS_NOT_FOUND }],
  });
}

/**
 * How Settings → Webhooks names a number (ADR-170): the number and the name WhatsApp verified for
 * it, or Meta's id for it until Meta reports them.
 */
export function webhookChannelLabel(channel: {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  phoneNumberId: string;
}): string {
  const { displayPhoneNumber: phone, verifiedName: name } = channel;
  if (phone && name) return `${phone} · ${name}`;
  return phone ?? name ?? `Phone number ID ${channel.phoneNumberId}`;
}

/** A template as Settings → Webhooks names it (ADR-175). */
const templateChoiceColumns = {
  id: messageTemplates.id,
  name: messageTemplates.name,
  language: messageTemplates.language,
};

/** A campaign as Settings → Webhooks names it (ADR-185). */
const campaignChoiceColumns = {
  id: campaigns.id,
  name: campaigns.name,
  status: campaigns.status,
};

/** The columns `webhookChannelLabel` reads, with the number's id and status. */
const channelChoiceColumns = {
  id: channelAccounts.id,
  displayPhoneNumber: channelAccounts.displayPhoneNumber,
  verifiedName: channelAccounts.verifiedName,
  phoneNumberId: channelAccounts.phoneNumberId,
  status: channelAccounts.status,
};

/**
 * The templates whose messages' statuses and changes an endpoint takes (ADR-175), each once; null
 * takes every template's, including templates added later.
 */
export const webhookTemplateIdsSchema = z
  .array(z.uuid({ error: 'Choose templates from the list.' }))
  .min(1, 'Choose at least one template, or take every template.')
  .max(WEBHOOK_LIMITS.templates, `Choose at most ${WEBHOOK_LIMITS.templates} templates.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const WEBHOOK_TEMPLATES_NEED_THE_EVENTS =
  'Choose templates only for an endpoint that receives Message status or Template status.';

export const WEBHOOK_TEMPLATES_NOT_FOUND = 'Choose templates of this company.';

/**
 * The templates an endpoint keeps after it is added or changed: every template (null) unless it
 * takes an event of a template; then those given, or else the ones it had.
 */
export function webhookTemplateIdsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesTemplateEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * Refuses templates given for an endpoint unless each is the company's (ADR-175). A company's
 * templates are never deleted (one deleted at Meta keeps its row), so a list never names one that is
 * gone. `tx` is in the company's scope.
 */
export async function assertWebhookTemplates(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null | undefined,
): Promise<void> {
  if (!ids || ids.length === 0) return;
  const rows = await tx
    .select({ id: messageTemplates.id })
    .from(messageTemplates)
    .where(and(eq(messageTemplates.tenantId, tenantId), inArray(messageTemplates.id, [...ids])));
  const found = new Set(rows.map((r) => r.id));
  const index = ids.findIndex((id) => !found.has(id));
  if (index === -1) return;
  throw new AppError('validation_failed', WEBHOOK_TEMPLATES_NOT_FOUND, {
    issues: [{ path: `templateIds.${index}`, message: WEBHOOK_TEMPLATES_NOT_FOUND }],
  });
}

/**
 * The campaigns whose messages' statuses and changes an endpoint takes (ADR-185), each once; null
 * takes every campaign's, including campaigns added later.
 */
export const webhookCampaignIdsSchema = z
  .array(z.uuid({ error: 'Choose campaigns from the list.' }))
  .min(1, 'Choose at least one campaign, or take every campaign.')
  .max(WEBHOOK_LIMITS.campaigns, `Choose at most ${WEBHOOK_LIMITS.campaigns} campaigns.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const WEBHOOK_CAMPAIGNS_NEED_THE_EVENTS =
  'Choose campaigns only for an endpoint that receives Message status or Campaign status.';

export const WEBHOOK_CAMPAIGNS_NOT_FOUND = 'Choose campaigns of this company.';

/**
 * The campaigns an endpoint keeps after it is added or changed: every campaign (null) unless it
 * takes an event of a campaign; then those given, or else the ones it had.
 */
export function webhookCampaignIdsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesCampaignEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * Refuses campaigns given for an endpoint unless each is the company's (ADR-185). A company's
 * campaigns are kept until the company is deleted, so a list never names one that is gone. `tx` is
 * in the company's scope.
 */
export async function assertWebhookCampaigns(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null | undefined,
): Promise<void> {
  if (!ids || ids.length === 0) return;
  const rows = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.tenantId, tenantId), inArray(campaigns.id, [...ids])));
  const found = new Set(rows.map((r) => r.id));
  const index = ids.findIndex((id) => !found.has(id));
  if (index === -1) return;
  throw new AppError('validation_failed', WEBHOOK_CAMPAIGNS_NOT_FOUND, {
    issues: [{ path: `campaignIds.${index}`, message: WEBHOOK_CAMPAIGNS_NOT_FOUND }],
  });
}

/**
 * The CRM pipelines whose deals' events an endpoint takes (ADR-263), each once; null takes every
 * pipeline's, including pipelines added later.
 */
export const webhookPipelineIdsSchema = z
  .array(z.uuid({ error: 'Choose pipelines from the list.' }))
  .min(1, 'Choose at least one pipeline, or take every pipeline.')
  .max(WEBHOOK_LIMITS.pipelines, `Choose at most ${WEBHOOK_LIMITS.pipelines} pipelines.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const WEBHOOK_PIPELINES_NEED_THE_EVENTS =
  'Choose pipelines only for an endpoint that receives Deal added, Deal details, Deal stage, Deal owner or Deal won, lost or reopened.';

export const WEBHOOK_PIPELINES_NOT_FOUND = 'Choose pipelines of this company.';

/**
 * The pipelines an endpoint keeps after it is added or changed: every pipeline (null) unless it
 * takes a deal event; then those given, or else the ones it had.
 */
export function webhookPipelineIdsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesPipelineEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * Refuses pipelines a list (`field`) gives for an endpoint unless each is the company's, archived
 * ones included, as deals' pipelines (ADR-263) and tasks' (ADR-303) are chosen. Pipelines are
 * archived, never deleted, so a list never names one that is gone. `tx` is in the company's scope.
 */
async function assertCompanyPipelines(
  tx: Tx,
  tenantId: string,
  field: 'pipelineIds' | 'taskPipelineIds',
  ids: readonly string[] | null | undefined,
): Promise<void> {
  if (!ids || ids.length === 0) return;
  const rows = await tx
    .select({ id: crmPipelines.id })
    .from(crmPipelines)
    .where(and(eq(crmPipelines.tenantId, tenantId), inArray(crmPipelines.id, [...ids])));
  const found = new Set(rows.map((r) => r.id));
  const index = ids.findIndex((id) => !found.has(id));
  if (index === -1) return;
  throw new AppError('validation_failed', WEBHOOK_PIPELINES_NOT_FOUND, {
    issues: [{ path: `${field}.${index}`, message: WEBHOOK_PIPELINES_NOT_FOUND }],
  });
}

/** Refuses pipelines given for an endpoint's deal events unless each is the company's (ADR-263). */
export async function assertWebhookPipelines(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null | undefined,
): Promise<void> {
  await assertCompanyPipelines(tx, tenantId, 'pipelineIds', ids);
}

/**
 * The CRM stages whose deals' events an endpoint takes (ADR-264), each once; null takes every
 * stage's, including stages added later.
 */
export const webhookStageIdsSchema = z
  .array(z.uuid({ error: 'Choose stages from the list.' }))
  .min(1, 'Choose at least one stage, or take every stage.')
  .max(WEBHOOK_LIMITS.stages, `Choose at most ${WEBHOOK_LIMITS.stages} stages.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const WEBHOOK_STAGES_NEED_THE_EVENTS =
  'Choose stages only for an endpoint that receives Deal added, Deal details, Deal stage, Deal owner or Deal won, lost or reopened.';

export const WEBHOOK_STAGES_NOT_FOUND = 'Choose stages of this company.';

/**
 * The stages an endpoint keeps after it is added or changed: every stage (null) unless it takes a
 * deal event; then those given, or else the ones it had.
 */
export function webhookStageIdsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesPipelineEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * Refuses stages given for an endpoint unless each is the company's (ADR-264), removed ones and
 * those of archived pipelines included. Stages are archived when removed, never deleted, so a list
 * never names one that is gone. `tx` is in the company's scope.
 */
export async function assertWebhookStages(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null | undefined,
): Promise<void> {
  if (!ids || ids.length === 0) return;
  const rows = await tx
    .select({ id: crmStages.id })
    .from(crmStages)
    .where(and(eq(crmStages.tenantId, tenantId), inArray(crmStages.id, [...ids])));
  const found = new Set(rows.map((r) => r.id));
  const index = ids.findIndex((id) => !found.has(id));
  if (index === -1) return;
  throw new AppError('validation_failed', WEBHOOK_STAGES_NOT_FOUND, {
    issues: [{ path: `stageIds.${index}`, message: WEBHOOK_STAGES_NOT_FOUND }],
  });
}

/**
 * The members whose deals' events an endpoint takes (ADR-265), each once; null takes every deal's,
 * including those of members who join later and deals without an owner.
 */
export const webhookOwnerIdsSchema = z
  .array(z.uuid({ error: 'Choose members from the list.' }))
  .min(1, 'Choose at least one member, or take every deal.')
  .max(WEBHOOK_LIMITS.owners, `Choose at most ${WEBHOOK_LIMITS.owners} members.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const WEBHOOK_OWNERS_NEED_THE_EVENTS =
  'Choose deal owners only for an endpoint that receives Deal added, Deal details, Deal stage, Deal owner or Deal won, lost or reopened.';

/** Deal owners (ADR-265) and task assignees (ADR-266) are chosen from the same members. */
export const WEBHOOK_CRM_MEMBERS_NOT_FOUND =
  'Choose active members of this company who use the CRM.';

/**
 * The owners an endpoint keeps after it is added or changed: every deal (null) unless it takes a
 * deal event; then those given, or else the ones it had.
 */
export function webhookOwnerIdsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesPipelineEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * Refuses members a list (`field`) adds to an endpoint unless each can own deals and be assigned
 * tasks now: a member of the company, active, with access to the CRM, as deal owners and task
 * assignees are chosen. Members the list already held may have left or lost the access since, and
 * stay: they match the deals they still own and the tasks still assigned to them. `tx` is in the
 * company's scope.
 */
async function assertWebhookCrmMembers(
  tx: Tx,
  tenantId: string,
  field: 'ownerIds' | 'taskAssigneeIds',
  ids: readonly string[] | null | undefined,
  held: readonly string[] | null,
): Promise<void> {
  const added = (ids ?? []).filter((id) => !held?.includes(id));
  if (added.length === 0) return;
  const refs = await memberRefs(tx, tenantId, added);
  const index = (ids ?? []).findIndex((id) => added.includes(id) && !refs.get(id)?.active);
  if (index === -1) return;
  throw new AppError('validation_failed', WEBHOOK_CRM_MEMBERS_NOT_FOUND, {
    issues: [{ path: `${field}.${index}`, message: WEBHOOK_CRM_MEMBERS_NOT_FOUND }],
  });
}

/** Refuses deal owners a list adds unless each can own deals now (ADR-265). */
export async function assertWebhookOwners(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null | undefined,
  held: readonly string[] | null = null,
): Promise<void> {
  await assertWebhookCrmMembers(tx, tenantId, 'ownerIds', ids, held);
}

/**
 * The members whose tasks' events an endpoint takes (ADR-266), each once; null takes every task's,
 * including those of members who join later.
 */
export const webhookTaskAssigneeIdsSchema = z
  .array(z.uuid({ error: 'Choose members from the list.' }))
  .min(1, 'Choose at least one member, or take every task.')
  .max(WEBHOOK_LIMITS.taskAssignees, `Choose at most ${WEBHOOK_LIMITS.taskAssignees} members.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const WEBHOOK_TASK_ASSIGNEES_NEED_THE_EVENTS =
  'Choose task assignees only for an endpoint that receives Task added, Task details, Task assignee or Task done, cancelled or reopened.';

/**
 * The assignees an endpoint keeps after it is added or changed: every task (null) unless it takes a
 * task event; then those given, or else the ones it had.
 */
export function webhookTaskAssigneeIdsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesTaskEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/** Refuses task assignees a list adds unless tasks can be assigned to each now (ADR-266). */
export async function assertWebhookTaskAssignees(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null | undefined,
  held: readonly string[] | null = null,
): Promise<void> {
  await assertWebhookCrmMembers(tx, tenantId, 'taskAssigneeIds', ids, held);
}

/**
 * The CRM pipelines whose deals' tasks' events an endpoint takes (ADR-303), each once; null takes
 * every task's, including those without a deal and those of pipelines added later.
 */
export const webhookTaskPipelineIdsSchema = z
  .array(z.uuid({ error: 'Choose pipelines from the list.' }))
  .min(1, 'Choose at least one pipeline, or take every task.')
  .max(WEBHOOK_LIMITS.taskPipelines, `Choose at most ${WEBHOOK_LIMITS.taskPipelines} pipelines.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const WEBHOOK_TASK_PIPELINES_NEED_THE_EVENTS =
  'Choose the pipelines of tasks’ deals only for an endpoint that receives Task added, Task details, Task assignee or Task done, cancelled or reopened.';

/**
 * The pipelines of tasks' deals an endpoint keeps after it is added or changed: every task (null)
 * unless it takes a task event; then those given, or else the ones it had.
 */
export function webhookTaskPipelineIdsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesTaskEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/** Refuses pipelines given for an endpoint's task events unless each is the company's (ADR-303). */
export async function assertWebhookTaskPipelines(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null | undefined,
): Promise<void> {
  await assertCompanyPipelines(tx, tenantId, 'taskPipelineIds', ids);
}

/**
 * The teams whose conversations' message and conversation events an endpoint takes (ADR-174), each
 * once; null takes every conversation's, including those of teams added later.
 */
export const webhookTeamIdsSchema = z
  .array(z.uuid({ error: 'Choose teams from the list.' }))
  .min(1, 'Choose at least one team, or take every conversation.')
  .max(WEBHOOK_LIMITS.teams, `Choose at most ${WEBHOOK_LIMITS.teams} teams.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const WEBHOOK_TEAMS_NEED_THE_EVENTS =
  'Choose teams only for an endpoint that receives message or conversation events.';

export const WEBHOOK_TEAMS_NOT_FOUND = 'Choose teams of this company.';

/**
 * The teams an endpoint keeps after it is added or changed: every conversation (null) unless it
 * takes an event of a conversation; then those given, or else the ones it had.
 */
export function webhookTeamIdsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesTeamEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * Refuses teams a list adds to an endpoint unless each is the company's (ADR-174). Teams the
 * endpoint's list already held may have been deleted since, and stay: they match no conversation.
 * `tx` is in the company's scope.
 */
export async function assertWebhookTeams(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null | undefined,
  held: readonly string[] | null = null,
): Promise<void> {
  const added = (ids ?? []).filter((id) => !held?.includes(id));
  if (added.length === 0) return;
  const rows = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.tenantId, tenantId), inArray(teams.id, added)));
  const found = new Set(rows.map((r) => r.id));
  const index = (ids ?? []).findIndex((id) => added.includes(id) && !found.has(id));
  if (index === -1) return;
  throw new AppError('validation_failed', WEBHOOK_TEAMS_NOT_FOUND, {
    issues: [{ path: `teamIds.${index}`, message: WEBHOOK_TEAMS_NOT_FOUND }],
  });
}

/**
 * The members whose assigned conversations' message and conversation events an endpoint takes
 * (ADR-181), each once; null takes every conversation's, including unassigned ones.
 */
export const webhookAssigneeIdsSchema = z
  .array(z.uuid({ error: 'Choose members from the list.' }))
  .min(1, 'Choose at least one member, or take every conversation.')
  .max(WEBHOOK_LIMITS.assignees, `Choose at most ${WEBHOOK_LIMITS.assignees} members.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const WEBHOOK_ASSIGNEES_NEED_THE_EVENTS =
  'Choose members only for an endpoint that receives message or conversation events.';

export const WEBHOOK_ASSIGNEES_NOT_FOUND = 'Choose members of this company who take conversations.';

/**
 * The members an endpoint keeps after it is added or changed: every conversation (null) unless it
 * takes an event of a conversation; then those given, or else the ones it had.
 */
export function webhookAssigneeIdsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesTeamEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/** Whether conversations can be assigned to a member: active, with a role that answers them. */
const takesConversations = () =>
  sql<boolean>`(${memberships.status} = 'active'
    and ${memberships.roles} && ${sql.param([...INBOX_WORKER_ROLES])}::text[])`;

/**
 * Refuses members a list adds to an endpoint unless conversations can be assigned to each now: a
 * member of the company, active, with a role that reads and answers them (ADR-181). Members the
 * endpoint's list already held may have left or lost that role since, and stay: their conversations
 * were released, and they match nothing while holding none. `tx` is in the company's scope.
 */
export async function assertWebhookAssignees(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null | undefined,
  held: readonly string[] | null = null,
): Promise<void> {
  const added = (ids ?? []).filter((id) => !held?.includes(id));
  if (added.length === 0) return;
  const rows = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.tenantId, tenantId), inArray(memberships.id, added), takesConversations()),
    );
  const found = new Set(rows.map((r) => r.id));
  const index = (ids ?? []).findIndex((id) => added.includes(id) && !found.has(id));
  if (index === -1) return;
  throw new AppError('validation_failed', WEBHOOK_ASSIGNEES_NOT_FOUND, {
    issues: [{ path: `assigneeIds.${index}`, message: WEBHOOK_ASSIGNEES_NOT_FOUND }],
  });
}

/**
 * The contact tags whose conversations' message and conversation events an endpoint takes
 * (ADR-267), as contacts carry them (`normalizeTag`), each once; null takes every conversation's.
 */
export const webhookContactTagsSchema = z
  .array(z.string({ error: 'Give tags as text.' }))
  .min(1, 'Give at least one tag, or take every conversation.')
  .max(WEBHOOK_LIMITS.contactTags, `Give at most ${WEBHOOK_LIMITS.contactTags} tags.`)
  .transform((given, ctx) => {
    const tags: string[] = [];
    for (const [index, raw] of given.entries()) {
      const tag = normalizeTag(raw);
      if (!tag.ok) {
        ctx.addIssue({ code: 'custom', message: tag.message, path: [index] });
        return z.NEVER;
      }
      if (!tags.includes(tag.tag)) tags.push(tag.tag);
    }
    return tags;
  })
  .nullable();

export const WEBHOOK_CONTACT_TAGS_NEED_THE_EVENTS =
  'Choose contact tags only for an endpoint that receives message or conversation events.';

/**
 * The tags an endpoint keeps after it is added or changed: every conversation (null) unless it
 * takes an event of a conversation; then those given, or else the ones it had.
 */
export function webhookContactTagsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesTeamEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/**
 * The conversation tags whose message and conversation events an endpoint takes (ADR-273), as
 * conversations carry them (`normalizeTag`, as contact tags, ADR-220), each once; null takes every
 * conversation's.
 */
export const webhookConversationTagsSchema = z
  .array(z.string({ error: 'Give tags as text.' }))
  .min(1, 'Give at least one tag, or take every conversation.')
  .max(WEBHOOK_LIMITS.conversationTags, `Give at most ${WEBHOOK_LIMITS.conversationTags} tags.`)
  .transform((given, ctx) => {
    const tags: string[] = [];
    for (const [index, raw] of given.entries()) {
      const tag = normalizeTag(raw);
      if (!tag.ok) {
        ctx.addIssue({ code: 'custom', message: tag.message, path: [index] });
        return z.NEVER;
      }
      if (!tags.includes(tag.tag)) tags.push(tag.tag);
    }
    return tags;
  })
  .nullable();

export const WEBHOOK_CONVERSATION_TAGS_NEED_THE_EVENTS =
  'Choose conversation tags only for an endpoint that receives message or conversation events.';

/**
 * The conversation tags an endpoint keeps after it is added or changed: every conversation (null)
 * unless it takes an event of a conversation; then those given, or else the ones it had.
 */
export function webhookConversationTagsFor(
  eventTypes: readonly WebhookEventType[],
  given: readonly string[] | null | undefined,
  current: readonly string[] | null,
): string[] | null {
  if (!webhookTakesTeamEvents(eventTypes)) return null;
  const kept = given === undefined ? current : given;
  return kept ? [...kept] : null;
}

/** A new signing secret: `whsec_` and 32 random bytes. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export const webhookEventTypesSchema = z
  .array(z.enum(WEBHOOK_EVENT_KEYS, { error: 'Choose events from the list' }))
  .min(1, 'Choose at least one event')
  .transform((chosen) => WEBHOOK_EVENT_KEYS.filter((e) => chosen.includes(e)));

/** How the failures to replay went (ADR-159): known kinds, at least one, once each in order. */
export const webhookFailureKindsSchema = z
  .array(z.enum(WEBHOOK_FAILURE_KINDS, { error: 'Choose failures from the list' }))
  .min(1, 'Choose at least one kind of failure')
  .transform((chosen) => WEBHOOK_FAILURE_KINDS.filter((k) => chosen.includes(k)));

const endpointFields = z.object({
  url: z
    .string({ error: 'Enter the endpoint URL' })
    .trim()
    .min(1, 'Enter the endpoint URL')
    .max(WEBHOOK_LIMITS.urlLength, 'The URL is too long'),
  description: z
    .string()
    .trim()
    .max(WEBHOOK_LIMITS.descriptionLength, 'Keep the description under 200 characters')
    .optional()
    .default(''),
  eventTypes: webhookEventTypesSchema,
  /** Given, the endpoint's headers become these; left out, a change keeps them. */
  headers: webhookHeadersSchema.optional(),
  /** Given, the `message.status` statuses it takes (null: every status); left out, they stay. */
  messageStatuses: webhookMessageStatusesSchema.optional(),
  /**
   * Given, who sent the messages whose statuses it takes (null: every sender, ADR-172); left out,
   * they stay.
   */
  messageSenders: webhookMessageSendersSchema.optional(),
  /**
   * Given, the contact parts it takes as `contact.updated` (null: every change); left out, they
   * stay.
   */
  contactParts: webhookContactPartsSchema.optional(),
  /**
   * Given, the custom fields whose changes it takes (null: every field, ADR-184); left out, they
   * stay.
   */
  contactFieldKeys: webhookContactFieldKeysSchema.optional(),
  /**
   * Given, the automations whose runs it takes (null: every automation, ADR-145); left out, they
   * stay.
   */
  automationIds: webhookAutomationIdsSchema.optional(),
  /**
   * Given, the campaign statuses it takes (null: every status, ADR-146); left out, they stay.
   */
  campaignStatuses: webhookCampaignStatusesSchema.optional(),
  /** Given, the order statuses it takes (null: every status, ADR-147); left out, they stay. */
  orderStatuses: webhookOrderStatusesSchema.optional(),
  /** Given, the template statuses it takes (null: every status, ADR-148); left out, they stay. */
  templateStatuses: webhookTemplateStatusesSchema.optional(),
  /**
   * Given, the conversation statuses it takes (null: every status, ADR-149); left out, they stay.
   */
  conversationStatuses: webhookConversationStatusesSchema.optional(),
  /** Given, how the runs it takes ended (null: every end, ADR-151); left out, they stay. */
  runEndStatuses: webhookRunEndStatusesSchema.optional(),
  /** Given, what started the runs it takes (null: every run, ADR-183); left out, they stay. */
  runTriggers: webhookRunTriggersSchema.optional(),
  /** Given, the consent changes it takes (null: every change, ADR-189); left out, they stay. */
  consentChanges: webhookConsentChangesSchema.optional(),
  /** Given, where the contacts it takes came from (null: every one, ADR-190); left out, they stay. */
  contactSources: webhookContactSourcesSchema.optional(),
  /** Given, the types of the received messages it takes (null: every type, ADR-191); left out, they stay. */
  messageTypes: webhookMessageTypesSchema.optional(),
  /** Given, why the runs it takes ended (null: every reason, ADR-192); left out, they stay. */
  runEndReasons: webhookRunEndReasonsSchema.optional(),
  /**
   * Given, the numbers whose events it takes (null: every number, ADR-170); left out, they stay.
   */
  channelIds: webhookChannelIdsSchema.optional(),
  /**
   * Given, the teams whose conversations' events it takes (null: every conversation's, ADR-174);
   * left out, they stay.
   */
  teamIds: webhookTeamIdsSchema.optional(),
  /**
   * Given, the templates whose messages' statuses and changes it takes (null: every template's,
   * ADR-175); left out, they stay.
   */
  templateIds: webhookTemplateIdsSchema.optional(),
  /**
   * Given, the campaigns whose messages' statuses and changes it takes (null: every campaign's,
   * ADR-185); left out, they stay.
   */
  campaignIds: webhookCampaignIdsSchema.optional(),
  /**
   * Given, the CRM pipelines whose deals' events it takes (null: every pipeline's, ADR-263); left
   * out, they stay.
   */
  pipelineIds: webhookPipelineIdsSchema.optional(),
  /**
   * Given, the CRM stages whose deals' events it takes (null: every stage's, ADR-264); left out,
   * they stay.
   */
  stageIds: webhookStageIdsSchema.optional(),
  /**
   * Given, the members whose deals' events it takes (null: every deal's, ADR-265); left out, they
   * stay.
   */
  ownerIds: webhookOwnerIdsSchema.optional(),
  /**
   * Given, the members whose tasks' events it takes (null: every task's, ADR-266); left out, they
   * stay.
   */
  taskAssigneeIds: webhookTaskAssigneeIdsSchema.optional(),
  /**
   * Given, the CRM pipelines whose deals' tasks' events it takes (null: every task's, ADR-303); left
   * out, they stay.
   */
  taskPipelineIds: webhookTaskPipelineIdsSchema.optional(),
  /**
   * Given, the members whose assigned conversations' events it takes (null: every conversation's,
   * ADR-181); left out, they stay.
   */
  assigneeIds: webhookAssigneeIdsSchema.optional(),
  /**
   * Given, the contact tags whose conversations' events it takes (null: every conversation's,
   * ADR-267); left out, they stay.
   */
  contactTags: webhookContactTagsSchema.optional(),
  /**
   * Given, the conversation tags whose events it takes (null: every conversation's, ADR-273); left
   * out, they stay.
   */
  conversationTags: webhookConversationTagsSchema.optional(),
  /** Given, its OAuth client (null: none, ADR-173); left out, it stays. */
  oauth: webhookOAuthSchema.nullable().optional(),
});
/** Statuses are chosen only for an endpoint that takes `message.status`. */
const statusesNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; messageStatuses?: unknown }) =>
    !data.messageStatuses || data.eventTypes.includes('message.status'),
  options: { path: ['messageStatuses'], message: WEBHOOK_STATUSES_NEED_THE_EVENT },
};
/** Senders are chosen only for an endpoint that takes `message.status` (ADR-172). */
const sendersNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; messageSenders?: unknown }) =>
    !data.messageSenders || data.eventTypes.includes('message.status'),
  options: { path: ['messageSenders'], message: WEBHOOK_SENDERS_NEED_THE_EVENT },
};
/** Contact parts are chosen only for an endpoint that takes `contact.updated` (ADR-123). */
const partsNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; contactParts?: unknown }) =>
    !data.contactParts || data.eventTypes.includes('contact.updated'),
  options: { path: ['contactParts'], message: WEBHOOK_PARTS_NEED_THE_EVENT },
};
/** Automations are chosen only for an endpoint that takes automation runs (ADR-145). */
const automationsNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; automationIds?: unknown }) =>
    !data.automationIds || webhookTakesAutomationRuns(data.eventTypes),
  options: { path: ['automationIds'], message: WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS },
};
/** Campaign statuses are chosen only for an endpoint that takes campaign changes (ADR-146). */
const campaignStatusesNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; campaignStatuses?: unknown }) =>
    !data.campaignStatuses || data.eventTypes.includes('campaign.status_changed'),
  options: { path: ['campaignStatuses'], message: WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT },
};
/** Order statuses are chosen only for an endpoint that takes order changes (ADR-147). */
const orderStatusesNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; orderStatuses?: unknown }) =>
    !data.orderStatuses || data.eventTypes.includes('order.status_changed'),
  options: { path: ['orderStatuses'], message: WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT },
};
/** Template statuses are chosen only for an endpoint that takes template changes (ADR-148). */
const templateStatusesNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; templateStatuses?: unknown }) =>
    !data.templateStatuses || data.eventTypes.includes('template.status_changed'),
  options: { path: ['templateStatuses'], message: WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT },
};
/** Conversation statuses are chosen only for an endpoint that takes their changes (ADR-149). */
const conversationStatusesNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; conversationStatuses?: unknown }) =>
    !data.conversationStatuses || data.eventTypes.includes('conversation.status_changed'),
  options: {
    path: ['conversationStatuses'],
    message: WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT,
  },
};
/** How runs ended is chosen only for an endpoint that takes their ends (ADR-151). */
const runEndStatusesNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; runEndStatuses?: unknown }) =>
    !data.runEndStatuses || data.eventTypes.includes('automation.run_ended'),
  options: { path: ['runEndStatuses'], message: WEBHOOK_RUN_END_STATUSES_NEED_THE_EVENT },
};
/** What started the runs is chosen only for an endpoint that takes run events (ADR-183). */
const runTriggersNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; runTriggers?: unknown }) =>
    !data.runTriggers || webhookTakesAutomationRuns(data.eventTypes),
  options: { path: ['runTriggers'], message: WEBHOOK_RUN_TRIGGERS_NEED_THE_EVENTS },
};
/** Consent changes are chosen only for an endpoint that takes `consent.changed` (ADR-189). */
const consentChangesNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; consentChanges?: unknown }) =>
    !data.consentChanges || data.eventTypes.includes('consent.changed'),
  options: { path: ['consentChanges'], message: WEBHOOK_CONSENT_CHANGES_NEED_THE_EVENT },
};
/** Where contacts came from is chosen only for an endpoint that takes `contact.created` (ADR-190). */
const contactSourcesNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; contactSources?: unknown }) =>
    !data.contactSources || data.eventTypes.includes('contact.created'),
  options: { path: ['contactSources'], message: WEBHOOK_CONTACT_SOURCES_NEED_THE_EVENT },
};
/** Message types are chosen only for an endpoint that takes `message.received` (ADR-191). */
const messageTypesNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; messageTypes?: unknown }) =>
    !data.messageTypes || data.eventTypes.includes('message.received'),
  options: { path: ['messageTypes'], message: WEBHOOK_MESSAGE_TYPES_NEED_THE_EVENT },
};
/** End reasons are chosen only for an endpoint that takes `automation.run_ended` (ADR-192). */
const runEndReasonsNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; runEndReasons?: unknown }) =>
    !data.runEndReasons || data.eventTypes.includes('automation.run_ended'),
  options: { path: ['runEndReasons'], message: WEBHOOK_RUN_END_REASONS_NEED_THE_EVENT },
};
/** Numbers are chosen only for an endpoint that takes events of numbers (ADR-170). */
const channelsNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; channelIds?: unknown }) =>
    !data.channelIds || webhookTakesChannelEvents(data.eventTypes),
  options: { path: ['channelIds'], message: WEBHOOK_CHANNELS_NEED_THE_EVENTS },
};
/** Teams are chosen only for an endpoint that takes events of conversations (ADR-174). */
const teamsNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; teamIds?: unknown }) =>
    !data.teamIds || webhookTakesTeamEvents(data.eventTypes),
  options: { path: ['teamIds'], message: WEBHOOK_TEAMS_NEED_THE_EVENTS },
};
/** Templates are chosen only for an endpoint that takes events of templates (ADR-175). */
const templatesNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; templateIds?: unknown }) =>
    !data.templateIds || webhookTakesTemplateEvents(data.eventTypes),
  options: { path: ['templateIds'], message: WEBHOOK_TEMPLATES_NEED_THE_EVENTS },
};
/** Campaigns are chosen only for an endpoint that takes events of campaigns (ADR-185). */
const campaignsNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; campaignIds?: unknown }) =>
    !data.campaignIds || webhookTakesCampaignEvents(data.eventTypes),
  options: { path: ['campaignIds'], message: WEBHOOK_CAMPAIGNS_NEED_THE_EVENTS },
};
/** Pipelines are chosen only for an endpoint that takes deal events (ADR-263). */
const pipelinesNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; pipelineIds?: unknown }) =>
    !data.pipelineIds || webhookTakesPipelineEvents(data.eventTypes),
  options: { path: ['pipelineIds'], message: WEBHOOK_PIPELINES_NEED_THE_EVENTS },
};
/** Stages are chosen only for an endpoint that takes deal events (ADR-264). */
const stagesNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; stageIds?: unknown }) =>
    !data.stageIds || webhookTakesPipelineEvents(data.eventTypes),
  options: { path: ['stageIds'], message: WEBHOOK_STAGES_NEED_THE_EVENTS },
};
/** Deal owners are chosen only for an endpoint that takes deal events (ADR-265). */
const ownersNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; ownerIds?: unknown }) =>
    !data.ownerIds || webhookTakesPipelineEvents(data.eventTypes),
  options: { path: ['ownerIds'], message: WEBHOOK_OWNERS_NEED_THE_EVENTS },
};
/** Task assignees are chosen only for an endpoint that takes task events (ADR-266). */
const taskAssigneesNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; taskAssigneeIds?: unknown }) =>
    !data.taskAssigneeIds || webhookTakesTaskEvents(data.eventTypes),
  options: { path: ['taskAssigneeIds'], message: WEBHOOK_TASK_ASSIGNEES_NEED_THE_EVENTS },
};
/** The pipelines of tasks' deals are chosen only for an endpoint that takes task events (ADR-303). */
const taskPipelinesNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; taskPipelineIds?: unknown }) =>
    !data.taskPipelineIds || webhookTakesTaskEvents(data.eventTypes),
  options: { path: ['taskPipelineIds'], message: WEBHOOK_TASK_PIPELINES_NEED_THE_EVENTS },
};
/** Members are chosen only for an endpoint that takes events of conversations (ADR-181). */
const assigneesNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; assigneeIds?: unknown }) =>
    !data.assigneeIds || webhookTakesTeamEvents(data.eventTypes),
  options: { path: ['assigneeIds'], message: WEBHOOK_ASSIGNEES_NEED_THE_EVENTS },
};
/** Contact tags are chosen only for an endpoint that takes events of conversations (ADR-267). */
const contactTagsNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; contactTags?: unknown }) =>
    !data.contactTags || webhookTakesTeamEvents(data.eventTypes),
  options: { path: ['contactTags'], message: WEBHOOK_CONTACT_TAGS_NEED_THE_EVENTS },
};
/** Conversation tags are chosen only for an endpoint that takes events of conversations (ADR-273). */
const conversationTagsNeedTheEvents = {
  check: (data: { eventTypes: WebhookEventType[]; conversationTags?: unknown }) =>
    !data.conversationTags || webhookTakesTeamEvents(data.eventTypes),
  options: { path: ['conversationTags'], message: WEBHOOK_CONVERSATION_TAGS_NEED_THE_EVENTS },
};
const endpointSchema = endpointFields
  .refine(statusesNeedTheEvent.check, statusesNeedTheEvent.options)
  .refine(sendersNeedTheEvent.check, sendersNeedTheEvent.options)
  .refine(partsNeedTheEvent.check, partsNeedTheEvent.options)
  .refine(automationsNeedTheEvents.check, automationsNeedTheEvents.options)
  .refine(campaignStatusesNeedTheEvent.check, campaignStatusesNeedTheEvent.options)
  .refine(orderStatusesNeedTheEvent.check, orderStatusesNeedTheEvent.options)
  .refine(templateStatusesNeedTheEvent.check, templateStatusesNeedTheEvent.options)
  .refine(conversationStatusesNeedTheEvent.check, conversationStatusesNeedTheEvent.options)
  .refine(runEndStatusesNeedTheEvent.check, runEndStatusesNeedTheEvent.options)
  .refine(runTriggersNeedTheEvents.check, runTriggersNeedTheEvents.options)
  .refine(consentChangesNeedTheEvent.check, consentChangesNeedTheEvent.options)
  .refine(contactSourcesNeedTheEvent.check, contactSourcesNeedTheEvent.options)
  .refine(messageTypesNeedTheEvent.check, messageTypesNeedTheEvent.options)
  .refine(runEndReasonsNeedTheEvent.check, runEndReasonsNeedTheEvent.options)
  .refine(channelsNeedTheEvents.check, channelsNeedTheEvents.options)
  .refine(teamsNeedTheEvents.check, teamsNeedTheEvents.options)
  .refine(templatesNeedTheEvents.check, templatesNeedTheEvents.options)
  .refine(campaignsNeedTheEvents.check, campaignsNeedTheEvents.options)
  .refine(pipelinesNeedTheEvents.check, pipelinesNeedTheEvents.options)
  .refine(stagesNeedTheEvents.check, stagesNeedTheEvents.options)
  .refine(ownersNeedTheEvents.check, ownersNeedTheEvents.options)
  .refine(taskAssigneesNeedTheEvents.check, taskAssigneesNeedTheEvents.options)
  .refine(taskPipelinesNeedTheEvents.check, taskPipelinesNeedTheEvents.options)
  .refine(assigneesNeedTheEvents.check, assigneesNeedTheEvents.options)
  .refine(contactTagsNeedTheEvents.check, contactTagsNeedTheEvents.options)
  .refine(conversationTagsNeedTheEvents.check, conversationTagsNeedTheEvents.options);
const endpointIdSchema = z.object({ endpointId: z.uuid() });
const updateSchema = endpointFields
  .extend({ endpointId: z.uuid() })
  .refine(statusesNeedTheEvent.check, statusesNeedTheEvent.options)
  .refine(sendersNeedTheEvent.check, sendersNeedTheEvent.options)
  .refine(partsNeedTheEvent.check, partsNeedTheEvent.options)
  .refine(automationsNeedTheEvents.check, automationsNeedTheEvents.options)
  .refine(campaignStatusesNeedTheEvent.check, campaignStatusesNeedTheEvent.options)
  .refine(orderStatusesNeedTheEvent.check, orderStatusesNeedTheEvent.options)
  .refine(templateStatusesNeedTheEvent.check, templateStatusesNeedTheEvent.options)
  .refine(conversationStatusesNeedTheEvent.check, conversationStatusesNeedTheEvent.options)
  .refine(runEndStatusesNeedTheEvent.check, runEndStatusesNeedTheEvent.options)
  .refine(runTriggersNeedTheEvents.check, runTriggersNeedTheEvents.options)
  .refine(consentChangesNeedTheEvent.check, consentChangesNeedTheEvent.options)
  .refine(contactSourcesNeedTheEvent.check, contactSourcesNeedTheEvent.options)
  .refine(messageTypesNeedTheEvent.check, messageTypesNeedTheEvent.options)
  .refine(runEndReasonsNeedTheEvent.check, runEndReasonsNeedTheEvent.options)
  .refine(channelsNeedTheEvents.check, channelsNeedTheEvents.options)
  .refine(teamsNeedTheEvents.check, teamsNeedTheEvents.options)
  .refine(templatesNeedTheEvents.check, templatesNeedTheEvents.options)
  .refine(campaignsNeedTheEvents.check, campaignsNeedTheEvents.options)
  .refine(pipelinesNeedTheEvents.check, pipelinesNeedTheEvents.options)
  .refine(stagesNeedTheEvents.check, stagesNeedTheEvents.options)
  .refine(ownersNeedTheEvents.check, ownersNeedTheEvents.options)
  .refine(taskAssigneesNeedTheEvents.check, taskAssigneesNeedTheEvents.options)
  .refine(taskPipelinesNeedTheEvents.check, taskPipelinesNeedTheEvents.options)
  .refine(assigneesNeedTheEvents.check, assigneesNeedTheEvents.options)
  .refine(contactTagsNeedTheEvents.check, contactTagsNeedTheEvents.options)
  .refine(conversationTagsNeedTheEvents.check, conversationTagsNeedTheEvents.options);
const enabledSchema = endpointIdSchema.extend({ enabled: z.boolean() });
const deliveryIdSchema = z.object({ deliveryId: z.uuid() });
const replayAllFailedSchema = z.object({
  period: z.enum(
    WEBHOOK_REPLAY_PERIODS.map((p) => p.key),
    { error: 'Choose a period from the list' },
  ),
  events: webhookEventTypesSchema.optional(),
  failures: webhookFailureKindsSchema.optional(),
});
const replayFailedSchema = replayAllFailedSchema.extend(endpointIdSchema.shape);

export interface WebhookEndpointView {
  id: string;
  url: string;
  description: string | null;
  eventTypes: WebhookEventType[];
  state: 'active' | 'disabled';
  disabledReason: 'manual' | 'failing' | null;
  disabledAt: Date | null;
  failingSince: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  secretVersion: number;
  /** Until when the previous secret also signs; null when it no longer does. */
  previousSecretExpiresAt: Date | null;
  /** The names of the endpoint's own headers (ADR-118); their values are never shown. */
  headerNames: string[];
  /** The `message.status` statuses it takes (ADR-119); null takes every status. */
  messageStatuses: WebhookMessageStatus[] | null;
  /** Who sent the messages whose statuses it takes (ADR-172); null takes every sender. */
  messageSenders: WebhookMessageSender[] | null;
  /** The contact parts it takes as `contact.updated` (ADR-123); null takes every change. */
  contactParts: WebhookContactPart[] | null;
  /**
   * The custom fields whose changes it takes (ADR-184), as stored, labelled; null takes every
   * field's.
   */
  contactFields: WebhookEndpointField[] | null;
  /**
   * The automations whose runs it takes (ADR-145), as stored, with their names and whether they
   * are archived; null takes every automation.
   */
  automations: WebhookEndpointAutomation[] | null;
  /** The campaign statuses it takes (ADR-146); null takes every status. */
  campaignStatuses: WebhookCampaignStatus[] | null;
  /** The order statuses it takes (ADR-147); null takes every status. */
  orderStatuses: WebhookOrderStatus[] | null;
  /** The template statuses it takes (ADR-148); null takes every status. */
  templateStatuses: WebhookTemplateStatus[] | null;
  /** The conversation statuses it takes (ADR-149); null takes every status. */
  conversationStatuses: WebhookConversationStatus[] | null;
  /** How the runs it takes as `automation.run_ended` ended (ADR-151); null takes every end. */
  runEndStatuses: WebhookRunEndStatus[] | null;
  /** What started the runs whose events it takes (ADR-183); null takes every run's. */
  runTriggers: WebhookRunTrigger[] | null;
  /** The consent changes it takes as `consent.changed` (ADR-189); null takes every change. */
  consentChanges: WebhookConsentChange[] | null;
  /** Where the contacts whose `contact.created` it takes came from (ADR-190); null: every contact. */
  contactSources: ContactSource[] | null;
  /** The types of the received messages it takes as `message.received` (ADR-191); null: every type. */
  messageTypes: WebhookReceivedMessageType[] | null;
  /** Why the runs it takes as `automation.run_ended` ended (ADR-192); null takes every reason. */
  runEndReasons: AutomationEndReason[] | null;
  /** The numbers whose events it takes (ADR-170), as stored, named; null takes every number. */
  channels: WebhookEndpointChannel[] | null;
  /**
   * The teams whose conversations' events it takes (ADR-174), as stored, named; null takes every
   * conversation's.
   */
  teams: WebhookEndpointTeam[] | null;
  /**
   * The templates whose messages' statuses and changes it takes (ADR-175), as stored, named; null
   * takes every template's.
   */
  templates: WebhookTemplateChoice[] | null;
  /**
   * The campaigns whose messages' statuses and changes it takes (ADR-185), as stored, named; null
   * takes every campaign's.
   */
  campaigns: WebhookEndpointCampaign[] | null;
  /**
   * The CRM pipelines whose deals' events it takes (ADR-263), as stored, named, with whether they
   * are archived; null takes every pipeline's.
   */
  pipelines: WebhookEndpointPipeline[] | null;
  /**
   * The CRM stages whose deals' events it takes (ADR-264), as stored, named with their pipelines,
   * with whether they were removed or their pipelines archived; null takes every stage's.
   */
  stages: WebhookEndpointStage[] | null;
  /**
   * The members whose deals' events it takes (ADR-265), as stored, named, with whether they can own
   * deals now; null takes every deal's.
   */
  owners: WebhookEndpointOwner[] | null;
  /**
   * The members whose tasks' events it takes (ADR-266), as stored, named, with whether tasks can be
   * assigned to them now; null takes every task's.
   */
  taskAssignees: WebhookEndpointOwner[] | null;
  /**
   * The CRM pipelines whose deals' tasks' events it takes (ADR-303), as stored, named, with whether
   * they are archived; null takes every task's.
   */
  taskPipelines: WebhookEndpointPipeline[] | null;
  /**
   * The members whose assigned conversations' events it takes (ADR-181), as stored, named, with
   * whether conversations can still be assigned to them; null takes every conversation's.
   */
  assignees: WebhookEndpointAssignee[] | null;
  /**
   * The contact tags whose conversations' events it takes (ADR-267), as stored; null takes every
   * conversation's.
   */
  contactTags: string[] | null;
  /**
   * The conversation tags whose events it takes (ADR-273), as stored; null takes every
   * conversation's.
   */
  conversationTags: string[] | null;
  /** Where it gets OAuth tokens and as which client (ADR-173); the secret is never shown. */
  oauth: WebhookEndpointOAuth | null;
  createdAt: Date;
  /** The member who added the endpoint in settings (null once their account is gone). */
  createdBy: string | null;
  /** The API key that added it through the API (ADR-081). */
  createdByKey: { name: string; keyPrefix: string } | null;
  /** Deliveries created in the last 24 hours, by state. */
  recent: Record<WebhookDeliveryState, number>;
}

export interface WebhookDeliveryView {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  state: WebhookDeliveryState;
  attempts: number;
  nextAttemptAt: Date;
  lastAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  deliveredAt: Date | null;
  replayOf: string | null;
  createdAt: Date;
}

/**
 * The URL as it will be called, after the egress guard's rules (https, no credentials, ports): an
 * endpoint's (`url`), or its OAuth token URL (`oauth.tokenUrl`, ADR-173), which is held to the
 * same rules.
 */
export function checkedWebhookUrl(
  raw: string,
  policy: Pick<EgressPolicy, 'allowLoopbackForTests'>,
  path: 'url' | 'oauth.tokenUrl' = 'url',
) {
  const invalid = (message: string) =>
    new AppError('validation_failed', message, { issues: [{ path, message }] });
  let target: ReturnType<typeof parseEgressUrl>;
  try {
    target = parseEgressUrl(raw, policy);
  } catch (error) {
    if (error instanceof EgressError) throw invalid(error.message);
    throw error;
  }
  target.url.hash = '';
  const url = target.url.toString();
  // Normalising (percent-encoding) can lengthen what was entered.
  if (url.length > WEBHOOK_LIMITS.urlLength) {
    throw invalid(path === 'url' ? 'The URL is too long' : 'The token URL is too long');
  }
  return { url, host: target.hostname };
}

/** An endpoint's OAuth columns (ADR-173): all null without an OAuth client. */
export interface WebhookOAuthColumns {
  oauthTokenUrl: string | null;
  oauthClientId: string | null;
  oauthClientSecretCiphertext: string | null;
  oauthScope: string | null;
}

export const NO_WEBHOOK_OAUTH: WebhookOAuthColumns = {
  oauthTokenUrl: null,
  oauthClientId: null,
  oauthClientSecretCiphertext: null,
  oauthScope: null,
};

/**
 * An OAuth client given for an endpoint, its token URL checked; a null secret keeps the stored one.
 */
export interface CheckedWebhookOAuth extends Omit<WebhookOAuthClient, 'clientSecret'> {
  clientSecret: string | null;
  /** The token URL's host, the only part of it audit entries name. */
  host: string;
}

/**
 * Checks an OAuth client given for an endpoint (ADR-173): its token URL like an endpoint's URL, and
 * that a secret is given unless the endpoint keeps the one it has, which it can only while the token
 * URL stays the same, since the secret is sent there.
 */
export function checkedWebhookOAuth(
  given: WebhookOAuthInput,
  current: WebhookOAuthColumns,
  policy: Pick<EgressPolicy, 'allowLoopbackForTests'>,
): CheckedWebhookOAuth {
  const { url, host } = checkedWebhookUrl(given.tokenUrl, policy, 'oauth.tokenUrl');
  const keeps = current.oauthClientSecretCiphertext !== null && current.oauthTokenUrl === url;
  if (given.clientSecret === undefined && !keeps) {
    const message = current.oauthTokenUrl
      ? WEBHOOK_OAUTH_SECRET_FOR_NEW_URL
      : WEBHOOK_OAUTH_SECRET_NEEDED;
    throw new AppError('validation_failed', message, {
      issues: [{ path: 'oauth.clientSecret', message }],
    });
  }
  return {
    tokenUrl: url,
    host,
    clientId: given.clientId,
    clientSecret: given.clientSecret ?? null,
    scope: given.scope ?? null,
  };
}

/**
 * The OAuth columns an endpoint keeps (ADR-173): none without a client; else the client, its secret
 * sealed with the keyring, bound to the company and the endpoint, or the one it has kept.
 */
export function webhookOAuthColumns(
  keyring: Keyring,
  tenantId: string,
  endpointId: string,
  oauth: CheckedWebhookOAuth | null,
  current: WebhookOAuthColumns,
): WebhookOAuthColumns {
  if (!oauth) return NO_WEBHOOK_OAUTH;
  let sealed = current.oauthClientSecretCiphertext;
  if (oauth.clientSecret !== null) {
    sealed = keyring.encrypt(oauth.clientSecret, webhookOAuthSecretAad(tenantId, endpointId));
  }
  if (!sealed) throw new Error('An OAuth client kept its secret without one stored');
  return {
    oauthTokenUrl: oauth.tokenUrl,
    oauthClientId: oauth.clientId,
    oauthClientSecretCiphertext: sealed,
    oauthScope: oauth.scope,
  };
}

/**
 * An endpoint's OAuth client, opened for its token requests, or null without one. Throws when the
 * keyring cannot open the secret (a key the platform no longer holds).
 */
export function openWebhookOAuthClient(
  keyring: Keyring,
  tenantId: string,
  endpointId: string,
  columns: WebhookOAuthColumns,
): WebhookOAuthClient | null {
  const { oauthTokenUrl, oauthClientId, oauthClientSecretCiphertext } = columns;
  if (!oauthTokenUrl || !oauthClientId || !oauthClientSecretCiphertext) return null;
  return {
    tokenUrl: oauthTokenUrl,
    clientId: oauthClientId,
    clientSecret: keyring.decryptString(
      oauthClientSecretCiphertext,
      webhookOAuthSecretAad(tenantId, endpointId),
    ),
    scope: columns.oauthScope,
  };
}

/**
 * An endpoint either gets OAuth tokens or sends an Authorization header of its own, since the token
 * goes in that header (ADR-173). `headersGiven`: the headers the request gave, to name the one at
 * fault; else the OAuth client is.
 */
export function assertWebhookAuthorization(
  headerNames: readonly string[],
  oauth: boolean,
  headersGiven: readonly WebhookHeader[] | undefined,
): void {
  if (!oauth) return;
  const index = headerNames.findIndex((name) => name.toLowerCase() === 'authorization');
  if (index === -1) return;
  const path = headersGiven ? `headers.${index}.name` : 'oauth';
  throw new AppError('validation_failed', WEBHOOK_OAUTH_AUTHORIZATION, {
    issues: [{ path, message: WEBHOOK_OAUTH_AUTHORIZATION }],
  });
}

/**
 * What a change's audit entry says of the endpoint's OAuth client (ADR-173): the token URL's host
 * and whether a new secret was given, or that the client was removed; nothing when it was left out.
 */
export function webhookOAuthAudit(
  oauth: CheckedWebhookOAuth | null | undefined,
  current: WebhookOAuthColumns,
): Record<string, unknown> {
  if (oauth === undefined) return {};
  if (oauth === null) return current.oauthTokenUrl ? { oauthRemoved: true } : {};
  return { oauthTokenHost: oauth.host, oauthSecretReplaced: oauth.clientSecret !== null };
}

/** Takes the company's endpoint lock, so two creations cannot pass the endpoint limit together. */
async function lockEndpoints(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`webhook-endpoints:${tenantId}`}, 0))`,
  );
}

/**
 * Locks an endpoint for a change. Writers lock the endpoint before its deliveries. `no key update`
 * (the default) still lets the capture triggers add deliveries meanwhile; deleting needs `update`.
 * `keysOnly` finds only endpoints API keys created (ADR-081): others are not found.
 */
export async function lockWebhookEndpoint(
  tx: Tx,
  tenantId: string,
  endpointId: string,
  strength: 'no key update' | 'update' = 'no key update',
  options: { keysOnly?: boolean } = {},
) {
  const [endpoint] = await tx
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      state: webhookEndpoints.state,
      secretVersion: webhookEndpoints.secretVersion,
      secretCiphertext: webhookEndpoints.secretCiphertext,
      eventTypes: webhookEndpoints.eventTypes,
      messageStatuses: webhookEndpoints.messageStatuses,
      messageSenders: webhookEndpoints.messageSenders,
      contactParts: webhookEndpoints.contactParts,
      contactFieldKeys: webhookEndpoints.contactFieldKeys,
      automationIds: webhookEndpoints.automationIds,
      campaignStatuses: webhookEndpoints.campaignStatuses,
      orderStatuses: webhookEndpoints.orderStatuses,
      templateStatuses: webhookEndpoints.templateStatuses,
      conversationStatuses: webhookEndpoints.conversationStatuses,
      runEndStatuses: webhookEndpoints.runEndStatuses,
      runTriggers: webhookEndpoints.runTriggers,
      consentChanges: webhookEndpoints.consentChanges,
      contactSources: webhookEndpoints.contactSources,
      messageTypes: webhookEndpoints.messageTypes,
      runEndReasons: webhookEndpoints.runEndReasons,
      channelAccountIds: webhookEndpoints.channelAccountIds,
      teamIds: webhookEndpoints.teamIds,
      templateIds: webhookEndpoints.templateIds,
      campaignIds: webhookEndpoints.campaignIds,
      pipelineIds: webhookEndpoints.pipelineIds,
      stageIds: webhookEndpoints.stageIds,
      ownerIds: webhookEndpoints.ownerIds,
      taskAssigneeIds: webhookEndpoints.taskAssigneeIds,
      taskPipelineIds: webhookEndpoints.taskPipelineIds,
      assigneeIds: webhookEndpoints.assigneeIds,
      contactTags: webhookEndpoints.contactTags,
      conversationTags: webhookEndpoints.conversationTags,
      headerNames: webhookEndpoints.headerNames,
      oauthTokenUrl: webhookEndpoints.oauthTokenUrl,
      oauthClientId: webhookEndpoints.oauthClientId,
      oauthClientSecretCiphertext: webhookEndpoints.oauthClientSecretCiphertext,
      oauthScope: webhookEndpoints.oauthScope,
    })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.tenantId, tenantId),
        eq(webhookEndpoints.id, endpointId),
        options.keysOnly ? isNotNull(webhookEndpoints.createdByApiKeyId) : undefined,
      ),
    )
    .for(strength);
  if (!endpoint) throw notFound('Webhook endpoint');
  return endpoint;
}

type LockedWebhookEndpoint = Awaited<ReturnType<typeof lockWebhookEndpoint>>;

/** Who creates an endpoint: a member in settings, or an API key (ADR-081). */
export type WebhookEndpointCreator = { userId: string } | { apiKeyId: string };

/**
 * Stores a new endpoint with its first secret, under the company's endpoint lock, refusing one
 * more than the limit. The URL was checked by `checkedWebhookUrl`. The secret is returned once.
 */
export async function insertWebhookEndpoint(
  tx: Tx,
  keyring: Keyring,
  tenantId: string,
  input: {
    url: string;
    description: string | null;
    eventTypes: WebhookEventType[];
    headers: readonly WebhookHeader[];
    messageStatuses: WebhookMessageStatus[] | null;
    messageSenders: WebhookMessageSender[] | null;
    contactParts: WebhookContactPart[] | null;
    contactFieldKeys: string[] | null;
    automationIds: string[] | null;
    campaignStatuses: WebhookCampaignStatus[] | null;
    orderStatuses: WebhookOrderStatus[] | null;
    templateStatuses: WebhookTemplateStatus[] | null;
    conversationStatuses: WebhookConversationStatus[] | null;
    runEndStatuses: WebhookRunEndStatus[] | null;
    runTriggers: WebhookRunTrigger[] | null;
    consentChanges: WebhookConsentChange[] | null;
    contactSources: ContactSource[] | null;
    messageTypes: WebhookReceivedMessageType[] | null;
    runEndReasons: AutomationEndReason[] | null;
    channelAccountIds: string[] | null;
    teamIds: string[] | null;
    templateIds: string[] | null;
    campaignIds: string[] | null;
    pipelineIds: string[] | null;
    stageIds: string[] | null;
    ownerIds: string[] | null;
    taskAssigneeIds: string[] | null;
    taskPipelineIds: string[] | null;
    assigneeIds: string[] | null;
    contactTags: string[] | null;
    conversationTags: string[] | null;
    /** Its OAuth client (ADR-173), checked by `checkedWebhookOAuth` with nothing stored. */
    oauth: CheckedWebhookOAuth | null;
    creator: WebhookEndpointCreator;
  },
): Promise<{ id: string; secret: string }> {
  await lockEndpoints(tx, tenantId);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.tenantId, tenantId));
  if ((row?.n ?? 0) >= WEBHOOK_LIMITS.endpoints) {
    throw new AppError(
      'precondition_failed',
      `A company can have ${WEBHOOK_LIMITS.endpoints} webhook endpoints. Delete one first.`,
    );
  }
  const id = uuidv7();
  const secret = generateWebhookSecret();
  await tx.insert(webhookEndpoints).values({
    id,
    tenantId,
    url: input.url,
    description: input.description,
    eventTypes: input.eventTypes,
    secretCiphertext: keyring.encrypt(secret, webhookSecretAad(tenantId, id, 1)),
    ...sealWebhookHeaders(keyring, tenantId, id, input.headers),
    messageStatuses: input.messageStatuses,
    messageSenders: input.messageSenders,
    contactParts: input.contactParts,
    contactFieldKeys: input.contactFieldKeys,
    automationIds: input.automationIds,
    campaignStatuses: input.campaignStatuses,
    orderStatuses: input.orderStatuses,
    templateStatuses: input.templateStatuses,
    conversationStatuses: input.conversationStatuses,
    runEndStatuses: input.runEndStatuses,
    runTriggers: input.runTriggers,
    consentChanges: input.consentChanges,
    contactSources: input.contactSources,
    messageTypes: input.messageTypes,
    runEndReasons: input.runEndReasons,
    channelAccountIds: input.channelAccountIds,
    teamIds: input.teamIds,
    templateIds: input.templateIds,
    campaignIds: input.campaignIds,
    pipelineIds: input.pipelineIds,
    stageIds: input.stageIds,
    ownerIds: input.ownerIds,
    taskAssigneeIds: input.taskAssigneeIds,
    taskPipelineIds: input.taskPipelineIds,
    assigneeIds: input.assigneeIds,
    contactTags: input.contactTags,
    conversationTags: input.conversationTags,
    ...webhookOAuthColumns(keyring, tenantId, id, input.oauth, NO_WEBHOOK_OAUTH),
    createdByUserId: 'userId' in input.creator ? input.creator.userId : null,
    createdByApiKeyId: 'apiKeyId' in input.creator ? input.creator.apiKeyId : null,
  });
  return { id, secret };
}

/**
 * A new secret for a locked endpoint, returned once. The previous one keeps signing (a second `v1`
 * signature) for 24 hours, so a receiver can switch without losing deliveries.
 */
export async function rotateWebhookEndpointSecret(
  tx: Tx,
  keyring: Keyring,
  tenantId: string,
  endpoint: LockedWebhookEndpoint,
  now: Date,
): Promise<{ secret: string; version: number }> {
  const secret = generateWebhookSecret();
  const version = endpoint.secretVersion + 1;
  await tx
    .update(webhookEndpoints)
    .set({
      secretCiphertext: keyring.encrypt(secret, webhookSecretAad(tenantId, endpoint.id, version)),
      secretVersion: version,
      previousSecretCiphertext: endpoint.secretCiphertext,
      previousSecretExpiresAt: new Date(
        now.getTime() + WEBHOOK_LIMITS.previousSecretHours * 3_600_000,
      ),
      updatedAt: now,
    })
    .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.id, endpoint.id)));
  return { secret, version };
}

/**
 * Turns a locked endpoint off (its pending deliveries fail) or on again (health starts afresh).
 * Nothing changes when it already is; the count of failed deliveries is returned.
 */
export async function setWebhookEndpointEnabled(
  tx: Tx,
  tenantId: string,
  endpoint: LockedWebhookEndpoint,
  enabled: boolean,
  now: Date,
): Promise<{ changed: boolean; failed: number }> {
  if ((endpoint.state === 'active') === enabled) return { changed: false, failed: 0 };
  await tx
    .update(webhookEndpoints)
    .set(
      enabled
        ? {
            state: 'active',
            disabledReason: null,
            disabledAt: null,
            failingSince: null,
            updatedAt: now,
          }
        : { state: 'disabled', disabledReason: 'manual', disabledAt: now, updatedAt: now },
    )
    .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.id, endpoint.id)));
  const failed = enabled ? 0 : await failPendingDeliveries(tx, tenantId, endpoint.id);
  return { changed: true, failed };
}

/**
 * Fails the endpoint's pending deliveries (it was turned off or is failing), with the endpoint
 * locked. An attempt already in progress finishes and is recorded; it is not retried.
 */
export async function failPendingDeliveries(
  tx: Tx,
  tenantId: string,
  endpointId: string,
): Promise<number> {
  const failed = await tx
    .update(webhookDeliveries)
    .set({ state: 'failed', lastError: 'endpoint_disabled' })
    .where(
      and(
        eq(webhookDeliveries.tenantId, tenantId),
        eq(webhookDeliveries.endpointId, endpointId),
        eq(webhookDeliveries.state, 'pending'),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return failed.length;
}

/** A delivery as Settings → Webhooks and the API list it (ADR-053, ADR-083). */
export const webhookDeliveryColumns = {
  id: webhookDeliveries.id,
  endpointId: webhookDeliveries.endpointId,
  eventId: webhookDeliveries.eventId,
  eventType: webhookEvents.type,
  state: webhookDeliveries.state,
  attempts: webhookDeliveries.attempts,
  nextAttemptAt: webhookDeliveries.nextAttemptAt,
  lastAttemptAt: webhookDeliveries.lastAttemptAt,
  lastStatusCode: webhookDeliveries.lastStatusCode,
  lastError: webhookDeliveries.lastError,
  lastDurationMs: webhookDeliveries.lastDurationMs,
  deliveredAt: webhookDeliveries.deliveredAt,
  replayOf: webhookDeliveries.replayOf,
  createdAt: webhookDeliveries.createdAt,
};

/** The join from a delivery to its event, which every delivery has. */
export const deliveryEventJoin = and(
  eq(webhookEvents.tenantId, webhookDeliveries.tenantId),
  eq(webhookEvents.id, webhookDeliveries.eventId),
);

/**
 * Queues a `ping` event for an endpoint the caller locked, which must be on (settings, and keys
 * for the endpoints keys added, ADR-083).
 */
export async function queueWebhookTest(
  tx: Tx,
  tenantId: string,
  endpoint: Pick<LockedWebhookEndpoint, 'id' | 'state'>,
): Promise<{ eventId: string; deliveryId: string }> {
  if (endpoint.state !== 'active') {
    throw new AppError('precondition_failed', 'Turn the endpoint on to send it a test event.');
  }
  const eventId = uuidv7();
  const deliveryId = uuidv7();
  await tx.insert(webhookEvents).values({ id: eventId, tenantId, type: 'ping', detail: {} });
  await tx
    .insert(webhookDeliveries)
    .values({ id: deliveryId, tenantId, endpointId: endpoint.id, eventId });
  return { eventId, deliveryId };
}

/**
 * Delivers a finished delivery's event again, as a new delivery to the same endpoint, which must
 * be on; the endpoint is locked first. With `keysOnly`, only deliveries to endpoints keys added
 * are found (ADR-083): any other is refused as unknown, like one that does not exist.
 */
export async function replayWebhookDelivery(
  tx: Tx,
  tenantId: string,
  deliveryId: string,
  options: { keysOnly?: boolean } = {},
): Promise<{ endpoint: LockedWebhookEndpoint; deliveryId: string }> {
  const [delivery] = await tx
    .select({
      endpointId: webhookDeliveries.endpointId,
      eventId: webhookDeliveries.eventId,
      state: webhookDeliveries.state,
    })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      and(
        eq(webhookEndpoints.tenantId, webhookDeliveries.tenantId),
        eq(webhookEndpoints.id, webhookDeliveries.endpointId),
      ),
    )
    .where(
      and(
        eq(webhookDeliveries.tenantId, tenantId),
        eq(webhookDeliveries.id, deliveryId),
        options.keysOnly ? isNotNull(webhookEndpoints.createdByApiKeyId) : undefined,
      ),
    );
  if (!delivery) throw notFound('Delivery');
  const endpoint = await lockWebhookEndpoint(tx, tenantId, delivery.endpointId);
  if (!(['succeeded', 'failed'] as WebhookDeliveryState[]).includes(delivery.state)) {
    throw new AppError('conflict', 'This delivery is still being attempted.');
  }
  if (endpoint.state !== 'active') {
    throw new AppError('precondition_failed', 'Turn the endpoint on to replay deliveries.');
  }
  const newId = uuidv7();
  await tx.insert(webhookDeliveries).values({
    id: newId,
    tenantId,
    endpointId: delivery.endpointId,
    eventId: delivery.eventId,
    replayOf: deliveryId,
  });
  return { endpoint, deliveryId: newId };
}

/** What a replay of an endpoint's failed deliveries queued (ADR-095). */
export interface WebhookFailedReplay {
  /** New deliveries queued, one per event. */
  queued: number;
  /** Whether more failed deliveries were left for another call. */
  more: boolean;
}

/**
 * Delivers again, as new deliveries to the same endpoint (which must be on), every event whose
 * deliveries to it all failed, from deliveries queued since `since`: one per event, replaying its
 * latest failed delivery, oldest event first, at most `WEBHOOK_LIMITS.replayBatch` (ADR-095). Left
 * out: events delivered since or with a delivery still waiting or being attempted (a replay already
 * queued included), deliveries that failed because what the event names no longer exists
 * (`event_gone`, which would fail again at once) and test events. The endpoint is locked first, so
 * calls at the same time queue each event once. With `keysOnly`, only endpoints keys added are found
 * (ADR-083); with `events`, only the failed deliveries of those events are replayed (ADR-156); with
 * `failures`, only events whose latest failed delivery failed in one of those ways (ADR-159).
 */
export async function replayFailedWebhookDeliveries(
  tx: Tx,
  tenantId: string,
  endpointId: string,
  since: Date,
  options: {
    keysOnly?: boolean;
    events?: readonly WebhookEventType[];
    failures?: readonly WebhookFailureKind[];
  } = {},
): Promise<WebhookFailedReplay & { endpoint: LockedWebhookEndpoint }> {
  const endpoint = await lockWebhookEndpoint(tx, tenantId, endpointId, 'no key update', options);
  if (endpoint.state !== 'active') {
    throw new AppError('precondition_failed', 'Turn the endpoint on to replay deliveries.');
  }
  const replayed = await replayLockedEndpoint(
    tx,
    tenantId,
    endpointId,
    since,
    options,
    WEBHOOK_LIMITS.replayBatch,
  );
  return { endpoint, ...replayed };
}

/** What a replay of every endpoint's failed deliveries queued (ADR-160). */
export interface WebhookFailedReplayAcross extends WebhookFailedReplay {
  /** Each endpoint that is on, in the order they were added, with what it queued. */
  endpoints: (WebhookFailedReplay & { id: string; url: string })[];
}

/**
 * Delivers again the failed deliveries of every endpoint that is on, each endpoint's chosen as its
 * own replay chooses them (`replayFailedWebhookDeliveries`), at most `WEBHOOK_LIMITS.replayBatch`
 * across them: endpoint by endpoint in the order they were added, each one's oldest event first
 * (ADR-160). `more` says whether any endpoint has more. Every endpoint is locked, in that order,
 * before any is read, so an endpoint's own replay at the same time queues each event once. Refused
 * when no endpoint is on; with `keysOnly`, only the endpoints keys added are replayed (ADR-083).
 */
export async function replayFailedAcrossEndpoints(
  tx: Tx,
  tenantId: string,
  since: Date,
  options: {
    keysOnly?: boolean;
    events?: readonly WebhookEventType[];
    failures?: readonly WebhookFailureKind[];
  } = {},
): Promise<WebhookFailedReplayAcross> {
  const endpoints = await tx
    .select({ id: webhookEndpoints.id, url: webhookEndpoints.url, state: webhookEndpoints.state })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.tenantId, tenantId),
        options.keysOnly ? isNotNull(webhookEndpoints.createdByApiKeyId) : undefined,
      ),
    )
    .orderBy(asc(webhookEndpoints.createdAt), asc(webhookEndpoints.id))
    .for('no key update');
  const on = endpoints.filter((e) => e.state === 'active');
  if (on.length === 0) {
    throw new AppError('precondition_failed', 'Turn an endpoint on to replay deliveries.');
  }
  let left: number = WEBHOOK_LIMITS.replayBatch;
  const replayed: WebhookFailedReplayAcross['endpoints'] = [];
  for (const endpoint of on) {
    // Once the batch is used up, a limit of 0 only finds whether this endpoint has more.
    const result = await replayLockedEndpoint(tx, tenantId, endpoint.id, since, options, left);
    left -= result.queued;
    replayed.push({ id: endpoint.id, url: endpoint.url, ...result });
  }
  return {
    queued: WEBHOOK_LIMITS.replayBatch - left,
    more: replayed.some((e) => e.more),
    endpoints: replayed,
  };
}

/**
 * The failed deliveries of an endpoint the caller locked, replayed as `replayFailedWebhookDeliveries`
 * describes, at most `limit` of them; with a limit of 0 nothing is queued and `more` says whether
 * any remain.
 */
async function replayLockedEndpoint(
  tx: Tx,
  tenantId: string,
  endpointId: string,
  since: Date,
  options: { events?: readonly WebhookEventType[]; failures?: readonly WebhookFailureKind[] },
  limit: number,
): Promise<WebhookFailedReplay> {
  // How the latest failed delivery's last attempt went (WEBHOOK_FAILURE_KINDS): a code says more
  // than a status an earlier attempt left. A failed delivery has one or the other; a 2xx succeeds.
  const failureKind = sql`case
    when f.last_error = any(${sql.param([...WEBHOOK_UNATTEMPTED_ERRORS])}::text[]) then 'not_attempted'
    when f.last_error is not null then 'no_answer'
    when f.last_status_code between 500 and 599 then 'server_error'
    when f.last_status_code between 400 and 499 then 'client_error'
    when f.last_status_code is not null then 'other_answer' end`;
  const failed = await tx.execute<{ id: string; event_id: string }>(sql`
    select f.id, f.event_id
      from (
        select distinct on (d.event_id) d.id, d.event_id, d.last_error, d.last_status_code
          from app.webhook_deliveries d
         where d.tenant_id = ${tenantId} and d.endpoint_id = ${endpointId}
           and d.state = 'failed' and d.created_at >= ${since.toISOString()}::timestamptz
         order by d.event_id, d.created_at desc, d.id desc
      ) f
      join app.webhook_events e on e.tenant_id = ${tenantId} and e.id = f.event_id
     where f.last_error is distinct from 'event_gone'
       and e.type <> 'ping'
       and ${options.events ? sql`e.type = any(${sql.param([...options.events])}::text[])` : sql`true`}
       and ${options.failures ? sql`${failureKind} = any(${sql.param([...options.failures])}::text[])` : sql`true`}
       and not exists (
         select 1 from app.webhook_deliveries o
          where o.tenant_id = ${tenantId} and o.event_id = f.event_id
            and o.endpoint_id = ${endpointId} and o.state <> 'failed')
     order by e.created_at, e.id
     limit ${limit + 1}`);
  const replayed = failed.rows.slice(0, limit);
  if (replayed.length > 0) {
    await tx.insert(webhookDeliveries).values(
      replayed.map((row) => ({
        id: uuidv7(),
        tenantId,
        endpointId,
        eventId: row.event_id,
        replayOf: row.id,
      })),
    );
  }
  return { queued: replayed.length, more: failed.rows.length > limit };
}

/**
 * Company webhook endpoints (ADR-053), managed by members with `developer.manage`. Secrets are
 * shown once and stored encrypted; audit entries name the endpoint's host, never its full URL or
 * secret.
 */
export function createWebhooksService(deps: {
  db: Database;
  clock: Clock;
  keyring: Keyring;
  egressPolicy: Pick<EgressPolicy, 'allowLoopbackForTests'>;
}) {
  const { db, clock, keyring } = deps;

  return {
    async list(ctx: TenantContext): Promise<WebhookEndpointView[]> {
      assertCan(ctx, 'developer.manage');
      const now = clock.now();
      const since = new Date(now.getTime() - 86_400_000);
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({
              id: webhookEndpoints.id,
              url: webhookEndpoints.url,
              description: webhookEndpoints.description,
              eventTypes: webhookEndpoints.eventTypes,
              state: webhookEndpoints.state,
              disabledReason: webhookEndpoints.disabledReason,
              disabledAt: webhookEndpoints.disabledAt,
              failingSince: webhookEndpoints.failingSince,
              lastSuccessAt: webhookEndpoints.lastSuccessAt,
              lastFailureAt: webhookEndpoints.lastFailureAt,
              secretVersion: webhookEndpoints.secretVersion,
              previousSecretExpiresAt: webhookEndpoints.previousSecretExpiresAt,
              headerNames: webhookEndpoints.headerNames,
              messageStatuses: webhookEndpoints.messageStatuses,
              messageSenders: webhookEndpoints.messageSenders,
              contactParts: webhookEndpoints.contactParts,
              contactFieldKeys: webhookEndpoints.contactFieldKeys,
              automationIds: webhookEndpoints.automationIds,
              campaignStatuses: webhookEndpoints.campaignStatuses,
              orderStatuses: webhookEndpoints.orderStatuses,
              templateStatuses: webhookEndpoints.templateStatuses,
              conversationStatuses: webhookEndpoints.conversationStatuses,
              runEndStatuses: webhookEndpoints.runEndStatuses,
              runTriggers: webhookEndpoints.runTriggers,
              consentChanges: webhookEndpoints.consentChanges,
              contactSources: webhookEndpoints.contactSources,
              messageTypes: webhookEndpoints.messageTypes,
              runEndReasons: webhookEndpoints.runEndReasons,
              channelAccountIds: webhookEndpoints.channelAccountIds,
              teamIds: webhookEndpoints.teamIds,
              templateIds: webhookEndpoints.templateIds,
              campaignIds: webhookEndpoints.campaignIds,
              pipelineIds: webhookEndpoints.pipelineIds,
              stageIds: webhookEndpoints.stageIds,
              ownerIds: webhookEndpoints.ownerIds,
              taskAssigneeIds: webhookEndpoints.taskAssigneeIds,
              taskPipelineIds: webhookEndpoints.taskPipelineIds,
              assigneeIds: webhookEndpoints.assigneeIds,
              contactTags: webhookEndpoints.contactTags,
              conversationTags: webhookEndpoints.conversationTags,
              oauthTokenUrl: webhookEndpoints.oauthTokenUrl,
              oauthClientId: webhookEndpoints.oauthClientId,
              oauthScope: webhookEndpoints.oauthScope,
              createdAt: webhookEndpoints.createdAt,
              createdBy: users.name,
              keyName: apiKeys.name,
              keyPrefix: apiKeys.keyPrefix,
            })
            .from(webhookEndpoints)
            .leftJoin(users, eq(users.id, webhookEndpoints.createdByUserId))
            .leftJoin(
              apiKeys,
              and(
                eq(apiKeys.tenantId, webhookEndpoints.tenantId),
                eq(apiKeys.id, webhookEndpoints.createdByApiKeyId),
              ),
            )
            .where(eq(webhookEndpoints.tenantId, ctx.tenant.id))
            .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id));
          const counts = await tx
            .select({
              endpointId: webhookDeliveries.endpointId,
              state: webhookDeliveries.state,
              n: sql<number>`count(*)::int`,
            })
            .from(webhookDeliveries)
            .where(
              and(
                eq(webhookDeliveries.tenantId, ctx.tenant.id),
                gt(webhookDeliveries.createdAt, since),
              ),
            )
            .groupBy(webhookDeliveries.endpointId, webhookDeliveries.state);
          // The names of the automations endpoints chose (ADR-145).
          const chosen = [...new Set(rows.flatMap((r) => r.automationIds ?? []))];
          const named =
            chosen.length === 0
              ? []
              : await tx
                  .select({
                    id: automations.id,
                    name: automations.name,
                    status: automations.status,
                  })
                  .from(automations)
                  .where(
                    and(eq(automations.tenantId, ctx.tenant.id), inArray(automations.id, chosen)),
                  );
          const byId = new Map(named.map((a) => [a.id, a]));
          // The numbers endpoints chose (ADR-170).
          const numbers = [...new Set(rows.flatMap((r) => r.channelAccountIds ?? []))];
          const numbered =
            numbers.length === 0
              ? []
              : await tx
                  .select(channelChoiceColumns)
                  .from(channelAccounts)
                  .where(
                    and(
                      eq(channelAccounts.tenantId, ctx.tenant.id),
                      inArray(channelAccounts.id, numbers),
                    ),
                  );
          const numberById = new Map(numbered.map((n) => [n.id, n]));
          // The teams endpoints chose (ADR-174); one deleted since is named by its absence.
          const teamIds = [...new Set(rows.flatMap((r) => r.teamIds ?? []))];
          const namedTeams =
            teamIds.length === 0
              ? []
              : await tx
                  .select({ id: teams.id, name: teams.name })
                  .from(teams)
                  .where(and(eq(teams.tenantId, ctx.tenant.id), inArray(teams.id, teamIds)));
          const teamNameById = new Map(namedTeams.map((t) => [t.id, t.name]));
          // The templates endpoints chose (ADR-175).
          const templateIds = [...new Set(rows.flatMap((r) => r.templateIds ?? []))];
          const namedTemplates =
            templateIds.length === 0
              ? []
              : await tx
                  .select(templateChoiceColumns)
                  .from(messageTemplates)
                  .where(
                    and(
                      eq(messageTemplates.tenantId, ctx.tenant.id),
                      inArray(messageTemplates.id, templateIds),
                    ),
                  );
          const templateById = new Map(namedTemplates.map((t) => [t.id, t]));
          // The campaigns endpoints chose (ADR-185).
          const campaignIds = [...new Set(rows.flatMap((r) => r.campaignIds ?? []))];
          const namedCampaigns =
            campaignIds.length === 0
              ? []
              : await tx
                  .select(campaignChoiceColumns)
                  .from(campaigns)
                  .where(
                    and(eq(campaigns.tenantId, ctx.tenant.id), inArray(campaigns.id, campaignIds)),
                  );
          const campaignById = new Map(namedCampaigns.map((c) => [c.id, c]));
          // The pipelines endpoints chose for deals (ADR-263) and tasks (ADR-303), and whether they
          // are archived.
          const pipelineIds = [
            ...new Set(
              rows.flatMap((r) => [...(r.pipelineIds ?? []), ...(r.taskPipelineIds ?? [])]),
            ),
          ];
          const namedPipelines =
            pipelineIds.length === 0
              ? []
              : await tx
                  .select({
                    id: crmPipelines.id,
                    name: crmPipelines.name,
                    archivedAt: crmPipelines.archivedAt,
                  })
                  .from(crmPipelines)
                  .where(
                    and(
                      eq(crmPipelines.tenantId, ctx.tenant.id),
                      inArray(crmPipelines.id, pipelineIds),
                    ),
                  );
          const pipelineById = new Map(namedPipelines.map((p) => [p.id, p]));
          const namedPipeline = (id: string): WebhookEndpointPipeline => {
            const pipeline = pipelineById.get(id);
            return {
              id,
              name: pipeline?.name ?? 'Unknown pipeline',
              archived: pipeline ? pipeline.archivedAt !== null : false,
            };
          };
          // The stages endpoints chose (ADR-264), with their pipelines.
          const stageIds = [...new Set(rows.flatMap((r) => r.stageIds ?? []))];
          const namedStages =
            stageIds.length === 0
              ? []
              : await tx
                  .select({
                    id: crmStages.id,
                    name: crmStages.name,
                    archivedAt: crmStages.archivedAt,
                    pipelineName: crmPipelines.name,
                    pipelineArchivedAt: crmPipelines.archivedAt,
                  })
                  .from(crmStages)
                  .innerJoin(
                    crmPipelines,
                    and(
                      eq(crmPipelines.tenantId, crmStages.tenantId),
                      eq(crmPipelines.id, crmStages.pipelineId),
                    ),
                  )
                  .where(
                    and(eq(crmStages.tenantId, ctx.tenant.id), inArray(crmStages.id, stageIds)),
                  );
          const stageById = new Map(namedStages.map((st) => [st.id, st]));
          // The deal owners (ADR-265) and task assignees (ADR-266) endpoints chose, and whether
          // they can own deals and be assigned tasks now.
          const crmMemberById = await memberRefs(
            tx,
            ctx.tenant.id,
            rows.flatMap((r) => [...(r.ownerIds ?? []), ...(r.taskAssigneeIds ?? [])]),
          );
          const crmMember = (id: string): WebhookEndpointOwner => {
            const member = crmMemberById.get(id);
            return { id, name: member?.name ?? null, active: member?.active ?? false };
          };
          // The members endpoints chose (ADR-181), and whether they still take conversations.
          const assigneeIds = [...new Set(rows.flatMap((r) => r.assigneeIds ?? []))];
          const namedAssignees =
            assigneeIds.length === 0
              ? []
              : await tx
                  .select({
                    id: memberships.id,
                    name: users.name,
                    assignable: takesConversations(),
                  })
                  .from(memberships)
                  .innerJoin(users, eq(users.id, memberships.userId))
                  .where(
                    and(
                      eq(memberships.tenantId, ctx.tenant.id),
                      inArray(memberships.id, assigneeIds),
                    ),
                  );
          const assigneeById = new Map(namedAssignees.map((m) => [m.id, m]));
          // The custom fields endpoints chose (ADR-184); one deleted since is named by its absence.
          const fieldKeys = [...new Set(rows.flatMap((r) => r.contactFieldKeys ?? []))];
          const namedFields =
            fieldKeys.length === 0
              ? []
              : await tx
                  .select({ key: contactFields.key, label: contactFields.label })
                  .from(contactFields)
                  .where(
                    and(
                      eq(contactFields.tenantId, ctx.tenant.id),
                      inArray(contactFields.key, fieldKeys),
                    ),
                  );
          const fieldLabelByKey = new Map(namedFields.map((f) => [f.key, f.label]));
          return rows.map((r) => {
            const recent: Record<WebhookDeliveryState, number> = {
              pending: 0,
              delivering: 0,
              succeeded: 0,
              failed: 0,
            };
            for (const c of counts) if (c.endpointId === r.id) recent[c.state] = c.n;
            const previousSigns = r.previousSecretExpiresAt && r.previousSecretExpiresAt > now;
            const {
              keyName,
              keyPrefix,
              automationIds,
              channelAccountIds,
              teamIds: chosenTeams,
              templateIds: chosenTemplates,
              campaignIds: chosenCampaigns,
              pipelineIds: chosenPipelines,
              stageIds: chosenStages,
              ownerIds: chosenOwners,
              taskAssigneeIds: chosenTaskAssignees,
              taskPipelineIds: chosenTaskPipelines,
              assigneeIds: chosenAssignees,
              contactFieldKeys: chosenFields,
              oauthTokenUrl,
              oauthClientId,
              oauthScope,
              ...endpoint
            } = r;
            return {
              ...endpoint,
              oauth:
                oauthTokenUrl && oauthClientId
                  ? { tokenUrl: oauthTokenUrl, clientId: oauthClientId, scope: oauthScope }
                  : null,
              channels: channelAccountIds
                ? channelAccountIds.map((id): WebhookEndpointChannel => {
                    const number = numberById.get(id);
                    return number
                      ? { id, label: webhookChannelLabel(number), status: number.status }
                      : { id, label: 'Unknown number', status: null };
                  })
                : null,
              teams: chosenTeams
                ? chosenTeams.map((id) => ({ id, name: teamNameById.get(id) ?? null }))
                : null,
              templates: chosenTemplates
                ? chosenTemplates.map(
                    (id) => templateById.get(id) ?? { id, name: 'Unknown template', language: '-' },
                  )
                : null,
              campaigns: chosenCampaigns
                ? chosenCampaigns.map(
                    (id): WebhookEndpointCampaign =>
                      campaignById.get(id) ?? { id, name: 'Unknown campaign', status: null },
                  )
                : null,
              pipelines: chosenPipelines ? chosenPipelines.map(namedPipeline) : null,
              stages: chosenStages
                ? chosenStages.map((id): WebhookEndpointStage => {
                    const stage = stageById.get(id);
                    return stage
                      ? {
                          id,
                          name: stage.name,
                          pipelineName: stage.pipelineName,
                          removed: stage.archivedAt !== null,
                          pipelineArchived: stage.pipelineArchivedAt !== null,
                        }
                      : {
                          id,
                          name: 'Unknown stage',
                          pipelineName: 'Unknown pipeline',
                          removed: false,
                          pipelineArchived: false,
                        };
                  })
                : null,
              owners: chosenOwners ? chosenOwners.map(crmMember) : null,
              taskAssignees: chosenTaskAssignees ? chosenTaskAssignees.map(crmMember) : null,
              taskPipelines: chosenTaskPipelines ? chosenTaskPipelines.map(namedPipeline) : null,
              contactFields: chosenFields
                ? chosenFields.map((key): WebhookEndpointField => ({
                    key,
                    label: fieldLabelByKey.get(key) ?? null,
                  }))
                : null,
              assignees: chosenAssignees
                ? chosenAssignees.map(
                    (id): WebhookEndpointAssignee =>
                      assigneeById.get(id) ?? { id, name: null, assignable: false },
                  )
                : null,
              automations: automationIds
                ? automationIds.map((id) => {
                    const automation = byId.get(id);
                    return {
                      id,
                      name: automation?.name ?? 'Unknown automation',
                      archived: automation?.status === 'archived',
                    };
                  })
                : null,
              createdByKey: keyName && keyPrefix ? { name: keyName, keyPrefix } : null,
              previousSecretExpiresAt: previousSigns ? r.previousSecretExpiresAt : null,
              recent,
            };
          });
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * The automations an endpoint can choose to take the runs of (ADR-145): the company's
     * automations with a published version, by name. Archived ones are listed too, so a list that
     * holds one is shown and kept.
     */
    async automationChoices(ctx: TenantContext): Promise<WebhookAutomationChoice[]> {
      assertCan(ctx, 'developer.manage');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ id: automations.id, name: automations.name, status: automations.status })
            .from(automations)
            .where(
              and(
                eq(automations.tenantId, ctx.tenant.id),
                inArray(
                  automations.id,
                  tx
                    .select({ id: automationVersions.automationId })
                    .from(automationVersions)
                    .where(
                      and(
                        eq(automationVersions.tenantId, ctx.tenant.id),
                        eq(automationVersions.kind, 'published'),
                      ),
                    ),
                ),
              ),
            )
            .orderBy(asc(automations.name), asc(automations.id)),
        { accessMode: 'read only' },
      );
    },

    /**
     * The numbers an endpoint can choose to take the events of (ADR-170): every WhatsApp number of
     * the company, in the order they were connected, whatever their status. Numbers are never
     * deleted, so a list always shows the numbers it holds.
     */
    async channelChoices(ctx: TenantContext): Promise<WebhookChannelChoice[]> {
      assertCan(ctx, 'developer.manage');
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select(channelChoiceColumns)
            .from(channelAccounts)
            .where(eq(channelAccounts.tenantId, ctx.tenant.id))
            .orderBy(asc(channelAccounts.createdAt), asc(channelAccounts.id)),
        { accessMode: 'read only' },
      );
      return rows.map((r) => ({ id: r.id, label: webhookChannelLabel(r), status: r.status }));
    },

    /**
     * The templates an endpoint can choose to take the statuses and changes of (ADR-175): every
     * template of the company, whatever its status, by name and language.
     */
    async templateChoices(ctx: TenantContext): Promise<WebhookTemplateChoice[]> {
      assertCan(ctx, 'developer.manage');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select(templateChoiceColumns)
            .from(messageTemplates)
            .where(eq(messageTemplates.tenantId, ctx.tenant.id))
            .orderBy(
              asc(messageTemplates.name),
              asc(messageTemplates.language),
              asc(messageTemplates.id),
            ),
        { accessMode: 'read only' },
      );
    },

    /**
     * The campaigns an endpoint can choose to take the statuses and changes of (ADR-185): the
     * company's newest campaigns, whatever their status, at most `WEBHOOK_LIMITS.campaignChoices`;
     * `more` says whether older ones exist (the API takes any of the company's).
     */
    async campaignChoices(
      ctx: TenantContext,
    ): Promise<{ campaigns: WebhookCampaignChoice[]; more: boolean }> {
      assertCan(ctx, 'developer.manage');
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select(campaignChoiceColumns)
            .from(campaigns)
            .where(eq(campaigns.tenantId, ctx.tenant.id))
            .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
            .limit(WEBHOOK_LIMITS.campaignChoices + 1),
        { accessMode: 'read only' },
      );
      return {
        campaigns: rows.slice(0, WEBHOOK_LIMITS.campaignChoices),
        more: rows.length > WEBHOOK_LIMITS.campaignChoices,
      };
    },

    /**
     * The CRM pipelines an endpoint can choose to take the deals' events of (ADR-263): those the
     * company uses (at most `CRM_LIMITS.pipelines`), in board order. An archived one has no open
     * deal and takes none until restored, so it is not offered; the API takes it, and Settings keeps
     * showing one an endpoint names.
     */
    async pipelineChoices(ctx: TenantContext): Promise<WebhookPipelineChoice[]> {
      assertCan(ctx, 'developer.manage');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ id: crmPipelines.id, name: crmPipelines.name })
            .from(crmPipelines)
            .where(and(eq(crmPipelines.tenantId, ctx.tenant.id), isNull(crmPipelines.archivedAt)))
            .orderBy(
              asc(crmPipelines.position),
              asc(sql`lower(${crmPipelines.name})`),
              asc(crmPipelines.id),
            ),
        { accessMode: 'read only' },
      );
    },

    /**
     * The CRM stages an endpoint can choose to take the deals' events of (ADR-264): the stages in
     * use of the pipelines the company uses, in board order. A removed stage holds no deal and a
     * stage of an archived pipeline none open, so they are not offered; the API takes them, and
     * Settings keeps showing one an endpoint names.
     */
    async stageChoices(ctx: TenantContext): Promise<WebhookStageChoice[]> {
      assertCan(ctx, 'developer.manage');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: crmStages.id,
              name: crmStages.name,
              pipelineId: crmPipelines.id,
              pipelineName: crmPipelines.name,
            })
            .from(crmStages)
            .innerJoin(
              crmPipelines,
              and(
                eq(crmPipelines.tenantId, crmStages.tenantId),
                eq(crmPipelines.id, crmStages.pipelineId),
              ),
            )
            .where(
              and(
                eq(crmStages.tenantId, ctx.tenant.id),
                isNull(crmStages.archivedAt),
                isNull(crmPipelines.archivedAt),
              ),
            )
            .orderBy(
              asc(crmPipelines.position),
              asc(sql`lower(${crmPipelines.name})`),
              asc(crmPipelines.id),
              asc(crmStages.position),
              asc(crmStages.createdAt),
            ),
        { accessMode: 'read only' },
      );
    },

    /**
     * The members an endpoint can choose to take the events of the deals they own (ADR-265) or of the
     * tasks assigned to them (ADR-266): those who can own deals and be assigned tasks (active, with
     * access to the CRM), by name.
     */
    async ownerChoices(ctx: TenantContext): Promise<WebhookOwnerChoice[]> {
      assertCan(ctx, 'developer.manage');
      const members = await db.run(ctx.scope, (tx) => crmMembers(tx, ctx.tenant.id), {
        accessMode: 'read only',
      });
      return members.map((m) => ({ id: m.membershipId, name: m.name }));
    },

    /**
     * The teams an endpoint can choose to take the conversations' events of (ADR-174): every team
     * of the company, by name.
     */
    async teamChoices(ctx: TenantContext): Promise<WebhookTeamChoice[]> {
      assertCan(ctx, 'developer.manage');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ id: teams.id, name: teams.name })
            .from(teams)
            .where(eq(teams.tenantId, ctx.tenant.id))
            .orderBy(asc(teams.name), asc(teams.id)),
        { accessMode: 'read only' },
      );
    },

    /**
     * The members an endpoint can choose to take the assigned conversations' events of (ADR-181):
     * those conversations can be assigned to (active, with a role that reads and answers them), by
     * name.
     */
    async assigneeChoices(ctx: TenantContext): Promise<WebhookAssigneeChoice[]> {
      assertCan(ctx, 'developer.manage');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ id: memberships.id, name: users.name })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(and(eq(memberships.tenantId, ctx.tenant.id), takesConversations()))
            .orderBy(asc(users.name), asc(memberships.id)),
        { accessMode: 'read only' },
      );
    },

    /**
     * The custom fields an endpoint can choose to take the changes of (ADR-184): every field of the
     * company, by label.
     */
    async contactFieldChoices(ctx: TenantContext): Promise<WebhookFieldChoice[]> {
      assertCan(ctx, 'developer.manage');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ key: contactFields.key, label: contactFields.label })
            .from(contactFields)
            .where(eq(contactFields.tenantId, ctx.tenant.id))
            .orderBy(asc(contactFields.label), asc(contactFields.key)),
        { accessMode: 'read only' },
      );
    },

    /** A new endpoint; its secret is returned once. */
    async create(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      assertRecentSignIn(ctx, clock.now());
      const data = parseInput(endpointSchema, input);
      const { url, host } = checkedWebhookUrl(data.url, deps.egressPolicy);
      return db.run(ctx.scope, async (tx) => {
        const headers = data.headers ?? [];
        const messageStatuses = webhookMessageStatusesFor(
          data.eventTypes,
          data.messageStatuses,
          null,
        );
        const messageSenders = webhookMessageSendersFor(data.eventTypes, data.messageSenders, null);
        const contactParts = webhookContactPartsFor(data.eventTypes, data.contactParts, null);
        // Fields narrow field changes only: refused for parts that take none (ADR-184).
        if (data.contactFieldKeys && !webhookTakesFieldChanges(data.eventTypes, contactParts)) {
          throw webhookFieldsNeedThePart();
        }
        const contactFieldKeys = webhookContactFieldKeysFor(
          data.eventTypes,
          contactParts,
          data.contactFieldKeys,
          null,
        );
        await assertWebhookContactFields(tx, ctx.tenant.id, contactFieldKeys);
        const automationIds = webhookAutomationIdsFor(data.eventTypes, data.automationIds, null);
        await assertWebhookAutomations(tx, ctx.tenant.id, automationIds);
        const campaignStatuses = webhookCampaignStatusesFor(
          data.eventTypes,
          data.campaignStatuses,
          null,
        );
        const orderStatuses = webhookOrderStatusesFor(data.eventTypes, data.orderStatuses, null);
        const templateStatuses = webhookTemplateStatusesFor(
          data.eventTypes,
          data.templateStatuses,
          null,
        );
        const conversationStatuses = webhookConversationStatusesFor(
          data.eventTypes,
          data.conversationStatuses,
          null,
        );
        const runEndStatuses = webhookRunEndStatusesFor(data.eventTypes, data.runEndStatuses, null);
        const runTriggers = webhookRunTriggersFor(data.eventTypes, data.runTriggers, null);
        const consentChanges = webhookConsentChangesFor(data.eventTypes, data.consentChanges, null);
        const contactSources = webhookContactSourcesFor(data.eventTypes, data.contactSources, null);
        const messageTypes = webhookMessageTypesFor(data.eventTypes, data.messageTypes, null);
        // Reasons narrow the ends taken: refused for an end it does not take (ADR-192).
        if (
          data.runEndReasons?.some((reason) => !webhookRunEndTakesReason(runEndStatuses, reason))
        ) {
          throw webhookRunEndReasonsNeedTheEnds();
        }
        const runEndReasons = webhookRunEndReasonsFor(
          data.eventTypes,
          runEndStatuses,
          data.runEndReasons,
          null,
        );
        const channelIds = webhookChannelIdsFor(data.eventTypes, data.channelIds, null);
        await assertWebhookChannels(tx, ctx.tenant.id, channelIds);
        const teamIds = webhookTeamIdsFor(data.eventTypes, data.teamIds, null);
        await assertWebhookTeams(tx, ctx.tenant.id, teamIds);
        const templateIds = webhookTemplateIdsFor(data.eventTypes, data.templateIds, null);
        await assertWebhookTemplates(tx, ctx.tenant.id, templateIds);
        const campaignIds = webhookCampaignIdsFor(data.eventTypes, data.campaignIds, null);
        await assertWebhookCampaigns(tx, ctx.tenant.id, campaignIds);
        const pipelineIds = webhookPipelineIdsFor(data.eventTypes, data.pipelineIds, null);
        await assertWebhookPipelines(tx, ctx.tenant.id, pipelineIds);
        const stageIds = webhookStageIdsFor(data.eventTypes, data.stageIds, null);
        await assertWebhookStages(tx, ctx.tenant.id, stageIds);
        const ownerIds = webhookOwnerIdsFor(data.eventTypes, data.ownerIds, null);
        await assertWebhookOwners(tx, ctx.tenant.id, ownerIds);
        const taskAssigneeIds = webhookTaskAssigneeIdsFor(
          data.eventTypes,
          data.taskAssigneeIds,
          null,
        );
        await assertWebhookTaskAssignees(tx, ctx.tenant.id, taskAssigneeIds);
        const taskPipelineIds = webhookTaskPipelineIdsFor(
          data.eventTypes,
          data.taskPipelineIds,
          null,
        );
        await assertWebhookTaskPipelines(tx, ctx.tenant.id, taskPipelineIds);
        const assigneeIds = webhookAssigneeIdsFor(data.eventTypes, data.assigneeIds, null);
        await assertWebhookAssignees(tx, ctx.tenant.id, assigneeIds);
        const contactTags = webhookContactTagsFor(data.eventTypes, data.contactTags, null);
        const conversationTags = webhookConversationTagsFor(
          data.eventTypes,
          data.conversationTags,
          null,
        );
        const oauth = data.oauth
          ? checkedWebhookOAuth(data.oauth, NO_WEBHOOK_OAUTH, deps.egressPolicy)
          : null;
        assertWebhookAuthorization(
          headers.map((h) => h.name),
          oauth !== null,
          data.headers,
        );
        const { id, secret } = await insertWebhookEndpoint(tx, keyring, ctx.tenant.id, {
          url,
          description: data.description || null,
          eventTypes: data.eventTypes,
          headers,
          messageStatuses,
          messageSenders,
          contactParts,
          contactFieldKeys,
          automationIds,
          campaignStatuses,
          orderStatuses,
          templateStatuses,
          conversationStatuses,
          runEndStatuses,
          runTriggers,
          consentChanges,
          contactSources,
          messageTypes,
          runEndReasons,
          channelAccountIds: channelIds,
          teamIds,
          templateIds,
          campaignIds,
          pipelineIds,
          stageIds,
          ownerIds,
          taskAssigneeIds,
          taskPipelineIds,
          assigneeIds,
          contactTags,
          conversationTags,
          oauth,
          creator: { userId: ctx.user.id },
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'webhook.endpoint_created',
            subjectType: 'webhook_endpoint',
            subjectId: id,
            metadata: {
              host,
              eventTypes: data.eventTypes,
              ...(headers.length > 0 ? { headers: headers.map((h) => h.name) } : {}),
              ...(messageStatuses ? { messageStatuses } : {}),
              ...(messageSenders ? { messageSenders } : {}),
              ...(contactParts ? { contactParts } : {}),
              ...(contactFieldKeys ? { contactFieldKeys } : {}),
              ...(automationIds ? { automationIds } : {}),
              ...(campaignStatuses ? { campaignStatuses } : {}),
              ...(orderStatuses ? { orderStatuses } : {}),
              ...(templateStatuses ? { templateStatuses } : {}),
              ...(conversationStatuses ? { conversationStatuses } : {}),
              ...(runEndStatuses ? { runEndStatuses } : {}),
              ...(runTriggers ? { runTriggers } : {}),
              ...(consentChanges ? { consentChanges } : {}),
              ...(contactSources ? { contactSources } : {}),
              ...(messageTypes ? { messageTypes } : {}),
              ...(runEndReasons ? { runEndReasons } : {}),
              ...(channelIds ? { channelIds } : {}),
              ...(teamIds ? { teamIds } : {}),
              ...(templateIds ? { templateIds } : {}),
              ...(campaignIds ? { campaignIds } : {}),
              ...(pipelineIds ? { pipelineIds } : {}),
              ...(stageIds ? { stageIds } : {}),
              ...(ownerIds ? { ownerIds } : {}),
              ...(taskAssigneeIds ? { taskAssigneeIds } : {}),
              ...(taskPipelineIds ? { taskPipelineIds } : {}),
              ...(assigneeIds ? { assigneeIds } : {}),
              ...(contactTags ? { contactTags } : {}),
              ...(conversationTags ? { conversationTags } : {}),
              ...(oauth ? { oauthTokenHost: oauth.host } : {}),
            },
          },
          meta,
        );
        return { id, secret };
      });
    },

    async update(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      assertRecentSignIn(ctx, clock.now());
      const data = parseInput(updateSchema, input);
      const { url, host } = checkedWebhookUrl(data.url, deps.egressPolicy);
      await db.run(ctx.scope, async (tx) => {
        const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, data.endpointId);
        const messageStatuses = webhookMessageStatusesFor(
          data.eventTypes,
          data.messageStatuses,
          endpoint.messageStatuses,
        );
        const messageSenders = webhookMessageSendersFor(
          data.eventTypes,
          data.messageSenders,
          endpoint.messageSenders,
        );
        const contactParts = webhookContactPartsFor(
          data.eventTypes,
          data.contactParts,
          endpoint.contactParts,
        );
        // Fields narrow field changes only: refused for parts that take none (ADR-184).
        if (data.contactFieldKeys && !webhookTakesFieldChanges(data.eventTypes, contactParts)) {
          throw webhookFieldsNeedThePart();
        }
        const contactFieldKeys = webhookContactFieldKeysFor(
          data.eventTypes,
          contactParts,
          data.contactFieldKeys,
          endpoint.contactFieldKeys,
        );
        // And the fields it adds: those it held may have been deleted since (ADR-184).
        if (data.contactFieldKeys !== undefined) {
          await assertWebhookContactFields(
            tx,
            ctx.tenant.id,
            contactFieldKeys,
            endpoint.contactFieldKeys,
          );
        }
        const automationIds = webhookAutomationIdsFor(
          data.eventTypes,
          data.automationIds,
          endpoint.automationIds,
        );
        // Only a list given now is checked: the automations kept were checked when chosen.
        if (data.automationIds !== undefined) {
          await assertWebhookAutomations(tx, ctx.tenant.id, automationIds);
        }
        const campaignStatuses = webhookCampaignStatusesFor(
          data.eventTypes,
          data.campaignStatuses,
          endpoint.campaignStatuses,
        );
        const orderStatuses = webhookOrderStatusesFor(
          data.eventTypes,
          data.orderStatuses,
          endpoint.orderStatuses,
        );
        const templateStatuses = webhookTemplateStatusesFor(
          data.eventTypes,
          data.templateStatuses,
          endpoint.templateStatuses,
        );
        const conversationStatuses = webhookConversationStatusesFor(
          data.eventTypes,
          data.conversationStatuses,
          endpoint.conversationStatuses,
        );
        const runEndStatuses = webhookRunEndStatusesFor(
          data.eventTypes,
          data.runEndStatuses,
          endpoint.runEndStatuses,
        );
        const runTriggers = webhookRunTriggersFor(
          data.eventTypes,
          data.runTriggers,
          endpoint.runTriggers,
        );
        const consentChanges = webhookConsentChangesFor(
          data.eventTypes,
          data.consentChanges,
          endpoint.consentChanges,
        );
        const contactSources = webhookContactSourcesFor(
          data.eventTypes,
          data.contactSources,
          endpoint.contactSources,
        );
        const messageTypes = webhookMessageTypesFor(
          data.eventTypes,
          data.messageTypes,
          endpoint.messageTypes,
        );
        // Reasons narrow the ends it keeps: refused for an end it does not take (ADR-192).
        if (
          data.runEndReasons?.some((reason) => !webhookRunEndTakesReason(runEndStatuses, reason))
        ) {
          throw webhookRunEndReasonsNeedTheEnds();
        }
        const runEndReasons = webhookRunEndReasonsFor(
          data.eventTypes,
          runEndStatuses,
          data.runEndReasons,
          endpoint.runEndReasons,
        );
        const channelIds = webhookChannelIdsFor(
          data.eventTypes,
          data.channelIds,
          endpoint.channelAccountIds,
        );
        // Only a list given now is checked: the numbers kept were checked when chosen.
        if (data.channelIds !== undefined) {
          await assertWebhookChannels(tx, ctx.tenant.id, channelIds);
        }
        const teamIds = webhookTeamIdsFor(data.eventTypes, data.teamIds, endpoint.teamIds);
        // And the teams it adds: those it held may have been deleted since (ADR-174).
        if (data.teamIds !== undefined) {
          await assertWebhookTeams(tx, ctx.tenant.id, teamIds, endpoint.teamIds);
        }
        const templateIds = webhookTemplateIdsFor(
          data.eventTypes,
          data.templateIds,
          endpoint.templateIds,
        );
        // Only a list given now is checked: the templates kept were checked when chosen.
        if (data.templateIds !== undefined) {
          await assertWebhookTemplates(tx, ctx.tenant.id, templateIds);
        }
        const campaignIds = webhookCampaignIdsFor(
          data.eventTypes,
          data.campaignIds,
          endpoint.campaignIds,
        );
        // Likewise the campaigns: those kept were checked when chosen (ADR-185).
        if (data.campaignIds !== undefined) {
          await assertWebhookCampaigns(tx, ctx.tenant.id, campaignIds);
        }
        const pipelineIds = webhookPipelineIdsFor(
          data.eventTypes,
          data.pipelineIds,
          endpoint.pipelineIds,
        );
        // And the pipelines (ADR-263).
        if (data.pipelineIds !== undefined) {
          await assertWebhookPipelines(tx, ctx.tenant.id, pipelineIds);
        }
        const stageIds = webhookStageIdsFor(data.eventTypes, data.stageIds, endpoint.stageIds);
        // And the stages (ADR-264).
        if (data.stageIds !== undefined) {
          await assertWebhookStages(tx, ctx.tenant.id, stageIds);
        }
        const ownerIds = webhookOwnerIdsFor(data.eventTypes, data.ownerIds, endpoint.ownerIds);
        // And the owners it adds: those it held may have left since (ADR-265).
        if (data.ownerIds !== undefined) {
          await assertWebhookOwners(tx, ctx.tenant.id, ownerIds, endpoint.ownerIds);
        }
        const taskAssigneeIds = webhookTaskAssigneeIdsFor(
          data.eventTypes,
          data.taskAssigneeIds,
          endpoint.taskAssigneeIds,
        );
        // And the assignees it adds: those it held may have left since (ADR-266).
        if (data.taskAssigneeIds !== undefined) {
          await assertWebhookTaskAssignees(
            tx,
            ctx.tenant.id,
            taskAssigneeIds,
            endpoint.taskAssigneeIds,
          );
        }
        const taskPipelineIds = webhookTaskPipelineIdsFor(
          data.eventTypes,
          data.taskPipelineIds,
          endpoint.taskPipelineIds,
        );
        // And the pipelines of tasks' deals (ADR-303).
        if (data.taskPipelineIds !== undefined) {
          await assertWebhookTaskPipelines(tx, ctx.tenant.id, taskPipelineIds);
        }
        const assigneeIds = webhookAssigneeIdsFor(
          data.eventTypes,
          data.assigneeIds,
          endpoint.assigneeIds,
        );
        // And the members it adds: those it held may no longer take conversations (ADR-181).
        if (data.assigneeIds !== undefined) {
          await assertWebhookAssignees(tx, ctx.tenant.id, assigneeIds, endpoint.assigneeIds);
        }
        // Tags are labels: any tag may be named, one no contact has yet included (ADR-267).
        const contactTags = webhookContactTagsFor(
          data.eventTypes,
          data.contactTags,
          endpoint.contactTags,
        );
        const conversationTags = webhookConversationTagsFor(
          data.eventTypes,
          data.conversationTags,
          endpoint.conversationTags,
        );
        // Left out, the OAuth client stays as it is (ADR-173).
        const oauth = data.oauth
          ? checkedWebhookOAuth(data.oauth, endpoint, deps.egressPolicy)
          : data.oauth;
        assertWebhookAuthorization(
          data.headers ? data.headers.map((h) => h.name) : endpoint.headerNames,
          oauth === undefined ? endpoint.oauthTokenUrl !== null : oauth !== null,
          data.headers,
        );
        await tx
          .update(webhookEndpoints)
          .set({
            url,
            description: data.description || null,
            eventTypes: data.eventTypes,
            messageStatuses,
            messageSenders,
            contactParts,
            contactFieldKeys,
            automationIds,
            campaignStatuses,
            orderStatuses,
            templateStatuses,
            conversationStatuses,
            runEndStatuses,
            runTriggers,
            consentChanges,
            contactSources,
            messageTypes,
            runEndReasons,
            channelAccountIds: channelIds,
            teamIds,
            templateIds,
            campaignIds,
            pipelineIds,
            stageIds,
            ownerIds,
            taskAssigneeIds,
            taskPipelineIds,
            assigneeIds,
            contactTags,
            conversationTags,
            ...(data.headers
              ? sealWebhookHeaders(keyring, ctx.tenant.id, data.endpointId, data.headers)
              : {}),
            ...(oauth !== undefined
              ? webhookOAuthColumns(keyring, ctx.tenant.id, data.endpointId, oauth, endpoint)
              : {}),
            updatedAt: clock.now(),
          })
          .where(
            and(
              eq(webhookEndpoints.tenantId, ctx.tenant.id),
              eq(webhookEndpoints.id, data.endpointId),
            ),
          );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'webhook.endpoint_updated',
            subjectType: 'webhook_endpoint',
            subjectId: data.endpointId,
            metadata: {
              host,
              eventTypes: data.eventTypes,
              ...(data.headers ? { headers: data.headers.map((h) => h.name) } : {}),
              ...(messageStatuses ? { messageStatuses } : {}),
              ...(messageSenders ? { messageSenders } : {}),
              ...(contactParts ? { contactParts } : {}),
              ...(contactFieldKeys ? { contactFieldKeys } : {}),
              ...(automationIds ? { automationIds } : {}),
              ...(campaignStatuses ? { campaignStatuses } : {}),
              ...(orderStatuses ? { orderStatuses } : {}),
              ...(templateStatuses ? { templateStatuses } : {}),
              ...(conversationStatuses ? { conversationStatuses } : {}),
              ...(runEndStatuses ? { runEndStatuses } : {}),
              ...(runTriggers ? { runTriggers } : {}),
              ...(consentChanges ? { consentChanges } : {}),
              ...(contactSources ? { contactSources } : {}),
              ...(messageTypes ? { messageTypes } : {}),
              ...(runEndReasons ? { runEndReasons } : {}),
              ...(channelIds ? { channelIds } : {}),
              ...(teamIds ? { teamIds } : {}),
              ...(templateIds ? { templateIds } : {}),
              ...(campaignIds ? { campaignIds } : {}),
              ...(pipelineIds ? { pipelineIds } : {}),
              ...(stageIds ? { stageIds } : {}),
              ...(ownerIds ? { ownerIds } : {}),
              ...(taskAssigneeIds ? { taskAssigneeIds } : {}),
              ...(taskPipelineIds ? { taskPipelineIds } : {}),
              ...(assigneeIds ? { assigneeIds } : {}),
              ...(contactTags ? { contactTags } : {}),
              ...(conversationTags ? { conversationTags } : {}),
              ...webhookOAuthAudit(oauth, endpoint),
            },
          },
          meta,
        );
      });
    },

    /** Turns an endpoint off (its pending deliveries fail) or on again (health starts afresh). */
    async setEnabled(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const data = parseInput(enabledSchema, input);
      const now = clock.now();
      await db.run(ctx.scope, async (tx) => {
        const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, data.endpointId);
        const { changed, failed } = await setWebhookEndpointEnabled(
          tx,
          ctx.tenant.id,
          endpoint,
          data.enabled,
          now,
        );
        if (!changed) return;
        await recordAudit(
          tx,
          ctx,
          {
            action: data.enabled ? 'webhook.endpoint_enabled' : 'webhook.endpoint_disabled',
            subjectType: 'webhook_endpoint',
            subjectId: endpoint.id,
            metadata: { host: webhookHost(endpoint.url), pendingDeliveriesFailed: failed },
          },
          meta,
        );
      });
    },

    /** A new secret, returned once; see `rotateWebhookEndpointSecret`. */
    async rotateSecret(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const now = clock.now();
      assertRecentSignIn(ctx, now);
      const { endpointId } = parseInput(endpointIdSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, endpointId);
        const { secret, version } = await rotateWebhookEndpointSecret(
          tx,
          keyring,
          ctx.tenant.id,
          endpoint,
          now,
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'webhook.secret_rotated',
            subjectType: 'webhook_endpoint',
            subjectId: endpointId,
            metadata: { host: webhookHost(endpoint.url), secretVersion: version },
          },
          meta,
        );
        return { secret };
      });
    },

    /** Deletes an endpoint and its delivery history. */
    async remove(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const { endpointId } = parseInput(endpointIdSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, endpointId, 'update');
        await tx
          .delete(webhookEndpoints)
          .where(
            and(eq(webhookEndpoints.tenantId, ctx.tenant.id), eq(webhookEndpoints.id, endpointId)),
          );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'webhook.endpoint_deleted',
            subjectType: 'webhook_endpoint',
            subjectId: endpointId,
            metadata: { host: webhookHost(endpoint.url) },
          },
          meta,
        );
      });
    },

    /** Queues a `ping` event for one active endpoint. */
    async sendTest(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'developer.manage');
      const { endpointId } = parseInput(endpointIdSchema, input);
      const { deliveryId } = await db.run(ctx.scope, async (tx) =>
        queueWebhookTest(
          tx,
          ctx.tenant.id,
          await lockWebhookEndpoint(tx, ctx.tenant.id, endpointId),
        ),
      );
      return { deliveryId };
    },

    /** The endpoint's latest 100 deliveries, newest first (only failed ones when asked). */
    async deliveries(
      ctx: TenantContext,
      input: { endpointId: string; failedOnly?: boolean },
    ): Promise<WebhookDeliveryView[]> {
      assertCan(ctx, 'developer.manage');
      const { endpointId } = parseInput(endpointIdSchema, { endpointId: input.endpointId });
      return db.run(
        ctx.scope,
        async (tx) =>
          tx
            .select(webhookDeliveryColumns)
            .from(webhookDeliveries)
            .innerJoin(webhookEvents, deliveryEventJoin)
            .where(
              and(
                eq(webhookDeliveries.tenantId, ctx.tenant.id),
                eq(webhookDeliveries.endpointId, endpointId),
                input.failedOnly ? eq(webhookDeliveries.state, 'failed') : undefined,
              ),
            )
            .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
            .limit(100),
        { accessMode: 'read only' },
      );
    },

    /** Delivers a finished delivery's event again, as a new delivery to the same active endpoint. */
    async replay(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const { deliveryId } = parseInput(deliveryIdSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const replayed = await replayWebhookDelivery(tx, ctx.tenant.id, deliveryId);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'webhook.delivery_replayed',
            subjectType: 'webhook_endpoint',
            subjectId: replayed.endpoint.id,
            metadata: { deliveryId, newDeliveryId: replayed.deliveryId },
          },
          meta,
        );
        return { deliveryId: replayed.deliveryId };
      });
    },

    /**
     * Delivers again every event whose deliveries to an active endpoint all failed in the chosen
     * period, 500 at most per call (ADR-095), of the chosen events or of every event (ADR-156).
     * Audited once, with the count and the events chosen.
     */
    async replayFailed(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<WebhookFailedReplay> {
      assertCan(ctx, 'developer.manage');
      const { endpointId, period, events, failures } = parseInput(replayFailedSchema, input);
      const hours = WEBHOOK_REPLAY_PERIODS.find((p) => p.key === period)?.hours ?? 1;
      const since = new Date(clock.now().getTime() - hours * 3_600_000);
      return db.run(ctx.scope, async (tx) => {
        const replayed = await replayFailedWebhookDeliveries(tx, ctx.tenant.id, endpointId, since, {
          events,
          failures,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'webhook.deliveries_replayed',
            subjectType: 'webhook_endpoint',
            subjectId: endpointId,
            metadata: {
              host: webhookHost(replayed.endpoint.url),
              since: since.toISOString(),
              ...(events ? { events } : {}),
              ...(failures ? { failures } : {}),
              queued: replayed.queued,
              more: replayed.more,
            },
          },
          meta,
        );
        return { queued: replayed.queued, more: replayed.more };
      });
    },

    /**
     * Delivers again the failed deliveries of every endpoint that is on from the chosen period, of
     * the chosen events and failures, 500 at most per call across them (ADR-160). Audited once per
     * endpoint replayed, as an endpoint's own replay is, marked as part of a replay of every one.
     */
    async replayAllFailed(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<WebhookFailedReplayAcross> {
      assertCan(ctx, 'developer.manage');
      const { period, events, failures } = parseInput(replayAllFailedSchema, input);
      const hours = WEBHOOK_REPLAY_PERIODS.find((p) => p.key === period)?.hours ?? 1;
      const since = new Date(clock.now().getTime() - hours * 3_600_000);
      return db.run(ctx.scope, async (tx) => {
        const replayed = await replayFailedAcrossEndpoints(tx, ctx.tenant.id, since, {
          events,
          failures,
        });
        for (const endpoint of replayed.endpoints) {
          await recordAudit(
            tx,
            ctx,
            {
              action: 'webhook.deliveries_replayed',
              subjectType: 'webhook_endpoint',
              subjectId: endpoint.id,
              metadata: {
                host: webhookHost(endpoint.url),
                since: since.toISOString(),
                ...(events ? { events } : {}),
                ...(failures ? { failures } : {}),
                queued: endpoint.queued,
                more: endpoint.more,
                allEndpoints: true,
              },
            },
            meta,
          );
        }
        return replayed;
      });
    },
  };
}

export type WebhooksService = ReturnType<typeof createWebhooksService>;
