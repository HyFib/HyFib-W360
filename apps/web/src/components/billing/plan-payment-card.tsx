import Link from 'next/link';
import { displayMoney } from '@w360/core';
import {
  CARD_MANDATE_FRICTIONLESS_MAX_MINOR,
  PLAN_INTERVAL_LABELS,
  PLAN_PAYMENT_UNAVAILABLE_TEXT,
  PLAN_SUBSCRIPTION_STATUS_LABELS,
  RECENT_SIGN_IN_MINUTES,
  type PlanPaymentOverview,
  type PlanPaymentUnavailable,
  type PlanSubscriptionStatus,
} from '@w360/domain';
import {
  Alert,
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
import { SignInAgain } from '@/components/sign-in-again';
import { formatDate } from '@/lib/format';
import { CancelPlanSubscription, PayForPlan } from './plan-payment';
import { planWithAddOns } from './plan-words';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';
const STATUS_TONE: Record<PlanSubscriptionStatus, Tone> = {
  creating: 'neutral',
  created: 'info',
  authenticated: 'info',
  active: 'success',
  pending: 'warning',
  halted: 'danger',
  paused: 'warning',
  cancelled: 'neutral',
  completed: 'neutral',
  expired: 'neutral',
  failed: 'neutral',
};
const LIVE: readonly PlanSubscriptionStatus[] = [
  'creating',
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'paused',
];
/** Reasons worth explaining; the others (not offered, complimentary, a period HyFib set) are quiet. */
const EXPLAINED: readonly PlanPaymentUnavailable[] = [
  'plan_not_published',
  'add_on_not_sold',
  'too_large',
];

const every = (months: number) =>
  months === 1 ? 'every month' : months === 3 ? 'every three months' : 'every year';

/**
 * Paying for the plan with a Razorpay subscription (ADR-063): the price with add-ons and tax, the
 * subscription and its state, the plan payments, and paying or cancelling for billing managers.
 * Nothing is shown when there is nothing to pay or know.
 */
export function PlanPaymentCard({
  slug,
  payment,
  canManage,
  recentSignIn,
  timeZone,
}: {
  slug: string;
  payment: PlanPaymentOverview;
  canManage: boolean;
  recentSignIn: boolean;
  timeZone: string;
}) {
  const { offer, subscription, next, payments } = payment;
  const explain = !offer.available && EXPLAINED.includes(offer.reason);
  if (!offer.available && !subscription && payments.length === 0 && !explain) return null;
  const day = (at: Date | null) => formatDate(at, timeZone);
  const live = subscription !== null && LIVE.includes(subscription.status);
  const signInFirst = (what: string) => (
    <SignInAgain
      reason={`${what} needs a sign-in within the last ${RECENT_SIGN_IN_MINUTES} minutes.`}
    />
  );

  return (
    <Card role="region" aria-labelledby="plan-payment-title">
      <CardHeader>
        <CardTitle id="plan-payment-title">Paying for your plan</CardTitle>
        <CardDescription>
          Pay for your plan through Razorpay: a subscription charges the same amount at the start of
          each billing period until it is cancelled. Razorpay emails the payer about each charge.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {subscription ? (
          <div className="grid gap-3 rounded-md border border-border p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                Subscription: {inr(subscription.amountMinor)}{' '}
                {PLAN_INTERVAL_LABELS[subscription.intervalMonths] ?? ''}
              </span>
              <Badge tone={STATUS_TONE[subscription.status]}>
                {PLAN_SUBSCRIPTION_STATUS_LABELS[subscription.status]}
              </Badge>
            </div>
            <p className="text-muted-foreground">
              {inr(subscription.subtotalMinor)} plus {subscription.taxBp / 100}% tax (
              {inr(subscription.taxMinor)}).
              {subscription.currentEnd && subscription.status === 'active'
                ? ` Paid until ${day(subscription.currentEnd)}.`
                : ''}
              {subscription.chargeAt &&
              subscription.status === 'active' &&
              subscription.paidCount > 0 &&
              !subscription.cancelAtPeriodEnd
                ? ` Next charge on ${day(subscription.chargeAt)}.`
                : ''}
              {subscription.startsAt &&
              subscription.paidCount === 0 &&
              (subscription.status === 'authenticated' || subscription.status === 'active')
                ? subscription.firstChargeAhead
                  ? ` Razorpay charges for the first period on ${day(subscription.startsAt)}, when the trial ends; nothing is charged before then.`
                  : ` The first charge was due when the trial ended on ${day(subscription.startsAt)}; Razorpay has not confirmed it yet.`
                : ''}
            </p>
            {subscription.cancelAtPeriodEnd && live ? (
              next ? (
                <Alert tone="info" title="Ends with the paid period">
                  {next.subscription.status === 'authenticated'
                    ? `Nothing more is charged for it. On ${day(subscription.currentEnd)} your plan changes to ${next.planName}.`
                    : `Nothing more is charged for it. Your plan changes to ${next.planName} on ${day(subscription.currentEnd)} once its payment is authorised; otherwise it ends then.`}
                </Alert>
              ) : (
                <Alert tone="info" title="Cancelled">
                  {subscription.paidCount === 0
                    ? `Razorpay’s first charge is under way: if it goes through, the plan stays paid until ${day(subscription.currentEnd)}, then ends. Nothing more is charged.`
                    : `Nothing more is charged. The plan ends on ${day(subscription.currentEnd)}, at the end of the paid period.`}
                </Alert>
              )
            ) : null}
            {subscription.status === 'pending' ? (
              <Alert
                tone="warning"
                title={
                  subscription.paidCount === 0
                    ? 'The first charge failed'
                    : 'The last charge failed'
                }
              >
                Razorpay is trying again. The payer can change the card through the link in
                Razorpay’s email.
              </Alert>
            ) : null}
            {subscription.status === 'halted' ? (
              <Alert tone="danger" title="Payments have stopped">
                Razorpay could not charge the card and has stopped trying. The payer can change the
                card through the link in Razorpay’s email, or you can cancel the subscription and
                pay again.
              </Alert>
            ) : null}
            {subscription.status === 'created' && subscription.checkoutOpen ? (
              <p className="text-muted-foreground">
                {subscription.startsAt
                  ? 'Waiting for the payment method to be authorised. You can finish until '
                  : 'Waiting for the first payment. You can finish paying until '}
                {formatDate(subscription.authorizeBy, timeZone)}; after that, start again.
              </p>
            ) : null}
            {canManage && live && subscription.status === 'created' && subscription.checkoutOpen ? (
              recentSignIn ? (
                <PayForPlan
                  slug={slug}
                  label={subscription.startsAt ? 'Finish setting up payments' : 'Finish paying'}
                />
              ) : (
                signInFirst('Paying for the plan')
              )
            ) : null}
            {canManage &&
            live &&
            subscription.status !== 'creating' &&
            !subscription.cancelAtPeriodEnd ? (
              recentSignIn ? (
                <div>
                  <CancelPlanSubscription
                    slug={slug}
                    description={
                      subscription.status === 'active' &&
                      subscription.currentEnd &&
                      subscription.paidCount === 0
                        ? `Razorpay’s first charge is under way: if it goes through, the plan stays paid until ${day(subscription.currentEnd)}, then ends without grace days. Nothing more is charged.`
                        : subscription.status === 'active' && subscription.currentEnd
                          ? `Nothing more is charged. The plan stays paid until ${day(subscription.currentEnd)}, then ends without grace days.`
                          : subscription.startsAt && subscription.paidCount === 0
                            ? subscription.firstChargeAhead
                              ? `Nothing is charged, and the trial goes on until ${day(subscription.startsAt)}.`
                              : `Nothing is charged; the trial ended on ${day(subscription.startsAt)}.`
                            : 'Nothing more is charged, and the subscription ends now.'
                    }
                  />
                </div>
              ) : (
                signInFirst('Cancelling the subscription')
              )
            ) : null}
          </div>
        ) : null}

        {next?.subscription.startsAt ? (
          <div
            role="group"
            aria-label="Next subscription"
            className="grid gap-3 rounded-md border border-border p-4 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                From {day(next.subscription.startsAt)}:{' '}
                {planWithAddOns(next.planName, next.subscription)},{' '}
                {inr(next.subscription.amountMinor)}{' '}
                {PLAN_INTERVAL_LABELS[next.subscription.intervalMonths] ?? ''}
              </span>
              <Badge tone={STATUS_TONE[next.subscription.status]}>
                {PLAN_SUBSCRIPTION_STATUS_LABELS[next.subscription.status]}
              </Badge>
            </div>
            <p className="text-muted-foreground">
              {inr(next.subscription.subtotalMinor)} plus {next.subscription.taxBp / 100}% tax (
              {inr(next.subscription.taxMinor)}).{' '}
              {next.subscription.status === 'authenticated'
                ? `Authorised: Razorpay charges for the first period on ${day(next.subscription.startsAt)}, when the current paid period ends, and ${every(next.subscription.intervalMonths)} after that until you cancel.`
                : next.subscription.checkoutOpen
                  ? `Waiting for the payment method to be authorised. You can finish until ${formatDate(next.subscription.authorizeBy, timeZone)}; after that, change your plan again.`
                  : 'Not authorised in time. Change your plan again to keep it going after the paid period.'}
            </p>
            {canManage &&
            next.subscription.status === 'created' &&
            next.subscription.checkoutOpen ? (
              recentSignIn ? (
                <PayForPlan
                  slug={slug}
                  label="Authorise the new plan"
                  scheduledNotice={`Payment method authorised. Razorpay charges for ${next.planName} on ${day(next.subscription.startsAt)}; nothing is charged for it before then.`}
                />
              ) : (
                signInFirst('Authorising the new plan')
              )
            ) : null}
            {canManage &&
            (next.subscription.status === 'authenticated' ||
              (next.subscription.status === 'created' && next.subscription.checkoutOpen)) ? (
              recentSignIn ? (
                <div>
                  <CancelPlanSubscription
                    slug={slug}
                    label="Cancel the change"
                    title={`Cancel the change to ${next.planName}?`}
                    keepLabel="Keep the change"
                    description={`Nothing was charged for it. Your current subscription still ends on ${day(next.subscription.startsAt)}, so your plan ends then unless you change it again.`}
                  />
                </div>
              ) : (
                signInFirst('Cancelling the change')
              )
            ) : null}
          </div>
        ) : null}

        {offer.available ? (
          <div className="grid gap-3">
            <Table>
              <THead>
                <TR>
                  <TH>
                    For {PLAN_INTERVAL_LABELS[offer.intervalMonths]?.replace('per ', 'each ')}
                  </TH>
                  <TH className="text-right">Amount</TH>
                </TR>
              </THead>
              <TBody>
                <TR>
                  <TD>Plan</TD>
                  <TD className="text-right tabular-nums">{inr(offer.quote.planMinor)}</TD>
                </TR>
                {offer.quote.seatsMinor > 0 ? (
                  <TR>
                    <TD>Extra seats</TD>
                    <TD className="text-right tabular-nums">{inr(offer.quote.seatsMinor)}</TD>
                  </TR>
                ) : null}
                {offer.quote.numbersMinor > 0 ? (
                  <TR>
                    <TD>Extra WhatsApp numbers</TD>
                    <TD className="text-right tabular-nums">{inr(offer.quote.numbersMinor)}</TD>
                  </TR>
                ) : null}
                {offer.quote.runPacksMinor > 0 ? (
                  <TR>
                    <TD>Automation run packs</TD>
                    <TD className="text-right tabular-nums">{inr(offer.quote.runPacksMinor)}</TD>
                  </TR>
                ) : null}
                {offer.quote.apiRequestPacksMinor > 0 ? (
                  <TR>
                    <TD>API request packs</TD>
                    <TD className="text-right tabular-nums">
                      {inr(offer.quote.apiRequestPacksMinor)}
                    </TD>
                  </TR>
                ) : null}
                <TR>
                  <TD>Tax ({offer.quote.taxBp / 100}%)</TD>
                  <TD className="text-right tabular-nums">{inr(offer.quote.taxMinor)}</TD>
                </TR>
                <TR>
                  <TD className="font-medium">Total</TD>
                  <TD className="text-right font-medium tabular-nums">
                    {inr(offer.quote.totalMinor)}
                  </TD>
                </TR>
              </TBody>
            </Table>
            {offer.startsAt ? (
              <p className="text-sm text-muted-foreground">
                Razorpay’s payment window checks the payment method now; any amount taken for the
                check is refunded. Razorpay charges {inr(offer.quote.totalMinor)} on{' '}
                {day(offer.startsAt)}, when the trial ends, and {inr(offer.quote.totalMinor)}{' '}
                {every(offer.intervalMonths)} after that until you cancel. Nothing is charged for
                the plan before then.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                You pay {inr(offer.quote.totalMinor)} now in Razorpay’s payment window, and Razorpay
                charges {inr(offer.quote.totalMinor)} {every(offer.intervalMonths)} after that until
                you cancel. The paid period starts today; the rest of a trial ending within two days
                is not carried over.
              </p>
            )}
            {offer.quote.totalMinor > CARD_MANDATE_FRICTIONLESS_MAX_MINOR ? (
              <p className="text-sm text-muted-foreground">
                Charges above {inr(CARD_MANDATE_FRICTIONLESS_MAX_MINOR)} on an Indian card need the
                payer’s approval each time: their bank sends a link before every charge, as RBI’s
                card mandate rules require.
              </p>
            ) : null}
            {canManage ? (
              recentSignIn ? (
                <PayForPlan
                  slug={slug}
                  label={`Pay ${inr(offer.quote.totalMinor)} ${PLAN_INTERVAL_LABELS[offer.intervalMonths] ?? ''}${offer.startsAt ? ` from ${day(offer.startsAt)}` : ''}`}
                />
              ) : (
                signInFirst('Paying for the plan')
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                Owners and billing managers can pay for the plan.
              </p>
            )}
          </div>
        ) : explain ? (
          <Alert tone="info" title="Paying here is not possible now">
            {PLAN_PAYMENT_UNAVAILABLE_TEXT[offer.reason]}
          </Alert>
        ) : null}

        {payments.length > 0 ? (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Paid</TH>
                  <TH>Period</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Method</TH>
                  <TH>
                    <span className="sr-only">Receipt</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {payments.map((p) => (
                  <TR key={p.id}>
                    <TD>{day(p.paidAt)}</TD>
                    <TD>
                      {day(p.periodStart)} to {day(p.periodEnd)}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {inr(p.amountMinor)}
                      {p.refundedMinor > 0 ? (
                        <span className="block text-xs text-muted-foreground">
                          {inr(p.refundedMinor)} refunded
                        </span>
                      ) : null}
                      {p.openRefundMinor !== null ? (
                        <span className="block text-xs text-muted-foreground">
                          Refund of {inr(p.openRefundMinor)} in progress
                        </span>
                      ) : null}
                    </TD>
                    <TD>{p.method ?? '—'}</TD>
                    <TD className="whitespace-nowrap">
                      <Link
                        href={`/c/${slug}/billing/plan-payments/${p.id}`}
                        className="text-sm text-primary underline-offset-4 hover:underline"
                      >
                        Receipt<span className="sr-only"> for {day(p.paidAt)}</span>
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <p className="text-xs text-muted-foreground">
              To ask HyFib for a refund of a plan payment, open its receipt.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
