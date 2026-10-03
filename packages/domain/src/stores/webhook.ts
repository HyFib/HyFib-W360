import { parseExternalJson, uuidv7, type Clock } from '@w360/core';
import {
  and,
  authorizedTenantScope,
  commerceStoreCheckouts,
  commerceStoreEvents,
  commerceStoreFetches,
  commerceStoreOrders,
  commerceStorePrivacyRequests,
  commerceStoreProducts,
  commerceStores,
  eq,
  inArray,
  isNull,
  or,
  sql,
  systemScope,
  type Database,
  type StoreFetchKind,
  type TenantScope,
  type Tx,
} from '@w360/db';
import type { Keyring } from '@w360/core';
import { recordSystemAudit } from '../audit';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { asRecord } from './http';
import {
  EXTERNAL_ID_RE,
  SHOP_DOMAIN_RE,
  STORE_WEBHOOK_ID_RE,
  WOO_PING_RE,
  clip,
  storeCustomerPhone,
  storeEmail,
  storeWebhookSecretAad,
  verifyShopifyWebhook,
  verifyWooWebhook,
} from './model';
import { gidNumber } from './shopify';
import { WOO_WEBHOOK_TOPICS } from './woocommerce';
import { enqueueStoreJob } from './worker';

/**
 * Store webhooks. A delivery is verified first (Shopify: HyFib's app secret, SH-024; WooCommerce:
 * the store's own secret, WC-014), recorded by its delivery id so a repeat does nothing twice, and
 * then only signals what to read from the store: nothing in the body is stored. Deletions,
 * uninstalls and Shopify's privacy requests act on the store's copy directly, using the shop named
 * in the signed body (the HMAC does not cover headers).
 */

export interface StoreWebhookDeps {
  db: Database;
  keyring: Keyring;
  clock: Clock;
  jobs: JobQueue;
  signer: JobSigner;
  /** HyFib's Shopify app secrets (current, then previous during rotation); null when unset. */
  shopifySecrets: readonly string[] | null;
}

export interface StoreWebhookResult {
  status: number;
  log: { outcome: string; tenantIds?: string[]; topic?: string };
}

const DELIVERY_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const ACTIVE_STATES = ['connecting', 'connected', 'failed'] as const;

interface ShopTarget {
  tenantId: string;
  storeId: string;
  state: string;
  shopExternalId: string | null;
}

async function storesForShop(db: Database, shopDomain: string): Promise<ShopTarget[]> {
  const res = await db.run(
    systemScope,
    (tx) =>
      tx.execute<{
        tenant_id: string;
        store_id: string;
        state: string;
        shop_external_id: string | null;
      }>(
        sql`select tenant_id, store_id, state, shop_external_id from ops.commerce_store_by_shop(${shopDomain})`,
      ),
    { accessMode: 'read only' },
  );
  return res.rows.map((r) => ({
    tenantId: r.tenant_id,
    storeId: r.store_id,
    state: r.state,
    shopExternalId: r.shop_external_id,
  }));
}

/** Records a delivery; false when it was seen before (a repeat does nothing). */
async function recordDelivery(
  tx: Tx,
  scope: TenantScope,
  storeId: string,
  deliveryId: string,
  topic: string,
): Promise<boolean> {
  const inserted = await tx
    .insert(commerceStoreEvents)
    .values({ id: uuidv7(), tenantId: scope.tenantId, storeId, deliveryId, topic })
    .onConflictDoNothing({
      target: [
        commerceStoreEvents.tenantId,
        commerceStoreEvents.storeId,
        commerceStoreEvents.deliveryId,
      ],
    })
    .returning({ id: commerceStoreEvents.id });
  return inserted.length > 0;
}

/**
 * Asks the worker to read one order or product now. Repeated signals collapse into one read of its
 * current state; the job is queued only for a connected store (others read it once reconnected).
 */
