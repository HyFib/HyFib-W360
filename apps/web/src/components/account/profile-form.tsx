'use client';
import { useState } from 'react';
import { Button, Field, Input } from '@w360/ui';
import { authClient } from '@/lib/auth-client';
import { FormError, FormSuccess } from '@/components/form-status';
import { ClientForm } from '@/components/client-form';

export function ProfileForm({ name }: { name: string }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      setError('Enter a name between 1 and 200 characters.');
      return;
    }
    const result = await authClient.updateUser({ name: trimmed });
    if (result.error) setError('Could not update your name.');
    else setSaved(true);
  }
  return (
    <ClientForm onSubmit={save} className="grid gap-3 sm:max-w-sm">
      <FormError message={error} />
      <FormSuccess message={saved ? 'Name updated.' : null} />
      <Field id="profile-name" label="Name">
        {(aria) => (
          <Input
            {...aria}
            autoComplete="name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={value.trim() === name}>
          Save
        </Button>
      </div>
    </ClientForm>
  );
}

export function ChangePasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    if (next.length < 12) {
      setError('Use at least 12 characters.');
      return;
    }
    const result = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    if (result.error) setError('Current password is incorrect, or the new password was rejected.');
    else {
      setSaved(true);
      setCurrent('');
      setNext('');
    }
  }
  return (
    <ClientForm onSubmit={save} className="grid gap-3 sm:max-w-sm">
      <FormError message={error} />
      <FormSuccess message={saved ? 'Password changed. Other sessions were signed out.' : null} />
      <Field id="current-password" label="Current password">
        {(aria) => (
          <Input
            {...aria}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        )}
      </Field>
      <Field id="new-password" label="New password" description="At least 12 characters.">
        {(aria) => (
          <Input
            {...aria}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={!current || !next}>
          Change password
        </Button>
      </div>
    </ClientForm>
  );
}
