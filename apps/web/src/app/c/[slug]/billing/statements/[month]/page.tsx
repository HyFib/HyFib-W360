import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError, displayMoney } from '@w360/core';
import { assertCan, STATEMENT_PAGE_SIZE, type Statement } from '@w360/domain';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { PrintButton } from '@/components/billing/print-button';
import { PageHeader } from '@/components/page-header';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Statement' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

function signed(paise: number): string {
  if (paise === 0) return '—';
  return paise > 0 ? `+${inr(paise)}` : `−${inr(-paise)}`;
}

function Amount({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`tabular-nums ${strong ? 'text-lg font-semibold' : ''}`}>{value}</dd>
    </div>
  );
}

function Balance({ title, balances }: { title: string; balances: Statement['opening'] }) {
  return (
    <div className="grid gap-2 rounded-md border border-border p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      <dl className="grid gap-2 sm:grid-cols-3">
        <Amount label="Available" value={inr(balances.availableMinor)} />
        <Amount label="Reserved for running services" value={inr(balances.reservedMinor)} />
        <Amount
          label="Total credit"
          value={inr(balances.availableMinor + balances.reservedMinor)}
          strong
        />
      </dl>
    </div>
  );
}

/** One month of service credit (ADR-057): balances, totals and every ledger line, paged. */
export default async function StatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; month: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug, month } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'billing.read');
  const { billingHistory } = await getRuntime();
  const pageParam = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  let statement: Statement;
  try {
    statement = await billingHistory.statement(ctx, { month, page: pageParam ?? 1 });
  } catch (error) {
    if (isAppError(error) && (error.code === 'not_found' || error.code === 'validation_failed')) {
      notFound();
    }
    throw error;
  }
  const tz = statement.timezone;
  const base = `/c/${ctx.tenant.slug}/billing`;
  const here = `${base}/statements/${statement.month}`;
  const { totals } = statement;
  const first = (statement.page - 1) * STATEMENT_PAGE_SIZE + 1;
  const last = first + statement.lines.length - 1;

  return (
    <div className="grid grid-cols-1 gap-6">
      <Link
        href={`${base}/statements`}
        className="text-sm text-primary underline-offset-4 hover:underline print:hidden"
      >
        ← All statements
      </Link>
      <PageHeader
        title={`Statement for ${statement.label}`}
        description={`${ctx.tenant.name} · service credit · times in ${tz}`}
        actions={
          <>
            <PrintButton />
            <a
              href={`${here}/csv`}
              download
              className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted print:hidden"
            >
              Download CSV
            </a>
          </>
        }
      />
      {statement.inProgress ? (
        <Alert tone="info" title="Month to date">
          This month has not ended: the statement includes everything up to{' '}
          {formatDateTime(statement.generatedAt, tz)}.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
          <CardDescription>
            Generated {formatDateTime(statement.generatedAt, tz)}. The closing balance is the
            opening balance plus every line below.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Balance title="Opening balance" balances={statement.opening} />
          <dl className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-4">
            <Amount label="Credit added" value={inr(totals.creditAddedMinor)} />
            <Amount label="Service charges" value={inr(totals.serviceChargesMinor)} />
            <Amount label="Refunds to card" value={inr(totals.refundsMinor)} />
            <Amount label="Chargebacks" value={inr(totals.chargebacksMinor)} />
          </dl>
          <Balance
            title={statement.inProgress ? 'Balance so far' : 'Closing balance'}
            balances={statement.closing}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
          <CardDescription>
            {statement.lineCount === 0
              ? 'Nothing changed your service credit this month.'
              : `Lines ${first}–${last} of ${statement.lineCount}, oldest first. Holds move credit between available and reserved without changing the total.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {statement.lineCount === 0 ? (
            <EmptyState title="No activity" description="Credits and charges appear here." />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Activity</TH>
                  <TH className="text-right">Available</TH>
                  <TH className="text-right">Reserved</TH>
                  <TH className="text-right">Available after</TH>
                </TR>
              </THead>
              <TBody>
                {statement.lines.map((line) => (
                  <TR key={line.id}>
                    <TD className="whitespace-nowrap">{formatDateTime(line.at, tz)}</TD>
                    <TD>
                      <div>{line.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {line.reference ? (
                          <span className="font-mono">{line.reference}</span>
                        ) : null}
                        {line.topupId ? (
                          <>
                            {line.reference ? ' · ' : null}
                            <Link
                              href={`${base}/receipts/${line.topupId}`}
                              className="text-primary underline-offset-4 hover:underline"
                            >
                              Receipt<span className="sr-only"> {line.receiptNumber}</span>
                            </Link>
                          </>
                        ) : null}
                      </div>
                    </TD>
                    <TD className="text-right tabular-nums">{signed(line.availableChangeMinor)}</TD>
                    <TD className="text-right tabular-nums">{signed(line.reservedChangeMinor)}</TD>
                    <TD className="text-right tabular-nums">{inr(line.availableAfterMinor)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {statement.pageCount > 1 ? (
            <nav
              aria-label="Statement pages"
              className="flex flex-wrap items-center justify-between gap-2 text-sm print:hidden"
            >
              {statement.page > 1 ? (
                <Link
                  href={`${here}?page=${statement.page - 1}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  ← Earlier lines
                </Link>
              ) : (
                <span />
              )}
              <span className="text-muted-foreground">
                Page {statement.page} of {statement.pageCount}
              </span>
              {statement.page < statement.pageCount ? (
                <Link
                  href={`${here}?page=${statement.page + 1}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Later lines →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
