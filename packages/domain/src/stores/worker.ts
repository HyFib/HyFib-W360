import { uuidv7, type Clock, type Keyring } from '@w360/core';
import type { EgressClient } from '@w360/core/egress';
import { QUEUES } from '@w360/contracts';
import {
  and,
  asc,
  commerceStoreEvents,
  commerceStoreFetches,
  commerceStoreOrderItems,
  commerceStoreOrders,
  commerceStoreProducts,
  commerceStoreShipments,
  commerceStores,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  suppressions,
  systemScope,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import {
  cartRemindersOn,
  importStoreConsent,
  pruneStoreCheckouts,
  recordCheckoutReminders,
  saveStoreCheckouts,
} from './cart-reminders';
import { StoreApiError } from './http';
import {
  STORE_MESSAGE_LIMITS,
  nextTrackingKeys,
  type OrderMilestones,
  type SavedOrderChange,
  type SavedShipmentChange,
} from './messages-model';
import { markOrdersTracked, recordOrderEvents, transitOrdersToCheck } from './order-messages';
import {
  STORE_LIMITS,
  SHOPIFY_CUSTOMER_SCOPE,
  SHOPIFY_FULFILLMENT_SCOPE,
  SHOPIFY_SCOPES,
  hasCustomerAccess,
  hasShipmentAccess,
  shipmentTrackingKey,
  storeAccessCodeAad,
  storeCredentialsAad,
  storeCredentialsSchema,
  storeCustomerPhone,
  storeWebhookSecretAad,
  type StoreCheckoutRecord,
  type StoreCredentials,
  type StoreOrderRecord,
  type StoreProductRecord,
  type StoreShipmentRecord,
} from './model';
import {
  SHOPIFY_SHIPMENT_TOPICS,
  SHOPIFY_WEBHOOK_TOPICS,
  ShopifyAdmin,
  exchangeShopifyCode,
  refreshShopifyToken,
  throttleWaitSeconds,
  type ShopifyAppConfig,
  type ShopifyTokens,
} from './shopify';
import { WOO_WEBHOOK_TOPICS, WooStore } from './woocommerce';

/**
 * The `commerce.store` job: one store's work under a five-minute lease on its row (finishing a
 * connection, refreshing a Shopify token, reading what webhooks signalled, the incremental read,
 * checking HyFib's webhooks, removal). Requests to the store happen outside database transactions;
 * what they return is written in short transactions and never moves a copy backwards (an older
 * `updated_at` than the one kept is ignored).
 */

export interface StoreWorkerDeps {
  db: Database;
  keyring: Keyring;
  clock: Clock;
  jobs: JobQueue;
  signer: JobSigner;
  /** The egress client for stores (address checks, no redirects, size and time limits). */
  egress: EgressClient;
  /** HyFib's Shopify app; null when it is not configured. */
  shopify: ShopifyAppConfig | null;
  appBaseUrl: string;
}

export type StoreJobOutcome =
  | 'skipped'
  | 'expired'
  | 'connected'
  | 'failed'
  | 'synced'
  | 'continuing'
  | 'waiting'
  | 'removed'
  | 'retry';

type StoreRow = typeof commerceStores.$inferSelect;
type StoreUpdate = Partial<typeof commerceStores.$inferInsert>;

const LEASE_MS = STORE_LIMITS.leaseMinutes * 60_000;
const MINUTE = 60_000;
const EPOCH = new Date(0);

export const shopifyWebhookUri = (appBaseUrl: string) => `${appBaseUrl}/api/webhooks/shopify`;
export const wooWebhookUri = (appBaseUrl: string, publicId: string) =>
  `${appBaseUrl}/api/webhooks/woocommerce/${publicId}`;

const where = (scope: TenantScope, storeId: string) =>
  and(eq(commerceStores.tenantId, scope.tenantId), eq(commerceStores.id, storeId));

export function readStoreCredentials(keyring: Keyring, store: StoreRow): StoreCredentials | null {
  if (!store.credentialsCiphertext) return null;
  const json = keyring.decryptString(
    store.credentialsCiphertext,
    storeCredentialsAad(store.tenantId, store.id),
  );
  return storeCredentialsSchema.parse(JSON.parse(json));
}

export function sealStoreCredentials(
  keyring: Keyring,
  tenantId: string,
  storeId: string,
  credentials: StoreCredentials,
): string {
  return keyring.encrypt(JSON.stringify(credentials), storeCredentialsAad(tenantId, storeId));
}

/** Seals an authorization code for more access on a connected store (its own binding). */
export function sealStoreAccessCode(
  keyring: Keyring,
  tenantId: string,
  storeId: string,
  code: string,
): string {
  return keyring.encrypt(code, storeAccessCodeAad(tenantId, storeId));
}

function readStoreAccessCode(keyring: Keyring, store: StoreRow): string | null {
  if (!store.accessCodeCiphertext) return null;
  return keyring.decryptString(
    store.accessCodeCiphertext,
    storeAccessCodeAad(store.tenantId, store.id),
  );
}

/** The next job for a store (the lease holder queues it when work remains). */
export async function enqueueStoreJob(
  deps: Pick<StoreWorkerDeps, 'jobs' | 'signer'>,
  tx: Tx | null,
  tenantId: string,
  storeId: string,
  singletonKey: string,
  actorUserId: string | null = null,
): Promise<void> {
  await deps.jobs.enqueue(
    tx,
    QUEUES.commerceStore.name,
    deps.signer.sign({ kind: 'commerce.store', tenantId, actorUserId, ref: storeId }),
    { singletonKey },
  );
}

export async function processStoreJob(
  deps: StoreWorkerDeps,
  scope: TenantScope,
  storeId: string,
): Promise<StoreJobOutcome> {
  const now = deps.clock.now();
  const [store] = await deps.db.run(scope, (tx) =>
    tx
      .update(commerceStores)
      .set({ leaseUntil: new Date(now.getTime() + LEASE_MS) })
      .where(
        and(
          where(scope, storeId),
          or(isNull(commerceStores.leaseUntil), lt(commerceStores.leaseUntil, now)),
        ),
      )
      .returning(),
  );
  // Gone, or another job holds the lease: that job queues the next one when work remains.
  if (!store) return 'skipped';
  const job = new StoreJob(deps, scope, store, now);
  try {
    return await job.run();
  } catch (error) {
    if (!job.released) await job.finish({});
    throw error;
  }
}

/** What removing HyFib from a store achieved at the store itself. */
export type StoreRemoteRemoval = 'done' | 'no_access' | 'unreachable';

/**
 * Removes a store at once because its company is being deleted (ADR-055): one attempt to remove
 * HyFib from the store (an unreachable store is not retried), then the store and everything read
 * from it are deleted. Returns what happened at the store, or 'gone' when there was no such store.
 */
export async function removeStoreForDeletion(
  deps: StoreWorkerDeps,
  scope: TenantScope,
  storeId: string,
): Promise<StoreRemoteRemoval | 'gone'> {
  const now = deps.clock.now();
  // The removal deadline is already past, so an unreachable store is removed rather than retried.
  const [store] = await deps.db.run(scope, (tx) =>
    tx
      .update(commerceStores)
      .set({
        state: 'removing',
        connectExpiresAt: new Date(now.getTime() - 1),
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      })
      .where(where(scope, storeId))
      .returning(),
  );
  if (!store) return 'gone';
  const job = new StoreJob(deps, scope, store, now);
  try {
    await job.run();
  } catch (error) {
    if (!job.released) await job.finish({});
    throw error;
  }
  return job.remote ?? 'no_access';
}

class StoreJob {
  released = false;
  /** Set by a removal: what could be done at the store. */
  remote: StoreRemoteRemoval | null = null;

  constructor(
    private readonly deps: StoreWorkerDeps,
    private readonly scope: TenantScope,
    private store: StoreRow,
    private readonly now: Date,
  ) {}

  private at(offsetMs: number) {
    return new Date(this.now.getTime() + offsetMs);
  }

  /**
   * Releases the lease with the given changes. When `requeue` is set, the next job is queued in the
   * same transaction if work remains, so a webhook that arrived while this job ran is never missed.
   */
  async finish(
    set: StoreUpdate,
    options: { requeue?: boolean; onlyState?: StoreRow['state'] } = {},
  ) {
    const { deps, scope, store } = this;
    await deps.db.run(scope, async (tx) => {
      await tx
        .update(commerceStores)
        .set({ ...set, leaseUntil: null })
        .where(
          and(
            where(scope, store.id),
            options.onlyState ? eq(commerceStores.state, options.onlyState) : undefined,
          ),
        );
      if (options.requeue) {
        const [pending] = await tx
          .select({ id: commerceStoreFetches.id })
          .from(commerceStoreFetches)
          .where(
            and(
              eq(commerceStoreFetches.tenantId, scope.tenantId),
              eq(commerceStoreFetches.storeId, store.id),
            ),
          )
          .limit(1);
        const next = set.nextSyncAt ?? store.nextSyncAt;
        const checkouts = 'checkoutsReadAt' in set ? set.checkoutsReadAt : store.checkoutsReadAt;
        const due = (at: Date | null | undefined) => !!at && at.getTime() <= this.now.getTime();
        if (pending || due(next) || due(checkouts)) {
          await enqueueStoreJob(
            deps,
            tx,
            scope.tenantId,
            store.id,
            `store:${store.id}:next:${this.now.getTime()}`,
          );
        }
      }
    });
    this.released = true;
  }

  private async fail(message: string, onlyState: StoreRow['state']): Promise<'failed'> {
    await this.finish(
      { state: 'failed', statusError: message.slice(0, 500), connectExpiresAt: null },
      { onlyState },
    );
    await this.deps.db.run(this.scope, (tx) =>
      recordSystemAudit(tx, this.scope.tenantId, {
        action: 'commerce.store_failed',
        subjectType: 'commerce_store',
        subjectId: this.store.id,
        metadata: { platform: this.store.platform, reason: message.slice(0, 200) },
      }),
    );
    return 'failed';
  }

  async run(): Promise<StoreJobOutcome> {
    switch (this.store.state) {
      case 'authorizing':
        return this.expireHandshake();
      case 'connecting':
        return this.finishConnecting();
      case 'connected':
        return this.maintain();
      case 'removing':
        return this.remove();
      default:
        await this.finish({});
        return 'skipped';
    }
  }

  // Handshakes -----------------------------------------------------------------------------------

  /** An approval that never came: a new store goes; a store that was connected before fails. */
  private async expireHandshake(): Promise<StoreJobOutcome> {
    const { store } = this;
    const expired =
      store.connectExpiresAt !== null &&
      store.connectExpiresAt.getTime() < this.now.getTime() - 60 * MINUTE;
    if (!expired) {
      await this.finish({});
      return 'skipped';
    }
    if (store.backfilledAt === null) {
      await this.deps.db.run(this.scope, (tx) =>
        tx
          .delete(commerceStores)
          .where(and(where(this.scope, store.id), eq(commerceStores.state, 'authorizing'))),
      );
      this.released = true;
      return 'expired';
    }
    await this.finish(
      {
        state: 'failed',
        statusError: 'The store owner did not approve HyFib in time. Connect the store again.',
        connectTokenHash: null,
        connectMembershipId: null,
        connectExpiresAt: null,
      },
      { onlyState: 'authorizing' },
    );
    return 'failed';
  }

  private async finishConnecting(): Promise<StoreJobOutcome> {
    const { store } = this;
    if (store.connectExpiresAt && store.connectExpiresAt.getTime() < this.now.getTime()) {
      return this.fail(
        'HyFib could not reach the store to finish connecting. Connect the store again.',
        'connecting',
      );
    }
    try {
      return store.platform === 'shopify' ? await this.connectShopify() : await this.connectWoo();
    } catch (error) {
      if (!(error instanceof StoreApiError)) throw error;
      if (['unreachable', 'server', 'throttled'].includes(error.failure)) {
        // Tried again by the sweep until the connecting deadline.
        await this.finish({ statusError: error.message.slice(0, 500) });
        return 'retry';
      }
      return this.fail(connectFailureMessage(store.platform, error), 'connecting');
    }
  }

  private async connectShopify(): Promise<StoreJobOutcome> {
    const { deps, store } = this;
    const config = deps.shopify;
    if (!config || !store.shopDomain) {
      return this.fail('Shopify is not set up for HyFib yet.', 'connecting');
    }
    let credentials = readStoreCredentials(deps.keyring, store);
    if (credentials?.kind === 'shopify_code') {
      const tokens = await exchangeShopifyCode(
        deps.egress,
        config,
        store.shopDomain,
        credentials.code,
      );
      const missing = SHOPIFY_SCOPES.filter((scope) => !tokens.scopes.includes(scope));
      if (missing.length > 0) {
        return this.fail(
          `Shopify did not grant ${missing.join(' and ')}. Connect the store again and approve all requested access.`,
          'connecting',
        );
      }
      credentials = await this.saveShopifyTokens(tokens);
      if (!credentials) {
        await this.finish({});
        return 'skipped';
      }
    }
    if (credentials?.kind !== 'shopify_token') {
      return this.fail('The store has no Shopify access. Connect the store again.', 'connecting');
    }
    const admin = new ShopifyAdmin(deps.egress, config, store.shopDomain, credentials.accessToken);
    const shop = await admin.shop();
    if (shop.domain !== store.shopDomain) {
      return this.fail(
        'Shopify answered for a different shop. Connect the store again.',
        'connecting',
      );
    }
    const webhookError = await ensureShopifyWebhooks(
      admin,
      shopifyWebhookUri(deps.appBaseUrl),
      this.store.grantedScopes,
    );
    await this.finish(
      {
        state: 'connected',
        statusError: null,
        name: shop.name ?? store.name,
        currency: shop.currency,
        shopExternalId: shop.id,
        connectExpiresAt: null,
        ordersCursor: store.ordersCursor ?? this.at(-STORE_LIMITS.backfillDays * 24 * 60 * MINUTE),
        productsCursor: store.productsCursor ?? EPOCH,
        nextSyncAt: this.now,
        webhooksCheckedAt: this.now,
        webhookError,
        syncError: null,
      },
      { requeue: true, onlyState: 'connecting' },
    );
    await this.audit('commerce.store_connected');
    return 'connected';
  }

  private async connectWoo(): Promise<StoreJobOutcome> {
    const { deps, store } = this;
    const credentials = readStoreCredentials(deps.keyring, store);
    if (
      credentials?.kind !== 'woo_keys' ||
      !store.webhookPublicId ||
      !store.webhookSecretCiphertext
    ) {
      return this.fail('The store has no WooCommerce keys. Connect the store again.', 'connecting');
    }
    const woo = new WooStore(deps.egress, store.storeUrl, credentials);
    const currency = await woo.currency();
    const secret = deps.keyring.decryptString(
      store.webhookSecretCiphertext,
      storeWebhookSecretAad(store.tenantId, store.id),
    );
    const webhookError = await ensureWooWebhooks(
      woo,
      wooWebhookUri(deps.appBaseUrl, store.webhookPublicId),
      secret,
      true,
    );
    await this.finish(
      {
        state: 'connected',
        statusError: null,
        currency,
        connectExpiresAt: null,
        ordersCursor: store.ordersCursor ?? this.at(-STORE_LIMITS.backfillDays * 24 * 60 * MINUTE),
        productsCursor: store.productsCursor ?? EPOCH,
        nextSyncAt: this.now,
        webhooksCheckedAt: this.now,
        webhookError,
        syncError: null,
      },
      { requeue: true, onlyState: 'connecting' },
    );
    await this.audit('commerce.store_connected');
    return 'connected';
  }

  /**
   * Stores a new token pair atomically, bound to the credentials it replaces (SH-008). Returns null
   * when the store changed meanwhile (connected again, uninstalled or removed): the newer state wins.
   */
  private async saveShopifyTokens(tokens: ShopifyTokens): Promise<StoreCredentials | null> {
    const { deps, scope, store } = this;
    const credentials: StoreCredentials = {
      kind: 'shopify_token',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      refreshExpiresAt: tokens.refreshExpiresInSeconds
        ? this.at(tokens.refreshExpiresInSeconds * 1000).toISOString()
        : null,
    };
    const [row] = await deps.db.run(scope, (tx) =>
      tx
        .update(commerceStores)
        .set({
          credentialsCiphertext: sealStoreCredentials(
            deps.keyring,
            scope.tenantId,
            store.id,
            credentials,
          ),
          credentialsVersion: store.credentialsVersion + 1,
          accessExpiresAt: tokens.expiresInSeconds ? this.at(tokens.expiresInSeconds * 1000) : null,
          grantedScopes: tokens.scopes.join(',').slice(0, 500),
        })
        .where(
          and(
            where(scope, store.id),
            eq(commerceStores.credentialsVersion, store.credentialsVersion),
            inArray(commerceStores.state, ['connecting', 'connected', 'removing']),
          ),
        )
        .returning(),
    );
    if (!row) return null;
    this.store = row;
    return credentials;
  }

  /**
   * A usable Shopify access token, refreshed shortly before it expires (SH-007): 'refused' when
   * Shopify no longer accepts HyFib (the store must be connected again), 'changed' when the store
   * changed meanwhile.
   */
  private async shopifyToken(): Promise<string | 'refused' | 'changed'> {
    const { deps, store } = this;
    const config = deps.shopify;
    const credentials = readStoreCredentials(deps.keyring, store);
    if (!config || !store.shopDomain || credentials?.kind !== 'shopify_token') return 'refused';
    const due =
      store.accessExpiresAt !== null &&
      store.accessExpiresAt.getTime() - STORE_LIMITS.refreshMarginMinutes * MINUTE <=
        this.now.getTime();
    if (!due) return credentials.accessToken;
    if (!credentials.refreshToken) return 'refused';
    let tokens: ShopifyTokens;
    try {
      tokens = await refreshShopifyToken(
        deps.egress,
        config,
        store.shopDomain,
        credentials.refreshToken,
      );
    } catch (error) {
      if (
        error instanceof StoreApiError &&
        (error.failure === 'rejected' || error.failure === 'unauthorized')
      ) {
        return 'refused';
      }
      throw error;
    }
    const saved = await this.saveShopifyTokens(tokens);
    return saved?.kind === 'shopify_token' ? saved.accessToken : 'changed';
  }

  private async client(): Promise<StoreClient | 'refused' | 'changed'> {
    const { deps, store } = this;
    if (store.platform === 'shopify') {
      const token = await this.shopifyToken();
      if (token === 'refused' || token === 'changed') return token;
      return shopifyStoreClient(
        new ShopifyAdmin(
          deps.egress,
          deps.shopify as ShopifyAppConfig,
          store.shopDomain as string,
          token,
        ),
      );
    }
    const credentials = readStoreCredentials(deps.keyring, store);
    if (credentials?.kind !== 'woo_keys') return 'refused';
    return wooStoreClient(new WooStore(deps.egress, store.storeUrl, credentials), store.currency);
  }

  private async maintain(): Promise<StoreJobOutcome> {
    try {
      if (this.store.accessCodeCiphertext) {
        const failure = await this.exchangeAccessCode();
        if (failure) return this.fail(failure, 'connected');
      }
      const { store } = this;
      const client = await this.client();
      if (client === 'changed') {
        await this.finish({});
        return 'skipped';
      }
      if (client === 'refused') {
        return this.fail(
          store.platform === 'shopify'
            ? 'Shopify no longer accepts HyFib’s access (it may have been uninstalled). Connect the store again.'
            : 'The store has no WooCommerce keys. Connect the store again.',
          'connected',
        );
      }
      const fetched = await this.processFetches(client);
      await this.checkDeliveries(client);
      const update: StoreUpdate = { syncError: null, ...(await this.readCheckouts(client)) };
      let waitSeconds: number | null = null;
      let continuing = fetched.remaining;
      if (store.nextSyncAt === null || store.nextSyncAt.getTime() <= this.now.getTime()) {
        const orders = await this.readUpdates('orders', client);
        update.ordersCursor = orders.cursor;
        update.ordersPage = orders.page;
        let products: ReadResult | null = null;
        if (orders.complete) {
          products = await this.readUpdates('products', client);
          update.productsCursor = products.cursor;
          update.productsPage = products.page;
        }
        waitSeconds = orders.waitSeconds ?? products?.waitSeconds ?? null;
        if (orders.complete && products?.complete) {
          update.syncedAt = this.now;
          update.backfilledAt = store.backfilledAt ?? this.now;
          update.nextSyncAt = this.at(STORE_LIMITS.syncIntervalMinutes * MINUTE);
        } else if (waitSeconds !== null) {
          update.nextSyncAt = this.at(waitSeconds * 1000);
        } else {
          update.nextSyncAt = this.now;
          continuing = true;
        }
      }
      if (client.readOrders) update.detailsWithheld = client.withheld;
      if (
        store.webhooksCheckedAt === null ||
        store.webhooksCheckedAt.getTime() <
          this.now.getTime() - STORE_LIMITS.webhookCheckHours * 60 * MINUTE
      ) {
        update.webhookError = await client.ensureWebhooks(
          this.deps.appBaseUrl,
          store,
          this.deps.keyring,
        );
        update.webhooksCheckedAt = this.now;
      }
      await this.pruneEvents();
      await this.finish(update, { requeue: true, onlyState: 'connected' });
      if (waitSeconds !== null) return 'waiting';
      return continuing ? 'continuing' : 'synced';
    } catch (error) {
      return this.handleSyncError(error);
    }
  }

  private async handleSyncError(error: unknown): Promise<StoreJobOutcome> {
    if (!(error instanceof StoreApiError)) throw error;
    if (error.failure === 'unauthorized') {
      return this.fail(
        this.store.platform === 'shopify'
          ? 'Shopify refused HyFib’s access. Connect the store again.'
          : 'WooCommerce refused the keys (they may have been revoked or lack Read/Write access). Connect the store again.',
        'connected',
      );
    }
    if (error.failure === 'throttled') {
      await this.finish(
        { nextSyncAt: this.at((error.retryAfterSeconds ?? 60) * 1000) },
        { onlyState: 'connected' },
      );
      return 'waiting';
    }
    // Anything else is retried in five minutes; the reason stays visible on the store page.
    await this.finish(
      { syncError: error.message.slice(0, 500), nextSyncAt: this.at(5 * MINUTE) },
      { onlyState: 'connected' },
    );
    return 'retry';
  }

  /** Reads the orders and products webhooks signalled, then clears those signals. */
  private async processFetches(client: StoreClient): Promise<{ remaining: boolean }> {
    const { deps, scope, store } = this;
    const rows = await deps.db.run(
      scope,
      (tx) =>
        tx
          .select()
          .from(commerceStoreFetches)
          .where(
            and(
              eq(commerceStoreFetches.tenantId, scope.tenantId),
              eq(commerceStoreFetches.storeId, store.id),
            ),
          )
          .orderBy(asc(commerceStoreFetches.requestedAt))
          .limit(STORE_LIMITS.fetchesPerRun),
      { accessMode: 'read only' },
    );
    if (rows.length === 0) return { remaining: false };
    const orders: StoreOrderRecord[] = [];
    const products: StoreProductRecord[] = [];
    const orderIds = rows.filter((r) => r.kind === 'order').map((r) => r.externalId);
    const productIds = rows.filter((r) => r.kind === 'product').map((r) => r.externalId);
    for (const ids of chunks(orderIds, client.batch))
      orders.push(...(await client.ordersById(ids)).values());
    for (const ids of chunks(productIds, client.batch))
      products.push(...(await client.productsById(ids)).values());
    await deps.db.run(scope, async (tx) => {
      await this.saveOrders(tx, orders);
      await saveStoreProducts(tx, store, products, this.now);
      // A signal that arrived during the read has a newer time and stays for the next job.
      for (const row of rows) {
        await tx
          .delete(commerceStoreFetches)
          .where(
            and(
              eq(commerceStoreFetches.tenantId, scope.tenantId),
              eq(commerceStoreFetches.id, row.id),
              eq(commerceStoreFetches.requestedAt, row.requestedAt),
            ),
          );
      }
    });
    return { remaining: rows.length === STORE_LIMITS.fetchesPerRun };
  }

  /**
   * One step of the incremental read (SH-016, WC-007): items updated since the cursor, oldest first.
   * The cursor moves to the last item's second, so boundary items are read again rather than
   * skipped; the page token continues only among items sharing the cursor's second.
   */
  private async readUpdates(kind: 'orders' | 'products', client: StoreClient): Promise<ReadResult> {
    const { deps, scope, store } = this;
    let cursor = (kind === 'orders' ? store.ordersCursor : store.productsCursor) ?? EPOCH;
    let page = kind === 'orders' ? store.ordersPage : store.productsPage;
    for (let i = 0; i < STORE_LIMITS.pagesPerRun; i += 1) {
      const result =
        kind === 'orders'
          ? await client.ordersPage(cursor, page)
          : await client.productsPage(cursor, page);
      await deps.db.run(scope, async (tx) => {
        if (kind === 'orders') await this.saveOrders(tx, result.items as StoreOrderRecord[]);
        else await saveStoreProducts(tx, store, result.items as StoreProductRecord[], this.now);
      });
      const last = result.items.at(-1)?.remoteUpdatedAt ?? null;
      const lastSecond = last ? new Date(Math.floor(last.getTime() / 1000) * 1000) : null;
      if (!result.next) {
        return {
          complete: true,
          cursor: lastSecond && lastSecond > cursor ? lastSecond : cursor,
          page: null,
          waitSeconds: null,
        };
      }
      if (lastSecond && lastSecond > cursor) {
        cursor = lastSecond;
        page = null;
      } else {
        page = result.next;
      }
      if (result.waitSeconds !== null) {
        return { complete: false, cursor, page, waitSeconds: result.waitSeconds };
      }
    }
    return { complete: false, cursor, page, waitSeconds: null };
  }

  /** Saves orders read from the store and records the order messages their changes call for. */
  private async saveOrders(tx: Tx, records: StoreOrderRecord[]) {
    const changes = await saveStoreOrders(tx, this.store, records, this.now);
    await recordOrderEvents(tx, this.deps, this.store, changes, this.now);
  }

  /**
   * Reads Shopify orders in transit again while the delivered message is on (SH-034: whether a
   * delivery changes the order is unconfirmed, so its webhooks cannot be relied on).
   */
  private async checkDeliveries(client: StoreClient) {
    const { deps, scope, store } = this;
    const ids = await deps.db.run(scope, (tx) => transitOrdersToCheck(tx, store, this.now), {
      accessMode: 'read only',
    });
    if (ids.length === 0) return;
    const orders: StoreOrderRecord[] = [];
    for (const batch of chunks(ids, client.batch))
      orders.push(...(await client.ordersById(batch)).values());
    await deps.db.run(scope, async (tx) => {
      await this.saveOrders(tx, orders);
      await markOrdersTracked(tx, store, ids, this.now);
    });
  }

  private async pruneEvents() {
    const { deps, scope, store } = this;
    await deps.db.run(scope, async (tx) => {
      await tx
        .delete(commerceStoreEvents)
        .where(
          and(
            eq(commerceStoreEvents.tenantId, scope.tenantId),
            eq(commerceStoreEvents.storeId, store.id),
            lt(
              commerceStoreEvents.receivedAt,
              this.at(-STORE_LIMITS.eventRetentionDays * 24 * 60 * MINUTE),
            ),
          ),
        );
      await pruneStoreCheckouts(tx, store, this.now);
    });
  }

  /**
   * Reads the checkouts updated since the cursor while a cart reminder is on (ADR-049), up to a
   * number of pages per run: each page is saved with the reminders and consent it calls for. A read
   * that needs more pages continues on the next run with Shopify's page cursor; a complete read
   * moves the cursor to when it started, less a margin, so updates made meanwhile are read next.
   * Problems with checkouts never fail the store: they are kept on the store and tried again later.
   */
  private async readCheckouts(client: StoreClient): Promise<StoreUpdate> {
    const { deps, scope, store } = this;
    if (!client.checkoutsPage || !store.checkoutsReadAt) return {};
    if (store.checkoutsReadAt.getTime() > this.now.getTime()) return {};
    const on = await deps.db.run(scope, (tx) => cartRemindersOn(tx, store), {
      accessMode: 'read only',
    });
    if (!on) return { checkoutsReadAt: null, checkoutsPage: null, checkoutsError: null };
    const later = (minutes: number) => this.at(minutes * MINUTE);
    const since = store.checkoutsCursor ?? store.checkoutsReadAt;
    // Customers (their phone and consent) only while the store's consent setting is on.
    const withCustomers = store.storeConsentAt !== null && hasCustomerAccess(store.grantedScopes);
    let page = store.checkoutsPage;
    try {
      for (let i = 0; i < STORE_MESSAGE_LIMITS.checkoutPagesPerRun; i += 1) {
        const result = await client.checkoutsPage(since, page, withCustomers);
        await deps.db.run(scope, async (tx) => {
          const saved = await saveStoreCheckouts(tx, store, result.items, this.now);
          await recordCheckoutReminders(tx, deps, store, saved, this.now);
          await importStoreConsent(tx, store, saved);
        });
        if (!result.next) {
          // The read started at `now` at the latest; the margin covers clocks that differ.
          const cursor = new Date(
            Math.floor(
              (this.now.getTime() - STORE_MESSAGE_LIMITS.checkoutClockMarginSeconds * 1000) / 1000,
            ) * 1000,
          );
          return {
            checkoutsCursor: cursor > since ? cursor : since,
            checkoutsPage: null,
            checkoutsError: null,
            checkoutsReadAt: later(STORE_MESSAGE_LIMITS.checkoutReadMinutes),
          };
        }
        page = result.next;
        if (result.waitSeconds !== null) {
          return {
            checkoutsPage: page,
            checkoutsError: null,
            checkoutsReadAt: this.at(result.waitSeconds * 1000),
          };
        }
      }
      return { checkoutsPage: page, checkoutsError: null, checkoutsReadAt: this.now };
    } catch (error) {
      if (!(error instanceof StoreApiError)) throw error;
      return {
        checkoutsPage: page,
        checkoutsError:
          error.failure === 'throttled'
            ? null
            : `Reading checkouts: ${error.message}`.slice(0, 500),
        checkoutsReadAt:
          error.failure === 'throttled'
            ? this.at((error.retryAfterSeconds ?? 60) * 1000)
            : later(STORE_MESSAGE_LIMITS.checkoutReadMinutes),
      };
    }
  }

  /**
   * Exchanges the authorization code a manager's approval for more access left on a connected
   * store (SH-042). Shopify keeps one current token per app and store (SH-007), so the new token
   * replaces the old one whatever it grants, bound to the credentials version read. Without
   * `read_customers` the store keeps working and the page says so; without the connector's own
   * scopes it can no longer sync, and the message returned fails it. A code Shopify refuses leaves
   * the current token in place.
   */
  private async exchangeAccessCode(): Promise<string | null> {
    const { deps, scope, store } = this;
    const config = deps.shopify;
    const ciphertext = store.accessCodeCiphertext;
    const clear = async (accessError: string | null) => {
      const [row] = await deps.db.run(scope, (tx) =>
        tx
          .update(commerceStores)
          .set({ accessCodeCiphertext: null, accessError })
          .where(
            and(
              where(scope, store.id),
              eq(commerceStores.accessCodeCiphertext, ciphertext as string),
            ),
          )
          .returning(),
      );
      if (row) this.store = row;
    };
    if (!ciphertext) return null;
    if (!config || !store.shopDomain || store.state !== 'connected') {
      await clear('Shopify is not set up for HyFib, or the store is not connected.');
      return null;
    }
    let tokens: ShopifyTokens;
    try {
      const code = readStoreAccessCode(deps.keyring, store);
      if (!code) return null;
      tokens = await exchangeShopifyCode(deps.egress, config, store.shopDomain, code);
    } catch (error) {
      if (!(error instanceof StoreApiError)) throw error;
      await clear(
        `Shopify did not accept the approval (${error.message.slice(0, 200)}). HyFib kept its current access; allow customer access again.`,
      );
      return null;
    }
    const missing = SHOPIFY_SCOPES.filter((s) => !tokens.scopes.includes(s));
    const failure =
      missing.length > 0
        ? `Shopify did not grant ${missing.join(' and ')} with the new approval, and HyFib's earlier access ended with it. Connect the store again and approve everything HyFib asks for.`
        : null;
    const credentials: StoreCredentials = {
      kind: 'shopify_token',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      refreshExpiresAt: tokens.refreshExpiresInSeconds
        ? this.at(tokens.refreshExpiresInSeconds * 1000).toISOString()
        : null,
    };
    const [row] = await deps.db.run(scope, (tx) =>
      tx
        .update(commerceStores)
        .set({
          credentialsCiphertext: sealStoreCredentials(
            deps.keyring,
            scope.tenantId,
            store.id,
            credentials,
          ),
          credentialsVersion: store.credentialsVersion + 1,
          accessExpiresAt: tokens.expiresInSeconds ? this.at(tokens.expiresInSeconds * 1000) : null,
          grantedScopes: tokens.scopes.join(',').slice(0, 500),
          accessCodeCiphertext: null,
          accessError: failure ?? accessShortfall(store, tokens.scopes),
          // New access may allow more webhooks (the shipment topics): check them in this run.
          webhooksCheckedAt: null,
        })
        .where(
          and(
            where(scope, store.id),
            eq(commerceStores.credentialsVersion, store.credentialsVersion),
            eq(commerceStores.accessCodeCiphertext, ciphertext),
            eq(commerceStores.state, 'connected'),
          ),
        )
        .returning(),
    );
    if (!row) return null;
    this.store = row;
    await this.audit('commerce.store_access_updated');
    return failure;
  }

  // Removal ------------------------------------------------------------------------------------------

  /**
   * Removes HyFib from the store as far as the store allows (Shopify: uninstall, SH-028;
   * WooCommerce: delete HyFib's webhooks, as keys cannot be revoked through the API), then deletes
   * the store and everything read from it. A store that cannot be reached is removed here anyway
   * after half an hour, and the audit entry says what could not be done at the store.
   */
  private async remove(): Promise<StoreJobOutcome> {
    const { deps, scope, store } = this;
    let remote: StoreRemoteRemoval = 'done';
    try {
      const credentials = readStoreCredentials(deps.keyring, store);
      if (store.platform === 'shopify') {
        const token = await this.shopifyToken();
        if (typeof token === 'string' && token !== 'refused' && token !== 'changed') {
          await new ShopifyAdmin(
            deps.egress,
            deps.shopify as ShopifyAppConfig,
            store.shopDomain as string,
            token,
          ).uninstall();
        } else {
          remote = 'no_access';
        }
      } else if (credentials?.kind === 'woo_keys' && store.webhookPublicId) {
        const woo = new WooStore(deps.egress, store.storeUrl, credentials);
        const uri = wooWebhookUri(deps.appBaseUrl, store.webhookPublicId);
        for (const hook of await woo.webhooks()) {
          if (hook.deliveryUrl === uri) await woo.deleteWebhook(hook.id);
        }
      } else {
        remote = 'no_access';
      }
    } catch (error) {
      if (!(error instanceof StoreApiError)) throw error;
      const deadlinePassed =
        store.connectExpiresAt !== null && store.connectExpiresAt.getTime() < this.now.getTime();
      if (['unreachable', 'server', 'throttled'].includes(error.failure) && !deadlinePassed) {
        await this.finish({ statusError: error.message.slice(0, 500) });
        return 'retry';
      }
      remote = ['unreachable', 'server', 'throttled'].includes(error.failure)
        ? 'unreachable'
        : 'no_access';
    }
    this.remote = remote;
    await deps.db.run(scope, async (tx) => {
      await tx
        .delete(commerceStores)
        .where(and(where(scope, store.id), eq(commerceStores.state, 'removing')));
      await recordSystemAudit(tx, scope.tenantId, {
        action: 'commerce.store_removed',
        subjectType: 'commerce_store',
        subjectId: store.id,
        metadata: { platform: store.platform, remote },
      });
    });
    this.released = true;
    return 'removed';
  }

  private async audit(action: string) {
    await this.deps.db.run(this.scope, (tx) =>
      recordSystemAudit(tx, this.scope.tenantId, {
        action,
        subjectType: 'commerce_store',
        subjectId: this.store.id,
        metadata: { platform: this.store.platform },
      }),
    );
  }
}

interface ReadResult {
  complete: boolean;
  cursor: Date | null;
  page: string | null;
  waitSeconds: number | null;
}

interface ReadPage<T> {
  items: T[];
  /** The page token for the next page, or null when this was the last. */
  next: string | null;
  /** Set when the store asked HyFib to slow down before the next page. */
  waitSeconds: number | null;
}

/** What the worker needs from either platform. */
interface StoreClient {
  batch: number;
  /** Whether orders were read (then `withheld` says if Shopify withheld customer fields). */
  readOrders: boolean;
  withheld: boolean;
  ordersPage(since: Date, page: string | null): Promise<ReadPage<StoreOrderRecord>>;
  productsPage(since: Date, page: string | null): Promise<ReadPage<StoreProductRecord>>;
  ordersById(ids: string[]): Promise<Map<string, StoreOrderRecord>>;
  productsById(ids: string[]): Promise<Map<string, StoreProductRecord>>;
  /** Makes sure HyFib's webhooks exist; returns what is wrong, or null. */
  ensureWebhooks(appBaseUrl: string, store: StoreRow, keyring: Keyring): Promise<string | null>;
  /** Checkouts updated since `since` (Shopify only, SH-038). */
  checkoutsPage?(
    since: Date,
    page: string | null,
    withCustomers: boolean,
  ): Promise<ReadPage<StoreCheckoutRecord>>;
}

function shopifyStoreClient(admin: ShopifyAdmin): StoreClient {
  const client: StoreClient = {
    batch: STORE_LIMITS.shopifyNodesPage,
    readOrders: false,
    withheld: false,
    async ordersPage(since, page) {
      const result = await admin.ordersPage(since, page);
      client.readOrders = true;
      client.withheld ||= result.withheld;
      return shopifyPage(result);
    },
    async productsPage(since, page) {
      const result = await admin.productsPage(since, page);
      return shopifyPage(result);
    },
    async ordersById(ids) {
      const result = await admin.ordersById(ids);
      client.readOrders = true;
      client.withheld ||= result.withheld;
      return result.items;
    },
    async productsById(ids) {
      return (await admin.productsById(ids)).items;
    },
    ensureWebhooks: (appBaseUrl, store) =>
      ensureShopifyWebhooks(admin, shopifyWebhookUri(appBaseUrl), store.grantedScopes),
    async checkoutsPage(since, page, withCustomers) {
      return shopifyPage(await admin.checkoutsPage(since, page, withCustomers));
    },
  };
  return client;
}

function shopifyPage<T>(result: {
  items: T[];
  hasNext: boolean;
  endCursor: string | null;
  throttle: { requested: number; available: number; restoreRate: number } | null;
}): ReadPage<T> {
  const next = result.hasNext && result.endCursor ? result.endCursor : null;
  // Stop before the bucket runs dry rather than be refused (SH-011).
  const low = result.throttle !== null && result.throttle.available < result.throttle.requested;
  return {
    items: result.items,
    next,
    waitSeconds:
      next && low ? throttleWaitSeconds(result.throttle, result.throttle?.requested ?? 0) : null,
  };
}

function wooStoreClient(woo: WooStore, currency: string | null): StoreClient {
  const pageNumber = (page: string | null) =>
    page && /^[0-9]{1,6}$/.test(page) ? Number(page) : 1;
  return {
    batch: STORE_LIMITS.wooProductsPage,
    readOrders: false,
    withheld: false,
    async ordersPage(since, page) {
      const n = pageNumber(page);
      // modified_after is exclusive: one second earlier keeps the cursor's own second (WC-007).
      const result = await woo.ordersPage(new Date(since.getTime() - 1000), n, currency);
      return {
        items: result.items,
        next: result.hasNext ? String(n + 1) : null,
        waitSeconds: null,
      };
    },
    async productsPage(since, page) {
      const n = pageNumber(page);
      const result = await woo.productsPage(new Date(since.getTime() - 1000), n, currency);
      return {
        items: result.items,
        next: result.hasNext ? String(n + 1) : null,
        waitSeconds: null,
      };
    },
    ordersById: (ids) => woo.ordersById(ids, currency),
    productsById: (ids) => woo.productsById(ids, currency),
    ensureWebhooks: async (appBaseUrl, store, keyring) => {
      if (!store.webhookPublicId || !store.webhookSecretCiphertext)
        return 'The store has no webhook address.';
      const secret = keyring.decryptString(
        store.webhookSecretCiphertext,
        storeWebhookSecretAad(store.tenantId, store.id),
      );
      return ensureWooWebhooks(
        woo,
        wooWebhookUri(appBaseUrl, store.webhookPublicId),
        secret,
        false,
      );
    },
  };
}

/**
 * Creates the subscriptions Shopify is missing (it deletes them after repeated failures, SH-025).
 * The same check brings stores connected before the shipment webhooks up to date (ADR-413): once a
 * store's token was granted `read_fulfillments` (SH-044), the two shipment topics are created like
 * any missing one, and a topic already there is never created twice. Shopify refusing a shipment
 * topic does not stop the store: shipments are read with the order anyway, and the reason is shown.
 */
async function ensureShopifyWebhooks(
  admin: ShopifyAdmin,
  uri: string,
  grantedScopes: string | null,
): Promise<string | null> {
  const existing = new Set(await admin.webhookTopics(uri));
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    if (!existing.has(topic)) await admin.createWebhook(topic, uri);
  }
  if (!hasShipmentAccess(grantedScopes)) return null;
  try {
    for (const topic of SHOPIFY_SHIPMENT_TOPICS) {
      if (!existing.has(topic)) await admin.createWebhook(topic, uri);
    }
  } catch (error) {
    if (!(error instanceof StoreApiError) || error.failure !== 'rejected') throw error;
    return `${error.message.slice(0, 300)} HyFib reads shipments with their orders instead.`;
  }
  return null;
}

