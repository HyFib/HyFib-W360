import type { Metadata } from 'next';
import { displayMoney } from '@w360/core';
import { assertCan, can, MANDATE_MAX_MINOR, type BillingOverview } from '@w360/domain';
import {
  Alert,
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
import { AddCredit } from '@/components/billing/add-credit';
import { AutoRechargeForm } from '@/components/billing/auto-recharge-form';
import { CardMandateSetup, RemoveCard } from '@/components/billing/card-mandate';
import { PageHeader } from '@/components/page-header';
import { RequireOwnDocument } from '@/components/require-own-document';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Billing' };
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

const TOPUP_STATUS: Record<string, { label: string; tone: Tone }> = {
  creating: { label: 'Starting', tone: 'neutral' },
  awaiting_payment: { label: 'Awaiting payment', tone: 'info' },
  paid: { label: 'Paid', tone: 'success' },
  partially_refunded: { label: 'Partly refunded', tone: 'warning' },
  refunded: { label: 'Refunded', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
};

const ATTEMPT_STATUS: Record<string, { label: string; tone: Tone }> = {
  scheduled: { label: 'Starting', tone: 'info' },
  order_created: { label: 'Starting', tone: 'info' },
  payment_requested: { label: 'Bank processing', tone: 'info' },
  unknown: { label: 'Checking with Razorpay', tone: 'warning' },
  succeeded: { label: 'Added', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Stopped', tone: 'neutral' },
};

const MANDATE_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_authorization: { label: 'Waiting for authorisation', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused by your bank', tone: 'warning' },
};

const TRANSACTION_LABEL: Record<string, string> = {
  topup_credit: 'Credit added',
  hold: 'Reserved for a service',
  hold_release: 'Reservation released',
  hold_settle: 'Service charge',
  refund: 'Refund to card',
  dispute_loss: 'Chargeback',
};

function signed(paise: number): string {
  if (paise === 0) return '—';
  return paise > 0 ? `+${inr(paise)}` : `−${inr(-paise)}`;
}

function defaultsFor(overview: BillingOverview) {
  return (
    overview.autoRecharge ?? {
      enabled: false,
      thresholdMinor: 50_000,
      amountMinor: 200_000,
      dailyCapMinor: 400_000,
      monthlyCapMinor: 1_000_000,
    }
  );
}

export default async function BillingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'billing.read');
  const { billing } = await getRuntime();
  const overview = await billing.overview(ctx);
  const canManage = can(ctx, 'billing.manage');
  const { payments, wallet, mandate } = overview;
  const tz = ctx.tenant.timezone;
  const activeMandate = mandate?.status === 'active' ? mandate : null;

  return (
    <>
      <RequireOwnDocument />
      <PageHeader
        title="Billing"
        description="Prepaid service credit for HyFib W360 services. Meta bills your WhatsApp account directly for conversations."
      />
      <div className="grid gap-6">
        {!payments.configured ? (
          <Alert tone="warning" title="Card payments are not available yet">
            This platform has not connected its Razorpay account, so credit cannot be added.
          </Alert>
        ) : payments.mode === 'test' ? (
          <Alert tone="info" title="Test mode">
            Payments use Razorpay test mode. No real money moves.
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Service credit</CardTitle>
            <CardDescription>
              Credit is added only after Razorpay confirms the payment was captured.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-md border border-border p-4">
                <dt className="text-sm text-muted-foreground">Available</dt>
                <dd
                  className={`text-2xl font-semibold ${wallet.availableMinor < 0 ? 'text-destructive' : ''}`}
                >
                  {inr(wallet.availableMinor)}
                </dd>
              </div>
              <div className="rounded-md border border-border p-4">
                <dt className="text-sm text-muted-foreground">Reserved for running services</dt>
                <dd className="text-2xl font-semibold">{inr(wallet.heldMinor)}</dd>
              </div>
            </dl>
            {wallet.availableMinor < 0 ? (
              <Alert tone="danger" title="Your balance is negative">
                A refund or chargeback exceeded your remaining credit. Add credit to use billable
                services again.
              </Alert>
            ) : null}
            {canManage && payments.configured ? <AddCredit slug={ctx.tenant.slug} /> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Auto-recharge</CardTitle>
            <CardDescription>
              Optional. A saved card is charged when credit runs low, within the limits you set.
              Card charges complete one to three days after they are requested.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {!payments.recurringCardsEnabled ? (
              <Alert tone="warning" title="Not available yet">
                Auto-recharge needs Razorpay to enable card mandates (Recurring Payments) for this
                platform. You can add credit manually meanwhile.
              </Alert>
            ) : null}
            {mandate ? (
              <div className="flex flex-wrap items-start justify-between gap-4 rounded-md border border-border p-4">
                <div className="grid gap-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {mandate.cardNetwork ?? 'Card'}
                      {mandate.cardLast4 ? ` •••• ${mandate.cardLast4}` : ''}
                    </span>
                    <Badge tone={MANDATE_STATUS[mandate.status]?.tone ?? 'neutral'}>
                      {MANDATE_STATUS[mandate.status]?.label ?? mandate.status}
                    </Badge>
                  </div>
                  {mandate.cardExpiryMonth && mandate.cardExpiryYear ? (
                    <span className="text-muted-foreground">
                      Expires {String(mandate.cardExpiryMonth).padStart(2, '0')}/
                      {mandate.cardExpiryYear}
                    </span>
                  ) : null}
                  <span className="text-muted-foreground">
                    Up to {inr(mandate.maxAmountMinor)} per charge
                  </span>
                </div>
                {canManage && payments.configured ? (
                  <RemoveCard slug={ctx.tenant.slug} mandateId={mandate.id} />
                ) : null}
              </div>
            ) : canManage && payments.configured && payments.recurringCardsEnabled ? (
              <CardMandateSetup
                slug={ctx.tenant.slug}
                defaultEmail={overview.billingContact?.email ?? ctx.user.email}
                defaultContact={overview.billingContact?.contact ?? ''}
              />
            ) : null}
            {canManage && payments.recurringCardsEnabled ? (
              <AutoRechargeForm
                slug={ctx.tenant.slug}
                initial={defaultsFor(overview)}
                canEnable={Boolean(activeMandate)}
              />
            ) : overview.autoRecharge ? (
              <p className="text-sm text-muted-foreground">
                Auto-recharge is {overview.autoRecharge.enabled ? 'on' : 'off'}: add{' '}
                {inr(overview.autoRecharge.amountMinor)} when credit falls below{' '}
                {inr(overview.autoRecharge.thresholdMinor)}.
              </p>
            ) : null}
            {overview.attempts.length > 0 ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Requested</TH>
                    <TH>Amount</TH>
                    <TH>Status</TH>
                    <TH>Details</TH>
                  </TR>
                </THead>
                <TBody>
                  {overview.attempts.map((a) => (
                    <TR key={a.id}>
                      <TD className="whitespace-nowrap">
                        {formatDateTime(a.createdAt.toISOString(), tz)}
                      </TD>
                      <TD>{inr(a.amountMinor)}</TD>
                      <TD>
                        <Badge tone={ATTEMPT_STATUS[a.status]?.tone ?? 'neutral'}>
                          {ATTEMPT_STATUS[a.status]?.label ?? a.status}
                        </Badge>
                      </TD>
                      <TD className="text-xs text-muted-foreground">
                        {a.status === 'failed' || a.status === 'canceled'
                          ? (a.lastError ?? '')
                          : ''}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Card mandates follow RBI rules: at most {inr(MANDATE_MAX_MINOR)} per charge, your bank
              notifies you before each charge, and you can cancel the mandate with your bank at any
              time.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payments</CardTitle>
          </CardHeader>
          <CardContent>
            {overview.topups.length === 0 ? (
              <EmptyState title="No payments yet" description="Credit you add appears here." />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Started</TH>
                    <TH>Type</TH>
                    <TH>Amount</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {overview.topups.map((t) => (
                    <TR key={t.id}>
                      <TD className="whitespace-nowrap">
                        {formatDateTime(t.createdAt.toISOString(), tz)}
                      </TD>
                      <TD>{t.kind === 'manual' ? 'Card payment' : 'Auto-recharge'}</TD>
                      <TD>
                        {inr(t.amountMinor)}
                        {t.refundedMinor > 0 ? (
                          <span className="block text-xs text-muted-foreground">
                            {inr(t.refundedMinor)} refunded
                          </span>
                        ) : null}
                      </TD>
                      <TD>
                        <Badge tone={TOPUP_STATUS[t.status]?.tone ?? 'neutral'}>
                          {TOPUP_STATUS[t.status]?.label ?? t.status}
                        </Badge>
                        {t.status === 'failed' && t.failureReason ? (
                          <span className="block text-xs text-muted-foreground">
                            {t.failureReason}
                          </span>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Credit history</CardTitle>
            <CardDescription>Every change to your available credit, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {overview.transactions.length === 0 ? (
              <EmptyState title="No activity yet" description="Credits and charges appear here." />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>When</TH>
                    <TH>Activity</TH>
                    <TH className="text-right">Available credit</TH>
                  </TR>
                </THead>
                <TBody>
                  {overview.transactions.map((t) => (
                    <TR key={t.id}>
                      <TD className="whitespace-nowrap">
                        {formatDateTime(t.createdAt.toISOString(), tz)}
                      </TD>
                      <TD>{TRANSACTION_LABEL[t.kind] ?? t.description ?? t.kind}</TD>
                      <TD className="text-right tabular-nums">{signed(t.availableEffectMinor)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Plans</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Subscription plans are planned and not available yet.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
