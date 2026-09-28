import { AppError, formatMinorUnits, type Clock } from '@w360/core';
import {
  and,
  autoRechargeAttempts,
  billingCustomers,
  creditRefunds,
  eq,
  inArray,
  paymentMandates,
  sql,
  topups,
  wallets,
  type CreditRefundStatus,
  type Database,
  type LedgerKind,
  type TopupStatus,
  type Tx,
} from '@w360/db';
import { z } from 'zod';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import { resolveLocalTime, zonedParts } from '../campaigns/schedule';
import { CSV_BOM, csvLine } from '../contacts/csv';
import { parseInput } from '../validation';

/**
 * Billing history (ADR-057): monthly statements and payment receipts, computed on request from the
 * append-only ledger (0004_billing). A statement covers one calendar month in the company's time
 * zone; its opening balances are the sums of the wallet's available and reserved accounts before
 * the month, its lines are the month's ledger transactions in time order, and its closing balances
 * are the opening balances plus the lines. Everything on one statement comes from one
 * repeatable-read snapshot. A receipt confirms a payment for prepaid service credit; it is not a
 * tax invoice.
 */

export type { LedgerKind };

export const LEDGER_KIND_LABELS: Record<LedgerKind, string> = {
  topup_credit: 'Credit added',
  hold: 'Reserved for a service',
  hold_release: 'Reservation released',
  hold_settle: 'Service charge',
  refund: 'Refund to card',
  dispute_loss: 'Chargeback',
};

/** A ledger line's label; the hold of a staff refund (ADR-058) says what it is for. */
export function ledgerLineLabel(kind: LedgerKind, referenceType: string | null): string {
  if (referenceType === 'credit_refund') {
    if (kind === 'hold') return 'Reserved for a refund';
    if (kind === 'hold_release') return 'Refund reservation released';
  }
  return LEDGER_KIND_LABELS[kind] ?? kind;
}

/** Razorpay's documented payment methods; anything else is shown as Razorpay reported it. */
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  card: 'Card',
  upi: 'UPI',
  netbanking: 'Net banking',
  wallet: 'Wallet',
  emi: 'EMI',
};

export function paymentMethodLabel(method: string | null): string | null {
  if (!method) return null;
  return PAYMENT_METHOD_LABELS[method] ?? method;
}

/** Lines per statement page on the web. */
export const STATEMENT_PAGE_SIZE = 100;
/** The most lines one CSV statement holds. */
export const STATEMENT_CSV_MAX_LINES = 100_000;

// Months -----------------------------------------------------------------------------------------

export interface Month {
  year: number;
  /** 1–12. */
  month: number;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseMonth(value: string): Month | null {
  const match = MONTH_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 2000 || year > 9998) return null;
  return { year, month: Number(match[2]) };
}

export function formatMonth(m: Month): string {
  return `${String(m.year).padStart(4, '0')}-${String(m.month).padStart(2, '0')}`;
}

export function monthLabel(m: Month): string {
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(m.year, m.month - 1, 1)));
}

