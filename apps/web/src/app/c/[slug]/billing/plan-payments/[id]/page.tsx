import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { displayMoney, isAppError } from '@w360/core';
import { assertCan, PLAN_INTERVAL_LABELS, type PlanPaymentReceipt } from '@w360/domain';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { PrintButton } from '@/components/billing/print-button';
import { PageHeader } from '@/components/page-header';
import { formatDate, formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Plan payment receipt' };
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The add-ons the payment covered, in words; empty when there were none. */
function addOns(receipt: PlanPaymentReceipt): string[] {
  return [
    receipt.extraSeats > 0 ? count(receipt.extraSeats, 'extra seat', 'extra seats') : null,
    receipt.extraNumbers > 0
      ? count(receipt.extraNumbers, 'extra WhatsApp number', 'extra WhatsApp numbers')
      : null,
    receipt.runPacks > 0
      ? count(receipt.runPacks, 'automation run pack', 'automation run packs')
      : null,
  ].filter((a): a is string => a !== null);
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
 * The receipt of a plan payment Razorpay charged for the company's subscription (ADR-064): a
 * payment confirmation for the plan, not a tax invoice.
 */
export default async function PlanPaymentReceiptPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'billing.read');
  const { planPayments } = await getRuntime();
  let receipt: PlanPaymentReceipt;
  try {
    receipt = await planPayments.receipt(ctx, id);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const tz = receipt.timezone;
  const extras = addOns(receipt);

  return (
    <div className="grid grid-cols-1 gap-6">
      <a
        href={`/c/${ctx.tenant.slug}/billing`}
        className="text-sm text-primary underline-offset-4 hover:underline print:hidden"
      >
        ← Billing
      </a>
      <PageHeader
        title="Plan payment receipt"
        description={`Receipt ${receipt.receiptNumber}`}
        actions={<PrintButton />}
      />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>
              {inr(receipt.amountMinor)} for the {receipt.planName} plan
            </CardTitle>
            {receipt.refundedMinor >= receipt.amountMinor ? (
              <Badge tone="neutral">Refunded</Badge>
            ) : receipt.refundedMinor > 0 ? (
              <Badge tone="warning">Partly refunded</Badge>
            ) : (
              <Badge tone="success">Paid</Badge>
            )}
          </div>
          <CardDescription>
            This receipt confirms a payment for your HyFib W360 plan through a Razorpay
            subscription. It is not a tax invoice.
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
            <Row label="Plan">
              {receipt.planName} ({receipt.planCode} v{receipt.planVersion}),{' '}
              {PLAN_INTERVAL_LABELS[receipt.intervalMonths] ?? ''}
              {extras.length > 0 ? (
                <span className="block text-muted-foreground">With {extras.join(', ')}</span>
              ) : null}
            </Row>
            <Row label="Billing period">
              {formatDate(receipt.periodStart, tz)} to {formatDate(receipt.periodEnd, tz)}
            </Row>
            {receipt.breakdown ? (
              <>
                <Row label="Plan and add-ons">{inr(receipt.breakdown.subtotalMinor)}</Row>
                <Row label={`Tax (${receipt.breakdown.taxBp / 100}%)`}>
                  {inr(receipt.breakdown.taxMinor)}
                </Row>
              </>
            ) : null}
            <Row label="Amount paid">{inr(receipt.amountMinor)} (INR)</Row>
            {receipt.refunds.map((r) => (
              <Row
                key={r.id}
                label={
                  r.status === 'processed' && r.processedAt
                    ? `Refunded on ${formatDate(r.processedAt, tz)}`
                    : 'Refund in progress'
                }
              >
                {inr(r.amountMinor)}
                <span className="block text-muted-foreground">
                  {r.origin === 'staff' ? 'Started by HyFib' : 'Made at Razorpay'}
                  {r.status === 'processed'
                    ? ', back to the card, UPI or bank account the payment came from'
                    : '; Razorpay usually completes a refund in 5–7 working days'}
                </span>
              </Row>
            ))}
            {receipt.refundedMinor > 0 ? (
              <Row label="Paid after refunds">
                {inr(receipt.amountMinor - receipt.refundedMinor)} (INR)
              </Row>
            ) : null}
            <Row label="Paid with">
              {receipt.methodLabel ? `${receipt.methodLabel}, through Razorpay` : 'Razorpay'}
            </Row>
            <Row label="Paid on">{formatDateTime(receipt.paidAt, tz)}</Row>
            <Row label="Razorpay payment">
              <span className="font-mono">{receipt.providerPaymentId}</span>
            </Row>
            <Row label="Razorpay invoice">
              <span className="font-mono">{receipt.providerInvoiceId}</span>
            </Row>
            {receipt.providerSubscriptionId ? (
              <Row label="Razorpay subscription">
                <span className="font-mono">{receipt.providerSubscriptionId}</span>
              </Row>
            ) : null}
          </dl>
          <p className="text-xs text-muted-foreground">
            Times are in {tz}. Card numbers are never stored by HyFib. Tax invoices are not issued
            yet. A refund shows here once HyFib asks Razorpay for it, or once Razorpay reports one
            made there.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
