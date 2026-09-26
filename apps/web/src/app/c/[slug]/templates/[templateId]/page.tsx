import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import {
  Alert,
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
import { PageHeader } from '@/components/page-header';
import { DeleteTemplate, SubmitTemplate } from '@/components/templates/template-actions';
import { TemplateEditor } from '@/components/templates/template-editor';
import { TemplatePreview } from '@/components/templates/template-preview';
import { formatDateTime } from '@/lib/format';
import { templateStatus } from '@/lib/template-status';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Template' };
export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = {
  submit: 'Submission',
  sync: 'Meta',
  send: 'Reported when sending',
  delete: 'Deletion',
};

export default async function TemplatePage({
  params,
}: {
  params: Promise<{ slug: string; templateId: string }>;
}) {
  const { slug, templateId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'templates.read')) notFound();
  const { templates } = await getRuntime();
  let detail: Awaited<ReturnType<typeof templates.getTemplate>>;
  try {
    detail = await templates.getTemplate(ctx, templateId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const { template } = detail;
  const status = templateStatus(template.status);
  const tz = ctx.tenant.timezone;
  const canWrite = can(ctx, 'templates.write');
  const canSubmit = can(ctx, 'templates.submit');
  const deletable = !['deleted', 'pending_deletion', 'submitting'].includes(template.status);

  return (
    <>
      <Link
        href={`/c/${ctx.tenant.slug}/templates`}
        className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← Templates
      </Link>
      <PageHeader
        title={template.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            <span>
              {template.language} ·{' '}
              {template.category.charAt(0) + template.category.slice(1).toLowerCase()}
            </span>
            {template.qualityScore ? <span>· Quality {template.qualityScore}</span> : null}
          </span>
        }
        actions={
          <>
            {detail.editable && canSubmit ? (
              <SubmitTemplate slug={ctx.tenant.slug} templateId={template.id} />
            ) : null}
            {deletable && canWrite && (template.providerTemplateId === null || canSubmit) ? (
              <DeleteTemplate
                slug={ctx.tenant.slug}
                templateId={template.id}
                atMeta={template.providerTemplateId !== null}
              />
            ) : null}
          </>
        }
      />
      <div className="grid gap-6">
        {template.status === 'submit_failed' && template.submitError ? (
          <Alert tone="danger" title="Meta did not accept this submission">
            {template.submitError}
          </Alert>
        ) : template.submitError ? (
          <Alert tone="info">{template.submitError}</Alert>
        ) : null}
        {template.status === 'rejected' ? (
          <Alert tone="danger" title="Rejected by Meta">
            {template.rejectionReason
              ? `Reason given: ${template.rejectionReason}.`
              : 'Meta did not give a reason.'}{' '}
            Create a new template with the changes; rejected templates cannot be edited here.
          </Alert>
        ) : null}
        {detail.unsupportedReason ? <Alert tone="warning">{detail.unsupportedReason}</Alert> : null}
        {detail.editable && canWrite && detail.definition ? (
          <Card>
            <CardHeader>
              <CardTitle>Edit draft</CardTitle>
            </CardHeader>
            <CardContent>
              <TemplateEditor
                slug={ctx.tenant.slug}
                accounts={[]}
                existing={{
                  id: template.id,
                  version: template.version,
                  name: template.name,
                  language: template.language,
                  definition: detail.definition,
                }}
              />
            </CardContent>
          </Card>
        ) : detail.preview ? (
          <Card>
            <CardHeader>
              <CardTitle>Content</CardTitle>
              <CardDescription>Shown with the example values.</CardDescription>
            </CardHeader>
            <CardContent className="max-w-md">
              <TemplatePreview rendered={detail.preview} />
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent>
            {detail.history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No status changes yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>When</TH>
                    <TH>Status</TH>
                    <TH>Source</TH>
                  </TR>
                </THead>
                <TBody>
                  {detail.history.map((h) => (
                    <TR key={h.id}>
                      <TD className="whitespace-nowrap text-sm">
                        {formatDateTime(h.occurredAt.toISOString(), tz)}
                      </TD>
                      <TD className="text-sm">
                        {templateStatus(h.status).label}
                        {h.reason ? (
                          <span className="block text-xs text-muted-foreground">{h.reason}</span>
                        ) : null}
                      </TD>
                      <TD className="text-sm text-muted-foreground">
                        {SOURCE_LABEL[h.source] ?? h.source}
                        {h.actorName ? ` · ${h.actorName}` : ''}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
