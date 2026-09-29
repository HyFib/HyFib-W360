import { z } from 'zod';
import {
  AUTOMATION_END_REASONS,
  AUTOMATION_RUN_STATUSES,
  CONVERSATION_STATUSES,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  type MessageStatus,
} from '@w360/db';
import { WEBHOOK_EVENT_INFO, WEBHOOK_LIMITS, WEBHOOK_RETRY_SECONDS } from '../webhooks/model';
import {
  automationRunEndedPayloadSchema,
  automationRunStartedPayloadSchema,
  consentChangedPayloadSchema,
  contactCreatedPayloadSchema,
  contactErasedPayloadSchema,
  contactUpdatedPayloadSchema,
  conversationAssignmentPayloadSchema,
  conversationStatusPayloadSchema,
  messageReceivedPayloadSchema,
  messageStatusPayloadSchema,
  pingPayloadSchema,
  templateStatusPayloadSchema,
} from '../webhooks/payloads';
import { apiStartAutomationSchema } from './automations';
import { apiContactSchema } from './contact-view';
import { apiConversationStatusSchema } from './conversations';
import { API_LIMITS, API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import {
  apiConsentSchema,
  apiContactCreateSchema,
  apiSendMessageSchema,
  apiSendTextSchema,
} from './resources';

/**
 * The OpenAPI 3.1 document of the public API v1 (ADR-052), built from the zod schemas that
 * validate requests and describe responses, so the document and the checks cannot drift apart.
 */

export const apiTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  language: z.string(),
  category: z.enum(['utility', 'marketing']),
  variables: z.object({
    header: z.number().int().describe('How many header values the template needs (0 or 1).'),
    body: z.number().int().describe('How many body values the template needs.'),
  }),
  text: z.object({
    header: z.string().nullable(),
    body: z.string(),
    footer: z.string().nullable(),
  }),
  channels: z
    .array(z.object({ id: z.uuid(), phone: z.string().nullable() }))
    .describe('Active WhatsApp numbers that can send the template.'),
});

export const apiQueuedMessageSchema = z.object({
  id: z.uuid(),
  type: z.enum(['template', 'text']),
  status: z.literal('queued'),
  contactId: z.uuid(),
  channelId: z.uuid(),
  templateId: z.uuid().optional().describe('The template sent, for templates.'),
});

/** The states of an outbound message (the `received` state is for inbound messages only). */
const OUTBOUND_STATUSES = [
  'queued',
  'sending',
  'accepted',
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
  'canceled',
  'unknown_outcome',
] as const satisfies readonly MessageStatus[];

export const apiMessageSchema = z.object({
  id: z.uuid(),
  type: z.enum(['template', 'text']),
  status: z
    .enum(OUTBOUND_STATUSES)
    .describe(
      'accepted: WhatsApp took the message; sent, delivered, read and failed follow from its status updates. unknown_outcome: the send was interrupted and it is unknown whether WhatsApp took it, so it is not retried.',
    ),
  statusAt: z.iso.datetime(),
  to: z.string().nullable(),
  templateId: z.uuid().nullable(),
  templateName: z.string().nullable(),
  channelId: z.uuid(),
  contactId: z.uuid(),
  error: z.object({ code: z.string().nullable(), title: z.string().nullable() }).nullable(),
  createdAt: z.iso.datetime(),
});

export const apiConversationSchema = z.object({
  id: z.uuid(),
  contactId: z.uuid(),
  channelId: z.uuid().describe('The WhatsApp number the conversation is on.'),
  status: z.enum(CONVERSATION_STATUSES),
  assigned: z.boolean().describe('Whether a member of the team is assigned.'),
  unreadCount: z.number().int(),
  lastMessageAt: z.iso.datetime().nullable(),
  lastInboundAt: z.iso.datetime().nullable().describe('When the contact last wrote.'),
  serviceWindowEndsAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'When WhatsApp’s customer service window ends, 24 hours after the contact last wrote: until then a text reply can be sent (POST /messages with `type` `text`).',
    ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().describe('When anything about the conversation last changed.'),
  resolvedAt: z.iso.datetime().nullable(),
});

