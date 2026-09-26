'use client';
import { useState } from 'react';
import { Button } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import { disconnectChannelAction, retryChannelSetupAction } from '@/app/actions/channels';

export function ChannelActions({
  slug,
  channelAccountId,
  status,
  label,
}: {
  slug: string;
  channelAccountId: string;
  status: string;
  label: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (!result.ok) setError(result.message);
  };
  if (status === 'disconnected') return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="grid justify-items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        {status === 'failed' || status === 'onboarding' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => retryChannelSetupAction(slug, channelAccountId))}
          >
            Retry setup
          </Button>
        ) : null}
        <ConfirmDialog
          title={`Disconnect ${label}?`}
          description="Messages to this number stop arriving here immediately and replies can no longer be sent. The number stays registered with Meta; reconnect it at any time."
          confirmLabel="Disconnect"
          destructive
          onConfirm={() => void run(() => disconnectChannelAction(slug, channelAccountId))}
          trigger={
            <Button size="sm" variant="outline" disabled={busy}>
              Disconnect
            </Button>
          }
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
