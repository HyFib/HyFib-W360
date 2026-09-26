'use client';
import { useState } from 'react';
import { Checkbox, Label } from '@w360/ui';
import { updateCompanySecurityAction } from '@/app/actions/tenancy';
import { FormError, FormSuccess } from '@/components/form-status';
import { ClientButton } from '@/components/client-form';

export function CompanySecurityForm({
  slug,
  requireMfaAllMembers,
  canEdit,
}: {
  slug: string;
  requireMfaAllMembers: boolean;
  canEdit: boolean;
}) {
  const [value, setValue] = useState(requireMfaAllMembers);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await updateCompanySecurityAction(slug, { requireMfaAllMembers: value });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setSaved(true);
  }

  return (
    <div className="grid gap-4">
      <FormError message={error} />
      <FormSuccess message={saved ? 'Security settings saved.' : null} />
      <div className="flex items-start gap-3">
        <Checkbox
          id="require-mfa"
          className="mt-0.5"
          checked={value}
          disabled={!canEdit}
          onChange={(e) => setValue(e.target.checked)}
        />
        <Label htmlFor="require-mfa" className="grid gap-1 font-normal">
          <span className="font-medium">Require two-factor authentication for every member</span>
          <span className="text-xs text-muted-foreground">
            Owners, administrators and billing members always need it. Members without it get a
            grace period and are then restricted.
          </span>
        </Label>
      </div>
      {canEdit ? (
        <div>
          <ClientButton onClick={save} disabled={busy || value === requireMfaAllMembers}>
            Save
          </ClientButton>
        </div>
      ) : null}
    </div>
  );
}
