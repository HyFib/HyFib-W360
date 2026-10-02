import type { Metadata } from 'next';
import Link from 'next/link';
import { displayMoney } from '@w360/core';
import {
  assertCan,
  can,
  hasRecentSignIn,
  PLAN_CHANGE_UNAVAILABLE_TEXT,
  PLAN_INTERVAL_LABELS,
  PLAN_MODULE_LABELS,
  RECENT_SIGN_IN_MINUTES,
  planShortfallText,
  type PlanChangeOverview,
  type PlanChangeVersion,
} from '@w360/domain';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@w360/ui';
import { planWithAddOns } from '@/components/billing/plan-words';
import { PageHeader } from '@/components/page-header';
import { SignInAgain } from '@/components/sign-in-again';
import { formatDate } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Change plan' };
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

const amount = (value: number | null, one: string, many: string) =>
  value === null
    ? `Unlimited ${many}`
    : `${value.toLocaleString('en-IN')} ${value === 1 ? one : many}`;

function VersionCard({
  slug,
  data,
  version,
}: {
  slug: string;
  data: PlanChangeOverview;
  version: PlanChangeVersion;
}) {
  const interval = PLAN_INTERVAL_LABELS[version.intervalMonths] ?? '';
  const included = [
    amount(version.seatsIncluded, 'seat', 'seats'),
    amount(version.numbersIncluded, 'WhatsApp number', 'WhatsApp numbers'),
    amount(version.teamsMax, 'team', 'teams'),
    amount(version.liveAutomationsMax, 'live automation', 'live automations'),
    `${amount(version.automationRunsMonthly, 'automation run', 'automation runs')} a month`,
    version.apiRequestsMonthly === 0
      ? 'No public API'
      : `${amount(version.apiRequestsMonthly, 'API request', 'API requests')} a month`,
  ];
  const modules = version.modules.map((m) => PLAN_MODULE_LABELS[m]);
  const sells = [
    version.seatPriceMinor !== null ? `extra seats at ${inr(version.seatPriceMinor)}` : '',
    version.numberPriceMinor !== null
      ? `extra WhatsApp numbers at ${inr(version.numberPriceMinor)}`
      : '',
    version.runPackPriceMinor !== null && version.runPackSize !== null
      ? `packs of ${version.runPackSize.toLocaleString('en-IN')} automation runs at ${inr(version.runPackPriceMinor)}`
      : '',
  ].filter(Boolean);
  const titleId = `plan-change-${version.id}`;
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span id={titleId}>{version.name}</span>
          {version.current ? <Badge tone="success">Your plan</Badge> : null}
        </CardTitle>
        <CardDescription>
          {inr(version.priceMinor)} {interval} before tax and add-ons.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {version.description ? <p className="text-sm">{version.description}</p> : null}
        <ul className="grid gap-1 text-sm">
          {included.map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>{modules.length > 0 ? `With ${modules.join(', ')}` : 'Without optional modules'}</li>
          <li>
            {sells.length > 0 ? `Sells ${sells.join(', ')}, each ${interval}` : 'Sells no add-ons'}
          </li>
        </ul>
        {version.shortfalls.length > 0 ? (
          <Alert tone="warning" title="Holds less than your company has now">
            <ul className="grid gap-1">
              {version.shortfalls.map((s) => (
                <li key={s.kind}>{planShortfallText(s)}, even with the most add-ons it sells.</li>
              ))}
            </ul>
            Free some first to change to this plan.
          </Alert>
        ) : data.unavailable === null ? (
          <Link
            href={`/c/${slug}/billing/change/${version.id}`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {version.current ? `Change ${version.name} add-ons` : `Choose ${version.name}`}
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Changing the plan a company pays for by subscription, from the end of the paid period (ADR-109):
 * the versions it can change to. Each links to its add-ons and the change itself.
 */
export default async function ChangePlanPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'billing.read');
  const { planChanges, clock } = await getRuntime();
  const data = await planChanges.overview(ctx);
  const canManage = can(ctx, 'billing.manage');
  const recent = hasRecentSignIn(ctx, clock.now());
  const tz = ctx.tenant.timezone;
  const day = (at: Date | null) => formatDate(at, tz);
  const { current, next } = data;

  return (
    <>
      <PageHeader
        title="Change plan"
        description="Change the plan you pay for by subscription, from the end of the paid period."
      />
      <div className="grid grid-cols-1 gap-6">
        <Link
          href={`/c/${ctx.tenant.slug}/billing`}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          ← Billing
        </Link>
        {data.unavailable ? (
          <Alert tone="info" title="You cannot change your plan here now">
            {PLAN_CHANGE_UNAVAILABLE_TEXT[data.unavailable]}
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">
            A change takes effect when your paid period ends, on {day(data.periodEnd)}: your current
            subscription ends then, and a new one for the plan you choose starts and is charged that
            day. Razorpay cannot change a subscription in place. You can change until{' '}
            {day(data.changeBy)}.
          </p>
        )}
        {current ? (
          <p className="text-sm">
            You pay for {planWithAddOns(current.name, current)}
            {current.amountMinor !== null
              ? `: ${inr(current.amountMinor)} ${PLAN_INTERVAL_LABELS[current.intervalMonths] ?? ''}`
              : ''}
            .
            {data.currentEnds && data.periodEnd
              ? ` Your current subscription ends on ${day(data.periodEnd)}.`
              : ''}
          </p>
        ) : null}
        {next ? (
          <Alert
            tone={next.status === 'authenticated' ? 'info' : 'warning'}
            title={`From ${day(next.startsAt)}: ${next.planName}`}
          >
            {planWithAddOns(next.planName, next)}, {inr(next.amountMinor)}{' '}
            {PLAN_INTERVAL_LABELS[next.intervalMonths] ?? ''}.{' '}
            {next.status === 'authenticated'
              ? 'Authorised: Razorpay charges for it then. Choosing again replaces it.'
              : next.checkoutOpen
                ? `Not authorised yet: finish in the payment window from Billing by ${day(next.authorizeBy)}, or choose again.`
                : 'Not authorised: choose again to authorise a new one.'}
          </Alert>
        ) : null}
        {data.unavailable === null && !canManage ? (
          <p className="text-sm text-muted-foreground">
            Owners and billing managers change the plan.
          </p>
        ) : null}
        {data.unavailable === null && canManage && !recent ? (
          <SignInAgain
            reason={`Changing the plan needs a sign-in within the last ${RECENT_SIGN_IN_MINUTES} minutes.`}
          />
        ) : null}
        {data.versions.length === 0 ? (
          <EmptyState
            title="No plans to change to"
            description="HyFib offers no plans to change to here yet. Ask HyFib to change your plan."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {data.versions.map((version) => (
              <VersionCard key={version.id} slug={ctx.tenant.slug} data={data} version={version} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