async function signalFetch(
  deps: Pick<StoreWebhookDeps, 'jobs' | 'signer' | 'clock'>,
  tx: Tx,
  scope: TenantScope,
  store: { id: string; state: string },
  kind: StoreFetchKind,
  externalId: string,
): Promise<void> {
  await tx
    .insert(commerceStoreFetches)
    .values({
      id: uuidv7(),
      tenantId: scope.tenantId,
      storeId: store.id,
      kind,
      externalId,
      requestedAt: deps.clock.now(),
    })
    .onConflictDoUpdate({
      target: [
        commerceStoreFetches.tenantId,
        commerceStoreFetches.storeId,
        commerceStoreFetches.kind,
        commerceStoreFetches.externalId,
      ],
      // Every repeat moves the time forward (even within one millisecond, or from a web instance
      // whose clock lags), so a worker reading the previous signal never deletes this one.
      set: {
        requestedAt: sql`greatest(excluded.requested_at, ${commerceStoreFetches.requestedAt} + interval '1 millisecond')`,
      },
    });
  if (store.state === 'connected') {
    await enqueueStoreJob(deps, tx, scope.tenantId, store.id, `store:${store.id}`);
  }
}

/** A signed delete event marks the copy deleted (nothing to read back). */
async function markDeleted(
  tx: Tx,
  scope: TenantScope,
  storeId: string,
  kind: StoreFetchKind,
  externalId: string,
  now: Date,
): Promise<void> {
  if (kind === 'order') {
    await tx
      .update(commerceStoreOrders)
      .set({ deletedAt: now })
      .where(
        and(
          eq(commerceStoreOrders.tenantId, scope.tenantId),
          eq(commerceStoreOrders.storeId, storeId),
          eq(commerceStoreOrders.externalId, externalId),
          isNull(commerceStoreOrders.deletedAt),
        ),
      );
  } else {
    await tx
      .update(commerceStoreProducts)
      .set({ deletedAt: now })
      .where(
        and(
          eq(commerceStoreProducts.tenantId, scope.tenantId),
          eq(commerceStoreProducts.storeId, storeId),
          eq(commerceStoreProducts.externalId, externalId),
          isNull(commerceStoreProducts.deletedAt),
        ),
      );
  }
  await tx
    .delete(commerceStoreFetches)
    .where(
      and(
        eq(commerceStoreFetches.tenantId, scope.tenantId),
        eq(commerceStoreFetches.storeId, storeId),
        eq(commerceStoreFetches.kind, kind),
        eq(commerceStoreFetches.externalId, externalId),
      ),
    );
}

/** A numeric resource id from a delivery body (`admin_graphql_api_id` first, then `id`). */
function resourceId(
  body: Record<string, unknown>,
  gidType: 'Order' | 'Product' | null,
): string | null {
  if (gidType) {
    const fromGid = gidNumber(body.admin_graphql_api_id, gidType);
    if (fromGid) return fromGid;
  }
  const id = body.id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
  if (typeof id === 'string' && EXTERNAL_ID_RE.test(id)) return id;
  return null;
}

const idList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((v) =>
          typeof v === 'number' && Number.isSafeInteger(v) && v > 0
            ? String(v)
            : typeof v === 'string' && EXTERNAL_ID_RE.test(v)
              ? v
              : null,
        )
        .filter((v): v is string => v !== null)
        .slice(0, 1000)
    : [];

// Shopify ------------------------------------------------------------------------------------------

const SHOPIFY_RESOURCE_TOPICS: Record<string, { kind: StoreFetchKind; delete: boolean }> = {
  'orders/create': { kind: 'order', delete: false },
  'orders/updated': { kind: 'order', delete: false },
  'orders/delete': { kind: 'order', delete: true },
  'products/create': { kind: 'product', delete: false },
  'products/update': { kind: 'product', delete: false },
  'products/delete': { kind: 'product', delete: true },
};

