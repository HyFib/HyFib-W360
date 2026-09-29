import { isAppError } from '@w360/core';
import {
  sql,
  systemScope,
  type Database,
  type SettlementReconItemStatus,
  type SettlementReconItemType,
  type SettlementReconReason,
} from '@w360/db';
import {
  TransientProviderError,
  applyPaymentById,
  applyRefundById,
  type BillingProviderDeps,
} from './payments';
import { findPlanPayment } from './plan-subscriptions';
import type { RazorpayReconItem, RazorpayResult } from './razorpay';

/**
 * Daily reconciliation of Razorpay settlements with HyFib's billing records (ADR-059). The worker
 * reads a day's settlement report page by page, matches every transaction against HyFib's own
 * records (looked up by provider id, never trusting the report for a company), records what HyFib
 * had missed through the usual paths (a captured payment credited, a processed refund recorded,
 * both fetched from Razorpay first) and keeps everything else for platform owners to look at. It
 * never changes anything else: corrections go through the normal paths or the Razorpay Dashboard.
 */

/** Razorpay's documented maximum page size (R-110). */
export const RECON_PAGE_SIZE = 1000;
/** At most this many pages a day (50,000 transactions); a larger day fails and says so. */
export const RECON_MAX_PAGES = 50;
export const RECON_LEASE_SECONDS = 15 * 60;
/** The previous day's report is read from this hour in India (ADR-059). */
export const RECON_START_HOUR_INDIA = 6;
/** Paid top-ups not seen in a settlement this many days after the payment are listed (ADR-059). */
export const UNSETTLED_AFTER_DAYS = 7;

const INDIA_TIME_ZONE = 'Asia/Kolkata';

/** India's calendar day of an instant, as YYYY-MM-DD. */
export function indiaDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: INDIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** A YYYY-MM-DD day moved by whole days. */
export function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/**
 * The latest day the daily schedule reconciles at `now`: the previous day in India from 06:00 India
 * time, and the day before that until then.
 */
export function reconcileThrough(now: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: INDIA_TIME_ZONE,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  );
  return addDays(indiaDate(now), hour >= RECON_START_HOUR_INDIA ? -1 : -2);
}

// Matching --------------------------------------------------------------------------------------------

/** One of HyFib's records for a provider id (ops.settlement_recon_facts). */
export interface ReconFact {
  kind:
    | 'topup_payment'
    | 'topup_order'
    | 'mandate_payment'
    | 'mandate_order'
    | 'mandate_refund'
    | 'refund'
    | 'plan_payment';
  providerId: string;
  tenantId: string;
  /** The top-up, card mandate or plan subscription. */
  subjectId: string;
  amountMinor: number | null;
  currency: string | null;
  status: string | null;
  paymentId: string | null;
}

export interface ReconFacts {
  topupByPayment: Map<string, ReconFact>;
  topupByOrder: Map<string, ReconFact>;
  mandateByPayment: Map<string, ReconFact>;
  mandateByOrder: Map<string, ReconFact>;
  mandateByRefund: Map<string, ReconFact>;
  refundById: Map<string, ReconFact>;
  planByPayment: Map<string, ReconFact>;
}

export function indexReconFacts(facts: readonly ReconFact[]): ReconFacts {
  const index: ReconFacts = {
    topupByPayment: new Map(),
    topupByOrder: new Map(),
    mandateByPayment: new Map(),
    mandateByOrder: new Map(),
    mandateByRefund: new Map(),
    refundById: new Map(),
    planByPayment: new Map(),
  };
  const maps: Record<ReconFact['kind'], Map<string, ReconFact>> = {
    topup_payment: index.topupByPayment,
    topup_order: index.topupByOrder,
    mandate_payment: index.mandateByPayment,
    mandate_order: index.mandateByOrder,
    mandate_refund: index.mandateByRefund,
    refund: index.refundById,
    plan_payment: index.planByPayment,
  };
  for (const fact of facts) maps[fact.kind].set(fact.providerId, fact);
  return index;
}

