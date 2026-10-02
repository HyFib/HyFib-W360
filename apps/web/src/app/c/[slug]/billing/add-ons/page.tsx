import type { Metadata } from 'next';
import Link from 'next/link';
import { displayMoney } from '@w360/core';
import {
  assertCan,
  can,
  hasRecentSignIn,
  PLAN_ADD_ON_LABELS,
  PLAN_ADD_ONS_UNAVAILABLE_TEXT,
  PLAN_INTERVAL_LABELS,
  RECENT_SIGN_IN_MINUTES,
  type PlanAddOns,
} from '@w360/domain';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@w360/ui';
import { AddOnsForm } from '@/components/billing/add-ons-form';
import { PageHeader } from '@/components/page-header';
import { SignInAgain } from '@/components/sign-in-again';
import { formatDate } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Add-ons' };
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

/** What choosing add-ons does now, for the company's plan state (ADR-106). */
function intro(data: PlanAddOns, timeZone: string): string {
  switch (data.status) {
    case 'trialing':
      return `During your trial, which ends on ${formatDate(data.trialEndsAt, timeZone)}, the add-ons you choose apply at once. Pay for your plan with them under Billing to keep them after the trial.`;
    case 'expired':
    case 'canceled':
      return 'Your plan has ended. Choose add-ons, then pay for your plan with them under Billing to lift the restriction.';
    case 'past_due':
      return 'Your paid period has ended. Choose add-ons, then pay for your plan with them under Billing.';
    default:
      return 'Choose add-ons, then pay for your plan with them under Billing.';
  }
}

/**
 * The add-ons of the company's plan version (ADR-106): extra seats, extra WhatsApp numbers and
 * automation run packs. Owners and billing managers choose them here while the company is on a
 * trial or its plan has ended, then pay for them with the plan under Billing.
 */
export default async function AddOnsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'billing.read');
  const { planAddOns, clock } = await getRuntime();
  const data = await planAddOns.addOns(ctx);
  const canManage = can(ctx, 'billing.manage');
  const recent = hasRecentSignIn(ctx, clock.now());
  const tz = ctx.tenant.timezone;
  const { plan } = data;
  const interval = plan ? (PLAN_INTERVAL_LABELS[plan.intervalMonths] ?? '') : '';
  const canChoose =
    data.unavailable === null && canManage && recent && data.taxBp !== null && plan !== null;

  return (
    <>
      <PageHeader
        title="Add-ons"
        description="Extra seats, WhatsApp numbers and automation runs for your plan, paid for with it."
      />
      <div className="grid grid-cols-1 gap-6">
        <Link
          href={`/c/${ctx.tenant.slug}/billing`}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          ← Billing
        </Link>
        {data.unavailable ? (
          <Alert tone="info" title="You cannot change your add-ons now">
            {PLAN_ADD_ONS_UNAVAILABLE_TEXT[data.unavailable]}
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">{intro(data, tz)}</p>
        )}
        {data.unavailable === null && !canManage ? (
          <p className="text-sm text-muted-foreground">
            Owners and billing managers choose the add-ons.
          </p>
        ) : null}
        {data.unavailable === null && canManage && !recent ? (
          <SignInAgain
            reason={`Changing add-ons needs a sign-in within the last ${RECENT_SIGN_IN_MINUTES} minutes.`}
          />
        ) : null}
        {!plan || data.options.length === 0 ? (
          <EmptyState
            title="No add-ons to choose"
            description={
              plan
                ? `${plan.name} sells no extra seats, WhatsApp numbers or automation runs. Choose another plan under Billing, or ask HyFib.`
                : 'Your company has no plan with add-ons.'
            }
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{plan.name} add-ons</CardTitle>
              <CardDescription>
                {inr(plan.priceMinor)} {interval} before tax and add-ons.
                {data.quote?.ok
                  ? ` You would pay ${inr(data.quote.quote.totalMinor)} ${interval} now, with ${data.quote.quote.taxBp / 100}% tax and your add-ons.`
                  : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {canChoose ? (
                <AddOnsForm
                  slug={ctx.tenant.slug}
                  prices={plan}
                  intervalMonths={plan.intervalMonths}
                  taxBp={data.taxBp ?? 0}
                  options={data.options}
                  consequence={
                    data.status === 'trialing'
                      ? `Saved add-ons apply at once, until your trial ends on ${formatDate(data.trialEndsAt, tz)}. Pay for your plan with them under Billing to keep them after the trial.`
                      : 'Saved add-ons apply at once. Pay for your plan with them under Billing.'
                  }
                />
              ) : (
                <dl className="grid gap-4 text-sm sm:grid-cols-3">
                  {data.options.map((option) => (
                    <div key={option.kind} className="grid gap-1">
                      <dt className="text-muted-foreground">{PLAN_ADD_ON_LABELS[option.kind]}</dt>
                      <dd>
                        {option.quantity.toLocaleString('en-IN')} · {inr(option.unitPriceMinor)}{' '}
                        each {interval}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
