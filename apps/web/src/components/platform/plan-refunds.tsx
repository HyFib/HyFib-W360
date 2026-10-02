import Link from 'next/link';
import { displayMoney } from '@w360/core';
import {
  PLAN_PAYMENT_REFUND_STATUS_LABELS,
  REFUND_REQUEST_STATUS_LABELS,
  type PlanPaymentRefundStatus,
  type PlatformPlanRefundListItem,
  type PlatformPlanRefundRequest,
} from '@w360/domain';
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
import { CompanyLink, Utc } from '@/components/platform/ops';
import { RefundRequestDecision } from '@/components/platform/refund-request-decision';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

const REQUEST_TONE: Record<
  PlatformPlanRefundRequest['status'],
  'info' | 'success' | 'danger' | 'neutral'
> = {
  open: 'info',
  approved: 'success',
  declined: 'danger',
  withdrawn: 'neutral',
};

const REFUND_TONE: Record<PlanPaymentRefundStatus, 'info' | 'success' | 'danger'> = {
  requested: 'info',
  submitted: 'info',
  processed: 'success',
  failed: 'danger',
};

type Page<T> = { items: T[]; nextCursor: string | null };

/**
 * Refunds of plan payments across companies (ADR-104): the requests companies made, which platform
 * owners approve or decline, and every refund of a plan payment (started by HyFib, answering a
 * request, or made at Razorpay). Payments to HyFib only; no company content.
 */
