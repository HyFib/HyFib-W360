import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { displayMoney, isAppError } from '@w360/core';
import {
  API_SCOPE_INFO,
  PLAN_INTERVAL_LABELS,
  PLAN_MODULE_KEYS,
  PLAN_MODULE_LABELS,
  PLAN_PAYMENT_MIN_MINOR,
} from '@w360/domain';
import { minorToInput } from '@w360/domain/crm-money';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import {
  PlanForm,
  PlanOfferActions,
  PlanVersionActions,
  type PlanFormValues,
} from '@/components/platform/plan-forms';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Plan · Platform' };
export const dynamic = 'force-dynamic';

const TONE = { draft: 'neutral', published: 'success', retired: 'warning' } as const;

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');
const limit = (value: number | null) =>
  value === null ? 'No limit' : value.toLocaleString('en-IN');
const rupees = (paise: number | null) => (paise === null ? '' : minorToInput(paise, 'INR'));
const count = (value: number | null) => (value === null ? '' : String(value));

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requirePlatformActor();
  const { planAdmin } = await getRuntime();
  let data: Awaited<ReturnType<typeof planAdmin.getPlan>>;
  try {
    data = await planAdmin.getPlan(actor, id);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const { plan, versions, companies, isDefaultTrial } = data;
  const isOwner = actor.role === 'platform_owner';
  const form: PlanFormValues = {
    code: plan.code,
    name: plan.name,
    description: plan.description ?? '',
    price: rupees(plan.priceMinor),
    intervalMonths: String(plan.intervalMonths),
    trialDays: String(plan.trialDays),
    graceDays: String(plan.graceDays),
    seatsIncluded: String(plan.seatsIncluded),
    seatPrice: rupees(plan.seatPriceMinor),
    seatsMax: count(plan.seatsMax),
    numbersIncluded: String(plan.numbersIncluded),
    numberPrice: rupees(plan.numberPriceMinor),
    numbersMax: count(plan.numbersMax),
    teamsMax: count(plan.teamsMax),
    liveAutomationsMax: count(plan.liveAutomationsMax),
    automationRunsMonthly: count(plan.automationRunsMonthly),
    runPackSize: count(plan.runPackSize),
    runPackPrice: rupees(plan.runPackPriceMinor),
    apiRequestsMonthly: count(plan.apiRequestsMonthly),
    apiScopeChoice: plan.apiScopes === null ? 'all' : 'chosen',
    apiScopes: plan.apiScopes ?? [],
    modules: plan.modules,
  };
  const terms: [string, string][] = [
    ['Price', `${inr(plan.priceMinor)} ${PLAN_INTERVAL_LABELS[plan.intervalMonths] ?? ''}`],
    ['Trial', plan.trialDays > 0 ? `${plan.trialDays} days` : 'None'],
    ['Grace after a paid period', `${plan.graceDays} days`],
    ['Seats included', String(plan.seatsIncluded)],
    [
      'Extra seats',
      plan.seatPriceMinor === null
        ? 'Not sold'
        : `${inr(plan.seatPriceMinor)} each${plan.seatsMax ? `, up to ${plan.seatsMax} seats` : ''}`,
    ],
    ['WhatsApp numbers included', String(plan.numbersIncluded)],
    [
      'Extra numbers',
      plan.numberPriceMinor === null
        ? 'Not sold'
        : `${inr(plan.numberPriceMinor)} each, up to ${plan.numbersMax ?? 100} numbers`,
    ],
    ['Teams', limit(plan.teamsMax)],
    ['Live automations', limit(plan.liveAutomationsMax)],
    ['Automation runs a month', limit(plan.automationRunsMonthly)],
    [
      'Run packs',
      plan.runPackSize === null || plan.runPackPriceMinor === null
        ? 'Not sold'
        : `${plan.runPackSize.toLocaleString('en-IN')} runs for ${inr(plan.runPackPriceMinor)}`,
    ],
    [
      'API requests a month',
      plan.apiRequestsMonthly === 0 ? 'Not included' : limit(plan.apiRequestsMonthly),
    ],
    [
      'API scopes',
      plan.apiRequestsMonthly === 0
        ? 'The API is not included'
        : plan.apiScopes === null
          ? 'Every scope, including scopes HyFib adds later'
          : plan.apiScopes.map((s) => API_SCOPE_INFO[s].label).join(', '),
    ],
    [
      'Modules',
      PLAN_MODULE_KEYS.filter((m) => plan.modules.includes(m))
        .map((m) => PLAN_MODULE_LABELS[m])
        .join(', ') || 'None (the modules every plan has)',
    ],
  ];
  return (
    <div className="grid gap-6">
      <Link
        href="/platform/plans"
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        ← All plans
      </Link>
      <div className="grid gap-1">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
          {plan.name} <span className="text-muted-foreground">v{plan.version}</span>
          <Badge tone={TONE[plan.status]}>{plan.status}</Badge>
          {isDefaultTrial ? <Badge tone="info">default trial</Badge> : null}
          {plan.offeredAt ? <Badge tone="info">offered to companies</Badge> : null}
        </h1>
        <p className="text-sm text-muted-foreground">
          Code {plan.code} · {companies} {companies === 1 ? 'company' : 'companies'} on this version
          {plan.description ? ` · ${plan.description}` : ''}
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Terms</CardTitle>
            <CardDescription>
              {plan.status === 'draft'
                ? 'A draft: companies cannot be put on it until it is published.'
                : 'Fixed for good. A change needs a new version.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {terms.map(([label, value]) => (
                <div key={label} className="grid gap-0.5">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Versions</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 text-sm">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2">
                  {v.id === plan.id ? (
                    <span className="font-medium">v{v.version} (this one)</span>
                  ) : (
                    <Link
                      href={`/platform/plans/${v.id}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      v{v.version}
                    </Link>
                  )}
                  <Badge tone={TONE[v.status]}>{v.status}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      {isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
            <CardDescription>Every change is recorded in the platform audit log.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {plan.status === 'published' ? (
              <PlanOfferActions
                id={plan.id}
                offered={plan.offeredAt !== null}
                payable={plan.priceMinor >= PLAN_PAYMENT_MIN_MINOR}
              />
            ) : null}
            <PlanVersionActions id={plan.id} status={plan.status} companies={companies} />
          </CardContent>
        </Card>
      ) : null}
      {isOwner && plan.status === 'draft' ? (
        <Card>
          <CardHeader>
            <CardTitle>Edit draft</CardTitle>
          </CardHeader>
          <CardContent>
            <PlanForm planId={plan.id} initial={form} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
