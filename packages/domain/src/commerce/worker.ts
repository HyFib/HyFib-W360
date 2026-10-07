import { clipText, uuidv7, type Clock, type Keyring } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  channelAccounts,
  commerceCatalogs,
  commerceOrders,
  commercePaymentAccounts,
  commercePaymentLinks,
  commerceProducts,
  commerceSyncs,
  contactIdentities,
  conversations,
  eq,
  inArray,
  isNull,
  lt,
  messages,
  notInArray,
  sendIntents,
  sql,
  systemScope,
  OPEN_PAYMENT_LINK_STATUSES,
  type Database,
  type PaymentLinkStatus,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { RazorpayClient, type RazorpayPaymentLink, type RazorpayResult } from '../billing/razorpay';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from '../messaging/events';
import type { GraphClient, GraphResult, RemoteProduct } from '../messaging/graph';
import { SERVICE_WINDOW_MS } from '../messaging/outbound';
import { STATUS_RANK } from '../messaging/status';
import { wabaCredential } from '../templates/service';
import { chunks } from '../validation';
import { COMMERCE_LIMITS, paymentAccountAad, paymentRequestText } from './model';
import { orderStatusChangedBy } from './orders';

/**
 * Worker side of commerce. Catalog reads only read from Meta. Payment Links are advanced one step at
 * a time under a short lease on the link row: created once (a link whose create response was lost is
 * found again by its single-use reference, research R-106 and R-107), cancelled on request, and
 * otherwise fetched from Razorpay with the company's keys; that fetched link is the only source of
 * a payment. HyFib never holds the money: it goes to the company's Razorpay account.
 */

export interface CommerceWorkerDeps {
  db: Database;
  keyring: Keyring;
  clock: Clock;
  /** Razorpay's API origin (razorpayApiBaseUrl). */
  razorpayBaseUrl: string;
  jobs: JobQueue;
  signer: JobSigner;
}

export type CommerceJobOutcome = 'done' | 'skipped' | 'retry';

/** Catalog reads also need the Graph client. */
export interface CatalogSyncDeps extends CommerceWorkerDeps {
  graph: GraphClient;
}

/** Catalog reads pending longer than this are failed by the sweep instead of tried again. */
export const COMMERCE_SYNC_GIVE_UP_MS = 30 * 60_000;
const LINK_LEASE_MS = 2 * 60_000;

type GraphFailure = Extract<GraphResult<never>, { ok: false }>;

function graphMessage(f: GraphFailure): string {
  // Graph permission errors: #10 and #200–#299 (the app or token lacks a permission). The Graph
  // client counts #10 as a credential failure, so these are told apart first.
  if (f.code === 10 || (f.code !== undefined && f.code >= 200 && f.code <= 299)) {
    return 'Meta refused access to the catalog. HyFib’s Meta app may not have catalog access (catalog_management) for this account yet.';
  }
  if (f.kind === 'auth') {
    return 'Meta rejected the stored credential. Reconnect the WhatsApp account, then try again.';
  }
  return `Meta did not return the catalog: ${(f.detail ?? f.title).slice(0, 600)}`;
}

