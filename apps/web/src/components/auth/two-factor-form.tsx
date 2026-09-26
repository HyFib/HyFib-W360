'use client';
import { useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Label,
} from '@w360/ui';
import { authClient, safeNextPath } from '@/lib/auth-client';
import { FormError } from '@/components/form-status';

export function TwoFactorForm({ next }: { next: string | null }) {
  const [mode, setMode] = useState<'totp' | 'backup'>('totp');
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const trimmed = code.replace(/\s+/g, '');
    const result =
      mode === 'totp'
        ? await authClient.twoFactor.verifyTotp({ code: trimmed, trustDevice })
        : await authClient.twoFactor.verifyBackupCode({ code: trimmed, trustDevice });
    setBusy(false);
    if (result.error) {
      setError(
        result.error.status === 429
          ? 'Too many attempts. Wait a minute.'
          : 'That code is not valid.',
      );
      return;
    }
    window.location.assign(safeNextPath(next));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="text-xl">Two-factor verification</span>
        </CardTitle>
        <CardDescription>
          {mode === 'totp'
            ? 'Enter the 6-digit code from your authenticator app.'
            : 'Enter one of your unused backup codes.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <FormError message={error} />
          <Field id="code" label={mode === 'totp' ? 'Authentication code' : 'Backup code'}>
            {(aria) => (
              <Input
                {...aria}
                inputMode={mode === 'totp' ? 'numeric' : 'text'}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={mode === 'totp' ? 8 : 24}
                required
              />
            )}
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox
              id="trust"
              checked={trustDevice}
              onChange={(e) => setTrustDevice(e.target.checked)}
            />
            <Label htmlFor="trust" className="font-normal">
              Trust this device for 30 days
            </Label>
          </div>
          <Button type="submit" disabled={busy || code.length < 6}>
            {busy ? 'Verifying…' : 'Verify'}
          </Button>
          <Button
            variant="link"
            onClick={() => {
              setMode(mode === 'totp' ? 'backup' : 'totp');
              setCode('');
              setError(null);
            }}
          >
            {mode === 'totp' ? 'Use a backup code instead' : 'Use an authenticator code instead'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
