import { z } from 'zod';
import { AppError, notFound, type Clock } from '@w360/core';
import type { EgressPolicy } from '@w360/core/egress';
import {
  and,
  apiKeys,
  asc,
  desc,
  eq,
  exactTimestamp,
  isNotNull,
  sql,
  tenants,
  WEBHOOK_DELIVERY_STATES,
  webhookDeliveries,
  webhookEndpoints,
  webhookEvents,
  type Database,
  type Tx,
  type WebhookDeliveryState,
  type WebhookCampaignStatus,
  type WebhookContactPart,
  type WebhookConversationStatus,
  type WebhookEventType,
  type WebhookMessageStatus,
  type WebhookOrderStatus,
  type WebhookTemplateStatus,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { deletionRecipients, formatCompanyTime } from '../tenancy/deletion';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import {
  WEBHOOK_EVENT_INFO,
  WEBHOOK_LIMITS,
  webhookHost,
  webhookTakesAutomationRuns,
} from '../webhooks/model';
import {
  assertWebhookAutomations,
  checkedWebhookUrl,
  deliveryEventJoin,
  insertWebhookEndpoint,
  lockWebhookEndpoint,
  queueWebhookTest,
  replayFailedWebhookDeliveries,
  replayWebhookDelivery,
  rotateWebhookEndpointSecret,
  sealWebhookHeaders,
  setWebhookEndpointEnabled,
  WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS,
  WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT,
  WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT,
  WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT,
  WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT,
  webhookAutomationIdsFor,
  webhookAutomationIdsSchema,
  webhookCampaignStatusesFor,
  webhookCampaignStatusesSchema,
  webhookContactPartsFor,
  webhookConversationStatusesFor,
  webhookConversationStatusesSchema,
  webhookContactPartsSchema,
  webhookDeliveryColumns,
  WEBHOOK_PARTS_NEED_THE_EVENT,
  WEBHOOK_STATUSES_NEED_THE_EVENT,
  webhookEventTypesSchema,
  webhookHeadersSchema,
  webhookMessageStatusesFor,
  webhookMessageStatusesSchema,
  webhookOrderStatusesFor,
  webhookOrderStatusesSchema,
  webhookTemplateStatusesFor,
  webhookTemplateStatusesSchema,
  type WebhookDeliveryView,
} from '../webhooks/service';
import { apiActor, assertScope, type ApiContext } from './context';
import type { ApiResponse, IdempotencyInput } from './idempotency';
import { API_LIMITS } from './model';
import { idempotent } from './resources';

/**
 * Webhook endpoints through the public API (ADR-081): a `webhooks.manage` key adds endpoints and
 * reads, changes, rotates the secret of and deletes the endpoints keys added; it also reads their
 * deliveries, sends them test events and replays finished deliveries (ADR-083). Endpoints members
 * added in settings, and their deliveries, are not found: their addresses can carry a receiver's
 * own token, and they stay under members' control. Settings → Webhooks shows every endpoint,
 * whoever added it.
 */

const descriptionField = z
  .string()
  .trim()
  .max(WEBHOOK_LIMITS.descriptionLength, 'Keep the description under 200 characters');

const headersField = webhookHeadersSchema.describe(
  `Up to ${WEBHOOK_LIMITS.headers} headers the receiver asks for, sent with every delivery (for example an Authorization header it issued). Values are secrets: they are stored encrypted and never shown again. Not allowed: Content-Type, Content-Encoding, User-Agent, the transport's headers (Host, Content-Length, Transfer-Encoding, Connection, Keep-Alive, Upgrade, TE, Trailer, Expect, Accept-Encoding), Proxy-* and HyFib's W360-*.`,
);

const messageStatusesField = webhookMessageStatusesSchema.describe(
  'The message.status statuses the endpoint receives (accepted, sent, delivered, read, played, failed, canceled, unknown_outcome), only with the message.status event; null receives every status, including statuses added later.',
);

/** Statuses are chosen only for an endpoint that receives `message.status` (ADR-119). */
const invalidStatuses = () =>
  new AppError('validation_failed', WEBHOOK_STATUSES_NEED_THE_EVENT, {
    issues: [{ path: 'messageStatuses', message: WEBHOOK_STATUSES_NEED_THE_EVENT }],
  });

const contactPartsField = webhookContactPartsSchema.describe(
  'The parts of a contact whose change the endpoint receives as contact.updated (name, phone, email, tags, fields: a change of any custom field), only with the contact.updated event: an event is sent when its change names one of them, and names every part that changed; null receives every change, including parts added later.',
);

/** Contact parts are chosen only for an endpoint that receives `contact.updated` (ADR-123). */
const invalidParts = () =>
  new AppError('validation_failed', WEBHOOK_PARTS_NEED_THE_EVENT, {
    issues: [{ path: 'contactParts', message: WEBHOOK_PARTS_NEED_THE_EVENT }],
  });

const automationIdsField = webhookAutomationIdsSchema.describe(
  `The automations whose runs the endpoint receives as automation.run_started and automation.run_ended, 1 to ${WEBHOOK_LIMITS.automations} ids of the company's automations that have been published (an archived one stays allowed), only with one of those events; null receives every automation's runs, including automations published later.`,
);

/** Automations are chosen only for an endpoint that receives automation runs (ADR-145). */
const invalidAutomations = () =>
  new AppError('validation_failed', WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS, {
    issues: [{ path: 'automationIds', message: WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS }],
  });

const campaignStatusesField = webhookCampaignStatusesSchema.describe(
  'The statuses a campaign reaches that the endpoint receives as campaign.status_changed (draft, pending_approval, scheduled, running, paused, completed, canceled), only with the campaign.status_changed event; null receives every status.',
);

/** Campaign statuses are chosen only for an endpoint that receives campaign changes (ADR-146). */
const invalidCampaignStatuses = () =>
  new AppError('validation_failed', WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT, {
    issues: [{ path: 'campaignStatuses', message: WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT }],
  });

const orderStatusesField = webhookOrderStatusesSchema.describe(
  'The statuses an order reaches that the endpoint receives as order.status_changed (confirmed, awaiting_payment, paid, fulfilled, cancelled), only with the order.status_changed event; null receives every status.',
);

/** Order statuses are chosen only for an endpoint that receives order changes (ADR-147). */
const invalidOrderStatuses = () =>
  new AppError('validation_failed', WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT, {
    issues: [{ path: 'orderStatuses', message: WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT }],
  });

const templateStatusesField = webhookTemplateStatusesSchema.describe(
  'The template statuses the endpoint receives as template.status_changed (pending, approved, rejected, paused, disabled, in_appeal, flagged, archived, deleted, limit_exceeded, locked), only with the template.status_changed event; null receives every status.',
);

/** Template statuses are chosen only for an endpoint that receives template changes (ADR-148). */
const invalidTemplateStatuses = () =>
  new AppError('validation_failed', WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT, {
    issues: [{ path: 'templateStatuses', message: WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT }],
  });

const conversationStatusesField = webhookConversationStatusesSchema.describe(
  'The statuses a conversation reaches that the endpoint receives as conversation.status_changed (open, resolved), only with the conversation.status_changed event; null receives every status.',
);

/** Conversation statuses are chosen only for an endpoint that receives their changes (ADR-149). */
const invalidConversationStatuses = () =>
  new AppError('validation_failed', WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT, {
    issues: [
      { path: 'conversationStatuses', message: WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT },
    ],
  });

export const apiCreateWebhookEndpointSchema = z
  .object({
    url: z
      .string({ error: 'Give the endpoint URL' })
      .trim()
      .min(1, 'Give the endpoint URL')
      .max(WEBHOOK_LIMITS.urlLength, 'The URL is too long')
      .describe(
        'Where HyFib sends the events: an https address on the public internet (no credentials, standard ports).',
      ),
    events: webhookEventTypesSchema.describe('The events the endpoint receives.'),
    description: descriptionField.optional().describe('A note for members, up to 200 characters.'),
    headers: headersField.optional(),
    messageStatuses: messageStatusesField.optional(),
    contactParts: contactPartsField.optional(),
    automationIds: automationIdsField.optional(),
    campaignStatuses: campaignStatusesField.optional(),
    orderStatuses: orderStatusesField.optional(),
    templateStatuses: templateStatusesField.optional(),
    conversationStatuses: conversationStatusesField.optional(),
  })
  .strict()
  .refine((data) => !data.messageStatuses || data.events.includes('message.status'), {
    path: ['messageStatuses'],
    message: WEBHOOK_STATUSES_NEED_THE_EVENT,
  })
  .refine((data) => !data.contactParts || data.events.includes('contact.updated'), {
    path: ['contactParts'],
    message: WEBHOOK_PARTS_NEED_THE_EVENT,
  })
  .refine((data) => !data.automationIds || webhookTakesAutomationRuns(data.events), {
    path: ['automationIds'],
    message: WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.campaignStatuses || data.events.includes('campaign.status_changed'), {
    path: ['campaignStatuses'],
    message: WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT,
  })
  .refine((data) => !data.orderStatuses || data.events.includes('order.status_changed'), {
    path: ['orderStatuses'],
    message: WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT,
  })
  .refine((data) => !data.templateStatuses || data.events.includes('template.status_changed'), {
    path: ['templateStatuses'],
    message: WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT,
  })
  .refine(
    (data) => !data.conversationStatuses || data.events.includes('conversation.status_changed'),
    { path: ['conversationStatuses'], message: WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT },
  );

export const apiUpdateWebhookEndpointSchema = z
  .object({
    events: webhookEventTypesSchema.optional().describe('The events the endpoint receives.'),
    description: descriptionField
      .optional()
      .describe('A note for members, up to 200 characters; an empty text removes it.'),
    enabled: z
      .boolean()
      .optional()
      .describe(
        'false turns the endpoint off (its waiting deliveries fail); true turns it on again.',
      ),
    headers: headersField
      .optional()
      .describe(
        'Replaces the endpoint’s headers with these (all of them: values are never shown, so give each again); an empty list removes them. Left out, the headers stay.',
      ),
    messageStatuses: messageStatusesField
      .optional()
      .describe(
        'The message.status statuses the endpoint receives; null receives every status. Left out, they stay, unless the events no longer include message.status, which clears them.',
      ),
    contactParts: contactPartsField
      .optional()
      .describe(
        'The parts of a contact whose change the endpoint receives as contact.updated; null receives every change. Left out, they stay, unless the events no longer include contact.updated, which clears them.',
      ),
    automationIds: automationIdsField
      .optional()
      .describe(
        "The automations whose runs the endpoint receives (the company's published automations); null receives every automation's runs. Left out, they stay, unless the events no longer include automation.run_started or automation.run_ended, which clears them.",
      ),
    campaignStatuses: campaignStatusesField
      .optional()
      .describe(
        'The statuses a campaign reaches that the endpoint receives as campaign.status_changed; null receives every status. Left out, they stay, unless the events no longer include campaign.status_changed, which clears them.',
      ),
    orderStatuses: orderStatusesField
      .optional()
      .describe(
        'The statuses an order reaches that the endpoint receives as order.status_changed; null receives every status. Left out, they stay, unless the events no longer include order.status_changed, which clears them.',
      ),
    templateStatuses: templateStatusesField
      .optional()
      .describe(
        'The template statuses the endpoint receives as template.status_changed; null receives every status. Left out, they stay, unless the events no longer include template.status_changed, which clears them.',
      ),
    conversationStatuses: conversationStatusesField
      .optional()
      .describe(
        'The statuses a conversation reaches that the endpoint receives as conversation.status_changed; null receives every status. Left out, they stay, unless the events no longer include conversation.status_changed, which clears them.',
      ),
  })
  .strict()
  .refine(
    (data) =>
      data.events !== undefined ||
      data.description !== undefined ||
      data.enabled !== undefined ||
      data.headers !== undefined ||
      data.messageStatuses !== undefined ||
      data.contactParts !== undefined ||
      data.automationIds !== undefined ||
      data.campaignStatuses !== undefined ||
      data.orderStatuses !== undefined ||
      data.templateStatuses !== undefined ||
      data.conversationStatuses !== undefined,
    'Give the events, the description, the headers, the message statuses, the contact parts, the automations, the campaign statuses, the order statuses, the template statuses, the conversation statuses or whether the endpoint is enabled',
  );

export interface ApiWebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEventType[];
  status: 'active' | 'disabled';
  /** Why a disabled endpoint is off: turned off, or failing for 72 hours (ADR-053). */
  disabledReason: 'manual' | 'failing' | null;
  failingSince: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  secretVersion: number;
  /** Until when the previous secret also signs, after a rotation. */
  previousSecretExpiresAt: string | null;
  /** The endpoint's own headers, by name only (ADR-118): values are never shown. */
  headers: { name: string }[];
  /** The `message.status` statuses it receives (ADR-119); null receives every status. */
  messageStatuses: WebhookMessageStatus[] | null;
  /** The contact parts it receives as `contact.updated` (ADR-123); null receives every change. */
  contactParts: WebhookContactPart[] | null;
  /** The automations whose runs it receives (ADR-145); null receives every automation's runs. */
  automationIds: string[] | null;
  /** The campaign statuses it receives (ADR-146); null receives every status. */
  campaignStatuses: WebhookCampaignStatus[] | null;
  /** The order statuses it receives (ADR-147); null receives every status. */
  orderStatuses: WebhookOrderStatus[] | null;
  /** The template statuses it receives (ADR-148); null receives every status. */
  templateStatuses: WebhookTemplateStatus[] | null;
  /** The conversation statuses it receives (ADR-149); null receives every status. */
  conversationStatuses: WebhookConversationStatus[] | null;
  /** The key that added the endpoint. */
  apiKeyId: string;
  createdAt: string;
  updatedAt: string;
}

/** A delivery of an event to an endpoint a key added (ADR-083). */
export interface ApiWebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  /** The event's type, or `ping` for a test event. */
  eventType: string;
  status: WebhookDeliveryState;
  attempts: number;
  /** When the next attempt is due, while the delivery waits. */
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  deliveredAt: string | null;
  /** The delivery this one replays. */
  replayOf: string | null;
  createdAt: string;
}

