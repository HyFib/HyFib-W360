import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import {
  BusinessHoursForm,
  ClosedDaysManager,
  CsatSettingsForm,
  ReadReceiptsForm,
  SlowReplyForm,
} from '@/components/settings/inbox-settings';
import { ResponseTargetForm } from '@/components/settings/response-target';
import { formatDayLong } from '@/lib/report-format';
import { canUseInbox } from '@/server/inbox';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Inbox settings' };
export const dynamic = 'force-dynamic';

export default async function InboxSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const manage = can(ctx, 'tenant.settings.manage');
  if (!manage && !canUseInbox(ctx)) notFound();
  const { inbox, businessHours, csat, readReceipts, slowReply } = await getRuntime();
  const [target, hours, survey, receipts, automaticReply] = await Promise.all([
    inbox.getResponseTarget(ctx),
    businessHours.getBusinessHours(ctx),
    csat.getCsatSettings(ctx),
    readReceipts.getSettings(ctx),
    slowReply.getSlowReplySettings(ctx),
  ]);
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>First-response target</CardTitle>
          <CardDescription>
            How quickly the team aims to answer a waiting customer. The inbox shows when each reply
            is due and reports measure the share answered in time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponseTargetForm slug={ctx.tenant.slug} initial={target} canEdit={manage} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Automatic reply when members are slow</CardTitle>
          <CardDescription>
            A message HyFib sends a waiting customer when no member has replied within the time you
            choose, so they know their message arrived.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SlowReplyForm
            slug={ctx.tenant.slug}
            initial={automaticReply}
            businessHours={hours.enabled}
            canEdit={manage}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Business hours</CardTitle>
          <CardDescription>
            When the team works. With business hours on, reply timers and the target count only
            these hours.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BusinessHoursForm
            slug={ctx.tenant.slug}
            initial={{ enabled: hours.enabled, days: hours.days }}
            timeZone={hours.timezone}
            canEdit={manage}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Closed days</CardTitle>
          <CardDescription>
            Whole days without business hours, such as public holidays. A team with closed days of
            its own (Settings → Teams) uses those instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ClosedDaysManager
            slug={ctx.tenant.slug}
            canEdit={manage}
            days={hours.holidays.map((h) => ({ ...h, label: formatDayLong(h.day) }))}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>CSAT surveys</CardTitle>
          <CardDescription>
            A rating question with three reply buttons, sent when a member resolves a conversation.
            Answers appear in Reports.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CsatSettingsForm slug={ctx.tenant.slug} initial={survey} canEdit={manage} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Read receipts and typing</CardTitle>
          <CardDescription>
            Whether customers see in WhatsApp that the team read their message and is writing a
            reply. Off until you turn it on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReadReceiptsForm slug={ctx.tenant.slug} initial={receipts.enabled} canEdit={manage} />
        </CardContent>
      </Card>
    </div>
  );
}
