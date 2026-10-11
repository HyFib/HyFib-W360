import { errorClassAndCode, toError, type Clock, type Keyring } from '@w360/core';
import { EgressError, type EgressClient } from '@w360/core/egress';
import { QUEUES } from '@w360/contracts';
import {
  and,
  asc,
  eq,
  exactTimestamp,
  inArray,
  lt,
  lte,
  memberships,
  sql,
  systemScope,
  tenants,
  users,
  webhookDeliveries,
  webhookEndpoints,
  webhookEvents,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { WEBHOOK_LIMITS, webhookHost, webhookRetryDelaySeconds } from './model';
import {
  fetchWebhookOAuthToken,
  type WebhookOAuthClient,
  type WebhookOAuthTokenCache,
} from './oauth';
import { buildWebhookPayload, WebhookEventGoneError } from './payloads';
import {
  failPendingDeliveries,
  openWebhookHeaders,
  openWebhookOAuthClient,
  webhookSecretAad,
} from './service';
import { webhookSignatureHeader } from './signing';

/**
 * Delivering webhooks (queue `webhook.deliver`, ADR-053). A job delivers one company's due
 * deliveries in batches: a batch is claimed under row locks with a lease, each payload is built
 * from the company's current data and signed, the requests go out through the egress client with
 * no transaction open, and each outcome is recorded in its own transaction. A delivery whose lease
 * expired (the worker was lost during the request) is attempted again, so a receiver can get an
 * event twice and deduplicates on its id: delivery is at least once, never exactly once. A delivery
 * whose payload or signature cannot be built fails alone (`payload_failed`) and the batch goes on.
 * An endpoint with an OAuth client (ADR-173) gets an access token before its deliveries are sent,
 * also with no transaction open.
 */

export const WEBHOOK_USER_AGENT = 'HyFib-W360-Webhooks/1';

/** Headroom over the egress deadline before an attempt still in progress counts as interrupted. */
const LEASE_MARGIN_MS = 35_000;
/** Deliveries claimed and sent together. */
const BATCH_SIZE = 10;
/**
 * A job hands over to a successor after this many deliveries, attempted or ended at their claim, so
 * one company cannot hold a worker.
 */
const JOB_DELIVERY_BUDGET = 200;

export interface WebhookNoticeDeps {
  outbox: OutboxDeps;
  appBaseUrl: string;
}

export interface WebhookDispatchDeps {
  db: Database;
  jobs: JobQueue;
  signer: JobSigner;
}

/** The worker's logger, as far as the delivery job uses it. */
export interface WebhookDeliveryLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

export interface WebhookDeliveryDeps extends WebhookDispatchDeps {
  clock: Clock;
  keyring: Keyring;
  egress: EgressClient;
  /** The egress deadline; the lease covers it plus a margin. */
  timeoutMs: number;
  notices: WebhookNoticeDeps;
  /** Hears of each delivery that could not be prepared, by ids and the error's class and code. */
  logger: WebhookDeliveryLogger;
  /** The process's OAuth access tokens (ADR-173), kept in memory across jobs. */
  oauthTokens: WebhookOAuthTokenCache;
}

interface ClaimedDelivery {
  id: string;
  endpointId: string;
  attempt: number;
  url: string;
  headers: Record<string, string>;
  body: string;
  /** The endpoint's OAuth client, its secret opened (ADR-173); null without one. */
  oauth: WebhookOAuthClient | null;
}

/** A delivery that failed at its claim because it could not be prepared (`payload_failed`). */
interface UnpreparedDelivery {
  deliveryId: string;
  endpointId: string;
  eventType: string;
  /**
   * What failed: building the payload, signing it with the endpoint's secrets, or opening the
   * endpoint's own headers (ADR-118) or its OAuth client (ADR-173).
   */
  stage: 'payload' | 'signature' | 'headers' | 'oauth';
  errorClass: string;
  errorCode: string | null;
}

interface AttemptOutcome {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
}

export interface WebhookDeliveryRun {
  /** Requests made (each one's outcome recorded). */
  attempted: number;
  succeeded: number;
  /** Failed attempts with another attempt scheduled. */
  retrying: number;
  /** Deliveries that failed for good, with or without an attempt in this run. */
  failed: number;
  /** Whether a successor job was queued because the budget ran out. */
  handedOver: boolean;
}

/** Wakes a company's delivery job (one queued and one active per company, policy `stately`). */
export async function signalWebhookDelivery(
  deps: Pick<WebhookDispatchDeps, 'jobs' | 'signer'>,
  tenantId: string,
): Promise<void> {
  await deps.jobs.enqueue(
    null,
    QUEUES.webhookDeliver.name,
    deps.signer.sign({ kind: 'webhook.deliver', tenantId, actorUserId: null, ref: 'deliver' }),
    { singletonKey: tenantId },
  );
}

/**
 * Active companies with deliveries due now: new ones, retries and interrupted attempts. The ids
 * come from the database (a SECURITY DEFINER query), never from a notification or a payload.
 */
export async function findWebhookDispatchDue(db: Database, limit = 500): Promise<string[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string }>(
        sql`select tenant_id from ops.webhook_dispatch_due(${limit})`,
      );
      return res.rows.map((r) => r.tenant_id);
    },
    { accessMode: 'read only' },
  );
}