export function PlanRefundsSections({
  views,
  view,
  requests,
  refunds,
  requestsCursor,
  refundsCursor,
  isOwner,
  sixMonthsAgo,
  href,
}: {
  views: readonly { key: string; label: string }[];
  view: string;
  requests: Page<PlatformPlanRefundRequest>;
  refunds: Page<PlatformPlanRefundListItem>;
  requestsCursor: string | undefined;
  refundsCursor: string | undefined;
  isOwner: boolean;
  sixMonthsAgo: Date;
  /** The page's URL with a view and the two list positions. */
  href: (view: string, requests: string | undefined, refunds: string | undefined) => string;
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Requests from companies</CardTitle>
          <CardDescription>
            Approving checks everything again: what Razorpay has not refunded of the payment, a
            refund already in progress and a company being deleted. A request that no longer fits is
            refused with the reason and stays open, to decline with a note. The company’s plan and
            its paid period never change.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <nav className="flex flex-wrap gap-4 text-sm" aria-label="Requests to show">
            {views.map((v) =>
              v.key === view ? (
                <span key={v.key} className="font-medium" aria-current="page">
                  {v.label}
                </span>
              ) : (
                <Link
                  key={v.key}
                  href={href(v.key, undefined, refundsCursor)}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {v.label}
                </Link>
              ),
            )}
          </nav>
          {requests.items.length === 0 ? (
            <EmptyState
              title={view === 'open' ? 'No request is waiting' : 'No requests'}
              description="Companies ask for refunds of plan payments from their plan payment receipts."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Asked</TH>
                  <TH>Company</TH>
                  <TH>Payment</TH>
                  <TH>Amount</TH>
                  <TH>Reason</TH>
                  <TH>Decision</TH>
                </TR>
              </THead>
              <TBody>
                {requests.items.map((r) => {
                  const left = r.paymentAmountMinor - r.paymentRefundedMinor;
                  return (
                    <TR key={r.id}>
                      <TD>
                        <Utc at={r.requestedAt} />
                        {r.requestedByName ? (
                          <span className="block text-xs text-muted-foreground">
                            by {r.requestedByName}
                          </span>
                        ) : null}
                      </TD>
                      <TD>
                        <CompanyLink id={r.tenantId} name={r.companyName} slug={r.companySlug} />
                        {r.companyStatus !== 'active' ? (
                          <Badge tone="warning">{r.companyStatus}</Badge>
                        ) : null}
                      </TD>
                      <TD className="text-sm">
                        <span className="font-mono text-xs">{r.paymentReceipt}</span>
                        <span className="block whitespace-nowrap">
                          {inr(r.paymentAmountMinor)}
                          {r.paymentRefundedMinor > 0
                            ? ` (${inr(r.paymentRefundedMinor)} refunded)`
                            : ''}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Paid <Utc at={r.paymentPaidAt} />
                        </span>
                        {r.paymentPaidAt && r.paymentPaidAt < sixMonthsAgo ? (
                          <span className="block text-xs text-warning">
                            Over 6 months ago: Razorpay may fail a normal refund.
                          </span>
                        ) : null}
                      </TD>
                      <TD className="text-sm">
                        <span className="whitespace-nowrap font-medium">{inr(r.amountMinor)}</span>
                        {r.status === 'open' ? (
                          <span className="block text-xs text-muted-foreground">
                            {inr(Math.max(left, 0))} left of the payment
                          </span>
                        ) : null}
                      </TD>
                      <TD className="min-w-48 break-words text-sm">{r.reason}</TD>
                      <TD className="min-w-64 text-sm">
                        <Badge tone={REQUEST_TONE[r.status]}>
                          {r.status === 'open'
                            ? 'Waiting for a decision'
                            : REFUND_REQUEST_STATUS_LABELS[r.status]}
                        </Badge>
                        {r.decidedAt ? (
                          <span className="block text-xs text-muted-foreground">
                            <Utc at={r.decidedAt} />
                            {r.decidedByName ? ` by ${r.decidedByName}` : ''}
                          </span>
                        ) : null}
                        {r.decisionNote ? (
                          <span className="block break-words text-xs text-muted-foreground">
                            Note: {r.decisionNote}
                          </span>
                        ) : null}
                        {r.planPaymentRefundStatus ? (
                          <span className="block text-xs text-muted-foreground">
                            Refund: {PLAN_PAYMENT_REFUND_STATUS_LABELS[r.planPaymentRefundStatus]}
                          </span>
                        ) : null}
                        {r.status === 'open' && r.refundInProgress ? (
                          <span className="block text-xs text-muted-foreground">
                            A refund of this payment is in progress: approving would be refused.
                          </span>
                        ) : null}
                        {r.status === 'open' ? (
                          isOwner ? (
                            <div className="mt-3">
                              <RefundRequestDecision
                                requestId={r.id}
                                amountLabel={inr(r.amountMinor)}
                                kind="plan_payment"
                              />
                            </div>
                          ) : (
                            <span className="block text-xs text-muted-foreground">
                              Only platform owners decide refund requests.
                            </span>
                          )
                        ) : null}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
          <div className="flex justify-end gap-3 text-sm">
            {requestsCursor ? (
              <Link
                href={href(view, undefined, refundsCursor)}
                className="text-primary underline-offset-4 hover:underline"
              >
                Newest requests
              </Link>
            ) : null}
            {requests.nextCursor ? (
              <Link
                href={href(view, requests.nextCursor, refundsCursor)}
                className="text-primary underline-offset-4 hover:underline"
              >
                Older requests
              </Link>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>All refunds of plan payments</CardTitle>
          <CardDescription>
            Every refund across companies, newest first: started from a company’s page, approving a
            request, or made at Razorpay (for example in its Dashboard). Razorpay returns the money
            to where it came from, usually in 5–7 working days.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {refunds.items.length === 0 ? (
            <EmptyState title="No refunds" description="Refunds of plan payments appear here." />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Requested</TH>
                  <TH>Company</TH>
                  <TH>Receipt</TH>
                  <TH>Amount</TH>
                  <TH>Status</TH>
                  <TH>Reason</TH>
                </TR>
              </THead>
              <TBody>
                {refunds.items.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      <Utc at={r.requestedAt} />
                      {r.requestedByName ? (
                        <span className="block text-xs text-muted-foreground">
                          by {r.requestedByName}
                        </span>
                      ) : null}
                      {r.requestId ? (
                        <span className="block text-xs text-muted-foreground">
                          Asked for by the company
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      <CompanyLink id={r.tenantId} name={r.companyName} slug={r.companySlug} />
                    </TD>
                    <TD className="font-mono text-xs">{r.paymentReceipt}</TD>
                    <TD className="whitespace-nowrap">{inr(r.amountMinor)}</TD>
                    <TD className="text-sm">
                      <Badge tone={REFUND_TONE[r.status]}>
                        {PLAN_PAYMENT_REFUND_STATUS_LABELS[r.status]}
                      </Badge>
                      {r.processedAt ? (
                        <span className="block text-xs text-muted-foreground">
                          Refunded <Utc at={r.processedAt} />
                        </span>
                      ) : r.failedAt ? (
                        <span className="block text-xs text-muted-foreground">
                          Failed <Utc at={r.failedAt} />
                        </span>
                      ) : r.submittedAt ? (
                        <span className="block text-xs text-muted-foreground">
                          Sent <Utc at={r.submittedAt} />
                        </span>
                      ) : null}
                      {r.lastError ? (
                        <span className="block break-words text-xs text-muted-foreground">
                          {r.lastError}
                        </span>
                      ) : null}
                    </TD>
                    <TD className="min-w-48 break-words text-sm">
                      {r.origin === 'razorpay' ? (
                        <span className="text-muted-foreground">Made at Razorpay</span>
                      ) : (
                        r.reason
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <div className="flex justify-end gap-3 text-sm">
            {refundsCursor ? (
              <Link
                href={href(view, requestsCursor, undefined)}
                className="text-primary underline-offset-4 hover:underline"
              >
                Newest refunds
              </Link>
            ) : null}
            {refunds.nextCursor ? (
              <Link
                href={href(view, requestsCursor, refunds.nextCursor)}
                className="text-primary underline-offset-4 hover:underline"
              >
                Older refunds
              </Link>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
