'use client';
import { AlertDialog as AD } from 'radix-ui';
import type { ReactNode } from 'react';
import { buttonVariants } from './button';
import { cn } from './cn';

/** Accessible confirmation dialog for destructive or irreversible actions. */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  destructive = false,
  children,
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** The button that closes the dialog without doing anything. */
  cancelLabel?: string;
  onConfirm: () => void;
  destructive?: boolean;
  /** Extra content between the description and the buttons (for example an optional note). */
  children?: ReactNode;
}) {
  return (
    <AD.Root>
      <AD.Trigger asChild>{trigger}</AD.Trigger>
      <AD.Portal>
        <AD.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <AD.Content className="fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-border bg-background p-6 shadow-lg focus:outline-none">
          <AD.Title className="text-base font-semibold">{title}</AD.Title>
          <AD.Description className="text-sm text-muted-foreground">{description}</AD.Description>
          {children}
          <div className="flex justify-end gap-2">
            <AD.Cancel className={buttonVariants({ variant: 'outline' })}>{cancelLabel}</AD.Cancel>
            <AD.Action
              className={cn(buttonVariants({ variant: destructive ? 'destructive' : 'primary' }))}
              onClick={onConfirm}
            >
              {confirmLabel}
            </AD.Action>
          </div>
        </AD.Content>
      </AD.Portal>
    </AD.Root>
  );
}
