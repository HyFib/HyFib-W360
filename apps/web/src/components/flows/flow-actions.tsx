'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  duplicateFlowAction,
  flowKeysAction,
  flowLifecycleAction,
  type FlowLifecycleAction,
} from '@/app/actions/flows';
import { ClientButton } from '@/components/client-form';
import { FormError } from '@/components/form-status';

const LABELS: Record<FlowLifecycleAction, string> = {
  publish: 'Publish',
  deprecate: 'Deprecate',
  remove: 'Delete draft',
  refresh: 'Refresh from Meta',
  retry: 'Try again',
  archive: 'Archive',
  restore: 'Restore',
};

/** Irreversible at Meta: asked twice. */
const CONFIRM: Partial<Record<FlowLifecycleAction, string>> = {
  publish: 'Publishing cannot be undone: the flow can no longer change at Meta.',
  deprecate: 'Deprecating cannot be undone: the flow can no longer be sent or opened.',
  remove: 'The draft is deleted, at Meta too.',
};

export function FlowLifecycleButtons({
  slug,
  flowId,
  version,
  actions,
  canDuplicate,
}: {
  slug: string;
  flowId: string;
  version: number;
  actions: FlowLifecycleAction[];
  canDuplicate: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<FlowLifecycleAction | null>(null);
  const [confirming, setConfirming] = useState<FlowLifecycleAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (action: FlowLifecycleAction) => {
    setPending(action);
    setError(null);
    void flowLifecycleAction(slug, action, { id: flowId, expectedVersion: version }).then((r) => {
      setPending(null);
      setConfirming(null);
      if (!r.ok) setError(r.message);
    });
  };
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <ClientButton
            key={action}
            size="sm"
            variant={action === 'publish' ? 'primary' : 'outline'}
            disabled={pending !== null}
            onClick={() => (CONFIRM[action] ? setConfirming(action) : run(action))}
          >
            {pending === action ? 'Working…' : LABELS[action]}
          </ClientButton>
        ))}
        {canDuplicate ? (
          <ClientButton
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => {
              setError(null);
              void duplicateFlowAction(slug, { id: flowId }).then((r) => {
                if (!r.ok) setError(r.message);
                else router.push(`/c/${slug}/flows/${r.data.id}`);
              });
            }}
          >
            Make a new draft from it
          </ClientButton>
        ) : null}
      </div>
      {confirming ? (
        <div className="grid gap-2 rounded-md border border-border p-3 text-sm" role="alert">
          <p>{CONFIRM[confirming]}</p>
          <div className="flex gap-2">
            <ClientButton size="sm" disabled={pending !== null} onClick={() => run(confirming)}>
              {pending === confirming ? 'Working…' : `Yes, ${LABELS[confirming].toLowerCase()}`}
            </ClientButton>
            <ClientButton size="sm" variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </ClientButton>
          </div>
        </div>
      ) : null}
      <FormError message={error} />
    </div>
  );
}

export function FlowKeyButtons({
  slug,
  whatsappAccountId,
  hasKey,
  canRotate,
}: {
  slug: string;
  whatsappAccountId: string;
  hasKey: boolean;
  canRotate: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (action: 'setup' | 'rotate') => {
    setBusy(true);
    setError(null);
    setMessage(null);
    void flowKeysAction(slug, action, { whatsappAccountId }).then((r) => {
      setBusy(false);
      if (!r.ok) setError(r.message);
      else setMessage('HyFib is uploading the key to Meta. Reload in a moment to see the result.');
    });
  };
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <ClientButton size="sm" variant="outline" disabled={busy} onClick={() => run('setup')}>
          {hasKey ? 'Upload the key again' : 'Set up encryption'}
        </ClientButton>
        {hasKey && canRotate ? (
          <ClientButton size="sm" variant="outline" disabled={busy} onClick={() => run('rotate')}>
            Replace the key
          </ClientButton>
        ) : null}
      </div>
      {message ? (
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
      <FormError message={error} />
    </div>
  );
}
