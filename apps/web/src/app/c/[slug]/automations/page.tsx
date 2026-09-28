import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import {
  Badge,
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
import { CreateAutomationForm } from '@/components/automations/automation-actions';
import { PageHeader } from '@/components/page-header';
import { AUTOMATION_STATUS } from '@/lib/automation-labels';
import { formatDateTime } from '@/lib/format';
import { ModuleNotInPlan, PlanLimitHint } from '@/components/plan-limit';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Automations' };
export const dynamic = 'force-dynamic';

export default async function AutomationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ archived?: string }>;
}) {
  const { slug } = await params;
  const { archived } = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'automations.read')) notFound();
  const { automations, plans } = await getRuntime();
  const includeArchived = archived === '1';
  const [list, usage] = await Promise.all([
    automations.listAutomations(ctx, { includeArchived }),
    plans.usage(ctx),
  ]);
  const base = `/c/${ctx.tenant.slug}/automations`;
  const tz = ctx.tenant.timezone;
  return (
    <>
      <PageHeader
        title="Automations"
        description="Replies and questions that run on their own when customers write: published versions never change, and a member’s reply always takes over."
      />
      <ModuleNotInPlan ctx={ctx} module="automations" />
      {can(ctx, 'automations.publish') ? (
        <div className="mb-4 grid gap-2">
          <PlanLimitHint
            ctx={ctx}
            one="live automation"
            what="live automations"
            used={usage.liveAutomations}
            limit={usage.limits.liveAutomations}
          />
          <PlanLimitHint
            ctx={ctx}
            one="automation run this month"
            what="automation runs this month"
            used={usage.automationRuns.used}
            limit={usage.limits.automationRuns}
            detail="new runs start again when the month renews"
          />
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardContent className="p-0">
            {list.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title={includeArchived ? 'No automations' : 'No automations yet'}
                  description="Create one, add its steps, try it in the simulator, then publish it."
                />
              </div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Automation</TH>
                    <TH>Status</TH>
                    <TH>Starts when</TH>
                    <TH>Runs (7 days)</TH>
                    <TH>Updated</TH>
                  </TR>
                </THead>
                <TBody>
                  {list.map((a) => {
                    const status = AUTOMATION_STATUS[a.status] ?? {
                      label: a.status,
                      tone: 'neutral' as const,
                    };
                    return (
                      <TR key={a.id}>
                        <TD className="font-medium">
                          <Link
                            href={`${base}/${a.id}`}
                            className="text-primary underline-offset-4 hover:underline"
                          >
                            {a.name}
                          </Link>
                          {a.description ? (
                            <span className="block text-xs text-muted-foreground">
                              {a.description}
                            </span>
                          ) : null}
                        </TD>
                        <TD>
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge tone={status.tone}>{status.label}</Badge>
                            {a.activeVersion ? (
                              <span className="text-xs text-muted-foreground">
                                v{a.activeVersion}
                                {a.draftChanged ? ' · unpublished changes' : ''}
                              </span>
                            ) : null}
                          </div>
                        </TD>
                        <TD className="text-sm">
                          {a.trigger ?? '—'}
                          {a.channelName ? (
                            <span className="block text-xs text-muted-foreground">
                              on {a.channelName}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="text-sm">
                          {a.runsLast7Days}
                          {a.activeRuns > 0 ? (
                            <span className="block text-xs text-muted-foreground">
                              {a.activeRuns} in progress
                            </span>
                          ) : null}
                        </TD>
                        <TD className="text-sm text-muted-foreground">
                          {formatDateTime(a.updatedAt, tz)}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <div className="grid content-start gap-6">
          {can(ctx, 'automations.write') ? (
            <Card>
              <CardHeader>
                <CardTitle>New automation</CardTitle>
                <CardDescription>
                  It starts as a draft with a greeting; nothing runs until it is published.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CreateAutomationForm slug={ctx.tenant.slug} />
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Runs</CardTitle>
              <CardDescription>Every run and each of its steps, newest first.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <Link
                href={`${base}/runs`}
                className="text-primary underline-offset-4 hover:underline"
              >
                All runs
              </Link>
              <Link
                href={includeArchived ? base : `${base}?archived=1`}
                className="text-primary underline-offset-4 hover:underline"
              >
                {includeArchived ? 'Hide archived automations' : 'Show archived automations'}
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
