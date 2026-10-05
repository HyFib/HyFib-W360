'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@w360/ui';
import { authClient } from '@/lib/auth-client';
import { FormError } from '@/components/form-status';
import { ClientButton } from '@/components/client-form';
import { summariseAgent } from '@/lib/user-agent';

export interface SessionRow {
  id: string;
  token: string;
  createdAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export function SessionsList({
  sessions,
  currentSessionId,
}: {
  sessions: SessionRow[];
  currentSessionId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function revoke(token: string) {
    setError(null);
    const result = await authClient.revokeSession({ token });
    if (result.error) setError('Could not revoke the session.');
    router.refresh();
  }

  async function revokeOthers() {
    setError(null);
    const result = await authClient.revokeOtherSessions();
    if (result.error) setError('Could not sign out other sessions.');
    router.refresh();
  }

  return (
    <div className="grid gap-3">
      <FormError message={error} />
      <ul className="grid gap-2">
        {sessions.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
          >
            <div className="grid gap-0.5">
              <span className="font-medium">{summariseAgent(s.userAgent)}</span>
              <span className="text-xs text-muted-foreground">
                Signed in {new Date(s.createdAt).toUTCString()}
                {s.ipAddress ? ` · ${s.ipAddress}` : ''}
              </span>
            </div>
            {s.id === currentSessionId ? (
              <Badge tone="info">This device</Badge>
            ) : (
              <ClientButton size="sm" variant="outline" onClick={() => void revoke(s.token)}>
                Sign out
              </ClientButton>
            )}
          </li>
        ))}
      </ul>
      {sessions.length > 1 ? (
        <div>
          <ClientButton variant="outline" onClick={() => void revokeOthers()}>
            Sign out all other sessions
          </ClientButton>
        </div>
      ) : null}
    </div>
  );
}
