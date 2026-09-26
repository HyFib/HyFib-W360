'use client';
import { useState } from 'react';
import { Button } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import { resolveUnknownOutcomeAction } from '@/app/actions/inbox';

/**
 * For a send whose outcome is unknown (the request may have reached WhatsApp, but no answer came
 * back). Nothing is resent automatically; a member decides.
 */
export function UnknownOutcomeActions({ slug, messageId }: { slug: string; messageId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'mark_sent' | 'resend') => {
    setBusy(true);
    setError(null);
    const result = await resolveUnknownOutcomeAction(slug, { messageId, decision });
    setBusy(false);
    if (!result.ok) setError(result.message);
  };
  return (
    <div className="mt-2 grid gap-1 text-xs">
      <p>We could not confirm whether WhatsApp received this message.</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void decide('mark_sent')}
        >
          It arrived
        </Button>
        <ConfirmDialog
          title="Send this message again?"
          description="If the first attempt did reach WhatsApp, the customer will receive the message twice."
          confirmLabel="Send again"
          onConfirm={() => void decide('resend')}
          trigger={
            <Button size="sm" variant="outline" disabled={busy}>
              Send again
            </Button>
          }
        />
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
