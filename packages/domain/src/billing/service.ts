import { AppError, uuidv7, type Clock, type RazorpayConfig } from '@w360/core';
import {
  and,
  autoRechargeAttempts,
  autoRechargeSettings,
  billingCustomers,
  desc,
  eq,
  gt,
  inArray,
  ledgerAccounts,
  paymentMandates,
  sql,
  topups,
  type Database,
  type MandateStatus,
  type TopupStatus,
  type Tx,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import { QUEUES } from '@w360/contracts';
import { cancelPendingAutoRecharge } from './attempts';
import type { BillingNoticeDeps } from './notices';
import {
  applyMandateAuthorization,
  creditFromPayment,
  TransientProviderError,
  type BillingProviderDeps,
} from './payments';
import { verifyCheckoutSignature, type RazorpayClient } from './razorpay';

/**
 * Company-facing billing: the service-credit wallet, manual card top-ups (Razorpay Standard
 * Checkout), the card mandate used by auto-recharge, and auto-recharge settings. Service credit
 * pays for billable HyFib services; in the default direct-Meta billing mode Meta charges the
 * company's own WhatsApp payment method and never touches this wallet (ADR-011).
 *
 * Credit is created only from a captured payment fetched from Razorpay. The Checkout handler's
 * signature proves the browser completed Checkout for our order; it is never enough on its own.
 */
export interface BillingServiceDeps {
  db: Database;
  clock: Clock;
  razorpay: RazorpayClient | null;
  razorpayConfig: RazorpayConfig | null;
  notices: BillingNoticeDeps;
}

/** Manual top-up bounds (the database allows ₹1–₹1,00,000; the product minimum is ₹100). */
export const TOPUP_MIN_MINOR = 10_000;
export const TOPUP_MAX_MINOR = 10_000_000;
/** RBI/Razorpay: card mandates debit at most ₹15,000 without extra authentication (R-032, R-044). */
export const MANDATE_MAX_MINOR = 1_500_000;
export const MANDATE_MIN_MINOR = 10_000;
/** Card mandate registration charges ₹1 (R-035); it is refunded once the mandate is confirmed. */
export const MANDATE_AUTHORIZATION_MINOR = 100;
export const AUTO_RECHARGE_THRESHOLD_MAX_MINOR = 100_000_000;
export const AUTO_RECHARGE_DAILY_CAP_MAX_MINOR = 50_000_000;
export const AUTO_RECHARGE_MONTHLY_CAP_MAX_MINOR = 500_000_000;
/** Manual top-ups a company may start per hour (each creates a Razorpay order). */
const TOPUP_STARTS_PER_HOUR = 20;
const MANDATE_TOKEN_VALIDITY_SECONDS = 5 * 365 * 24 * 3600;

export interface WalletSummary {
  availableMinor: number;
  heldMinor: number;
}

export interface BillingOverview {
  payments: { configured: boolean; mode: 'test' | 'live' | null; recurringCardsEnabled: boolean };
  wallet: WalletSummary;
  topups: {
    id: string;
    kind: 'manual' | 'auto_recharge';
    amountMinor: number;
    status: TopupStatus;
    refundedMinor: number;
    failureReason: string | null;
    createdAt: Date;
    paidAt: Date | null;
  }[];
  transactions: {
    id: string;
    kind: string;
    description: string | null;
    availableEffectMinor: number;
    createdAt: Date;
  }[];
  mandate: {
    id: string;
    status: MandateStatus;
    maxAmountMinor: number;
    cardNetwork: string | null;
    cardLast4: string | null;
    cardExpiryMonth: number | null;
    cardExpiryYear: number | null;
    confirmedAt: Date | null;
  } | null;
  billingContact: { email: string; contact: string } | null;
  autoRecharge: {
    enabled: boolean;
    mandateId: string | null;
    thresholdMinor: number;
    amountMinor: number;
    dailyCapMinor: number;
    monthlyCapMinor: number;
  } | null;
  attempts: {
    id: string;
    status: string;
    amountMinor: number;
    lastError: string | null;
    createdAt: Date;
    resolvedAt: Date | null;
  }[];
}

export interface CheckoutStart {
  keyId: string;
  orderId: string;
  amountMinor: number;
  currency: 'INR';
  companyName: string;
  prefill: { name: string; email: string; contact?: string };
}

function paymentsUnavailable(): AppError {
  return new AppError(
    'provider_unavailable',
    'Card payments are not configured for this platform yet.',
  );
}

function ensureWholePaise(value: number, field: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError('validation_failed', `${field} is out of range.`, {
      issues: [{ path: field, message: 'Out of range' }],
    });
  }
}

