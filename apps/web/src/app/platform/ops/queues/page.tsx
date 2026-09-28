import type { Metadata } from 'next';
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
import { CompanyLink, Utc } from '@/components/platform/ops';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Queues · Operations' };
export const dynamic = 'force-dynamic';

export default async function OpsQueuesPage() {
  const actor = await requirePlatformActor();
  const { platformOps } = await getRuntime();
  const o = await platformOps.queues(actor);
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Job queues</CardTitle>
          <CardDescription>
            pg-boss&apos;s counts, which the worker refreshes about once a minute. Failed counts
            only the failed jobs pg-boss still keeps. Each queue&apos;s work is a row that the
            minute sweeps signal again, so there is no redrive here (ADR-054).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table aria-label="Job queues">
            <THead>
              <TR>
                <TH>Queue</TH>
                <TH>Ready</TH>
                <TH>Deferred</TH>
                <TH>Active</TH>
                <TH>Failed</TH>
                <TH>Dead letters (24 h / 7 d)</TH>
              </TR>
            </THead>
            <TBody>
              {o.queues.map((q) => (
                <TR key={q.name}>
                  <TD>
                    <code className="text-xs">{q.name}</code>
                    <div className="text-xs text-muted-foreground">
                      {q.policy === null
                        ? 'Not declared by this release'
                        : `${
                            q.policy.retryLimit === 0
                              ? 'no retries'
                              : `${q.policy.retryLimit} ${q.policy.retryLimit === 1 ? 'retry' : 'retries'}`
                          }${q.policy.hasDeadLetter ? ', then dead-lettered' : ''}`}
                    </div>
                  </TD>
                  {q.counts ? (
                    <>
                      <TD className="tabular-nums">{q.counts.ready}</TD>
                      <TD className="tabular-nums">{q.counts.deferred}</TD>
                      <TD className="tabular-nums">{q.counts.active}</TD>
                      <TD className="tabular-nums">{q.counts.failed}</TD>
                    </>
                  ) : (
                    <TD colSpan={4} className="text-sm text-muted-foreground">
                      No such queue in the database
                    </TD>
                  )}
                  <TD className="tabular-nums">
                    {q.deadLetters.last24h > 0 ? (
                      <Badge tone="warning">{q.deadLetters.last24h}</Badge>
                    ) : (
                      '0'
                    )}{' '}
                    / {q.deadLetters.last7d}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent dead letters</CardTitle>
          <CardDescription>
            Jobs that failed all their retries. The company and reference show only when the
            job&apos;s signature verified; errors show only their name and code. The full job stays
            in pg-boss for 30 days (RUNBOOKS §3).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {o.deadLetters.length === 0 ? (
            <EmptyState title="No dead letters" />
          ) : (
            <Table aria-label="Recent dead letters">
              <THead>
                <TR>
                  <TH>Failed</TH>
                  <TH>Queue</TH>
                  <TH>Company</TH>
                  <TH>Reference</TH>
                  <TH>Error</TH>
                  <TH>Retries</TH>
                </TR>
              </THead>
              <TBody>
                {o.deadLetters.map((d) => (
                  <TR key={d.id}>
                    <TD>
                      <Utc at={d.failedAt} />
                      <div className="text-xs text-muted-foreground">{d.id}</div>
                    </TD>
                    <TD>
                      <code className="text-xs">{d.sourceQueue}</code>
                    </TD>
                    <TD>
                      {!d.verified ? (
                        <Badge tone="danger">Signature did not verify</Badge>
                      ) : d.tenantId && d.tenantName && d.tenantSlug ? (
                        <CompanyLink id={d.tenantId} name={d.tenantName} slug={d.tenantSlug} />
                      ) : (
                        <span className="text-muted-foreground">Platform job</span>
                      )}
                    </TD>
                    <TD>
                      <code className="break-all text-xs">{d.ref ?? '—'}</code>
                    </TD>
                    <TD className="text-sm">
                      {d.errorName ?? 'No error name'}
                      {d.errorCode ? (
                        <div className="text-xs text-muted-foreground">{d.errorCode}</div>
                      ) : null}
                    </TD>
                    <TD className="tabular-nums">{d.retries ?? '—'}</TD>
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