export interface ReconClassification {
  status: SettlementReconItemStatus;
  reason: SettlementReconReason | null;
  tenantId: string | null;
  topupId: string | null;
  /** HyFib's amount for the transaction, when HyFib has one. */
  hyfibAmountMinor: number | null;
  /**
   * HyFib missed this transaction: fetch it from Razorpay and record it through the usual path
   * (`plan_payment`: a payment on no order of HyFib's, which may be a plan subscription's charge).
   */
  apply: 'payment' | 'refund' | 'plan_payment' | null;
}

const DOCUMENTED_TYPES: readonly string[] = ['payment', 'refund', 'transfer', 'adjustment'];

export function reconItemType(type: string): SettlementReconItemType {
  return DOCUMENTED_TYPES.includes(type) ? (type as SettlementReconItemType) : 'other';
}

const NO_MATCH = { tenantId: null, topupId: null, hyfibAmountMinor: null, apply: null } as const;

function matchReconItem(item: RazorpayReconItem, facts: ReconFacts): ReconClassification {
  switch (item.type) {
    case 'payment': {
      const credited = facts.topupByPayment.get(item.entityId);
      if (credited) {
        const match = {
          tenantId: credited.tenantId,
          topupId: credited.subjectId,
          hyfibAmountMinor: credited.amountMinor,
          apply: null,
        };
        return credited.amountMinor === item.amount
          ? { ...match, status: 'matched', reason: null }
          : { ...match, status: 'mismatch', reason: 'amount_differs' };
      }
      const authorization = facts.mandateByPayment.get(item.entityId);
      if (authorization) {
        return {
          ...NO_MATCH,
          tenantId: authorization.tenantId,
          status: 'matched',
          reason: 'mandate_authorization',
        };
      }
      const plan = facts.planByPayment.get(item.entityId);
      if (plan) {
        const match = { ...NO_MATCH, tenantId: plan.tenantId, hyfibAmountMinor: plan.amountMinor };
        return plan.amountMinor === item.amount
          ? { ...match, status: 'matched', reason: 'plan_payment' }
          : { ...match, status: 'mismatch', reason: 'amount_differs' };
      }
      const order = item.orderId ? facts.topupByOrder.get(item.orderId) : undefined;
      if (order) {
        // A payment on a top-up's order that did not credit it: applied as a webhook would be.
        return {
          tenantId: order.tenantId,
          topupId: order.subjectId,
          hyfibAmountMinor: order.amountMinor,
          status: 'mismatch',
          reason: 'payment_unavailable',
          apply: 'payment',
        };
      }
      const mandateOrder = item.orderId ? facts.mandateByOrder.get(item.orderId) : undefined;
      if (mandateOrder) {
        return {
          ...NO_MATCH,
          tenantId: mandateOrder.tenantId,
          status: 'mismatch',
          reason: 'mandate_payment',
        };
      }
      // Possibly a plan subscription's charge HyFib has not recorded: synced when it is.
      return { ...NO_MATCH, status: 'not_hyfib', reason: 'unknown_payment', apply: 'plan_payment' };
    }
    case 'refund': {
      const recorded = facts.refundById.get(item.entityId);
      if (recorded) {
        const match = {
          tenantId: recorded.tenantId,
          topupId: recorded.subjectId,
          hyfibAmountMinor: recorded.amountMinor,
          apply: null,
        };
        return recorded.amountMinor === item.amount
          ? { ...match, status: 'matched', reason: null }
          : { ...match, status: 'mismatch', reason: 'amount_differs' };
      }
      const authorization =
        facts.mandateByRefund.get(item.entityId) ??
        (item.paymentId ? facts.mandateByPayment.get(item.paymentId) : undefined);
      if (authorization) {
        return {
          ...NO_MATCH,
          tenantId: authorization.tenantId,
          status: 'matched',
          reason: 'mandate_authorization',
        };
      }
      const credited = item.paymentId ? facts.topupByPayment.get(item.paymentId) : undefined;
      if (credited) {
        // A refund of a payment that credited a top-up, not recorded: applied as refund.processed.
        return {
          tenantId: credited.tenantId,
          topupId: credited.subjectId,
          hyfibAmountMinor: null,
          status: 'mismatch',
          reason: 'refund_unavailable',
          apply: 'refund',
        };
      }
      const order = item.orderId ? facts.topupByOrder.get(item.orderId) : undefined;
      if (order) {
        return {
          tenantId: order.tenantId,
          topupId: order.subjectId,
          hyfibAmountMinor: null,
          status: 'matched',
          reason: 'uncredited_payment_refund',
          apply: null,
        };
      }
      const planPayment = item.paymentId ? facts.planByPayment.get(item.paymentId) : undefined;
      if (planPayment) {
        return {
          ...NO_MATCH,
          tenantId: planPayment.tenantId,
          status: 'review',
          reason: 'plan_payment_refund',
        };
      }
      return { ...NO_MATCH, status: 'not_hyfib', reason: 'unknown_refund' };
    }
    case 'transfer':
      return { ...NO_MATCH, status: 'not_hyfib', reason: 'transfer' };
    case 'adjustment':
      return { ...NO_MATCH, status: 'review', reason: 'adjustment' };
    default:
      return { ...NO_MATCH, status: 'review', reason: 'unknown_type' };
  }
}

