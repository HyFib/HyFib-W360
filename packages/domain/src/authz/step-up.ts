import { AppError } from '@w360/core';
import type { TenantContext } from './context';

/**
 * Step-up re-authentication (ADR-056): actions that hand out credentials, move money, take or
 * destroy the whole company's data, or weaken account security need a sign-in within the last 15
 * minutes: the window the authentication library uses for its own sensitive endpoints
 * (`session.freshAge`, set from this constant). A member who signed in earlier signs in again, with
 * their password and, when enabled, two-factor; nothing else renews the window.
 */
export const RECENT_SIGN_IN_MINUTES = 15;

/** Until when the member's sign-in counts as recent (null without an interactive session). */
export function recentSignInUntil(ctx: TenantContext): Date | null {
  return ctx.signedInAt
    ? new Date(ctx.signedInAt.getTime() + RECENT_SIGN_IN_MINUTES * 60_000)
    : null;
}

export function hasRecentSignIn(ctx: TenantContext, now: Date): boolean {
  const until = recentSignInUntil(ctx);
  return until !== null && now.getTime() < until.getTime();
}

/** Throws `step_up_required` unless the member signed in within the last 15 minutes. */
export function assertRecentSignIn(ctx: TenantContext, now: Date): void {
  if (hasRecentSignIn(ctx, now)) return;
  throw new AppError(
    'step_up_required',
    `For your security, sign in again to do this: it needs a sign-in within the last ${RECENT_SIGN_IN_MINUTES} minutes.`,
  );
}
