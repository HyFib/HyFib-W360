import type { ReactNode } from 'react';
import { PageHeader } from '@/components/page-header';
import { SettingsTabs } from '@/components/settings/settings-tabs';
import { requireTenant } from '@/server/session';

export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const base = `/c/${ctx.tenant.slug}/settings`;
  const inbox = ctx.permissions.has('inbox.read_all') || ctx.permissions.has('inbox.read_assigned');
  const tabs = [
    { href: base, label: 'General' },
    { href: `${base}/members`, label: 'Members' },
    { href: `${base}/security`, label: 'Security' },
    ...(ctx.permissions.has('channels.read')
      ? [{ href: `${base}/channels`, label: 'Channels' }]
      : []),
    ...(ctx.permissions.has('contacts.read')
      ? [{ href: `${base}/messaging`, label: 'Messaging' }]
      : []),
    ...(inbox || ctx.permissions.has('tenant.settings.manage')
      ? [{ href: `${base}/inbox`, label: 'Inbox' }]
      : []),
    ...(inbox ? [{ href: `${base}/teams`, label: 'Teams' }] : []),
    ...(ctx.permissions.has('inbox.reply') || ctx.permissions.has('inbox.supervise')
      ? [{ href: `${base}/saved-replies`, label: 'Saved replies' }]
      : []),
    ...(ctx.permissions.has('crm.read') ? [{ href: `${base}/pipelines`, label: 'Pipelines' }] : []),
    ...(ctx.permissions.has('audit.read') ? [{ href: `${base}/audit`, label: 'Audit log' }] : []),
    { href: `${base}/modules`, label: 'Modules' },
  ];
  return (
    <>
      <PageHeader title="Settings" description="Manage your company, team and security." />
      <SettingsTabs tabs={tabs} />
      <div className="mt-6">{children}</div>
    </>
  );
}