/**
 * Creates HyFib's missing webhooks and re-enables disabled ones (WooCommerce disables a webhook
 * after more than five failed deliveries and never retries, WC-018). While connecting, a key that
 * cannot create webhooks fails the connection; later, the problem is shown instead.
 */
async function ensureWooWebhooks(
  woo: WooStore,
  uri: string,
  secret: string,
  connecting: boolean,
): Promise<string | null> {
  try {
    const hooks = (await woo.webhooks()).filter((hook) => hook.deliveryUrl === uri);
    for (const topic of WOO_WEBHOOK_TOPICS) {
      const found = hooks.filter((hook) => hook.topic === topic);
      if (found.length === 0) await woo.createWebhook(topic, uri, secret);
      for (const hook of found) if (hook.status !== 'active') await woo.activateWebhook(hook.id);
    }
    return null;
  } catch (error) {
    if (connecting || !(error instanceof StoreApiError) || error.failure !== 'unauthorized')
      throw error;
    return 'The keys cannot manage webhooks (they need Read/Write access); HyFib reads changes every hour instead.';
  }
}

/**
 * What an approval for more access did not grant, said on the store's page: customer access only
 * when it was asked for, and shipment access (which every approval asks for). Null when nothing is
 * missing.
 */
export function accessShortfall(
  store: Pick<StoreRow, 'customerAccessRequestedAt'>,
  scopes: readonly string[],
): string | null {
  const missing: string[] = [];
  if (store.customerAccessRequestedAt !== null && !scopes.includes(SHOPIFY_CUSTOMER_SCOPE)) {
    missing.push('Shopify did not grant access to customers. The store keeps working without it.');
  }
  if (!hasShipmentAccess(scopes.join(','))) {
    missing.push(
      `Shopify did not grant access to shipment updates (${SHOPIFY_FULFILLMENT_SCOPE}): HyFib reads shipments with their orders instead.`,
    );
  }
  return missing.length > 0 ? missing.join(' ') : null;
}

