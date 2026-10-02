import { displayMoney } from '@w360/core';
import {
  API_SCOPE_INFO,
  PLAN_INTERVAL_LABELS,
  PLAN_MODULE_KEYS,
  PLAN_MODULE_LABELS,
  TENANT_PLAN_STATUS_LABELS,
  warningThreshold,
  type CompanyPlanOverview,
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
import { formatDate } from '@/lib/format';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

const STATUS_TONE = {
  complimentary: 'info',
  trialing: 'info',
  active: 'success',
  past_due: 'warning',
  expired: 'danger',
  canceled: 'danger',
} as const;

function UsageRow({
  label,
  used,
  limit,
  detail,
  monthly = false,
}: {
  label: string;
  used: number;
  limit: number | null;
  detail?: string;
  /** A monthly allowance, which warns at 80% (ADR-062). */
  monthly?: boolean;
}) {
  const share = limit === null || limit === 0 ? null : Math.min(100, (used / limit) * 100);
  const full = limit !== null && used >= limit;
  // At 80% of a monthly limit the billing managers are warned by email (ADR-062).
  const threshold = monthly ? warningThreshold(limit) : null;
  const nearly = !full && threshold !== null && used >= threshold;
  return (
    <TR>
      <TD className="font-medium">
        {label}
        {detail ? <div className="text-xs font-normal text-muted-foreground">{detail}</div> : null}
      </TD>
      <TD>
        <span
          className={
            full ? 'font-medium text-destructive' : nearly ? 'font-medium text-warning' : ''
          }
        >
          {used.toLocaleString('en-IN')}
          {limit === null ? '' : ` of ${limit.toLocaleString('en-IN')}`}
          {nearly ? ' (nearly used up)' : ''}
        </span>
        {share !== null ? (
          <div
            className="mt-1 h-1.5 w-full max-w-40 overflow-hidden rounded bg-muted"
            aria-hidden="true"
          >
            <div
              className={`h-full ${full ? 'bg-destructive' : nearly ? 'bg-warning' : 'bg-primary'}`}
              style={{ width: `${share}%` }}
            />
          </div>
        ) : null}
      </TD>
      <TD className="text-sm text-muted-foreground">
        {limit === null ? 'No limit' : full ? 'All in use' : `${limit - used} left`}
      </TD>
    </TR>
  );
}

/** The company's plan, its state and its usage on the Billing page (ADR-051). */
export function PlanCard({
  overview,
  timeZone,
  payment = null,
  next = null,
}: {
  overview: CompanyPlanOverview;
  timeZone: string;
  /** The plan the company changes to from the end of the paid period (ADR-109). */
  next?: { planName: string; startsAt: Date; authorised: boolean } | null;
  /**
   * Whether the company pays by subscription (ADR-063), has one whose payments start when the
   * trial ends (ADR-102), or can pay for its plan here.
   */
  payment?: 'subscribed' | 'from_trial_end' | 'offered' | null;
}) {
  const { plan, usage, status } = overview;
  const payHere = payment === 'offered';
  const day = (at: Date | null) => formatDate(at, timeZone);
  const runs = usage.automationRuns;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{plan ? `${plan.name} plan` : 'Plan'}</CardTitle>
          <Badge tone={STATUS_TONE[status]}>{TENANT_PLAN_STATUS_LABELS[status]}</Badge>
        </div>
        <CardDescription>
          {status === 'complimentary'
            ? 'Complimentary access from HyFib: no limits and every module.'
            : status === 'trialing'
              ? overview.trialWaitsUntil
                ? `The trial ended on ${day(overview.trialEndsAt)}. Everything keeps working while Razorpay makes the first charge, until ${day(overview.trialWaitsUntil)} at the latest.`
                : `Trial until ${day(overview.trialEndsAt)}.`
              : status === 'active' || status === 'past_due'
                ? `Paid period ${day(overview.periodStart)} to ${day(overview.periodEnd)}.`
                : 'The plan has ended.'}{' '}
          {overview.trialWaitsUntil
            ? null
            : payment === 'from_trial_end'
              ? 'Payments by subscription through Razorpay start when the trial ends.'
              : payment === 'subscribed'
                ? 'Paid by subscription through Razorpay.'
                : payHere
                  ? 'HyFib sets plans; you can pay for yours below.'
                  : 'HyFib sets plans and periods; there is nothing to pay here for the plan.'}
          {next
            ? next.authorised
              ? ` From ${day(next.startsAt)}, your plan is ${next.planName}.`
              : ` Your plan changes to ${next.planName} on ${day(next.startsAt)} once its payment is authorised.`
            : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {status === 'past_due' ? (
          <Alert tone="warning" title="The paid period has ended">
            Everything keeps working until {day(overview.graceEndsAt)}.{' '}
            {payment === 'subscribed'
              ? 'The plan is paid again once Razorpay’s charge goes through.'
              : payHere
                ? 'Pay for the plan below, or ask HyFib to renew it, before then.'
                : 'Ask HyFib to renew the plan before then.'}
          </Alert>
        ) : null}
        {status === 'expired' || status === 'canceled' ? (
          <Alert
            tone="danger"
            title={status === 'canceled' ? 'The plan was canceled' : 'The plan ended'}
          >
            Sending messages, campaigns and automations is paused. Your data is kept, and you can
            still review and export it.{' '}
            {payment === 'subscribed'
              ? 'The plan is paid once a Razorpay charge goes through (the payer can change the card through the link in Razorpay’s email), or cancel the subscription below and pay again.'
              : payHere
                ? 'Pay for the plan below, or ask HyFib to choose a plan, to continue.'
                : 'Ask HyFib to choose a plan to continue.'}
          </Alert>
        ) : null}
        {plan ? (
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div className="grid gap-1">
              <dt className="text-muted-foreground">Price</dt>
              <dd className="font-medium">
                {inr(plan.priceMinor)} {PLAN_INTERVAL_LABELS[plan.intervalMonths] ?? ''}
              </dd>
            </div>
            {plan.seatPriceMinor !== null ? (
              <div className="grid gap-1">
                <dt className="text-muted-foreground">Extra seats</dt>
                <dd>
                  {overview.addOns.extraSeats} · {inr(plan.seatPriceMinor)} each
                </dd>
              </div>
            ) : null}
            {plan.numberPriceMinor !== null ? (
              <div className="grid gap-1">
                <dt className="text-muted-foreground">Extra WhatsApp numbers</dt>
                <dd>
                  {overview.addOns.extraNumbers} · {inr(plan.numberPriceMinor)} each
                </dd>
              </div>
            ) : null}
            {plan.runPackSize !== null && plan.runPackPriceMinor !== null ? (
              <div className="grid gap-1">
                <dt className="text-muted-foreground">Automation run packs</dt>
                <dd>
                  {overview.addOns.runPacks} · {plan.runPackSize.toLocaleString('en-IN')} runs for{' '}
                  {inr(plan.runPackPriceMinor)}
                </dd>
              </div>
            ) : null}
            {plan.apiRequestPackSize !== null && plan.apiRequestPackPriceMinor !== null ? (
              <div className="grid gap-1">
                <dt className="text-muted-foreground">API request packs</dt>
                <dd>
                  {overview.addOns.apiRequestPacks} ·{' '}
                  {plan.apiRequestPackSize.toLocaleString('en-IN')} requests for{' '}
                  {inr(plan.apiRequestPackPriceMinor)}
                </dd>
              </div>
            ) : null}
            {plan.status === 'retired' ? (
              <div className="grid gap-1 sm:col-span-3">
                <dt className="sr-only">Availability</dt>
                <dd className="text-muted-foreground">
                  This plan is no longer offered to new companies; your terms stay as they are.
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Modules</h3>
          <ul className="flex flex-wrap gap-2">
            {PLAN_MODULE_KEYS.map((m) => (
              <li key={m}>
                <Badge tone={overview.modules.includes(m) ? 'success' : 'neutral'}>
                  {PLAN_MODULE_LABELS[m]}
                  {overview.modules.includes(m) ? '' : ' · not included'}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Inbox, contacts, templates, campaigns, growth tools, reports and billing are in every
            plan. Without a module you can still see what you already have in it.
          </p>
        </div>
        <Table>
          <THead>
            <TR>
              <TH>Usage</TH>
              <TH>Used</TH>
              <TH>Left</TH>
            </TR>
          </THead>
          <TBody>
            <UsageRow
              label="Seats"
              used={usage.seats.members + usage.seats.invitations}
              limit={usage.limits.seats}
              detail={
                usage.seats.invitations > 0
                  ? `${usage.seats.members} members and ${usage.seats.invitations} waiting invitations`
                  : undefined
              }
            />
            <UsageRow label="WhatsApp numbers" used={usage.numbers} limit={usage.limits.numbers} />
            <UsageRow label="Teams" used={usage.teams} limit={usage.limits.teams} />
            <UsageRow
              label="Live automations"
              used={usage.liveAutomations}
              limit={usage.limits.liveAutomations}
            />
            <UsageRow
              label="Automation runs this month"
              used={runs.used}
              limit={usage.limits.automationRuns}
              monthly
              detail={`${day(runs.periodStart)} to ${day(runs.periodEnd)}; test runs are not counted`}
            />
            {usage.limits.apiRequests === 0 ? (
              <TR>
                <TD className="font-medium">API requests this month</TD>
                <TD className="text-muted-foreground">The public API is not in the plan</TD>
              </TR>
            ) : (
              <UsageRow
                label="API requests this month"
                used={usage.apiRequests.used}
                limit={usage.limits.apiRequests}
                monthly
                detail={`${day(usage.apiRequests.periodStart)} to ${day(usage.apiRequests.periodEnd)}; requests with the company's API keys`}
              />
            )}
            {usage.limits.apiRequests !== 0 && usage.apiScopes ? (
              <TR>
                <TD className="font-medium">API scopes</TD>
                <TD>{usage.apiScopes.map((s) => API_SCOPE_INFO[s].label).join(', ')}</TD>
              </TR>
            ) : null}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}
