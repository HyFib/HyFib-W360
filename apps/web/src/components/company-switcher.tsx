'use client';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@w360/ui/client';
import { rememberCompanyAction } from '@/app/actions/tenancy';

interface Company {
  slug: string;
  name: string;
  status: string;
}

function fullNavigate(path: string) {
  window.location.assign(path);
}

/**
 * Switching company performs a full page load so no client state (drafts, caches, open streams)
 * from the previous company survives into the next one.
 */
export function CompanySwitcher({ current, companies }: { current: Company; companies: Company[] }) {
  async function switchTo(slug: string) {
    await rememberCompanyAction(slug);
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full load deliberately drops all client state when the company/identity context changes
    window.location.assign(`/c/${slug}`);
  }
  return (
    <Menu>
      <MenuTrigger className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="truncate font-medium">{current.name}</span>
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="sr-only">Switch company</span>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Your companies</MenuLabel>
        {companies.map((c) => (
          <MenuItem key={c.slug} onSelect={() => (c.slug === current.slug ? undefined : void switchTo(c.slug))}>
            <span className="flex-1 truncate">{c.name}</span>
            {c.status !== 'active' ? <span className="text-xs text-warning">{c.status}</span> : null}
            {c.slug === current.slug ? <Check aria-label="Current company" className="size-4" /> : null}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => fullNavigate('/onboarding')}>
          <Plus aria-hidden="true" className="size-4" /> Create a company
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
