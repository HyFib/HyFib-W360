import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { PageHeader } from '@/components/page-header';
import { SettingsTabs } from '@/components/settings/settings-tabs';
import { requireTenant } from '@/server/session';

export default async function GrowthLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'campaigns.read')) notFound();
  const base = `/c/${ctx.tenant.slug}/growth`;
  return (
    <>
      <PageHeader
        title="Growth"
        description="Links and QR codes that open a chat with you, a button for your website, and where conversations come from."
      />
      <SettingsTabs
        label="Growth sections"
        tabs={[
          { href: base, label: 'Chat links' },
          { href: `${base}/widgets`, label: 'Website button' },
          { href: `${base}/ads`, label: 'Ads' },
        ]}
      />
      <div className="mt-6">{children}</div>
    </>
  );
}