/** Wakes the delivery job of every company with due deliveries; returns how many were woken. */
export async function dispatchDueWebhooks(deps: WebhookDispatchDeps, limit = 500): Promise<number> {
  const due = await findWebhookDispatchDue(deps.db, limit);
  for (const tenantId of due) await signalWebhookDelivery(deps, tenantId);
  return due.length;
}

/** Deletes events and deliveries past their 30 days (the retention sweep); returns rows deleted. */
export async function purgeWebhookData(db: Database, limit = 5_000): Promise<number> {
  return db.run(systemScope, async (tx) => {
    const res = await tx.execute<{ purged: number }>(
      sql`select ops.purge_webhook_data(${limit}) as purged`,
    );
    return Number(res.rows[0]?.purged ?? 0);
  });
}

/**
 * Delivers the company's due deliveries until none is left or the job's budget is spent (then a
 * successor job is queued). Scope: an authorized company scope from the signed job.
 */
export async function processWebhookDeliveries(
  deps: WebhookDeliveryDeps,
  scope: TenantScope,
): Promise<WebhookDeliveryRun> {
  const run: WebhookDeliveryRun = {
    attempted: 0,
    succeeded: 0,
    retrying: 0,
    failed: 0,
    handedOver: false,
  };
  // Deliveries ended at their claim count toward the budget, though not as attempts: a backlog that
  // cannot be built (`payload_failed`) hands over like one that is attempted.
  let ended = 0;
  while (run.attempted + ended < JOB_DELIVERY_BUDGET) {
    const batch = await claimDeliveries(deps, scope, BATCH_SIZE);
    run.failed += batch.ended;
    ended += batch.ended;
    // Logged once the claim that ended them committed: ids and the error's class and code only.
    for (const unprepared of batch.unprepared) {
      deps.logger.error(
        { tenantId: scope.tenantId, ...unprepared },
        'webhook delivery could not be prepared; failed as payload_failed',
      );
    }
    if (batch.claimed.length === 0) {
      // Deliveries that ended without an attempt may have filled the batch: look again.
      if (batch.ended === 0) return run;
      continue;
    }
    // The requests, with no transaction open. Every outcome is recorded before an unexpected error
    // (a bug, not a failed request) is raised; its delivery is then attempted again after its lease.
    const settled = await Promise.allSettled(
      batch.claimed.map((delivery) => sendDelivery(deps, scope.tenantId, delivery)),
    );
    let unexpected: unknown = null;
    for (const [index, result] of settled.entries()) {
      const delivery = batch.claimed[index];
      if (!delivery) continue;
      if (result.status === 'rejected') {
        unexpected ??= result.reason;
        continue;
      }
      const recorded = await recordOutcome(deps, scope, delivery, result.value);
      run.attempted += 1;
      if (recorded !== 'stale') run[recorded] += 1;
    }
    if (unexpected !== null) throw toError(unexpected);
  }
  await signalWebhookDelivery(deps, scope.tenantId);
  run.handedOver = true;
  return run;
}

const DELIVERY_COLUMNS = {
  id: webhookDeliveries.id,
  endpointId: webhookDeliveries.endpointId,
  eventId: webhookDeliveries.eventId,
  attempts: webhookDeliveries.attempts,
};

