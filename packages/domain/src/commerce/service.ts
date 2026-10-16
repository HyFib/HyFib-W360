import { z } from 'zod';
import { AppError, clipText, notFound, uuidv7, type Clock, type Keyring } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  asc,
  channelAccounts,
  commerceCatalogs,
  commerceOrderItems,
  commerceOrders,
  commercePaymentAccounts,
  commercePaymentLinks,
  commerceProducts,
  commerceSyncs,
  contactIdentities,
  contacts,
  conversations,
  desc,
  eq,
  inArray,
  isNull,
  isUniqueViolation,
  lt,
  messages,
  or,
  outerColumn,
  sendIntents,
  sql,
  whatsappAccounts,
  OPEN_PAYMENT_LINK_STATUSES,
  ORDER_STATUSES,
  type Database,
  type OrderStatus,
  type SQL,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import { formatMinor } from '../crm/money';
import { recordAudit, type RequestMeta } from '../audit';
import { endRunForHuman } from '../automations/runs';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from '../messaging/events';
import { assertManagementOpen } from '../messaging/management-pace';
import { SERVICE_WINDOW_MS, canSeeConversation } from '../messaging/outbound';
import { STATUS_RANK } from '../messaging/status';
import { likePattern, parseInput } from '../validation';
import {
  COMMERCE_LIMITS,
  MEMBER_ORDER_TRANSITIONS,
  PAYABLE_ORDER_STATUSES,
  RAZORPAY_KEY_ID_RE,
  buildProductMessageRequest,
  newPaymentLinkReference,
  newPaymentWebhookId,
  paymentAccountAad,
  productListProblem,
  productMessageSchema,
  razorpayMode,
  type ResolvedProductMessage,
} from './model';
import { assertModule } from '../plans/entitlements';
import { CSV_BOM, csvLine } from '../contacts/csv';
import { shownNumber } from '../contacts/number-masking';
import { orderStatusChangedBy, type OrderStatusChange } from './orders';
import { ORDER_CSV_COLUMNS, orderCsvLine, type OrderCsvRow } from './orders-csv';

/** Orders one batch of an export reads (ADR-235). */
const ORDER_EXPORT_BATCH = 500;

/** An orders export's filter, as the list's (ADR-235). */
const orderExportSchema = z.object({ status: z.enum(ORDER_STATUSES).optional() });

/**
 * Commerce (P4-06). Reading catalogs, products and orders needs `commerce.read`; members see an
 * order only when they can see its conversation. Reading catalogs from Meta and the company's
 * Razorpay keys need `commerce.manage`. Sending products, changing an order's status and asking for
 * payment are replies: `inbox.reply` in a conversation the member can see. Everything done at Meta
 * or Razorpay is written ahead here and performed by the worker; a payment is recorded only from the
 * Payment Link as fetched from Razorpay, never from a browser or a webhook body.
 */

export interface CommerceDeps {
  db: Database;
  clock: Clock;
  jobs: JobQueue;
  signer: JobSigner;
  keyring: Keyring;
  appBaseUrl: string;
  /** Live Razorpay keys are accepted only in production (like HyFib's own keys). */
  allowLiveKeys: boolean;
}

const idSchema = z.object({ id: z.uuid() });
const versioned = idSchema.extend({ expectedVersion: z.number().int().min(1) });

const accountSchema = z.object({
  keyId: z
    .string()
    .trim()
    .regex(
      RAZORPAY_KEY_ID_RE,
      'Enter the key id from Razorpay (it starts with rzp_test_ or rzp_live_).',
    ),
  keySecret: z.string().trim().min(8, 'Enter the key secret.').max(200),
  webhookSecret: z
    .string()
    .trim()
    .min(8, 'Enter the webhook secret (at least 8 characters).')
    .max(200),
});

const DROPPED_ITEMS_MESSAGE =
  'HyFib could not read every item of this cart, so it has no total to ask for.';
const PAYMENT_CAP_MESSAGE = `HyFib asks for at most ${formatMinor(
  COMMERCE_LIMITS.maxPaymentMinor,
  'INR',
)} in one Payment Link.`;

const stale = () =>
  new AppError(
    'conflict',
    'Someone else changed this. Reload to see the latest version, then try again.',
  );

const invalid = (path: string, message: string) =>
  new AppError('validation_failed', message, { issues: [{ path, message }] });

/**
 * The order list's paging cursor: the last order's time and id (orders are listed by both, newest
 * first), so orders received in the same second are never skipped.
 */
function parseOrderCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split('~');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !z.uuid().safeParse(id).success) return null;
  return { at: new Date(at), id };
}

export interface OrderListItem {
  id: string;
  reference: string;
  status: OrderStatus;
  currency: string | null;
  subtotalMinor: number | null;
  itemCount: number;
  contactName: string | null;
  conversationId: string;
  receivedAt: string;
}

/**
 * Writes the new status of an order whose row the caller locked, as members change it on the order
 * page and API keys through `PATCH /orders/{id}` (ADR-168): the time of the change and the next
 * version, so a page opened before either change is refused as stale. Each caller checks the move
 * against MEMBER_ORDER_TRANSITIONS and writes its own audit row; the table's trigger captures the
 * `order.status_changed` webhook event, naming who made the change (`by`, ADR-270).
 */
export async function writeLockedOrderStatus(
  tx: Tx,
  tenantId: string,
  order: { id: string; version: number },
  status: OrderStatus,
  now: Date,
  by: OrderStatusChange,
): Promise<number> {
  const version = order.version + 1;
  await tx
    .update(commerceOrders)
    .set({ status, statusChangedAt: now, version, ...orderStatusChangedBy(by) })
    .where(and(eq(commerceOrders.tenantId, tenantId), eq(commerceOrders.id, order.id)));
  return version;
}

/** Who asks a customer to pay: a member on the order page, or an API key (ADR-283). */
export type PaymentRequester = { membershipId: string; userId: string } | { apiKeyId: string };

/** An order whose row the caller locked, as a payment request reads it. */
export interface PayableOrder {
  id: string;
  status: OrderStatus;
  droppedItems: number;
  currency: string | null;
  subtotalMinor: number | null;
  conversationId: string;
  version: number;
}