export async function handleShopifyWebhook(
  deps: StoreWebhookDeps,
  input: {
    rawBody: Buffer;
    hmac: string | null;
    topic: string | null;
    shopDomain: string | null;
    webhookId: string | null;
  },
): Promise<StoreWebhookResult> {
  if (!deps.shopifySecrets) return { status: 404, log: { outcome: 'not_configured' } };
  // Shopify's app review expects 401 for a delivery whose HMAC does not verify (SH-027).
  if (!verifyShopifyWebhook(input.rawBody, input.hmac, deps.shopifySecrets)) {
    return { status: 401, log: { outcome: 'bad_signature' } };
  }
  const topic = (input.topic ?? '').trim().toLowerCase();
  const headerShop = (input.shopDomain ?? '').trim().toLowerCase();
  const deliveryId = (input.webhookId ?? '').trim();
  if (!/^[a-z_]{1,40}\/[a-z_]{1,40}$/.test(topic) || !DELIVERY_ID_RE.test(deliveryId)) {
    return { status: 400, log: { outcome: 'missing_headers', topic: topic.slice(0, 64) } };
  }
  let body: Record<string, unknown> | null;
  try {
    body = asRecord(parseExternalJson(input.rawBody.toString('utf8')));
  } catch {
    body = null;
  }
  if (!body) return { status: 400, log: { outcome: 'malformed', topic } };

  const resource = SHOPIFY_RESOURCE_TOPICS[topic];
  if (resource || topic === 'app/uninstalled') {
    if (!SHOP_DOMAIN_RE.test(headerShop))
      return { status: 400, log: { outcome: 'bad_shop', topic } };
    const target = (await storesForShop(deps.db, headerShop)).find((t) =>
      (ACTIVE_STATES as readonly string[]).includes(t.state),
    );
    if (!target) return { status: 200, log: { outcome: 'no_store', topic } };
    const scope = authorizedTenantScope(target.tenantId, null);
    if (topic === 'app/uninstalled') {
      return uninstalled(deps, scope, target, headerShop, body, deliveryId);
    }
    const gidType = resource?.kind === 'order' ? 'Order' : 'Product';
    const externalId = resourceId(body, gidType);
    if (!resource || !externalId) return { status: 400, log: { outcome: 'malformed', topic } };
    const outcome = await deps.db.run(scope, async (tx) => {
      if (!(await recordDelivery(tx, scope, target.storeId, deliveryId, topic))) return 'duplicate';
      if (resource.delete) {
        await markDeleted(tx, scope, target.storeId, resource.kind, externalId, deps.clock.now());
        return 'deleted';
      }
      await signalFetch(
        deps,
        tx,
        scope,
        { id: target.storeId, state: target.state },
        resource.kind,
        externalId,
      );
      return 'fetch_signalled';
    });
    return { status: 200, log: { outcome, topic, tenantIds: [target.tenantId] } };
  }

  if (
    topic === 'customers/redact' ||
    topic === 'customers/data_request' ||
    topic === 'shop/redact'
  ) {
    // The signed body names the shop; the header does not count for these (SH-024).
    const shop = typeof body.shop_domain === 'string' ? body.shop_domain.trim().toLowerCase() : '';
    if (!SHOP_DOMAIN_RE.test(shop)) return { status: 400, log: { outcome: 'bad_shop', topic } };
    const targets = await storesForShop(deps.db, shop);
    const tenantIds: string[] = [];
    for (const target of targets) {
      const scope = authorizedTenantScope(target.tenantId, null);
      if (topic === 'shop/redact') {
        if (target.state !== 'uninstalled') continue;
        await shopRedact(deps, scope, target.storeId);
      } else if (topic === 'customers/redact') {
        await customerRedact(deps, scope, target.storeId, body, deliveryId);
      } else {
        await dataRequest(deps, scope, target.storeId, body, deliveryId);
      }
      tenantIds.push(target.tenantId);
    }
    return {
      status: 200,
      log: { outcome: tenantIds.length ? 'handled' : 'no_store', topic, tenantIds },
    };
  }
  return { status: 200, log: { outcome: 'ignored', topic } };
}

/**
 * The merchant uninstalled HyFib (SH-028): the store stops syncing and its access is dropped; what
 * was read stays until Shopify's shop redaction or the company removes the store. The body must
 * name the same shop (by id or myshopify domain).
 */
