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
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { OPS_SIGNAL_RULES, qualityRank } from '@w360/domain';
import { CompanyLink, percent } from '@/components/platform/ops';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Signals · Operations' };
export const dynamic = 'force-dynamic';

export default async function OpsSignalsPage() {
  const actor = await requirePlatformActor();
  const { platformOps } = await getRuntime();
  const o = await platformOps.signals(actor);
  const r = OPS_SIGNAL_RULES;
  const flagged = o.rows.filter((row) => row.flags.length > 0).length;
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Sending signals ({r.windowDays} days)</CardTitle>
            <Button asChild variant="outline" size="sm">
              <a href="/platform/ops/export/signals" download>
                Download CSV
              </a>
            </Button>
          </div>
          <CardDescription>
            A signal asks for a review, not a verdict: nothing is suspended automatically, and a
            suspension is a reasoned action on the company&apos;s page. The thresholds are
            HyFib&apos;s own, not Meta&apos;s: at least {r.minOutbound} messages with{' '}
            {r.failureRate * 100}% failed; at least {r.minMarketingDelivered} marketing templates
            delivered with opt-outs of {r.optOutRate * 100}% or more; {r.stoppedMarketing} sends to
            people who stopped marketing messages (Meta error 131050); {r.perUserLimit} sends held
            back by Meta&apos;s per-user marketing limit (131049); {r.complaints} numbers suppressed
            after complaints; a number rated RED or YELLOW at its last check.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm">
            {flagged === 0
              ? 'No company is flagged.'
              : `${flagged} ${flagged === 1 ? 'company is' : 'companies are'} flagged.`}
          </p>
          {o.rows.length === 0 ? (
            <EmptyState title={`No sending in the last ${r.windowDays} days`} />
          ) : (
            <Table aria-label="Sending signals">
              <THead>
                <TR>
                  <TH>Company</TH>
                  <TH>Sent</TH>
                  <TH>Failed</TH>
                  <TH>Marketing delivered</TH>
                  <TH>Marketing opt-outs</TH>
                  <TH>131050 / 131049</TH>
                  <TH>Complaints</TH>
                  <TH>Quality</TH>
                  <TH>Signals</TH>
                </TR>
              </THead>
              <TBody>
                {o.rows.map(({ activity: a, quality, flags }) => {
                  const rank = qualityRank(quality);
                  return (
                    <TR key={a.tenantId}>
                      <TD>
                        <CompanyLink id={a.tenantId} name={a.name} slug={a.slug} />
                      </TD>
                      <TD className="tabular-nums">{a.outbound}</TD>
                      <TD className="tabular-nums">
                        {a.failed}
                        <div className="text-xs text-muted-foreground">
                          {percent(a.failed, a.outbound)}
                        </div>
                      </TD>
                      <TD className="tabular-nums">{a.marketingDelivered}</TD>
                      <TD className="tabular-nums">
                        {a.marketingOptOuts}
                        <div className="text-xs text-muted-foreground">
                          {percent(a.marketingOptOuts, a.marketingDelivered)}
                        </div>
                      </TD>
                      <TD className="tabular-nums">
                        {a.error131050} / {a.error131049}
                      </TD>
                      <TD className="tabular-nums">{a.complaints}</TD>
                      <TD>
                        {rank ? (
                          <Badge
                            tone={
                              rank === 'RED' ? 'danger' : rank === 'YELLOW' ? 'warning' : 'success'
                            }
                          >
                            {rank}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">Not rated</span>
                        )}
                      </TD>
                      <TD className="min-w-48">
                        {flags.length === 0 ? (
                          <span className="text-muted-foreground">None</span>
                        ) : (
                          <ul className="grid gap-1 text-sm">
                            {flags.map((f) => (
                              <li key={f.key}>{f.detail}</li>
                            ))}
                          </ul>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Security events</CardTitle>
          <CardDescription>
            Invalid webhook and job signatures, password resets and sign-ups with an existing email,
            by type. Details are not shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {o.security.length === 0 ? (
            <EmptyState title="No security events in 7 days" />
          ) : (
            <Table aria-label="Security events">
              <THead>
                <TR>
                  <TH>Event</TH>
                  <TH>Severity</TH>
                  <TH>24 hours</TH>
                  <TH>7 days</TH>
                </TR>
              </THead>
              <TBody>
                {o.security.map((e) => (
                  <TR key={`${e.type}:${e.provider ?? ''}:${e.severity}`}>
                    <TD>
                      <code className="text-xs">{e.type}</code>
                      {e.provider ? (
                        <div className="text-xs text-muted-foreground">{e.provider}</div>
                      ) : null}
                    </TD>
                    <TD>
                      <Badge tone={e.severity === 'critical' ? 'danger' : 'neutral'}>
                        {e.severity}
                      </Badge>
                    </TD>
                    <TD className="tabular-nums">{e.last24h}</TD>
                    <TD className="tabular-nums">{e.last7d}</TD>
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