/** Reads the account's connected catalogs and their products from Meta (M-172). */
export async function processCommerceSync(
  deps: CatalogSyncDeps,
  scope: TenantScope,
  whatsappAccountId: string,
): Promise<CommerceJobOutcome> {
  const claimed = await deps.db.run(scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(commerceSyncs)
      .where(
        and(
          eq(commerceSyncs.tenantId, scope.tenantId),
          eq(commerceSyncs.whatsappAccountId, whatsappAccountId),
        ),
      )
      .for('update');
    if (!row || (row.state !== 'queued' && row.state !== 'running')) return null;
    if (row.state === 'queued') {
      await tx
        .update(commerceSyncs)
        .set({ state: 'running' })
        .where(and(eq(commerceSyncs.tenantId, scope.tenantId), eq(commerceSyncs.id, row.id)));
    }
    const credential = await wabaCredential(tx, scope.tenantId, whatsappAccountId, deps.keyring);
    return { row, credential };
  });
  if (!claimed) return 'skipped';
  const { row, credential } = claimed;
  const finish = (set: { state: 'idle' | 'failed'; error: string | null }) =>
    deps.db.run(scope, (tx) =>
      tx
        .update(commerceSyncs)
        .set({ ...set, finishedAt: deps.clock.now() })
        .where(
          and(
            eq(commerceSyncs.tenantId, scope.tenantId),
            eq(commerceSyncs.id, row.id),
            // Only the read this job claimed: a newer request stays queued.
            eq(commerceSyncs.version, row.version),
            inArray(commerceSyncs.state, ['queued', 'running']),
          ),
        ),
    );
  const fail = async (message: string) => {
    await finish({ state: 'failed', error: message });
    return 'done' as const;
  };
  if (!credential)
    return fail('The WhatsApp account is not connected. Reconnect it, then try again.');

  // Catalogs connected to the account.
  const catalogs: { id: string; name: string | null; productCount: number | null }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const listed = await deps.graph.listProductCatalogs(credential.wabaId, credential.token, {
      after,
    });
    if (!listed.ok) {
      return listed.kind === 'retryable' || listed.kind === 'unknown'
        ? 'retry'
        : fail(graphMessage(listed));
    }
    catalogs.push(...listed.data.catalogs);
    if (!listed.data.after || catalogs.length >= COMMERCE_LIMITS.catalogsPerAccount) break;
    after = listed.data.after;
  }
  const kept = catalogs.slice(0, COMMERCE_LIMITS.catalogsPerAccount);

  // Each catalog's products, up to HyFib's limit.
  const read: { catalog: (typeof kept)[number]; products: RemoteProduct[]; truncated: boolean }[] =
    [];
  for (const catalog of kept) {
    const products: RemoteProduct[] = [];
    let cursor: string | null = null;
    let truncated = false;
    for (;;) {
      const listed = await deps.graph.listCatalogProducts(catalog.id, credential.token, {
        after: cursor,
      });
      if (!listed.ok) {
        return listed.kind === 'retryable' || listed.kind === 'unknown'
          ? 'retry'
          : fail(graphMessage(listed));
      }
      products.push(...listed.data.products);
      if (products.length >= COMMERCE_LIMITS.productsPerCatalog) {
        truncated =
          Boolean(listed.data.after) || products.length > COMMERCE_LIMITS.productsPerCatalog;
        products.length = Math.min(products.length, COMMERCE_LIMITS.productsPerCatalog);
        break;
      }
      if (!listed.data.after) break;
      cursor = listed.data.after;
    }
    read.push({ catalog, products, truncated });
  }

  const now = deps.clock.now();
  await deps.db.run(scope, async (tx) => {
    const existing = await tx
      .select({ id: commerceCatalogs.id, metaCatalogId: commerceCatalogs.metaCatalogId })
      .from(commerceCatalogs)
      .where(
        and(
          eq(commerceCatalogs.tenantId, scope.tenantId),
          eq(commerceCatalogs.whatsappAccountId, whatsappAccountId),
        ),
      );
    const byMeta = new Map(existing.map((c) => [c.metaCatalogId, c.id]));
    for (const { catalog, products, truncated } of read) {
      let catalogId = byMeta.get(catalog.id);
      if (catalogId) {
        await tx
          .update(commerceCatalogs)
          .set({
            name: catalog.name,
            productCount: catalog.productCount,
            truncated,
            disconnectedAt: null,
            syncedAt: now,
          })
          .where(
            and(eq(commerceCatalogs.tenantId, scope.tenantId), eq(commerceCatalogs.id, catalogId)),
          );
      } else {
        catalogId = uuidv7();
        await tx.insert(commerceCatalogs).values({
          id: catalogId,
          tenantId: scope.tenantId,
          whatsappAccountId,
          metaCatalogId: catalog.id,
          name: catalog.name,
          productCount: catalog.productCount,
          truncated,
          syncedAt: now,
        });
      }
      const seen = new Map<string, RemoteProduct>();
      for (const p of products) seen.set(p.retailerId, p);
      for (const batch of chunks([...seen.values()], 200)) {
        await tx
          .insert(commerceProducts)
          .values(
            batch.map((p) => ({
              id: uuidv7(),
              tenantId: scope.tenantId,
              catalogId: catalogId as string,
              retailerId: p.retailerId,
              metaProductId: p.id,
              name: p.name,
              description: p.description,
              priceText: p.price,
              currency: p.currency,
              availability: p.availability,
              reviewStatus: p.reviewStatus,
              syncedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [
              commerceProducts.tenantId,
              commerceProducts.catalogId,
              commerceProducts.retailerId,
            ],
            set: {
              metaProductId: sql`excluded.meta_product_id`,
              name: sql`excluded.name`,
              description: sql`excluded.description`,
              priceText: sql`excluded.price_text`,
              currency: sql`excluded.currency`,
              availability: sql`excluded.availability`,
              reviewStatus: sql`excluded.review_status`,
              removedAt: null,
              syncedAt: now,
            },
          });
      }
      // Products Meta no longer lists are marked removed (only after a complete read).
      if (!truncated) {
        const retailerIds = [...seen.keys()];
        await tx
          .update(commerceProducts)
          .set({ removedAt: now })
          .where(
            and(
              eq(commerceProducts.tenantId, scope.tenantId),
              eq(commerceProducts.catalogId, catalogId),
              isNull(commerceProducts.removedAt),
              retailerIds.length > 0
                ? notInArray(commerceProducts.retailerId, retailerIds)
                : undefined,
            ),
          );
      }
    }
    // Catalogs no longer connected to the account.
    const connected = kept.map((c) => c.id);
    await tx
      .update(commerceCatalogs)
      .set({ disconnectedAt: now })
      .where(
        and(
          eq(commerceCatalogs.tenantId, scope.tenantId),
          eq(commerceCatalogs.whatsappAccountId, whatsappAccountId),
          isNull(commerceCatalogs.disconnectedAt),
          connected.length > 0 ? notInArray(commerceCatalogs.metaCatalogId, connected) : undefined,
        ),
      );
  });
  await finish({ state: 'idle', error: null });
  return 'done';
}

/** Fails catalog reads that have waited too long (called by the sweep for stale reads). */
export async function giveUpCommerceSync(
  deps: { db: Database; clock: Clock },
  scope: TenantScope,
  whatsappAccountId: string,
) {
  await deps.db.run(scope, (tx) =>
    tx
      .update(commerceSyncs)
      .set({
        state: 'failed',
        error:
          'This did not finish within 30 minutes (Meta did not answer, or the company was suspended). Try again.',
        finishedAt: deps.clock.now(),
      })
      .where(
        and(
          eq(commerceSyncs.tenantId, scope.tenantId),
          eq(commerceSyncs.whatsappAccountId, whatsappAccountId),
          inArray(commerceSyncs.state, ['queued', 'running']),
          lt(
            commerceSyncs.requestedAt,
            new Date(deps.clock.now().getTime() - COMMERCE_SYNC_GIVE_UP_MS),
          ),
        ),
      ),
  );
}

/** The daily read: queues it again when the last one finished more than a day ago. */
export async function queueDailyCommerceSync(
  deps: { db: Database; clock: Clock },
  scope: TenantScope,
  whatsappAccountId: string,
): Promise<boolean> {
  const updated = await deps.db.run(scope, (tx) =>
    tx
      .update(commerceSyncs)
      .set({
        state: 'queued',
        error: null,
        requestedAt: deps.clock.now(),
        version: sql`${commerceSyncs.version} + 1`,
      })
      .where(
        and(
          eq(commerceSyncs.tenantId, scope.tenantId),
          eq(commerceSyncs.whatsappAccountId, whatsappAccountId),
          eq(commerceSyncs.state, 'idle'),
          lt(commerceSyncs.finishedAt, new Date(deps.clock.now().getTime() - 24 * 3_600_000)),
        ),
      )
      .returning({ id: commerceSyncs.id }),
  );
  return updated.length > 0;
}

// Payment Links ------------------------------------------------------------------------------------

async function merchantClient(deps: CommerceWorkerDeps, tx: Tx, tenantId: string) {
  const [account] = await tx
    .select({
      id: commercePaymentAccounts.id,
      keyId: commercePaymentAccounts.keyId,
      keySecret: commercePaymentAccounts.keySecretCiphertext,
      status: commercePaymentAccounts.status,
      version: commercePaymentAccounts.version,
    })
    .from(commercePaymentAccounts)
    .where(eq(commercePaymentAccounts.tenantId, tenantId));
  if (!account) return null;
  const keySecret = deps.keyring.decryptString(
    account.keySecret,
    paymentAccountAad(tenantId, account.id, 'key'),
  );
  return {
    accountId: account.id,
    version: account.version,
    client: new RazorpayClient({ baseUrl: deps.razorpayBaseUrl, keyId: account.keyId, keySecret }),
  };
}

/** When to look at a link again: every 15 minutes for a day, then every six hours until it expires. */
function nextCheck(now: Date, createdAt: Date, expiresAt: Date): Date | null {
  if (now.getTime() > expiresAt.getTime() + 86_400_000) return null;
  const young = now.getTime() - createdAt.getTime() < 86_400_000;
  return new Date(now.getTime() + (young ? 15 : 360) * 60_000);
}

const PROVIDER_STATUSES = new Set(['created', 'partially_paid', 'paid', 'expired', 'cancelled']);

type LinkRow = typeof commercePaymentLinks.$inferSelect;

/**
 * Advances one Payment Link: creates it (once), cancels it when asked, or fetches its status.
 * Returns 'retry' when Razorpay could not be reached or another job holds the link's lease; the link
 * keeps its state for the next attempt.
 */
export async function processPaymentLink(
  deps: CommerceWorkerDeps,
  scope: TenantScope,
  linkId: string,
): Promise<CommerceJobOutcome> {
  const now = deps.clock.now();
  const claimed = await deps.db.run(scope, async (tx) => {
    const [link] = await tx
      .select()
      .from(commercePaymentLinks)
      .where(
        and(eq(commercePaymentLinks.tenantId, scope.tenantId), eq(commercePaymentLinks.id, linkId)),
      )
      .for('update');
    if (!link || !['creating', 'created', 'partially_paid'].includes(link.status)) {
      return 'gone' as const;
    }
    // Another job is working on the link: try again shortly (a webhook's check must not be lost).
    if (link.leaseUntil && link.leaseUntil > now) return 'busy' as const;
    const attempts = link.status === 'creating' ? link.attempts + 1 : link.attempts;
    await tx
      .update(commercePaymentLinks)
      .set({ leaseUntil: new Date(now.getTime() + LINK_LEASE_MS), attempts })
      .where(
        and(
          eq(commercePaymentLinks.tenantId, scope.tenantId),
          eq(commercePaymentLinks.id, link.id),
        ),
      );
    const merchant = await merchantClient(deps, tx, scope.tenantId);
    return { link: { ...link, attempts }, merchant };
  });
  if (claimed === 'gone') return 'skipped';
  if (claimed === 'busy') return 'retry';
  const { link, merchant } = claimed;

  const release = (set: Partial<typeof commercePaymentLinks.$inferInsert> = {}) =>
    deps.db.run(scope, (tx) =>
      tx
        .update(commercePaymentLinks)
        .set({ leaseUntil: null, ...set })
        .where(
          and(
            eq(commercePaymentLinks.tenantId, scope.tenantId),
            eq(commercePaymentLinks.id, link.id),
          ),
        ),
    );
  const retryLater = async (error: string) => {
    await release({
      error: error.slice(0, 500),
      nextCheckAt: new Date(now.getTime() + 5 * 60_000),
    });
    return 'retry' as const;
  };

  if (!merchant) {
    if (link.status === 'creating') {
      await settleLink(deps, scope, link, {
        status: 'failed',
        error: 'The company’s Razorpay account was removed.',
      });
      return 'done';
    }
    return retryLater('The company’s Razorpay account was removed; the link cannot be checked.');
  }
  const { client } = merchant;

  // Creating: find a link an earlier attempt may have made before creating one.
  if (link.status === 'creating') {
    let remote: RazorpayPaymentLink | null = null;
    if (link.attempts > 1) {
      const found = await client.findPaymentLinksByReference(link.reference);
      if (!found.ok) return failure(deps, scope, link, found, retryLater, merchant.version);
      remote = found.data[0] ?? null;
    }
    if (!remote && link.cancelRequestedAt) {
      await settleLink(deps, scope, link, { status: 'cancelled', error: null });
      return 'done';
    }
    if (!remote) {
      const created = await client.createPaymentLink({
        amount: link.amountMinor,
        currency: 'INR',
        referenceId: link.reference,
        description: await orderDescription(deps, scope, link.orderId),
        expireBy: Math.floor(link.expiresAt.getTime() / 1000),
      });
      if (created.ok) {
        remote = created.data;
      } else if (
        created.kind === 'permanent' &&
        /reference id already attempted/i.test(created.description)
      ) {
        const found = await client.findPaymentLinksByReference(link.reference);
        if (!found.ok) return failure(deps, scope, link, found, retryLater, merchant.version);
        remote = found.data[0] ?? null;
        if (!remote)
          return retryLater('Razorpay reports the link exists but did not return it yet.');
      } else {
        return failure(deps, scope, link, created, retryLater, merchant.version);
      }
    }
    if (remote.amount !== link.amountMinor || remote.currency !== link.currency) {
      await settleLink(deps, scope, link, {
        status: 'failed',
        providerLinkId: remote.id,
        error: 'Razorpay reported a different amount for this link; it was not sent.',
      });
      return 'done';
    }
    if (link.cancelRequestedAt && remote.status === 'created') {
      const cancelled = await client.cancelPaymentLink(remote.id);
      if (cancelled.ok) remote = cancelled.data;
      else if (cancelled.kind !== 'permanent')
        return failure(deps, scope, link, cancelled, retryLater, merchant.version);
    }
    await adoptRemote(deps, scope, link, remote, { send: !link.cancelRequestedAt });
    return 'done';
  }

  // Created: cancel on request, otherwise fetch the status.
  if (!link.providerLinkId) return retryLater('The link has no Razorpay id.');
  let remote: RazorpayResult<RazorpayPaymentLink>;
  if (link.cancelRequestedAt && link.status === 'created') {
    remote = await client.cancelPaymentLink(link.providerLinkId);
    // Refused (for example already paid, R-109): fetch what Razorpay has instead.
    if (!remote.ok && remote.kind === 'permanent')
      remote = await client.fetchPaymentLink(link.providerLinkId);
  } else {
    remote = await client.fetchPaymentLink(link.providerLinkId);
  }
  if (!remote.ok) return failure(deps, scope, link, remote, retryLater, merchant.version);
  if (remote.data.id !== link.providerLinkId || remote.data.amount !== link.amountMinor) {
    return retryLater('Razorpay returned a different link or amount; it was not applied.');
  }
  await adoptRemote(deps, scope, link, remote.data, { send: false });
  return 'done';
}

async function failure(
  deps: CommerceWorkerDeps,
  scope: TenantScope,
  link: LinkRow,
  result: Extract<RazorpayResult<unknown>, { ok: false }>,
  retryLater: (error: string) => Promise<'retry'>,
  /** The version of the keys the request used: keys saved since then are not marked failed. */
  accountVersion: number,
): Promise<CommerceJobOutcome> {
  if (result.kind === 'retryable' || result.kind === 'unknown') {
    return retryLater(`Razorpay could not be reached (${result.description}).`);
  }
  const message =
    result.kind === 'auth'
      ? 'Razorpay rejected the company’s key id or secret. Check them in Commerce → Payments.'
      : `Razorpay refused the request: ${result.description}`;
  if (result.kind === 'auth') {
    await deps.db.run(scope, (tx) =>
      tx
        .update(commercePaymentAccounts)
        .set({ status: 'failed', statusError: message, checkedAt: deps.clock.now() })
        .where(
          and(
            eq(commercePaymentAccounts.tenantId, scope.tenantId),
            eq(commercePaymentAccounts.version, accountVersion),
          ),
        ),
    );
  }
  if (link.status === 'creating') {
    await settleLink(deps, scope, link, { status: 'failed', error: message });
    return 'done';
  }
  return retryLater(message);
}

async function orderDescription(deps: CommerceWorkerDeps, scope: TenantScope, orderId: string) {
  const [order] = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({ reference: commerceOrders.reference })
        .from(commerceOrders)
        .where(and(eq(commerceOrders.tenantId, scope.tenantId), eq(commerceOrders.id, orderId))),
    { accessMode: 'read only' },
  );
  return `Order ${order?.reference ?? ''}`.trim();
}

