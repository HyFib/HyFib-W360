import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { displayMoney, isAppError } from '@w360/core';
import { assertCan, type PaymentReceipt } from '@w360/domain';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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

export const metadata: Metadata = { title: 'Payment receipt' };
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

const STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  paid: { label: 'Paid', tone: 'success' },
  partially_refunded: { label: 'Partly refunded', tone: 'warning' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

function paidWith(receipt: PaymentReceipt): string {
  if (receipt.card && (receipt.card.network || receipt.card.last4)) {
    const card = `${receipt.card.network ?? 'Card'}${receipt.card.last4 ? ` •••• ${receipt.card.last4}` : ''}`;
    return `${card} (saved card, automatic top-up)`;
  }
  if (receipt.methodLabel) return `${receipt.methodLabel}, through Razorpay`;
  return 'Razorpay';
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-0.5 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

/**
 * The receipt of a paid top-up (ADR-057): a payment confirmation for prepaid service credit, not a
 * tax invoice.
 */
export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'billing.read');
  const { billingHistory } = await getRuntime();
  let receipt: PaymentReceipt;
  try {
    receipt = await billingHistory.receipt(ctx, id);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const tz = receipt.timezone;
  const status = STATUS[receipt.status] ?? { label: receipt.status, tone: 'neutral' as const };

  return (
    <div className="grid grid-cols-1 gap-6">
      <a
        href={`/c/${ctx.tenant.slug}/billing`}
        className="text-sm text-primary underline-offset-4 hover:underline print:hidden"
      >
        ← Billing
      </a>
      <PageHeader
        title="Payment receipt"
        description={`Receipt ${receipt.receiptNumber}`}
        actions={<PrintButton />}
      />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{inr(receipt.amountMinor)} for HyFib W360 service credit</CardTitle>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <CardDescription>
            This receipt confirms a payment for prepaid service credit. It is not a tax invoice.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6">
          <dl className="grid grid-cols-1 gap-3">
            <Row label="Receipt number">
              <span className="font-mono">{receipt.receiptNumber}</span>
            </Row>
            <Row label="Paid by">
              {receipt.companyName}
              {receipt.billingEmail ? (
                <span className="block text-muted-foreground">{receipt.billingEmail}</span>
              ) : null}
            </Row>
            <Row label="Amount">{inr(receipt.amountMinor)} (INR)</Row>
            <Row label="Payment">
              {receipt.kind === 'manual' ? 'One-time payment' : 'Automatic top-up'}
            </Row>
            <Row label="Paid with">{paidWith(receipt)}</Row>
            <Row label="Payment confirmed">{formatDateTime(receipt.confirmedAt, tz)}</Row>
            <Row label="Credit added">{formatDateTime(receipt.creditedAt, tz)}</Row>
            {receipt.providerPaymentId ? (
              <Row label="Razorpay payment">
                <span className="font-mono">{receipt.providerPaymentId}</span>
              </Row>
            ) : null}
            {receipt.providerOrderId ? (
              <Row label="Razorpay order">
                <span className="font-mono">{receipt.providerOrderId}</span>
              </Row>
            ) : null}
            {receipt.refundedMinor > 0 ? (
              <Row label="Refunded">{inr(receipt.refundedMinor)}</Row>
            ) : null}
          </dl>
          {receipt.adjustments.length > 0 ? (
            <div className="grid gap-2">
              <h2 className="text-sm font-medium">Refunds and chargebacks</h2>
              <Table>
                <THead>
                  <TR>
                    <TH>When</TH>
                    <TH>Activity</TH>
                    <TH>Reference</TH>
                    <TH className="text-right">Amount</TH>
                  </TR>
                </THead>
                <TBody>
                  {receipt.adjustments.map((a) => (
                    <TR key={a.id}>
                      <TD className="whitespace-nowrap">{formatDateTime(a.at, tz)}</TD>
                      <TD>{a.label}</TD>
                      <TD className="font-mono text-xs">{a.reference ?? ''}</TD>
                      <TD className="text-right tabular-nums">{inr(a.amountMinor)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Times are in {tz}. Card numbers are never stored by HyFib. Tax invoices are not issued
            yet.{' '}
            <Link
              href={`/c/${ctx.tenant.slug}/billing/statements`}
              className="text-primary underline-offset-4 hover:underline print:hidden"
            >
              Monthly statements
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
