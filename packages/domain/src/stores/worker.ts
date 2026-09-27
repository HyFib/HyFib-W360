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
import { StoreApiError } from './http';
import {
  STORE_LIMITS,
  SHOPIFY_SCOPES,
  storeCredentialsAad,
  storeCredentialsSchema,
  storeCustomerPhone,
  storeWebhookSecretAad,
  type StoreCredentials,
  type StoreOrderRecord,
  type StoreProductRecord,
} from './model';
import {
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

class StoreJob {
  released = false;

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
        if (pending || (next && next.getTime() <= this.now.getTime())) {
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
    const webhookError = await ensureShopifyWebhooks(admin, shopifyWebhookUri(deps.appBaseUrl));
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
    const { store } = this;
    try {
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
      const update: StoreUpdate = { syncError: null };
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
      await saveStoreOrders(tx, store, orders, this.now);
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
      await deps.db.run(scope, (tx) =>
        kind === 'orders'
          ? saveStoreOrders(tx, store, result.items as StoreOrderRecord[], this.now)
          : saveStoreProducts(tx, store, result.items as StoreProductRecord[], this.now),
      );
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

  private async pruneEvents() {
    const { deps, scope, store } = this;
    await deps.db.run(scope, (tx) =>
      tx
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
        ),
    );
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
    let remote: 'done' | 'no_access' | 'unreachable' = 'done';
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
    ensureWebhooks: (appBaseUrl) => ensureShopifyWebhooks(admin, shopifyWebhookUri(appBaseUrl)),
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

/** Creates the subscriptions Shopify is missing (it deletes them after repeated failures, SH-025). */
async function ensureShopifyWebhooks(admin: ShopifyAdmin, uri: string): Promise<string | null> {
  const existing = new Set(await admin.webhookTopics(uri));
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    if (!existing.has(topic)) await admin.createWebhook(topic, uri);
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

/**
 * Upserts orders read from the store. A copy never moves backwards (older `updated_at` is ignored);
 * redacted orders keep their customer details empty, and so do orders of numbers suppressed because
 * their contact was erased. Lines are replaced with the order.
 */
export async function saveStoreOrders(
  tx: Tx,
  store: Pick<StoreRow, 'id' | 'tenantId' | 'phoneCallingCode'>,
  records: StoreOrderRecord[],
  now: Date,
): Promise<void> {
  if (records.length === 0) return;
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
          redactedAt: sql`coalesce(${commerceStoreOrders.redactedAt}, excluded.redacted_at)`,
          deletedAt: null,
          syncedAt: now,
        },
        setWhere: sql`${commerceStoreOrders.remoteUpdatedAt} <= excluded.remote_updated_at`,
      })
      .returning({ id: commerceStoreOrders.id });
    if (!row) continue;
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