export const apiConversationMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  direction: z.enum(['inbound', 'outbound']).describe('inbound: written by the contact.'),
  type: z.enum(MESSAGE_TYPES),
  text: z
    .string()
    .nullable()
    .describe(
      'The words of the message: the text, a caption, the title of a tapped reply, a reaction or a location’s name; for outbound messages the text, a template’s body with its values or an interactive message’s body. Null if none.',
    ),
  reply: z
    .object({ id: z.string().nullable(), title: z.string().nullable() })
    .nullable()
    .describe('The button or list reply the contact tapped.'),
  mimeType: z.string().nullable().describe('For media messages (the media is not attached).'),
  templateId: z.uuid().nullable(),
  templateName: z.string().nullable(),
  sentBy: z
    .enum(['agent', 'bot', 'campaign', 'api', 'system'])
    .nullable()
    .describe(
      'Who sent an outbound message: a member (agent), an automation (bot), a campaign, the API or HyFib (system). Null for inbound messages.',
    ),
  apiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that sent it, for messages sent through the API.'),
  status: z.enum(MESSAGE_STATUSES).describe('received for inbound messages.'),
  statusAt: z.iso.datetime(),
  error: z.object({ code: z.string().nullable(), title: z.string().nullable() }).nullable(),
  createdAt: z.iso.datetime(),
});

export const apiAutomationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z
    .enum(['active', 'paused'])
    .describe('A paused automation refuses to start (reason automation_paused).'),
  inputs: z
    .array(z.string())
    .describe('The inputs every start must give, by name; the steps use them as {{input.<name>}}.'),
  channelId: z.uuid().nullable().describe('The WhatsApp number the automation sends from.'),
  phoneNumber: z.string().nullable().describe('That number, as WhatsApp displays it.'),
  createdAt: z.iso.datetime(),
});

export const apiAutomationRunSchema = z.object({
  id: z.uuid(),
  automationId: z.uuid(),
  contactId: z.uuid(),
  conversationId: z.uuid(),
  channelId: z.uuid(),
  status: z
    .enum(AUTOMATION_RUN_STATUSES)
    .describe(
      'running or waiting while it works (waiting for the contact, a timer or a web request); completed, handed_off (to a member), taken_over (a member or the API replied), stopped or failed once it ended.',
    ),
  endReason: z
    .enum(Object.values(AUTOMATION_END_REASONS).flat() as [string, ...string[]])
    .nullable()
    .describe('Why the run ended; null while it works.'),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z
      .string()
      .describe(
        'unauthenticated, forbidden, not_found, conflict, validation_failed, precondition_failed, rate_limited, tenant_suspended, unsupported, bad_request, internal.',
      ),
    message: z.string(),
    reason: z
      .string()
      .optional()
      .describe(
        'A finer reason: automation_busy, automation_limit, automation_paused, automation_quota, automation_unavailable, channel_unavailable, conversation_assigned, idempotency_key_reused, ip_not_allowed, not_in_plan, quota_exceeded or window_closed.',
      ),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
  requestId: z.string(),
});

function jsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'output') {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  return rest;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const dataOf = (schema: unknown) => ({
  type: 'object',
  properties: { data: schema },
  required: ['data'],
});

const errors = (...statuses: number[]) =>
  Object.fromEntries(
    statuses.map((status) => [
      String(status),
      {
        description:
          {
            400: 'The request is malformed (for example invalid JSON or a missing header).',
            401: 'No valid API key: missing, unknown, revoked or expired.',
            403: "The key lacks the scope this needs, the company's plan does not include the API, or automations when starting one (reason not_in_plan), or the key does not accept requests from the client's address (reason ip_not_allowed).",
            404: 'Not found in the company.',
            409: 'The request conflicts with the current state. Starting an automation: another automation handles the conversation (reason automation_busy), a member is assigned to it (conversation_assigned), or it had as many runs in the last hour as allowed (automation_limit).',
            412: "A condition for sending or saving is not met (consent, suppression, state). With reason window_closed, the number has not written to the WhatsApp number in the last 24 hours, so only templates can be sent to it. Starting an automation: it is not published, archived or not started through the API (automation_unavailable), paused (automation_paused), its number is not active (channel_unavailable), or the plan's automation runs for the month are used up (automation_quota).",
            415: 'The body must be JSON (Content-Type: application/json).',
            422: 'The request body or parameters are invalid.',
            423: 'The company is suspended or its plan has ended: reading only.',
            429: "Too many requests: wait for Retry-After seconds. With reason quota_exceeded, the plan's API requests for the month are used up, and Retry-After counts the seconds until the next month's period starts.",
            500: 'Something went wrong on our side; retry later (with the same Idempotency-Key).',
          }[status] ?? 'Error',
        content: json(ref('Error')),
      },
    ]),
  );

const pageParams = [
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: API_LIMITS.pageSize, default: 50 },
  },
  {
    name: 'cursor',
    in: 'query',
    schema: { type: 'string' },
    description: '`nextCursor` from the previous page.',
  },
];

