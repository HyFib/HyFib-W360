'use client';
import { useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { authClient } from '@/lib/auth-client';
import { FormError, FormSuccess } from '@/components/form-status';

export function VerifyEmailPanel({ email }: { email: string | null }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function resend() {
    if (!email) return;
    setBusy(true);
    setError(null);
    const result = await authClient.sendVerificationEmail({ email, callbackURL: '/onboarding' });
    setBusy(false);
    if (result.error) setError(result.error.status === 429 ? 'Please wait before requesting another link.' : 'Could not send the link.');
    else setMessage('A new confirmation link is on its way.');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle><span className="text-xl">Confirm your email</span></CardTitle>
        <CardDescription>
          {email ? `We sent a confirmation link to ${email}.` : 'We sent you a confirmation link.'} Open it to continue.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <FormSuccess message={message} />
        <FormError message={error} />
        {email ? (
          <Button variant="outline" onClick={resend} disabled={busy}>
            {busy ? 'Sending…' : 'Send a new link'}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
