import type { Metadata } from 'next';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@w360/ui';
import { opsCompanyPage } from '@w360/domain';
import {
  CompanyLink,
  CompanyPager,
  IssueList,
  LevelBadge,
  StatTile,
  Utc,
} from '@/components/platform/ops';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Operations · Platform' };
export const dynamic = 'force-dynamic';

export default async function OpsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const actor = await requirePlatformActor();
  const { page } = await searchParams;
  const { platformOps } = await getRuntime();
  const o = await platformOps.overview(actor);
  // A page of the companies needing attention (ADR-331); the counts above cover them all.
  const shown = opsCompanyPage(o.attention, Number(page ?? 1));
  return (
    <div className="grid grid-cols-1 gap-6">
      <section aria-label="Totals" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Companies" value={o.companies} detail={`${o.activeCompanies} active`} />
        <StatTile
          label="Companies needing attention"
          value={o.critical + o.warning}
          detail={`${o.critical} critical · ${o.warning} with warnings`}
          tone={o.critical > 0 ? 'danger' : o.warning > 0 ? 'warning' : undefined}
        />
        <StatTile
          label="Integration failures"
          value={o.integrationFailures}
          href="/platform/ops/integrations"
          tone={o.integrationFailures > 0 ? 'warning' : undefined}
        />
        <StatTile
          label="Webhook receipts needing attention"
          value={o.receiptsNeedingAttention}
          detail={`${o.openQuarantine} quarantined events open`}
          href="/platform/ops/integrations"
          tone={o.receiptsNeedingAttention > 0 ? 'danger' : undefined}
        />
        <StatTile
          label="Dead letters (24 hours)"
          value={o.deadLetters24h}
          detail={`${o.deadLetters7d} in 7 days`}
          href="/platform/ops/queues"
          tone={o.deadLetters24h > 0 ? 'warning' : undefined}
        />
        <StatTile
          label="Jobs ready to run"
          value={o.readyJobs}
          detail={`${o.failedJobs} failed jobs retained by pg-boss`}
          href="/platform/ops/queues"
        />
        <StatTile
          label="Late queues"
          value={o.queueCheckFresh ? o.lateQueues : '—'}
          detail={
            o.queuesCheckedAt === null ? (
              'The worker has not checked the queues yet'
            ) : o.queueCheckFresh ? (
              <>
                Checked <Utc at={o.queuesCheckedAt} />
              </>
            ) : (
              <>
                The worker last checked <Utc at={o.queuesCheckedAt} />
              </>
            )
          }
          href="/platform/ops/queues"
          tone={!o.queueCheckFresh || o.lateQueues > 0 ? 'danger' : undefined}
        />
        <StatTile
          label="Failed or abandoned signups (7 days)"
          value={o.failedSignups7d}
          href="/platform/ops/onboarding"
        />
      </section>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Companies needing attention</CardTitle>
            <Button asChild variant="outline" size="sm">
              <a href="/platform/ops/export/health" download>
                Download CSV
              </a>
            </Button>
          </div>
          <CardDescription>
            From numbers, sending in the last 24 hours, integrations, dead letters and plans. The
            thresholds are HyFib&apos;s own (ADR-054). The CSV has every company&apos;s health,
            worst first, healthy companies included.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {o.attention.length === 0 ? (
            <EmptyState title="Every company looks healthy" />
          ) : (
            <div className="grid gap-4">
              <CompanyPager page={shown} href={(n) => `/platform/ops?page=${n}`} />
              <ul aria-label="Companies needing attention" className="grid gap-4">
                {shown.rows.map((c) => (
                  <li
                    key={c.facts.tenantId}
                    className="grid gap-2 border-b border-border pb-4 last:border-0 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]"
                  >
                    <div className="grid content-start gap-1">
                      <div>
                        <CompanyLink
                          id={c.facts.tenantId}
                          name={c.facts.name}
                          slug={c.facts.slug}
                        />
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <LevelBadge level={c.level} />
                        {c.facts.status !== 'active' ? (
                          <Badge tone="neutral">{c.facts.status}</Badge>
                        ) : null}
                      </div>
                    </div>
                    <IssueList issues={c.issues} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
