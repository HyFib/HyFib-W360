import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@w360/ui';
import { Brand } from '@/components/brand';
import { requirePlatformActor } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const actor = await requirePlatformActor();
  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-sidebar px-6 py-4">
        <div className="flex items-center gap-3">
          <Link
            href="/platform"
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Brand />
          </Link>
          <Badge tone="warning">
            Platform administration · {actor.role.replace('platform_', '')}
          </Badge>
        </div>
        <Link href="/" className="text-sm text-primary underline-offset-4 hover:underline">
          Exit to workspace
        </Link>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-8">
        {children}
      </main>
    </div>
  );
}
