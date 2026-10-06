import type { Metadata } from 'next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { EmailPreferencesForm } from '@/components/settings/email-preferences-form';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Notification settings' };
export const dynamic = 'force-dynamic';

export default async function NotificationSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const { emailPreferences } = await getRuntime();
  const preferences = await emailPreferences.getEmailPreferences(ctx);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Emails to you</CardTitle>
        <CardDescription>
          Choose which emails HyFib sends you about {ctx.tenant.name}. Security, sign-in and billing
          emails are always sent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {preferences.length > 0 ? (
          <EmailPreferencesForm slug={ctx.tenant.slug} preferences={preferences} />
        ) : (
          <p className="text-sm text-muted-foreground">
            None of these emails concern what your role does in this company.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
