'use client';
import { useState } from 'react';
import { Button, Checkbox, Field, Input, Label, Select, Textarea } from '@w360/ui';
import {
  grantSupportAccessAction,
  resetUserMfaAction,
  revokeSupportAccessAction,
  setTenantStatusAction,
} from '@/app/actions/platform';
import { FormError, FormSuccess } from '@/components/form-status';
import { ClientButton, ClientForm } from '@/components/client-form';

const SCOPES = [
  { value: 'tenant.read', label: 'Company profile' },
  { value: 'members.read', label: 'Members and invitations' },
  { value: 'messages.metadata.read', label: 'Message metadata (no content)' },
  { value: 'billing.read', label: 'Billing records' },
  { value: 'diagnostics.read', label: 'Audit and diagnostics' },
];

export function TenantStatusForm({ tenantId, status }: { tenantId: string; status: string }) {
  const target = status === 'active' ? 'suspended' : 'active';
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await setTenantStatusAction({ tenantId, status: target, reason });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setReason('');
  }
  if (status !== 'active' && status !== 'suspended')
    return (
      <p className="text-sm text-muted-foreground">
        Status changes are unavailable while the company is {status}.
      </p>
    );
  return (
    <ClientForm onSubmit={submit} className="grid gap-3">
      <FormError message={error} />
      <Field
        id="status-reason"
        label={
          target === 'suspended'
            ? 'Reason for suspension (visible to the company)'
            : 'Reason for reactivation'
        }
      >
        {(aria) => (
          <Textarea
            {...aria}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={10}
            maxLength={2000}
            required
          />
        )}
      </Field>
      <div>
        <Button
          type="submit"
          variant={target === 'suspended' ? 'destructive' : 'primary'}
          disabled={busy || reason.trim().length < 10}
        >
          {target === 'suspended' ? 'Suspend company' : 'Reactivate company'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function SupportGrantForm({ tenantId }: { tenantId: string }) {
  const [reason, setReason] = useState('');
  const [scopes, setScopes] = useState<string[]>(['tenant.read']);
  const [duration, setDuration] = useState('60');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(null);
    const result = await grantSupportAccessAction({
      tenantId,
      reason,
      scopes,
      durationMinutes: Number(duration),
    });
    if (!result.ok) setError(result.message);
    else setDone(`Access granted until ${new Date(result.data.expiresAt).toUTCString()}.`);
  }
  return (
    <ClientForm onSubmit={submit} className="grid gap-3">
      <FormError message={error} />
      <FormSuccess message={done} />
      <Field id="grant-reason" label="Reason (ticket reference and purpose; shown to the company)">
        {(aria) => (
          <Textarea
            {...aria}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
          />
        )}
      </Field>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Scope</legend>
        {SCOPES.map((s) => (
          <div key={s.value} className="flex items-center gap-2">
            <Checkbox
              id={`scope-${s.value}`}
              checked={scopes.includes(s.value)}
              onChange={(e) =>
                setScopes(
                  e.target.checked ? [...scopes, s.value] : scopes.filter((x) => x !== s.value),
                )
              }
            />
            <Label htmlFor={`scope-${s.value}`} className="font-normal">
              {s.label}
            </Label>
          </div>
        ))}
      </fieldset>
      <Field id="grant-duration" label="Duration">
        {(aria) => (
          <Select {...aria} value={duration} onChange={(e) => setDuration(e.target.value)}>
            <option value="15">15 minutes</option>
            <option value="60">1 hour</option>
            <option value="240">4 hours</option>
            <option value="480">8 hours (maximum)</option>
          </Select>
        )}
      </Field>
      <div>
        <Button type="submit" disabled={reason.trim().length < 10 || scopes.length === 0}>
          Grant time-boxed access
        </Button>
      </div>
    </ClientForm>
  );
}

export function RevokeGrantButton({ grantId }: { grantId: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-grid gap-1">
      <ClientButton
        size="sm"
        variant="outline"
        onClick={async () => {
          const r = await revokeSupportAccessAction(grantId);
          if (!r.ok) setError(r.message);
        }}
      >
        Revoke
      </ClientButton>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function MfaResetForm({ userId, name }: { userId: string; name: string }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const result = await resetUserMfaAction({ userId, reason });
    if (!result.ok) setError(result.message);
    else setDone(true);
  }
  if (done)
    return (
      <FormSuccess
        message={`Two-factor authentication reset for ${name}; all their sessions were signed out.`}
      />
    );
  return (
    <ClientForm onSubmit={submit} className="grid gap-2">
      <FormError message={error} />
      <Field
        id={`mfa-${userId}`}
        label={`Reset two-factor for ${name} (identity verified out of band)`}
      >
        {(aria) => (
          <Input
            {...aria}
            placeholder="How identity was verified, ticket reference"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" size="sm" variant="destructive" disabled={reason.trim().length < 10}>
          Reset two-factor
        </Button>
      </div>
    </ClientForm>
  );
}
