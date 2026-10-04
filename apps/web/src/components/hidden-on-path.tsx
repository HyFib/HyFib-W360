'use client';
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Shows its children except on the page whose path ends with `suffix` (for a layout banner that a
 * page explains in more detail itself).
 */
export function HiddenOnPath({ suffix, children }: { suffix: string; children: ReactNode }) {
  const pathname = usePathname();
  return pathname.endsWith(suffix) ? null : <>{children}</>;
}
