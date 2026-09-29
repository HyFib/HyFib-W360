'use client';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Select } from '@w360/ui';
import {
  assignConversationAction,
  setConversationStatusAction,
  setConversationTeamAction,
} from '@/app/actions/inbox';
import { FormError } from '@/components/form-status';
import { ClientButton, useHydrated } from '@/components/client-form';

export interface AssignableMember {
  membershipId: string;
  name: string;
}

/** Assignment and resolve/reopen, with optimistic concurrency on the conversation version. */
export function ConversationControls({
  slug,
  conversationId,
  version,
  status,
  assignedMembershipId,
  myMembershipId,
  canManageAssignment,
  canReply,
  members,
}: {
  slug: string;
  conversationId: string;
  version: number;
  status: 'open' | 'pending' | 'resolved';
  assignedMembershipId: string | null;
  myMembershipId: string;
  canManageAssignment: boolean;
  canReply: boolean;
  members: AssignableMember[];
}) {
  const router = useRouter();
  const selectId = useId();
  // The select acts on change, so like a ClientButton it stays disabled until hydration: a choice
  // made before would show without being applied (see useHydrated).
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (
    fn: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>,
  ) => {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      if (result.code === 'conflict') router.refresh();
    }
  };

  const assign = (membershipId: string | null) =>
    run(() =>
      assignConversationAction(slug, { conversationId, membershipId, expectedVersion: version }),
    );

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {canManageAssignment ? (
          <>
            <label htmlFor={selectId} className="text-sm text-muted-foreground">
              Assigned to
            </label>
            <Select
              id={selectId}
              className="w-auto min-w-40"
              value={assignedMembershipId ?? ''}
              disabled={busy || !hydrated}
              onChange={(event) => void assign(event.target.value || null)}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.membershipId === myMembershipId ? `${m.name} (you)` : m.name}
                </option>
              ))}
            </Select>
          </>
        ) : assignedMembershipId === null ? (
          <ClientButton
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void assign(myMembershipId)}
          >
            Assign to me
          </ClientButton>
        ) : assignedMembershipId === myMembershipId ? (
          <ClientButton
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void assign(null)}
          >
            Release
          </ClientButton>
        ) : null}
        {canReply ? (
          status === 'resolved' ? (
            <ClientButton
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  setConversationStatusAction(slug, {
                    conversationId,
                    status: 'open',
                    expectedVersion: version,
                  }),
                )
              }
            >
              Reopen
            </ClientButton>
          ) : (
            <ClientButton
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  setConversationStatusAction(slug, {
                    conversationId,
                    status: 'resolved',
                    expectedVersion: version,
                  }),
                )
              }
            >
              Resolve
            </ClientButton>
          )
        ) : null}
      </div>
      <FormError message={error} />
    </div>
  );
}

/** Moves the conversation to another team (members who manage assignments). */
export function TeamControl({
  slug,
  conversationId,
  version,
  teamId,
  teams,
}: {
  slug: string;
  conversationId: string;
  version: number;
  teamId: string | null;
  teams: { id: string; name: string }[];
}) {
  const router = useRouter();
  const selectId = useId();
  // Acts on change: disabled until hydration, as in ConversationControls.
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="text-sm text-muted-foreground">
          Team
        </label>
        <Select
          id={selectId}
          className="w-auto min-w-40"
          value={teamId ?? ''}
          disabled={busy || !hydrated}
          onChange={(event) => {
            setBusy(true);
            setError(null);
            void setConversationTeamAction(slug, {
              conversationId,
              teamId: event.target.value || null,
              expectedVersion: version,
            }).then((r) => {
              setBusy(false);
              if (!r.ok) {
                setError(r.message);
                if (r.code === 'conflict') router.refresh();
              }
            });
          }}
        >
          <option value="">No team</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </div>
      <FormError message={error} />
    </div>
  );
}
