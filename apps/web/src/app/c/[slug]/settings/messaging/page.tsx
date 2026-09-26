import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import {
  ConsentKeywordsForm,
  ContactFieldsManager,
  SuppressionManager,
} from '@/components/settings/messaging-settings';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Messaging settings' };
export const dynamic = 'force-dynamic';

export default async function MessagingSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'contacts.read')) notFound();
  const { consent, contacts } = await getRuntime();
  const [settings, fields, suppressions] = await Promise.all([
    consent.getSettings(ctx),
    contacts.listFields(ctx),
    consent.listSuppressions(ctx, { limit: 200 }),
  ]);
  const manage = can(ctx, 'tenant.settings.manage');
  const tz = ctx.tenant.timezone;
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Consent keywords</CardTitle>
          <CardDescription>
            How customers opt out or back in by replying on WhatsApp. Replies inside the 24-hour
            customer service window are never blocked; consent governs templates.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ConsentKeywordsForm slug={ctx.tenant.slug} initial={settings} canEdit={manage} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Suppression list</CardTitle>
          <CardDescription>
            Numbers that must never receive templates, whatever their consent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SuppressionManager
            slug={ctx.tenant.slug}
            canAdd={can(ctx, 'contacts.write')}
            canRemove={manage}
            items={suppressions.items.map((s) => ({
              id: s.id,
              phoneE164: s.phoneE164,
              reason: s.reason,
              note: s.note,
              createdByName: s.createdByName,
              createdAt: formatDateTime(s.createdAt.toISOString(), tz),
            }))}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Custom contact fields</CardTitle>
          <CardDescription>
            Extra details stored on every contact. The key is also the CSV column name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ContactFieldsManager slug={ctx.tenant.slug} fields={fields} canEdit={manage} />
        </CardContent>
      </Card>
    </div>
  );
}