async function uninstalled(
  deps: StoreWebhookDeps,
  scope: TenantScope,
  target: ShopTarget,
  shopDomain: string,
  body: Record<string, unknown>,
  deliveryId: string,
): Promise<StoreWebhookResult> {
  const bodyId = resourceId(body, null);
  const bodyDomain =
    typeof body.myshopify_domain === 'string' ? body.myshopify_domain.trim().toLowerCase() : null;
  const sameShop =
    (bodyId !== null && bodyId === target.shopExternalId) || bodyDomain === shopDomain;
  if (!sameShop)
    return { status: 400, log: { outcome: 'shop_mismatch', topic: 'app/uninstalled' } };
  const outcome = await deps.db.run(scope, async (tx) => {
    if (!(await recordDelivery(tx, scope, target.storeId, deliveryId, 'app/uninstalled')))
      return 'duplicate';
    const changed = await tx
      .update(commerceStores)
      .set({
        state: 'uninstalled',
        uninstalledAt: deps.clock.now(),
        credentialsCiphertext: null,
        accessExpiresAt: null,
        connectTokenHash: null,
        connectMembershipId: null,
        connectExpiresAt: null,
        statusError: 'HyFib was uninstalled in Shopify. Connect the store again to resume.',
      })
      .where(
        and(
          eq(commerceStores.tenantId, scope.tenantId),
          eq(commerceStores.id, target.storeId),
          inArray(commerceStores.state, [...ACTIVE_STATES]),
        ),
      )
      .returning({ id: commerceStores.id });
    if (changed.length === 0) return 'ignored';
    await tx
      .delete(commerceStoreFetches)
      .where(
        and(
          eq(commerceStoreFetches.tenantId, scope.tenantId),
          eq(commerceStoreFetches.storeId, target.storeId),
        ),
      );
    await recordSystemAudit(tx, scope.tenantId, {
      action: 'commerce.store_uninstalled',
      subjectType: 'commerce_store',
      subjectId: target.storeId,
      metadata: { platform: 'shopify' },
    });
    return 'uninstalled';
  });
  return { status: 200, log: { outcome, topic: 'app/uninstalled', tenantIds: [scope.tenantId] } };
}

/**
 * customers/redact (SH-027): the named orders, and the store's orders with the customer's number or
 * email, lose the customer's details for good (later reads keep them empty). Only what was redacted
 * is recorded, not who.
 */