const pageOf = (schema: string) =>
  json({
    type: 'object',
    properties: {
      data: { type: 'array', items: ref(schema) },
      nextCursor: { type: ['string', 'null'] },
    },
    required: ['data', 'nextCursor'],
  });

const scopeNote = (...scopes: string[]) => `Scope: ${scopes.map((s) => `\`${s}\``).join(' or ')}.`;

const retrySchedule = WEBHOOK_RETRY_SECONDS.map((seconds) =>
  seconds < 3_600 ? `${seconds / 60} min` : `${seconds / 3_600} h`,
).join(', ');

/** One webhook the API sends (OpenAPI 3.1 `webhooks`): a signed POST to the company's endpoint. */
const webhook = (operationId: string, summary: string, description: string, schema: string) => ({
  post: {
    operationId,
    summary,
    description: `${description} Verify \`W360-Signature\` before trusting the body, and deduplicate on the event id.`,
    security: [],
    parameters: [
      { $ref: '#/components/parameters/WebhookSignature' },
      { $ref: '#/components/parameters/WebhookEventId' },
      { $ref: '#/components/parameters/WebhookEventType' },
      { $ref: '#/components/parameters/WebhookDeliveryId' },
      { $ref: '#/components/parameters/WebhookDeliveryAttempt' },
    ],
    requestBody: { required: true, content: json(ref(schema)) },
    responses: {
      '2XX': {
        description: `Received. Any other answer, or none within 10 seconds, is retried (${retrySchedule}).`,
      },
    },
  },
});