/** Replaying an endpoint's failed deliveries (ADR-095). */
export const apiReplayFailedDeliveriesSchema = z
  .object({
    since: z.iso
      .datetime({
        offset: true,
        error: 'Give since as a date and time, such as 2026-09-30T08:00:00Z',
      })
      .describe(
        'Replay the failed deliveries queued at or after this time. Deliveries are kept 30 days.',
      ),
  })
  .strict();

export const apiWebhookDeliveryListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    status: z.enum(WEBHOOK_DELIVERY_STATES).optional().describe('Only deliveries in this state.'),
  })
  .strict();

function toApiDelivery(row: WebhookDeliveryView): ApiWebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.state === 'pending' ? row.nextAttemptAt.toISOString() : null,
    lastAttemptAt: iso(row.lastAttemptAt),
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    lastDurationMs: row.lastDurationMs,
    deliveredAt: iso(row.deliveredAt),
    replayOf: row.replayOf,
    createdAt: row.createdAt.toISOString(),
  };
}

const columns = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  description: webhookEndpoints.description,
  eventTypes: webhookEndpoints.eventTypes,
  state: webhookEndpoints.state,
  disabledReason: webhookEndpoints.disabledReason,
  failingSince: webhookEndpoints.failingSince,
  lastSuccessAt: webhookEndpoints.lastSuccessAt,
  lastFailureAt: webhookEndpoints.lastFailureAt,
  secretVersion: webhookEndpoints.secretVersion,
  previousSecretExpiresAt: webhookEndpoints.previousSecretExpiresAt,
  headerNames: webhookEndpoints.headerNames,
  messageStatuses: webhookEndpoints.messageStatuses,
  contactParts: webhookEndpoints.contactParts,
  automationIds: webhookEndpoints.automationIds,
  campaignStatuses: webhookEndpoints.campaignStatuses,
  orderStatuses: webhookEndpoints.orderStatuses,
  templateStatuses: webhookEndpoints.templateStatuses,
  conversationStatuses: webhookEndpoints.conversationStatuses,
  apiKeyId: webhookEndpoints.createdByApiKeyId,
  createdAt: webhookEndpoints.createdAt,
  updatedAt: webhookEndpoints.updatedAt,
};

