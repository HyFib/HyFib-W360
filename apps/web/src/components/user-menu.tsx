'use client';
import { LogOut, Shield, UserRound } from 'lucide-react';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from '@w360/ui/client';
import { authClient } from '@/lib/auth-client';

/** Full page load so no client state from the current company context survives. */
function fullNavigate(path: string) {
  window.location.assign(path);
}

export function UserMenu({
  name,
  email,
  isPlatformAdmin,
}: {
  name: string;
  email: string;
  isPlatformAdmin: boolean;
}) {
  async function signOut() {
    await authClient.signOut();
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full load deliberately drops all client state when the company/identity context changes
    window.location.assign('/sign-in');
  }
  const initials = name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <Menu>
      <MenuTrigger className="grid size-9 place-items-center rounded-full bg-secondary text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span aria-hidden="true">{initials || '?'}</span>
        <span className="sr-only">Account menu for {name}</span>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>
          <span className="block text-sm text-foreground">{name}</span>
          <span className="block truncate">{email}</span>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={() => fullNavigate('/account')}>
          <UserRound aria-hidden="true" className="size-4" /> Account & security
        </MenuItem>
        {isPlatformAdmin ? (
          <MenuItem onSelect={() => fullNavigate('/platform')}>
            <Shield aria-hidden="true" className="size-4" /> Platform administration
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem onSelect={() => void signOut()}>
          <LogOut aria-hidden="true" className="size-4" /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
