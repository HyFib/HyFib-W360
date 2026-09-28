import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock, type Keyring } from '@w360/core';
import { EgressError, parseEgressUrl, type EgressPolicy } from '@w360/core/egress';
import {
  and,
  desc,
  eq,
  gt,
  sql,
  users,
  webhookDeliveries,
  webhookEndpoints,
  webhookEvents,
  type Database,
  type Tx,
  type WebhookDeliveryState,
  type WebhookEventType,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import { parseInput } from '../validation';
import { WEBHOOK_EVENT_KEYS, WEBHOOK_LIMITS, webhookHost } from './model';

/** Binds an endpoint's secret to its company, the endpoint and the secret's version. */
export const webhookSecretAad = (tenantId: string, endpointId: string, version: number) =>
  `webhook-secret:${tenantId}:${endpointId}:${version}`;

/** A new signing secret: `whsec_` and 32 random bytes. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

const eventTypesSchema = z
  .array(z.enum(WEBHOOK_EVENT_KEYS, { error: 'Choose events from the list' }))
  .min(1, 'Choose at least one event')
  .transform((chosen) => WEBHOOK_EVENT_KEYS.filter((e) => chosen.includes(e)));

const endpointSchema = z.object({
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
  eventTypes: eventTypesSchema,
});
const endpointIdSchema = z.object({ endpointId: z.uuid() });
const updateSchema = endpointSchema.extend({ endpointId: z.uuid() });
const enabledSchema = endpointIdSchema.extend({ enabled: z.boolean() });
const deliveryIdSchema = z.object({ deliveryId: z.uuid() });

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
  createdAt: Date;
  createdBy: string | null;
  /** Deliveries created in the last 24 hours, by state. */
  recent: Record<WebhookDeliveryState, number>;
}

