import type { ReactNode } from 'react';
import { Brand } from '@/components/brand';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <header className="px-6 py-5">
        <Brand />
      </header>
      <main
        id="main"
        className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:items-center"
      >
        <div className="w-full max-w-sm">{children}</div>
      </main>
      <footer className="px-6 py-4 text-center text-xs text-muted-foreground">
        Uses the official WhatsApp Business Platform. WhatsApp is a trademark of its owner; HyFib
        W360 is an independent product.
      </footer>
    </div>
  );
}