export function addMonths(m: Month, count: number): Month {
  const index = m.year * 12 + (m.month - 1) + count;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function compareMonths(a: Month, b: Month): number {
  return a.year * 12 + a.month - (b.year * 12 + b.month);
}

/** The calendar month of `instant` in `timeZone`. */
export function monthOf(instant: Date, timeZone: string): Month {
  const parts = zonedParts(instant.getTime(), timeZone);
  return { year: parts.year, month: parts.month };
}

/**
 * The month's first instant in `timeZone`: local midnight on the 1st, or the first real instant of
 * that day when a daylight-saving change removes or doubles midnight (campaigns/schedule).
 */
export function monthStart(m: Month, timeZone: string): Date {
  return resolveLocalTime({ year: m.year, month: m.month, day: 1, hour: 0, minute: 0 }, timeZone)
    .instant;
}

export function monthBounds(m: Month, timeZone: string): { start: Date; end: Date } {
  return { start: monthStart(m, timeZone), end: monthStart(addMonths(m, 1), timeZone) };
}

// Statements -------------------------------------------------------------------------------------

export interface Balances {
  availableMinor: number;
  reservedMinor: number;
}

export interface StatementTotals {
  creditAddedMinor: number;
  /** Settled service charges (a positive number is money used). */
  serviceChargesMinor: number;
  refundsMinor: number;
  chargebacksMinor: number;
}

export interface StatementMonthSummary extends StatementTotals {
  month: string;
  label: string;
  inProgress: boolean;
  lineCount: number;
  closing: Balances;
}

export interface StatementLine {
  id: string;
  at: Date;
  kind: LedgerKind;
  label: string;
  /** The provider or service reference of the posting (payment, refund or dispute id). */
  reference: string | null;
  /** The top-up the line belongs to (credits, refunds, chargebacks): its receipt. */
  topupId: string | null;
  receiptNumber: string | null;
  availableChangeMinor: number;
  reservedChangeMinor: number;
  availableAfterMinor: number;
  reservedAfterMinor: number;
}

export interface Statement {
  month: string;
  label: string;
  timezone: string;
  start: Date;
  /** Exclusive end: the next month's first instant. */
  end: Date;
  inProgress: boolean;
  generatedAt: Date;
  opening: Balances;
  closing: Balances;
  totals: StatementTotals;
  lineCount: number;
  page: number;
  pageCount: number;
  lines: StatementLine[];
}

export interface ReceiptAdjustment {
  id: string;
  kind: 'refund' | 'dispute_loss';
  label: string;
  amountMinor: number;
  at: Date;
  reference: string | null;
}

export interface PaymentReceipt {
  topupId: string;
  receiptNumber: string;
  kind: 'manual' | 'auto_recharge';
  status: TopupStatus;
  amountMinor: number;
  currency: 'INR';
  confirmedAt: Date;
  creditedAt: Date;
  method: string | null;
  methodLabel: string | null;
  /** The saved card an automatic top-up charged (network and last four digits only). */
  card: { network: string | null; last4: string | null } | null;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  refundedMinor: number;
  adjustments: ReceiptAdjustment[];
  /**
   * Refunds HyFib started for this payment that did not complete (ADR-058): in progress or
   * failed. Completed ones are in `adjustments`.
   */
  refundRequests: {
    id: string;
    amountMinor: number;
    status: CreditRefundStatus;
    requestedAt: Date;
    failedAt: Date | null;
  }[];
  companyName: string;
  billingEmail: string | null;
  timezone: string;
}

export interface BillingHistoryDeps {
  db: Database;
  clock: Clock;
}

const statementInput = z.object({
  month: z.string().regex(MONTH_RE, 'Choose a month as YYYY-MM.'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WalletRow {
  id: string;
  createdAt: Date;
}

const toNumber = (value: string | number | null | undefined): number => Number(value ?? 0);

/** Sums of a period's lines per ledger kind. */
interface KindSums {
  kind: LedgerKind;
  count: number;
  available: number;
  reserved: number;
}

function totalsOf(sums: KindSums[]): StatementTotals {
  const total = (kind: LedgerKind) =>
    sums.filter((s) => s.kind === kind).reduce((acc, s) => acc + s.available + s.reserved, 0);
  // Money out is the negated change; `0 - x` keeps an empty total at 0 rather than -0.
  return {
    creditAddedMinor: total('topup_credit'),
    serviceChargesMinor: 0 - total('hold_settle'),
    refundsMinor: 0 - total('refund'),
    chargebacksMinor: 0 - total('dispute_loss'),
  };
}

function missingStatement(): AppError {
  return new AppError('not_found', 'There is no statement for that month.');
}

async function loadWallet(tx: Tx, tenantId: string): Promise<WalletRow | null> {
  const [wallet] = await tx
    .select({ id: wallets.id, createdAt: wallets.createdAt })
    .from(wallets)
    .where(eq(wallets.tenantId, tenantId));
  return wallet ?? null;
}

/** Available and reserved balances from the wallet's entries before `before`. */
async function balancesBefore(
  tx: Tx,
  tenantId: string,
  walletId: string,
  before: Date,
): Promise<Balances> {
  const res = await tx.execute<{ code: string; balance: string | number }>(sql`
    select a.code,
           coalesce(sum(case when e.direction = a.normal_side then e.amount_minor else -e.amount_minor end), 0)
             as balance
      from app.ledger_accounts a
      left join app.ledger_entries e
        on e.tenant_id = a.tenant_id and e.account_id = a.id and e.created_at < ${before.toISOString()}::timestamptz
     where a.tenant_id = ${tenantId} and a.wallet_id = ${walletId}
       and a.code in ('wallet_available', 'wallet_held')
     group by a.code`);
  const of = (code: string) => toNumber(res.rows.find((r) => r.code === code)?.balance);
  return { availableMinor: of('wallet_available'), reservedMinor: of('wallet_held') };
}

/** Per-kind line counts and changes to available and reserved credit in [start, end). */
async function kindSums(
  tx: Tx,
  tenantId: string,
  walletId: string,
  start: Date,
  end: Date,
): Promise<KindSums[]> {
  const res = await tx.execute<{
    kind: LedgerKind;
    n: string | number;
    available: string | number;
    reserved: string | number;
  }>(sql`
    with lines as (
      select t.id, t.kind,
             coalesce(sum(case when e.direction = a.normal_side then e.amount_minor else -e.amount_minor end)
                      filter (where a.code = 'wallet_available'), 0) as available,
             coalesce(sum(case when e.direction = a.normal_side then e.amount_minor else -e.amount_minor end)
                      filter (where a.code = 'wallet_held'), 0) as reserved
        from app.ledger_transactions t
        join app.ledger_entries e on e.tenant_id = t.tenant_id and e.transaction_id = t.id
        join app.ledger_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
       where t.tenant_id = ${tenantId} and t.wallet_id = ${walletId}
         and t.created_at >= ${start.toISOString()}::timestamptz
         and t.created_at < ${end.toISOString()}::timestamptz
       group by t.id
    )
    select kind, count(*) as n, coalesce(sum(available), 0) as available,
           coalesce(sum(reserved), 0) as reserved
      from lines
     group by kind`);
  return res.rows.map((r) => ({
    kind: r.kind,
    count: toNumber(r.n),
    available: toNumber(r.available),
    reserved: toNumber(r.reserved),
  }));
}

type RawLine = {
  id: string;
  kind: LedgerKind;
  reference_type: string | null;
  reference_id: string | null;
  actor_id: string | null;
  created_at: Date | string;
  available_change: string | number;
  reserved_change: string | number;
  available_cum: string | number;
  reserved_cum: string | number;
};

/**
 * Lines of [start, end) in time order from line `offset` (0-based), with running sums of the
 * changes from the period's first line, so balances carry across pages. Postings made in one
 * transaction share its time and keep the order they were made in (their first entry's id), such
 * as a refund reservation released before the refund it pays for.
 */
async function periodLines(
  tx: Tx,
  tenantId: string,
  walletId: string,
  start: Date,
  end: Date,
  offset: number,
  limit: number,
): Promise<RawLine[]> {
  const res = await tx.execute<RawLine>(sql`
    with lines as (
      select t.id, t.kind, t.reference_type, t.reference_id, t.actor_id, t.created_at,
             coalesce(sum(case when e.direction = a.normal_side then e.amount_minor else -e.amount_minor end)
                      filter (where a.code = 'wallet_available'), 0) as available_change,
             coalesce(sum(case when e.direction = a.normal_side then e.amount_minor else -e.amount_minor end)
                      filter (where a.code = 'wallet_held'), 0) as reserved_change,
             min(e.id) as first_entry
        from app.ledger_transactions t
        join app.ledger_entries e on e.tenant_id = t.tenant_id and e.transaction_id = t.id
        join app.ledger_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
       where t.tenant_id = ${tenantId} and t.wallet_id = ${walletId}
         and t.created_at >= ${start.toISOString()}::timestamptz
         and t.created_at < ${end.toISOString()}::timestamptz
       group by t.id
    ), numbered as (
      select l.*,
             row_number() over w as n,
             sum(l.available_change) over w as available_cum,
             sum(l.reserved_change) over w as reserved_cum
        from lines l
      window w as (order by l.created_at, l.first_entry rows between unbounded preceding and current row)
    )
    select id, kind, reference_type, reference_id, actor_id, created_at, available_change,
           reserved_change, available_cum, reserved_cum
      from numbered
     where n > ${offset}
     order by n
     limit ${limit}`);
  return res.rows;
}

interface LineTopups {
  /** Top-up id → its receipt number and Razorpay payment. */
  topups: Map<string, { receipt: string; paymentId: string | null }>;
  /** Staff refund request id → the top-up it refunds (holds of staff refunds, ADR-058). */
  refundTopups: Map<string, string>;
}

const referenced = (lines: RawLine[], type: string) => [
  ...new Set(
    lines
      .filter((l) => l.reference_type === type && l.reference_id && UUID_RE.test(l.reference_id))
      .map((l) => l.reference_id as string),
  ),
];

/** Receipt numbers and payment ids of the top-ups the lines refer to, directly or by a refund. */
async function topupsFor(tx: Tx, tenantId: string, lines: RawLine[]): Promise<LineTopups> {
  const refundIds = referenced(lines, 'credit_refund');
  const refundTopups = new Map<string, string>();
  if (refundIds.length > 0) {
    const rows = await tx
      .select({ id: creditRefunds.id, topupId: creditRefunds.topupId })
      .from(creditRefunds)
      .where(and(eq(creditRefunds.tenantId, tenantId), inArray(creditRefunds.id, refundIds)));
    for (const r of rows) refundTopups.set(r.id, r.topupId);
  }
  const ids = [...new Set([...referenced(lines, 'topup'), ...refundTopups.values()])];
  if (ids.length === 0) return { topups: new Map(), refundTopups };
  const rows = await tx
    .select({ id: topups.id, receipt: topups.receipt, paymentId: topups.providerPaymentId })
    .from(topups)
    .where(and(eq(topups.tenantId, tenantId), inArray(topups.id, ids)));
  return {
    topups: new Map(rows.map((r) => [r.id, { receipt: r.receipt, paymentId: r.paymentId }])),
    refundTopups,
  };
}

function toLines(raw: RawLine[], opening: Balances, refs: LineTopups): StatementLine[] {
  return raw.map((r) => {
    const directTopup = r.reference_type === 'topup' ? r.reference_id : null;
    const refundTopup =
      r.reference_type === 'credit_refund' && r.reference_id
        ? (refs.refundTopups.get(r.reference_id) ?? null)
        : null;
    const candidate = directTopup ?? refundTopup;
    const topupId = candidate && refs.topups.has(candidate) ? candidate : null;
    const topup = topupId ? refs.topups.get(topupId) : undefined;
    let reference: string | null;
    if (r.kind === 'topup_credit') reference = topup?.paymentId ?? null;
    else if (r.kind === 'refund' || r.kind === 'dispute_loss') reference = r.actor_id;
    else if (r.reference_type === 'credit_refund') reference = topup?.paymentId ?? null;
    else
      reference =
        r.reference_type && r.reference_id ? `${r.reference_type} ${r.reference_id}` : null;
    return {
      id: r.id,
      at: new Date(r.created_at),
      kind: r.kind,
      label: ledgerLineLabel(r.kind, r.reference_type),
      reference,
      topupId,
      receiptNumber: topup?.receipt ?? null,
      availableChangeMinor: toNumber(r.available_change),
      reservedChangeMinor: toNumber(r.reserved_change),
      availableAfterMinor: opening.availableMinor + toNumber(r.available_cum),
      reservedAfterMinor: opening.reservedMinor + toNumber(r.reserved_cum),
    };
  });
}

/** "YYYY-MM-DD HH:MM:SS" in the company's time zone, for CSV cells. */
function localDateTime(at: Date, timeZone: string): string {
  const p = zonedParts(at.getTime(), timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${String(p.year).padStart(4, '0')}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
}

const rupees = (paise: number) => formatMinorUnits(BigInt(paise), 'INR');

export function createBillingHistoryService(deps: BillingHistoryDeps) {
  const { db, clock } = deps;

  /** Resolves and checks a statement month for the company (inside the snapshot). */
  function resolveMonth(
    wallet: WalletRow,
    monthText: string,
    timeZone: string,
    now: Date,
  ): { month: Month; start: Date; end: Date; inProgress: boolean } {
    const month = parseMonth(monthText);
    if (!month) throw missingStatement();
    const current = monthOf(now, timeZone);
    const first = monthOf(wallet.createdAt, timeZone);
    if (compareMonths(month, current) > 0 || compareMonths(month, first) < 0) {
      throw missingStatement();
    }
    const { start, end } = monthBounds(month, timeZone);
    return { month, start, end, inProgress: end.getTime() > now.getTime() };
  }

  async function buildStatement(
    ctx: TenantContext,
    input: { month: string; page: number },
    lineLimit: number,
    wholeMonth: boolean,
  ): Promise<Statement> {
    const timeZone = ctx.tenant.timezone;
    return db.run(
      ctx.scope,
      async (tx) => {
        const now = clock.now();
        const wallet = await loadWallet(tx, ctx.tenant.id);
        if (!wallet) throw missingStatement();
        const period = resolveMonth(wallet, input.month, timeZone, now);
        const walletId = wallet.id;
        const opening = await balancesBefore(tx, ctx.tenant.id, walletId, period.start);
        const sums = await kindSums(tx, ctx.tenant.id, walletId, period.start, period.end);
        const lineCount = sums.reduce((acc, s) => acc + s.count, 0);
        if (wholeMonth && lineCount > STATEMENT_CSV_MAX_LINES) {
          throw new AppError(
            'validation_failed',
            `This month has more than ${STATEMENT_CSV_MAX_LINES.toLocaleString('en-IN')} lines, too many for one file. Contact support for an export.`,
          );
        }
        const pageCount = Math.max(1, Math.ceil(lineCount / STATEMENT_PAGE_SIZE));
        const page = wholeMonth ? 1 : Math.min(input.page, pageCount);
        const offset = wholeMonth ? 0 : (page - 1) * STATEMENT_PAGE_SIZE;
        const raw = await periodLines(
          tx,
          ctx.tenant.id,
          walletId,
          period.start,
          period.end,
          offset,
          lineLimit,
        );
        const lines = toLines(raw, opening, await topupsFor(tx, ctx.tenant.id, raw));
        const closing: Balances = {
          availableMinor: opening.availableMinor + sums.reduce((acc, s) => acc + s.available, 0),
          reservedMinor: opening.reservedMinor + sums.reduce((acc, s) => acc + s.reserved, 0),
        };
        return {
          month: formatMonth(period.month),
          label: monthLabel(period.month),
          timezone: timeZone,
          start: period.start,
          end: period.end,
          inProgress: period.inProgress,
          generatedAt: now,
          opening,
          closing,
          totals: totalsOf(sums),
          lineCount,
          page,
          pageCount,
          lines,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  return {
    /**
     * Every month from the wallet's creation to the current month (newest first), each with its
     * totals and closing balances. Empty when the company never started a payment.
     */
    async statementMonths(ctx: TenantContext): Promise<StatementMonthSummary[]> {
      assertCan(ctx, 'billing.read');
      const timeZone = ctx.tenant.timezone;
      return db.run(
        ctx.scope,
        async (tx) => {
          const now = clock.now();
          const wallet = await loadWallet(tx, ctx.tenant.id);
          if (!wallet) return [];
          const res = await tx.execute<{
            month: string;
            kind: LedgerKind;
            n: string | number;
            available: string | number;
            reserved: string | number;
          }>(sql`
            with lines as (
              select t.id, t.kind,
                     to_char(t.created_at at time zone ${timeZone}, 'YYYY-MM') as month,
                     coalesce(sum(case when e.direction = a.normal_side then e.amount_minor else -e.amount_minor end)
                              filter (where a.code = 'wallet_available'), 0) as available,
                     coalesce(sum(case when e.direction = a.normal_side then e.amount_minor else -e.amount_minor end)
                              filter (where a.code = 'wallet_held'), 0) as reserved
                from app.ledger_transactions t
                join app.ledger_entries e on e.tenant_id = t.tenant_id and e.transaction_id = t.id
                join app.ledger_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
               where t.tenant_id = ${ctx.tenant.id} and t.wallet_id = ${wallet.id}
               group by t.id
            )
            select month, kind, count(*) as n, coalesce(sum(available), 0) as available,
                   coalesce(sum(reserved), 0) as reserved
              from lines
             group by month, kind`);
          const byMonth = new Map<string, KindSums[]>();
          for (const r of res.rows) {
            const list = byMonth.get(r.month) ?? [];
            list.push({
              kind: r.kind,
              count: toNumber(r.n),
              available: toNumber(r.available),
              reserved: toNumber(r.reserved),
            });
            byMonth.set(r.month, list);
          }
          const current = monthOf(now, timeZone);
          let first = monthOf(wallet.createdAt, timeZone);
          if (compareMonths(first, current) > 0) first = current;
          const oldestFirst: StatementMonthSummary[] = [];
          const running: Balances = { availableMinor: 0, reservedMinor: 0 };
          for (let m = first; compareMonths(m, current) <= 0; m = addMonths(m, 1)) {
            const key = formatMonth(m);
            const sums = byMonth.get(key) ?? [];
            running.availableMinor += sums.reduce((acc, s) => acc + s.available, 0);
            running.reservedMinor += sums.reduce((acc, s) => acc + s.reserved, 0);
            oldestFirst.push({
              month: key,
              label: monthLabel(m),
              inProgress: compareMonths(m, current) === 0,
              lineCount: sums.reduce((acc, s) => acc + s.count, 0),
              closing: { ...running },
              ...totalsOf(sums),
            });
          }
          return oldestFirst.reverse();
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },

    /** One month's statement, one page of lines at a time (STATEMENT_PAGE_SIZE). */
    async statement(ctx: TenantContext, input: unknown): Promise<Statement> {
      assertCan(ctx, 'billing.read');
      const data = parseInput(statementInput, input);
      return buildStatement(ctx, data, STATEMENT_PAGE_SIZE, false);
    },

    /**
     * One month's statement as CSV: an opening-balance row, every line and a closing-balance row,
     * amounts in exact rupees. Audited before any data is returned.
     */
    async statementCsv(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ filename: string; body: string }> {
      assertCan(ctx, 'billing.read');
      const data = parseInput(statementInput, input);
      const statement = await buildStatement(
        ctx,
        { month: data.month, page: 1 },
        STATEMENT_CSV_MAX_LINES,
        true,
      );
      await db.run(ctx.scope, (tx) =>
        recordAudit(
          tx,
          ctx,
          {
            action: 'billing.statement_exported',
            subjectType: 'billing_statement',
            subjectId: statement.month,
            metadata: {
              month: statement.month,
              timezone: statement.timezone,
              lines: statement.lineCount,
            },
          },
          meta,
        ),
      );
      const tz = statement.timezone;
      const rows = [
        csvLine([
          `Date (${tz})`,
          'Activity',
          'Reference',
          'Receipt number',
          'Available credit change (INR)',
          'Reserved credit change (INR)',
          'Available credit after (INR)',
          'Reserved credit after (INR)',
        ]),
        csvLine([
          localDateTime(statement.start, tz),
          'Opening balance',
          '',
          '',
          '',
          '',
          rupees(statement.opening.availableMinor),
          rupees(statement.opening.reservedMinor),
        ]),
        ...statement.lines.map((l) =>
          csvLine([
            localDateTime(l.at, tz),
            l.label,
            l.reference ?? '',
            l.receiptNumber ?? '',
            rupees(l.availableChangeMinor),
            rupees(l.reservedChangeMinor),
            rupees(l.availableAfterMinor),
            rupees(l.reservedAfterMinor),
          ]),
        ),
        csvLine([
          localDateTime(statement.inProgress ? statement.generatedAt : statement.end, tz),
          statement.inProgress ? 'Balance so far (month to date)' : 'Closing balance',
          '',
          '',
          '',
          '',
          rupees(statement.closing.availableMinor),
          rupees(statement.closing.reservedMinor),
        ]),
      ];
      return {
        filename: `statement-${statement.month}.csv`,
        body: CSV_BOM + rows.join(''),
      };
    },

    /** The receipt of a top-up credited from a captured payment. */
    async receipt(ctx: TenantContext, topupId: string): Promise<PaymentReceipt> {
      assertCan(ctx, 'billing.read');
      if (!UUID_RE.test(topupId)) throw new AppError('not_found', 'There is no such receipt.');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [topup] = await tx
            .select({
              id: topups.id,
              kind: topups.kind,
              status: topups.status,
              amountMinor: topups.amountMinor,
              receipt: topups.receipt,
              orderId: topups.providerOrderId,
              paymentId: topups.providerPaymentId,
              refundedMinor: topups.refundedMinor,
              creditedTransactionId: topups.creditedTransactionId,
              paymentMethod: topups.paymentMethod,
              paidAt: topups.paidAt,
            })
            .from(topups)
            .where(and(eq(topups.tenantId, ctx.tenant.id), eq(topups.id, topupId)));
          if (!topup || !topup.creditedTransactionId || !topup.paidAt) {
            throw new AppError(
              'not_found',
              'There is no receipt for this payment: it was not completed.',
            );
          }
          const credit = await tx.execute<{ created_at: Date | string }>(sql`
            select created_at from app.ledger_transactions
             where tenant_id = ${ctx.tenant.id} and id = ${topup.creditedTransactionId}`);
          const adjustments = await tx.execute<{
            id: string;
            kind: 'refund' | 'dispute_loss';
            actor_id: string | null;
            created_at: Date | string;
            amount: string | number;
          }>(sql`
            select t.id, t.kind, t.actor_id, t.created_at,
                   coalesce(sum(e.amount_minor) filter (where a.code = 'wallet_available' and e.direction = 'debit'), 0)
                     as amount
              from app.ledger_transactions t
              join app.ledger_entries e on e.tenant_id = t.tenant_id and e.transaction_id = t.id
              join app.ledger_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
             where t.tenant_id = ${ctx.tenant.id} and t.reference_type = 'topup'
               and t.reference_id = ${topup.id} and t.kind in ('refund', 'dispute_loss')
             group by t.id
             order by t.created_at, min(e.id)`);
          let card: PaymentReceipt['card'] = null;
          if (topup.kind === 'auto_recharge') {
            const [mandate] = await tx
              .select({ network: paymentMandates.cardNetwork, last4: paymentMandates.cardLast4 })
              .from(autoRechargeAttempts)
              .innerJoin(
                paymentMandates,
                and(
                  eq(paymentMandates.tenantId, autoRechargeAttempts.tenantId),
                  eq(paymentMandates.id, autoRechargeAttempts.mandateId),
                ),
              )
              .where(
                and(
                  eq(autoRechargeAttempts.tenantId, ctx.tenant.id),
                  eq(autoRechargeAttempts.topupId, topup.id),
                ),
              );
            card = mandate ?? null;
          }
          const refundRequests = await tx
            .select({
              id: creditRefunds.id,
              amountMinor: creditRefunds.amountMinor,
              status: creditRefunds.status,
              requestedAt: creditRefunds.requestedAt,
              failedAt: creditRefunds.failedAt,
            })
            .from(creditRefunds)
            .where(
              and(
                eq(creditRefunds.tenantId, ctx.tenant.id),
                eq(creditRefunds.topupId, topup.id),
                inArray(creditRefunds.status, ['requested', 'submitted', 'failed']),
              ),
            )
            .orderBy(creditRefunds.requestedAt);
          const [customer] = await tx
            .select({ email: billingCustomers.email })
            .from(billingCustomers)
            .where(eq(billingCustomers.tenantId, ctx.tenant.id));
          const creditedAt = credit.rows[0]?.created_at;
          return {
            topupId: topup.id,
            receiptNumber: topup.receipt,
            kind: topup.kind,
            status: topup.status,
            amountMinor: topup.amountMinor,
            currency: 'INR' as const,
            confirmedAt: topup.paidAt,
            creditedAt: creditedAt ? new Date(creditedAt) : topup.paidAt,
            method: topup.paymentMethod,
            methodLabel: paymentMethodLabel(topup.paymentMethod),
            card,
            providerPaymentId: topup.paymentId,
            providerOrderId: topup.orderId,
            refundedMinor: topup.refundedMinor,
            adjustments: adjustments.rows.map((r) => ({
              id: r.id,
              kind: r.kind,
              label: LEDGER_KIND_LABELS[r.kind],
              amountMinor: toNumber(r.amount),
              at: new Date(r.created_at),
              reference: r.actor_id,
            })),
            refundRequests,
            companyName: ctx.tenant.name,
            billingEmail: customer?.email ?? null,
            timezone: ctx.tenant.timezone,
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
  };
}

export type BillingHistoryService = ReturnType<typeof createBillingHistoryService>;