/**
 * How one settled transaction matches HyFib's records. A transaction in another currency is for a
 * person and is never applied; a dispute is handled by withDispute.
 */
export function classifyReconItem(item: RazorpayReconItem, facts: ReconFacts): ReconClassification {
  const match = matchReconItem(item, facts);
  if (item.currency !== 'INR')
    return { ...match, status: 'review', reason: 'currency', apply: null };
  return withDispute(item, match);
}

/**
 * A transaction HyFib matched or recorded is for a person when it has a dispute: the report
 * documents only the dispute's id, not which transaction carries a chargeback's deduction (R-111).
 * It is decided after a missed payment or refund was applied (which happens as its webhook would
 * have), so the same transaction reads the same on every run. A transaction already waiting for a
 * person keeps its own reason; lost chargebacks are recorded from their own webhook.
 */
export function withDispute(
  item: RazorpayReconItem,
  found: ReconClassification,
): ReconClassification {
  return item.disputeId && (found.status === 'matched' || found.status === 'recorded')
    ? { ...found, status: 'review', reason: 'dispute' }
    : found;
}

// The run ---------------------------------------------------------------------------------------------

export type SettlementReconOutcome =
  'completed' | 'deferred' | 'failed' | 'not_claimable' | 'superseded';

export interface SettlementReconResult {
  outcome: SettlementReconOutcome;
  date?: string;
  items?: number;
  recorded?: number;
}

/** A transaction of the report, or a place where Razorpay returned one HyFib cannot read. */
interface ReportRow {
  position: number;
  item: RazorpayReconItem | null;
}

const UNREADABLE: ReconClassification = { ...NO_MATCH, status: 'review', reason: 'unreadable' };

/**
 * Runs the daily schedule: creates the runs it owes up to the latest day it may reconcile now, and
 * returns the runs due (the minute billing sweep queues one signed job each).
 */
export async function findDueSettlementRecons(
  db: Database,
  now: Date,
  limit = 10,
): Promise<{ runId: string; date: string }[]> {
  const through = reconcileThrough(now);
  return db.run(systemScope, async (tx) => {
    const res = await tx.execute<{ run_id: string; settlement_date: string }>(
      sql`select run_id, settlement_date::text as settlement_date
            from ops.settlement_recon_due(${through}::date, ${limit}::int)`,
    );
    return res.rows.map((r) => ({ runId: r.run_id, date: r.settlement_date }));
  });
}

