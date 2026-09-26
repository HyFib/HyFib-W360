'use client';
import { DropdownMenu as DM } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from './cn';

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export const MenuGroup = DM.Group;

export function MenuContent({ children, align = 'start', className }: { children: ReactNode; align?: 'start' | 'end'; className?: string }) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        sideOffset={6}
        className={cn('z-50 min-w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md', className)}
      >
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuItem({ className, ...props }: DM.DropdownMenuItemProps) {
  return (
    <DM.Item
      className={cn('flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50', className)}
      {...props}
    />
  );
}

export function MenuLabel({ className, ...props }: DM.DropdownMenuLabelProps) {
  return <DM.Label className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...props} />;
}

export function MenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-border" />;
}
