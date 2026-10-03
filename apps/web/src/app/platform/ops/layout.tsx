import Link from 'next/link';
import type { ReactNode } from 'react';
import { SettingsTabs } from '@/components/settings/settings-tabs';
import { requirePlatformActor } from '@/server/session';

export const dynamic = 'force-dynamic';

const BASE = '/platform/ops';

export default async function OpsLayout({ children }: { children: ReactNode }) {
  await requirePlatformActor();
  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="grid gap-1">
        <Link href="/platform" className="text-sm text-primary underline-offset-4 hover:underline">
          ← Platform administration
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="text-sm text-muted-foreground">
          Counts, states, error codes and times only: no messages, contacts, payloads or secrets are
          shown here.
        </p>
      </div>
      <SettingsTabs
        label="Operations sections"
        tabs={[
          { href: BASE, label: 'Overview' },
          { href: `${BASE}/onboarding`, label: 'Onboarding' },
          { href: `${BASE}/integrations`, label: 'Integrations' },
          { href: `${BASE}/queues`, label: 'Queues' },
          { href: `${BASE}/signals`, label: 'Signals' },
          { href: `${BASE}/usage`, label: 'Usage' },
          { href: `${BASE}/keys`, label: 'Keys' },
        ]}
      />
      {children}
    </div>
  );
}