function connectFailureMessage(platform: StoreRow['platform'], error: StoreApiError): string {
  if (platform === 'shopify') {
    if (error.failure === 'rejected' || error.failure === 'unauthorized') {
      return 'Shopify did not accept the approval (it may have expired). Connect the store again.';
    }
    return `Shopify’s answer could not be used: ${error.message}`;
  }
  switch (error.failure) {
    case 'unauthorized':
      return 'WooCommerce refused the keys. They need Read/Write access; connect the store again.';
    case 'not_found':
      return error.message;
    case 'address':
      return `HyFib cannot connect to this address: ${error.message}`;
    case 'malformed':
      return 'The address did not answer like a WooCommerce store.';
    default:
      return `The store refused the request: ${error.message}`;
  }
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

// Saving -------------------------------------------------------------------------------------------

const milestonesOf = (row: {
  placedAt: Date;
  status: string;
  cancelledAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  cashOnDelivery: boolean;
  test: boolean;
}): OrderMilestones => ({
  placedAt: row.placedAt,
  cancelled: row.status === 'cancelled',
  cancelledAt: row.cancelledAt,
  shippedAt: row.shippedAt,
  deliveredAt: row.deliveredAt,
  cashOnDelivery: row.cashOnDelivery,
  test: row.test,
});

/**
 * Upserts orders read from the store. A copy never moves backwards (older `updated_at` is ignored);
 * redacted orders keep their customer details and tracking empty, and so do orders of numbers
 * suppressed because their contact was erased. Lines are replaced with the order. Returns the orders
 * whose copy changed, with their milestones before and after, for order messages.
 */
export async function saveStoreOrders(
  tx: Tx,
  store: Pick<StoreRow, 'id' | 'tenantId' | 'phoneCallingCode'>,
  records: StoreOrderRecord[],
  now: Date,
): Promise<SavedOrderChange[]> {
  if (records.length === 0) return [];
  const phones = records.map((r) => storeCustomerPhone(r.customerPhone, store.phoneCallingCode));
  const distinct = [...new Set(phones.filter((p): p is string => p !== null))];
  const erased = new Set(
    distinct.length === 0
      ? []
      : (
          await tx
            .select({ phone: suppressions.phoneE164 })
            .from(suppressions)
            .where(
              and(
                eq(suppressions.tenantId, store.tenantId),
                eq(suppressions.reason, 'erased'),
                inArray(suppressions.phoneE164, distinct),
              ),
            )
        ).map((r) => r.phone),
  );
  // The copy before this read (the store's lease keeps other writers of orders away).
  const before = new Map(
    (
      await tx
        .select({
          externalId: commerceStoreOrders.externalId,
          placedAt: commerceStoreOrders.placedAt,
          status: commerceStoreOrders.status,
          cancelledAt: commerceStoreOrders.cancelledAt,
          shippedAt: commerceStoreOrders.shippedAt,
          deliveredAt: commerceStoreOrders.deliveredAt,
          cashOnDelivery: commerceStoreOrders.cashOnDelivery,
          test: commerceStoreOrders.test,
        })
        .from(commerceStoreOrders)
        .where(
          and(
            eq(commerceStoreOrders.tenantId, store.tenantId),
            eq(commerceStoreOrders.storeId, store.id),
            inArray(
              commerceStoreOrders.externalId,
              records.map((r) => r.externalId),
            ),
          ),
        )
    ).map((row) => [row.externalId, row]),
  );
  const changes: SavedOrderChange[] = [];
  for (const [index, record] of records.entries()) {
    const phone = phones[index] ?? null;
    const redact = phone !== null && erased.has(phone);
    const [row] = await tx
      .insert(commerceStoreOrders)
      .values({
        id: uuidv7(),
        tenantId: store.tenantId,
        storeId: store.id,
        externalId: record.externalId,
        name: record.name,
        status: record.status,
        financialStatus: record.financialStatus,
        fulfillmentStatus: record.fulfillmentStatus,
        test: record.test,
        currency: record.currency,
        totalMinor: record.currency ? record.totalMinor : null,
        itemsTruncated: record.itemsTruncated,
        placedAt: record.placedAt,
        cancelledAt: record.cancelledAt,
        remoteUpdatedAt: record.remoteUpdatedAt,
        customerName: redact ? null : record.customerName,
        customerPhone: redact ? null : phone,
        customerEmail: redact ? null : record.customerEmail,
        statusUrl: redact ? null : record.statusUrl,
        paymentNames: record.paymentNames,
        cashOnDelivery: record.cashOnDelivery,
        shippedAt: record.shippedAt,
        deliveredAt: record.deliveredAt,
        trackingCompany: record.trackingCompany,
        trackingNumber: redact ? null : record.trackingNumber,
        trackingUrl: redact ? null : record.trackingUrl,
        trackedAt: now,
        redactedAt: redact ? now : null,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          commerceStoreOrders.tenantId,
          commerceStoreOrders.storeId,
          commerceStoreOrders.externalId,
        ],
        set: {
          name: sql`excluded.name`,
          status: sql`excluded.status`,
          financialStatus: sql`excluded.financial_status`,
          fulfillmentStatus: sql`excluded.fulfillment_status`,
          test: sql`excluded.test`,
          currency: sql`excluded.currency`,
          totalMinor: sql`excluded.total_minor`,
          itemsTruncated: sql`excluded.items_truncated`,
          placedAt: sql`excluded.placed_at`,
          cancelledAt: sql`excluded.cancelled_at`,
          remoteUpdatedAt: sql`excluded.remote_updated_at`,
          customerName: sql`case when ${commerceStoreOrders.redactedAt} is null then excluded.customer_name end`,
          customerPhone: sql`case when ${commerceStoreOrders.redactedAt} is null then excluded.customer_phone end`,
          customerEmail: sql`case when ${commerceStoreOrders.redactedAt} is null then excluded.customer_email end`,
          statusUrl: sql`case when ${commerceStoreOrders.redactedAt} is null then excluded.status_url end`,
          paymentNames: sql`excluded.payment_names`,
          cashOnDelivery: sql`excluded.cash_on_delivery`,
          shippedAt: sql`excluded.shipped_at`,
          deliveredAt: sql`excluded.delivered_at`,
          trackingCompany: sql`excluded.tracking_company`,
          trackingNumber: sql`case when ${commerceStoreOrders.redactedAt} is null then excluded.tracking_number end`,
          trackingUrl: sql`case when ${commerceStoreOrders.redactedAt} is null then excluded.tracking_url end`,
          trackedAt: now,
          redactedAt: sql`coalesce(${commerceStoreOrders.redactedAt}, excluded.redacted_at)`,
          deletedAt: null,
          syncedAt: now,
        },
        setWhere: sql`${commerceStoreOrders.remoteUpdatedAt} <= excluded.remote_updated_at`,
      })
      .returning({ id: commerceStoreOrders.id, redactedAt: commerceStoreOrders.redactedAt });
    if (!row) continue;
    const previous = before.get(record.externalId);
    changes.push({
      orderId: row.id,
      // An order the store deleted and brought back is not new again.
      previous: previous ? milestonesOf(previous) : null,
      current: milestonesOf(record),
      shipments: await saveOrderShipments(tx, store, row, record, now),
    });
    await tx
      .delete(commerceStoreOrderItems)
      .where(
        and(
          eq(commerceStoreOrderItems.tenantId, store.tenantId),
          eq(commerceStoreOrderItems.orderId, row.id),
        ),
      );
    if (record.items.length > 0) {
      await tx.insert(commerceStoreOrderItems).values(
        record.items.slice(0, STORE_LIMITS.orderItems).map((item, position) => ({
          id: uuidv7(),
          tenantId: store.tenantId,
          orderId: row.id,
          position: position + 1,
          title: item.title,
          sku: item.sku,
          quantity: item.quantity,
          totalMinor: record.currency ? item.totalMinor : null,
        })),
      );
    }
  }
  return changes;
}

