'use client';
import { useSyncExternalStore, type FormHTMLAttributes } from 'react';
import { Button, cn, type ButtonProps } from '@w360/ui';

const noopSubscribe = () => () => {};

/**
 * True once React has hydrated this tree in the browser; always false during server rendering.
 * Controlled inputs outside a `ClientForm` stay disabled until then: React keeps a value typed
 * before hydration in the field but never reports it to `onChange`, so state misses it and the
 * next render puts the old value back.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

type ClientFormProps = Omit<FormHTMLAttributes<HTMLFormElement>, 'method' | 'action'>;

/**
 * A form submitted by a browser-side handler. Its controls stay disabled until React has hydrated,
 * so input typed before hydration cannot be silently reset (react-hook-form writes its default
 * values when fields register) and the browser can never fall back to a native submission, which
 * would place field values such as passwords in the URL. `method="post"` guards the same case.
 */
export function ClientForm({ className, children, ...props }: ClientFormProps) {
  const hydrated = useHydrated();
  return (
    <form method="post" noValidate {...props}>
      <fieldset disabled={!hydrated} className={cn('min-w-0', className)}>
        {children}
      </fieldset>
    </form>
  );
}

/**
 * A button whose click handler runs in the browser. It stays disabled until React has hydrated,
 * so a click that arrives before the handler is attached is never silently lost.
 */
export function ClientButton({ disabled, ...props }: ButtonProps) {
  const hydrated = useHydrated();
  return <Button disabled={!hydrated || disabled} {...props} />;
}