export interface WebhookDeliveryView {
  id: string;
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

const invalidUrl = (message: string) =>
  new AppError('validation_failed', message, { issues: [{ path: 'url', message }] });

/** The URL as it will be called, after the egress guard's rules (https, no credentials, ports). */
function checkedUrl(raw: string, policy: Pick<EgressPolicy, 'allowLoopbackForTests'>) {
  let target: ReturnType<typeof parseEgressUrl>;
  try {
    target = parseEgressUrl(raw, policy);
  } catch (error) {
    if (error instanceof EgressError) throw invalidUrl(error.message);
    throw error;
  }
  target.url.hash = '';
  const url = target.url.toString();
  // Normalising (percent-encoding) can lengthen what was entered.
  if (url.length > WEBHOOK_LIMITS.urlLength) throw invalidUrl('The URL is too long');
  return { url, host: target.hostname };
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
 */
async function lockEndpoint(
  tx: Tx,
  tenantId: string,
  endpointId: string,
  strength: 'no key update' | 'update' = 'no key update',
) {
  const [endpoint] = await tx
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      state: webhookEndpoints.state,
      secretVersion: webhookEndpoints.secretVersion,
      secretCiphertext: webhookEndpoints.secretCiphertext,
    })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.id, endpointId)))
    .for(strength);
  if (!endpoint) throw notFound('Webhook endpoint');
  return endpoint;
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
              createdAt: webhookEndpoints.createdAt,
              createdBy: users.name,
            })
            .from(webhookEndpoints)
            .leftJoin(users, eq(users.id, webhookEndpoints.createdByUserId))
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
          return rows.map((r) => {
            const recent: Record<WebhookDeliveryState, number> = {
              pending: 0,
              delivering: 0,
              succeeded: 0,
              failed: 0,
            };
            for (const c of counts) if (c.endpointId === r.id) recent[c.state] = c.n;
            const previousSigns = r.previousSecretExpiresAt && r.previousSecretExpiresAt > now;
            return {
              ...r,
              previousSecretExpiresAt: previousSigns ? r.previousSecretExpiresAt : null,
              recent,
            };
          });
        },
        { accessMode: 'read only' },
      );
    },

    /** A new endpoint; its secret is returned once. */
    async create(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const data = parseInput(endpointSchema, input);
      const { url, host } = checkedUrl(data.url, deps.egressPolicy);
      const id = uuidv7();
      const secret = generateWebhookSecret();
      await db.run(ctx.scope, async (tx) => {
        await lockEndpoints(tx, ctx.tenant.id);
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.tenantId, ctx.tenant.id));
        if ((row?.n ?? 0) >= WEBHOOK_LIMITS.endpoints) {
          throw new AppError(
            'precondition_failed',
            `A company can have ${WEBHOOK_LIMITS.endpoints} webhook endpoints. Delete one first.`,
          );
        }
        await tx.insert(webhookEndpoints).values({
          id,
          tenantId: ctx.tenant.id,
          url,
          description: data.description || null,
          eventTypes: data.eventTypes,
          secretCiphertext: keyring.encrypt(secret, webhookSecretAad(ctx.tenant.id, id, 1)),
          createdByUserId: ctx.user.id,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'webhook.endpoint_created',
            subjectType: 'webhook_endpoint',
            subjectId: id,
            metadata: { host, eventTypes: data.eventTypes },
          },
          meta,
        );
      });
      return { id, secret };
    },

    async update(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const data = parseInput(updateSchema, input);
      const { url, host } = checkedUrl(data.url, deps.egressPolicy);
      await db.run(ctx.scope, async (tx) => {
        await lockEndpoint(tx, ctx.tenant.id, data.endpointId);
        await tx
          .update(webhookEndpoints)
          .set({
            url,
            description: data.description || null,
            eventTypes: data.eventTypes,
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
            metadata: { host, eventTypes: data.eventTypes },
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
        const endpoint = await lockEndpoint(tx, ctx.tenant.id, data.endpointId);
        if ((endpoint.state === 'active') === data.enabled) return;
        await tx
          .update(webhookEndpoints)
          .set(
            data.enabled
              ? {
                  state: 'active',
                  disabledReason: null,
                  disabledAt: null,
                  failingSince: null,
                  updatedAt: now,
                }
              : { state: 'disabled', disabledReason: 'manual', disabledAt: now, updatedAt: now },
          )
          .where(
            and(eq(webhookEndpoints.tenantId, ctx.tenant.id), eq(webhookEndpoints.id, endpoint.id)),
          );
        const failed = data.enabled
          ? 0
          : await failPendingDeliveries(tx, ctx.tenant.id, endpoint.id);
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

    /**
     * A new secret, returned once. The previous one keeps signing (a second `v1` signature) for 24
     * hours, so a receiver can switch without losing deliveries.
     */
    async rotateSecret(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const { endpointId } = parseInput(endpointIdSchema, input);
      const now = clock.now();
      const secret = generateWebhookSecret();
      await db.run(ctx.scope, async (tx) => {
        const endpoint = await lockEndpoint(tx, ctx.tenant.id, endpointId);
        const version = endpoint.secretVersion + 1;
        await tx
          .update(webhookEndpoints)
          .set({
            secretCiphertext: keyring.encrypt(
              secret,
              webhookSecretAad(ctx.tenant.id, endpointId, version),
            ),
            secretVersion: version,
            previousSecretCiphertext: endpoint.secretCiphertext,
            previousSecretExpiresAt: new Date(
              now.getTime() + WEBHOOK_LIMITS.previousSecretHours * 3_600_000,
            ),
            updatedAt: now,
          })
          .where(
            and(eq(webhookEndpoints.tenantId, ctx.tenant.id), eq(webhookEndpoints.id, endpointId)),
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
      });
      return { secret };
    },

    /** Deletes an endpoint and its delivery history. */
    async remove(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const { endpointId } = parseInput(endpointIdSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const endpoint = await lockEndpoint(tx, ctx.tenant.id, endpointId, 'update');
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
      const eventId = uuidv7();
      const deliveryId = uuidv7();
      await db.run(ctx.scope, async (tx) => {
        const endpoint = await lockEndpoint(tx, ctx.tenant.id, endpointId);
        if (endpoint.state !== 'active') {
          throw new AppError(
            'precondition_failed',
            'Turn the endpoint on to send it a test event.',
          );
        }
        await tx.insert(webhookEvents).values({
          id: eventId,
          tenantId: ctx.tenant.id,
          type: 'ping',
          detail: {},
        });
        await tx.insert(webhookDeliveries).values({
          id: deliveryId,
          tenantId: ctx.tenant.id,
          endpointId,
          eventId,
        });
      });
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
            .select({
              id: webhookDeliveries.id,
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
            })
            .from(webhookDeliveries)
            .innerJoin(
              webhookEvents,
              and(
                eq(webhookEvents.tenantId, webhookDeliveries.tenantId),
                eq(webhookEvents.id, webhookDeliveries.eventId),
              ),
            )
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
      const newId = uuidv7();
      await db.run(ctx.scope, async (tx) => {
        const [delivery] = await tx
          .select({
            endpointId: webhookDeliveries.endpointId,
            eventId: webhookDeliveries.eventId,
            state: webhookDeliveries.state,
          })
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.tenantId, ctx.tenant.id),
              eq(webhookDeliveries.id, deliveryId),
            ),
          );
        if (!delivery) throw notFound('Delivery');
        const endpoint = await lockEndpoint(tx, ctx.tenant.id, delivery.endpointId);
        if (!(['succeeded', 'failed'] as WebhookDeliveryState[]).includes(delivery.state)) {
          throw new AppError('conflict', 'This delivery is still being attempted.');
        }
        if (endpoint.state !== 'active') {
          throw new AppError('precondition_failed', 'Turn the endpoint on to replay deliveries.');
        }
        await tx.insert(webhookDeliveries).values({
          id: newId,
          tenantId: ctx.tenant.id,
          endpointId: delivery.endpointId,
          eventId: delivery.eventId,
          replayOf: deliveryId,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'webhook.delivery_replayed',
            subjectType: 'webhook_endpoint',
            subjectId: delivery.endpointId,
            metadata: { deliveryId, newDeliveryId: newId },
          },
          meta,
        );
      });
      return { deliveryId: newId };
    },
  };
}

export type WebhooksService = ReturnType<typeof createWebhooksService>;