/**
 * Asks the customer to pay an order whose row the caller locked, as members do on the order page
 * and keys through `POST /orders/{id}/request-payment` (ADR-283): the order must be received or
 * confirmed, its cart read whole and its total in rupees within Razorpay's and HyFib's bounds, and
 * the company's Razorpay account checked. The link is written ahead for the worker to create once
 * and send in the chat, and the order waits for payment, naming who asked. Each caller writes its
 * own audit row.
 */
export async function writePaymentRequest(
  tx: Tx,
  deps: Pick<CommerceDeps, 'jobs' | 'signer'>,
  tenantId: string,
  order: PayableOrder,
  by: PaymentRequester,
  now: Date,
): Promise<{ linkId: string; version: number }> {
  if (!PAYABLE_ORDER_STATUSES.includes(order.status)) {
    throw new AppError(
      'conflict',
      'Payment can be requested only for received or confirmed orders.',
    );
  }
  if (order.droppedItems > 0) {
    throw new AppError('precondition_failed', DROPPED_ITEMS_MESSAGE);
  }
  if (order.currency !== 'INR' || order.subtotalMinor === null) {
    throw new AppError(
      'precondition_failed',
      order.currency !== 'INR'
        ? 'Payment Links are for amounts in Indian rupees.'
        : 'The order total could not be worked out from the prices WhatsApp sent.',
    );
  }
  if (order.subtotalMinor < COMMERCE_LIMITS.minPaymentMinor) {
    throw new AppError('precondition_failed', 'Razorpay needs at least ₹1.');
  }
  if (order.subtotalMinor > COMMERCE_LIMITS.maxPaymentMinor) {
    throw new AppError('precondition_failed', PAYMENT_CAP_MESSAGE);
  }
  const [account] = await tx
    .select({ status: commercePaymentAccounts.status })
    .from(commercePaymentAccounts)
    .where(eq(commercePaymentAccounts.tenantId, tenantId));
  if (!account || account.status !== 'verified') {
    throw new AppError(
      'precondition_failed',
      account
        ? 'Your Razorpay account has not been checked successfully. Check it in Commerce → Payments.'
        : 'Add your Razorpay account in Commerce → Payments first.',
    );
  }
  const byKey = 'apiKeyId' in by;
  const linkId = uuidv7();
  try {
    await tx.insert(commercePaymentLinks).values({
      id: linkId,
      tenantId,
      orderId: order.id,
      conversationId: order.conversationId,
      reference: newPaymentLinkReference(),
      amountMinor: order.subtotalMinor,
      currency: 'INR',
      expiresAt: new Date(now.getTime() + COMMERCE_LIMITS.paymentLinkDays * 86_400_000),
      nextCheckAt: now,
      createdByMembershipId: byKey ? null : by.membershipId,
      createdByApiKeyId: byKey ? by.apiKeyId : null,
    });
  } catch (error) {
    if (isUniqueViolation(error, 'commerce_payment_links_open_uq')) {
      throw new AppError('conflict', 'This order already has an open Payment Link.');
    }
    throw error;
  }
  const version = order.version + 1;
  await tx
    .update(commerceOrders)
    .set({
      status: 'awaiting_payment',
      statusChangedAt: now,
      version,
      ...orderStatusChangedBy(byKey ? { apiKeyId: by.apiKeyId } : 'member'),
    })
    .where(and(eq(commerceOrders.tenantId, tenantId), eq(commerceOrders.id, order.id)));
  await deps.jobs.enqueue(
    tx,
    QUEUES.commerceLink.name,
    deps.signer.sign({
      kind: 'commerce.link',
      tenantId,
      actorUserId: byKey ? null : by.userId,
      ref: linkId,
    }),
    { singletonKey: `${linkId}:create` },
  );
  return { linkId, version };
}

/**
 * Asks the worker to cancel the open Payment Link of an order whose row the caller locked, as
 * members do on the order page and keys through `POST /orders/{id}/cancel-payment` (ADR-283); the
 * order waits for payment until Razorpay confirms the cancellation. Asking again while it is being
 * cancelled changes nothing (`requested` false); an order without an open link is refused. Each
 * caller writes its own audit row when `requested` is true.
 */
export async function writePaymentLinkCancel(
  tx: Tx,
  deps: Pick<CommerceDeps, 'jobs' | 'signer' | 'clock'>,
  tenantId: string,
  orderId: string,
  actorUserId: string | null,
): Promise<{ requested: boolean }> {
  const [link] = await tx
    .select({
      id: commercePaymentLinks.id,
      cancelRequestedAt: commercePaymentLinks.cancelRequestedAt,
    })
    .from(commercePaymentLinks)
    .where(
      and(
        eq(commercePaymentLinks.tenantId, tenantId),
        eq(commercePaymentLinks.orderId, orderId),
        inArray(commercePaymentLinks.status, [...OPEN_PAYMENT_LINK_STATUSES]),
      ),
    )
    .for('update');
  if (!link) throw new AppError('conflict', 'This order has no open Payment Link.');
  if (link.cancelRequestedAt) return { requested: false };
  const now = deps.clock.now();
  await tx
    .update(commercePaymentLinks)
    .set({
      cancelRequestedAt: now,
      nextCheckAt: now,
      version: sql`${commercePaymentLinks.version} + 1`,
    })
    .where(and(eq(commercePaymentLinks.tenantId, tenantId), eq(commercePaymentLinks.id, link.id)));
  await deps.jobs.enqueue(
    tx,
    QUEUES.commerceLink.name,
    deps.signer.sign({ kind: 'commerce.link', tenantId, actorUserId, ref: link.id }),
    { singletonKey: `${link.id}:cancel` },
  );
  return { requested: true };
}