async function ensureWallet(tx: Tx): Promise<string> {
  const res = await tx.execute<{ id: string }>(sql`select app.billing_ensure_wallet() as id`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error('wallet could not be created');
  return id;
}

export function createBillingService(deps: BillingServiceDeps) {
  const { db, clock } = deps;

  function provider(): { razorpay: RazorpayClient; config: RazorpayConfig } {
    if (!deps.razorpay || !deps.razorpayConfig) throw paymentsUnavailable();
    return { razorpay: deps.razorpay, config: deps.razorpayConfig };
  }

  function providerDeps(razorpay: RazorpayClient): BillingProviderDeps {
    return { db, razorpay, clock, notices: deps.notices };
  }

  return {
    async overview(ctx: TenantContext): Promise<BillingOverview> {
      assertCan(ctx, 'billing.read');
      const scope = ctx.scope;
      return db.run(
        scope,
        async (tx) => {
          const accounts = await tx
            .select({ code: ledgerAccounts.code, balance: ledgerAccounts.balanceMinor })
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.tenantId, scope.tenantId),
                inArray(ledgerAccounts.code, ['wallet_available', 'wallet_held']),
              ),
            );
          const wallet: WalletSummary = {
            availableMinor: accounts.find((a) => a.code === 'wallet_available')?.balance ?? 0,
            heldMinor: accounts.find((a) => a.code === 'wallet_held')?.balance ?? 0,
          };
          const recentTopups = await tx
            .select({
              id: topups.id,
              kind: topups.kind,
              amountMinor: topups.amountMinor,
              status: topups.status,
              refundedMinor: topups.refundedMinor,
              failureReason: topups.failureReason,
              createdAt: topups.createdAt,
              paidAt: topups.paidAt,
            })
            .from(topups)
            .where(eq(topups.tenantId, scope.tenantId))
            .orderBy(desc(topups.createdAt))
            .limit(20);
          // Effect of each posting on available credit (credit adds, debit subtracts).
          const txRows = await tx.execute<{
            id: string;
            kind: string;
            description: string | null;
            created_at: Date | string;
            effect: string | number;
          }>(sql`
            select t.id, t.kind, t.description, t.created_at,
                   coalesce(sum(case when e.direction = 'credit' then e.amount_minor else -e.amount_minor end)
                            filter (where a.code = 'wallet_available'), 0) as effect
              from app.ledger_transactions t
              join app.ledger_entries e on e.tenant_id = t.tenant_id and e.transaction_id = t.id
              join app.ledger_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
             where t.tenant_id = ${scope.tenantId}
             group by t.id
             order by t.created_at desc, t.id desc
             limit 50`);
          const [mandate] = await tx
            .select({
              id: paymentMandates.id,
              status: paymentMandates.status,
              maxAmountMinor: paymentMandates.maxAmountMinor,
              cardNetwork: paymentMandates.cardNetwork,
              cardLast4: paymentMandates.cardLast4,
              cardExpiryMonth: paymentMandates.cardExpiryMonth,
              cardExpiryYear: paymentMandates.cardExpiryYear,
              confirmedAt: paymentMandates.confirmedAt,
            })
            .from(paymentMandates)
            .where(
              and(
                eq(paymentMandates.tenantId, scope.tenantId),
                inArray(paymentMandates.status, ['active', 'paused', 'pending_authorization']),
              ),
            )
            .orderBy(desc(paymentMandates.createdAt))
            .limit(1);
          const [customer] = await tx
            .select({ email: billingCustomers.email, contact: billingCustomers.contact })
            .from(billingCustomers)
            .where(eq(billingCustomers.tenantId, scope.tenantId));
          const [settings] = await tx
            .select({
              enabled: autoRechargeSettings.enabled,
              mandateId: autoRechargeSettings.mandateId,
              thresholdMinor: autoRechargeSettings.thresholdMinor,
              amountMinor: autoRechargeSettings.amountMinor,
              dailyCapMinor: autoRechargeSettings.dailyCapMinor,
              monthlyCapMinor: autoRechargeSettings.monthlyCapMinor,
            })
            .from(autoRechargeSettings)
            .where(eq(autoRechargeSettings.tenantId, scope.tenantId));
          const attempts = await tx
            .select({
              id: autoRechargeAttempts.id,
              status: autoRechargeAttempts.status,
              amountMinor: autoRechargeAttempts.amountMinor,
              lastError: autoRechargeAttempts.lastError,
              createdAt: autoRechargeAttempts.createdAt,
              resolvedAt: autoRechargeAttempts.resolvedAt,
            })
            .from(autoRechargeAttempts)
            .where(eq(autoRechargeAttempts.tenantId, scope.tenantId))
            .orderBy(desc(autoRechargeAttempts.createdAt))
            .limit(10);
          return {
            payments: {
              configured: Boolean(deps.razorpay && deps.razorpayConfig),
              mode: deps.razorpayConfig?.mode ?? null,
              recurringCardsEnabled: deps.razorpayConfig?.recurringCardsEnabled ?? false,
            },
            wallet,
            topups: recentTopups,
            transactions: txRows.rows.map((r) => ({
              id: r.id,
              kind: r.kind,
              description: r.description,
              availableEffectMinor: Number(r.effect),
              createdAt: new Date(r.created_at),
            })),
            mandate: mandate ?? null,
            billingContact: customer ?? null,
            autoRecharge: settings ?? null,
            attempts,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** Creates a top-up and its Razorpay order; the browser then opens Checkout for that order. */
    async startTopup(
      ctx: TenantContext,
      input: { amountMinor: number },
      meta: RequestMeta = {},
    ): Promise<CheckoutStart & { topupId: string }> {
      assertCan(ctx, 'billing.manage');
      const { razorpay, config } = provider();
      ensureWholePaise(input.amountMinor, 'amount', TOPUP_MIN_MINOR, TOPUP_MAX_MINOR);
      const topupId = uuidv7();
      const receipt = `tu_${topupId}`;
      await db.run(ctx.scope, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`w360:topups:${ctx.tenant.id}`}, 0))`,
        );
        const recent = await tx
          .select({ id: topups.id })
          .from(topups)
          .where(
            and(
              eq(topups.tenantId, ctx.tenant.id),
              eq(topups.kind, 'manual'),
              gt(topups.createdAt, new Date(clock.now().getTime() - 3600_000)),
            ),
          );
        if (recent.length >= TOPUP_STARTS_PER_HOUR) {
          throw new AppError('rate_limited', 'Too many payment attempts. Try again in an hour.');
        }
        const walletId = await ensureWallet(tx);
        await tx.insert(topups).values({
          id: topupId,
          tenantId: ctx.tenant.id,
          walletId,
          kind: 'manual',
          amountMinor: input.amountMinor,
          receipt,
          createdByUserId: ctx.user.id,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'billing.topup_started',
            subjectType: 'topup',
            subjectId: topupId,
            metadata: { amountMinor: input.amountMinor },
          },
          meta,
        );
      });
      const order = await razorpay.createOrder({
        amount: input.amountMinor,
        currency: 'INR',
        receipt,
        paymentCapture: true,
        notes: { purpose: 'topup', topup: topupId },
      });
      if (!order.ok || order.data.amount !== input.amountMinor || order.data.currency !== 'INR') {
        // Without a recorded order id no browser can pay this top-up, so failing it is final even
        // if Razorpay did create an order we never heard about.
        await db.run(ctx.scope, (tx) =>
          tx
            .update(topups)
            .set({ status: 'failed', failureReason: 'The payment could not be started.' })
            .where(
              and(
                eq(topups.tenantId, ctx.tenant.id),
                eq(topups.id, topupId),
                eq(topups.status, 'creating'),
              ),
            ),
        );
        throw new AppError(
          'provider_unavailable',
          'We could not start the payment. Try again in a moment.',
        );
      }
      await db.run(ctx.scope, (tx) =>
        tx
          .update(topups)
          .set({ providerOrderId: order.data.id, status: 'awaiting_payment' })
          .where(
            and(
              eq(topups.tenantId, ctx.tenant.id),
              eq(topups.id, topupId),
              eq(topups.status, 'creating'),
            ),
          ),
      );
      return {
        topupId,
        keyId: config.keyId,
        orderId: order.data.id,
        amountMinor: input.amountMinor,
        currency: 'INR',
        companyName: ctx.tenant.name,
        prefill: { name: ctx.user.name, email: ctx.user.email },
      };
    },

    /**
     * Called with the Checkout handler's response. Verifies the signature against OUR order id,
     * then fetches the payment from Razorpay; only a captured payment credits the wallet. Anything
     * short of that reports `processing` and the webhook or reconciliation finishes the job.
     */
    async confirmTopupCheckout(
      ctx: TenantContext,
      input: { topupId: string; paymentId: string; signature: string },
    ): Promise<{ status: 'credited' | 'processing' | 'failed' }> {
      assertCan(ctx, 'billing.manage');
      const { razorpay, config } = provider();
      const [topup] = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ status: topups.status, orderId: topups.providerOrderId, kind: topups.kind })
            .from(topups)
            .where(and(eq(topups.tenantId, ctx.tenant.id), eq(topups.id, input.topupId))),
        { accessMode: 'read only' },
      );
      if (!topup || topup.kind !== 'manual') throw new AppError('not_found', 'Payment not found.');
      if (['paid', 'partially_refunded', 'refunded'].includes(topup.status))
        return { status: 'credited' };
      if (!topup.orderId || !/^pay_[A-Za-z0-9]{1,40}$/.test(input.paymentId)) {
        throw new AppError('validation_failed', 'The payment response is not valid.');
      }
      if (
        !verifyCheckoutSignature(topup.orderId, input.paymentId, input.signature, config.keySecret)
      ) {
        throw new AppError('validation_failed', 'The payment response could not be verified.');
      }
      const payment = await razorpay.fetchPayment(input.paymentId);
      if (!payment.ok) return { status: 'processing' };
      if (payment.data.orderId !== topup.orderId) {
        throw new AppError('validation_failed', 'The payment does not belong to this top-up.');
      }
      if (payment.data.status === 'captured') {
        await creditFromPayment(providerDeps(razorpay), ctx.scope, input.topupId, payment.data);
        return { status: 'credited' };
      }
      if (payment.data.status === 'failed') return { status: 'failed' };
      return { status: 'processing' };
    },

    /** Registers (or re-registers) the card mandate: customer, mandate row, ₹1 authorisation order. */
    async startMandateSetup(
      ctx: TenantContext,
      input: { maxAmountMinor: number; email: string; contact: string },
      meta: RequestMeta = {},
    ): Promise<CheckoutStart & { mandateId: string; customerId: string }> {
      assertCan(ctx, 'billing.manage');
      // A mandate lets HyFib debit the card later without the card holder (ADR-056).
      assertRecentSignIn(ctx, clock.now());
      const { razorpay, config } = provider();
      if (!config.recurringCardsEnabled) {
        throw new AppError(
          'unsupported',
          'Auto-recharge with a card is not available on this platform yet.',
        );
      }
      ensureWholePaise(input.maxAmountMinor, 'maxAmount', MANDATE_MIN_MINOR, MANDATE_MAX_MINOR);
      const email = input.email.trim().toLowerCase();
      const contact = input.contact.replace(/[\s-]/g, '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 64) {
        throw new AppError('validation_failed', 'Enter a valid billing email address.', {
          issues: [{ path: 'email', message: 'Invalid email' }],
        });
      }
      if (!/^\+?[0-9]{8,15}$/.test(contact)) {
        throw new AppError('validation_failed', 'Enter a valid phone number with country code.', {
          issues: [{ path: 'contact', message: 'Invalid phone number' }],
        });
      }
      const existing = await db.run(
        ctx.scope,
        async (tx) => {
          const [active] = await tx
            .select({ id: paymentMandates.id })
            .from(paymentMandates)
            .where(
              and(
                eq(paymentMandates.tenantId, ctx.tenant.id),
                inArray(paymentMandates.status, ['active', 'paused']),
              ),
            );
          const [customer] = await tx
            .select()
            .from(billingCustomers)
            .where(eq(billingCustomers.tenantId, ctx.tenant.id));
          return { active, customer };
        },
        { accessMode: 'read only' },
      );
      if (existing.active) {
        throw new AppError(
          'conflict',
          'A card is already set up. Remove it before adding another.',
        );
      }
      let customerRowId = existing.customer?.id;
      let customerId = existing.customer?.providerCustomerId;
      if (!existing.customer) {
        const created = await razorpay.createCustomer({
          name: ctx.tenant.name,
          email,
          contact,
          notes: { purpose: 'w360_billing' },
        });
        if (!created.ok || !/^cust_[A-Za-z0-9]{1,40}$/.test(created.data.id)) {
          throw new AppError(
            'provider_unavailable',
            'We could not reach the payment provider. Try again.',
          );
        }
        const rowId = uuidv7();
        // A concurrent setup may have recorded the customer first; the stored row wins.
        await db.run(ctx.scope, (tx) =>
          tx
            .insert(billingCustomers)
            .values({
              id: rowId,
              tenantId: ctx.tenant.id,
              providerCustomerId: created.data.id,
              email,
              contact,
            })
            .onConflictDoNothing(),
        );
        const [row] = await db.run(ctx.scope, (tx) =>
          tx.select().from(billingCustomers).where(eq(billingCustomers.tenantId, ctx.tenant.id)),
        );
        if (!row) throw new Error('billing customer was not recorded');
        customerRowId = row.id;
        customerId = row.providerCustomerId;
      } else if (existing.customer.email !== email || existing.customer.contact !== contact) {
        await db.run(ctx.scope, (tx) =>
          tx
            .update(billingCustomers)
            .set({ email, contact })
            .where(eq(billingCustomers.tenantId, ctx.tenant.id)),
        );
      }
      if (!customerRowId || !customerId) throw new Error('billing customer missing');
      const mandateId = uuidv7();
      const billingCustomerId = customerRowId;
      await db.run(ctx.scope, async (tx) => {
        // Auto-recharge credits this wallet, so it exists before the first charge is decided.
        await ensureWallet(tx);
        // An earlier setup that was never completed is abandoned; if its authorisation completes
        // later, the webhook deletes that token instead of activating a second card.
        await tx
          .update(paymentMandates)
          .set({ status: 'cancelled', endedAt: clock.now() })
          .where(
            and(
              eq(paymentMandates.tenantId, ctx.tenant.id),
              eq(paymentMandates.status, 'pending_authorization'),
            ),
          );
        await tx.insert(paymentMandates).values({
          id: mandateId,
          tenantId: ctx.tenant.id,
          billingCustomerId,
          maxAmountMinor: input.maxAmountMinor,
          createdByUserId: ctx.user.id,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'billing.mandate_setup_started',
            subjectType: 'payment_mandate',
            subjectId: mandateId,
            metadata: { maxAmountMinor: input.maxAmountMinor },
          },
          meta,
        );
      });
      const order = await razorpay.createOrder({
        amount: MANDATE_AUTHORIZATION_MINOR,
        currency: 'INR',
        receipt: `md_${mandateId}`,
        customerId,
        recurringToken: {
          maxAmount: input.maxAmountMinor,
          expireAt: Math.floor(clock.now().getTime() / 1000) + MANDATE_TOKEN_VALIDITY_SECONDS,
          frequency: 'as_presented',
        },
        notes: { purpose: 'mandate', mandate: mandateId },
      });
      if (!order.ok) {
        await db.run(ctx.scope, (tx) =>
          tx
            .update(paymentMandates)
            .set({ status: 'cancelled', endedAt: clock.now() })
            .where(
              and(eq(paymentMandates.tenantId, ctx.tenant.id), eq(paymentMandates.id, mandateId)),
            ),
        );
        throw new AppError(
          'provider_unavailable',
          'We could not start the card setup. Try again in a moment.',
        );
      }
      await db.run(ctx.scope, (tx) =>
        tx
          .update(paymentMandates)
          .set({ authorizationOrderId: order.data.id })
          .where(
            and(eq(paymentMandates.tenantId, ctx.tenant.id), eq(paymentMandates.id, mandateId)),
          ),
      );
      return {
        mandateId,
        customerId,
        keyId: config.keyId,
        orderId: order.data.id,
        amountMinor: MANDATE_AUTHORIZATION_MINOR,
        currency: 'INR',
        companyName: ctx.tenant.name,
        prefill: { name: ctx.user.name, email, contact },
      };
    },

    async confirmMandateCheckout(
      ctx: TenantContext,
      input: { mandateId: string; paymentId: string; signature: string },
    ): Promise<{ status: MandateStatus }> {
      assertCan(ctx, 'billing.manage');
      const { razorpay, config } = provider();
      const [mandate] = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              status: paymentMandates.status,
              orderId: paymentMandates.authorizationOrderId,
            })
            .from(paymentMandates)
            .where(
              and(
                eq(paymentMandates.tenantId, ctx.tenant.id),
                eq(paymentMandates.id, input.mandateId),
              ),
            ),
        { accessMode: 'read only' },
      );
      if (!mandate) throw new AppError('not_found', 'Card setup not found.');
      if (mandate.status !== 'pending_authorization') return { status: mandate.status };
      if (!mandate.orderId || !/^pay_[A-Za-z0-9]{1,40}$/.test(input.paymentId)) {
        throw new AppError('validation_failed', 'The card setup response is not valid.');
      }
      if (
        !verifyCheckoutSignature(
          mandate.orderId,
          input.paymentId,
          input.signature,
          config.keySecret,
        )
      ) {
        throw new AppError('validation_failed', 'The card setup response could not be verified.');
      }
      const payment = await razorpay.fetchPayment(input.paymentId);
      if (!payment.ok) return { status: 'pending_authorization' };
      if (payment.data.orderId !== mandate.orderId) {
        throw new AppError('validation_failed', 'The payment does not belong to this card setup.');
      }
      try {
        await applyMandateAuthorization(
          providerDeps(razorpay),
          ctx.scope,
          input.mandateId,
          payment.data,
        );
      } catch (error) {
        // The mandate state is already stored; a transient failure while refunding the ₹1
        // authorisation is retried by the webhook job with the same idempotency key.
        if (!(error instanceof TransientProviderError)) throw error;
      }
      const [after] = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ status: paymentMandates.status })
            .from(paymentMandates)
            .where(
              and(
                eq(paymentMandates.tenantId, ctx.tenant.id),
                eq(paymentMandates.id, input.mandateId),
              ),
            ),
        { accessMode: 'read only' },
      );
      if (after?.status === 'active') {
        await db.run(ctx.scope, (tx) =>
          recordAudit(tx, ctx, {
            action: 'billing.mandate_confirmed',
            subjectType: 'payment_mandate',
            subjectId: input.mandateId,
          }),
        );
      }
      return { status: after?.status ?? 'pending_authorization' };
    },

    /**
     * Removes the card mandate: deletes the token at Razorpay (how a merchant cancels a card
     * mandate, R-037), then turns auto-recharge off and stops attempts that have not requested a
     * debit yet. A debit already requested from the bank may still complete and is credited.
     */
    async cancelMandate(ctx: TenantContext, input: { mandateId: string }, meta: RequestMeta = {}) {
      assertCan(ctx, 'billing.manage');
      const { razorpay } = provider();
      const [row] = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              status: paymentMandates.status,
              tokenId: paymentMandates.providerTokenId,
              customerId: billingCustomers.providerCustomerId,
            })
            .from(paymentMandates)
            .innerJoin(
              billingCustomers,
              and(
                eq(billingCustomers.tenantId, paymentMandates.tenantId),
                eq(billingCustomers.id, paymentMandates.billingCustomerId),
              ),
            )
            .where(
              and(
                eq(paymentMandates.tenantId, ctx.tenant.id),
                eq(paymentMandates.id, input.mandateId),
              ),
            ),
        { accessMode: 'read only' },
      );
      if (!row) throw new AppError('not_found', 'Card not found.');
      if (!['active', 'paused', 'pending_authorization'].includes(row.status)) return;
      if (row.tokenId) {
        const deleted = await razorpay.deleteToken(row.customerId, row.tokenId);
        // A permanent refusal means the token no longer exists at Razorpay.
        if (!deleted.ok && deleted.kind !== 'permanent') {
          throw new AppError(
            'provider_unavailable',
            'We could not remove the card right now. Try again.',
          );
        }
      }
      const now = clock.now();
      await db.run(ctx.scope, async (tx) => {
        await tx
          .update(paymentMandates)
          .set({ status: 'cancelled', endedAt: now })
          .where(
            and(
              eq(paymentMandates.tenantId, ctx.tenant.id),
              eq(paymentMandates.id, input.mandateId),
            ),
          );
        await tx
          .update(autoRechargeSettings)
          .set({ enabled: false, updatedByUserId: ctx.user.id })
          .where(
            and(
              eq(autoRechargeSettings.tenantId, ctx.tenant.id),
              eq(autoRechargeSettings.mandateId, input.mandateId),
            ),
          );
        await cancelPendingAutoRecharge(tx, ctx.scope, 'The card was removed.', now);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'billing.mandate_cancelled',
            subjectType: 'payment_mandate',
            subjectId: input.mandateId,
          },
          meta,
        );
      });
    },

    async updateAutoRecharge(
      ctx: TenantContext,
      input: {
        enabled: boolean;
        thresholdMinor: number;
        amountMinor: number;
        dailyCapMinor: number;
        monthlyCapMinor: number;
      },
      meta: RequestMeta = {},
    ): Promise<{ enabled: boolean }> {
      assertCan(ctx, 'billing.manage');
      // Turning automatic charges off never needs a fresh sign-in; anything else can charge the card.
      if (input.enabled) assertRecentSignIn(ctx, clock.now());
      ensureWholePaise(input.thresholdMinor, 'threshold', 0, AUTO_RECHARGE_THRESHOLD_MAX_MINOR);
      ensureWholePaise(input.amountMinor, 'amount', MANDATE_MIN_MINOR, MANDATE_MAX_MINOR);
      ensureWholePaise(
        input.dailyCapMinor,
        'dailyCap',
        input.amountMinor,
        AUTO_RECHARGE_DAILY_CAP_MAX_MINOR,
      );
      ensureWholePaise(
        input.monthlyCapMinor,
        'monthlyCap',
        input.dailyCapMinor,
        AUTO_RECHARGE_MONTHLY_CAP_MAX_MINOR,
      );
      const now = clock.now();
      return db.run(ctx.scope, async (tx) => {
        let mandateId: string | null = null;
        if (input.enabled) {
          await ensureWallet(tx);
          if (!deps.razorpayConfig?.recurringCardsEnabled) {
            throw new AppError(
              'unsupported',
              'Auto-recharge with a card is not available on this platform yet.',
            );
          }
          const [mandate] = await tx
            .select({ id: paymentMandates.id, maxAmountMinor: paymentMandates.maxAmountMinor })
            .from(paymentMandates)
            .where(
              and(
                eq(paymentMandates.tenantId, ctx.tenant.id),
                eq(paymentMandates.status, 'active'),
              ),
            )
            .orderBy(desc(paymentMandates.confirmedAt))
            .limit(1);
          if (!mandate) {
            throw new AppError('precondition_failed', 'Set up a card for auto-recharge first.');
          }
          if (input.amountMinor > mandate.maxAmountMinor) {
            throw new AppError(
              'validation_failed',
              'The recharge amount is above your card mandate limit.',
              {
                issues: [{ path: 'amount', message: 'Above the card mandate limit' }],
              },
            );
          }
          mandateId = mandate.id;
        }
        const values = {
          enabled: input.enabled,
          thresholdMinor: input.thresholdMinor,
          amountMinor: input.amountMinor,
          dailyCapMinor: input.dailyCapMinor,
          monthlyCapMinor: input.monthlyCapMinor,
          updatedByUserId: ctx.user.id,
        };
        const [current] = await tx
          .select({ mandateId: autoRechargeSettings.mandateId })
          .from(autoRechargeSettings)
          .where(eq(autoRechargeSettings.tenantId, ctx.tenant.id))
          .for('update');
        if (current) {
          await tx
            .update(autoRechargeSettings)
            .set({ ...values, ...(mandateId ? { mandateId } : {}) })
            .where(eq(autoRechargeSettings.tenantId, ctx.tenant.id));
        } else {
          await tx
            .insert(autoRechargeSettings)
            .values({ tenantId: ctx.tenant.id, mandateId, ...values });
        }
        // Attempts that have not asked the bank for money follow the new settings: they are
        // stopped when auto-recharge is turned off or its amount changes.
        await cancelPendingAutoRecharge(
          tx,
          ctx.scope,
          input.enabled ? 'Auto-recharge settings changed.' : 'Auto-recharge was turned off.',
          now,
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'billing.auto_recharge_updated',
            subjectType: 'auto_recharge_settings',
            subjectId: ctx.tenant.id,
            metadata: {
              enabled: input.enabled,
              thresholdMinor: input.thresholdMinor,
              amountMinor: input.amountMinor,
              dailyCapMinor: input.dailyCapMinor,
              monthlyCapMinor: input.monthlyCapMinor,
            },
          },
          meta,
        );
        if (input.enabled) {
          await deps.notices.outbox.jobs.enqueue(
            tx,
            QUEUES.autoRecharge.name,
            deps.notices.outbox.signer.sign({
              kind: 'billing.auto-recharge',
              tenantId: ctx.tenant.id,
              actorUserId: null,
              ref: 'check',
            }),
            { singletonKey: `check:${ctx.tenant.id}` },
          );
        }
        return { enabled: input.enabled };
      });
    },
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
