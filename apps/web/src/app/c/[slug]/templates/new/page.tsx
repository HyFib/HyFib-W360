import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { Alert, Card, CardContent } from '@w360/ui';
import { PageHeader } from '@/components/page-header';
import { TemplateEditor } from '@/components/templates/template-editor';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'New template' };
export const dynamic = 'force-dynamic';

export default async function NewTemplatePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'templates.write')) notFound();
  const { templates } = await getRuntime();
  const accounts = (await templates.syncStatus(ctx))
    .filter((a) => a.status === 'connected')
    .map((a) => ({ id: a.id, name: a.name ?? 'WhatsApp account' }));
  return (
    <>
      <Link
        href={`/c/${ctx.tenant.slug}/templates`}
        className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← Templates
      </Link>
      <PageHeader
        title="New template"
        description="Save a draft, then submit it to Meta for review. Text headers, a body with numbered variables, a footer and static buttons are supported."
      />
      {accounts.length === 0 ? (
        <Alert tone="warning" title="No connected WhatsApp account">
          Connect a WhatsApp number in Settings → Channels first.
        </Alert>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <TemplateEditor slug={ctx.tenant.slug} accounts={accounts} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
