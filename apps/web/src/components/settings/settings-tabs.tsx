'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@w360/ui/cn';
import { needsOwnDocument } from '@/lib/document-routes';

export function SettingsTabs({
  tabs,
  label = 'Settings sections',
}: {
  tabs: { href: string; label: string }[];
  label?: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((tab, i) => {
        const active = i === 0 ? pathname === tab.href : pathname.startsWith(tab.href);
        const className = cn(
          '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active
            ? 'border-primary text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground',
        );
        // Pages with a provider SDK need a full page load for their own security policy.
        return needsOwnDocument(tab.href) ? (
          <a
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={className}
          >
            {tab.label}
          </a>
        ) : (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={className}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