async function claimRun(
  db: Database,
  runId: string,
): Promise<{ attempt: number; date: string } | null> {
  return db.run(systemScope, async (tx) => {
    const res = await tx.execute<{ attempt: number; settlement_date: string }>(
      sql`select attempt, settlement_date::text as settlement_date
            from ops.settlement_recon_claim(${runId}::uuid, ${RECON_LEASE_SECONDS}::int)`,
    );
    const row = res.rows[0];
    return row ? { attempt: Number(row.attempt), date: row.settlement_date } : null;
  });
}

type Failure = Extract<RazorpayResult<never>, { ok: false }>;

function describeFailure(failure: Failure): string {
  const status = failure.httpStatus ? `HTTP ${failure.httpStatus}` : 'no HTTP status';
  const code = failure.code ? `, ${failure.code}` : '';
  switch (failure.kind) {
    case 'auth':
      return `Razorpay refused HyFib's API keys (${status}): ${failure.description}`;
    case 'permanent':
      return `Razorpay refused the request (${status}${code}): ${failure.description}`;
    case 'retryable':
      return `Razorpay could not answer (${status}${code}): ${failure.description}`;
    default:
      return `No usable answer from Razorpay: ${failure.description}`;
  }
}

async function deferRun(db: Database, runId: string, attempt: number, error: string) {
  return db.run(systemScope, async (tx) => {
    const res = await tx.execute<{ status: string | null }>(
      sql`select ops.settlement_recon_defer(${runId}::uuid, ${attempt}::int, ${error}) as status`,
    );
    return res.rows[0]?.status ?? null;
  });
}

async function failRun(db: Database, runId: string, attempt: number, error: string) {
  await db.run(systemScope, (tx) =>
    tx.execute(sql`select ops.settlement_recon_fail(${runId}::uuid, ${attempt}::int, ${error})`),
  );
}

async function loadFacts(db: Database, items: readonly RazorpayReconItem[]): Promise<ReconFacts> {
  const unique = (values: (string | null)[]) => [
    ...new Set(values.filter((v): v is string => v !== null)),
  ];
  const payments = unique(items.filter((i) => i.type === 'payment').map((i) => i.entityId));
  const orders = unique(items.map((i) => i.orderId));
  const refunds = items.filter((i) => i.type === 'refund');
  const refundIds = unique(refunds.map((i) => i.entityId));
  const refundPayments = unique(refunds.map((i) => i.paymentId));
  const rows = await db.run(
    systemScope,
    async (tx) =>
      (
        await tx.execute<{
          kind: ReconFact['kind'];
          provider_id: string;
          tenant_id: string;
          subject_id: string;
          amount_minor: string | number | null;
          currency: string | null;
          status: string | null;
          payment_id: string | null;
        }>(
          sql`select * from ops.settlement_recon_facts(${sql.param(payments)}::text[],
                ${sql.param(orders)}::text[], ${sql.param(refundIds)}::text[],
                ${sql.param(refundPayments)}::text[])`,
        )
      ).rows,
    { accessMode: 'read only' },
  );
  return indexReconFacts(
    rows.map((r) => ({
      kind: r.kind,
      providerId: r.provider_id,
      tenantId: r.tenant_id,
      subjectId: r.subject_id,
      amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
      currency: r.currency,
      status: r.status,
      paymentId: r.payment_id,
    })),
  );
}

/**
 * Records a transaction HyFib missed through the path its webhook would have taken, with the state
 * fetched from Razorpay, and says how it ended. Only a provider failure that may pass is thrown
 * (TransientProviderError): the run is then tried again later.
 */
