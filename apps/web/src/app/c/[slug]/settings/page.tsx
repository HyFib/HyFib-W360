import type { Metadata } from 'next';
import { assertCan, can } from '@w360/domain';
import { GeneralSettingsForm } from '@/components/settings/general-form';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'General settings' };
export const dynamic = 'force-dynamic';

export default async function GeneralSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'tenant.read');
  const timezones = Intl.supportedValuesOf('timeZone');
  if (!timezones.includes(ctx.tenant.timezone)) timezones.unshift(ctx.tenant.timezone);
  return (
    <GeneralSettingsForm
      slug={ctx.tenant.slug}
      canEdit={can(ctx, 'tenant.settings.manage')}
      timezones={timezones}
      initial={{ name: ctx.tenant.name, timezone: ctx.tenant.timezone, locale: ctx.tenant.locale }}
    />
  );
}