/**
 * Claims up to `limit` due deliveries (skipping rows another transaction holds) and prepares each
 * request. A delivery that cannot be attempted ends here: its endpoint was turned off, its message
 * no longer exists, its last attempt was interrupted with no attempt left, or its payload or
 * signature could not be built (returned in `unprepared`, for the log).
 */
async function claimDeliveries(
  deps: WebhookDeliveryDeps,
  scope: TenantScope,
  limit: number,
): Promise<{ claimed: ClaimedDelivery[]; ended: number; unprepared: UnpreparedDelivery[] }> {
  const tenantId = scope.tenantId;
  return deps.db.run(scope, async (tx) => {
    const now = deps.clock.now();
    const pending = await tx
      .select(DELIVERY_COLUMNS)
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.tenantId, tenantId),
          eq(webhookDeliveries.state, 'pending'),
          lte(webhookDeliveries.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    // Attempts whose lease expired: the worker making them was lost, and the outcome is unknown.
    const interrupted =
      pending.length < limit
        ? await tx
            .select(DELIVERY_COLUMNS)
            .from(webhookDeliveries)
            .where(
              and(
                eq(webhookDeliveries.tenantId, tenantId),
                eq(webhookDeliveries.state, 'delivering'),
                lt(webhookDeliveries.leaseUntil, now),
              ),
            )
            .orderBy(asc(webhookDeliveries.leaseUntil), asc(webhookDeliveries.id))
            .limit(limit - pending.length)
            .for('update', { skipLocked: true })
        : [];
    const due = [...pending, ...interrupted];
    if (due.length === 0) return { claimed: [], ended: 0, unprepared: [] };

    const endpoints = new Map(
      (
        await tx
          .select({
            id: webhookEndpoints.id,
            url: webhookEndpoints.url,
            state: webhookEndpoints.state,
            secretCiphertext: webhookEndpoints.secretCiphertext,
            secretVersion: webhookEndpoints.secretVersion,
            previousSecretCiphertext: webhookEndpoints.previousSecretCiphertext,
            previousSecretExpiresAt: webhookEndpoints.previousSecretExpiresAt,
            headersCiphertext: webhookEndpoints.headersCiphertext,
            oauthTokenUrl: webhookEndpoints.oauthTokenUrl,
            oauthClientId: webhookEndpoints.oauthClientId,
            oauthClientSecretCiphertext: webhookEndpoints.oauthClientSecretCiphertext,
            oauthScope: webhookEndpoints.oauthScope,
            oauthClientAuth: webhookEndpoints.oauthClientAuth,
            oauthPrivateKeyCiphertext: webhookEndpoints.oauthPrivateKeyCiphertext,
            oauthPublicKey: webhookEndpoints.oauthPublicKey,
            oauthAssertionAudience: webhookEndpoints.oauthAssertionAudience,
          })
          .from(webhookEndpoints)
          .where(
            and(
              eq(webhookEndpoints.tenantId, tenantId),
              inArray(webhookEndpoints.id, [...new Set(due.map((d) => d.endpointId))]),
            ),
          )
      ).map((e) => [e.id, e]),
    );
    const events = new Map(
      (
        await tx
          .select({
            id: webhookEvents.id,
            tenantId: webhookEvents.tenantId,
            type: webhookEvents.type,
            messageId: webhookEvents.messageId,
            conversationId: webhookEvents.conversationId,
            contactId: webhookEvents.contactId,
            templateId: webhookEvents.templateId,
            status: webhookEvents.status,
            detail: webhookEvents.detail,
            contactChanges: webhookEvents.contactChanges,
            tagsAdded: webhookEvents.tagsAdded,
            tagsRemoved: webhookEvents.tagsRemoved,
            occurredAt: webhookEvents.occurredAt,
            occurredAtExact: exactTimestamp(webhookEvents.occurredAt),
          })
          .from(webhookEvents)
          .where(
            and(
              eq(webhookEvents.tenantId, tenantId),
              inArray(webhookEvents.id, [...new Set(due.map((d) => d.eventId))]),
            ),
          )
      ).map((e) => [e.id, e]),
    );

    const secrets = new Map<string, string[]>();
    const signingSecrets = (endpoint: NonNullable<ReturnType<typeof endpoints.get>>) => {
      const known = secrets.get(endpoint.id);
      if (known) return known;
      const list = [
        deps.keyring.decryptString(
          endpoint.secretCiphertext,
          webhookSecretAad(tenantId, endpoint.id, endpoint.secretVersion),
        ),
      ];
      // For 24 hours after a rotation the previous secret signs too.
      if (
        endpoint.previousSecretCiphertext &&
        endpoint.previousSecretExpiresAt &&
        endpoint.previousSecretExpiresAt > now
      ) {
        list.push(
          deps.keyring.decryptString(
            endpoint.previousSecretCiphertext,
            webhookSecretAad(tenantId, endpoint.id, endpoint.secretVersion - 1),
          ),
        );
      }
      secrets.set(endpoint.id, list);
      return list;
    };

    // The endpoint's own headers (ADR-118), opened once per endpoint and batch.
    const ownHeaders = new Map<string, Record<string, string>>();
    const endpointHeaders = (endpoint: NonNullable<ReturnType<typeof endpoints.get>>) => {
      const known = ownHeaders.get(endpoint.id);
      if (known) return known;
      const opened = openWebhookHeaders(
        deps.keyring,
        tenantId,
        endpoint.id,
        endpoint.headersCiphertext,
      );
      ownHeaders.set(endpoint.id, opened);
      return opened;
    };

    // The endpoint's OAuth client (ADR-173), opened once per endpoint and batch.
    const oauthClients = new Map<string, WebhookOAuthClient | null>();
    const endpointOAuth = (endpoint: NonNullable<ReturnType<typeof endpoints.get>>) => {
      if (oauthClients.has(endpoint.id)) return oauthClients.get(endpoint.id) ?? null;
      const opened = openWebhookOAuthClient(deps.keyring, tenantId, endpoint.id, endpoint);
      oauthClients.set(endpoint.id, opened);
      return opened;
    };

    const claimed: ClaimedDelivery[] = [];
    const unprepared: UnpreparedDelivery[] = [];
    let ended = 0;
    const end = async (deliveryId: string, error: string) => {
      await tx
        .update(webhookDeliveries)
        .set({ state: 'failed', lastError: error, leaseUntil: null })
        .where(and(eq(webhookDeliveries.tenantId, tenantId), eq(webhookDeliveries.id, deliveryId)));
      ended += 1;
    };
    const leaseUntil = new Date(now.getTime() + deps.timeoutMs + LEASE_MARGIN_MS);
    // A token request may come first, with its own deadline (ADR-173).
    const oauthLeaseUntil = new Date(leaseUntil.getTime() + deps.timeoutMs);
    const timestamp = Math.floor(now.getTime() / 1000);

    for (const delivery of due) {
      const endpoint = endpoints.get(delivery.endpointId);
      const event = events.get(delivery.eventId);
      if (!endpoint || endpoint.state !== 'active') {
        await end(delivery.id, 'endpoint_disabled');
        continue;
      }
      if (delivery.attempts >= WEBHOOK_LIMITS.attempts) {
        await end(delivery.id, 'interrupted');
        continue;
      }
      if (!event) {
        await end(delivery.id, 'event_gone');
        continue;
      }
      let body: string;
      let signature: string;
      let headers: Record<string, string>;
      let oauth: WebhookOAuthClient | null;
      let stage: UnpreparedDelivery['stage'] = 'payload';
      try {
        // In a savepoint, so that a database error while building leaves the claim usable.
        const payload = await tx.transaction((sp) => buildWebhookPayload(sp, event, endpoint.id));
        body = JSON.stringify(payload);
        stage = 'signature';
        signature = webhookSignatureHeader(signingSecrets(endpoint), timestamp, body);
        stage = 'headers';
        headers = endpointHeaders(endpoint);
        stage = 'oauth';
        oauth = endpointOAuth(endpoint);
      } catch (error) {
        if (error instanceof WebhookEventGoneError) {
          await end(delivery.id, 'event_gone');
          continue;
        }
        // A bug, data the builder cannot describe, a secret, headers or an OAuth client the keyring
        // cannot open, or a database error. Thrown, it would roll back the batch, and the sweep would
        // claim the same deliveries again every minute; ended without an attempt, it is replayed
        // once fixed.
        await end(delivery.id, 'payload_failed');
        unprepared.push({
          deliveryId: delivery.id,
          endpointId: endpoint.id,
          eventType: event.type,
          stage,
          ...errorClassAndCode(error),
        });
        continue;
      }
      const attempt = delivery.attempts + 1;
      await tx
        .update(webhookDeliveries)
        .set({
          state: 'delivering',
          attempts: attempt,
          leaseUntil: oauth ? oauthLeaseUntil : leaseUntil,
          lastAttemptAt: now,
        })
        .where(
          and(eq(webhookDeliveries.tenantId, tenantId), eq(webhookDeliveries.id, delivery.id)),
        );
      claimed.push({
        id: delivery.id,
        endpointId: endpoint.id,
        attempt,
        url: endpoint.url,
        body,
        oauth,
        headers: {
          // The endpoint's own first, so none of them can replace HyFib's.
          ...headers,
          'content-type': 'application/json',
          'user-agent': WEBHOOK_USER_AGENT,
          'w360-signature': signature,
          'w360-event-id': event.id,
          'w360-event-type': event.type,
          'w360-delivery-id': delivery.id,
          'w360-delivery-attempt': String(attempt),
        },
      });
    }
    return { claimed, ended, unprepared };
  });
}

