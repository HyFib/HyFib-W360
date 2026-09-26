'use client';
import { useState } from 'react';
import QRCode from 'qrcode';
import { Alert, Button, Field, Input } from '@w360/ui';
import { authClient } from '@/lib/auth-client';
import { FormError, FormSuccess } from '@/components/form-status';

type Step = { kind: 'idle' } | { kind: 'enrolling'; qr: string; secret: string; backupCodes: string[] } | { kind: 'codes'; backupCodes: string[] };

export function TwoFactorSettings({ enabled }: { enabled: boolean }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function startEnrolment() {
    setBusy(true);
    setError(null);
    const result = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (result.error || !result.data || result.data.method !== 'totp') {
      setError('Password incorrect, or two-factor could not be started.');
      return;
    }
    const uri = result.data.totpURI;
    const secret = new URL(uri).searchParams.get('secret') ?? '';
    const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 192 });
    setStep({ kind: 'enrolling', qr, secret, backupCodes: result.data.backupCodes });
    setPassword('');
  }

  async function confirmEnrolment(backupCodes: string[]) {
    setBusy(true);
    setError(null);
    const result = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s+/g, '') });
    setBusy(false);
    if (result.error) {
      setError('That code is not valid. Check your authenticator app’s clock and try again.');
      return;
    }
    setStep({ kind: 'codes', backupCodes });
    setNotice('Two-factor authentication is on. Store your backup codes somewhere safe.');
  }

  async function disable() {
    setBusy(true);
    setError(null);
    const result = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (result.error) {
      setError('Password incorrect.');
      return;
    }
    window.location.reload();
  }

  async function regenerate() {
    setBusy(true);
    setError(null);
    const result = await authClient.twoFactor.generateBackupCodes({ password });
    setBusy(false);
    if (result.error || !result.data) {
      setError('Password incorrect.');
      return;
    }
    setPassword('');
    setStep({ kind: 'codes', backupCodes: result.data.backupCodes });
  }

  return (
    <div className="grid gap-4">
      <FormError message={error} />
      <FormSuccess message={notice} />
      {step.kind === 'enrolling' ? (
        <div className="grid gap-4">
          <p className="text-sm">Scan this QR code with an authenticator app, then enter the 6-digit code it shows.</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated locally */}
          <img src={step.qr} alt="QR code for your authenticator app" width={192} height={192} className="rounded border border-border bg-white p-2" />
          <p className="text-xs text-muted-foreground">
            Can’t scan? Enter this key manually: <code className="break-all">{step.secret}</code>
          </p>
          <Field id="totp-code" label="Code from your app">
            {(aria) => <Input {...aria} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={8} />}
          </Field>
          <div>
            <Button onClick={() => void confirmEnrolment(step.backupCodes)} disabled={busy || code.length < 6}>Turn on two-factor</Button>
          </div>
        </div>
      ) : step.kind === 'codes' ? (
        <div className="grid gap-3">
          <Alert tone="warning" title="Backup codes">Each code works once. They are shown only now.</Alert>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
            {step.backupCodes.map((c) => <li key={c} className="rounded bg-muted px-2 py-1">{c}</li>)}
          </ul>
          <div><Button variant="outline" onClick={() => window.location.reload()}>Done</Button></div>
        </div>
      ) : (
        <div className="grid gap-3 sm:max-w-sm">
          <p className="text-sm text-muted-foreground">
            {enabled ? 'Two-factor authentication is on.' : 'Protect your account with an authenticator app (TOTP).'} Confirm your password to continue.
          </p>
          <Field id="tf-password" label="Current password">
            {(aria) => <Input {...aria} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <div className="flex flex-wrap gap-2">
            {enabled ? (
              <>
                <Button variant="outline" onClick={() => void regenerate()} disabled={busy || !password}>New backup codes</Button>
                <Button variant="destructive" onClick={() => void disable()} disabled={busy || !password}>Turn off</Button>
              </>
            ) : (
              <Button onClick={() => void startEnrolment()} disabled={busy || !password}>Set up two-factor</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
