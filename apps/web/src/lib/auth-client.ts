'use client';
import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

/** Browser client for the identity endpoints under /api/auth (same origin). */
export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect() {
        const next = new URLSearchParams(window.location.search).get('next');
        window.location.assign(
          next ? `/two-factor?next=${encodeURIComponent(next)}` : '/two-factor',
        );
      },
    }),
  ],
});

/** Only same-site relative paths are accepted as post-login destinations (no open redirects). */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return fallback;
  return value;
}
