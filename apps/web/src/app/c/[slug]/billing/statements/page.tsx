import type { Metadata } from 'next';
import Link from 'next/link';
import { displayMoney } from '@w360/core';
import { assertCan } from '@w360/domain';
import {
  Badge,
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
import { PageHeader } from '@/components/page-header';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Statements' };
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

/** Every month of service credit since the first payment, newest first (ADR-057). */
export default async function StatementsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'billing.read');
  const { billingHistory } = await getRuntime();
  const months = await billingHistory.statementMonths(ctx);
  const base = `/c/${ctx.tenant.slug}/billing`;

  return (
    <div className="grid grid-cols-1 gap-6">
      <a href={base} className="text-sm text-primary underline-offset-4 hover:underline">
        ← Billing
      </a>
      <PageHeader
        title="Statements"
        description={`Your service credit month by month, with every credit, charge, refund and chargeback. Months follow the company's time zone (${ctx.tenant.timezone}).`}
      />
      <Card>
        <CardHeader>
          <CardTitle>Monthly statements</CardTitle>
          <CardDescription>
            Open a month for its lines, print it or save it as a PDF, or download it as CSV for your
            accounts. Statements show service credit only: Meta bills your WhatsApp account
            directly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {months.length === 0 ? (
            <EmptyState
              title="No statements yet"
              description="Statements start in the month of your first payment."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Month</TH>
                  <TH className="text-right">Credit added</TH>
                  <TH className="text-right">Service charges</TH>
                  <TH className="text-right">Refunds and chargebacks</TH>
                  <TH className="text-right">Closing balance</TH>
                  <TH>
                    <span className="sr-only">Download</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {months.map((m) => (
                  <TR key={m.month}>
                    <TD className="whitespace-nowrap">
                      <Link
                        href={`${base}/statements/${m.month}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {m.label}
                      </Link>
                      {m.inProgress ? (
                        <Badge tone="info" className="ml-2">
                          Month to date
                        </Badge>
                      ) : null}
                      <div className="text-xs text-muted-foreground">
                        {m.lineCount === 0
                          ? 'No activity'
                          : `${m.lineCount} ${m.lineCount === 1 ? 'line' : 'lines'}`}
                      </div>
                    </TD>
                    <TD className="text-right tabular-nums">{inr(m.creditAddedMinor)}</TD>
                    <TD className="text-right tabular-nums">{inr(m.serviceChargesMinor)}</TD>
                    <TD className="text-right tabular-nums">
                      {inr(m.refundsMinor + m.chargebacksMinor)}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {inr(m.closing.availableMinor + m.closing.reservedMinor)}
                    </TD>
                    <TD className="whitespace-nowrap">
                      <a
                        href={`${base}/statements/${m.month}/csv`}
                        download
                        className="text-sm text-primary underline-offset-4 hover:underline"
                      >
                        CSV<span className="sr-only"> for {m.label}</span>
                      </a>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
