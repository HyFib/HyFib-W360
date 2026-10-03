import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock, type Keyring } from '@w360/core';
import { EgressError, parseEgressUrl, type EgressPolicy } from '@w360/core/egress';
import {
  and,
  apiKeys,
  desc,
  eq,
  gt,
  isNotNull,
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
import { assertRecentSignIn } from '../authz/step-up';
import { parseInput } from '../validation';
import {
  WEBHOOK_CONTACT_PARTS,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_LIMITS,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_REPLAY_PERIODS,
  webhookHost,
  type WebhookContactPart,
  type WebhookMessageStatus,
} from './model';

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

/** A new signing secret: `whsec_` and 32 random bytes. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export const webhookEventTypesSchema = z
  .array(z.enum(WEBHOOK_EVENT_KEYS, { error: 'Choose events from the list' }))
  .min(1, 'Choose at least one event')
  .transform((chosen) => WEBHOOK_EVENT_KEYS.filter((e) => chosen.includes(e)));

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
   * Given, the contact parts it takes as `contact.updated` (null: every change); left out, they
   * stay.
   */
  contactParts: webhookContactPartsSchema.optional(),
});
/** Statuses are chosen only for an endpoint that takes `message.status`. */
const statusesNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; messageStatuses?: unknown }) =>
    !data.messageStatuses || data.eventTypes.includes('message.status'),
  options: { path: ['messageStatuses'], message: WEBHOOK_STATUSES_NEED_THE_EVENT },
};
/** Contact parts are chosen only for an endpoint that takes `contact.updated` (ADR-123). */
const partsNeedTheEvent = {
  check: (data: { eventTypes: WebhookEventType[]; contactParts?: unknown }) =>
    !data.contactParts || data.eventTypes.includes('contact.updated'),
  options: { path: ['contactParts'], message: WEBHOOK_PARTS_NEED_THE_EVENT },
};
const endpointSchema = endpointFields
  .refine(statusesNeedTheEvent.check, statusesNeedTheEvent.options)
  .refine(partsNeedTheEvent.check, partsNeedTheEvent.options);
const endpointIdSchema = z.object({ endpointId: z.uuid() });
const updateSchema = endpointFields
  .extend({ endpointId: z.uuid() })
  .refine(statusesNeedTheEvent.check, statusesNeedTheEvent.options)
  .refine(partsNeedTheEvent.check, partsNeedTheEvent.options);
const enabledSchema = endpointIdSchema.extend({ enabled: z.boolean() });
const deliveryIdSchema = z.object({ deliveryId: z.uuid() });
const replayFailedSchema = endpointIdSchema.extend({
  period: z.enum(
    WEBHOOK_REPLAY_PERIODS.map((p) => p.key),
    { error: 'Choose a period from the list' },
  ),
});

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
  /** The contact parts it takes as `contact.updated` (ADR-123); null takes every change. */
  contactParts: WebhookContactPart[] | null;
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

const invalidUrl = (message: string) =>
  new AppError('validation_failed', message, { issues: [{ path: 'url', message }] });

/** The URL as it will be called, after the egress guard's rules (https, no credentials, ports). */
export function checkedWebhookUrl(
  raw: string,
  policy: Pick<EgressPolicy, 'allowLoopbackForTests'>,
) {
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
      contactParts: webhookEndpoints.contactParts,
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
    contactParts: WebhookContactPart[] | null;
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
    contactParts: input.contactParts,
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
 * (ADR-083).
 */
export async function replayFailedWebhookDeliveries(
  tx: Tx,
  tenantId: string,
  endpointId: string,
  since: Date,
  options: { keysOnly?: boolean } = {},
): Promise<WebhookFailedReplay & { endpoint: LockedWebhookEndpoint }> {
  const endpoint = await lockWebhookEndpoint(tx, tenantId, endpointId, 'no key update', options);
  if (endpoint.state !== 'active') {
    throw new AppError('precondition_failed', 'Turn the endpoint on to replay deliveries.');
  }
  const failed = await tx.execute<{ id: string; event_id: string }>(sql`
    select f.id, f.event_id
      from (
        select distinct on (d.event_id) d.id, d.event_id, d.last_error
          from app.webhook_deliveries d
         where d.tenant_id = ${tenantId} and d.endpoint_id = ${endpointId}
           and d.state = 'failed' and d.created_at >= ${since.toISOString()}::timestamptz
         order by d.event_id, d.created_at desc, d.id desc
      ) f
      join app.webhook_events e on e.tenant_id = ${tenantId} and e.id = f.event_id
     where f.last_error is distinct from 'event_gone'
       and e.type <> 'ping'
       and not exists (
         select 1 from app.webhook_deliveries o
          where o.tenant_id = ${tenantId} and o.event_id = f.event_id
            and o.endpoint_id = ${endpointId} and o.state <> 'failed')
     order by e.created_at, e.id
     limit ${WEBHOOK_LIMITS.replayBatch + 1}`);
  const replayed = failed.rows.slice(0, WEBHOOK_LIMITS.replayBatch);
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
  return {
    endpoint,
    queued: replayed.length,
    more: failed.rows.length > WEBHOOK_LIMITS.replayBatch,
  };
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
              contactParts: webhookEndpoints.contactParts,
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
          return rows.map((r) => {
            const recent: Record<WebhookDeliveryState, number> = {
              pending: 0,
              delivering: 0,
              succeeded: 0,
              failed: 0,
            };
            for (const c of counts) if (c.endpointId === r.id) recent[c.state] = c.n;
            const previousSigns = r.previousSecretExpiresAt && r.previousSecretExpiresAt > now;
            const { keyName, keyPrefix, ...endpoint } = r;
            return {
              ...endpoint,
              createdByKey: keyName && keyPrefix ? { name: keyName, keyPrefix } : null,
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
        const contactParts = webhookContactPartsFor(data.eventTypes, data.contactParts, null);
        const { id, secret } = await insertWebhookEndpoint(tx, keyring, ctx.tenant.id, {
          url,
          description: data.description || null,
          eventTypes: data.eventTypes,
          headers,
          messageStatuses,
          contactParts,
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
              ...(contactParts ? { contactParts } : {}),
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
        const contactParts = webhookContactPartsFor(
          data.eventTypes,
          data.contactParts,
          endpoint.contactParts,
        );
        await tx
          .update(webhookEndpoints)
          .set({
            url,
            description: data.description || null,
            eventTypes: data.eventTypes,
            messageStatuses,
            contactParts,
            ...(data.headers
              ? sealWebhookHeaders(keyring, ctx.tenant.id, data.endpointId, data.headers)
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
              ...(contactParts ? { contactParts } : {}),
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
     * period, 500 at most per call (ADR-095). Audited once, with the count.
     */
    async replayFailed(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<WebhookFailedReplay> {
      assertCan(ctx, 'developer.manage');
      const { endpointId, period } = parseInput(replayFailedSchema, input);
      const hours = WEBHOOK_REPLAY_PERIODS.find((p) => p.key === period)?.hours ?? 1;
      const since = new Date(clock.now().getTime() - hours * 3_600_000);
      return db.run(ctx.scope, async (tx) => {
        const replayed = await replayFailedWebhookDeliveries(tx, ctx.tenant.id, endpointId, since);
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
              queued: replayed.queued,
              more: replayed.more,
            },
          },
          meta,
        );
        return { queued: replayed.queued, more: replayed.more };
      });
    },
  };
}

export type WebhooksService = ReturnType<typeof createWebhooksService>;