type EndpointRow = Pick<
  typeof webhookEndpoints.$inferSelect,
  | 'id'
  | 'url'
  | 'description'
  | 'eventTypes'
  | 'state'
  | 'disabledReason'
  | 'failingSince'
  | 'lastSuccessAt'
  | 'lastFailureAt'
  | 'secretVersion'
  | 'previousSecretExpiresAt'
  | 'headerNames'
  | 'messageStatuses'
  | 'contactParts'
  | 'automationIds'
  | 'campaignStatuses'
  | 'orderStatuses'
  | 'templateStatuses'
  | 'conversationStatuses'
  | 'createdAt'
  | 'updatedAt'
> & { apiKeyId: string | null };

const iso = (at: Date | null) => at?.toISOString() ?? null;

function toApiEndpoint(row: EndpointRow, now: Date): ApiWebhookEndpoint {
  if (!row.apiKeyId) throw new Error('An endpoint a key added has no key');
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.eventTypes,
    status: row.state,
    disabledReason: row.disabledReason,
    failingSince: iso(row.failingSince),
    lastSuccessAt: iso(row.lastSuccessAt),
    lastFailureAt: iso(row.lastFailureAt),
    secretVersion: row.secretVersion,
    previousSecretExpiresAt:
      row.previousSecretExpiresAt && row.previousSecretExpiresAt > now
        ? row.previousSecretExpiresAt.toISOString()
        : null,
    headers: row.headerNames.map((name) => ({ name })),
    messageStatuses: row.messageStatuses,
    contactParts: row.contactParts,
    automationIds: row.automationIds,
    campaignStatuses: row.campaignStatuses,
    orderStatuses: row.orderStatuses,
    templateStatuses: row.templateStatuses,
    conversationStatuses: row.conversationStatuses,
    apiKeyId: row.apiKeyId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const addedByKey = (tenantId: string) =>
  and(eq(webhookEndpoints.tenantId, tenantId), isNotNull(webhookEndpoints.createdByApiKeyId));

async function readEndpoint(tx: Tx, ctx: ApiContext, id: string, now: Date) {
  const [row] = await tx
    .select(columns)
    .from(webhookEndpoints)
    .where(and(addedByKey(ctx.tenant.id), eq(webhookEndpoints.id, id)));
  if (!row) throw notFound('Webhook endpoint');
  return toApiEndpoint(row, now);
}

const endpointId = (id: string) => {
  if (!z.uuid().safeParse(id).success) throw notFound('Webhook endpoint');
  return id;
};

const invalidSince = (message: string) =>
  new AppError('validation_failed', message, { issues: [{ path: 'since', message }] });

const deliveryId = (id: string) => {
  if (!z.uuid().safeParse(id).success) throw notFound('Delivery');
  return id;
};

/** A delivery to an endpoint a key added; any other is not found. */
async function readDelivery(tx: Tx, ctx: ApiContext, id: string): Promise<ApiWebhookDelivery> {
  const [row] = await tx
    .select(webhookDeliveryColumns)
    .from(webhookDeliveries)
    .innerJoin(webhookEvents, deliveryEventJoin)
    .innerJoin(
      webhookEndpoints,
      and(
        eq(webhookEndpoints.tenantId, webhookDeliveries.tenantId),
        eq(webhookEndpoints.id, webhookDeliveries.endpointId),
      ),
    )
    .where(and(addedByKey(ctx.tenant.id), eq(webhookDeliveries.id, id)));
  if (!row) throw notFound('Delivery');
  return toApiDelivery(row);
}

/** The response kept for an `Idempotency-Key`: the same, without the secret (shown once). */
const withoutSecret = (body: Record<string, unknown>) => ({
  ...body,
  data: { ...(body.data as Record<string, unknown>), secret: null },
});

/** The email to owners and administrators when a key adds an endpoint, times in the company's zone. */
export function endpointAnnouncement(input: {
  keyName: string;
  keyPrefix: string;
  host: string;
  events: WebhookEventType[];
  at: Date;
  timeZone: string;
}): { subject: string; lines: string[] } {
  const events = input.events.map((event) => WEBHOOK_EVENT_INFO[event].label).join(', ');
  return {
    subject: 'Webhook endpoint added through the API',
    lines: [
      `The API key “${input.keyName}” (${input.keyPrefix}_…) added a webhook endpoint at ${input.host} on ${formatCompanyTime(input.at, input.timeZone)}. It receives: ${events}.`,
      'If you did not expect this, delete the endpoint in Settings, Webhooks, and revoke the key in Settings, API keys.',
    ],
  };
}

export interface ApiWebhookEndpointsDeps extends OutboxDeps {
  db: Database;
  clock: Clock;
  egressPolicy: Pick<EgressPolicy, 'allowLoopbackForTests'>;
  appBaseUrl: string;
}

export function createApiWebhookEndpoints(deps: ApiWebhookEndpointsDeps) {
  const { db, clock } = deps;

  /** Emails the company's owners and administrators that the request's key added an endpoint. */
  async function announce(
    tx: Tx,
    ctx: ApiContext,
    endpoint: { host: string; events: WebhookEventType[]; at: Date },
  ) {
    const [company] = await tx
      .select({ name: tenants.name, slug: tenants.slug, timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenant.id));
    const [key] = await tx
      .select({ name: apiKeys.name, keyPrefix: apiKeys.keyPrefix })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, ctx.key.id)));
    if (!company || !key) throw new Error('The company or the key of an API request is missing');
    const { subject, lines } = endpointAnnouncement({
      keyName: key.name,
      keyPrefix: key.keyPrefix,
      host: endpoint.host,
      events: endpoint.events,
      at: endpoint.at,
      timeZone: company.timezone,
    });
    for (const person of await deletionRecipients(tx, ctx.tenant.id)) {
      await enqueueEmail(deps, tx, {
        to: person.email,
        tenantId: ctx.tenant.id,
        payload: {
          kind: 'tenant.notice',
          companyName: company.name,
          subject,
          lines,
          url: `${deps.appBaseUrl}/c/${company.slug}/settings/webhooks`,
          actionLabel: 'Review webhooks',
        },
      });
    }
  }

  const audit = (
    tx: Tx,
    ctx: ApiContext,
    action: string,
    id: string,
    metadata: Record<string, unknown>,
  ) =>
    recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action,
        subjectType: 'webhook_endpoint',
        subjectId: id,
        metadata: { ...metadata, source: 'api' },
        correlationId: ctx.requestId,
      },
      apiActor(ctx),
    );

  return {
    /** GET /api/v1/webhook-endpoints: the endpoints keys added, oldest first. */
    async list(ctx: ApiContext): Promise<{ data: ApiWebhookEndpoint[] }> {
      assertScope(ctx, 'webhooks.manage');
      const now = clock.now();
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select(columns)
            .from(webhookEndpoints)
            .where(addedByKey(ctx.tenant.id))
            .orderBy(asc(webhookEndpoints.createdAt), asc(webhookEndpoints.id));
          return { data: rows.map((row) => toApiEndpoint(row, now)) };
        },
        { accessMode: 'read only' },
      );
    },

    /** GET /api/v1/webhook-endpoints/{id}. */
    async get(ctx: ApiContext, id: string): Promise<ApiWebhookEndpoint> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      return db.run(ctx.scope, (tx) => readEndpoint(tx, ctx, id, clock.now()), {
        accessMode: 'read only',
      });
    },

    /**
     * POST /api/v1/webhook-endpoints: a new endpoint, once per `Idempotency-Key`, with its secret
     * in the first response only. Owners and administrators are emailed about it.
     */
    async create(
      ctx: ApiContext,
      input: unknown,
      idempotency: IdempotencyInput,
    ): Promise<ApiResponse> {
      assertScope(ctx, 'webhooks.manage');
      const data = parseInput(apiCreateWebhookEndpointSchema, input);
      const { url, host } = checkedWebhookUrl(data.url, deps.egressPolicy);
      const now = clock.now();
      return db.run(ctx.scope, (tx) =>
        idempotent(
          tx,
          ctx,
          idempotency,
          now,
          async () => {
            const headers = data.headers ?? [];
            const messageStatuses = webhookMessageStatusesFor(
              data.events,
              data.messageStatuses,
              null,
            );
            const contactParts = webhookContactPartsFor(data.events, data.contactParts, null);
            const automationIds = webhookAutomationIdsFor(data.events, data.automationIds, null);
            await assertWebhookAutomations(tx, ctx.tenant.id, automationIds);
            const campaignStatuses = webhookCampaignStatusesFor(
              data.events,
              data.campaignStatuses,
              null,
            );
            const orderStatuses = webhookOrderStatusesFor(data.events, data.orderStatuses, null);
            const templateStatuses = webhookTemplateStatusesFor(
              data.events,
              data.templateStatuses,
              null,
            );
            const conversationStatuses = webhookConversationStatusesFor(
              data.events,
              data.conversationStatuses,
              null,
            );
            const { id, secret } = await insertWebhookEndpoint(tx, deps.keyring, ctx.tenant.id, {
              url,
              description: data.description || null,
              eventTypes: data.events,
              headers,
              messageStatuses,
              contactParts,
              automationIds,
              campaignStatuses,
              orderStatuses,
              templateStatuses,
              conversationStatuses,
              creator: { apiKeyId: ctx.key.id },
            });
            await audit(tx, ctx, 'webhook.endpoint_created', id, {
              host,
              eventTypes: data.events,
              ...(headers.length > 0 ? { headers: headers.map((h) => h.name) } : {}),
              ...(messageStatuses ? { messageStatuses } : {}),
              ...(contactParts ? { contactParts } : {}),
              ...(automationIds ? { automationIds } : {}),
              ...(campaignStatuses ? { campaignStatuses } : {}),
              ...(orderStatuses ? { orderStatuses } : {}),
              ...(templateStatuses ? { templateStatuses } : {}),
              ...(conversationStatuses ? { conversationStatuses } : {}),
            });
            await announce(tx, ctx, { host, events: data.events, at: now });
            const endpoint = await readEndpoint(tx, ctx, id, now);
            return { status: 201, body: { data: { ...endpoint, secret } } };
          },
          withoutSecret,
        ),
      );
    },

    /**
     * PATCH /api/v1/webhook-endpoints/{id}: its events, description or whether it is enabled. The
     * address cannot change: a new address is a new endpoint, announced to owners and admins.
     */
    async update(ctx: ApiContext, id: string, input: unknown): Promise<ApiWebhookEndpoint> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      const data = parseInput(apiUpdateWebhookEndpointSchema, input);
      const now = clock.now();
      return db.run(ctx.scope, async (tx) => {
        const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, id, 'no key update', {
          keysOnly: true,
        });
        const host = webhookHost(endpoint.url);
        const events = data.events ?? endpoint.eventTypes;
        if (data.messageStatuses && !events.includes('message.status')) throw invalidStatuses();
        if (data.contactParts && !events.includes('contact.updated')) throw invalidParts();
        if (data.automationIds && !webhookTakesAutomationRuns(events)) throw invalidAutomations();
        if (data.campaignStatuses && !events.includes('campaign.status_changed')) {
          throw invalidCampaignStatuses();
        }
        if (data.orderStatuses && !events.includes('order.status_changed')) {
          throw invalidOrderStatuses();
        }
        if (data.templateStatuses && !events.includes('template.status_changed')) {
          throw invalidTemplateStatuses();
        }
        if (data.conversationStatuses && !events.includes('conversation.status_changed')) {
          throw invalidConversationStatuses();
        }
        // Only a list given now is checked: the automations kept were checked when chosen.
        if (data.automationIds !== undefined) {
          await assertWebhookAutomations(tx, ctx.tenant.id, data.automationIds);
        }
        if (
          data.events !== undefined ||
          data.description !== undefined ||
          data.headers !== undefined ||
          data.messageStatuses !== undefined ||
          data.contactParts !== undefined ||
          data.automationIds !== undefined ||
          data.campaignStatuses !== undefined ||
          data.orderStatuses !== undefined ||
          data.templateStatuses !== undefined ||
          data.conversationStatuses !== undefined
        ) {
          const [changed] = await tx
            .update(webhookEndpoints)
            .set({
              ...(data.events !== undefined ? { eventTypes: data.events } : {}),
              ...(data.description !== undefined ? { description: data.description || null } : {}),
              ...(data.headers !== undefined
                ? sealWebhookHeaders(deps.keyring, ctx.tenant.id, id, data.headers)
                : {}),
              messageStatuses: webhookMessageStatusesFor(
                events,
                data.messageStatuses,
                endpoint.messageStatuses,
              ),
              contactParts: webhookContactPartsFor(
                events,
                data.contactParts,
                endpoint.contactParts,
              ),
              automationIds: webhookAutomationIdsFor(
                events,
                data.automationIds,
                endpoint.automationIds,
              ),
              campaignStatuses: webhookCampaignStatusesFor(
                events,
                data.campaignStatuses,
                endpoint.campaignStatuses,
              ),
              orderStatuses: webhookOrderStatusesFor(
                events,
                data.orderStatuses,
                endpoint.orderStatuses,
              ),
              templateStatuses: webhookTemplateStatusesFor(
                events,
                data.templateStatuses,
                endpoint.templateStatuses,
              ),
              conversationStatuses: webhookConversationStatusesFor(
                events,
                data.conversationStatuses,
                endpoint.conversationStatuses,
              ),
              updatedAt: now,
            })
            .where(and(eq(webhookEndpoints.tenantId, ctx.tenant.id), eq(webhookEndpoints.id, id)))
            .returning({
              eventTypes: webhookEndpoints.eventTypes,
              messageStatuses: webhookEndpoints.messageStatuses,
              contactParts: webhookEndpoints.contactParts,
              automationIds: webhookEndpoints.automationIds,
              campaignStatuses: webhookEndpoints.campaignStatuses,
              orderStatuses: webhookEndpoints.orderStatuses,
              templateStatuses: webhookEndpoints.templateStatuses,
              conversationStatuses: webhookEndpoints.conversationStatuses,
            });
          if (!changed) throw new Error('A locked endpoint was not updated');
          await audit(tx, ctx, 'webhook.endpoint_updated', id, {
            host,
            eventTypes: changed.eventTypes,
            ...(data.headers !== undefined ? { headers: data.headers.map((h) => h.name) } : {}),
            ...(changed.messageStatuses ? { messageStatuses: changed.messageStatuses } : {}),
            ...(changed.contactParts ? { contactParts: changed.contactParts } : {}),
            ...(changed.automationIds ? { automationIds: changed.automationIds } : {}),
            ...(changed.campaignStatuses ? { campaignStatuses: changed.campaignStatuses } : {}),
            ...(changed.orderStatuses ? { orderStatuses: changed.orderStatuses } : {}),
            ...(changed.templateStatuses ? { templateStatuses: changed.templateStatuses } : {}),
            ...(changed.conversationStatuses
              ? { conversationStatuses: changed.conversationStatuses }
              : {}),
          });
        }
        if (data.enabled !== undefined) {
          const { changed, failed } = await setWebhookEndpointEnabled(
            tx,
            ctx.tenant.id,
            endpoint,
            data.enabled,
            now,
          );
          if (changed) {
            await audit(
              tx,
              ctx,
              data.enabled ? 'webhook.endpoint_enabled' : 'webhook.endpoint_disabled',
              id,
              { host, pendingDeliveriesFailed: failed },
            );
          }
        }
        return readEndpoint(tx, ctx, id, now);
      });
    },

    /** DELETE /api/v1/webhook-endpoints/{id}: the endpoint and its delivery history. */
    async remove(ctx: ApiContext, id: string): Promise<void> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      await db.run(ctx.scope, async (tx) => {
        const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, id, 'update', {
          keysOnly: true,
        });
        await tx
          .delete(webhookEndpoints)
          .where(and(eq(webhookEndpoints.tenantId, ctx.tenant.id), eq(webhookEndpoints.id, id)));
        await audit(tx, ctx, 'webhook.endpoint_deleted', id, { host: webhookHost(endpoint.url) });
      });
    },

    /**
     * POST /api/v1/webhook-endpoints/{id}/rotate-secret: a new secret, once per `Idempotency-Key`
     * and in the first response only; the previous one also signs for 24 hours.
     */
    async rotateSecret(
      ctx: ApiContext,
      id: string,
      idempotency: IdempotencyInput,
    ): Promise<ApiResponse> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      const now = clock.now();
      return db.run(ctx.scope, (tx) =>
        idempotent(
          tx,
          ctx,
          idempotency,
          now,
          async () => {
            const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, id, 'no key update', {
              keysOnly: true,
            });
            const { secret, version } = await rotateWebhookEndpointSecret(
              tx,
              deps.keyring,
              ctx.tenant.id,
              endpoint,
              now,
            );
            await audit(tx, ctx, 'webhook.secret_rotated', id, {
              host: webhookHost(endpoint.url),
              secretVersion: version,
            });
            return {
              status: 200,
              body: { data: { ...(await readEndpoint(tx, ctx, id, now)), secret } },
            };
          },
          withoutSecret,
        ),
      );
    },

    /**
     * GET /api/v1/webhook-endpoints/{id}/deliveries: the endpoint's deliveries, newest first, on
     * exact keyset pages (ADR-083). Deliveries are kept 30 days.
     */
    async deliveries(
      ctx: ApiContext,
      id: string,
      query: unknown,
    ): Promise<{ data: ApiWebhookDelivery[]; nextCursor: string | null }> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      const q = parseInput(apiWebhookDeliveryListQuerySchema, query);
      const cursor = decodeKeysetCursor(q.cursor);
      const now = clock.now();
      return db.run(
        ctx.scope,
        async (tx) => {
          await readEndpoint(tx, ctx, id, now);
          const rows = await tx
            .select({
              ...webhookDeliveryColumns,
              cursorAt: exactTimestamp(webhookDeliveries.createdAt),
            })
            .from(webhookDeliveries)
            .innerJoin(webhookEvents, deliveryEventJoin)
            .where(
              and(
                eq(webhookDeliveries.tenantId, ctx.tenant.id),
                eq(webhookDeliveries.endpointId, id),
                q.status ? eq(webhookDeliveries.state, q.status) : undefined,
                cursor
                  ? sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
            .limit(q.limit + 1);
          const shown = rows.slice(0, q.limit);
          const last = shown.at(-1);
          return {
            data: shown.map(({ cursorAt: _cursorAt, ...row }) => toApiDelivery(row)),
            nextCursor:
              rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** GET /api/v1/webhook-deliveries/{id}: a delivery to an endpoint a key added (ADR-083). */
    async getDelivery(ctx: ApiContext, id: string): Promise<ApiWebhookDelivery> {
      assertScope(ctx, 'webhooks.manage');
      deliveryId(id);
      return db.run(ctx.scope, (tx) => readDelivery(tx, ctx, id), { accessMode: 'read only' });
    },

    /**
     * POST /api/v1/webhook-endpoints/{id}/test: a `ping` event for the endpoint, which must be on,
     * once per `Idempotency-Key` (ADR-083). Answered with its delivery, to follow with
     * GET /webhook-deliveries/{id}.
     */
    async sendTest(
      ctx: ApiContext,
      id: string,
      idempotency: IdempotencyInput,
    ): Promise<ApiResponse> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      const now = clock.now();
      return db.run(ctx.scope, (tx) =>
        idempotent(tx, ctx, idempotency, now, async () => {
          const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, id, 'no key update', {
            keysOnly: true,
          });
          const queued = await queueWebhookTest(tx, ctx.tenant.id, endpoint);
          return { status: 201, body: { data: await readDelivery(tx, ctx, queued.deliveryId) } };
        }),
      );
    },

    /**
     * POST /api/v1/webhook-deliveries/{id}/replay: the finished delivery's event again, as a new
     * delivery to the same endpoint, which must be on, once per `Idempotency-Key` (ADR-083).
     * Audited as the key, as a member's replay is.
     */
    async replay(ctx: ApiContext, id: string, idempotency: IdempotencyInput): Promise<ApiResponse> {
      assertScope(ctx, 'webhooks.manage');
      deliveryId(id);
      const now = clock.now();
      return db.run(ctx.scope, (tx) =>
        idempotent(tx, ctx, idempotency, now, async () => {
          const replayed = await replayWebhookDelivery(tx, ctx.tenant.id, id, { keysOnly: true });
          await audit(tx, ctx, 'webhook.delivery_replayed', replayed.endpoint.id, {
            host: webhookHost(replayed.endpoint.url),
            deliveryId: id,
            newDeliveryId: replayed.deliveryId,
          });
          return {
            status: 201,
            body: { data: await readDelivery(tx, ctx, replayed.deliveryId) },
          };
        }),
      );
    },

    /**
     * POST /api/v1/webhook-endpoints/{id}/replay-failed: every event whose deliveries to the
     * endpoint all failed since `since`, delivered again, at most 500 per call and once per
     * `Idempotency-Key` (ADR-095). Answered with how many were queued and whether more remain.
     * Audited as the key, once per call.
     */
    async replayFailed(
      ctx: ApiContext,
      id: string,
      input: unknown,
      idempotency: IdempotencyInput,
    ): Promise<ApiResponse> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      const { since } = parseInput(apiReplayFailedDeliveriesSchema, input);
      const now = clock.now();
      const from = new Date(since);
      if (from.getTime() > now.getTime()) {
        throw invalidSince('Give a time in the past.');
      }
      return db.run(ctx.scope, (tx) =>
        idempotent(tx, ctx, idempotency, now, async () => {
          const replayed = await replayFailedWebhookDeliveries(tx, ctx.tenant.id, id, from, {
            keysOnly: true,
          });
          await audit(tx, ctx, 'webhook.deliveries_replayed', id, {
            host: webhookHost(replayed.endpoint.url),
            since: from.toISOString(),
            queued: replayed.queued,
            more: replayed.more,
          });
          return {
            status: 200,
            body: { data: { queued: replayed.queued, more: replayed.more } },
          };
        }),
      );
    },
  };
}

export type ApiWebhookEndpoints = ReturnType<typeof createApiWebhookEndpoints>;
