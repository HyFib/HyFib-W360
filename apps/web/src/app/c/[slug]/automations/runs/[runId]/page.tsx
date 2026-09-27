import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can, NODE_TYPE_LABELS, type NodeType } from '@w360/domain';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { StopRunButton } from '@/components/automations/automation-actions';
import { PageHeader } from '@/components/page-header';
import {
  END_REASONS,
  RUN_STATUS,
  STEP_DETAILS,
  STEP_OUTCOMES,
  TRIGGER_TYPE_LABELS,
} from '@/lib/automation-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Automation run' };
export const dynamic = 'force-dynamic';

export default async function AutomationRunPage({
  params,
}: {
  params: Promise<{ slug: string; runId: string }>;
}) {
  const { slug, runId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'automations.read')) notFound();
  const { automations } = await getRuntime();
  let run: Awaited<ReturnType<typeof automations.getRun>>;
  try {
    run = await automations.getRun(ctx, runId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const tz = ctx.tenant.timezone;
  const status = RUN_STATUS[run.status] ?? { label: run.status, tone: 'neutral' as const };
  const active = run.status === 'running' || run.status === 'waiting';
  const nodeName = (id: string | null) => {
    if (!id) return '—';
    const node = run.graph?.nodes.find((n) => n.id === id);
    return node?.label ? `${node.label} (${id})` : id;
  };
  const describe = (detail: string | null) =>
    detail
      ? detail
          .split(', ')
          .map((d) => STEP_DETAILS[d] ?? END_REASONS[d] ?? d)
          .join('; ')
      : null;
  const base = `/c/${ctx.tenant.slug}/automations`;
  return (
    <>
      <PageHeader
        title={`Run of ${run.automationName}`}
        description={`${run.mode === 'test' ? 'Test of the draft' : `Version ${run.versionNumber ?? '—'}`}, started ${formatDateTime(run.startedAt, tz)} by ${
          run.mode === 'test'
            ? (run.startedByName ?? 'a member')
            : (TRIGGER_TYPE_LABELS[run.triggerType] ?? run.triggerType).toLowerCase()
        }.`}
        actions={
          <Link
            href={`${base}/${run.automationId}`}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Open the automation
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Steps</CardTitle>
            <CardDescription>
              The log records steps and branches only; what the customer wrote stays in the
              conversation.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>#</TH>
                  <TH>Time</TH>
                  <TH>Step</TH>
                  <TH>What happened</TH>
                </TR>
              </THead>
              <TBody>
                {run.log.map((s) => (
                  <TR key={s.seq}>
                    <TD className="text-sm">{s.seq}</TD>
                    <TD className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatDateTime(s.createdAt, tz)}
                    </TD>
                    <TD className="text-sm">
                      {nodeName(s.nodeId)}
                      {s.nodeType ? (
                        <span className="block text-xs text-muted-foreground">
                          {NODE_TYPE_LABELS[s.nodeType as NodeType] ?? s.nodeType}
                        </span>
                      ) : null}
                    </TD>
                    <TD className="text-sm">
                      {STEP_OUTCOMES[s.outcome] ?? s.outcome}
                      {s.branch ? (
                        <span className="text-muted-foreground"> → {s.branch}</span>
                      ) : null}
                      {s.detail ? (
                        <span className="block text-xs text-muted-foreground">
                          {s.outcome === 'started' ? 'Started by ' : ''}
                          {describe(s.detail)}
                        </span>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Status <Badge tone={status.tone}>{status.label}</Badge>
              </CardTitle>
              <CardDescription>
                {active
                  ? run.waitingFor === 'reply'
                    ? `Waiting for the customer’s reply${run.waitUntil ? ` until ${formatDateTime(run.waitUntil, tz)}` : ''}.`
                    : run.waitingFor === 'timer'
                      ? `Waiting until ${run.waitUntil ? formatDateTime(run.waitUntil, tz) : 'later'}.`
                      : 'Running.'
                  : `${END_REASONS[run.endReason ?? ''] ?? 'Ended.'}${run.endDetail ? ` (${describe(run.endDetail)})` : ''}${run.endedByName ? ` By ${run.endedByName}.` : ''}`}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <p>
                {run.steps} step{run.steps === 1 ? '' : 's'}, {run.messages} message
                {run.messages === 1 ? '' : 's'} sent
                {run.endedAt ? `, ended ${formatDateTime(run.endedAt, tz)}` : ''}.
              </p>
              {run.conversationId ? (
                <Link
                  href={`/c/${ctx.tenant.slug}/inbox/${run.conversationId}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Open the conversation
                </Link>
              ) : null}
              {active && can(ctx, 'automations.publish') ? (
                <StopRunButton slug={ctx.tenant.slug} runId={run.id} />
              ) : null}
            </CardContent>
          </Card>
          {run.variables ? (
            <Card>
              <CardHeader>
                <CardTitle>Saved answers</CardTitle>
                <CardDescription>
                  Cleared 30 days after the run ends, or when the contact is erased.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {Object.keys(run.variables).length === 0 ? (
                  <p className="text-sm text-muted-foreground">None.</p>
                ) : (
                  <dl className="grid gap-2 text-sm">
                    {Object.entries(run.variables).map(([key, value]) => (
                      <div key={key}>
                        <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
                        <dd className="whitespace-pre-wrap break-words">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