/** Records a link's end state (failed or cancelled before it existed) and frees its order. */
async function settleLink(
  deps: CommerceWorkerDeps,
  scope: TenantScope,
  link: LinkRow,
  set: { status: PaymentLinkStatus; error: string | null; providerLinkId?: string },
) {
  await deps.db.run(scope, async (tx) => {
    await lockLinkOrder(tx, scope.tenantId, link.orderId);
    const settled = await tx
      .update(commercePaymentLinks)
      .set({
        status: set.status,
        error: set.error,
        ...(set.providerLinkId ? { providerLinkId: set.providerLinkId } : {}),
        leaseUntil: null,
        nextCheckAt: null,
        checkedAt: deps.clock.now(),
        version: sql`${commercePaymentLinks.version} + 1`,
      })
      .where(
        and(
          eq(commercePaymentLinks.tenantId, scope.tenantId),
          eq(commercePaymentLinks.id, link.id),
          inArray(commercePaymentLinks.status, [...OPEN_PAYMENT_LINK_STATUSES]),
        ),
      )
      .returning({ id: commercePaymentLinks.id });
    if (settled.length > 0) await releaseOrder(tx, deps, scope.tenantId, link.orderId);
  });
}

/**
 * Lock order for a link's rows: its conversation (only when a message may be queued), then its
 * order, then the link. Replies, erasure and the order pages take the same order, so no two
 * transactions wait on each other.
 */