/**
 * Sends a claimed delivery. With an OAuth client (ADR-173), a bearer token first: the one the process
 * keeps, the one being asked for another delivery, or one asked for now. Without a token the attempt
 * fails, with the token request's error and no status, as the endpoint was not called; a token the
 * endpoint answers 401 to is dropped, so the next attempt asks for a new one.
 */
async function sendDelivery(
  deps: WebhookDeliveryDeps,
  tenantId: string,
  delivery: ClaimedDelivery,
): Promise<AttemptOutcome> {
  const client = delivery.oauth;
  if (!client) return attemptDelivery(deps.egress, delivery);
  const started = performance.now();
  const owner = { tenantId, endpointId: delivery.endpointId };
  const got = await deps.oauthTokens.token(owner, client, deps.clock.now(), () =>
    fetchWebhookOAuthToken(deps.egress, client, WEBHOOK_USER_AGENT, () => deps.clock.now()),
  );
  if (!got.ok) {
    return {
      ok: false,
      statusCode: null,
      error: got.error,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }
  const outcome = await attemptDelivery(deps.egress, {
    ...delivery,
    // After the endpoint's own headers, which cannot hold one (the services refuse it).
    headers: { ...delivery.headers, authorization: `Bearer ${got.token.accessToken}` },
  });
  if (outcome.statusCode === 401) deps.oauthTokens.drop(owner, got.token.accessToken);
  return outcome;
}

/** One POST through the egress client: a 2xx answer succeeds; anything else is a failed attempt. */
async function attemptDelivery(
  egress: EgressClient,
  delivery: Pick<ClaimedDelivery, 'url' | 'headers' | 'body'>,
): Promise<AttemptOutcome> {
  const started = performance.now();
  try {
    const response = await egress.request({
      method: 'POST',
      url: delivery.url,
      headers: delivery.headers,
      body: delivery.body,
    });
    // The body is read up to the egress limit and discarded.
    const valid = response.status >= 100 && response.status <= 599;
    return {
      ok: response.status >= 200 && response.status <= 299,
      statusCode: valid ? response.status : null,
      error: valid ? null : 'invalid_status',
      durationMs: Math.max(0, Math.round(response.durationMs)),
    };
  } catch (error) {
    if (!(error instanceof EgressError)) throw error;
    return {
      ok: false,
      statusCode: null,
      error: error.code,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }
}

/**
 * Records an attempt's outcome and the endpoint's health. Locks the endpoint, then the delivery (the
 * order every writer uses). An outcome whose attempt no longer owns the delivery (its lease expired
 * and a newer attempt claimed it, or the endpoint was deleted) is not recorded.
 */
async function recordOutcome(
  deps: WebhookDeliveryDeps,
  scope: TenantScope,
  delivery: ClaimedDelivery,
  outcome: AttemptOutcome,
): Promise<'succeeded' | 'retrying' | 'failed' | 'stale'> {
  const tenantId = scope.tenantId;
  return deps.db.run(scope, async (tx) => {
    const now = deps.clock.now();
    const [endpoint] = await tx
      .select({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        state: webhookEndpoints.state,
        failingSince: webhookEndpoints.failingSince,
      })
      .from(webhookEndpoints)
      .where(
        and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.id, delivery.endpointId)),
      )
      .for('no key update');
    const [current] = await tx
      .select({ state: webhookDeliveries.state, attempts: webhookDeliveries.attempts })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.tenantId, tenantId), eq(webhookDeliveries.id, delivery.id)))
      .for('update');
    if (
      !endpoint ||
      !current ||
      current.state !== 'delivering' ||
      current.attempts !== delivery.attempt
    ) {
      return 'stale';
    }
    const thisDelivery = and(
      eq(webhookDeliveries.tenantId, tenantId),
      eq(webhookDeliveries.id, delivery.id),
    );
    const thisEndpoint = and(
      eq(webhookEndpoints.tenantId, tenantId),
      eq(webhookEndpoints.id, endpoint.id),
    );
    const result = {
      leaseUntil: null,
      lastStatusCode: outcome.statusCode,
      lastError: outcome.error,
      lastDurationMs: outcome.durationMs,
    };
    if (outcome.ok) {
      await tx
        .update(webhookDeliveries)
        .set({ ...result, state: 'succeeded', deliveredAt: now })
        .where(thisDelivery);
      await tx
        .update(webhookEndpoints)
        .set({ lastSuccessAt: now, failingSince: null })
        .where(thisEndpoint);
      return 'succeeded';
    }

    const failingSince = endpoint.failingSince ?? now;
    const disable =
      endpoint.state === 'active' &&
      now.getTime() - failingSince.getTime() >= WEBHOOK_LIMITS.disableAfterHours * 3_600_000;
    const delaySeconds =
      endpoint.state === 'active' && !disable ? webhookRetryDelaySeconds(delivery.attempt) : null;
    await tx
      .update(webhookDeliveries)
      .set(
        delaySeconds === null
          ? { ...result, state: 'failed' }
          : {
              ...result,
              state: 'pending',
              nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
            },
      )
      .where(thisDelivery);
    await tx
      .update(webhookEndpoints)
      .set({
        lastFailureAt: now,
        failingSince,
        ...(disable
          ? { state: 'disabled', disabledReason: 'failing', disabledAt: now, updatedAt: now }
          : {}),
      })
      .where(thisEndpoint);
    if (disable) {
      const pendingFailed = await failPendingDeliveries(tx, tenantId, endpoint.id);
      await recordSystemAudit(tx, tenantId, {
        action: 'webhook.endpoint_auto_disabled',
        subjectType: 'webhook_endpoint',
        subjectId: endpoint.id,
        metadata: {
          host: webhookHost(endpoint.url),
          failingSince: failingSince.toISOString(),
          pendingDeliveriesFailed: pendingFailed,
        },
      });
      await notifyEndpointDisabled(deps.notices, tx, tenantId, endpoint.url);
    }
    return delaySeconds === null ? 'failed' : 'retrying';
  });
}

/**
 * Emails the company's active owners and administrators (the roles with `developer.manage`) that
 * an endpoint was turned off, in the transaction that turned it off.
 */
async function notifyEndpointDisabled(
  deps: WebhookNoticeDeps,
  tx: Tx,
  tenantId: string,
  endpointUrl: string,
): Promise<number> {
  const [company] = await tx
    .select({ name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!company) return 0;
  const recipients = await tx
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, 'active'),
        sql`${memberships.roles} && array['owner', 'admin']::text[]`,
      ),
    );
  const url = new URL(`/c/${company.slug}/settings/webhooks`, deps.appBaseUrl).toString();
  for (const recipient of recipients) {
    await enqueueEmail(deps.outbox, tx, {
      to: recipient.email,
      tenantId,
      payload: {
        kind: 'webhook.endpoint_disabled',
        companyName: company.name,
        host: webhookHost(endpointUrl) ?? 'the endpoint',
        url,
      },
    });
  }
  return recipients.length;
}
