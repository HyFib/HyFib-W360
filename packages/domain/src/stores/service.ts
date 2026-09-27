import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock, type Keyring } from '@w360/core';
import {
  and,
  asc,
  authorizedTenantScope,
  commerceStoreFetches,
  commerceStoreOrderItems,
  commerceStoreOrders,
  commerceStorePrivacyRequests,
  commerceStoreProducts,
  commerceStores,
  contacts,
  conversations,
  desc,
  eq,
  gt,
  isNull,
  isUniqueViolation,
  lt,
  or,
  outerColumn,
  sql,
  systemScope,
  type Database,
  type Tx,
} from '@w360/db';
import { recordAudit, recordSystemAudit, type RequestMeta } from '../audit';
import { assertCan, can, type TenantContext } from '../authz/context';
import { CALLING_CODE_RE } from '../contacts/phone';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { canSeeConversation } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, likePattern, parseInput } from '../validation';
import {
  CONNECT_TOKEN_RE,
  SHOP_DOMAIN_RE,
  STORE_LIMITS,
  WOO_CONSUMER_KEY_RE,
  WOO_CONSUMER_SECRET_RE,
  connectTokenHash,
  newConnectToken,
  newStoreWebhookId,
  newStoreWebhookSecret,
  normalizeShopDomain,
  normalizeStoreUrl,
  shopifyAuthorizeUrl,
  storeWebhookSecretAad,
  verifyShopifyCallback,
  wooAuthorizeUrl,
} from './model';
import { shopOrigin, type ShopifyAppConfig } from './shopify';
import { enqueueStoreJob, sealStoreCredentials } from './worker';

/**
 * Store connectors (P4-06b). Seeing stores, their orders and products needs `commerce.read` (orders
 * carry customer details, so `contacts.read` too); connecting, syncing and removing stores need
 * `commerce.manage`. Everything done at a store is written ahead here and performed by the worker;
 * the only data that reaches HyFib from a browser is Shopify's signed callback, and the only data
 * from a store without a member's session is WooCommerce's key handover, which is trusted only once
 * the keys work against the address the member entered.
 */

export interface StoreServiceDeps {
  db: Database;
  clock: Clock;
  jobs: JobQueue;
  signer: JobSigner;
  keyring: Keyring;
  appBaseUrl: string;
  /** HyFib's Shopify app (null until configured) and the secrets its signatures may use. */
  shopify: (ShopifyAppConfig & { secrets: readonly string[] }) | null;
  /** http:// store addresses, only for local test stand-ins (APP_ENV=local|test). */
  allowHttpStores: boolean;
}

export const STORE_APP_NAME = 'HyFib W360';

const MINUTE = 60_000;

const callingCode = z
  .string()
  .trim()
  .transform((v) => v.replace(/^\+/, ''))
  .refine((v) => v === '' || CALLING_CODE_RE.test(v), 'Enter a country calling code such as 91.')
  .optional();

const shopifySchema = z.object({ shop: z.string().max(300), callingCode });
const wooSchema = z.object({ url: z.string().max(300), callingCode });
const wooKeysSchema = wooSchema.extend({
  consumerKey: z
    .string()
    .trim()
    .regex(WOO_CONSUMER_KEY_RE, 'Enter the consumer key (it starts with ck_).'),
  consumerSecret: z
    .string()
    .trim()
    .regex(WOO_CONSUMER_SECRET_RE, 'Enter the consumer secret (it starts with cs_).'),
});
const idSchema = z.object({ id: z.uuid() });
const settingsSchema = idSchema.extend({ callingCode });
const listSchema = z.object({
  storeId: z.uuid(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(200).optional(),
});

/** WooCommerce's key handover body (WC-003). */
const keyHandoverSchema = z.object({
  key_id: z.number().int().positive().optional(),
  user_id: z.string().regex(CONNECT_TOKEN_RE),
  consumer_key: z.string().regex(WOO_CONSUMER_KEY_RE),
  consumer_secret: z.string().regex(WOO_CONSUMER_SECRET_RE),
  key_permissions: z.string(),
});

const invalid = (path: string, message: string) =>
  new AppError('validation_failed', message, { issues: [{ path, message }] });

/** The product list's paging cursor: the last product's title and id (the list's order). */
function decodeTitleCursor(value: string | undefined): [string, string] | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  if (
    !Array.isArray(parsed) ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(parsed[1])
  ) {
    throw new AppError('validation_failed', 'Invalid cursor.');
  }
  return [parsed[0], parsed[1]];
}

export type ShopifyCallbackResult =
  | { ok: true; tenantSlug: string; storeId: string; tokenHash: string; code: string; shop: string }
  | { ok: false; reason: 'not_configured' | 'bad_signature' | 'bad_request' | 'unknown_state' };

