import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { AutomationEditor } from '@/components/automations/automation-editor';
import { AutomationStatusActions, TestRunForm } from '@/components/automations/automation-actions';
import { PageHeader } from '@/components/page-header';
import { AUTOMATION_STATUS, RUN_STATUS, TRIGGER_TYPE_LABELS } from '@/lib/automation-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Automation' };
export const dynamic = 'force-dynamic';

export default async function AutomationPage({
  params,
}: {
  params: Promise<{ slug: string; automationId: string }>;
}) {
  const { slug, automationId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'automations.read')) notFound();
  const { automations } = await getRuntime();
  let detail: Awaited<ReturnType<typeof automations.getAutomation>>;
  try {
    detail = await automations.getAutomation(ctx, automationId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const canWrite = can(ctx, 'automations.write');
  const canPublish = can(ctx, 'automations.publish');
  const { runs } = await automations.listRuns(ctx, { automationId: detail.id });
  const testConversations =
    canWrite && can(ctx, 'inbox.reply') ? await automations.testConversationOptions(ctx) : [];
  const errors = detail.issues.filter((i) => i.level === 'error').length;
  const status = AUTOMATION_STATUS[detail.status] ?? {
    label: detail.status,
    tone: 'neutral' as const,
  };
  const base = `/c/${ctx.tenant.slug}/automations`;
  const tz = ctx.tenant.timezone;
  return (
    <>
      <PageHeader
        title={detail.name}
        description={detail.description ?? 'Build the steps, try them, then publish a version.'}
        actions={
          <Link href={base} className="text-sm text-primary underline-offset-4 hover:underline">
            All automations
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <AutomationEditor
          slug={ctx.tenant.slug}
          companyName={ctx.tenant.name}
          canWrite={canWrite && detail.status !== 'archived'}
          automation={{
            id: detail.id,
            name: detail.name,
            description: detail.description,
            version: detail.version,
            trigger: detail.draft.trigger,
            graph: detail.draft.graph,
            channelAccountId: detail.draft.channelAccountId,
          }}
          channels={detail.options.channels}
          teams={detail.options.teams}
          fields={detail.options.fields}
          web={{
            allowedDomains: detail.options.allowedDomains,
            secrets: detail.options.secrets,
            allowInsecureHttp: detail.options.allowInsecureHttp,
          }}
        />
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Status <Badge tone={status.tone}>{status.label}</Badge>
              </CardTitle>
              <CardDescription>
                {detail.activeVersion
                  ? `Version ${detail.activeVersion.number} is live since ${formatDateTime(detail.activeVersion.createdAt, tz)}.`
                  : 'Not published yet.'}{' '}
                {detail.activeVersion && detail.draftChanged
                  ? 'The saved draft has changes that are not published.'
                  : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AutomationStatusActions
                slug={ctx.tenant.slug}
                automationId={detail.id}
                version={detail.version}
                status={detail.status}
                hasVersion={Boolean(detail.activeVersion)}
                draftChanged={detail.draftChanged}
                canPublish={canPublish}
                canWrite={canWrite}
                errors={errors}
              />
              <p className="mt-3 text-xs text-muted-foreground">
                Publishing uses the saved draft. Draft saved{' '}
                {formatDateTime(detail.draft.updatedAt, tz)}
                {detail.draft.updatedByName ? ` by ${detail.draft.updatedByName}` : ''}.
              </p>
            </CardContent>
          </Card>
          {canWrite ? (
            <Card>
              <CardHeader>
                <CardTitle>Test on WhatsApp</CardTitle>
                <CardDescription>
                  Runs the saved draft (not yet published) in one conversation. Reply from that
                  phone to continue; replying from the inbox stops the test like any run.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TestRunForm
                  slug={ctx.tenant.slug}
                  automationId={detail.id}
                  version={detail.version}
                  conversations={testConversations}
                  disabledReason={
                    !can(ctx, 'inbox.reply')
                      ? 'Testing needs permission to reply in the inbox.'
                      : detail.status === 'archived'
                        ? 'Restore the automation to test it.'
                        : errors > 0
                          ? 'Fix the errors in the saved draft to test it.'
                          : null
                  }
                />
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Versions</CardTitle>
              <CardDescription>Published versions never change.</CardDescription>
            </CardHeader>
            <CardContent>
              {detail.versions.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet.</p>
              ) : (
                <ul className="grid gap-2 text-sm">
                  {detail.versions.map((v) => (
                    <li key={v.id} className="grid">
                      <span className="flex items-center gap-2">
                        <span className="font-medium">Version {v.number}</span>
                        {v.active ? <Badge tone="success">Live</Badge> : null}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(v.createdAt, tz)}
                        {v.createdByName ? ` · ${v.createdByName}` : ''}
                      </span>
                      {v.note ? <span className="text-xs">{v.note}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recent runs</CardTitle>
            </CardHeader>
            <CardContent>
              {runs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No runs yet.</p>
              ) : (
                <ul className="grid gap-2 text-sm">
                  {runs.slice(0, 10).map((r) => {
                    const rs = RUN_STATUS[r.status] ?? {
                      label: r.status,
                      tone: 'neutral' as const,
                    };
                    return (
                      <li key={r.id} className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`${base}/runs/${r.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {formatDateTime(r.startedAt, tz)}
                        </Link>
                        <Badge tone={rs.tone}>{rs.label}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {r.mode === 'test' ? 'Test' : (TRIGGER_TYPE_LABELS[r.triggerType] ?? '')}
                          {r.versionNumber ? ` · v${r.versionNumber}` : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <Link
                href={`${base}/runs?automation=${detail.id}`}
                className="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline"
              >
                All runs of this automation
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