export function buildOpenApiDocument(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'HyFib W360 API',
      version: '1.0.0',
      description: [
        'Send approved WhatsApp templates, reply with text to contacts who wrote in the last 24 hours, read conversations and their messages, resolve and reopen conversations, manage contacts and consent, and read message status for your company.',
        '',
        'Authenticate with `Authorization: Bearer <API key>`; keys are created in Settings → API keys and belong to the company. A key can be limited to the addresses its systems call from: a request from any other address is refused with 403 (reason `ip_not_allowed`).',
        `Scopes: ${API_SCOPE_KEYS.map((s) => `\`${s}\` (${API_SCOPE_INFO[s].label.toLowerCase()})`).join(', ')}.`,
        '',
        `Limits: ${API_LIMITS.keyRate.refillPerSecond} requests a second per key (bursts of ${API_LIMITS.keyRate.capacity}) and ${API_LIMITS.companyRate.refillPerSecond} per company; JSON bodies up to ${API_LIMITS.bodyBytes / 1024} KB.`,
        '',
        `POST /messages needs an \`Idempotency-Key\` header: a retry with the same key and body returns the first response (header \`Idempotent-Replayed: true\`) and never sends twice; responses are kept ${API_LIMITS.idempotencyHours} hours. Delivery itself follows WhatsApp: read the status with GET /messages/{id}.`,
        '',
        `Webhooks: endpoints added in Settings → Webhooks receive the events below as signed JSON POSTs. \`W360-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret>\` (two \`v1\` values for ${WEBHOOK_LIMITS.previousSecretHours} hours after the secret is rotated); reject a time more than 5 minutes from yours. Answer with a 2xx status within 10 seconds; anything else is retried (${retrySchedule}; ${WEBHOOK_LIMITS.attempts} attempts). Delivery is at least once and unordered: deduplicate on the event id. An endpoint failing for ${WEBHOOK_LIMITS.disableAfterHours} hours is turned off.`,
      ].join('\n'),
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    paths: {
      '/templates': {
        get: {
          operationId: 'listTemplates',
          summary: 'Approved templates that can be sent',
          description: scopeNote('templates.read'),
          responses: {
            '200': {
              description: 'The templates.',
              content: json(dataOf({ type: 'array', items: ref('Template') })),
            },
            ...errors(401, 403, 429, 500),
          },
        },
      },
      '/contacts': {
        get: {
          operationId: 'listContacts',
          summary: 'Contacts, newest first',
          description: scopeNote('contacts.read'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: API_LIMITS.pageSize, default: 50 },
            },
            {
              name: 'cursor',
              in: 'query',
              schema: { type: 'string' },
              description: '`nextCursor` from the previous page.',
            },
            {
              name: 'phone',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only the contact with this number (with its country code).',
            },
          ],
          responses: {
            '200': {
              description: 'A page of contacts.',
              content: json({
                type: 'object',
                properties: {
                  data: { type: 'array', items: ref('Contact') },
                  nextCursor: { type: ['string', 'null'] },
                },
                required: ['data', 'nextCursor'],
              }),
            },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createContact',
          summary: 'Create a contact, or get the existing one for the number',
          description: `${scopeNote('contacts.write')} An existing contact answers 200 with \`created: false\`; empty name and email are filled and tags added.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('ContactCreate')) },
          responses: {
            '201': {
              description: 'Created.',
              content: json({
                type: 'object',
                properties: { data: ref('Contact'), created: { type: 'boolean' } },
                required: ['data', 'created'],
              }),
            },
            '200': {
              description: 'The contact already existed.',
              content: json({
                type: 'object',
                properties: { data: ref('Contact'), created: { type: 'boolean' } },
                required: ['data', 'created'],
              }),
            },
            ...errors(400, 401, 403, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/contacts/{id}': {
        get: {
          operationId: 'getContact',
          summary: 'A contact',
          description: scopeNote('contacts.read'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The contact.', content: json(dataOf(ref('Contact'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
      },
      '/contacts/{id}/consent': {
        post: {
          operationId: 'recordConsent',
          summary: 'Record an opt-in or opt-out',
          description: `${scopeNote('contacts.write')} Recorded with its evidence as consent from the API; marketing templates need the contact's marketing opt-in.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('Consent')) },
          responses: {
            '200': {
              description: 'The contact with its consent.',
              content: json(dataOf(ref('Contact'))),
            },
            ...errors(400, 401, 403, 404, 415, 422, 423, 429, 500),
          },
        },
      },
      '/messages': {
        post: {
          operationId: 'sendMessage',
          summary: 'Send an approved template, or a text reply',
          description: [
            `${scopeNote('messages.send', 'messages.send_marketing', 'messages.reply')}`,
            'A template (`type` `template` or left out): utility templates need `messages.send`, marketing templates `messages.send_marketing`. The contact is created when new; consent, the suppression list and the marketing frequency cap are checked.',
            'A text reply (`type` `text`) needs `messages.reply` and goes only to a number that wrote to the WhatsApp number in the last 24 hours (WhatsApp’s customer service window); otherwise it is refused with reason `window_closed`, and nothing tells whether the number is a contact. It stops an automation answering the conversation, and the conversation keeps waiting for a member of the team. The window is checked again when the message is sent.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: {
            required: true,
            content: json({ oneOf: [ref('SendTemplate'), ref('SendText')] }),
          },
          responses: {
            '201': {
              description: 'Queued for sending.',
              content: json(dataOf(ref('QueuedMessage'))),
            },
            ...errors(400, 401, 403, 404, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/conversations': {
        get: {
          operationId: 'listConversations',
          summary: 'Conversations, newest first',
          description: `${scopeNote('conversations.read')} Pages never skip or repeat a conversation. To catch up on changes, ask for \`updatedSince\` a little before your previous pass began (a minute, say) and expect to see some conversations again: a change carries the time it began to be saved, so one still being saved while you read can carry an earlier time. Conversations of erased contacts are not listed.`,
          parameters: [
            ...pageParams,
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: [...CONVERSATION_STATUSES] },
            },
            {
              name: 'contactId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the conversations of this contact.',
            },
            {
              name: 'channelId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the conversations on this WhatsApp number.',
            },
            {
              name: 'updatedSince',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description:
                'Only conversations changed at or after this time (a new message, a status or assignee change, a read).',
            },
          ],
          responses: {
            '200': { description: 'A page of conversations.', content: pageOf('Conversation') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/conversations/{id}': {
        get: {
          operationId: 'getConversation',
          summary: 'A conversation',
          description: scopeNote('conversations.read'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The conversation.',
              content: json(dataOf(ref('Conversation'))),
            },
            ...errors(401, 403, 404, 429, 500),
          },
        },
        patch: {
          operationId: 'setConversationStatus',
          summary: 'Resolve or reopen a conversation',
          description: [
            `${scopeNote('conversations.write')} As a member does in the inbox. Resolving stops an automation answering the conversation and ends the wait for a reply; the contact's next message opens the conversation again. No satisfaction survey is sent: surveys follow a member's resolve.`,
            'Asking for the status the conversation already has changes nothing, so a retry is safe without an `Idempotency-Key`. Conversations of erased contacts are not found.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('ConversationStatus')) },
          responses: {
            '200': {
              description: 'The conversation, as it now is.',
              content: json(dataOf(ref('Conversation'))),
            },
            ...errors(400, 401, 403, 404, 415, 422, 423, 429, 500),
          },
        },
      },
      '/conversations/{id}/messages': {
        get: {
          operationId: 'listConversationMessages',
          summary: 'The messages of a conversation, newest first',
          description: `${scopeNote('conversations.read')} Messages read as the webhooks describe them; media is not attached. Internal notes are not messages.`,
          parameters: [{ $ref: '#/components/parameters/Id' }, ...pageParams],
          responses: {
            '200': { description: 'A page of messages.', content: pageOf('ConversationMessage') },
            ...errors(401, 403, 404, 422, 429, 500),
          },
        },
      },
      '/automations': {
        get: {
          operationId: 'listAutomations',
          summary: 'Automations started through the API, oldest first',
          description: `${scopeNote('automations.start')} Published automations whose trigger is "Started through the API", active or paused, with the inputs each start must give.`,
          parameters: pageParams,
          responses: {
            '200': { description: 'A page of automations.', content: pageOf('Automation') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/automations/{id}/runs': {
        post: {
          operationId: 'startAutomationRun',
          summary: 'Start an automation for a contact',
          description: [
            `${scopeNote('automations.start')} An automation that sends marketing templates also needs \`messages.send_marketing\`. Starts the published automation for the contact with this number (created when new), with every input its trigger declares. The run sends from the automation's number; until the contact replies it sends templates only, each checked for consent (and, for marketing, the frequency cap) when it is sent.`,
            'Refused, changing nothing, when the contact was erased, opted out or is on the suppression list, when a member is assigned to the conversation or another automation handles it, or when the plan has no automation runs left. One run per `Idempotency-Key`: a retry answers as the first request did.',
          ].join('\n\n'),
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: { required: true, content: json(ref('StartAutomationRun')) },
          responses: {
            '201': {
              description: 'The run, as it starts.',
              content: json(dataOf(ref('AutomationRun'))),
            },
            ...errors(400, 401, 403, 404, 409, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/automation-runs/{id}': {
        get: {
          operationId: 'getAutomationRun',
          summary: 'A run started through the API',
          description: `${scopeNote('automations.start')} Any run a key of the company started.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The run.', content: json(dataOf(ref('AutomationRun'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
      },
      '/automation-runs/{id}/stop': {
        post: {
          operationId: 'stopAutomationRun',
          summary: 'Stop a run started through the API',
          description: [
            `${scopeNote('automations.start')} Any run a key of the company started. A running or waiting run ends as \`stopped\` with the reason \`stopped_by_api\`: messages it queued that have not left are cancelled, and the conversation is not handed to people (a customer who wrote waits for a member in the inbox, as after a reply through the API).`,
            'A run that has already ended is answered as it is and nothing changes, so a retry is harmless; its `endReason` says how it ended.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The run, as it is now.',
              content: json(dataOf(ref('AutomationRun'))),
            },
            ...errors(401, 403, 404, 423, 429, 500),
          },
        },
      },
      '/messages/{id}': {
        get: {
          operationId: 'getMessage',
          summary: 'The status of a message sent through the API',
          description: scopeNote('messages.send', 'messages.send_marketing', 'messages.reply'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The message.', content: json(dataOf(ref('Message'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
      },
    },
    webhooks: {
      'message.received': webhook(
        'webhookMessageReceived',
        WEBHOOK_EVENT_INFO['message.received'].label,
        WEBHOOK_EVENT_INFO['message.received'].description,
        'WebhookMessageReceived',
      ),
      'message.status': webhook(
        'webhookMessageStatus',
        WEBHOOK_EVENT_INFO['message.status'].label,
        WEBHOOK_EVENT_INFO['message.status'].description,
        'WebhookMessageStatus',
      ),
      'consent.changed': webhook(
        'webhookConsentChanged',
        WEBHOOK_EVENT_INFO['consent.changed'].label,
        WEBHOOK_EVENT_INFO['consent.changed'].description,
        'WebhookConsentChanged',
      ),
      'template.status_changed': webhook(
        'webhookTemplateStatusChanged',
        WEBHOOK_EVENT_INFO['template.status_changed'].label,
        WEBHOOK_EVENT_INFO['template.status_changed'].description,
        'WebhookTemplateStatusChanged',
      ),
      'conversation.status_changed': webhook(
        'webhookConversationStatusChanged',
        WEBHOOK_EVENT_INFO['conversation.status_changed'].label,
        WEBHOOK_EVENT_INFO['conversation.status_changed'].description,
        'WebhookConversationStatusChanged',
      ),
      'conversation.assignment_changed': webhook(
        'webhookConversationAssignmentChanged',
        WEBHOOK_EVENT_INFO['conversation.assignment_changed'].label,
        WEBHOOK_EVENT_INFO['conversation.assignment_changed'].description,
        'WebhookConversationAssignmentChanged',
      ),
      'contact.created': webhook(
        'webhookContactCreated',
        WEBHOOK_EVENT_INFO['contact.created'].label,
        `${WEBHOOK_EVENT_INFO['contact.created'].description} An import sends one per contact added.`,
        'WebhookContactCreated',
      ),
      'contact.updated': webhook(
        'webhookContactUpdated',
        WEBHOOK_EVENT_INFO['contact.updated'].label,
        `${WEBHOOK_EVENT_INFO['contact.updated'].description} One event per contact for each change saved; a contact added in the same change is sent as contact.created only.`,
        'WebhookContactUpdated',
      ),
      'contact.erased': webhook(
        'webhookContactErased',
        WEBHOOK_EVENT_INFO['contact.erased'].label,
        WEBHOOK_EVENT_INFO['contact.erased'].description,
        'WebhookContactErased',
      ),
      'automation.run_started': webhook(
        'webhookAutomationRunStarted',
        WEBHOOK_EVENT_INFO['automation.run_started'].label,
        `${WEBHOOK_EVENT_INFO['automation.run_started'].description} For a run started through the API, run.id is the id POST /automations/{id}/runs answered and run.apiKeyId names the key that called it.`,
        'WebhookAutomationRunStarted',
      ),
      'automation.run_ended': webhook(
        'webhookAutomationRunEnded',
        WEBHOOK_EVENT_INFO['automation.run_ended'].label,
        `${WEBHOOK_EVENT_INFO['automation.run_ended'].description} Deliveries are not ordered: the end of a short run can arrive before its start, so compare run.startedAt and run.endedAt.`,
        'WebhookAutomationRunEnded',
      ),
      ping: webhook(
        'webhookPing',
        'Test event',
        'Sent only when a member chooses "Send test event" for the endpoint.',
        'WebhookPing',
      ),
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'A company API key.' },
      },
      parameters: {
        Id: { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string', maxLength: API_LIMITS.idempotencyKeyLength },
          description: 'A unique key per request (for example a UUID), reused only for retries.',
        },
        IdempotencyKeyOptional: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          schema: { type: 'string', maxLength: API_LIMITS.idempotencyKeyLength },
        },
        WebhookSignature: {
          name: 'W360-Signature',
          in: 'header',
          required: true,
          schema: { type: 'string' },
          description:
            '`t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, with one `v1` per signing secret.',
        },
        WebhookEventId: {
          name: 'W360-Event-Id',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          description:
            'The event id (also `id` in the body): the same on every attempt and replay.',
        },
        WebhookEventType: {
          name: 'W360-Event-Type',
          in: 'header',
          required: true,
          schema: { type: 'string' },
        },
        WebhookDeliveryId: {
          name: 'W360-Delivery-Id',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          description: 'This delivery; a replay is a new delivery of the same event.',
        },
        WebhookDeliveryAttempt: {
          name: 'W360-Delivery-Attempt',
          in: 'header',
          required: true,
          schema: { type: 'integer', minimum: 1, maximum: WEBHOOK_LIMITS.attempts },
        },
      },
      schemas: {
        Contact: jsonSchema(apiContactSchema),
        ContactCreate: jsonSchema(apiContactCreateSchema, 'input'),
        Consent: jsonSchema(apiConsentSchema, 'input'),
        Template: jsonSchema(apiTemplateSchema),
        SendTemplate: jsonSchema(apiSendMessageSchema, 'input'),
        SendText: jsonSchema(apiSendTextSchema, 'input'),
        QueuedMessage: jsonSchema(apiQueuedMessageSchema),
        Message: jsonSchema(apiMessageSchema),
        Conversation: jsonSchema(apiConversationSchema),
        ConversationMessage: jsonSchema(apiConversationMessageSchema),
        ConversationStatus: jsonSchema(apiConversationStatusSchema, 'input'),
        Automation: jsonSchema(apiAutomationSchema),
        AutomationRun: jsonSchema(apiAutomationRunSchema),
        StartAutomationRun: jsonSchema(apiStartAutomationSchema, 'input'),
        Error: jsonSchema(apiErrorSchema),
        WebhookMessageReceived: jsonSchema(messageReceivedPayloadSchema),
        WebhookMessageStatus: jsonSchema(messageStatusPayloadSchema),
        WebhookConsentChanged: jsonSchema(consentChangedPayloadSchema),
        WebhookTemplateStatusChanged: jsonSchema(templateStatusPayloadSchema),
        WebhookConversationStatusChanged: jsonSchema(conversationStatusPayloadSchema),
        WebhookConversationAssignmentChanged: jsonSchema(conversationAssignmentPayloadSchema),
        WebhookContactCreated: jsonSchema(contactCreatedPayloadSchema),
        WebhookContactUpdated: jsonSchema(contactUpdatedPayloadSchema),
        WebhookContactErased: jsonSchema(contactErasedPayloadSchema),
        WebhookAutomationRunStarted: jsonSchema(automationRunStartedPayloadSchema),
        WebhookAutomationRunEnded: jsonSchema(automationRunEndedPayloadSchema),
        WebhookPing: jsonSchema(pingPayloadSchema),
      },
    },
  };
}

/** The routes the document describes: method and path template (checked by a unit test). */
export const API_ROUTES = [
  ['get', '/templates'],
  ['get', '/contacts'],
  ['post', '/contacts'],
  ['get', '/contacts/{id}'],
  ['post', '/contacts/{id}/consent'],
  ['post', '/messages'],
  ['get', '/messages/{id}'],
  ['get', '/conversations'],
  ['get', '/conversations/{id}'],
  ['patch', '/conversations/{id}'],
  ['get', '/conversations/{id}/messages'],
  ['get', '/automations'],
  ['post', '/automations/{id}/runs'],
  ['get', '/automation-runs/{id}'],
  ['post', '/automation-runs/{id}/stop'],
] as const;
