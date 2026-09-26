import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { ChangePasswordForm, ProfileForm } from '@/components/account/profile-form';
import { SessionsList } from '@/components/account/sessions-list';
import { TwoFactorSettings } from '@/components/account/two-factor-settings';
import { Brand } from '@/components/brand';
import { getRuntime } from '@/server/runtime';
import { requireSession } from '@/server/session';

export const metadata: Metadata = { title: 'Account' };
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await requireSession('/account');
  const { tenancy, auth } = await getRuntime();
  const [companies, rawSessions] = await Promise.all([
    tenancy.listMyCompanies(session.user.id),
    auth.api.listSessions({ headers: await headers() }),
  ]);
  const sessions = rawSessions.map((s) => ({
    id: s.id,
    token: s.token,
    createdAt: new Date(s.createdAt).toISOString(),
    ipAddress: s.ipAddress ?? null,
    userAgent: s.userAgent ?? null,
  }));
  return (
    <div className="min-h-dvh bg-muted/30">
      <header className="flex items-center justify-between border-b border-border bg-background px-6 py-4">
        <Link href="/" className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Brand /></Link>
        <Link href="/" className="text-sm text-primary underline-offset-4 hover:underline">Back to workspace</Link>
      </header>
      <main id="main" className="mx-auto grid max-w-3xl gap-6 px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Account & security</h1>
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>{session.user.email}</CardDescription>
          </CardHeader>
          <CardContent><ProfileForm name={session.user.name} /></CardContent>
        </Card>
        <Card id="security">
          <CardHeader>
            <CardTitle>Two-factor authentication</CardTitle>
            <CardDescription>Required for owners, administrators and billing members.</CardDescription>
          </CardHeader>
          <CardContent><TwoFactorSettings enabled={session.user.twoFactorEnabled} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Password</CardTitle></CardHeader>
          <CardContent><ChangePasswordForm /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active sessions</CardTitle>
            <CardDescription>Sign out devices you no longer use.</CardDescription>
          </CardHeader>
          <CardContent><SessionsList sessions={sessions} currentSessionId={session.sessionId} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Companies</CardTitle></CardHeader>
          <CardContent>
            {companies.length === 0 ? (
              <p className="text-sm text-muted-foreground">You are not a member of any company yet. <Link className="text-primary underline-offset-4 hover:underline" href="/onboarding">Create one</Link>.</p>
            ) : (
              <ul className="grid gap-2 text-sm">
                {companies.map((c) => (
                  <li key={c.slug} className="flex justify-between gap-2">
                    <Link href={`/c/${c.slug}`} className="font-medium text-primary underline-offset-4 hover:underline">{c.name}</Link>
                    <span className="text-muted-foreground">{c.roles.join(', ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
