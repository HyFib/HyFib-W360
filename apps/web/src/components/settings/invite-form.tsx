'use client';
import { useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from '@w360/ui';
import { inviteMemberAction } from '@/app/actions/tenancy';
import { FormError, FormSuccess } from '@/components/form-status';
import { RolePicker, type RoleOption } from './role-picker';

export function InviteForm({ slug, roleOptions }: { slug: string; roleOptions: RoleOption[] }) {
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<string[]>(['agent']);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setSent(null);
    const result = await inviteMemberAction(slug, { email, roles });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      setFieldErrors(Object.fromEntries((result.issues ?? []).map((i) => [i.path, i.message])));
      return;
    }
    setSent(`Invitation sent to ${email}.`);
    setEmail('');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a teammate</CardTitle>
        <CardDescription>They will receive an email link valid for 7 days. They must sign in with this address to accept.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 sm:max-w-lg" noValidate>
          <FormError message={error} />
          <FormSuccess message={sent} />
          <Field id="invite-email" label="Email address" error={fieldErrors.email}>
            {(aria) => <Input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required {...aria} />}
          </Field>
          <RolePicker idPrefix="invite-role" options={roleOptions} value={roles} onChange={setRoles} />
          {fieldErrors.roles ? <p className="text-xs text-destructive" role="alert">{fieldErrors.roles}</p> : null}
          <div>
            <Button type="submit" disabled={busy || !email || roles.length === 0}>{busy ? 'Sending…' : 'Send invitation'}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
