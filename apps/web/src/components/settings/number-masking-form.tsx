'use client';
import { useState } from 'react';
import type { MaskableRole } from '@w360/domain';
import { Checkbox, Label } from '@w360/ui';
import { updateNumberMaskingAction } from '@/app/actions/tenancy';
import { ActionFailure, type ActionFailureState } from '@/components/action-failure';
import { FormSuccess } from '@/components/form-status';
import { ClientButton, useHydrated } from '@/components/client-form';

/** A role the company can mask, as Settings names it. */
export interface MaskableRoleOption {
  role: MaskableRole;
  label: string;
  description: string;
}

/** The roles whose members see customers' numbers masked (ADR-226). */
export function NumberMaskingForm({
  slug,
  roles,
  example,
  maskedNumberRoles,
  canEdit,
}: {
  slug: string;
  roles: MaskableRoleOption[];
  /** A number as masked members see it. */
  example: string;
  maskedNumberRoles: readonly MaskableRole[];
  canEdit: boolean;
}) {
  // A box ticked before hydration would show ticked while `chosen` stayed unchanged (see useHydrated).
  const hydrated = useHydrated();
  const [chosen, setChosen] = useState<MaskableRole[]>([...maskedNumberRoles]);
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const unchanged =
    chosen.length === maskedNumberRoles.length &&
    chosen.every((role) => maskedNumberRoles.includes(role));

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await updateNumberMaskingAction(slug, { maskedNumberRoles: chosen });
    setBusy(false);
    if (!result.ok) setError(result);
    else setSaved(true);
  }

  return (
    <div className="grid gap-4">
      <ActionFailure failure={error} />
      <FormSuccess message={saved ? 'Number masking saved.' : null} />
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm text-muted-foreground">
          Members with only these roles see customers&apos; numbers as{' '}
          <span className="font-mono">{example}</span>: in the inbox, contacts, CRM, campaigns,
          orders and reports, and in what they download. Owners and administrators always see them
          whole.
        </legend>
        {roles.map(({ role, label, description }) => (
          <div key={role} className="flex items-start gap-3">
            <Checkbox
              id={`mask-${role}`}
              className="mt-0.5"
              checked={chosen.includes(role)}
              disabled={!canEdit || !hydrated}
              onChange={(e) =>
                setChosen(
                  e.target.checked
                    ? roles.map((o) => o.role).filter((r) => r === role || chosen.includes(r))
                    : chosen.filter((r) => r !== role),
                )
              }
            />
            <Label htmlFor={`mask-${role}`} className="grid gap-1 font-normal">
              <span className="font-medium">{label}</span>
              <span className="text-xs text-muted-foreground">{description}</span>
            </Label>
          </div>
        ))}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        A member who also has a role that is not masked sees numbers whole. API keys and webhooks
        still carry numbers whole, and messages keep what customers wrote. Showing numbers to a role
        again asks you to have signed in recently.
      </p>
      {canEdit ? (
        <div>
          <ClientButton onClick={save} disabled={busy || unchanged}>
            Save
          </ClientButton>
        </div>
      ) : null}
    </div>
  );
}