/**
 * Upserts the shipments read with an order (ADR-413), never backwards (an older `updatedAt` than the
 * one kept is ignored), under row locks on the copies already there, so two reads of the same
 * shipment (a webhook delivered twice, a read racing the transit check) agree on what is new. A
 * redacted order's shipments keep no tracking. Returns each shipment saved: whether HyFib saw it
 * for the first time and, when its tracking is one not seen for it before, that tracking's number.
 */
async function saveOrderShipments(
  tx: Tx,
  store: Pick<StoreRow, 'id' | 'tenantId'>,
  order: { id: string; redactedAt: Date | null },
  record: StoreOrderRecord,
  now: Date,
): Promise<SavedShipmentChange[]> {
  const shipments: StoreShipmentRecord[] = record.shipments;
  if (shipments.length === 0) return [];
  const known = new Map(
    (
      await tx
        .select({
          externalId: commerceStoreShipments.externalId,
          orderId: commerceStoreShipments.orderId,
          trackingKeys: commerceStoreShipments.trackingKeys,
        })
        .from(commerceStoreShipments)
        .where(
          and(
            eq(commerceStoreShipments.tenantId, store.tenantId),
            eq(commerceStoreShipments.storeId, store.id),
            inArray(
              commerceStoreShipments.externalId,
              shipments.map((s) => s.externalId),
            ),
          ),
        )
        .for('update')
    ).map((row) => [row.externalId, row]),
  );
  const redacted = order.redactedAt !== null;
  const saved: SavedShipmentChange[] = [];
  for (const shipment of shipments) {
    const previous = known.get(shipment.externalId);
    // A fulfillment belongs to one order; one HyFib holds under another order is left alone.
    if (previous && previous.orderId !== order.id) continue;
    const next = redacted
      ? { keys: [], revision: null }
      : nextTrackingKeys(
          previous ? previous.trackingKeys : null,
          shipmentTrackingKey(shipment.trackingNumber, shipment.trackingUrl),
        );
    const [row] = await tx
      .insert(commerceStoreShipments)
      .values({
        id: uuidv7(),
        tenantId: store.tenantId,
        storeId: store.id,
        orderId: order.id,
        externalId: shipment.externalId,
        status: shipment.status,
        displayStatus: shipment.displayStatus,
        failed: shipment.failed,
        remoteCreatedAt: shipment.createdAt,
        remoteUpdatedAt: shipment.updatedAt,
        trackingCompany: shipment.trackingCompany,
        trackingNumber: redacted ? null : shipment.trackingNumber,
        trackingUrl: redacted ? null : shipment.trackingUrl,
        trackingKeys: next.keys,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          commerceStoreShipments.tenantId,
          commerceStoreShipments.storeId,
          commerceStoreShipments.externalId,
        ],
        set: {
          status: sql`excluded.status`,
          displayStatus: sql`excluded.display_status`,
          failed: sql`excluded.failed`,
          remoteCreatedAt: sql`excluded.remote_created_at`,
          remoteUpdatedAt: sql`excluded.remote_updated_at`,
          trackingCompany: sql`excluded.tracking_company`,
          trackingNumber: sql`excluded.tracking_number`,
          trackingUrl: sql`excluded.tracking_url`,
          trackingKeys: sql`excluded.tracking_keys`,
          syncedAt: now,
        },
        setWhere: sql`${commerceStoreShipments.remoteUpdatedAt} <= excluded.remote_updated_at
          and ${commerceStoreShipments.orderId} = excluded.order_id`,
      })
      .returning({
        id: commerceStoreShipments.id,
        // A row this statement inserted (rather than updated) has no deleting transaction.
        inserted: sql<boolean>`(xmax = 0)`,
      });
    if (!row) continue;
    saved.push({
      shipmentId: row.id,
      orderId: order.id,
      isNew: row.inserted,
      trackingRevision: row.inserted ? null : next.revision,
      current: {
        createdAt: shipment.createdAt,
        updatedAt: shipment.updatedAt,
        failed: shipment.failed,
      },
      test: record.test,
      orderCancelled: record.status === 'cancelled',
    });
  }
  return saved;
}

