import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  dayOf,
  PLAN_MODULE_KEYS,
  PLAN_MODULE_LABELS,
  TENANT_PLAN_STATUS_LABELS,
} from '@w360/domain';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { TenantPlanForm, type AssignablePlanOption } from '@/components/platform/plan-forms';
import {
  MfaResetForm,
  SupportGrantForm,
  TenantStatusForm,
} from '@/components/platform/platform-forms';
import { IssueList, LevelBadge, Utc } from '@/components/platform/ops';
import { formatDate, formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Company · Platform' };
export const dynamic = 'force-dynamic';

export default async function PlatformTenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requirePlatformActor();
  const { platform, planAdmin, platformOps } = await getRuntime();
  const company = await platform.getTenant(actor, id);
  if (!company) notFound();
  const [owners, planView, published, ops] = await Promise.all([
    platform.tenantOwners(actor, id),
    planAdmin.tenantPlan(actor, id),
    planAdmin.assignablePlans(actor),
    platformOps.companyHealth(actor, id),
  ]);
  const { state, usage, limits } = planView;
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
              . Nothing is charged here; set periods after payment is settled.
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