export function createStoreService(deps: StoreServiceDeps) {
  const { db } = deps;

  const storeWhere = (ctx: TenantContext, id: string) =>
    and(eq(commerceStores.tenantId, ctx.tenant.id), eq(commerceStores.id, id));

  const enqueue = (tx: Tx, ctx: TenantContext, storeId: string) =>
    enqueueStoreJob(
      deps,
      tx,
      ctx.tenant.id,
      storeId,
      `store:${storeId}:${deps.clock.now().getTime()}`,
      ctx.user.id,
    );

  async function lockStore(tx: Tx, ctx: TenantContext, id: string) {
    const [store] = await tx.select().from(commerceStores).where(storeWhere(ctx, id)).for('update');
    if (!store) throw notFound('Store not found.');
    return store;
  }

  async function assertRoom(tx: Tx, ctx: TenantContext) {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(commerceStores)
      .where(eq(commerceStores.tenantId, ctx.tenant.id));
    if (n >= STORE_LIMITS.storesPerCompany) {
      throw new AppError(
        'precondition_failed',
        `A company can connect at most ${STORE_LIMITS.storesPerCompany} stores. Remove one first.`,
      );
    }
  }

  const reconnectable = (state: string) => {
    if (state === 'removing') {
      throw new AppError('conflict', 'This store is being removed. Try again in a few minutes.');
    }
    if (state === 'connected' || state === 'connecting') {
      throw new AppError('conflict', 'This store is already connected.');
    }
  };

  const readable = (ctx: TenantContext) => {
    assertCan(ctx, 'commerce.read');
    // Store orders carry customers' names, numbers and emails.
    assertCan(ctx, 'contacts.read');
  };

  return {
    /** Whether HyFib's Shopify app is configured (WooCommerce needs nothing from HyFib). */
    capabilities() {
      return { shopify: deps.shopify !== null };
    },

    async stores(ctx: TenantContext) {
      assertCan(ctx, 'commerce.read');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: commerceStores.id,
              platform: commerceStores.platform,
              name: commerceStores.name,
              storeUrl: commerceStores.storeUrl,
              shopDomain: commerceStores.shopDomain,
              state: commerceStores.state,
              statusError: commerceStores.statusError,
              syncError: commerceStores.syncError,
              webhookError: commerceStores.webhookError,
              syncedAt: commerceStores.syncedAt,
              backfilledAt: commerceStores.backfilledAt,
              createdAt: commerceStores.createdAt,
              orders: sql<number>`(select count(*)::int from ${commerceStoreOrders} o
                where o.tenant_id = ${outerColumn(commerceStores.tenantId)}
                  and o.store_id = ${outerColumn(commerceStores.id)} and o.deleted_at is null)`,
              products: sql<number>`(select count(*)::int from ${commerceStoreProducts} p
                where p.tenant_id = ${outerColumn(commerceStores.tenantId)}
                  and p.store_id = ${outerColumn(commerceStores.id)} and p.deleted_at is null)`,
              openRequests: sql<number>`(select count(*)::int from ${commerceStorePrivacyRequests} r
                where r.tenant_id = ${outerColumn(commerceStores.tenantId)}
                  and r.store_id = ${outerColumn(commerceStores.id)}
                  and r.kind = 'data_request' and r.answered_at is null)`,
            })
            .from(commerceStores)
            .where(eq(commerceStores.tenantId, ctx.tenant.id))
            .orderBy(asc(commerceStores.createdAt)),
        { accessMode: 'read only' },
      );
    },

    async store(ctx: TenantContext, id: string) {
      assertCan(ctx, 'commerce.read');
      const { id: storeId } = parseInput(idSchema, { id });
      return db.run(
        ctx.scope,
        async (tx) => {
          const [store] = await tx
            .select({
              id: commerceStores.id,
              platform: commerceStores.platform,
              name: commerceStores.name,
              storeUrl: commerceStores.storeUrl,
              shopDomain: commerceStores.shopDomain,
              currency: commerceStores.currency,
              state: commerceStores.state,
              statusError: commerceStores.statusError,
              syncError: commerceStores.syncError,
              webhookError: commerceStores.webhookError,
              webhooksCheckedAt: commerceStores.webhooksCheckedAt,
              phoneCallingCode: commerceStores.phoneCallingCode,
              productsTruncated: commerceStores.productsTruncated,
              detailsWithheld: commerceStores.detailsWithheld,
              backfilledAt: commerceStores.backfilledAt,
              syncedAt: commerceStores.syncedAt,
              nextSyncAt: commerceStores.nextSyncAt,
              uninstalledAt: commerceStores.uninstalledAt,
              createdAt: commerceStores.createdAt,
            })
            .from(commerceStores)
            .where(storeWhere(ctx, storeId));
          if (!store) throw notFound('Store not found.');
          const [counts] = await tx
            .select({
              orders: sql<number>`count(*)::int`,
              pending: sql<number>`(select count(*)::int from ${commerceStoreFetches} f
                where f.tenant_id = ${ctx.tenant.id} and f.store_id = ${storeId})`,
            })
            .from(commerceStoreOrders)
            .where(
              and(
                eq(commerceStoreOrders.tenantId, ctx.tenant.id),
                eq(commerceStoreOrders.storeId, storeId),
                isNull(commerceStoreOrders.deletedAt),
              ),
            );
          const manage = can(ctx, 'commerce.manage');
          const requests = await tx
            .select({
              id: commerceStorePrivacyRequests.id,
              kind: commerceStorePrivacyRequests.kind,
              customerEmail: commerceStorePrivacyRequests.customerEmail,
              customerPhone: commerceStorePrivacyRequests.customerPhone,
              orderIds: commerceStorePrivacyRequests.orderIds,
              ordersRedacted: commerceStorePrivacyRequests.ordersRedacted,
              receivedAt: commerceStorePrivacyRequests.receivedAt,
              answeredAt: commerceStorePrivacyRequests.answeredAt,
            })
            .from(commerceStorePrivacyRequests)
            .where(
              and(
                eq(commerceStorePrivacyRequests.tenantId, ctx.tenant.id),
                eq(commerceStorePrivacyRequests.storeId, storeId),
              ),
            )
            .orderBy(desc(commerceStorePrivacyRequests.receivedAt))
            .limit(20);
          return {
            store,
            orders: counts?.orders ?? 0,
            pendingReads: counts?.pending ?? 0,
            // Who asked for their data is shown only to members who can answer it.
            privacyRequests: requests.map((r) =>
              manage ? r : { ...r, customerEmail: null, customerPhone: null },
            ),
            canManage: manage,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * Starts connecting a Shopify store (SH-003): a single-use `state` bound to this member, valid
     * for 15 minutes. A store the company connected before (failed or uninstalled) is reconnected
     * in place, keeping what HyFib read.
     */
    async startShopifyConnect(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      const config = deps.shopify;
      if (!config) throw new AppError('unsupported', 'Shopify is not set up for HyFib yet.');
      const data = parseInput(shopifySchema, input);
      const shopDomain = normalizeShopDomain(data.shop);
      if (!shopDomain) {
        throw invalid('shop', 'Enter your store’s address, for example my-shop.myshopify.com.');
      }
      const { token, hash } = newConnectToken();
      const now = deps.clock.now();
      const connect = {
        state: 'authorizing' as const,
        connectTokenHash: hash,
        connectMembershipId: ctx.membership.id,
        connectExpiresAt: new Date(now.getTime() + STORE_LIMITS.connectMinutes * MINUTE),
        statusError: null,
      };
      try {
        await db.run(ctx.scope, async (tx) => {
          const [existing] = await tx
            .select()
            .from(commerceStores)
            .where(
              and(
                eq(commerceStores.tenantId, ctx.tenant.id),
                eq(commerceStores.platform, 'shopify'),
                eq(commerceStores.shopDomain, shopDomain),
              ),
            )
            .for('update');
          let id: string;
          if (existing) {
            reconnectable(existing.state);
            id = existing.id;
            await tx
              .update(commerceStores)
              .set({
                ...connect,
                ...(data.callingCode !== undefined
                  ? { phoneCallingCode: data.callingCode || null }
                  : {}),
                version: existing.version + 1,
              })
              .where(storeWhere(ctx, id));
          } else {
            await assertRoom(tx, ctx);
            id = uuidv7();
            await tx.insert(commerceStores).values({
              id,
              tenantId: ctx.tenant.id,
              platform: 'shopify',
              shopDomain,
              storeUrl: `https://${shopDomain}`,
              phoneCallingCode: data.callingCode || null,
              createdByMembershipId: ctx.membership.id,
              ...connect,
            });
          }
          await recordAudit(
            tx,
            ctx,
            {
              action: 'commerce.store_connect_started',
              subjectType: 'commerce_store',
              subjectId: id,
              metadata: { platform: 'shopify', shop: shopDomain },
            },
            meta,
          );
        });
      } catch (error) {
        if (isUniqueViolation(error, 'commerce_stores_shop_uq')) {
          throw new AppError(
            'conflict',
            'This Shopify store is connected to another HyFib company. It has to be removed there first.',
          );
        }
        throw error;
      }
      return {
        url: shopifyAuthorizeUrl(shopOrigin(config, shopDomain), {
          clientId: config.clientId,
          redirectUri: `${deps.appBaseUrl}/api/stores/shopify/callback`,
          state: token,
        }),
      };
    },

    /**
     * Checks Shopify's callback before any company context exists (SH-004): the HMAC with HyFib's
     * app secret, the timestamp, the shop's shape and a handshake still waiting. The route then
     * requires the signed-in member who started it (acceptShopifyApproval).
     */
    async shopifyCallback(query: URLSearchParams): Promise<ShopifyCallbackResult> {
      const config = deps.shopify;
      if (!config) return { ok: false, reason: 'not_configured' };
      const check = verifyShopifyCallback(query, config.secrets, deps.clock.now().getTime());
      if (!check.ok) return { ok: false, reason: 'bad_signature' };
      const shop = (query.get('shop') ?? '').toLowerCase();
      const state = query.get('state') ?? '';
      const code = query.get('code') ?? '';
      if (
        !SHOP_DOMAIN_RE.test(shop) ||
        !CONNECT_TOKEN_RE.test(state) ||
        !code ||
        code.length > 512
      ) {
        return { ok: false, reason: 'bad_request' };
      }
      const tokenHash = connectTokenHash(state);
      const res = await db.run(
        systemScope,
        (tx) =>
          tx.execute<{ tenant_slug: string; store_id: string; platform: string }>(
            sql`select tenant_slug, store_id, platform from ops.commerce_store_by_connect(${tokenHash})`,
          ),
        { accessMode: 'read only' },
      );
      const target = res.rows[0];
      if (!target || target.platform !== 'shopify') return { ok: false, reason: 'unknown_state' };
      return {
        ok: true,
        tenantSlug: target.tenant_slug,
        storeId: target.store_id,
        tokenHash,
        code,
        shop,
      };
    },

    /** Finishes the Shopify handshake for the member who started it; the worker exchanges the code. */
    async acceptShopifyApproval(
      ctx: TenantContext,
      input: { storeId: string; tokenHash: string; code: string; shop: string },
      meta: RequestMeta = {},
    ) {
      assertCan(ctx, 'commerce.manage');
      const now = deps.clock.now();
      return db.run(ctx.scope, async (tx) => {
        const store = await lockStore(tx, ctx, input.storeId);
        if (
          store.state !== 'authorizing' ||
          store.platform !== 'shopify' ||
          store.connectTokenHash !== input.tokenHash ||
          !store.connectExpiresAt ||
          store.connectExpiresAt <= now ||
          store.shopDomain !== input.shop
        ) {
          throw new AppError(
            'conflict',
            'This approval is no longer valid. Connect the store again.',
          );
        }
        if (store.connectMembershipId !== ctx.membership.id) {
          throw new AppError(
            'forbidden',
            'Only the member who started connecting this store can finish it.',
          );
        }
        await tx
          .update(commerceStores)
          .set({
            state: 'connecting',
            credentialsCiphertext: sealStoreCredentials(deps.keyring, ctx.tenant.id, store.id, {
              kind: 'shopify_code',
              code: input.code,
            }),
            credentialsVersion: store.credentialsVersion + 1,
            connectTokenHash: null,
            connectMembershipId: null,
            connectExpiresAt: new Date(now.getTime() + STORE_LIMITS.connectingMinutes * MINUTE),
            statusError: null,
            version: store.version + 1,
          })
          .where(storeWhere(ctx, store.id));
        await enqueue(tx, ctx, store.id);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.store_connect_approved',
            subjectType: 'commerce_store',
            subjectId: store.id,
            metadata: { platform: 'shopify', shop: store.shopDomain },
          },
          meta,
        );
        return { storeId: store.id };
      });
    },

    /**
     * Starts connecting a WooCommerce store through its app authentication endpoint (WC-002): the
     * store owner approves Read/Write keys, and WooCommerce posts them to HyFib's callback with the
     * single-use id sent as `user_id`.
     */
    async startWooConnect(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      const data = parseInput(wooSchema, input);
      const url = normalizeStoreUrl(data.url, deps.allowHttpStores);
      if (!url.ok) throw invalid('url', url.message);
      const { token, hash } = newConnectToken();
      const now = deps.clock.now();
      const id = await db.run(ctx.scope, async (tx) => {
        const storeId = await upsertWooStore(tx, ctx, url.url, data.callingCode, {
          state: 'authorizing',
          connectTokenHash: hash,
          connectMembershipId: ctx.membership.id,
          connectExpiresAt: new Date(now.getTime() + STORE_LIMITS.connectMinutes * MINUTE),
          statusError: null,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.store_connect_started',
            subjectType: 'commerce_store',
            subjectId: storeId,
            metadata: { platform: 'woocommerce', url: url.url },
          },
          meta,
        );
        return storeId;
      });
      return {
        storeId: id,
        url: wooAuthorizeUrl(url.url, {
          appName: STORE_APP_NAME,
          userId: token,
          returnUrl: `${deps.appBaseUrl}/c/${ctx.tenant.slug}/commerce/stores/${id}`,
          callbackUrl: `${deps.appBaseUrl}/api/stores/woocommerce/callback`,
        }),
      };
    },

    /**
     * WooCommerce's key handover (WC-003), without a member's session: accepted only for a
     * handshake still waiting and only Read/Write keys; the worker then proves the keys against the
     * store's own address before anything is read. Any status but 200 makes WooCommerce delete the
     * keys again.
     */
    async acceptWooKeys(
      body: unknown,
    ): Promise<{ status: number; outcome: string; tenantId?: string }> {
      const parsed = keyHandoverSchema.safeParse(body);
      if (!parsed.success) return { status: 400, outcome: 'malformed' };
      if (parsed.data.key_permissions !== 'read_write')
        return { status: 400, outcome: 'not_read_write' };
      const tokenHash = connectTokenHash(parsed.data.user_id);
      const res = await db.run(
        systemScope,
        (tx) =>
          tx.execute<{ tenant_id: string; store_id: string; platform: string }>(
            sql`select tenant_id, store_id, platform from ops.commerce_store_by_connect(${tokenHash})`,
          ),
        { accessMode: 'read only' },
      );
      const target = res.rows[0];
      if (!target || target.platform !== 'woocommerce')
        return { status: 404, outcome: 'unknown_handshake' };
      const scope = authorizedTenantScope(target.tenant_id, null);
      const now = deps.clock.now();
      const accepted = await db.run(scope, async (tx) => {
        const [store] = await tx
          .select()
          .from(commerceStores)
          .where(
            and(
              eq(commerceStores.tenantId, scope.tenantId),
              eq(commerceStores.id, target.store_id),
            ),
          )
          .for('update');
        if (
          !store ||
          store.state !== 'authorizing' ||
          store.connectTokenHash !== tokenHash ||
          !store.connectExpiresAt ||
          store.connectExpiresAt <= now
        ) {
          return false;
        }
        await tx
          .update(commerceStores)
          .set({
            state: 'connecting',
            credentialsCiphertext: sealStoreCredentials(deps.keyring, scope.tenantId, store.id, {
              kind: 'woo_keys',
              consumerKey: parsed.data.consumer_key,
              consumerSecret: parsed.data.consumer_secret,
            }),
            credentialsVersion: store.credentialsVersion + 1,
            connectTokenHash: null,
            connectMembershipId: null,
            connectExpiresAt: new Date(now.getTime() + STORE_LIMITS.connectingMinutes * MINUTE),
            statusError: null,
          })
          .where(and(eq(commerceStores.tenantId, scope.tenantId), eq(commerceStores.id, store.id)));
        await enqueueStoreJob(deps, tx, scope.tenantId, store.id, `store:${store.id}:keys`);
        await recordSystemAudit(tx, scope.tenantId, {
          action: 'commerce.store_keys_received',
          subjectType: 'commerce_store',
          subjectId: store.id,
          metadata: { platform: 'woocommerce', keyId: parsed.data.key_id ?? null },
        });
        return true;
      });
      return accepted
        ? { status: 200, outcome: 'accepted', tenantId: target.tenant_id }
        : { status: 404, outcome: 'unknown_handshake' };
    },

    /** Connects a WooCommerce store with keys a member created in WooCommerce (WC-001). */
    async saveWooKeys(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      const data = parseInput(wooKeysSchema, input);
      const url = normalizeStoreUrl(data.url, deps.allowHttpStores);
      if (!url.ok) throw invalid('url', url.message);
      const now = deps.clock.now();
      return db.run(ctx.scope, async (tx) => {
        const storeId = uuidv7();
        const id = await upsertWooStore(
          tx,
          ctx,
          url.url,
          data.callingCode,
          (existingId) => ({
            state: 'connecting',
            credentialsCiphertext: sealStoreCredentials(
              deps.keyring,
              ctx.tenant.id,
              existingId ?? storeId,
              {
                kind: 'woo_keys',
                consumerKey: data.consumerKey,
                consumerSecret: data.consumerSecret,
              },
            ),
            connectTokenHash: null,
            connectMembershipId: null,
            connectExpiresAt: new Date(now.getTime() + STORE_LIMITS.connectingMinutes * MINUTE),
            statusError: null,
          }),
          storeId,
        );
        await enqueue(tx, ctx, id);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.store_keys_saved',
            subjectType: 'commerce_store',
            subjectId: id,
            metadata: { platform: 'woocommerce', url: url.url },
          },
          meta,
        );
        return { storeId: id };
      });
    },

    /**
     * The calling code for customer numbers without one. Orders from the last 60 days are read
     * again so their numbers are linked to contacts under the new setting.
     */
    async updateStoreSettings(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      const data = parseInput(settingsSchema, input);
      const now = deps.clock.now();
      return db.run(ctx.scope, async (tx) => {
        const store = await lockStore(tx, ctx, data.id);
        await tx
          .update(commerceStores)
          .set({
            phoneCallingCode: data.callingCode || null,
            ...(store.state === 'connected'
              ? {
                  ordersCursor: new Date(
                    now.getTime() - STORE_LIMITS.backfillDays * 24 * 60 * MINUTE,
                  ),
                  ordersPage: null,
                  nextSyncAt: now,
                }
              : {}),
            version: store.version + 1,
          })
          .where(storeWhere(ctx, store.id));
        if (store.state === 'connected') await enqueue(tx, ctx, store.id);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.store_settings_saved',
            subjectType: 'commerce_store',
            subjectId: store.id,
            metadata: { callingCode: data.callingCode || null },
          },
          meta,
        );
        return { ok: true as const };
      });
    },

    /** Reads the store again now (and checks HyFib's webhooks). */
    async requestStoreSync(ctx: TenantContext, id: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      const { id: storeId } = parseInput(idSchema, { id });
      return db.run(ctx.scope, async (tx) => {
        const store = await lockStore(tx, ctx, storeId);
        if (store.state !== 'connected') {
          throw new AppError('precondition_failed', 'Only a connected store can be read.');
        }
        await tx
          .update(commerceStores)
          .set({ nextSyncAt: deps.clock.now(), webhooksCheckedAt: null, syncError: null })
          .where(storeWhere(ctx, store.id));
        await enqueue(tx, ctx, store.id);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.store_sync_requested',
            subjectType: 'commerce_store',
            subjectId: store.id,
          },
          meta,
        );
        return { ok: true as const };
      });
    },

    /**
     * Removes a store: the worker removes HyFib from the store as far as it can (Shopify:
     * uninstall; WooCommerce: its webhooks) and deletes everything read from it.
     */
    async removeStore(ctx: TenantContext, id: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      const { id: storeId } = parseInput(idSchema, { id });
      const now = deps.clock.now();
      return db.run(ctx.scope, async (tx) => {
        const store = await lockStore(tx, ctx, storeId);
        if (store.state === 'removing') return { ok: true as const };
        await tx
          .update(commerceStores)
          .set({
            state: 'removing',
            connectTokenHash: null,
            connectMembershipId: null,
            // Removal deadline: past it, the store goes even if it cannot be reached.
            connectExpiresAt: new Date(now.getTime() + 30 * MINUTE),
            version: store.version + 1,
          })
          .where(storeWhere(ctx, store.id));
        await enqueue(tx, ctx, store.id);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.store_remove_requested',
            subjectType: 'commerce_store',
            subjectId: store.id,
            metadata: { platform: store.platform },
          },
          meta,
        );
        return { ok: true as const };
      });
    },

    async storeOrders(ctx: TenantContext, input: unknown) {
      readable(ctx);
      const data = parseInput(listSchema, input);
      const cursor = decodeKeysetCursor(data.cursor);
      const pageSize = 50;
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: commerceStoreOrders.id,
              name: commerceStoreOrders.name,
              status: commerceStoreOrders.status,
              financialStatus: commerceStoreOrders.financialStatus,
              fulfillmentStatus: commerceStoreOrders.fulfillmentStatus,
              test: commerceStoreOrders.test,
              currency: commerceStoreOrders.currency,
              totalMinor: commerceStoreOrders.totalMinor,
              placedAt: commerceStoreOrders.placedAt,
              customerName: commerceStoreOrders.customerName,
              customerPhone: commerceStoreOrders.customerPhone,
              redactedAt: commerceStoreOrders.redactedAt,
            })
            .from(commerceStoreOrders)
            .where(
              and(
                eq(commerceStoreOrders.tenantId, ctx.tenant.id),
                eq(commerceStoreOrders.storeId, data.storeId),
                isNull(commerceStoreOrders.deletedAt),
                data.q
                  ? or(
                      sql`${commerceStoreOrders.name} ilike ${likePattern(data.q)}`,
                      sql`${commerceStoreOrders.customerName} ilike ${likePattern(data.q)}`,
                      sql`${commerceStoreOrders.customerPhone} ilike ${likePattern(data.q)}`,
                      sql`${commerceStoreOrders.customerEmail} ilike ${likePattern(data.q)}`,
                    )
                  : undefined,
                cursor
                  ? or(
                      lt(commerceStoreOrders.placedAt, cursor.at),
                      and(
                        eq(commerceStoreOrders.placedAt, cursor.at),
                        lt(commerceStoreOrders.id, cursor.id),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(commerceStoreOrders.placedAt), desc(commerceStoreOrders.id))
            .limit(pageSize + 1),
        { accessMode: 'read only' },
      );
      const page = rows.slice(0, pageSize);
      const last = page.at(-1);
      return {
        orders: page,
        next: rows.length > pageSize && last ? encodeKeysetCursor(last.placedAt, last.id) : null,
      };
    },

    async storeOrder(ctx: TenantContext, id: string) {
      readable(ctx);
      const { id: orderId } = parseInput(idSchema, { id });
      return db.run(
        ctx.scope,
        async (tx) => {
          const [order] = await tx
            .select({
              order: commerceStoreOrders,
              storeName: commerceStores.name,
              storeUrl: commerceStores.storeUrl,
              platform: commerceStores.platform,
            })
            .from(commerceStoreOrders)
            .innerJoin(
              commerceStores,
              and(
                eq(commerceStores.tenantId, commerceStoreOrders.tenantId),
                eq(commerceStores.id, commerceStoreOrders.storeId),
              ),
            )
            .where(
              and(
                eq(commerceStoreOrders.tenantId, ctx.tenant.id),
                eq(commerceStoreOrders.id, orderId),
              ),
            );
          if (!order) throw notFound('Order not found.');
          const items = await tx
            .select()
            .from(commerceStoreOrderItems)
            .where(
              and(
                eq(commerceStoreOrderItems.tenantId, ctx.tenant.id),
                eq(commerceStoreOrderItems.orderId, orderId),
              ),
            )
            .orderBy(asc(commerceStoreOrderItems.position));
          const phone = order.order.customerPhone;
          const [contact] = phone
            ? await tx
                .select({ id: contacts.id, name: contacts.displayName })
                .from(contacts)
                .where(
                  and(
                    eq(contacts.tenantId, ctx.tenant.id),
                    eq(contacts.phoneE164, phone),
                    isNull(contacts.erasedAt),
                  ),
                )
                .limit(1)
            : [];
          return { ...order, items, contact: contact ?? null };
        },
        { accessMode: 'read only' },
      );
    },

    async storeProducts(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'commerce.read');
      const data = parseInput(listSchema, input);
      const after = decodeTitleCursor(data.cursor);
      const [afterTitle, afterId] = after ?? [];
      const pageSize = 50;
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: commerceStoreProducts.id,
              title: commerceStoreProducts.title,
              status: commerceStoreProducts.status,
              sku: commerceStoreProducts.sku,
              url: commerceStoreProducts.url,
              currency: commerceStoreProducts.currency,
              priceMinMinor: commerceStoreProducts.priceMinMinor,
              priceMaxMinor: commerceStoreProducts.priceMaxMinor,
              inventory: commerceStoreProducts.inventory,
              variants: commerceStoreProducts.variants,
            })
            .from(commerceStoreProducts)
            .where(
              and(
                eq(commerceStoreProducts.tenantId, ctx.tenant.id),
                eq(commerceStoreProducts.storeId, data.storeId),
                isNull(commerceStoreProducts.deletedAt),
                data.q
                  ? or(
                      sql`${commerceStoreProducts.title} ilike ${likePattern(data.q)}`,
                      sql`${commerceStoreProducts.sku} ilike ${likePattern(data.q)}`,
                    )
                  : undefined,
                after && afterId
                  ? or(
                      gt(commerceStoreProducts.title, afterTitle as string),
                      and(
                        eq(commerceStoreProducts.title, afterTitle as string),
                        gt(commerceStoreProducts.id, afterId),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(asc(commerceStoreProducts.title), asc(commerceStoreProducts.id))
            .limit(pageSize + 1),
        { accessMode: 'read only' },
      );
      const page = rows.slice(0, pageSize);
      const last = page.at(-1);
      return {
        products: page,
        next:
          rows.length > pageSize && last
            ? Buffer.from(JSON.stringify([last.title, last.id])).toString('base64url')
            : null,
      };
    },

    /**
     * The store orders of a conversation's contact, matched by phone number (for the inbox panel):
     * shown when the member can see the conversation.
     */
    async conversationStoreOrders(ctx: TenantContext, conversationId: string) {
      readable(ctx);
      const { id } = parseInput(idSchema, { id: conversationId });
      return db.run(
        ctx.scope,
        async (tx) => {
          const [conversation] = await tx
            .select({ assigned: conversations.assignedMembershipId, phone: contacts.phoneE164 })
            .from(conversations)
            .innerJoin(
              contacts,
              and(
                eq(contacts.tenantId, conversations.tenantId),
                eq(contacts.id, conversations.contactId),
              ),
            )
            .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, id)));
          if (!conversation || !canSeeConversation(ctx, conversation.assigned)) {
            throw notFound('Conversation not found.');
          }
          if (!conversation.phone) return { orders: [], total: 0 };
          const match = and(
            eq(commerceStoreOrders.tenantId, ctx.tenant.id),
            eq(commerceStoreOrders.customerPhone, conversation.phone),
            isNull(commerceStoreOrders.deletedAt),
          );
          const orders = await tx
            .select({
              id: commerceStoreOrders.id,
              name: commerceStoreOrders.name,
              status: commerceStoreOrders.status,
              financialStatus: commerceStoreOrders.financialStatus,
              fulfillmentStatus: commerceStoreOrders.fulfillmentStatus,
              currency: commerceStoreOrders.currency,
              totalMinor: commerceStoreOrders.totalMinor,
              placedAt: commerceStoreOrders.placedAt,
              statusUrl: commerceStoreOrders.statusUrl,
              storeName: commerceStores.name,
              platform: commerceStores.platform,
            })
            .from(commerceStoreOrders)
            .innerJoin(
              commerceStores,
              and(
                eq(commerceStores.tenantId, commerceStoreOrders.tenantId),
                eq(commerceStores.id, commerceStoreOrders.storeId),
              ),
            )
            .where(match)
            .orderBy(desc(commerceStoreOrders.placedAt), desc(commerceStoreOrders.id))
            .limit(5);
          const [{ total } = { total: 0 }] = await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(commerceStoreOrders)
            .where(match);
          return { orders, total };
        },
        { accessMode: 'read only' },
      );
    },

    /** Marks a Shopify data request answered; who asked is then no longer kept. */
    async answerPrivacyRequest(ctx: TenantContext, id: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      const { id: requestId } = parseInput(idSchema, { id });
      return db.run(ctx.scope, async (tx) => {
        const [request] = await tx
          .update(commerceStorePrivacyRequests)
          .set({
            answeredAt: deps.clock.now(),
            answeredByMembershipId: ctx.membership.id,
            customerEmail: null,
            customerPhone: null,
          })
          .where(
            and(
              eq(commerceStorePrivacyRequests.tenantId, ctx.tenant.id),
              eq(commerceStorePrivacyRequests.id, requestId),
              eq(commerceStorePrivacyRequests.kind, 'data_request'),
              isNull(commerceStorePrivacyRequests.answeredAt),
            ),
          )
          .returning({
            id: commerceStorePrivacyRequests.id,
            storeId: commerceStorePrivacyRequests.storeId,
          });
        if (!request) throw notFound('Request not found or already answered.');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.store_data_request_answered',
            subjectType: 'commerce_store',
            subjectId: request.storeId,
          },
          meta,
        );
        return { ok: true as const };
      });
    },
  };

  /**
   * Inserts a WooCommerce store for the address, or reuses the company's store with the same
   * address for a reconnect (keeping what HyFib read). Returns the store id.
   */
  async function upsertWooStore(
    tx: Tx,
    ctx: TenantContext,
    storeUrl: string,
    code: string | undefined,
    set:
      | Partial<typeof commerceStores.$inferInsert>
      | ((existingId: string | null) => Partial<typeof commerceStores.$inferInsert>),
    newId: string = uuidv7(),
  ): Promise<string> {
    const [existing] = await tx
      .select()
      .from(commerceStores)
      .where(
        and(
          eq(commerceStores.tenantId, ctx.tenant.id),
          eq(commerceStores.platform, 'woocommerce'),
          eq(commerceStores.storeUrl, storeUrl),
        ),
      )
      .for('update');
    const values = typeof set === 'function' ? set(existing?.id ?? null) : set;
    if (existing) {
      reconnectable(existing.state);
      await tx
        .update(commerceStores)
        .set({
          ...values,
          ...(code !== undefined ? { phoneCallingCode: code || null } : {}),
          ...(values.credentialsCiphertext
            ? { credentialsVersion: existing.credentialsVersion + 1 }
            : {}),
          version: existing.version + 1,
        })
        .where(storeWhere(ctx, existing.id));
      return existing.id;
    }
    await assertRoom(tx, ctx);
    await tx.insert(commerceStores).values({
      id: newId,
      tenantId: ctx.tenant.id,
      platform: 'woocommerce',
      storeUrl,
      webhookPublicId: newStoreWebhookId(),
      webhookSecretCiphertext: deps.keyring.encrypt(
        newStoreWebhookSecret(),
        storeWebhookSecretAad(ctx.tenant.id, newId),
      ),
      phoneCallingCode: code || null,
      createdByMembershipId: ctx.membership.id,
      ...values,
    });
    return newId;
  }
}

export type StoreService = ReturnType<typeof createStoreService>;
