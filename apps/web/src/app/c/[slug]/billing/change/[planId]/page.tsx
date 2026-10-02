import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { displayMoney } from '@w360/core';
import {
  assertCan,
  can,
  hasRecentSignIn,
  PLAN_ADD_ON_LABELS,
  PLAN_CHANGE_UNAVAILABLE_TEXT,
  PLAN_INTERVAL_LABELS,
  RECENT_SIGN_IN_MINUTES,
  planShortfallText,
} from '@w360/domain';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { ChangePlanForm } from '@/components/billing/change-plan-form';
import { planWithAddOns } from '@/components/billing/plan-words';
import { PageHeader } from '@/components/page-header';
import { SignInAgain } from '@/components/sign-in-again';
import { formatDate } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Change plan' };
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

/**
 * Changing to one plan version from the end of the paid period (ADR-109): the add-ons it sells,
 * what it would cost, and the change itself for owners and billing managers.
 */
export default async function ChangeToPlanPage({
  params,
}: {
  params: Promise<{ slug: string; planId: string }>;
}) {
  const { slug, planId } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'billing.read');
  const { planChanges, clock } = await getRuntime();
  const data = await planChanges.option(ctx, planId);
  if (!data) notFound();
  const canManage = can(ctx, 'billing.manage');
  const recent = hasRecentSignIn(ctx, clock.now());
  const tz = ctx.tenant.timezone;
  const day = (at: Date | null) => formatDate(at, tz);
  const { version, current } = data;
  const interval = PLAN_INTERVAL_LABELS[version.intervalMonths] ?? '';
  const canChange =
    data.unavailable === null &&
    canManage &&
    recent &&
    data.taxBp !== null &&
    data.periodEnd !== null &&
    version.shortfalls.length === 0;

  return (
    <>
      <PageHeader
        title={`Change to ${version.name}`}
        description="From the end of the paid period, with the add-ons you choose."
      />
      <div className="grid grid-cols-1 gap-6">
        <Link
          href={`/c/${ctx.tenant.slug}/billing/change`}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          ← Change plan
        </Link>
        {data.unavailable ? (
          <Alert tone="info" title="You cannot change your plan here now">
            {PLAN_CHANGE_UNAVAILABLE_TEXT[data.unavailable]}
          </Alert>
        ) : current ? (
          <p className="text-sm text-muted-foreground">
            You pay for {planWithAddOns(current.name, current)} until {day(data.periodEnd)}. From
            then, you would pay for {version.name} with the add-ons below.
          </p>
        ) : null}
        {version.shortfalls.length > 0 ? (
          <Alert tone="warning" title="Holds less than your company has now">
            <ul className="grid gap-1">
              {version.shortfalls.map((s) => (
                <li key={s.kind}>{planShortfallText(s)}, even with the most add-ons it sells.</li>
              ))}
            </ul>
            Free some first to change to this plan.
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
        <Card>
          <CardHeader>
            <CardTitle>
              {version.name}
              {data.periodEnd ? ` from ${day(data.periodEnd)}` : ''}
            </CardTitle>
            <CardDescription>
              {inr(version.priceMinor)} {interval} before tax and add-ons
              {data.taxBp !== null ? `; ${data.taxBp / 100}% tax is added` : ''}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canChange && data.taxBp !== null && data.periodEnd ? (
              <ChangePlanForm
                slug={ctx.tenant.slug}
                planId={version.id}
                planName={version.name}
                prices={version}
                intervalMonths={version.intervalMonths}
                taxBp={data.taxBp}
                options={data.options}
                periodEnd={day(data.periodEnd)}
                currentEnds={data.currentEnds}
              />
            ) : data.options.length > 0 ? (
              <dl className="grid gap-4 text-sm sm:grid-cols-3">
                {data.options.map((option) => (
                  <div key={option.kind} className="grid gap-1">
                    <dt className="text-muted-foreground">{PLAN_ADD_ON_LABELS[option.kind]}</dt>
                    <dd>
                      {inr(option.unitPriceMinor)} each {interval}, up to{' '}
                      {option.max.toLocaleString('en-IN')}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">{version.name} sells no add-ons.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