async function lockLinkOrder(tx: Tx, tenantId: string, orderId: string) {
  await tx
    .select({ id: commerceOrders.id })
    .from(commerceOrders)
    .where(and(eq(commerceOrders.tenantId, tenantId), eq(commerceOrders.id, orderId)))
    .for('update');
}

/**
 * An order waiting for payment goes back to confirmed when its link ends unpaid, a change HyFib
 * makes from the link (ADR-270).
 */
async function releaseOrder(tx: Tx, deps: { clock: Clock }, tenantId: string, orderId: string) {
  await tx
    .update(commerceOrders)
    .set({
      status: 'confirmed',
      statusChangedAt: deps.clock.now(),
      version: sql`${commerceOrders.version} + 1`,
      ...orderStatusChangedBy('payment_link'),
    })
    .where(
      and(
        eq(commerceOrders.tenantId, tenantId),
        eq(commerceOrders.id, orderId),
        eq(commerceOrders.status, 'awaiting_payment'),
      ),
    );
}

/**
 * Applies the link as Razorpay reports it: its id, address and status. A paid link (the whole amount
 * paid) marks the order paid; an expired or cancelled one frees the order. A newly created link is
 * sent in the chat when the customer service window is still open.
 */
async function adoptRemote(
  deps: CommerceWorkerDeps,
  scope: TenantScope,
  link: LinkRow,
  remote: RazorpayPaymentLink,
  options: { send: boolean },
) {
  const now = deps.clock.now();
  const status: PaymentLinkStatus = PROVIDER_STATUSES.has(remote.status)
    ? (remote.status as PaymentLinkStatus)
    : 'created';
  const paid = status === 'paid' && remote.amountPaid >= link.amountMinor;
  const open = status === 'created' || status === 'partially_paid' || (status === 'paid' && !paid);
  // The address to send in the chat, when a message may be queued.
  const sendUrl = options.send && open ? remote.shortUrl : null;
  const noAddress = options.send && open && !remote.shortUrl;
  await deps.db.run(scope, async (tx) => {
    const conversation = sendUrl
      ? await lockConversation(tx, scope.tenantId, link.conversationId)
      : null;
    await lockLinkOrder(tx, scope.tenantId, link.orderId);
    const [current] = await tx
      .select({ status: commercePaymentLinks.status, messageId: commercePaymentLinks.messageId })
      .from(commercePaymentLinks)
      .where(
        and(
          eq(commercePaymentLinks.tenantId, scope.tenantId),
          eq(commercePaymentLinks.id, link.id),
        ),
      )
      .for('update');
    // A link that already ended (paid, expired, cancelled, failed) never changes again.
    if (!current || !OPEN_PAYMENT_LINK_STATUSES.includes(current.status)) return;
    let messageId = current.messageId;
    let sendError: string | undefined = noAddress && !messageId ? LINK_WITHOUT_ADDRESS : undefined;
    if (sendUrl && !messageId) {
      const sent = conversation
        ? await queueLinkMessage(tx, deps, scope.tenantId, link, conversation, sendUrl)
        : { messageId: null, error: LINK_NOT_SENT('the conversation was not found.') };
      messageId = sent.messageId;
      sendError = sent.error ?? undefined;
    }
    await tx
      .update(commercePaymentLinks)
      .set({
        status: paid ? 'paid' : open ? (status === 'paid' ? 'partially_paid' : status) : status,
        providerLinkId: remote.id,
        shortUrl: remote.shortUrl,
        amountPaidMinor: remote.amountPaid,
        messageId,
        ...(sendError ? { sendError } : {}),
        error: null,
        leaseUntil: null,
        checkedAt: now,
        nextCheckAt: open ? nextCheck(now, link.createdAt, link.expiresAt) : null,
        ...(paid ? { paidAt: now } : {}),
        version: sql`${commercePaymentLinks.version} + 1`,
      })
      .where(
        and(
          eq(commercePaymentLinks.tenantId, scope.tenantId),
          eq(commercePaymentLinks.id, link.id),
        ),
      );
    if (paid) {
      await tx
        .update(commerceOrders)
        .set({
          status: 'paid',
          paidAt: now,
          statusChangedAt: now,
          version: sql`${commerceOrders.version} + 1`,
          ...orderStatusChangedBy('payment_link'),
        })
        .where(
          and(
            eq(commerceOrders.tenantId, scope.tenantId),
            eq(commerceOrders.id, link.orderId),
            inArray(commerceOrders.status, ['awaiting_payment', 'received', 'confirmed']),
          ),
        );
    } else if (!open) {
      await releaseOrder(tx, deps, scope.tenantId, link.orderId);
    }
  });
}

