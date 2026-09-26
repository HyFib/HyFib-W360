import type { Metadata } from 'next';
import Link from 'next/link';
import { ROLE_LABELS } from '@w360/domain';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { Brand } from '@/components/brand';
import { AcceptInvitationButton } from '@/components/onboarding/accept-invitation';
import { getRuntime } from '@/server/runtime';
import { getCurrentSession } from '@/server/session';

export const metadata: Metadata = { title: 'Invitation', referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { tenancy } = await getRuntime();
  const [preview, session] = await Promise.all([tenancy.previewInvitation(token), getCurrentSession()]);
  const next = `/invite/${token}`;

  let body: React.ReactNode;
  if (!preview || preview.status !== 'pending') {
    body = (
      <Alert tone="warning" title="This invitation is not valid">
        It may have expired, been revoked or already been used. Ask the person who invited you for a new invitation.
      </Alert>
    );
  } else if (!session) {
    body = (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">Sign in or create an account with <strong>{preview.email}</strong> to accept.</p>
        <Button asChild><Link href={`/sign-in?next=${encodeURIComponent(next)}`}>Sign in</Link></Button>
        <Button asChild variant="outline"><Link href={`/sign-up?next=${encodeURIComponent(next)}`}>Create account</Link></Button>
      </div>
    );
  } else if (session.user.email.toLowerCase() !== preview.email) {
    body = (
      <Alert tone="warning" title="Signed in with a different email">
        This invitation was sent to {preview.email}, but you are signed in as {session.user.email}. Sign out and sign in with the invited address.
      </Alert>
    );
  } else if (!session.user.emailVerified) {
    body = <Alert tone="warning" title="Verify your email first">Confirm your email address, then return to this page.</Alert>;
  } else {
    body = <AcceptInvitationButton token={token} />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <header className="px-6 py-5"><Brand /></header>
      <main id="main" className="flex flex-1 justify-center px-4 pb-16 pt-6">
        <Card className="h-fit w-full max-w-md">
          <CardHeader>
            <CardTitle><span className="text-xl">{preview && preview.status === 'pending' ? `Join ${preview.companyName}` : 'Invitation'}</span></CardTitle>
            {preview && preview.status === 'pending' ? (
              <CardDescription>
                {preview.inviterName} invited you as {preview.roles.map((r) => ROLE_LABELS[r].label).join(', ')}. Expires{' '}
                {preview.expiresAt.toUTCString()}.
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent>{body}</CardContent>
        </Card>
      </main>
    </div>
  );
}
