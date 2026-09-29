import type { Metadata } from 'next';
import Link from 'next/link';
import { displayMoney } from '@w360/core';
import { PLAN_INTERVAL_LABELS } from '@w360/domain';
import {
  Badge,
  Button,
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
import { DefaultTrialForm, PlanTaxForm } from '@/components/platform/plan-forms';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Plans · Platform' };
export const dynamic = 'force-dynamic';

const TONE = { draft: 'neutral', published: 'success', retired: 'warning' } as const;

export default async function PlansPage() {
  const actor = await requirePlatformActor();
  const { planAdmin, razorpay } = await getRuntime();
  const { plans, defaultTrialPlanId, planTaxBp } = await planAdmin.listPlans(actor);
  const isOwner = actor.role === 'platform_owner';
  const trialOptions = plans
    .filter((p) => p.status === 'published' && p.trialDays > 0)
    .map((p) => ({
      id: p.id,
      label: `${p.name} (${p.code} v${p.version}) · ${p.trialDays}-day trial`,
    }));
  const defaultTrial = plans.find((p) => p.id === defaultTrialPlanId);
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Plans</h1>
          <p className="text-sm text-muted-foreground">
            Plan versions companies can be put on. Published versions never change; a change is a
            new version.{' '}
            <Link href="/platform" className="text-primary underline-offset-4 hover:underline">
              Back to platform
            </Link>
          </p>
        </div>
        {isOwner ? (
          <Button asChild>
            <Link href="/platform/plans/new">New plan</Link>
          </Button>
        ) : null}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Default trial</CardTitle>
          <CardDescription>
            {defaultTrial
              ? `New companies start a ${defaultTrial.trialDays}-day trial of ${defaultTrial.name} (${defaultTrial.code} v${defaultTrial.version}).`
              : 'No default trial: new companies start complimentary, with no limits and every module.'}
          </CardDescription>
        </CardHeader>
        {isOwner ? (
          <CardContent>
            <DefaultTrialForm current={defaultTrialPlanId} options={trialOptions} />
          </CardContent>
        ) : null}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Paying for plans</CardTitle>
          <CardDescription>
            {!razorpay?.subscriptionsEnabled
              ? 'Turned off on this platform: companies cannot pay for plans here until Razorpay Subscriptions is activated and RAZORPAY_SUBSCRIPTIONS_ENABLED is set.'
              : planTaxBp === null
                ? 'No tax on plan prices is set, so companies cannot pay for plans here yet.'
                : `Companies on a published plan version can pay for it through a Razorpay subscription. Plan prices are before tax; ${planTaxBp / 100}% tax is added.`}{' '}
            A subscription keeps the tax it started with.
          </CardDescription>
        </CardHeader>
        {isOwner ? (
          <CardContent>
            <PlanTaxForm current={planTaxBp} />
          </CardContent>
        ) : null}
      </Card>
      <Card>
        <CardContent className="p-0">
          {plans.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No plans yet"
                description={
                  isOwner
                    ? 'Create a plan, review the draft, then publish it.'
                    : 'A platform owner creates and publishes plans.'
                }
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Plan</TH>
                  <TH>Version</TH>
                  <TH>Price</TH>
                  <TH>Trial</TH>
                  <TH>Companies</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {plans.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      <Link
                        href={`/platform/plans/${p.id}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {p.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{p.code}</div>
                    </TD>
                    <TD>v{p.version}</TD>
                    <TD className="text-sm">
                      {displayMoney(BigInt(p.priceMinor), 'INR')}{' '}
                      {PLAN_INTERVAL_LABELS[p.intervalMonths] ?? ''}
                    </TD>
                    <TD className="text-sm">{p.trialDays > 0 ? `${p.trialDays} days` : '—'}</TD>
                    <TD>{p.companies}</TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={TONE[p.status]}>{p.status}</Badge>
                        {p.id === defaultTrialPlanId ? (
                          <Badge tone="info">default trial</Badge>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