async function customerRedact(
  deps: StoreWebhookDeps,
  scope: TenantScope,
  storeId: string,
  body: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  const customer = asRecord(body.customer);
  const orderIds = idList(body.orders_to_redact);
  const email = storeEmail(customer?.email);
  await deps.db.run(scope, async (tx) => {
    const [store] = await tx
      .select({ callingCode: commerceStores.phoneCallingCode })
      .from(commerceStores)
      .where(and(eq(commerceStores.tenantId, scope.tenantId), eq(commerceStores.id, storeId)))
      .for('update');
    if (!store) return;
    if (!(await recordDelivery(tx, scope, storeId, deliveryId, 'customers/redact'))) return;
    const phone = storeCustomerPhone(clip(customer?.phone, 40), store.callingCode);
    const matches = [
      orderIds.length > 0 ? inArray(commerceStoreOrders.externalId, orderIds) : undefined,
      phone ? eq(commerceStoreOrders.customerPhone, phone) : undefined,
      email ? sql`lower(${commerceStoreOrders.customerEmail}) = ${email}` : undefined,
    ].filter((m) => m !== undefined);
    let redacted = 0;
    if (matches.length > 0) {
      const rows = await tx
        .update(commerceStoreOrders)
        .set({
          customerName: null,
          customerPhone: null,
          customerEmail: null,
          statusUrl: null,
          trackingNumber: null,
          trackingUrl: null,
          redactedAt: sql`coalesce(${commerceStoreOrders.redactedAt}, now())`,
        })
        .where(
          and(
            eq(commerceStoreOrders.tenantId, scope.tenantId),
            eq(commerceStoreOrders.storeId, storeId),
            or(...matches),
          ),
        )
        .returning({ id: commerceStoreOrders.id });
      redacted = rows.length;
    }
    // Checkouts the customer left (cart reminders, ADR-049): by number or Shopify customer id.
    const customerId = resourceId(customer ?? {}, null);
    const checkoutMatches = [
      phone ? eq(commerceStoreCheckouts.customerPhone, phone) : undefined,
      customerId ? eq(commerceStoreCheckouts.customerExternalId, customerId) : undefined,
    ].filter((m) => m !== undefined);
    if (checkoutMatches.length > 0) {
      await tx
        .update(commerceStoreCheckouts)
        .set({
          customerExternalId: null,
          customerName: null,
          customerPhone: null,
          recoveryUrl: null,
          consentState: null,
          consentUpdatedAt: null,
          consentOptInLevel: null,
          consentCollectedFrom: null,
          redactedAt: sql`coalesce(${commerceStoreCheckouts.redactedAt}, now())`,
        })
        .where(
          and(
            eq(commerceStoreCheckouts.tenantId, scope.tenantId),
            eq(commerceStoreCheckouts.storeId, storeId),
            or(...checkoutMatches),
          ),
        );
    }
    // A data request from the same customer no longer keeps who asked.
    const requestMatches = [
      email ? sql`lower(${commerceStorePrivacyRequests.customerEmail}) = ${email}` : undefined,
      typeof customer?.phone === 'string' && customer.phone
        ? eq(commerceStorePrivacyRequests.customerPhone, customer.phone.slice(0, 40))
        : undefined,
    ].filter((m) => m !== undefined);
    if (requestMatches.length > 0) {
      await tx
        .update(commerceStorePrivacyRequests)
        .set({ customerEmail: null, customerPhone: null })
        .where(
          and(
            eq(commerceStorePrivacyRequests.tenantId, scope.tenantId),
            eq(commerceStorePrivacyRequests.storeId, storeId),
            eq(commerceStorePrivacyRequests.kind, 'data_request'),
            or(...requestMatches),
          ),
        );
    }
    await tx.insert(commerceStorePrivacyRequests).values({
      id: uuidv7(),
      tenantId: scope.tenantId,
      storeId,
      kind: 'redact',
      orderIds,
      ordersRedacted: redacted,
    });
    await recordSystemAudit(tx, scope.tenantId, {
      action: 'commerce.store_customer_redacted',
      subjectType: 'commerce_store',
      subjectId: storeId,
      metadata: { ordersNamed: orderIds.length, ordersRedacted: redacted },
    });
  });
}

/**
 * customers/data_request (SH-027): kept for the company, with who asked and the order ids, until a
 * member marks it answered (the store page lists the orders HyFib holds for them).
 */
async function dataRequest(
  deps: StoreWebhookDeps,
  scope: TenantScope,
  storeId: string,
  body: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  const customer = asRecord(body.customer);
  await deps.db.run(scope, async (tx) => {
    if (!(await recordDelivery(tx, scope, storeId, deliveryId, 'customers/data_request'))) return;
    await tx.insert(commerceStorePrivacyRequests).values({
      id: uuidv7(),
      tenantId: scope.tenantId,
      storeId,
      kind: 'data_request',
      customerEmail: clip(customer?.email, 320),
      customerPhone: clip(customer?.phone, 40),
      orderIds: idList(body.orders_requested),
    });
    await recordSystemAudit(tx, scope.tenantId, {
      action: 'commerce.store_data_requested',
      subjectType: 'commerce_store',
      subjectId: storeId,
      metadata: { orders: idList(body.orders_requested).length },
    });
  });
}

/** shop/redact (SH-027), 48 hours after an uninstall: the store and everything read from it go. */
async function shopRedact(
  deps: StoreWebhookDeps,
  scope: TenantScope,
  storeId: string,
): Promise<void> {
  await deps.db.run(scope, async (tx) => {
    const deleted = await tx
      .delete(commerceStores)
      .where(
        and(
          eq(commerceStores.tenantId, scope.tenantId),
          eq(commerceStores.id, storeId),
          eq(commerceStores.state, 'uninstalled'),
        ),
      )
      .returning({ id: commerceStores.id });
    if (deleted.length === 0) return;
    await recordSystemAudit(tx, scope.tenantId, {
      action: 'commerce.store_redacted',
      subjectType: 'commerce_store',
      subjectId: storeId,
      metadata: { platform: 'shopify' },
    });
  });
}

