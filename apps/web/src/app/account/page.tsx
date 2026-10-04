import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { SIGN_IN_HISTORY_LIMIT, SIGN_IN_METHOD_LABELS } from '@w360/domain';
import { ChangePasswordForm, ProfileForm } from '@/components/account/profile-form';
import { SessionsList } from '@/components/account/sessions-list';
import { TwoFactorSettings } from '@/components/account/two-factor-settings';
import { Brand } from '@/components/brand';
import { formatDateTime } from '@/lib/format';
import { summariseAgent } from '@/lib/user-agent';
import { getRuntime } from '@/server/runtime';
import { requireSession } from '@/server/session';

export const metadata: Metadata = { title: 'Account' };
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await requireSession('/account');
  const { tenancy, auth, account } = await getRuntime();
  const [companies, rawSessions, signIns] = await Promise.all([
    tenancy.listMyCompanies(session.user.id),
    auth.api.listSessions({ headers: await headers() }),
    account.signInHistory(session.user.id),
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
        <Link
          href="/"
          className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Brand />
        </Link>
        <Link href="/" className="text-sm text-primary underline-offset-4 hover:underline">
          Back to workspace
        </Link>
      </header>
      <main id="main" className="mx-auto grid max-w-3xl grid-cols-1 gap-6 px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Account & security</h1>
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>{session.user.email}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileForm name={session.user.name} />
          </CardContent>
        </Card>
        <Card id="security">
          <CardHeader>
            <CardTitle>Two-factor authentication</CardTitle>
            <CardDescription>
              Required for owners, administrators and billing members.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TwoFactorSettings enabled={session.user.twoFactorEnabled} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active sessions</CardTitle>
            <CardDescription>Sign out devices you no longer use.</CardDescription>
          </CardHeader>
          <CardContent>
            <SessionsList sessions={sessions} currentSessionId={session.sessionId} />
          </CardContent>
        </Card>
        <Card id="sign-ins">
          <CardHeader>
            <CardTitle>Recent sign-ins</CardTitle>
            <CardDescription>
              Your last {SIGN_IN_HISTORY_LIMIT} sign-ins, newest first. If one is not yours, change
              your password, which signs your other sessions out
              {session.user.twoFactorEnabled ? '.' : ', and turn on two-factor authentication.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {signIns.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sign-in has been recorded yet.</p>
            ) : (
              <Table aria-label="Recent sign-ins">
                <THead>
                  <TR>
                    <TH>When (UTC)</TH>
                    <TH>Device</TH>
                    <TH>Address</TH>
                    <TH>How</TH>
                  </TR>
                </THead>
                <TBody>
                  {signIns.map((s, i) => (
                    <TR key={`${s.at.toISOString()}-${i}`}>
                      <TD>
                        <span className="whitespace-nowrap">{formatDateTime(s.at, 'UTC')}</span>
                        {s.sessionId !== null && s.sessionId === session.sessionId ? (
                          <Badge tone="info" className="ml-2">
                            This session
                          </Badge>
                        ) : null}
                      </TD>
                      <TD>{summariseAgent(s.userAgent)}</TD>
                      <TD className="font-mono">{s.ipAddress ?? 'Unknown'}</TD>
                      <TD>{s.method === null ? 'Another way' : SIGN_IN_METHOD_LABELS[s.method]}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Companies</CardTitle>
          </CardHeader>
          <CardContent>
            {companies.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You are not a member of any company yet.{' '}
                <Link
                  className="text-primary underline-offset-4 hover:underline"
                  href="/onboarding"
                >
                  Create one
                </Link>
                .
              </p>
            ) : (
              <ul className="grid gap-2 text-sm">
                {companies.map((c) => (
                  <li key={c.slug} className="flex justify-between gap-2">
                    <Link
                      href={`/c/${c.slug}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {c.name}
                    </Link>
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
