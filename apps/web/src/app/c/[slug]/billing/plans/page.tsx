import type { Metadata } from 'next';
import Link from 'next/link';
import { displayMoney } from '@w360/core';
import {
  assertCan,
  can,
  hasRecentSignIn,
  PLAN_CHOICE_UNAVAILABLE_TEXT,
  PLAN_INTERVAL_LABELS,
  PLAN_MODULE_LABELS,
  RECENT_SIGN_IN_MINUTES,
  planShortfallText,
  type PlanChoice,
  type PlanChoices,
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
import { ChoosePlanButton } from '@/components/billing/plan-choice';
import { PageHeader } from '@/components/page-header';
import { SignInAgain } from '@/components/sign-in-again';
import { formatDate } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Choose a plan' };
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

const amount = (value: number | null, one: string, many: string) =>
  value === null
    ? `Unlimited ${many}`
    : `${value.toLocaleString('en-IN')} ${value === 1 ? one : many}`;

/** What choosing does now, for the company's plan state (ADR-105). */
function intro(data: PlanChoices, timeZone: string): string {
  switch (data.status) {
    case 'trialing':
      return `During your trial, which ends on ${formatDate(data.trialEndsAt, timeZone)}, the plan you choose applies at once, with its limits and modules. Pay for it under Billing to keep it after the trial.`;
    case 'expired':
    case 'canceled':
      return 'Your plan has ended. Choose a plan, then pay for it under Billing to lift the restriction.';
    case 'past_due':
      return 'Your paid period has ended. Choose a plan, then pay for it under Billing.';
    default:
      return 'Choose a plan, then pay for it under Billing.';
  }
}

/** What the company would pay each interval, in words. */
function price(choice: PlanChoice, addOns: PlanChoices['addOns']): string {
  const interval = PLAN_INTERVAL_LABELS[choice.intervalMonths] ?? '';
  const base = `${inr(choice.priceMinor)} ${interval} before tax`;
  if (!choice.quote) return base;
  if (!choice.quote.ok) return base;
  const hasAddOns = addOns.extraSeats > 0 || addOns.extraNumbers > 0 || addOns.runPacks > 0;
  return `${base}. You would pay ${inr(choice.quote.quote.totalMinor)} ${interval}, with ${choice.quote.quote.taxBp / 100}% tax${hasAddOns ? ' and your add-ons' : ''}.`;
}

function ChoiceCard({
  slug,
  data,
  choice,
  canChoose,
  timeZone,
}: {
  slug: string;
  data: PlanChoices;
  choice: PlanChoice;
  canChoose: boolean;
  timeZone: string;
}) {
  const { addOns } = data;
  const included = [
    amount(choice.seatsIncluded + addOns.extraSeats, 'seat', 'seats') +
      (addOns.extraSeats > 0 ? ` (with your ${addOns.extraSeats} extra)` : ''),
    amount(choice.numbersIncluded + addOns.extraNumbers, 'WhatsApp number', 'WhatsApp numbers') +
      (addOns.extraNumbers > 0 ? ` (with your ${addOns.extraNumbers} extra)` : ''),
    amount(choice.teamsMax, 'team', 'teams'),
    amount(choice.liveAutomationsMax, 'live automation', 'live automations'),
    `${amount(choice.automationRunsMonthly, 'automation run', 'automation runs')} a month`,
    choice.apiRequestsMonthly === 0
      ? 'No public API'
      : `${amount(choice.apiRequestsMonthly, 'API request', 'API requests')} a month`,
  ];
  const modules = choice.modules.map((m) => PLAN_MODULE_LABELS[m]);
  const unpriced = choice.quote !== null && !choice.quote.ok;
  const consequence =
    data.status === 'trialing'
      ? `Its limits and modules apply at once, until your trial ends on ${formatDate(data.trialEndsAt, timeZone)}. Pay for it under Billing to keep it after the trial.`
      : data.status === 'past_due'
        ? 'Its limits and modules apply at once. Pay for it under Billing to keep everything working.'
        : 'Then pay for it under Billing to lift the restriction.';
  const titleId = `plan-choice-${choice.id}`;
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span id={titleId}>{choice.name}</span>
          {choice.current ? <Badge tone="success">Your plan</Badge> : null}
        </CardTitle>
        <CardDescription>{price(choice, addOns)}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {choice.description ? <p className="text-sm">{choice.description}</p> : null}
        <ul className="grid gap-1 text-sm">
          {included.map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>{modules.length > 0 ? `With ${modules.join(', ')}` : 'Without optional modules'}</li>
        </ul>
        {choice.shortfalls.length > 0 ? (
          <Alert tone="warning" title="Holds less than your company has now">
            <ul className="grid gap-1">
              {choice.shortfalls.map((s) => (
                <li key={s.kind}>{planShortfallText(s)}.</li>
              ))}
            </ul>
            Free some first to choose this plan.
          </Alert>
        ) : null}
        {unpriced ? (
          <p className="text-sm text-muted-foreground">
            Your add-ons are not sold with this plan, or it costs more than can be paid here. Ask
            HyFib to change your plan.
          </p>
        ) : null}
        {choice.current ? (
          <p className="text-sm text-muted-foreground">Your company is on this plan.</p>
        ) : canChoose && choice.shortfalls.length === 0 && !unpriced ? (
          <ChoosePlanButton
            slug={slug}
            planId={choice.id}
            planName={choice.name}
            consequence={consequence}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The plans HyFib offers companies (ADR-105). Owners and billing managers choose one here while the
 * company is on a trial or its plan has ended, then pay for it under Billing.
 */
export default async function ChoosePlanPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'billing.read');
  const { planChoices, clock } = await getRuntime();
  const data = await planChoices.choices(ctx);
  const canManage = can(ctx, 'billing.manage');
  const recent = hasRecentSignIn(ctx, clock.now());
  const tz = ctx.tenant.timezone;
  const canChoose = data.unavailable === null && canManage && recent;

  return (
    <>
      <PageHeader
        title="Choose a plan"
        description="The plans HyFib offers. Choose one, then pay for it under Billing."
      />
      <div className="grid grid-cols-1 gap-6">
        <Link
          href={`/c/${ctx.tenant.slug}/billing`}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          ← Billing
        </Link>
        {data.unavailable ? (
          <Alert tone="info" title="You cannot choose a plan now">
            {PLAN_CHOICE_UNAVAILABLE_TEXT[data.unavailable]}
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">
            {intro(data, tz)}
            {data.currentPlan ? ` You are on ${data.currentPlan.name}.` : ''}
          </p>
        )}
        {data.unavailable === null && !canManage ? (
          <p className="text-sm text-muted-foreground">
            Owners and billing managers choose the plan.
          </p>
        ) : null}
        {data.unavailable === null && canManage && !recent ? (
          <SignInAgain
            reason={`Choosing a plan needs a sign-in within the last ${RECENT_SIGN_IN_MINUTES} minutes.`}
          />
        ) : null}
        {data.choices.length === 0 ? (
          <EmptyState
            title="No plans to choose yet"
            description="HyFib offers no plans to choose here yet. Ask HyFib to change your plan."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {data.choices.map((choice) => (
              <ChoiceCard
                key={choice.id}
                slug={ctx.tenant.slug}
                data={data}
                choice={choice}
                canChoose={canChoose}
                timeZone={tz}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