/**
 * Upserts products read from the store (never backwards). New products stop being added at
 * HyFib's limit per store, and the store is marked as truncated; known products keep updating.
 */
export async function saveStoreProducts(
  tx: Tx,
  store: Pick<StoreRow, 'id' | 'tenantId'>,
  records: StoreProductRecord[],
  now: Date,
): Promise<void> {
  if (records.length === 0) return;
  const known = new Set(
    (
      await tx
        .select({ externalId: commerceStoreProducts.externalId })
        .from(commerceStoreProducts)
        .where(
          and(
            eq(commerceStoreProducts.tenantId, store.tenantId),
            eq(commerceStoreProducts.storeId, store.id),
            inArray(
              commerceStoreProducts.externalId,
              records.map((r) => r.externalId),
            ),
          ),
        )
    ).map((r) => r.externalId),
  );
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(commerceStoreProducts)
    .where(
      and(
        eq(commerceStoreProducts.tenantId, store.tenantId),
        eq(commerceStoreProducts.storeId, store.id),
      ),
    );
  let room = STORE_LIMITS.productsPerStore - count;
  let truncated = false;
  const accepted = records.filter((record) => {
    if (known.has(record.externalId)) return true;
    if (room > 0) {
      room -= 1;
      return true;
    }
    truncated = true;
    return false;
  });
  for (const record of accepted) {
    await tx
      .insert(commerceStoreProducts)
      .values({
        id: uuidv7(),
        tenantId: store.tenantId,
        storeId: store.id,
        externalId: record.externalId,
        title: record.title,
        status: record.status,
        sku: record.sku,
        url: record.url,
        currency: record.currency,
        priceMinMinor: record.priceMinMinor,
        priceMaxMinor: record.priceMaxMinor,
        inventory: record.inventory,
        variants: record.variants,
        remoteUpdatedAt: record.remoteUpdatedAt,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          commerceStoreProducts.tenantId,
          commerceStoreProducts.storeId,
          commerceStoreProducts.externalId,
        ],
        set: {
          title: sql`excluded.title`,
          status: sql`excluded.status`,
          sku: sql`excluded.sku`,
          url: sql`excluded.url`,
          currency: sql`excluded.currency`,
          priceMinMinor: sql`excluded.price_min_minor`,
          priceMaxMinor: sql`excluded.price_max_minor`,
          inventory: sql`excluded.inventory`,
          variants: sql`excluded.variants`,
          remoteUpdatedAt: sql`excluded.remote_updated_at`,
          deletedAt: null,
          syncedAt: now,
        },
        setWhere: sql`${commerceStoreProducts.remoteUpdatedAt} <= excluded.remote_updated_at`,
      });
  }
  if (truncated) {
    await tx
      .update(commerceStores)
      .set({ productsTruncated: true })
      .where(and(eq(commerceStores.tenantId, store.tenantId), eq(commerceStores.id, store.id)));
  }
}

// Sweep --------------------------------------------------------------------------------------------

/** Stores with work due (minute sweep; active companies only, from a SECURITY DEFINER query). */
export async function findDueStoreWork(db: Database, limit = 50) {
  const res = await db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; store_id: string }>(
        sql`select tenant_id, store_id from ops.commerce_store_work_due(${limit})`,
      ),
    { accessMode: 'read only' },
  );
  return res.rows.map((r) => ({ tenantId: r.tenant_id, storeId: r.store_id }));
}
