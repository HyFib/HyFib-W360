import Link from 'next/link';
import { cn } from '@w360/ui/cn';

/** Deals and tasks: the two CRM pages. */
export function CrmTabs({ slug, active }: { slug: string; active: 'deals' | 'tasks' }) {
  const tabs = [
    { key: 'deals', href: `/c/${slug}/crm`, label: 'Deals' },
    { key: 'tasks', href: `/c/${slug}/crm/tasks`, label: 'Tasks' },
  ] as const;
  return (
    <nav aria-label="CRM sections" className="flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={active === tab.key ? 'page' : undefined}
          className={cn(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            active === tab.key
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