async function applyMissed(
  deps: BillingProviderDeps,
  item: RazorpayReconItem,
  found: ReconClassification,
): Promise<ReconClassification> {
  const as = (
    status: SettlementReconItemStatus,
    reason: SettlementReconReason | null,
  ): ReconClassification => ({ ...found, status, reason, apply: null });
  if (found.apply === 'payment') {
    try {
      const applied = await applyPaymentById(deps, item.entityId);
      switch (applied.outcome) {
        case 'credited':
          return as('recorded', 'credited');
        case 'already_credited':
          return as('matched', null);
        case 'unknown_order':
          return as('mismatch', 'payment_unavailable');
        case 'mandate_updated':
          return as('mismatch', 'mandate_payment');
        default:
          return as('mismatch', 'not_captured');
      }
    } catch (error) {
      // app.billing_credit_topup: another payment already paid the top-up (W3409), or the captured
      // amount is not the top-up's (W3412).
      if (isAppError(error) && error.code === 'conflict') return as('mismatch', 'second_payment');
      if (isAppError(error) && error.code === 'precondition_failed') {
        return as('mismatch', 'amount_differs');
      }
      throw error;
    }
  }
  if (found.apply === 'plan_payment') {
    const applied = await applyPaymentById(deps, item.entityId);
    if (applied.outcome !== 'subscription_synced') return as('not_hyfib', 'unknown_payment');
    const recorded = await findPlanPayment(deps.db, item.entityId);
    if (!recorded) {
      return { ...as('mismatch', 'plan_payment_unrecorded'), tenantId: applied.tenantId };
    }
    const match = { tenantId: recorded.tenantId, hyfibAmountMinor: recorded.amountMinor };
    return recorded.amountMinor === item.amount
      ? { ...as('recorded', 'plan_payment_recorded'), ...match }
      : { ...as('mismatch', 'amount_differs'), ...match };
  }
  if (found.apply === 'refund' && item.paymentId) {
    try {
      const applied = await applyRefundById(deps, item.paymentId, item.entityId);
      switch (applied) {
        case 'recorded':
          return as('recorded', 'refund_recorded');
        case 'already_recorded':
          return as('matched', null);
        case 'refund_pending':
          return as('mismatch', 'refund_not_processed');
        case 'mandate_authorization_refund':
          return as('matched', 'mandate_authorization');
        default:
          return as('mismatch', 'refund_unavailable');
      }
    } catch (error) {
      // app.billing_record_refund: the top-up's refunds would exceed its payment (W3412).
      if (isAppError(error) && error.code === 'precondition_failed') {
        return as('mismatch', 'refund_exceeds_payment');
      }
      throw error;
    }
  }
  return found;
}

const epochToIso = (seconds: number | null) =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();

function itemRecord(row: ReportRow, found: ReconClassification) {
  const item = row.item;
  return {
    item_type: item ? reconItemType(item.type) : 'other',
    entity_id: item ? item.entityId : `unreadable:${row.position}`,
    provider_type: item && reconItemType(item.type) === 'other' ? item.type : null,
    amount_minor: item?.amount ?? 0,
    debit_minor: item?.debit ?? 0,
    credit_minor: item?.credit ?? 0,
    fee_minor: item?.fee ?? 0,
    tax_minor: item?.tax ?? 0,
    currency: item?.currency ?? null,
    on_hold: item?.onHold ?? null,
    settled: item?.settled ?? null,
    settlement_id: item?.settlementId ?? null,
    settlement_utr: item?.settlementUtr ?? null,
    provider_created_at: epochToIso(item?.createdAt ?? null),
    settled_at: epochToIso(item?.settledAt ?? null),
    payment_id: item?.paymentId ?? null,
    order_id: item?.orderId ?? null,
    dispute_id: item?.disputeId ?? null,
    method: item?.method ?? null,
    status: found.status,
    reason: found.reason,
    tenant_id: found.tenantId,
    topup_id: found.topupId,
    hyfib_amount_minor: found.hyfibAmountMinor,
  };
}

/** Another attempt holds the run (its lease expired meanwhile): this attempt stops writing. */
class AttemptSupersededError extends Error {
  override name = 'AttemptSupersededError';
}

/** Runs one of the attempt's writes; the functions refuse (W3409) once the attempt is not current. */
async function attemptWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isAppError(error) && error.code === 'conflict') throw new AttemptSupersededError();
    throw error;
  }
}

