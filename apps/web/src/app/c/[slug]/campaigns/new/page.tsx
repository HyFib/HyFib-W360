import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { Card, CardContent } from '@w360/ui';
import { CreateCampaignForm } from '@/components/campaigns/campaign-actions';
import { PageHeader } from '@/components/page-header';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'New campaign' };
export const dynamic = 'force-dynamic';

export default async function NewCampaignPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'campaigns.write')) notFound();
  return (
    <>
      <PageHeader
        title="New campaign"
        description="Start with a name; you choose the message and audience next."
      />
      <Card className="max-w-xl">
        <CardContent className="pt-6">
          <CreateCampaignForm slug={ctx.tenant.slug} />
        </CardContent>
      </Card>
    </>
  );
}
