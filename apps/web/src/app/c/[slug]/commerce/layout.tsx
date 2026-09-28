import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { PageHeader } from '@/components/page-header';
import { ModuleNotInPlan } from '@/components/plan-limit';
import { SettingsTabs } from '@/components/settings/settings-tabs';
import { requireTenant } from '@/server/session';

export default async function CommerceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const base = `/c/${ctx.tenant.slug}/commerce`;
  return (
    <>
      <PageHeader
        title="Commerce"
        description="Orders customers send from your WhatsApp catalog, the products you can send in a chat, Payment Links from your own Razorpay account, and your Shopify or WooCommerce store."
      />
      <SettingsTabs
        label="Commerce sections"
        tabs={[
          { href: base, label: 'Orders' },
          { href: `${base}/catalogs`, label: 'Catalogs' },
          { href: `${base}/payments`, label: 'Payments' },
          { href: `${base}/stores`, label: 'Stores' },
        ]}
      />
      <div className="mt-6">
        <ModuleNotInPlan ctx={ctx} module="commerce" />
        {children}
      </div>
    </>
  );
}