async function recordItems(
  db: Database,
  runId: string,
  attempt: number,
  records: ReturnType<typeof itemRecord>[],
): Promise<void> {
  if (records.length === 0) return;
  await attemptWrite(() =>
    db.run(systemScope, (tx) =>
      tx.execute(
        sql`select ops.settlement_recon_record_items(${runId}::uuid, ${attempt}::int,
              ${JSON.stringify(records)}::jsonb)`,
      ),
    ),
  );
}

/**
 * One attempt at a run: claims it, reads the day's report from Razorpay, matches and records every
 * transaction and completes the run. A Razorpay failure that may pass leaves the run due again
 * (5, 15, 60, 180, 360 minutes); a refusal fails it until a platform owner runs the day again. An
 * attempt that lost its claim (the lease expired and another attempt started) stops writing.
 */
export async function runSettlementRecon(
  deps: BillingProviderDeps,
  runId: string,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<SettlementReconResult> {
  const claim = await claimRun(deps.db, runId);
  if (!claim) return { outcome: 'not_claimable' };
  const { attempt, date } = claim;
  const pageSize = options.pageSize ?? RECON_PAGE_SIZE;
  const maxPages = options.maxPages ?? RECON_MAX_PAGES;
  try {
    const rows: ReportRow[] = [];
    let complete = false;
    for (let page = 0; page < maxPages && !complete; page += 1) {
      const skip = page * pageSize;
      const res = await deps.razorpay.fetchSettlementRecon({ date, count: pageSize, skip });
      if (!res.ok) {
        const message = describeFailure(res);
        if (res.kind === 'auth' || res.kind === 'permanent') {
          await failRun(deps.db, runId, attempt, message);
          return { outcome: 'failed', date };
        }
        const status = await deferRun(deps.db, runId, attempt, message);
        return { outcome: status === 'failed' ? 'failed' : 'deferred', date };
      }
      res.data.items.forEach((item, index) => rows.push({ position: skip + index, item }));
      complete = res.data.items.length < pageSize;
    }
    if (!complete) {
      await failRun(
        deps.db,
        runId,
        attempt,
        `The day has more than ${maxPages * pageSize} transactions, more than HyFib reads in one run.`,
      );
      return { outcome: 'failed', date };
    }
    let recorded = 0;
    for (let start = 0; start < rows.length; start += 1000) {
      const chunk = rows.slice(start, start + 1000);
      const facts = await loadFacts(
        deps.db,
        chunk.flatMap((row) => (row.item ? [row.item] : [])),
      );
      const records: ReturnType<typeof itemRecord>[] = [];
      for (const row of chunk) {
        let found = row.item ? classifyReconItem(row.item, facts) : UNREADABLE;
        if (row.item && found.apply) {
          try {
            found = withDispute(row.item, await applyMissed(deps, row.item, found));
          } catch (error) {
            if (!(error instanceof TransientProviderError)) throw error;
            const status = await deferRun(
              deps.db,
              runId,
              attempt,
              `Razorpay could not answer while recording ${row.item.entityId}: ${error.message}`,
            );
            return { outcome: status === 'failed' ? 'failed' : 'deferred', date };
          }
          if (found.status === 'recorded') {
            // Written at once, so a later attempt still shows that this run recorded it.
            await recordItems(deps.db, runId, attempt, [itemRecord(row, found)]);
            recorded += 1;
          }
        }
        records.push(itemRecord(row, found));
      }
      await recordItems(deps.db, runId, attempt, records);
    }
    const items = await attemptWrite(() =>
      deps.db.run(systemScope, async (tx) => {
        const res = await tx.execute<{ items: number }>(
          sql`select ops.settlement_recon_complete(${runId}::uuid, ${attempt}::int) as items`,
        );
        return Number(res.rows[0]?.items ?? 0);
      }),
    );
    return { outcome: 'completed', date, items, recorded };
  } catch (error) {
    if (error instanceof AttemptSupersededError) return { outcome: 'superseded', date };
    throw error;
  }
}
