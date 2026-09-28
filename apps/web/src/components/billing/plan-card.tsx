import { displayMoney } from '@w360/core';
import {
  PLAN_INTERVAL_LABELS,
  PLAN_MODULE_KEYS,
  PLAN_MODULE_LABELS,
  TENANT_PLAN_STATUS_LABELS,
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
}: {
  label: string;
  used: number;
  limit: number | null;
  detail?: string;
}) {
  const share = limit === null || limit === 0 ? null : Math.min(100, (used / limit) * 100);
  const full = limit !== null && used >= limit;
  return (
    <TR>
      <TD className="font-medium">
        {label}
        {detail ? <div className="text-xs font-normal text-muted-foreground">{detail}</div> : null}
      </TD>
      <TD>
        <span className={full ? 'font-medium text-destructive' : ''}>
          {used.toLocaleString('en-IN')}
          {limit === null ? '' : ` of ${limit.toLocaleString('en-IN')}`}
        </span>
        {share !== null ? (
          <div
            className="mt-1 h-1.5 w-full max-w-40 overflow-hidden rounded bg-muted"
            aria-hidden="true"
          >
            <div
              className={`h-full ${full ? 'bg-destructive' : 'bg-primary'}`}
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
}: {
  overview: CompanyPlanOverview;
  timeZone: string;
}) {
  const { plan, usage, status } = overview;
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
              ? `Trial until ${day(overview.trialEndsAt)}.`
              : status === 'active' || status === 'past_due'
                ? `Paid period ${day(overview.periodStart)} to ${day(overview.periodEnd)}.`
                : 'The plan has ended.'}{' '}
          HyFib sets plans and periods; there is nothing to pay here for the plan.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {status === 'past_due' ? (
          <Alert tone="warning" title="The paid period has ended">
            Everything keeps working until {day(overview.graceEndsAt)}. Ask HyFib to renew the plan
            before then.
          </Alert>
        ) : null}
        {status === 'expired' || status === 'canceled' ? (
          <Alert
            tone="danger"
            title={status === 'canceled' ? 'The plan was canceled' : 'The plan ended'}
          >
            Sending messages, campaigns and automations is paused. Your data is kept, and you can
            still review and export it. Ask HyFib to choose a plan to continue.
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
              detail={`${day(runs.periodStart)} to ${day(runs.periodEnd)}; test runs are not counted`}
            />
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}
