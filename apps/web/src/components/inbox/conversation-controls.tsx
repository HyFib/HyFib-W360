'use client';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Button, Select } from '@w360/ui';
import { assignConversationAction, setConversationStatusAction } from '@/app/actions/inbox';
import { FormError } from '@/components/form-status';

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
              disabled={busy}
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
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void assign(myMembershipId)}
          >
            Assign to me
          </Button>
        ) : assignedMembershipId === myMembershipId ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void assign(null)}>
            Release
          </Button>
        ) : null}
        {canReply ? (
          status === 'resolved' ? (
            <Button
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
            </Button>
          ) : (
            <Button
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
            </Button>
          )
        ) : null}
      </div>
      <FormError message={error} />
    </div>
  );
}
