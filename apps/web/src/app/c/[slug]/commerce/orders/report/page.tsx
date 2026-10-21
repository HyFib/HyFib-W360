import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import {
  PERIOD_PRESETS,
  can,
  formatOrderTotal,
  type CurrencyTotal,
  type OrderReport,
} from '@w360/domain';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { ORDER_STATUS } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { formatCount, formatDay, formatDayLong } from '@/lib/report-format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Order report' };
export const dynamic = 'force-dynamic';

const PRESET_LABELS: Record<string, string> = {
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  custom: 'Custom dates',
};

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/** The currencies any of these totals use, in currency order. */
const currenciesOf = (lists: CurrencyTotal[][]) =>
  [...new Set(lists.flatMap((l) => l.map((t) => t.currency)))].sort();

const amountIn = (totals: CurrencyTotal[], currency: string) => {
  const line = totals.find((t) => t.currency === currency);
  return line ? formatOrderTotal(line.minor, currency) : '—';
};

/**
 * WhatsApp order report (ADR-409): orders received per day and status, their subtotals per
 * currency and the items by product, over the orders the member sees in the list. Totals only.
 */
export default async function OrderReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const { commerce } = await getRuntime();
  let report: OrderReport;
  let periodError: string | null = null;
  try {
    report = await commerce.orderReport(ctx, {
      preset: one(sp.preset),
      from: one(sp.from),
      to: one(sp.to),
    });
  } catch (error) {
    if (!isAppError(error) || error.code !== 'validation_failed') throw error;
    periodError = error.publicMessage;
    report = await commerce.orderReport(ctx, {});
  }
  const { period, totals } = report;
  const tz = ctx.tenant.timezone;
  const base = `/c/${ctx.tenant.slug}/commerce`;
  const currencies = currenciesOf([totals.subtotals]);
  const productCurrencies = currenciesOf(report.products.map((p) => p.subtotals));

  return (
    <div className="grid grid-cols-1 gap-6">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Order report</CardTitle>
          <CardDescription>
            WhatsApp orders received in a period, by day, status and product. You see the totals of
            the orders of conversations you can see, as in the{' '}
            <Link href={base} className="text-primary underline-offset-4 hover:underline">
              order list
            </Link>
            . Amounts are the prices WhatsApp sent with each order; statuses are the orders’
            statuses now.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4">
          {periodError ? (
            <Alert tone="warning" title="Showing the last 7 days instead">
              {periodError}
            </Alert>
          ) : null}
          <form method="get" className="grid items-end gap-4 sm:grid-cols-4">
            <div className="grid gap-1.5">
              <Label htmlFor="or-preset">Period</Label>
              <Select id="or-preset" name="preset" defaultValue={period.preset}>
                {[...PERIOD_PRESETS, 'custom'].map((p) => (
                  <option key={p} value={p}>
                    {PRESET_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="or-from">From (custom dates)</Label>
              <Input id="or-from" name="from" type="date" defaultValue={period.from} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="or-to">To (custom dates)</Label>
              <Input id="or-to" name="to" type="date" defaultValue={period.to} />
            </div>
            <div>
              <Button type="submit" variant="outline">
                Show report
              </Button>
            </div>
          </form>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {formatDayLong(period.from)} – {formatDayLong(period.to)}
            </span>{' '}
            in {tz} ({period.days.length} {period.days.length === 1 ? 'day' : 'days'}).
            {period.inProgress
              ? ' The period includes today, so its numbers are still moving.'
              : ''}{' '}
            Computed {formatDateTime(report.generatedAt.toISOString(), tz)}.
          </p>
          <dl className="grid gap-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Orders</dt>
              <dd className="text-lg font-semibold">{formatCount(totals.orders)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="text-lg font-semibold">
                {totals.subtotals.length === 0
                  ? '—'
                  : totals.subtotals.map((t) => (
                      <span key={t.currency} className="block">
                        {formatOrderTotal(t.minor, t.currency)}
                      </span>
                    ))}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Orders without a known total</dt>
              <dd className="text-lg font-semibold">{formatCount(totals.withoutSubtotal)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Items HyFib could not read</dt>
              <dd className="text-lg font-semibold">
                {formatCount(totals.unreadableItems)}
                <span className="block text-xs font-normal text-muted-foreground">
                  in {formatCount(totals.ordersWithUnreadableItems)}{' '}
                  {totals.ordersWithUnreadableItems === 1 ? 'order' : 'orders'}
                </span>
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            A subtotal counts only orders whose every item HyFib read with a price in one currency;
            the others are counted as orders without a known total, never estimated.
          </p>
        </CardContent>
      </Card>

      {totals.orders === 0 ? (
        <EmptyState
          title="No orders in this period"
          description="An order is counted here when a customer sends their cart from your WhatsApp catalog in a conversation you can see."
        />
      ) : (
        <>
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>By status</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Status</TH>
                    <TH>Orders</TH>
                    {currencies.map((c) => (
                      <TH key={c}>Subtotal ({c})</TH>
                    ))}
                    <TH>Without a known total</TH>
                  </TR>
                </THead>
                <TBody>
                  {report.statuses.map((s) => (
                    <TR key={s.status}>
                      <TD>{ORDER_STATUS[s.status]?.label ?? s.status}</TD>
                      <TD>{formatCount(s.orders)}</TD>
                      {currencies.map((c) => (
                        <TD key={c}>{amountIn(s.subtotals, c)}</TD>
                      ))}
                      <TD>{formatCount(s.withoutSubtotal)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>By day</CardTitle>
              <CardDescription>Days in {tz}, by when HyFib received each order.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Day</TH>
                    <TH>Orders</TH>
                    {report.statuses.map((s) => (
                      <TH key={s.status}>{ORDER_STATUS[s.status]?.label ?? s.status}</TH>
                    ))}
                    {currencies.map((c) => (
                      <TH key={c}>Subtotal ({c})</TH>
                    ))}
                    <TH>Without a known total</TH>
                    <TH>Unreadable items</TH>
                  </TR>
                </THead>
                <TBody>
                  {report.days.map((d) => (
                    <TR key={d.day}>
                      <TD className="whitespace-nowrap">{formatDay(d.day)}</TD>
                      <TD>{formatCount(d.orders)}</TD>
                      {report.statuses.map((s) => (
                        <TD key={s.status}>{formatCount(d.byStatus[s.status])}</TD>
                      ))}
                      {currencies.map((c) => (
                        <TD key={c}>{amountIn(d.subtotals, c)}</TD>
                      ))}
                      <TD>{formatCount(d.withoutSubtotal)}</TD>
                      <TD>{formatCount(d.unreadableItems)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>By product</CardTitle>
              <CardDescription>
                Items HyFib read, by the retailer id the catalog gives each product, with the name
                the catalog had when the latest order arrived. A subtotal counts the items whose
                price HyFib read.
                {report.productCount > report.products.length
                  ? ` The ${formatCount(report.products.length)} most ordered of ${formatCount(report.productCount)} products are listed.`
                  : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Retailer id</TH>
                    <TH>Product</TH>
                    <TH>Quantity</TH>
                    <TH>Orders</TH>
                    {productCurrencies.map((c) => (
                      <TH key={c}>Subtotal ({c})</TH>
                    ))}
                    <TH>Quantity without a price</TH>
                  </TR>
                </THead>
                <TBody>
                  {report.products.map((p) => (
                    <TR key={p.retailerId}>
                      <TD className="font-mono text-sm">{p.retailerId}</TD>
                      <TD>{p.name ?? 'Not in HyFib’s copy of the catalog'}</TD>
                      <TD>{formatCount(p.quantity)}</TD>
                      <TD>{formatCount(p.orders)}</TD>
                      {productCurrencies.map((c) => (
                        <TD key={c}>{amountIn(p.subtotals, c)}</TD>
                      ))}
                      <TD>{formatCount(p.unpricedQuantity)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
