import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { STARTER_FLOW_JSON, can } from '@w360/domain';
import { Card, CardContent } from '@w360/ui';
import { FlowDraftForm } from '@/components/flows/flow-draft-form';
import { PageHeader } from '@/components/page-header';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'New flow' };
export const dynamic = 'force-dynamic';

export default async function NewFlowPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'flows.write')) notFound();
  const { flows } = await getRuntime();
  const accounts = await flows.accounts(ctx);
  return (
    <>
      <Link
        href={`/c/${ctx.tenant.slug}/flows`}
        className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← Flows
      </Link>
      <PageHeader
        title="New flow"
        description="Start from the example form or paste Flow JSON built in WhatsApp Manager. HyFib sends the draft to Meta, which checks every component; nothing reaches customers until it is published and sent."
      />
      <Card>
        <CardContent className="pt-6">
          <FlowDraftForm
            slug={ctx.tenant.slug}
            accounts={accounts}
            starterJson={STARTER_FLOW_JSON}
          />
        </CardContent>
      </Card>
    </>
  );
}
