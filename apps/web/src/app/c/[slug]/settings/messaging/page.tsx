import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { CampaignSettingsForm } from '@/components/settings/campaign-settings';
import { ResponseTargetForm } from '@/components/settings/response-target';
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
  const { consent, contacts, campaigns, inbox } = await getRuntime();
  const [settings, fields, suppressions, campaignSettings, responseTarget] = await Promise.all([
    consent.getSettings(ctx),
    contacts.listFields(ctx),
    consent.listSuppressions(ctx, { limit: 200 }),
    can(ctx, 'campaigns.read') ? campaigns.getSettings(ctx) : Promise.resolve(null),
    inbox.getResponseTarget(ctx),
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
          <CardTitle>Inbox response target</CardTitle>
          <CardDescription>
            How quickly the team aims to answer a waiting customer, for the inbox report.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponseTargetForm slug={ctx.tenant.slug} initial={responseTarget} canEdit={manage} />
        </CardContent>
      </Card>
      {campaignSettings ? (
        <Card>
          <CardHeader>
            <CardTitle>Campaigns</CardTitle>
            <CardDescription>Approval, marketing frequency and cost estimates.</CardDescription>
          </CardHeader>
          <CardContent>
            <CampaignSettingsForm
              slug={ctx.tenant.slug}
              initial={campaignSettings}
              currencies={campaignSettings.availableCurrencies}
              canEdit={manage}
            />
          </CardContent>
        </Card>
      ) : null}
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