const LINK_NOT_SENT = (reason: string) =>
  `The link was created but not sent: ${reason} Copy it from the order page.`;
const LINK_WITHOUT_ADDRESS =
  'The link was created, but Razorpay returned no https address for it, so it was not sent. Cancel it and request payment again.';

async function lockConversation(tx: Tx, tenantId: string, conversationId: string) {
  const [conversation] = await tx
    .select({
      id: conversations.id,
      channelAccountId: conversations.channelAccountId,
      contactId: conversations.contactId,
      lastInboundAt: conversations.lastInboundAt,
      assignedMembershipId: conversations.assignedMembershipId,
    })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
    .for('update');
  return conversation ?? null;
}

/** Queues the chat message carrying the link, when the conversation can still be replied to. */
async function queueLinkMessage(
  tx: Tx,
  deps: CommerceWorkerDeps,
  tenantId: string,
  link: LinkRow,
  conversation: NonNullable<Awaited<ReturnType<typeof lockConversation>>>,
  url: string,
): Promise<{ messageId: string | null; error: string | null }> {
  const now = deps.clock.now();
  const [channel] = await tx
    .select({
      status: channelAccounts.status,
      whatsappAccountId: channelAccounts.whatsappAccountId,
    })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, tenantId),
        eq(channelAccounts.id, conversation.channelAccountId),
      ),
    );
  const [order] = await tx
    .select({ reference: commerceOrders.reference })
    .from(commerceOrders)
    .where(and(eq(commerceOrders.tenantId, tenantId), eq(commerceOrders.id, link.orderId)));
  const notSent = (reason: string) => ({ messageId: null, error: LINK_NOT_SENT(reason) });
  if (!channel || !order) return notSent('the conversation was not found.');
  if (channel.status !== 'active') return notSent('the WhatsApp number is not active.');
  if (
    !conversation.lastInboundAt ||
    now.getTime() - conversation.lastInboundAt.getTime() > SERVICE_WINDOW_MS
  ) {
    return notSent('the 24-hour customer service window had closed.');
  }
  const [identity] = await tx
    .select({ waId: contactIdentities.waId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.tenantId, tenantId),
        eq(contactIdentities.contactId, conversation.contactId),
        eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
      ),
    )
    .limit(1);
  if (!identity?.waId) return notSent('the contact has no phone number.');
  const text = paymentRequestText({
    amountMinor: link.amountMinor,
    currency: link.currency,
    orderReference: order.reference,
    url,
  });
  const messageId = uuidv7();
  const intentId = uuidv7();
  await tx.insert(messages).values({
    id: messageId,
    tenantId,
    conversationId: conversation.id,
    channelAccountId: conversation.channelAccountId,
    direction: 'outbound',
    type: 'text',
    content: { text, paymentLinkId: link.id },
    status: 'queued',
    statusRank: STATUS_RANK.queued,
    // Sent as whoever asked for the payment: the member, or the key (ADR-283).
    ...(link.createdByApiKeyId
      ? { senderType: 'api' as const, apiKeyId: link.createdByApiKeyId }
      : { senderType: 'agent' as const, senderMembershipId: link.createdByMembershipId }),
    clientKey: `paylink-${link.id}`,
  });
  await tx.insert(sendIntents).values({
    id: intentId,
    tenantId,
    messageId,
    channelAccountId: conversation.channelAccountId,
    request: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: identity.waId,
      type: 'text',
      text: { body: text, preview_url: true },
    },
    actorUserId: null,
  });
  await tx
    .update(conversations)
    .set({
      lastMessageAt: now,
      lastMessagePreview: clipText(text, 200),
      version: sql`${conversations.version} + 1`,
    })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversation.id)));
  await emitTenantEvent(tx, tenantId, {
    type: 'message.created',
    conversationId: conversation.id,
    assignedMembershipId: conversation.assignedMembershipId,
    payload: { messageId },
  });
  await deps.jobs.enqueue(
    tx,
    QUEUES.messageSend.name,
    deps.signer.sign({ kind: 'message.send', tenantId, actorUserId: null, ref: intentId }),
    { singletonKey: intentId, group: { id: conversation.channelAccountId } },
  );
  return { messageId, error: null };
}

