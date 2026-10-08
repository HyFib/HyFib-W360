import type { Metadata } from 'next';
import Link from 'next/link';
import {
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
import {
  INTEGRATION_SOURCE_LABELS,
  INTEGRATION_STATE_LABELS,
  OPS_WINDOWS,
  QUARANTINE_REASON_LABELS,
  RECEIPT_PROBLEM_LABELS,
  WEBHOOK_PROVIDER_LABELS,
  integrationFailureView,
  type IntegrationFailureView,
} from '@w360/domain';
import { CompanyLink, ListTitle, Utc } from '@/components/platform/ops';
import {
  AcknowledgeFailureForm,
  AssignFailureForm,
  AcknowledgeQuarantineForm,
  AcknowledgeReceiptForm,
  ResolveQuarantineForm,
  RetryReceiptForm,
} from '@/components/platform/ops-forms';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Integrations · Operations' };
export const dynamic = 'force-dynamic';

/** Every failure, or those assigned to the administrator reading (ADR-315). */
const FAILURE_VIEWS: { view: IntegrationFailureView; label: string; href: string }[] = [
  { view: 'all', label: 'All failures', href: '/platform/ops/integrations' },
  { view: 'mine', label: 'Assigned to me', href: '/platform/ops/integrations?failures=mine' },
];

export default async function OpsIntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ failures?: string | string[] }>;
}) {
  const actor = await requirePlatformActor();
  const { failures } = await searchParams;
  const { platformOps } = await getRuntime();
  const o = await platformOps.integrations(actor, integrationFailureView(failures));
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <ListTitle title="Current failures" list="failures" />
          <CardDescription>
            Numbers, WhatsApp accounts, stores, payment accounts, catalog and Flow syncs, and
            webhook endpoints that are failing now. Errors are the provider&apos;s answer as HyFib
            stored it; only the host of a URL is shown. Platform administrators are emailed about
            each failure once, with counts only, at most every 15 minutes (ADR-139);{' '}
            {o.lastIntegrationAlertAt ? (
              <>
                the last email went out <Utc at={o.lastIntegrationAlertAt} />.
              </>
            ) : (
              'none has gone out yet.'
            )}{' '}
            An administrator who takes a failure acknowledges it with a note, so the others see who
            took it and what was found; the acknowledgement lasts while the failure is listed
            (ADR-141). Any administrator assigns a failure to an administrator, themselves or
            another, so it is clear who handles it; the assignment lasts while the failure is listed
            too (ADR-313), and the assignee is emailed unless they assigned it themselves, with
            counts only (ADR-314). Assigned to me lists only the failures assigned to you (ADR-315).
            The CSV gives every failure with when it was acknowledged, not by whom or the note, and
            leaves assignments out.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <nav aria-label="Failures shown" className="flex flex-wrap gap-2 text-sm">
            {FAILURE_VIEWS.map((v) => (
              <Link
                key={v.view}
                href={v.href}
                aria-current={v.view === o.failuresView ? 'page' : undefined}
                className={
                  v.view === o.failuresView
                    ? 'rounded-md bg-primary px-3 py-1 text-primary-foreground'
                    : 'rounded-md border border-border px-3 py-1 text-primary hover:bg-muted'
                }
              >
                {v.label}
              </Link>
            ))}
          </nav>
          {o.failures.length === 0 ? (
            <EmptyState
              title={
                o.failuresView === 'mine'
                  ? 'No failing integration is assigned to you'
                  : 'No integration is failing'
              }
            />
          ) : (
            <Table aria-label="Current failures">
              <THead>
                <TR>
                  <TH>Company</TH>
                  <TH>What</TH>
                  <TH>State</TH>
                  <TH>Error</TH>
                  <TH>Since</TH>
                  <TH>Assigned</TH>
                  <TH>Acknowledged</TH>
                </TR>
              </THead>
              <TBody>
                {o.failures.map((f) => (
                  <TR key={`${f.source}:${f.subjectId}`}>
                    <TD>
                      <CompanyLink id={f.tenantId} name={f.tenantName} slug={f.tenantSlug} />
                    </TD>
                    <TD>
                      {INTEGRATION_SOURCE_LABELS[f.source] ?? f.source}
                      {f.label ? (
                        <div className="text-xs text-muted-foreground">{f.label}</div>
                      ) : null}
                    </TD>
                    <TD>
                      <Badge tone={f.state === 'failing' ? 'warning' : 'danger'}>
                        {INTEGRATION_STATE_LABELS[f.state] ?? f.state}
                      </Badge>
                    </TD>
                    <TD className="max-w-sm text-sm">{f.error ?? '—'}</TD>
                    <TD>
                      <Utc at={f.since} />
                    </TD>
                    <TD className="max-w-xs text-sm">
                      {f.assignment ? (
                        <div className="mb-2">
                          <div>To {f.assignment.assigneeName ?? 'an administrator'}</div>
                          <div className="text-xs text-muted-foreground">
                            by {f.assignment.byName ?? 'an administrator'},{' '}
                            <Utc at={f.assignment.at} />
                          </div>
                        </div>
                      ) : null}
                      <AssignFailureForm
                        source={f.source}
                        subjectId={f.subjectId}
                        state={f.state}
                        assigneeUserId={f.assignment?.assigneeUserId ?? null}
                        administrators={o.administrators}
                      />
                    </TD>
                    <TD className="max-w-xs text-sm">
                      {f.acknowledgement ? (
                        <div className="mb-2">
                          <div>
                            By {f.acknowledgement.byName ?? 'an administrator'},{' '}
                            <Utc at={f.acknowledgement.at} />
                          </div>
                          <div className="break-words text-xs text-muted-foreground">
                            {f.acknowledgement.note}
                          </div>
                        </div>
                      ) : null}
                      <AcknowledgeFailureForm
                        source={f.source}
                        subjectId={f.subjectId}
                        state={f.state}
                        acknowledged={f.acknowledgement !== null}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <ListTitle title="Meta and Razorpay webhook receipts" list="receipts" />
          <CardDescription>
            Receipts that failed all 12 attempts, or whose worker stopped during the last one, or
            that have waited over 10 minutes (quarantined ones are listed below). Retry one after
            fixing the cause: it goes back to processing, which is idempotent. A receipt&apos;s body
            is erased after 7 days, and then it cannot be processed again. Acknowledge a receipt
            with a note to tell the other administrators what you found or did, retried or not; a
            later note replaces it, the platform audit log keeps each, and the note goes with the
            receipt (ADR-179). The CSV gives when, never who or the note. Platform administrators
            are emailed about each receipt that failed all its attempts, each quarantined event and
            each dead letter, at most every 15 minutes (ADR-091);{' '}
            {o.lastFailureAlertAt ? (
              <>
                the last email went out <Utc at={o.lastFailureAlertAt} />.
              </>
            ) : (
              'none has gone out yet.'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {o.receipts.length === 0 ? (
            <EmptyState title="No receipt needs attention" />
          ) : (
            <Table aria-label="Webhook receipts needing attention">
              <THead>
                <TR>
                  <TH>Received</TH>
                  <TH>From</TH>
                  <TH>Problem</TH>
                  <TH>Attempts</TH>
                  <TH>Last error</TH>
                  <TH />
                  <TH>Acknowledged</TH>
                </TR>
              </THead>
              <TBody>
                {o.receipts.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      <Utc at={r.receivedAt} />
                      <div className="text-xs text-muted-foreground">{r.id}</div>
                    </TD>
                    <TD>{WEBHOOK_PROVIDER_LABELS[r.provider] ?? r.provider}</TD>
                    <TD>
                      <Badge tone={r.problem === 'waiting' ? 'warning' : 'danger'}>
                        {RECEIPT_PROBLEM_LABELS[r.problem]}
                      </Badge>
                      {r.problem === 'exhausted' && r.status === 'processing' ? (
                        <div className="text-xs text-muted-foreground">
                          Its worker stopped during the last attempt.
                        </div>
                      ) : null}
                      {r.alertedAt ? (
                        <div className="text-xs text-muted-foreground">
                          Staff emailed <Utc at={r.alertedAt} />
                        </div>
                      ) : null}
                    </TD>
                    <TD className="tabular-nums">{r.attempts}</TD>
                    <TD className="max-w-xs text-sm">{r.lastError ?? '—'}</TD>
                    <TD>
                      {r.retryable ? (
                        <RetryReceiptForm receiptId={r.id} />
                      ) : r.problem === 'waiting' ? (
                        <span className="text-xs text-muted-foreground">Retried by the sweep</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Body erased</span>
                      )}
                    </TD>
                    <TD className="max-w-xs text-sm">
                      {r.acknowledgement ? (
                        <div className="mb-2">
                          <div>
                            By {r.acknowledgement.byName ?? 'an administrator'},{' '}
                            <Utc at={r.acknowledgement.at} />
                          </div>
                          <div className="break-words text-xs text-muted-foreground">
                            {r.acknowledgement.note}
                          </div>
                        </div>
                      ) : null}
                      <AcknowledgeReceiptForm
                        receiptId={r.id}
                        acknowledged={r.acknowledgement !== null}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <ListTitle title="Quarantined webhook events" list="quarantine" />
          <CardDescription>
            Events HyFib could not attribute to a company. Map an account only after verifying
            ownership with the company (it reconnects through Embedded Signup), then retry the
            receipt; record what was decided either way. Until then, acknowledge an entry with a
            note to tell the other administrators what you found or are waiting for; a later note
            replaces it, the platform audit log keeps each, and the note goes with the entry
            (ADR-199). The CSV gives when, never who or the note.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {o.quarantine.length === 0 ? (
            <EmptyState title="No open quarantine entries" />
          ) : (
            <Table aria-label="Quarantined webhook events">
              <THead>
                <TR>
                  <TH>Quarantined</TH>
                  <TH>From</TH>
                  <TH>Reason</TH>
                  <TH>Provider ids</TH>
                  <TH />
                  <TH>Acknowledged</TH>
                </TR>
              </THead>
              <TBody>
                {o.quarantine.map((q) => (
                  <TR key={q.id}>
                    <TD>
                      <Utc at={q.createdAt} />
                      {q.alertedAt ? (
                        <div className="text-xs text-muted-foreground">
                          Staff emailed <Utc at={q.alertedAt} />
                        </div>
                      ) : null}
                    </TD>
                    <TD>{WEBHOOK_PROVIDER_LABELS[q.provider] ?? q.provider}</TD>
                    <TD>{QUARANTINE_REASON_LABELS[q.reason] ?? q.reason}</TD>
                    <TD className="text-xs">
                      {q.externalIds.length === 0
                        ? '—'
                        : q.externalIds.map((e) => (
                            <div key={e.key}>
                              {e.key}: <code>{e.value}</code>
                            </div>
                          ))}
                    </TD>
                    <TD>
                      <div className="grid gap-2">
                        {q.retryable ? <RetryReceiptForm receiptId={q.receiptId} /> : null}
                        <ResolveQuarantineForm quarantineId={q.id} />
                      </div>
                    </TD>
                    <TD className="max-w-xs text-sm">
                      {q.acknowledgement ? (
                        <div className="mb-2">
                          <div>
                            By {q.acknowledgement.byName ?? 'an administrator'},{' '}
                            <Utc at={q.acknowledgement.at} />
                          </div>
                          <div className="break-words text-xs text-muted-foreground">
                            {q.acknowledgement.note}
                          </div>
                        </div>
                      ) : null}
                      <AcknowledgeQuarantineForm
                        quarantineId={q.id}
                        acknowledged={q.acknowledgement !== null}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <ListTitle title={`Email delivery (${OPS_WINDOWS.emailDays} days)`} list="emails" />
          <CardDescription>
            Counts by kind only. Waiting means due for over 15 minutes and not sent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {o.emails.length === 0 ? (
            <EmptyState title="No failed or waiting emails" />
          ) : (
            <Table aria-label="Email delivery">
              <THead>
                <TR>
                  <TH>Kind</TH>
                  <TH>Failed</TH>
                  <TH>Waiting</TH>
                </TR>
              </THead>
              <TBody>
                {o.emails.map((e) => (
                  <TR key={e.kind}>
                    <TD>
                      <code className="text-xs">{e.kind}</code>
                    </TD>
                    <TD className="tabular-nums">{e.failed}</TD>
                    <TD className="tabular-nums">{e.stuck}</TD>
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
