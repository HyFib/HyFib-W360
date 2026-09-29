import { z } from 'zod';
import { notFound, type Clock } from '@w360/core';
import type { EgressPolicy } from '@w360/core/egress';
import {
  and,
  apiKeys,
  asc,
  eq,
  isNotNull,
  tenants,
  webhookEndpoints,
  type Database,
  type Tx,
  type WebhookEventType,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { deletionRecipients, formatCompanyTime } from '../tenancy/deletion';
import { parseInput } from '../validation';
import { WEBHOOK_EVENT_INFO, WEBHOOK_LIMITS, webhookHost } from '../webhooks/model';
import {
  checkedWebhookUrl,
  insertWebhookEndpoint,
  lockWebhookEndpoint,
  rotateWebhookEndpointSecret,
  setWebhookEndpointEnabled,
  webhookEventTypesSchema,
} from '../webhooks/service';
import { apiActor, assertScope, type ApiContext } from './context';
import type { ApiResponse, IdempotencyInput } from './idempotency';
import { idempotent } from './resources';

/**
 * Webhook endpoints through the public API (ADR-081): a `webhooks.manage` key adds endpoints and
 * reads, changes, rotates the secret of and deletes the endpoints keys added. Endpoints members
 * added in settings are not found: their addresses can carry a receiver's own token, and they stay
 * under members' control. Settings → Webhooks shows every endpoint, whoever added it.
 */

const descriptionField = z
  .string()
  .trim()
  .max(WEBHOOK_LIMITS.descriptionLength, 'Keep the description under 200 characters');

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
  })
  .strict();

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
  })
  .strict()
  .refine(
    (data) =>
      data.events !== undefined || data.description !== undefined || data.enabled !== undefined,
    'Give the events, the description or whether the endpoint is enabled',
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
  /** The key that added the endpoint. */
  apiKeyId: string;
  createdAt: string;
  updatedAt: string;
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
            const { id, secret } = await insertWebhookEndpoint(tx, deps.keyring, ctx.tenant.id, {
              url,
              description: data.description || null,
              eventTypes: data.events,
              creator: { apiKeyId: ctx.key.id },
            });
            await audit(tx, ctx, 'webhook.endpoint_created', id, {
              host,
              eventTypes: data.events,
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
        if (data.events !== undefined || data.description !== undefined) {
          const [changed] = await tx
            .update(webhookEndpoints)
            .set({
              ...(data.events !== undefined ? { eventTypes: data.events } : {}),
              ...(data.description !== undefined ? { description: data.description || null } : {}),
              updatedAt: now,
            })
            .where(and(eq(webhookEndpoints.tenantId, ctx.tenant.id), eq(webhookEndpoints.id, id)))
            .returning({ eventTypes: webhookEndpoints.eventTypes });
          if (!changed) throw new Error('A locked endpoint was not updated');
          await audit(tx, ctx, 'webhook.endpoint_updated', id, {
            host,
            eventTypes: changed.eventTypes,
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
  };
}

export type ApiWebhookEndpoints = ReturnType<typeof createApiWebhookEndpoints>;
