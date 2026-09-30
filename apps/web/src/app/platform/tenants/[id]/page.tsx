import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { displayMoney } from '@w360/core';
import {
  API_SCOPE_INFO,
  dayOf,
  DELETION_GRACE_DAYS,
  STAFF_DELETION_REASON,
  PLAN_INTERVAL_LABELS,
  PLAN_MODULE_KEYS,
  PLAN_MODULE_LABELS,
  PLAN_SUBSCRIPTION_STATUS_LABELS,
  TENANT_PLAN_STATUS_LABELS,
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
import {
  CancelTenantSubscriptionForm,
  TenantPlanForm,
  type AssignablePlanOption,
} from '@/components/platform/plan-forms';
import {
  MfaResetForm,
  SupportGrantForm,
  TenantStatusForm,
} from '@/components/platform/platform-forms';
import {
  CancelStaffDeletionForm,
  ScheduleDeletionForm,
} from '@/components/platform/deletion-forms';
import { IssueList, LevelBadge, Utc } from '@/components/platform/ops';
import { ServiceCredit } from '@/components/platform/service-credit';
import { formatDate, formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Company · Platform' };
export const dynamic = 'force-dynamic';

export default async function PlatformTenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requirePlatformActor();
  const { platform, planAdmin, platformOps, platformBilling, clock } = await getRuntime();
  const company = await platform.getTenant(actor, id);
  if (!company) notFound();
  const [owners, planView, published, ops, deletion, credit] = await Promise.all([
    platform.tenantOwners(actor, id),
    planAdmin.tenantPlan(actor, id),
    planAdmin.assignablePlans(actor),
    platformOps.companyHealth(actor, id),
    platform.tenantDeletion(actor, id),
    platformBilling.companyBilling(actor, id),
  ]);
  const { state, usage, limits } = planView;
  const waitsForRefund = Boolean(
    deletion &&
    !deletion.startedAt &&
    !deletion.cancelledAt &&
    deletion.dueAt.getTime() <= clock.now().getTime() &&
    credit.refunds.some((r) => r.status === 'requested' || r.status === 'submitted'),
  );
  const openDeletion = Boolean(deletion && !deletion.cancelledAt && !deletion.completedAt);
  const reasonLimits = { min: STAFF_DELETION_REASON.min, max: STAFF_DELETION_REASON.max };
  const tz = planView.timezone;
  const option = (p: (typeof published)[number] | NonNullable<typeof planView.plan>) => ({
    id: p.id,
    label: `${p.name} (${p.code} v${p.version})${p.status === 'retired' ? ' · retired, kept' : ''}`,
    trialDays: p.trialDays,
    intervalMonths: p.intervalMonths,
    sellsSeats: p.seatPriceMinor !== null,
    sellsNumbers: p.numberPriceMinor !== null,
    sellsRunPacks: p.runPackSize !== null,
  });
  const options: AssignablePlanOption[] = published.map(option);
  if (planView.plan && !options.some((o) => o.id === planView.plan?.id))
    options.unshift(option(planView.plan));
  const used = (n: number, max: number | null) =>
    max === null ? `${n} (no limit)` : `${n} of ${max}`;
  return (
    <div className="grid gap-6">
      <Link href="/platform" className="text-sm text-primary underline-offset-4 hover:underline">
        ← All companies
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{company.name}</h1>
        <Badge tone={company.status === 'active' ? 'success' : 'warning'}>{company.status}</Badge>
        {company.planStatus ? (
          <Badge tone="info">{TENANT_PLAN_STATUS_LABELS[company.planStatus]}</Badge>
        ) : null}
      </div>
      {company.statusReason ? (
        <p className="text-sm text-muted-foreground">Last status reason: {company.statusReason}</p>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-2">
        {deletion ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>Deletion</CardTitle>
                <Badge
                  tone={
                    deletion.completedAt
                      ? 'neutral'
                      : deletion.cancelledAt
                        ? 'info'
                        : deletion.startedAt
                          ? 'danger'
                          : 'warning'
                  }
                >
                  {deletion.completedAt
                    ? 'Deleted'
                    : deletion.cancelledAt
                      ? 'Cancelled'
                      : deletion.startedAt
                        ? 'Deleting'
                        : 'Scheduled'}
                </Badge>
              </div>
              <CardDescription>
                {deletion.requestedBy === 'platform'
                  ? 'Scheduled by HyFib staff (ADR-090): platform owners can cancel it until it starts; owners cannot.'
                  : 'Asked for by an owner (ADR-055): owners can cancel it until it starts; staff cannot.'}{' '}
                Nobody can speed it up.
                {waitsForRefund
                  ? ' It is due and waits for the refund of service credit in progress (ADR-058).'
                  : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
              <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Requested</dt>
                  <dd>
                    <Utc at={deletion.requestedAt} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Due</dt>
                  <dd>
                    <Utc at={deletion.dueAt} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {deletion.cancelledAt ? 'Cancelled' : 'Started'}
                  </dt>
                  <dd>
                    <Utc at={deletion.cancelledAt ?? deletion.startedAt} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Finished</dt>
                  <dd>
                    <Utc at={deletion.completedAt} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Status before the request</dt>
                  <dd>{deletion.previousStatus}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Runs</dt>
                  <dd>{deletion.attempts}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Rows deleted</dt>
                  <dd>{deletion.rowsDeleted}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Providers visited</dt>
                  <dd>
                    <Utc at={deletion.providerCleanupAt} />
                  </dd>
                </div>
              </dl>
              {deletion.providerCleanup.length > 0 ? (
                <ul className="grid gap-1">
                  {deletion.providerCleanup.map((item, index) => (
                    <li key={index} className="flex flex-wrap items-center gap-2">
                      <Badge
                        tone={
                          item.outcome === 'done'
                            ? 'success'
                            : item.outcome === 'failed'
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {item.outcome}
                      </Badge>
                      <span className="min-w-0 break-words">{item.label}</span>
                      {item.code ? (
                        <code className="text-xs text-muted-foreground">{item.code}</code>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : deletion.providerCleanupAt ? (
                <p className="text-muted-foreground">No provider connections to remove.</p>
              ) : null}
              {deletion.reason ? (
                <p className="whitespace-pre-line break-words">
                  <span className="font-medium">Reason the company was given:</span>{' '}
                  {deletion.reason}
                </p>
              ) : null}
              {deletion.cancelledAt ? (
                <p className="whitespace-pre-line break-words">
                  <span className="font-medium">
                    Cancelled by {deletion.cancelledBy === 'platform' ? 'HyFib staff' : 'an owner'}
                    {deletion.cancelReason ? ':' : '.'}
                  </span>
                  {deletion.cancelReason ? ` ${deletion.cancelReason}` : ''}
                </p>
              ) : null}
              {deletion.requestedBy === 'platform' && openDeletion && !deletion.startedAt ? (
                actor.role === 'platform_owner' ? (
                  <CancelStaffDeletionForm tenantId={company.id} limits={reasonLimits} />
                ) : (
                  <p className="text-muted-foreground">Only platform owners can cancel it.</p>
                )
              ) : null}
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>Account status</CardTitle>
            <CardDescription>
              Suspension stops outbound activity; ingestion, exports, billing and owner access
              continue. A company whose plan ended is restricted the same way until its plan
              changes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TenantStatusForm tenantId={company.id} status={company.status} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Support access</CardTitle>
            <CardDescription>Grants are recorded in the company’s audit log.</CardDescription>
          </CardHeader>
          <CardContent>
            <SupportGrantForm tenantId={company.id} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Plan</CardTitle>
              <Badge
                tone={state.status === 'expired' || state.status === 'canceled' ? 'danger' : 'info'}
              >
                {TENANT_PLAN_STATUS_LABELS[state.status]}
              </Badge>
            </div>
            <CardDescription>
              {planView.plan
                ? `${planView.plan.name} (${planView.plan.code} v${planView.plan.version})`
                : 'No plan: no limits and every module.'}
              {state.status === 'trialing'
                ? ` · trial until ${formatDate(state.trialEndsAt, tz)}`
                : ''}
              {state.status === 'active' || state.status === 'past_due'
                ? ` · paid ${formatDate(state.periodStart, tz)} to ${formatDate(state.periodEnd, tz)}`
                : ''}
              {state.status === 'past_due'
                ? ` · grace until ${formatDate(state.graceEndsAt, tz)}`
                : ''}
              {planView.subscription?.live ? ' · paid by Razorpay subscription' : ''}. Periods set
              here are for payments settled outside HyFib.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 lg:grid-cols-2">
            <div className="grid content-start gap-3 text-sm">
              <dl className="grid gap-2 sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Seats</dt>
                  <dd>
                    {used(usage.members + usage.invitations, limits.seats)}
                    {usage.invitations > 0 ? ` (${usage.invitations} invitations waiting)` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">WhatsApp numbers</dt>
                  <dd>{used(usage.numbers, limits.numbers)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Teams</dt>
                  <dd>{used(usage.teams, limits.teams)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Live automations</dt>
                  <dd>{used(usage.liveAutomations, limits.liveAutomations)}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">
                    Automation runs {formatDate(usage.periodStart, tz)} to{' '}
                    {formatDate(usage.periodEnd, tz)}
                  </dt>
                  <dd>{used(usage.automationRuns, limits.automationRuns)}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">
                    API requests {formatDate(usage.periodStart, tz)} to{' '}
                    {formatDate(usage.periodEnd, tz)}
                  </dt>
                  <dd>
                    {limits.apiRequests === 0
                      ? 'Not in the plan'
                      : used(usage.apiRequests, limits.apiRequests)}
                  </dd>
                </div>
                {limits.apiRequests !== 0 && planView.apiScopes ? (
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">API scopes</dt>
                    <dd>{planView.apiScopes.map((s) => API_SCOPE_INFO[s].label).join(', ')}</dd>
                  </div>
                ) : null}
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Modules</dt>
                  <dd>
                    {PLAN_MODULE_KEYS.filter((m) => planView.modules.includes(m))
                      .map((m) => PLAN_MODULE_LABELS[m])
                      .join(', ') || 'Only the modules every plan has'}
                  </dd>
                </div>
              </dl>
              {state.note ? (
                <p className="text-muted-foreground">
                  Last change {formatDateTime(state.changedAt, tz)}: {state.note}
                </p>
              ) : null}
            </div>
            {planView.subscription?.live ? (
              <Alert tone="info" title="Paid by Razorpay subscription">
                Plan changes wait until the subscription is cancelled (below), so a company is never
                charged for a plan it is no longer on.
              </Alert>
            ) : (
              <TenantPlanForm
                tenantId={company.id}
                version={state.version}
                today={dayOf(new Date(), tz)}
                current={{
                  status: state.status,
                  planId: state.planId,
                  trialEndsOn: state.trialEndsAt ? dayOf(state.trialEndsAt, tz) : '',
                  periodStart: state.periodStart ? dayOf(state.periodStart, tz) : '',
                  periodEnd: state.periodEnd ? dayOf(state.periodEnd, tz) : '',
                  extraSeats: state.extraSeats,
                  extraNumbers: state.extraNumbers,
                  runPacks: state.runPacks,
                }}
                options={options}
              />
            )}
          </CardContent>
        </Card>
        {planView.subscription || planView.payments.length > 0 ? (
          <Card className="lg:col-span-2" role="region" aria-labelledby="plan-subscription-title">
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle id="plan-subscription-title">Plan subscription</CardTitle>
                {planView.subscription ? (
                  <Badge tone={planView.subscription.live ? 'info' : 'neutral'}>
                    {PLAN_SUBSCRIPTION_STATUS_LABELS[planView.subscription.status]}
                  </Badge>
                ) : null}
              </div>
              <CardDescription>
                The company pays for its plan through Razorpay (ADR-063). HyFib follows what
                Razorpay reports; the paid period is set from the cycle Razorpay charged.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
              {planView.subscription ? (
                <dl className="grid gap-2 sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">Charge</dt>
                    <dd>
                      {displayMoney(BigInt(planView.subscription.amountMinor), 'INR')}{' '}
                      {PLAN_INTERVAL_LABELS[planView.subscription.intervalMonths] ?? ''} (tax{' '}
                      {planView.subscription.taxBp / 100}%)
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Current cycle</dt>
                    <dd>
                      {planView.subscription.currentStart && planView.subscription.currentEnd
                        ? `${formatDate(planView.subscription.currentStart, tz)} to ${formatDate(planView.subscription.currentEnd, tz)}`
                        : '—'}
                      {planView.subscription.cancelAtPeriodEnd ? ' · cancelled at its end' : ''}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Razorpay subscription</dt>
                    <dd className="break-all font-mono text-xs">
                      {planView.subscription.providerSubscriptionId ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Last checked with Razorpay</dt>
                    <dd>
                      {planView.subscription.syncedAt
                        ? formatDateTime(planView.subscription.syncedAt, tz)
                        : '—'}
                    </dd>
                  </div>
                  {planView.subscription.failureReason ? (
                    <div className="sm:col-span-2">
                      <dt className="text-muted-foreground">Note</dt>
                      <dd>{planView.subscription.failureReason}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
              {planView.payments.length > 0 ? (
                <Table>
                  <THead>
                    <TR>
                      <TH>Paid</TH>
                      <TH>Period</TH>
                      <TH className="text-right">Amount</TH>
                      <TH>Payment</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {planView.payments.map((p) => (
                      <TR key={p.id}>
                        <TD>{formatDate(p.paidAt, tz)}</TD>
                        <TD>
                          {formatDate(p.periodStart, tz)} to {formatDate(p.periodEnd, tz)}
                        </TD>
                        <TD className="text-right tabular-nums">
                          {displayMoney(BigInt(p.amountMinor), 'INR')}
                        </TD>
                        <TD className="font-mono text-xs">{p.providerPaymentId}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : null}
              {planView.subscription?.live ? (
                actor.role === 'platform_owner' ? (
                  <CancelTenantSubscriptionForm tenantId={company.id} />
                ) : (
                  <p className="text-muted-foreground">
                    Only platform owners can cancel a company’s subscription.
                  </p>
                )
              ) : null}
            </CardContent>
          </Card>
        ) : null}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Service credit</CardTitle>
            <CardDescription>
              Payments to HyFib and refunds of unused credit (ADR-058). A refund reserves the credit
              at once; Razorpay returns the money to where it came from, usually in 5–7 working
              days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ServiceCredit
              tenantId={company.id}
              billing={credit}
              refundBlocked={
                actor.role !== 'platform_owner'
                  ? 'Only platform owners can refund service credit.'
                  : company.status === 'pending_deletion' || company.status === 'deleted'
                    ? 'The company is being deleted, so refunds are not started here. Refund the payment in the Razorpay Dashboard; HyFib records it from Razorpay’s refund event.'
                    : null
              }
            />
          </CardContent>
        </Card>
        {ops ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>Health</CardTitle>
                <LevelBadge level={ops.health.level} />
              </div>
              <CardDescription>
                Counts and states only (ADR-054).{' '}
                <Link
                  href="/platform/ops"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Operations
                </Link>
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm lg:grid-cols-2">
              <div className="grid content-start gap-3">
                {ops.health.issues.length > 0 ? (
                  <IssueList issues={ops.health.issues} />
                ) : (
                  <p className="text-muted-foreground">No issues found.</p>
                )}
                <dl className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">WhatsApp numbers</dt>
                    <dd>
                      {ops.health.facts.numbersActive} active of {ops.health.facts.numbersTotal}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Worst quality rating</dt>
                    <dd>
                      {ops.health.facts.qualityRating ?? 'Not rated'}
                      {ops.health.facts.qualityCheckedAt ? (
                        <div className="text-xs text-muted-foreground">
                          checked <Utc at={ops.health.facts.qualityCheckedAt} />
                        </div>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Last 24 hours</dt>
                    <dd>
                      {ops.health.facts.outbound24h} sent, {ops.health.facts.failed24h} failed,{' '}
                      {ops.health.facts.inbound24h} received
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Last message</dt>
                    <dd>
                      <Utc at={ops.health.facts.lastMessageAt} />
                    </dd>
                  </div>
                </dl>
              </div>
              {ops.activity ? (
                <dl className="grid content-start gap-2 sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Sent in 30 days</dt>
                    <dd>{ops.activity.outbound}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Received in 30 days</dt>
                    <dd>{ops.activity.inbound}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Marketing opt-outs in 30 days</dt>
                    <dd>{ops.activity.marketingOptOuts}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Webhook deliveries in 30 days</dt>
                    <dd>{ops.activity.webhookDeliveries}</dd>
                  </div>
                </dl>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
        {!openDeletion && ['active', 'suspended', 'restricted'].includes(company.status) ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Delete the company</CardTitle>
              <CardDescription>
                For a company that asked HyFib to delete it, or whose service HyFib ends (ADR-090).
                It is deleted {DELETION_GRACE_DAYS} days later by the same job as an owner’s
                request; until then it works as if suspended and its owners can export its data. The
                owners and administrators are emailed the reason. Only platform owners can schedule
                or cancel it; nobody can speed it up.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {actor.role === 'platform_owner' ? (
                <ScheduleDeletionForm
                  tenantId={company.id}
                  slug={company.slug}
                  limits={reasonLimits}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Only platform owners can schedule a deletion.
                </p>
              )}
            </CardContent>
          </Card>
        ) : null}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Owners and account recovery</CardTitle>
            <CardDescription>
              Reset two-factor only after verifying identity through a separate channel.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {owners.map((o) => (
              <div key={o.userId} className="grid gap-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{o.name}</span>
                  <Badge>{o.status}</Badge>
                  <Badge tone={o.twoFactorEnabled ? 'success' : 'warning'}>
                    {o.twoFactorEnabled ? 'Two-factor on' : 'No two-factor'}
                  </Badge>
                </div>
                {o.userId !== actor.userId ? (
                  <MfaResetForm userId={o.userId} name={o.name} />
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
