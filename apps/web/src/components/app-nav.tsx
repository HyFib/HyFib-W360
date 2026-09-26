'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@w360/ui/cn';
import { needsOwnDocument } from '@/lib/document-routes';

export function AppNav({
  base,
  items,
}: {
  base: string;
  items: { key: string; label: string; path: string }[];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="grid gap-1">
      {items.map((item) => {
        const href = `${base}${item.path}`;
        const active = item.path === '' ? pathname === base : pathname.startsWith(href);
        const className = cn(
          'rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active ? 'bg-accent text-foreground' : 'text-muted-foreground',
        );
        // Pages with a provider SDK need a full page load for their own security policy.
        return needsOwnDocument(href) ? (
          <a
            key={item.key}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={className}
          >
            {item.label}
          </a>
        ) : (
          <Link
            key={item.key}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={className}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
