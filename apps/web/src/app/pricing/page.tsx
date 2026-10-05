import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { displayMoney } from '@w360/core';
import { PLAN_INTERVAL_LABELS, priceListLines, type PriceListPlan } from '@w360/domain';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { Brand } from '@/components/brand';
import { getRuntime } from '@/server/runtime';

export const metadata: Metadata = {
  title: 'Plans and prices',
  description:
    'The plans HyFib W360 offers, with their prices, what they include and their add-ons.',
};
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

function PlanCard({ plan, taxBp }: { plan: PriceListPlan; taxBp: number }) {
  const interval = PLAN_INTERVAL_LABELS[plan.intervalMonths] ?? '';
  const { included, addOns } = priceListLines(plan);
  const titleId = `price-list-plan-${plan.id}`;
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle>
          <span id={titleId}>{plan.name}</span>
        </CardTitle>
        <CardDescription>
          {inr(plan.priceMinor)} {interval} before tax · {inr(plan.totalMinor)} {interval} with{' '}
          {taxBp / 100}% tax
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {plan.description ? <p className="text-sm">{plan.description}</p> : null}
        <ul className="grid gap-1 text-sm">
          {included.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {addOns.length > 0 ? (
          <div className="grid gap-1 text-sm">
            <p className="font-medium">Add-ons, before tax</p>
            <ul className="grid gap-1">
              {addOns.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The price list for visitors (ADR-107): the plan versions offered to companies, for anyone who has
 * not signed in. Not found unless a platform owner shows it and a visitor could follow it.
 */
export default async function PricingPage() {
  const { priceList } = await getRuntime();
  const list = await priceList.publicPriceList();
  if (!list) notFound();
  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 py-5">
        <Brand />
        <nav aria-label="Account" className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost">
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button asChild>
            <Link href="/sign-up">Create an account</Link>
          </Button>
        </nav>
      </header>
      <main
        id="main"
        className="mx-auto grid w-full max-w-5xl flex-1 content-start gap-6 px-4 pb-16 pt-2"
      >
        <div className="grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Plans and prices</h1>
          <p className="text-sm text-muted-foreground">
            Prices are in Indian rupees for each company, before tax; {list.taxBp / 100}% tax is
            added. A company pays for its plan by subscription, through Razorpay.
          </p>
          <p className="text-sm text-muted-foreground">
            New companies start with a {list.trialDays}-day trial, with no payment needed. During
            it, choose one of these plans under Billing, then pay for it to keep it after the trial.
          </p>
          <p className="text-sm text-muted-foreground">
            The prices do not include WhatsApp&apos;s own charges for messages: Meta bills your
            company for them directly.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {list.plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} taxBp={list.taxBp} />
          ))}
        </div>
      </main>
      <footer className="px-6 py-4 text-center text-xs text-muted-foreground">
        Uses the official WhatsApp Business Platform. WhatsApp is a trademark of its owner; HyFib
        W360 is an independent product.
      </footer>
    </div>
  );
}