export function createCommerceService(deps: CommerceDeps) {
  const { db } = deps;

  const enqueue = (
    tx: Tx,
    ctx: TenantContext,
    queue: 'commerceSync' | 'commerceLink' | 'commerceAccount',
    kind: string,
    ref: string,
    singletonKey: string,
  ) =>
    deps.jobs.enqueue(
      tx,
      QUEUES[queue].name,
      deps.signer.sign({ kind, tenantId: ctx.tenant.id, actorUserId: ctx.user.id, ref }),
      { singletonKey },
    );

  /** Orders a member may see: those of conversations they can see (SQL form of canSeeConversation). */
  function orderVisibility(ctx: TenantContext): SQL | undefined {
    if (can(ctx, 'inbox.read_all')) return undefined;
    if (!can(ctx, 'inbox.read_assigned')) return sql`false`;
    return or(
      isNull(conversations.assignedMembershipId),
      eq(conversations.assignedMembershipId, ctx.membership.id),
    );
  }

  async function lockOrder(tx: Tx, ctx: TenantContext, id: string, expectedVersion?: number) {
    const [order] = await tx
      .select()
      .from(commerceOrders)
      .where(and(eq(commerceOrders.tenantId, ctx.tenant.id), eq(commerceOrders.id, id)))
      .for('update');
    if (!order) throw notFound('Order');
    const [conv] = await tx
      .select({ assignedMembershipId: conversations.assignedMembershipId })
      .from(conversations)
      .where(
        and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, order.conversationId)),
      );
    if (!conv || !canSeeConversation(ctx, conv.assignedMembershipId)) throw notFound('Order');
    if (expectedVersion !== undefined && order.version !== expectedVersion) throw stale();
    return order;
  }

  /**
   * A connected account of the company whose management calls Meta does not throttle: while it
   * does, the action says so instead of queuing a catalog read (ADR-399).
   */
  async function connectedAccount(tx: Tx, ctx: TenantContext, whatsappAccountId: string) {
    const [account] = await tx
      .select({
        id: whatsappAccounts.id,
        status: whatsappAccounts.status,
        managementPausedUntil: whatsappAccounts.managementPausedUntil,
      })
      .from(whatsappAccounts)
      .where(
        and(
          eq(whatsappAccounts.tenantId, ctx.tenant.id),
          eq(whatsappAccounts.id, whatsappAccountId),
        ),
      );
    if (!account || account.status !== 'connected') {
      throw invalid('whatsappAccountId', 'Choose a connected WhatsApp account.');
    }
    assertManagementOpen(account.managementPausedUntil, deps.clock.now(), ctx.tenant.timezone);
  }

  return {
    /** Each WhatsApp account with its catalog read and the catalogs Meta reported. */
    async catalogs(ctx: TenantContext) {
      assertCan(ctx, 'commerce.read');
      return db.run(
        ctx.scope,
        async (tx) => {
          const accounts = await tx
            .select({
              id: whatsappAccounts.id,
              name: whatsappAccounts.name,
              wabaId: whatsappAccounts.wabaId,
              status: whatsappAccounts.status,
              syncState: commerceSyncs.state,
              syncError: commerceSyncs.error,
              syncRequestedAt: commerceSyncs.requestedAt,
              syncFinishedAt: commerceSyncs.finishedAt,
              syncVersion: commerceSyncs.version,
            })
            .from(whatsappAccounts)
            .leftJoin(
              commerceSyncs,
              and(
                eq(commerceSyncs.tenantId, whatsappAccounts.tenantId),
                eq(commerceSyncs.whatsappAccountId, whatsappAccounts.id),
              ),
            )
            .where(eq(whatsappAccounts.tenantId, ctx.tenant.id))
            .orderBy(asc(whatsappAccounts.createdAt));
          const catalogs = await tx
            .select({
              id: commerceCatalogs.id,
              whatsappAccountId: commerceCatalogs.whatsappAccountId,
              metaCatalogId: commerceCatalogs.metaCatalogId,
              name: commerceCatalogs.name,
              productCount: commerceCatalogs.productCount,
              truncated: commerceCatalogs.truncated,
              disconnectedAt: commerceCatalogs.disconnectedAt,
              syncedAt: commerceCatalogs.syncedAt,
              listed: sql<number>`(select count(*) from app.commerce_products p
                where p.tenant_id = ${outerColumn(commerceCatalogs.tenantId)}
                  and p.catalog_id = ${outerColumn(commerceCatalogs.id)} and p.removed_at is null)::int`,
            })
            .from(commerceCatalogs)
            .where(eq(commerceCatalogs.tenantId, ctx.tenant.id))
            .orderBy(asc(commerceCatalogs.createdAt));
          return accounts.map((a) => ({
            id: a.id,
            name: a.name ?? `WhatsApp account ${a.wabaId}`,
            connected: a.status === 'connected',
            sync: {
              state: a.syncState ?? 'idle',
              error: a.syncError,
              requestedAt: a.syncRequestedAt?.toISOString() ?? null,
              finishedAt: a.syncFinishedAt?.toISOString() ?? null,
            },
            catalogs: catalogs
              .filter((c) => c.whatsappAccountId === a.id)
              .map((c) => ({
                ...c,
                disconnectedAt: c.disconnectedAt?.toISOString() ?? null,
                syncedAt: c.syncedAt?.toISOString() ?? null,
              })),
          }));
        },
        { accessMode: 'read only' },
      );
    },

    /** Asks the worker to read the account's catalogs and products from Meta again. */
    async requestSync(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      const data = parseInput(z.object({ whatsappAccountId: z.uuid() }), input);
      return db.run(ctx.scope, async (tx) => {
        await connectedAccount(tx, ctx, data.whatsappAccountId);
        const now = deps.clock.now();
        await tx
          .insert(commerceSyncs)
          .values({
            id: uuidv7(),
            tenantId: ctx.tenant.id,
            whatsappAccountId: data.whatsappAccountId,
            state: 'queued',
            requestedAt: now,
          })
          .onConflictDoUpdate({
            target: [commerceSyncs.tenantId, commerceSyncs.whatsappAccountId],
            set: {
              state: 'queued',
              error: null,
              requestedAt: now,
              // A new request: an earlier deferral for a pause no longer applies (ADR-399).
              managementDeferredUntil: null,
              version: sql`${commerceSyncs.version} + 1`,
            },
            // A read already waiting or running is not requested twice.
            setWhere: sql`${commerceSyncs.state} not in ('queued', 'running')`,
          });
        await enqueue(
          tx,
          ctx,
          'commerceSync',
          'commerce.sync',
          data.whatsappAccountId,
          `${data.whatsappAccountId}:${now.getTime()}`,
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.catalog_sync_requested',
            subjectType: 'whatsapp_account',
            subjectId: data.whatsappAccountId,
            metadata: {},
          },
          meta,
        );
        return { ok: true as const };
      });
    },

    /** Products of a catalog as last read from Meta, by name, with search and pages of 100. */
    async products(
      ctx: TenantContext,
      catalogId: string,
      options: { q?: string; page?: number } = {},
    ) {
      assertCan(ctx, 'commerce.read');
      if (!z.uuid().safeParse(catalogId).success) throw notFound('Catalog');
      const q = options.q?.trim().slice(0, 100) ?? '';
      const page = Math.min(Math.max(Math.trunc(options.page ?? 1), 1), 100);
      return db.run(
        ctx.scope,
        async (tx) => {
          const [catalog] = await tx
            .select({
              id: commerceCatalogs.id,
              name: commerceCatalogs.name,
              metaCatalogId: commerceCatalogs.metaCatalogId,
              whatsappAccountId: commerceCatalogs.whatsappAccountId,
              truncated: commerceCatalogs.truncated,
              disconnectedAt: commerceCatalogs.disconnectedAt,
              syncedAt: commerceCatalogs.syncedAt,
            })
            .from(commerceCatalogs)
            .where(
              and(eq(commerceCatalogs.tenantId, ctx.tenant.id), eq(commerceCatalogs.id, catalogId)),
            );
          if (!catalog) throw notFound('Catalog');
          const pattern = q ? likePattern(q) : null;
          const rows = await tx
            .select({
              id: commerceProducts.id,
              retailerId: commerceProducts.retailerId,
              name: commerceProducts.name,
              priceText: commerceProducts.priceText,
              availability: commerceProducts.availability,
              reviewStatus: commerceProducts.reviewStatus,
            })
            .from(commerceProducts)
            .where(
              and(
                eq(commerceProducts.tenantId, ctx.tenant.id),
                eq(commerceProducts.catalogId, catalogId),
                isNull(commerceProducts.removedAt),
                pattern
                  ? sql`(${commerceProducts.name} ilike ${pattern} or ${commerceProducts.retailerId} ilike ${pattern})`
                  : undefined,
              ),
            )
            .orderBy(asc(commerceProducts.name), asc(commerceProducts.id))
            .limit(101)
            .offset((page - 1) * 100);
          return {
            catalog: {
              ...catalog,
              disconnectedAt: catalog.disconnectedAt?.toISOString() ?? null,
              syncedAt: catalog.syncedAt?.toISOString() ?? null,
            },
            products: rows.slice(0, 100),
            page,
            hasMore: rows.length > 100,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * The products a member can send in a conversation: those of the catalogs connected to the
     * conversation's WhatsApp account (at most 500, by name; search narrows them).
     */
    async sendableProducts(ctx: TenantContext, conversationId: string, q = '') {
      assertCan(ctx, 'inbox.reply');
      if (!can(ctx, 'commerce.read') || !z.uuid().safeParse(conversationId).success) return [];
      const pattern = q.trim() ? likePattern(q.trim().slice(0, 100)) : null;
      return db.run(
        ctx.scope,
        async (tx) => {
          const [conv] = await tx
            .select({
              whatsappAccountId: channelAccounts.whatsappAccountId,
              assignedMembershipId: conversations.assignedMembershipId,
            })
            .from(conversations)
            .innerJoin(
              channelAccounts,
              and(
                eq(channelAccounts.tenantId, conversations.tenantId),
                eq(channelAccounts.id, conversations.channelAccountId),
              ),
            )
            .where(
              and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)),
            );
          if (!conv || !canSeeConversation(ctx, conv.assignedMembershipId)) return [];
          return tx
            .select({
              id: commerceProducts.id,
              catalogId: commerceProducts.catalogId,
              catalogName: commerceCatalogs.name,
              retailerId: commerceProducts.retailerId,
              name: commerceProducts.name,
              priceText: commerceProducts.priceText,
              availability: commerceProducts.availability,
            })
            .from(commerceProducts)
            .innerJoin(
              commerceCatalogs,
              and(
                eq(commerceCatalogs.tenantId, commerceProducts.tenantId),
                eq(commerceCatalogs.id, commerceProducts.catalogId),
              ),
            )
            .where(
              and(
                eq(commerceProducts.tenantId, ctx.tenant.id),
                eq(commerceCatalogs.whatsappAccountId, conv.whatsappAccountId),
                isNull(commerceCatalogs.disconnectedAt),
                isNull(commerceProducts.removedAt),
                pattern
                  ? sql`(${commerceProducts.name} ilike ${pattern} or ${commerceProducts.retailerId} ilike ${pattern})`
                  : undefined,
              ),
            )
            .orderBy(asc(commerceProducts.name), asc(commerceProducts.id))
            .limit(500);
        },
        { accessMode: 'read only' },
      );
    },

    /** Sends products in a conversation (a reply: the customer service window must be open). */
    async sendProducts(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'inbox.reply');
      assertModule(ctx.plan, 'commerce');
      assertCan(ctx, 'commerce.read');
      const data = parseInput(
        z.object({
          conversationId: z.uuid(),
          clientKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
          message: productMessageSchema,
        }),
        input,
      );
      if (data.message.kind === 'product_list') {
        const problem = productListProblem(data.message.sections);
        if (problem) throw invalid('message', problem);
      }
      const now = deps.clock.now();
      return db.run(ctx.scope, async (tx) => {
        const [existing] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.tenantId, ctx.tenant.id), eq(messages.clientKey, data.clientKey)));
        if (existing) return { messageId: existing.id, duplicate: true };
        const [conv] = await tx
          .select({
            id: conversations.id,
            assignedMembershipId: conversations.assignedMembershipId,
            lastInboundAt: conversations.lastInboundAt,
            channelAccountId: conversations.channelAccountId,
            contactId: conversations.contactId,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, ctx.tenant.id),
              eq(conversations.id, data.conversationId),
            ),
          )
          .for('update');
        if (!conv || !canSeeConversation(ctx, conv.assignedMembershipId))
          throw notFound('Conversation');
        const [channel] = await tx
          .select({
            status: channelAccounts.status,
            whatsappAccountId: channelAccounts.whatsappAccountId,
          })
          .from(channelAccounts)
          .where(
            and(
              eq(channelAccounts.tenantId, ctx.tenant.id),
              eq(channelAccounts.id, conv.channelAccountId),
            ),
          );
        if (!channel || channel.status !== 'active') {
          throw new AppError(
            'precondition_failed',
            'This WhatsApp number is not active. Reconnect it in Settings → Channels.',
          );
        }
        if (
          !conv.lastInboundAt ||
          now.getTime() - conv.lastInboundAt.getTime() > SERVICE_WINDOW_MS
        ) {
          throw new AppError(
            'precondition_failed',
            'The 24-hour customer service window has closed. Products can be sent only while it is open.',
          );
        }
        const message = data.message;
        const productIds =
          message.kind === 'product'
            ? [message.productId]
            : message.kind === 'catalog'
              ? [message.thumbnailProductId]
              : message.sections.flatMap((s) => s.productIds);
        const found = await tx
          .select({
            id: commerceProducts.id,
            retailerId: commerceProducts.retailerId,
            name: commerceProducts.name,
            catalogId: commerceCatalogs.metaCatalogId,
          })
          .from(commerceProducts)
          .innerJoin(
            commerceCatalogs,
            and(
              eq(commerceCatalogs.tenantId, commerceProducts.tenantId),
              eq(commerceCatalogs.id, commerceProducts.catalogId),
            ),
          )
          .where(
            and(
              eq(commerceProducts.tenantId, ctx.tenant.id),
              inArray(commerceProducts.id, productIds),
              eq(commerceCatalogs.whatsappAccountId, channel.whatsappAccountId),
              isNull(commerceCatalogs.disconnectedAt),
              isNull(commerceProducts.removedAt),
            ),
          );
        const byId = new Map(found.map((p) => [p.id, p]));
        if (productIds.some((id) => !byId.has(id))) {
          throw invalid('message', 'Choose products from a catalog of this WhatsApp number.');
        }
        const catalogIds = new Set(found.map((p) => p.catalogId));
        if (catalogIds.size !== 1) throw invalid('message', 'Choose products from one catalog.');
        const catalogId = [...catalogIds][0] as string;
        const product = (id: string) => byId.get(id) as (typeof found)[number];
        let resolved: ResolvedProductMessage;
        switch (message.kind) {
          case 'product':
            resolved = {
              kind: 'product',
              catalogId,
              retailerId: product(message.productId).retailerId,
              body: message.body,
              footer: message.footer,
            };
            break;
          case 'product_list':
            resolved = {
              kind: 'product_list',
              catalogId,
              header: message.header,
              body: message.body,
              footer: message.footer,
              sections: message.sections.map((s) => ({
                title: s.title,
                retailerIds: s.productIds.map((id) => product(id).retailerId),
              })),
            };
            break;
          case 'catalog':
            resolved = {
              kind: 'catalog',
              thumbnailRetailerId: product(message.thumbnailProductId).retailerId,
              body: message.body,
              footer: message.footer,
            };
            break;
        }
        const [identity] = await tx
          .select({ waId: contactIdentities.waId })
          .from(contactIdentities)
          .where(
            and(
              eq(contactIdentities.tenantId, ctx.tenant.id),
              eq(contactIdentities.contactId, conv.contactId),
              eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
            ),
          )
          .limit(1);
        if (!identity?.waId) {
          throw new AppError(
            'unsupported',
            'This contact is known only by a WhatsApp user id. Sending to user ids is not enabled until Meta’s request format is verified.',
          );
        }
        await endRunForHuman(tx, {
          tenantId: ctx.tenant.id,
          conversationId: conv.id,
          reason: 'agent_replied',
          actorMembershipId: ctx.membership.id,
          now,
        });
        const messageId = uuidv7();
        const intentId = uuidv7();
        const names = productIds.map((id) => product(id).name);
        await tx.insert(messages).values({
          id: messageId,
          tenantId: ctx.tenant.id,
          conversationId: conv.id,
          channelAccountId: conv.channelAccountId,
          direction: 'outbound',
          type: 'interactive',
          content: {
            products: {
              kind: message.kind,
              names: names.slice(0, COMMERCE_LIMITS.productsPerMessage),
              ...('header' in message ? { header: message.header } : {}),
              body: message.body,
              footer: message.footer,
            },
          },
          status: 'queued',
          statusRank: STATUS_RANK.queued,
          senderType: 'agent',
          senderMembershipId: ctx.membership.id,
          clientKey: data.clientKey,
        });
        await tx.insert(sendIntents).values({
          id: intentId,
          tenantId: ctx.tenant.id,
          messageId,
          channelAccountId: conv.channelAccountId,
          request: buildProductMessageRequest(identity.waId, resolved),
          actorUserId: ctx.user.id,
        });
        const preview =
          message.kind === 'catalog'
            ? '[Catalog]'
            : message.kind === 'product'
              ? `[Product] ${names[0] ?? ''}`
              : `[Products] ${names.length}`;
        const claim = conv.assignedMembershipId === null;
        await tx
          .update(conversations)
          .set({
            lastMessageAt: now,
            lastMessagePreview: clipText(preview, 200),
            unreadCount: 0,
            status: 'open',
            ...(claim ? { assignedMembershipId: ctx.membership.id } : {}),
            version: sql`${conversations.version} + 1`,
          })
          .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conv.id)));
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: 'message.created',
          conversationId: conv.id,
          assignedMembershipId: claim ? ctx.membership.id : conv.assignedMembershipId,
          payload: { messageId },
        });
        await deps.jobs.enqueue(
          tx,
          QUEUES.messageSend.name,
          deps.signer.sign({
            kind: 'message.send',
            tenantId: ctx.tenant.id,
            actorUserId: ctx.user.id,
            ref: intentId,
          }),
          { singletonKey: intentId, group: { id: conv.channelAccountId } },
        );
        return { messageId, duplicate: false };
      });
    },

    /** Orders of conversations the member can see, newest first. */
    async orders(
      ctx: TenantContext,
      options: { status?: string; conversationId?: string; before?: string } = {},
    ): Promise<{ orders: OrderListItem[]; older: string | null }> {
      assertCan(ctx, 'commerce.read');
      const status = (MEMBER_ORDER_TRANSITIONS as Record<string, unknown>)[options.status ?? '']
        ? (options.status as OrderStatus)
        : null;
      const conversationId =
        options.conversationId && z.uuid().safeParse(options.conversationId).success
          ? options.conversationId
          : null;
      const before = parseOrderCursor(options.before);
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: commerceOrders.id,
              reference: commerceOrders.reference,
              status: commerceOrders.status,
              currency: commerceOrders.currency,
              subtotalMinor: commerceOrders.subtotalMinor,
              itemCount: commerceOrders.itemCount,
              contactName: contacts.displayName,
              contactErased: sql<boolean>`${contacts.erasedAt} is not null`,
              conversationId: commerceOrders.conversationId,
              receivedAt: commerceOrders.receivedAt,
            })
            .from(commerceOrders)
            .innerJoin(
              conversations,
              and(
                eq(conversations.tenantId, commerceOrders.tenantId),
                eq(conversations.id, commerceOrders.conversationId),
              ),
            )
            .innerJoin(
              contacts,
              and(
                eq(contacts.tenantId, commerceOrders.tenantId),
                eq(contacts.id, commerceOrders.contactId),
              ),
            )
            .where(
              and(
                eq(commerceOrders.tenantId, ctx.tenant.id),
                orderVisibility(ctx),
                status ? eq(commerceOrders.status, status) : undefined,
                conversationId ? eq(commerceOrders.conversationId, conversationId) : undefined,
                before
                  ? or(
                      lt(commerceOrders.receivedAt, before.at),
                      and(
                        eq(commerceOrders.receivedAt, before.at),
                        lt(commerceOrders.id, before.id),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(commerceOrders.receivedAt), desc(commerceOrders.id))
            .limit(51),
        { accessMode: 'read only' },
      );
      const page = rows.slice(0, 50);
      const last = page.at(-1);
      return {
        orders: page.map(({ contactErased, ...r }) => ({
          ...r,
          contactName: contactErased ? 'Erased contact' : r.contactName,
          receivedAt: r.receivedAt.toISOString(),
        })),
        older: rows.length > 50 && last ? `${last.receivedAt.toISOString()}~${last.id}` : null,
      };
    },

    /**
     * The orders of conversations the member can see as CSV (ADR-235), newest first, streamed in
     * batches, as the list filters them by status. They carry customers' names, numbers and notes,
     * so they need `contacts.export` too; numbers are shown as the member may see them (ADR-226).
     * Audited before the first line.
     */
    async *exportOrders(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): AsyncGenerator<string> {
      assertCan(ctx, 'commerce.read');
      assertCan(ctx, 'contacts.export');
      const { status } = parseInput(orderExportSchema, input ?? {});
      await db.run(ctx.scope, (tx) =>
        recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.orders_exported',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: { status: status ?? null },
          },
          meta,
        ),
      );
      yield CSV_BOM + csvLine(ORDER_CSV_COLUMNS);
      let before: { at: Date; id: string } | null = null;
      for (;;) {
        const cursor: { at: Date; id: string } | null = before;
        const rows: OrderCsvRow[] = await db.run(
          ctx.scope,
          (tx) =>
            tx
              .select({
                id: commerceOrders.id,
                reference: commerceOrders.reference,
                receivedAt: commerceOrders.receivedAt,
                status: commerceOrders.status,
                statusChangedAt: commerceOrders.statusChangedAt,
                paidAt: commerceOrders.paidAt,
                contactName: contacts.displayName,
                contactPhone: contacts.phoneE164,
                contactErased: sql<boolean>`${contacts.erasedAt} is not null`,
                items: sql<string | null>`(select string_agg(i.quantity || ' × ' ||
                    coalesce(i.name, i.retailer_id), '; ' order by i.position)
                  from app.commerce_order_items i
                  where i.tenant_id = ${commerceOrders.tenantId} and i.order_id = ${commerceOrders.id})`,
                itemCount: commerceOrders.itemCount,
                droppedItems: commerceOrders.droppedItems,
                currency: commerceOrders.currency,
                subtotalMinor: commerceOrders.subtotalMinor,
                customerNote: commerceOrders.customerNote,
              })
              .from(commerceOrders)
              .innerJoin(
                conversations,
                and(
                  eq(conversations.tenantId, commerceOrders.tenantId),
                  eq(conversations.id, commerceOrders.conversationId),
                ),
              )
              .innerJoin(
                contacts,
                and(
                  eq(contacts.tenantId, commerceOrders.tenantId),
                  eq(contacts.id, commerceOrders.contactId),
                ),
              )
              .where(
                and(
                  eq(commerceOrders.tenantId, ctx.tenant.id),
                  orderVisibility(ctx),
                  status ? eq(commerceOrders.status, status) : undefined,
                  cursor
                    ? or(
                        lt(commerceOrders.receivedAt, cursor.at),
                        and(
                          eq(commerceOrders.receivedAt, cursor.at),
                          lt(commerceOrders.id, cursor.id),
                        ),
                      )
                    : undefined,
                ),
              )
              .orderBy(desc(commerceOrders.receivedAt), desc(commerceOrders.id))
              .limit(ORDER_EXPORT_BATCH),
          { accessMode: 'read only' },
        );
        if (rows.length === 0) break;
        yield rows.map((r) => orderCsvLine(r, (phone) => shownNumber(ctx, phone))).join('');
        const last = rows.at(-1);
        if (!last || rows.length < ORDER_EXPORT_BATCH) break;
        before = { at: last.receivedAt, id: last.id };
      }
    },

    /** One order with its items, its Payment Links and what the member may do. */
    async order(ctx: TenantContext, id: string) {
      assertCan(ctx, 'commerce.read');
      if (!z.uuid().safeParse(id).success) throw notFound('Order');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [row] = await tx
            .select({
              order: commerceOrders,
              assignedMembershipId: conversations.assignedMembershipId,
              contactName: contacts.displayName,
              contactErased: sql<boolean>`${contacts.erasedAt} is not null`,
            })
            .from(commerceOrders)
            .innerJoin(
              conversations,
              and(
                eq(conversations.tenantId, commerceOrders.tenantId),
                eq(conversations.id, commerceOrders.conversationId),
              ),
            )
            .innerJoin(
              contacts,
              and(
                eq(contacts.tenantId, commerceOrders.tenantId),
                eq(contacts.id, commerceOrders.contactId),
              ),
            )
            .where(and(eq(commerceOrders.tenantId, ctx.tenant.id), eq(commerceOrders.id, id)));
          if (!row || !canSeeConversation(ctx, row.assignedMembershipId)) throw notFound('Order');
          const items = await tx
            .select({
              position: commerceOrderItems.position,
              retailerId: commerceOrderItems.retailerId,
              name: commerceOrderItems.name,
              quantity: commerceOrderItems.quantity,
              unitPriceMinor: commerceOrderItems.unitPriceMinor,
              currency: commerceOrderItems.currency,
            })
            .from(commerceOrderItems)
            .where(
              and(
                eq(commerceOrderItems.tenantId, ctx.tenant.id),
                eq(commerceOrderItems.orderId, id),
              ),
            )
            .orderBy(asc(commerceOrderItems.position));
          const links = await tx
            .select({
              id: commercePaymentLinks.id,
              status: commercePaymentLinks.status,
              amountMinor: commercePaymentLinks.amountMinor,
              amountPaidMinor: commercePaymentLinks.amountPaidMinor,
              currency: commercePaymentLinks.currency,
              shortUrl: commercePaymentLinks.shortUrl,
              error: commercePaymentLinks.error,
              sendError: commercePaymentLinks.sendError,
              cancelRequestedAt: commercePaymentLinks.cancelRequestedAt,
              expiresAt: commercePaymentLinks.expiresAt,
              paidAt: commercePaymentLinks.paidAt,
              checkedAt: commercePaymentLinks.checkedAt,
              messageId: commercePaymentLinks.messageId,
              createdAt: commercePaymentLinks.createdAt,
              // Asked for by an API key rather than a member (ADR-283).
              throughApi: sql<boolean>`(${commercePaymentLinks.createdByApiKeyId} IS NOT NULL)`,
            })
            .from(commercePaymentLinks)
            .where(
              and(
                eq(commercePaymentLinks.tenantId, ctx.tenant.id),
                eq(commercePaymentLinks.orderId, id),
              ),
            )
            .orderBy(desc(commercePaymentLinks.createdAt));
          const [account] = await tx
            .select({
              status: commercePaymentAccounts.status,
              keyId: commercePaymentAccounts.keyId,
            })
            .from(commercePaymentAccounts)
            .where(eq(commercePaymentAccounts.tenantId, ctx.tenant.id));
          const order = row.order;
          const openLink = links.find((l) => OPEN_PAYMENT_LINK_STATUSES.includes(l.status));
          const canAct = can(ctx, 'inbox.reply');
          const payable =
            canAct &&
            PAYABLE_ORDER_STATUSES.includes(order.status) &&
            !openLink &&
            order.currency === 'INR' &&
            order.subtotalMinor !== null &&
            order.subtotalMinor >= COMMERCE_LIMITS.minPaymentMinor &&
            order.subtotalMinor <= COMMERCE_LIMITS.maxPaymentMinor;
          return {
            order: {
              id: order.id,
              reference: order.reference,
              status: order.status,
              currency: order.currency,
              subtotalMinor: order.subtotalMinor,
              itemCount: order.itemCount,
              droppedItems: order.droppedItems,
              customerNote: order.customerNote,
              receivedAt: order.receivedAt.toISOString(),
              statusChangedAt: order.statusChangedAt.toISOString(),
              paidAt: order.paidAt?.toISOString() ?? null,
              conversationId: order.conversationId,
              version: order.version,
              contactName: row.contactErased ? 'Erased contact' : row.contactName,
            },
            items,
            links: links.map((l) => ({
              ...l,
              expiresAt: l.expiresAt.toISOString(),
              paidAt: l.paidAt?.toISOString() ?? null,
              checkedAt: l.checkedAt?.toISOString() ?? null,
              cancelRequestedAt: l.cancelRequestedAt?.toISOString() ?? null,
              createdAt: l.createdAt.toISOString(),
            })),
            nextStatuses: canAct ? MEMBER_ORDER_TRANSITIONS[order.status] : [],
            payment: {
              account: account
                ? { status: account.status, mode: razorpayMode(account.keyId) }
                : null,
              payable: payable && account?.status === 'verified',
              why:
                order.droppedItems > 0
                  ? DROPPED_ITEMS_MESSAGE
                  : order.currency !== 'INR'
                    ? 'Payment Links are for amounts in Indian rupees.'
                    : order.subtotalMinor === null
                      ? 'The order total could not be worked out from the prices WhatsApp sent.'
                      : order.subtotalMinor < COMMERCE_LIMITS.minPaymentMinor
                        ? 'Razorpay needs at least ₹1.'
                        : order.subtotalMinor > COMMERCE_LIMITS.maxPaymentMinor
                          ? PAYMENT_CAP_MESSAGE
                          : !account
                            ? 'Add your Razorpay account in Commerce → Payments first.'
                            : account.status !== 'verified'
                              ? 'Your Razorpay account has not been checked successfully.'
                              : null,
              canCancelLink: canAct && Boolean(openLink) && !openLink?.cancelRequestedAt,
            },
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** Moves an order along (confirm, fulfil, cancel); payment statuses come only from Razorpay. */
    async setOrderStatus(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.read');
      assertCan(ctx, 'inbox.reply');
      assertModule(ctx.plan, 'commerce');
      const data = parseInput(
        versioned.extend({ status: z.enum(['confirmed', 'fulfilled', 'cancelled']) }),
        input,
      );
      return db.run(ctx.scope, async (tx) => {
        const order = await lockOrder(tx, ctx, data.id, data.expectedVersion);
        if (!MEMBER_ORDER_TRANSITIONS[order.status].includes(data.status)) {
          throw new AppError(
            'conflict',
            order.status === 'awaiting_payment'
              ? 'This order is waiting for payment: cancel its Payment Link first.'
              : 'The order cannot move to that status from its current one.',
          );
        }
        const version = await writeLockedOrderStatus(
          tx,
          ctx.tenant.id,
          order,
          data.status,
          deps.clock.now(),
          'member',
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.order_status_changed',
            subjectType: 'commerce_order',
            subjectId: order.id,
            metadata: { reference: order.reference, from: order.status, to: data.status },
          },
          meta,
        );
        return { version };
      });
    },

    /**
     * Asks the customer to pay the order's subtotal with a Payment Link from the company's own
     * Razorpay account. The link is written ahead; the worker creates it once and sends it in the
     * chat. The order waits for payment until Razorpay reports the link paid, expired or cancelled.
     */
    async requestPayment(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.read');
      assertCan(ctx, 'inbox.reply');
      assertModule(ctx.plan, 'commerce');
      const data = parseInput(versioned, input);
      const now = deps.clock.now();
      return db.run(ctx.scope, async (tx) => {
        const order = await lockOrder(tx, ctx, data.id, data.expectedVersion);
        const requested = await writePaymentRequest(
          tx,
          deps,
          ctx.tenant.id,
          order,
          { membershipId: ctx.membership.id, userId: ctx.user.id },
          now,
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.payment_requested',
            subjectType: 'commerce_order',
            subjectId: order.id,
            metadata: {
              reference: order.reference,
              amountMinor: order.subtotalMinor,
              currency: 'INR',
            },
          },
          meta,
        );
        return requested;
      });
    },

    /** Cancels an order's open Payment Link at Razorpay (the worker performs it). */
    async cancelPaymentLink(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.read');
      assertCan(ctx, 'inbox.reply');
      const data = parseInput(z.object({ orderId: z.uuid() }), input);
      return db.run(ctx.scope, async (tx) => {
        const order = await lockOrder(tx, ctx, data.orderId);
        const { requested } = await writePaymentLinkCancel(
          tx,
          deps,
          ctx.tenant.id,
          order.id,
          ctx.user.id,
        );
        if (requested) {
          await recordAudit(
            tx,
            ctx,
            {
              action: 'commerce.payment_link_cancel_requested',
              subjectType: 'commerce_order',
              subjectId: order.id,
              metadata: { reference: order.reference },
            },
            meta,
          );
        }
        return { ok: true as const };
      });
    },

    /** The company's Razorpay account as members may see it (never the secrets). */
    async paymentAccount(ctx: TenantContext) {
      assertCan(ctx, 'commerce.read');
      const manage = can(ctx, 'commerce.manage');
      const [account] = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              keyId: commercePaymentAccounts.keyId,
              status: commercePaymentAccounts.status,
              statusError: commercePaymentAccounts.statusError,
              checkedAt: commercePaymentAccounts.checkedAt,
              webhookPublicId: commercePaymentAccounts.webhookPublicId,
              version: commercePaymentAccounts.version,
            })
            .from(commercePaymentAccounts)
            .where(eq(commercePaymentAccounts.tenantId, ctx.tenant.id)),
        { accessMode: 'read only' },
      );
      if (!account) return { account: null, canManage: manage };
      return {
        account: {
          keyId: manage ? account.keyId : null,
          mode: razorpayMode(account.keyId),
          status: account.status,
          statusError: account.statusError,
          checkedAt: account.checkedAt?.toISOString() ?? null,
          version: account.version,
          webhookUrl: manage
            ? `${deps.appBaseUrl.replace(/\/$/, '')}/api/webhooks/razorpay-links/${account.webhookPublicId}`
            : null,
        },
        canManage: manage,
      };
    },

    /** Saves the company's Razorpay keys (write-only) and asks the worker to check them. */
    async savePaymentAccount(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      // Payments for the company's orders go to these keys' account (ADR-056).
      assertRecentSignIn(ctx, deps.clock.now());
      const data = parseInput(accountSchema, input);
      if (razorpayMode(data.keyId) === 'live' && !deps.allowLiveKeys) {
        throw invalid(
          'keyId',
          'Live Razorpay keys can be used only in production. Use test keys here.',
        );
      }
      return db.run(ctx.scope, async (tx) => {
        const [existing] = await tx
          .select({ id: commercePaymentAccounts.id, version: commercePaymentAccounts.version })
          .from(commercePaymentAccounts)
          .where(eq(commercePaymentAccounts.tenantId, ctx.tenant.id))
          .for('update');
        const id = existing?.id ?? uuidv7();
        const secrets = {
          keySecretCiphertext: deps.keyring.encrypt(
            data.keySecret,
            paymentAccountAad(ctx.tenant.id, id, 'key'),
          ),
          webhookSecretCiphertext: deps.keyring.encrypt(
            data.webhookSecret,
            paymentAccountAad(ctx.tenant.id, id, 'webhook'),
          ),
        };
        if (existing) {
          await tx
            .update(commercePaymentAccounts)
            .set({
              keyId: data.keyId,
              ...secrets,
              status: 'checking',
              statusError: null,
              version: existing.version + 1,
              updatedByMembershipId: ctx.membership.id,
            })
            .where(
              and(
                eq(commercePaymentAccounts.tenantId, ctx.tenant.id),
                eq(commercePaymentAccounts.id, id),
              ),
            );
        } else {
          await tx.insert(commercePaymentAccounts).values({
            id,
            tenantId: ctx.tenant.id,
            keyId: data.keyId,
            ...secrets,
            webhookPublicId: newPaymentWebhookId(),
            status: 'checking',
            updatedByMembershipId: ctx.membership.id,
          });
        }
        await enqueue(
          tx,
          ctx,
          'commerceAccount',
          'commerce.account',
          id,
          `${id}:${deps.clock.now().getTime()}`,
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.payment_account_saved',
            subjectType: 'commerce_payment_account',
            subjectId: id,
            metadata: { keyId: data.keyId, mode: razorpayMode(data.keyId) },
          },
          meta,
        );
        return { ok: true as const };
      });
    },

    /** Removes the company's Razorpay keys (refused while Payment Links are open). */
    async removePaymentAccount(ctx: TenantContext, meta: RequestMeta = {}) {
      assertCan(ctx, 'commerce.manage');
      return db.run(ctx.scope, async (tx) => {
        const [account] = await tx
          .select({ id: commercePaymentAccounts.id, keyId: commercePaymentAccounts.keyId })
          .from(commercePaymentAccounts)
          .where(eq(commercePaymentAccounts.tenantId, ctx.tenant.id))
          .for('update');
        if (!account) return { ok: true as const };
        const [open] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(commercePaymentLinks)
          .where(
            and(
              eq(commercePaymentLinks.tenantId, ctx.tenant.id),
              inArray(commercePaymentLinks.status, [...OPEN_PAYMENT_LINK_STATUSES]),
            ),
          );
        if ((open?.n ?? 0) > 0) {
          throw new AppError(
            'conflict',
            'Some Payment Links are still open. Wait until they are paid, expired or cancelled.',
          );
        }
        await tx
          .delete(commercePaymentAccounts)
          .where(
            and(
              eq(commercePaymentAccounts.tenantId, ctx.tenant.id),
              eq(commercePaymentAccounts.id, account.id),
            ),
          );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'commerce.payment_account_removed',
            subjectType: 'commerce_payment_account',
            subjectId: account.id,
            metadata: { keyId: account.keyId },
          },
          meta,
        );
        return { ok: true as const };
      });
    },
  };
}

export type CommerceService = ReturnType<typeof createCommerceService>;
