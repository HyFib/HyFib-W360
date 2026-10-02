import type { Metadata } from 'next';
import Link from 'next/link';
import { displayMoney } from '@w360/core';
import {
  CREDIT_REFUND_STATUS_LABELS,
  REFUND_REQUEST_STATUS_LABELS,
  type CreditRefundStatus,
  type PlatformRefundRequest,
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
import { PlanRefundsSections } from '@/components/platform/plan-refunds';
import { RefundRequestDecision } from '@/components/platform/refund-request-decision';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Refunds · Platform' };
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

const VIEWS = [
  { key: 'open', label: 'Waiting for a decision' },
  { key: 'decided', label: 'Decided' },
  { key: 'all', label: 'All requests' },
] as const;
type View = (typeof VIEWS)[number]['key'];

const KINDS = [
  { key: 'credit', label: 'Service credit' },
  { key: 'plan', label: 'Plan payments' },
] as const;
type Kind = (typeof KINDS)[number]['key'];

const REQUEST_TONE: Record<
  PlatformRefundRequest['status'],
  'info' | 'success' | 'danger' | 'neutral'
> = {
  open: 'info',
  approved: 'success',
  declined: 'danger',
  withdrawn: 'neutral',
};

const REFUND_TONE: Record<CreditRefundStatus, 'info' | 'success' | 'danger'> = {
  requested: 'info',
  submitted: 'info',
  processed: 'success',
  failed: 'danger',
};

function param(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The page's URL with the given list positions (each list pages on its own cursor). */
function pageHref(
  kind: Kind,
  view: string,
  requests: string | undefined,
  refunds: string | undefined,
): string {
  const query = new URLSearchParams();
  if (kind !== 'credit') query.set('kind', kind);
  if (view !== 'open') query.set('view', view);
  if (requests) query.set('cursor', requests);
  if (refunds) query.set('refunds', refunds);
  const text = query.toString();
  return text ? `/platform/refunds?${text}` : '/platform/refunds';
}

/**
 * Refunds across companies, of unused service credit (ADR-073) or of plan payments (ADR-104): the
 * requests companies made, which platform owners approve or decline, and every refund, staff-started,
 * answering a request or (for plan payments) made at Razorpay. Payments to HyFib only; no company
 * content.
 */
export default async function PlatformRefundsPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string | string[];
    view?: string | string[];
    cursor?: string | string[];
    refunds?: string | string[];
  }>;
}) {
  const actor = await requirePlatformActor();
  const query = await searchParams;
  const kind: Kind = KINDS.find((k) => k.key === param(query.kind))?.key ?? 'credit';
  const view: View = VIEWS.find((v) => v.key === param(query.view))?.key ?? 'open';
  const requestsCursor = param(query.cursor);
  const refundsCursor = param(query.refunds);
  const { platformBilling, clock } = await getRuntime();
  const isOwner = actor.role === 'platform_owner';
  // Razorpay may fail a normal refund of a payment older than 6 months (R-077).
  const sixMonthsAgo = new Date(clock.now());
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
  const header = (
    <div className="grid gap-1">
      <Link href="/platform" className="text-sm text-primary underline-offset-4 hover:underline">
        ← Platform administration
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Refunds</h1>
      <p className="text-sm text-muted-foreground">
        Refunds of unused service credit and of plan payments. A company’s billing managers ask from
        a payment’s receipt; a platform owner approves, which refunds the amount through Razorpay as
        a refund from the company’s page does, or declines with a note the company reads. Platform
        owners are emailed when requests arrive.
      </p>
      <nav className="mt-2 flex flex-wrap gap-4 text-sm" aria-label="Refunds of">
        {KINDS.map((k) =>
          k.key === kind ? (
            <span key={k.key} className="font-medium" aria-current="page">
              {k.label}
            </span>
          ) : (
            <Link
              key={k.key}
              href={pageHref(k.key, 'open', undefined, undefined)}
              className="text-primary underline-offset-4 hover:underline"
            >
              {k.label}
            </Link>
          ),
        )}
      </nav>
    </div>
  );

  if (kind === 'plan') {
    const [planRequests, planRefunds] = await Promise.all([
      platformBilling.planRefundRequests(actor, { status: view, cursor: requestsCursor }),
      platformBilling.planPaymentRefunds(actor, { cursor: refundsCursor }),
    ]);
    return (
      <div className="grid grid-cols-1 gap-6">
        {header}
        <PlanRefundsSections
          views={VIEWS}
          view={view}
          requests={planRequests}
          refunds={planRefunds}
          requestsCursor={requestsCursor}
          refundsCursor={refundsCursor}
          isOwner={isOwner}
          sixMonthsAgo={sixMonthsAgo}
          href={(v, requestsAt, refundsAt) => pageHref('plan', v, requestsAt, refundsAt)}
        />
      </div>
    );
  }

  const [requests, refunds] = await Promise.all([
    platformBilling.refundRequests(actor, { status: view, cursor: requestsCursor }),
    platformBilling.creditRefunds(actor, { cursor: refundsCursor }),
  ]);

  return (
    <div className="grid grid-cols-1 gap-6">
      {header}
      <Card>
        <CardHeader>
          <CardTitle>Requests from companies</CardTitle>
          <CardDescription>
            Approving checks everything again: what is left of the payment, the company’s unused
            credit now, a refund already in progress and a company being deleted. A request that no
            longer fits is refused with the reason and stays open, to decline with a note.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <nav className="flex flex-wrap gap-4 text-sm" aria-label="Requests to show">
            {VIEWS.map((v) =>
              v.key === view ? (
                <span key={v.key} className="font-medium" aria-current="page">
                  {v.label}
                </span>
              ) : (
                <Link
                  key={v.key}
                  href={pageHref('credit', v.key, undefined, refundsCursor)}
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
              description="Companies ask for refunds of unused credit from their payment receipts."
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
                  const left = r.topupAmountMinor - r.topupRefundedMinor;
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
                        <span className="font-mono text-xs">{r.topupReceipt}</span>
                        <span className="block whitespace-nowrap">
                          {inr(r.topupAmountMinor)}
                          {r.topupRefundedMinor > 0
                            ? ` (${inr(r.topupRefundedMinor)} refunded)`
                            : ''}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Paid <Utc at={r.topupPaidAt} />
                        </span>
                        {r.topupPaidAt && r.topupPaidAt < sixMonthsAgo ? (
                          <span className="block text-xs text-warning">
                            Over 6 months ago: Razorpay may fail a normal refund.
                          </span>
                        ) : null}
                      </TD>
                      <TD className="text-sm">
                        <span className="whitespace-nowrap font-medium">{inr(r.amountMinor)}</span>
                        {r.status === 'open' ? (
                          <>
                            <span className="block text-xs text-muted-foreground">
                              {inr(Math.max(left, 0))} left of the payment
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {r.availableMinor === null
                                ? 'No wallet'
                                : `${inr(r.availableMinor)} unused credit now`}
                            </span>
                          </>
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
                        {r.creditRefundStatus ? (
                          <span className="block text-xs text-muted-foreground">
                            Refund: {CREDIT_REFUND_STATUS_LABELS[r.creditRefundStatus]}
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
                href={pageHref('credit', view, undefined, refundsCursor)}
                className="text-primary underline-offset-4 hover:underline"
              >
                Newest requests
              </Link>
            ) : null}
            {requests.nextCursor ? (
              <Link
                href={pageHref('credit', view, requests.nextCursor, refundsCursor)}
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
          <CardTitle>All refunds of service credit</CardTitle>
          <CardDescription>
            Every refund across companies, newest first: started from a company’s page or approving
            a request. A refund reserves the credit at once; Razorpay returns the money to where it
            came from, usually in 5–7 working days.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {refunds.items.length === 0 ? (
            <EmptyState
              title="No refunds"
              description="Refunds of unused service credit appear here."
            />
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
                    <TD className="font-mono text-xs">{r.topupReceipt}</TD>
                    <TD className="whitespace-nowrap">{inr(r.amountMinor)}</TD>
                    <TD className="text-sm">
                      <Badge tone={REFUND_TONE[r.status]}>
                        {CREDIT_REFUND_STATUS_LABELS[r.status]}
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
                    <TD className="min-w-48 break-words text-sm">{r.reason}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <div className="flex justify-end gap-3 text-sm">
            {refundsCursor ? (
              <Link
                href={pageHref('credit', view, requestsCursor, undefined)}
                className="text-primary underline-offset-4 hover:underline"
              >
                Newest refunds
              </Link>
            ) : null}
            {refunds.nextCursor ? (
              <Link
                href={pageHref('credit', view, requestsCursor, refunds.nextCursor)}
                className="text-primary underline-offset-4 hover:underline"
              >
                Older refunds
              </Link>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