/** Checks the company's Razorpay keys by listing one Payment Link. */
export async function processPaymentAccountCheck(
  deps: CommerceWorkerDeps,
  scope: TenantScope,
  accountId: string,
): Promise<CommerceJobOutcome> {
  const merchant = await deps.db.run(scope, (tx) => merchantClient(deps, tx, scope.tenantId));
  if (!merchant || merchant.accountId !== accountId) return 'skipped';
  const result = await merchant.client.findPaymentLinksByReference(
    `w360_check_${accountId.slice(0, 8)}`,
  );
  // No answer at all is tried again; an answer in an unexpected format is reported.
  if (
    !result.ok &&
    (result.kind === 'retryable' || (result.kind === 'unknown' && result.httpStatus === undefined))
  ) {
    return 'retry';
  }
  const status = result.ok ? 'verified' : 'failed';
  const statusError = result.ok
    ? null
    : result.kind === 'auth'
      ? 'Razorpay rejected the key id or secret.'
      : `Razorpay refused the check: ${result.description}`;
  await deps.db.run(scope, (tx) =>
    tx
      .update(commercePaymentAccounts)
      .set({ status, statusError, checkedAt: deps.clock.now() })
      .where(
        and(
          eq(commercePaymentAccounts.tenantId, scope.tenantId),
          eq(commercePaymentAccounts.id, accountId),
          eq(commercePaymentAccounts.status, 'checking'),
          // Keys saved again while this check ran are checked by their own job.
          eq(commercePaymentAccounts.version, merchant.version),
        ),
      ),
  );
  return 'done';
}