// WooCommerce --------------------------------------------------------------------------------------

export async function handleWooWebhook(
  deps: StoreWebhookDeps,
  input: {
    publicId: string;
    rawBody: Buffer;
    signature: string | null;
    topic: string | null;
    deliveryId: string | null;
  },
): Promise<StoreWebhookResult> {
  if (!STORE_WEBHOOK_ID_RE.test(input.publicId))
    return { status: 404, log: { outcome: 'unknown_store' } };
  const targetRes = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; store_id: string }>(
        sql`select tenant_id, store_id from ops.commerce_store_by_webhook(${input.publicId})`,
      ),
    { accessMode: 'read only' },
  );
  const target = targetRes.rows[0];
  if (!target) return { status: 404, log: { outcome: 'unknown_store' } };
  const scope = authorizedTenantScope(target.tenant_id, null);
  const [store] = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({
          id: commerceStores.id,
          state: commerceStores.state,
          secret: commerceStores.webhookSecretCiphertext,
        })
        .from(commerceStores)
        .where(
          and(eq(commerceStores.tenantId, scope.tenantId), eq(commerceStores.id, target.store_id)),
        ),
    { accessMode: 'read only' },
  );
  if (!store?.secret) return { status: 404, log: { outcome: 'unknown_store' } };
  // WooCommerce pings a new webhook without a signature (WC-012); it changes nothing.
  if (!input.signature && WOO_PING_RE.test(input.rawBody.toString('utf8').trim())) {
    return { status: 200, log: { outcome: 'ping', tenantIds: [scope.tenantId] } };
  }
  const secret = deps.keyring.decryptString(
    store.secret,
    storeWebhookSecretAad(scope.tenantId, store.id),
  );
  if (!verifyWooWebhook(input.rawBody, input.signature, secret)) {
    return { status: 401, log: { outcome: 'bad_signature', tenantIds: [scope.tenantId] } };
  }
  const topic = (input.topic ?? '').trim().toLowerCase();
  const deliveryId = (input.deliveryId ?? '').trim();
  if (!(WOO_WEBHOOK_TOPICS as readonly string[]).includes(topic)) {
    return {
      status: 200,
      log: { outcome: 'ignored', topic: topic.slice(0, 64), tenantIds: [scope.tenantId] },
    };
  }
  if (!DELIVERY_ID_RE.test(deliveryId)) {
    return { status: 400, log: { outcome: 'missing_headers', topic, tenantIds: [scope.tenantId] } };
  }
  let body: Record<string, unknown> | null;
  try {
    body = asRecord(parseExternalJson(input.rawBody.toString('utf8')));
  } catch {
    body = null;
  }
  const externalId = body ? resourceId(body, null) : null;
  if (!externalId)
    return { status: 400, log: { outcome: 'malformed', topic, tenantIds: [scope.tenantId] } };
  if (!(ACTIVE_STATES as readonly string[]).includes(store.state)) {
    return { status: 200, log: { outcome: 'no_store', topic, tenantIds: [scope.tenantId] } };
  }
  const kind: StoreFetchKind = topic.startsWith('order.') ? 'order' : 'product';
  const outcome = await deps.db.run(scope, async (tx) => {
    if (!(await recordDelivery(tx, scope, store.id, deliveryId, topic))) return 'duplicate';
    if (topic.endsWith('.deleted')) {
      await markDeleted(tx, scope, store.id, kind, externalId, deps.clock.now());
      return 'deleted';
    }
    await signalFetch(deps, tx, scope, store, kind, externalId);
    return 'fetch_signalled';
  });
  return { status: 200, log: { outcome, topic, tenantIds: [scope.tenantId] } };
}
