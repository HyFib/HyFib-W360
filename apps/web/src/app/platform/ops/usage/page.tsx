import type { Metadata } from 'next';
import Link from 'next/link';
import {
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
import { USAGE_WINDOWS } from '@w360/domain';
import { CompanyLink, StatTile } from '@/components/platform/ops';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Usage · Operations' };
export const dynamic = 'force-dynamic';

export default async function OpsUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const actor = await requirePlatformActor();
  const { days } = await searchParams;
  const { platformOps } = await getRuntime();
  const o = await platformOps.usage(actor, Number(days ?? 30));
  const t = o.totals;
  return (
    <div className="grid grid-cols-1 gap-6">
      <nav aria-label="Period" className="flex flex-wrap gap-2 text-sm">
        {USAGE_WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/platform/ops/usage?days=${w}`}
            aria-current={w === o.days ? 'page' : undefined}
            className={
              w === o.days
                ? 'rounded-md bg-primary px-3 py-1 text-primary-foreground'
                : 'rounded-md border border-border px-3 py-1 text-primary hover:bg-muted'
            }
          >
            {w} days
          </Link>
        ))}
      </nav>
      <section aria-label="Totals" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Messages sent"
          value={t.outbound}
          detail={`${t.campaign} by campaigns · ${t.bot} by automations · ${t.api} through the API`}
        />
        <StatTile label="Messages received" value={t.inbound} />
        <StatTile label="Webhook deliveries" value={t.webhookDeliveries} />
        <StatTile
          label="Members and numbers"
          value={`${t.members} · ${t.numbers}`}
          detail="Active members · WhatsApp numbers"
        />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>By company ({o.days} days)</CardTitle>
          <CardDescription>
            Busiest first. Automation runs and API requests are the plan&apos;s counters for its
            current period (from the date shown); messages sent through the API also count under
            Sent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {o.rows.length === 0 ? (
            <EmptyState title="No companies yet" />
          ) : (
            <Table aria-label="Usage by company">
              <THead>
                <TR>
                  <TH>Company</TH>
                  <TH>Sent</TH>
                  <TH>By</TH>
                  <TH>Received</TH>
                  <TH>Webhook deliveries</TH>
                  <TH>Automation runs</TH>
                  <TH>API requests</TH>
                  <TH>Members</TH>
                  <TH>Numbers</TH>
                </TR>
              </THead>
              <TBody>
                {o.rows.map((a) => (
                  <TR key={a.tenantId}>
                    <TD>
                      <CompanyLink id={a.tenantId} name={a.name} slug={a.slug} />
                    </TD>
                    <TD className="tabular-nums">{a.outbound}</TD>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground">
                      {a.outbound === 0
                        ? '—'
                        : [
                            ['agents', a.outboundBySender.agent],
                            ['automations', a.outboundBySender.bot],
                            ['campaigns', a.outboundBySender.campaign],
                            ['API', a.outboundBySender.api],
                            ['system', a.outboundBySender.system],
                          ]
                            .filter(([, n]) => Number(n) > 0)
                            .map(([label, n]) => `${n} ${label}`)
                            .join(' · ')}
                    </TD>
                    <TD className="tabular-nums">{a.inbound}</TD>
                    <TD className="tabular-nums">{a.webhookDeliveries}</TD>
                    <TD className="tabular-nums">
                      {a.automationRuns}
                      {a.runsPeriodStart ? (
                        <div className="text-xs text-muted-foreground">
                          from {a.runsPeriodStart.toISOString().slice(0, 10)}
                        </div>
                      ) : null}
                    </TD>
                    <TD className="tabular-nums">
                      {a.apiRequests}
                      {a.apiPeriodStart ? (
                        <div className="text-xs text-muted-foreground">
                          from {a.apiPeriodStart.toISOString().slice(0, 10)}
                        </div>
                      ) : null}
                    </TD>
                    <TD className="tabular-nums">{a.members}</TD>
                    <TD className="tabular-nums">{a.numbers}</TD>
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