/**
 * Sweep: ends a check of the keys whose job ran out of retries (ADR-111). Keys still being checked
 * become `failed`, so payment requests say why they are refused and saving the keys again checks
 * them. Keys saved again since have a check of their own, which the sweep waits for. False when
 * nothing was left to end.
 */
export async function settlePaymentAccountCheck(
  tx: Tx,
  tenantId: string,
  accountId: string,
  at: Date,
): Promise<boolean> {
  const ended = await tx
    .update(commercePaymentAccounts)
    .set({
      status: 'failed',
      statusError:
        'Razorpay could not be reached to check the keys after repeated attempts. Save them again to check them.',
      checkedAt: at,
    })
    .where(
      and(
        eq(commercePaymentAccounts.tenantId, tenantId),
        eq(commercePaymentAccounts.id, accountId),
        eq(commercePaymentAccounts.status, 'checking'),
      ),
    )
    .returning({ id: commercePaymentAccounts.id });
  return ended.length > 0;
}

/** Work the minute sweep should signal (active companies only). */
export async function findDueCommerceWork(db: Database, limit = 50) {
  const res = await db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; kind: 'sync' | 'link'; ref: string }>(
        sql`select tenant_id, kind, ref from ops.commerce_work_due(${limit})`,
      ),
    { accessMode: 'read only' },
  );
  return res.rows.map((r) => ({ tenantId: r.tenant_id, kind: r.kind, ref: r.ref }));
}
