'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button } from '@w360/ui';
import { authClient } from '@/lib/auth-client';
import { FormError } from '@/components/form-status';

export interface SessionRow {
  id: string;
  token: string;
  createdAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export function SessionsList({ sessions, currentSessionId }: { sessions: SessionRow[]; currentSessionId: string }) {
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
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
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
              <Button size="sm" variant="outline" onClick={() => void revoke(s.token)}>Sign out</Button>
            )}
          </li>
        ))}
      </ul>
      {sessions.length > 1 ? (
        <div><Button variant="outline" onClick={() => void revokeOthers()}>Sign out all other sessions</Button></div>
      ) : null}
    </div>
  );
}

function summariseAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}
