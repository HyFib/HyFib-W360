import type { Metadata } from 'next';
import { DEAD_LETTER_RETRY_BLOCK_TEXT, waitLabel, type QueueWait } from '@w360/domain';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { CompanyLink, ListTitle, Utc } from '@/components/platform/ops';
import { RetryDeadLetterForm } from '@/components/platform/ops-forms';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Queues · Operations' };
export const dynamic = 'force-dynamic';

/** The oldest ready job's wait at the worker's last check, and whether the queue is late. */
function QueueWaitCell({ wait }: { wait: QueueWait | null }) {
  if (wait === null) return <span className="text-sm text-muted-foreground">Not checked</span>;
  if (wait.oldestWaitMs === null) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="grid gap-1">
      <span className="whitespace-nowrap tabular-nums">{waitLabel(wait.oldestWaitMs)}</span>
      {wait.lateSince ? (
        <span className="grid gap-0.5 text-xs text-muted-foreground">
          <span>
            <Badge tone="danger">Late</Badge> since <Utc at={wait.lateSince} />
          </span>
          {wait.alertedAt ? (
            <span>
              Staff emailed <Utc at={wait.alertedAt} />
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export default async function OpsQueuesPage() {
  const actor = await requirePlatformActor();
  const { platformOps } = await getRuntime();
  const o = await platformOps.queues(actor);
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <ListTitle title="Job queues" list="queues" />
          <CardDescription>
            pg-boss&apos;s counts, which the worker refreshes about once a minute. Failed counts
            only the failed jobs pg-boss still keeps. Each queue&apos;s work is a row that the
            minute sweeps signal again, so there is no redrive here (ADR-054). The oldest wait is
            the longest a ready job had waited for a worker when the worker&apos;s minute sweep last
            checked ({o.waitsCheckedAt ? <Utc at={o.waitsCheckedAt} /> : 'not yet'}). A queue is
            late once it reaches its limit, until the wait is back under half of it; platform
            administrators are emailed once each time, at most every 15 minutes (ADR-096; last email{' '}
            {o.lastQueueAlertAt ? <Utc at={o.lastQueueAlertAt} /> : 'never'}).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {o.waitsFresh ? null : (
            <Alert tone="danger" title="The worker is not checking the queues">
              {o.waitsCheckedAt ? (
                <>
                  Its last check was at <Utc at={o.waitsCheckedAt} />.
                </>
              ) : (
                'It has not checked them yet.'
              )}{' '}
              The waits below may be out of date, and nobody is emailed about a late queue until the
              worker&apos;s minute sweep runs again: look at the worker&apos;s health and logs.
            </Alert>
          )}
          <Table aria-label="Job queues">
            <THead>
              <TR>
                <TH>Queue</TH>
                <TH>Ready</TH>
                <TH>Oldest wait</TH>
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
                          }${q.policy.hasDeadLetter ? ', then dead-lettered' : ''}; waits ${q.policy.maxWaitMinutes} min at most`}
                    </div>
                  </TD>
                  {q.counts ? (
                    <>
                      <TD className="tabular-nums">{q.counts.ready}</TD>
                      <TD>
                        <QueueWaitCell wait={q.wait} />
                      </TD>
                      <TD className="tabular-nums">{q.counts.deferred}</TD>
                      <TD className="tabular-nums">{q.counts.active}</TD>
                      <TD className="tabular-nums">{q.counts.failed}</TD>
                    </>
                  ) : (
                    <TD colSpan={5} className="text-sm text-muted-foreground">
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
          <ListTitle title="Recent dead letters" list="dead-letters" />
          <CardDescription>
            Jobs that failed all their retries. The company and reference show only when the
            job&apos;s signature verified; errors show only their name and code. pg-boss keeps the
            failed job for its queue&apos;s retention (1 to 7 days) and its copy in the dead-letter
            queue for 30 days (RUNBOOKS §3). Platform administrators are emailed about each, with
            counts by queue, at most every 15 minutes (ADR-091). Once the cause is fixed, the minute
            sweeps signal most queues&apos; work again by themselves. The work of channel.onboard,
            commerce.account and template.delete is ended for its company instead, within a minute:
            the number&apos;s setup or the keys&apos; check fails and a deletion is undone, and the
            company starts it again (ADR-111). Until then, and for other queues such as
            template.submit, Retry sends a job back to its queue once, for one more attempt, with
            your reason in the platform audit log (ADR-108, RUNBOOKS §10P). If it fails again, it is
            listed again. The CSV gives when a job was retried, not by whom.
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
                  <TH>
                    <span className="sr-only">Retry</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {o.deadLetters.map((d) => (
                  <TR key={d.id}>
                    <TD>
                      <Utc at={d.failedAt} />
                      <div className="text-xs text-muted-foreground">{d.id}</div>
                      {d.alertedAt ? (
                        <div className="text-xs text-muted-foreground">
                          Staff emailed <Utc at={d.alertedAt} />
                        </div>
                      ) : null}
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
                    <TD className="text-xs text-muted-foreground">
                      {d.retriedAt ? (
                        <>
                          Retried <Utc at={d.retriedAt} />
                          {d.retriedByName ? ` by ${d.retriedByName}` : null}
                        </>
                      ) : d.settledAt ? (
                        <>
                          {d.settledEnded ? 'Work ended for its company ' : 'Nothing left to end '}
                          <Utc at={d.settledAt} />
                          <div>
                            {d.settledEnded
                              ? 'The company can start it again.'
                              : 'The work had finished or was started again.'}
                          </div>
                        </>
                      ) : d.retryable ? (
                        <div className="grid gap-1">
                          <RetryDeadLetterForm deadLetterId={d.id} />
                          {d.retryableUntil ? (
                            <span>
                              Until <Utc at={d.retryableUntil} />
                            </span>
                          ) : null}
                        </div>
                      ) : d.retryBlock ? (
                        DEAD_LETTER_RETRY_BLOCK_TEXT[d.retryBlock]
                      ) : null}
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
