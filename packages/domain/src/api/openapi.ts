import { z } from 'zod';
import type { MessageStatus } from '@w360/db';
import { API_LIMITS, API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { apiConsentSchema, apiContactCreateSchema, apiSendMessageSchema } from './resources';

/**
 * The OpenAPI 3.1 document of the public API v1 (ADR-052), built from the zod schemas that
 * validate requests and describe responses, so the document and the checks cannot drift apart.
 */

const consentValue = z.enum(['opted_in', 'opted_out']).nullable();

export const apiContactSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  phone: z.string().nullable().describe('E.164, like +919876543210.'),
  email: z.string().nullable(),
  tags: z.array(z.string()),
  consent: z.object({ marketing: consentValue, utility: consentValue }),
  source: z.string().describe('Where the contact came from: whatsapp, manual, import, api, store.'),
  createdAt: z.iso.datetime(),
});

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
  status: z.literal('queued'),
  contactId: z.uuid(),
  channelId: z.uuid(),
  templateId: z.uuid(),
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

export const apiErrorSchema = z.object({
  error: z.object({
    code: z
      .string()
      .describe(
        'unauthenticated, forbidden, not_found, conflict, validation_failed, precondition_failed, rate_limited, tenant_suspended, unsupported, bad_request, internal.',
      ),
    message: z.string(),
    reason: z.string().optional().describe('A finer reason, like idempotency_key_reused.'),
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
            403: 'The key lacks the scope this needs.',
            404: 'Not found in the company.',
            409: 'The request conflicts with the current state.',
            412: 'A condition for sending or saving is not met (consent, suppression, state).',
            415: 'The body must be JSON (Content-Type: application/json).',
            422: 'The request body or parameters are invalid.',
            423: 'The company is suspended or its plan has ended: reading only.',
            429: 'Too many requests: wait for Retry-After seconds.',
            500: 'Something went wrong on our side; retry later (with the same Idempotency-Key).',
          }[status] ?? 'Error',
        content: json(ref('Error')),
      },
    ]),
  );

const scopeNote = (...scopes: string[]) => `Scope: ${scopes.map((s) => `\`${s}\``).join(' or ')}.`;

export function buildOpenApiDocument(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'HyFib W360 API',
      version: '1.0.0',
      description: [
        'Send approved WhatsApp templates, manage contacts and consent, and read message status for your company.',
        '',
        'Authenticate with `Authorization: Bearer <API key>`; keys are created in Settings → API keys and belong to the company.',
        `Scopes: ${API_SCOPE_KEYS.map((s) => `\`${s}\` (${API_SCOPE_INFO[s].label.toLowerCase()})`).join(', ')}.`,
        '',
        `Limits: ${API_LIMITS.keyRate.refillPerSecond} requests a second per key (bursts of ${API_LIMITS.keyRate.capacity}) and ${API_LIMITS.companyRate.refillPerSecond} per company; JSON bodies up to ${API_LIMITS.bodyBytes / 1024} KB.`,
        '',
        `POST /messages needs an \`Idempotency-Key\` header: a retry with the same key and body returns the first response (header \`Idempotent-Replayed: true\`) and never sends twice; responses are kept ${API_LIMITS.idempotencyHours} hours. Delivery itself follows WhatsApp: read the status with GET /messages/{id}.`,
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
          operationId: 'sendTemplate',
          summary: 'Send an approved template',
          description: `${scopeNote('messages.send', 'messages.send_marketing')} Utility templates need \`messages.send\`, marketing templates \`messages.send_marketing\`. The contact is created when new; consent, the suppression list and the marketing frequency cap are checked.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: json(ref('SendTemplate')) },
          responses: {
            '201': {
              description: 'Queued for sending.',
              content: json(dataOf(ref('QueuedMessage'))),
            },
            ...errors(400, 401, 403, 404, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/messages/{id}': {
        get: {
          operationId: 'getMessage',
          summary: 'The status of a message sent through the API',
          description: scopeNote('messages.send', 'messages.send_marketing'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The message.', content: json(dataOf(ref('Message'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
      },
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
      },
      schemas: {
        Contact: jsonSchema(apiContactSchema),
        ContactCreate: jsonSchema(apiContactCreateSchema, 'input'),
        Consent: jsonSchema(apiConsentSchema, 'input'),
        Template: jsonSchema(apiTemplateSchema),
        SendTemplate: jsonSchema(apiSendMessageSchema, 'input'),
        QueuedMessage: jsonSchema(apiQueuedMessageSchema),
        Message: jsonSchema(apiMessageSchema),
        Error: jsonSchema(apiErrorSchema),
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
] as const;
