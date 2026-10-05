import 'server-only';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import type { Logger } from '@w360/core';
import type { Database } from '@w360/db';
import { isSignInPath, recordSignIn, signInRecorder } from '@w360/domain';

/**
 * Records each completed sign-in as a security event (SEC-9, ADR-136). Its after hook must run after
 * Better Auth's two-factor plugin's, which withdraws the session the password step created for
 * someone with two-factor on until a code is given, and before nextCookies', so that a sign-in that
 * cannot be recorded fails without setting a cookie (its session is deleted).
 */
export function signInHistory(deps: { db: Database; logger: Logger }): BetterAuthPlugin {
  const record = signInRecorder({
    record: (signIn) => recordSignIn(deps.db, signIn),
    logger: deps.logger,
  });
  return {
    id: 'w360-sign-in-history',
    hooks: {
      after: [
        {
          matcher: (ctx) => isSignInPath(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            await record(ctx);
          }),
        },
      ],
    },
  };
}
