'use client';
import { useState } from 'react';
import { ConfirmDialog } from '@w360/ui/client';
import {
  changeMemberRolesAction,
  resendInvitationAction,
  revokeInvitationAction,
  setMemberStatusAction,
} from '@/app/actions/tenancy';
import { RolePicker, type RoleOption } from './role-picker';
import { ClientButton } from '@/components/client-form';

function useActionState() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (!result.ok) setError(result.message);
    return result.ok;
  }
  return { error, busy, run };
}

export function MemberActions({
  slug,
  membershipId,
  name,
  roles,
  status,
  roleOptions,
  canManage,
  isSelf,
}: {
  slug: string;
  membershipId: string;
  name: string;
  roles: string[];
  status: 'active' | 'suspended' | 'removed';
  roleOptions: RoleOption[];
  canManage: boolean;
  isSelf: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(roles);
  const { error, busy, run } = useActionState();

  if (!canManage || status === 'removed')
    return <span className="text-xs text-muted-foreground">—</span>;

  return (
    <div className="grid justify-items-end gap-2">
      {editing ? (
        <div className="grid w-72 gap-3 rounded-md border border-border p-3 text-left">
          <RolePicker
            idPrefix={`roles-${membershipId}`}
            options={roleOptions}
            value={draft}
            onChange={setDraft}
          />
          <div className="flex justify-end gap-2">
            <ClientButton
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(false);
                setDraft(roles);
              }}
            >
              Cancel
            </ClientButton>
            <ClientButton
              size="sm"
              disabled={busy || draft.length === 0}
              onClick={async () => {
                if (await run(() => changeMemberRolesAction(slug, { membershipId, roles: draft })))
                  setEditing(false);
              }}
            >
              Save roles
            </ClientButton>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          {!isSelf || roles.includes('owner') ? (
            <ClientButton size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit roles
            </ClientButton>
          ) : null}
          {!isSelf && status === 'active' ? (
            <ConfirmDialog
              trigger={
                <ClientButton size="sm" variant="outline">
                  Suspend
                </ClientButton>
              }
              title={`Suspend ${name}?`}
              description="They lose access immediately, including open sessions for this company. You can restore access later."
              confirmLabel="Suspend access"
              destructive
              onConfirm={() =>
                void run(() => setMemberStatusAction(slug, { membershipId, status: 'suspended' }))
              }
            />
          ) : null}
          {!isSelf && status === 'suspended' ? (
            <ClientButton
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() => setMemberStatusAction(slug, { membershipId, status: 'active' }))
              }
            >
              Restore
            </ClientButton>
          ) : null}
          {!isSelf ? (
            <ConfirmDialog
              trigger={
                <ClientButton size="sm" variant="ghost" className="text-destructive">
                  Remove
                </ClientButton>
              }
              title={`Remove ${name}?`}
              description="They lose access to this company. To add them back you will need to send a new invitation."
              confirmLabel="Remove member"
              destructive
              onConfirm={() =>
                void run(() => setMemberStatusAction(slug, { membershipId, status: 'removed' }))
              }
            />
          ) : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="max-w-72 text-right text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function InvitationActions({
  slug,
  invitationId,
  email,
}: {
  slug: string;
  invitationId: string;
  email: string;
}) {
  const { error, busy, run } = useActionState();
  return (
    <div className="grid justify-items-end gap-1">
      <div className="flex gap-2">
        <ClientButton
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => resendInvitationAction(slug, invitationId))}
        >
          Resend
        </ClientButton>
        <ConfirmDialog
          trigger={
            <ClientButton size="sm" variant="ghost" className="text-destructive">
              Revoke
            </ClientButton>
          }
          title={`Revoke invitation for ${email}?`}
          description="The invitation link stops working immediately."
          confirmLabel="Revoke"
          destructive
          onConfirm={() => void run(() => revokeInvitationAction(slug, invitationId))}
        />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
