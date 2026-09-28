import 'server-only';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { Logger, WebConfig } from '@w360/core';
import { betterAuthSchema, systemScope, type Database } from '@w360/db';
import {
  enqueueEmail,
  RECENT_SIGN_IN_MINUTES,
  recordSecurityEvent,
  type OutboxDeps,
} from '@w360/domain';

/**
 * Identity: email/password with mandatory email verification, TOTP two-factor with backup codes,
 * database-backed sessions (revocation takes effect immediately; no stateless cookie cache),
 * database-backed rate limits shared by all replicas, and built-in sign-up enumeration protection.
 */
export function createAuth(deps: {
  config: WebConfig;
  authPool: pg.Pool;
  db: Database;
  outbox: OutboxDeps;
  logger: Logger;
}) {
  const { config, db, outbox, logger } = deps;
  // Secure cookies follow the public origin, not NODE_ENV: staging and production configs must use
  // https (enforced in loadWebConfig), while loopback test stacks run `next start` over plain http,
  // where some browsers (WebKit) drop Secure cookies entirely.
  const secureCookies = new URL(config.APP_BASE_URL).protocol === 'https:';
  const trustedOrigins = [
    config.APP_BASE_URL,
    ...(config.TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ];

  const queueEmail = async (to: string, payload: Parameters<typeof enqueueEmail>[2]['payload']) => {
    await db.run(systemScope, (tx) =>
      enqueueEmail(outbox, tx, { to, payload }).then(() => undefined),
    );
  };

  return betterAuth({
    appName: 'HyFib W360',
    baseURL: config.APP_BASE_URL,
    secret: config.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle({ client: deps.authPool }), {
      provider: 'pg',
      schema: betterAuthSchema,
    }),
    trustedOrigins,
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await queueEmail(user.email, { kind: 'auth.reset_password', name: user.name, url });
      },
      onPasswordReset: async ({ user }) => {
        await queueEmail(user.email, { kind: 'auth.password_changed', name: user.name });
        await recordSecurityEvent(db, {
          eventType: 'auth.password_reset',
          severity: 'info',
          userId: user.id,
        });
      },
      onExistingUserSignUp: async ({ user }) => {
        await recordSecurityEvent(db, {
          eventType: 'auth.signup_existing_email',
          severity: 'info',
          userId: user.id,
        });
      },
      customSyntheticUser: ({ coreFields, id }) => ({ ...coreFields, id, twoFactorEnabled: false }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        await queueEmail(user.email, { kind: 'auth.verify_email', name: user.name, url });
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // The step-up window (ADR-056): the library's own sensitive endpoints and HyFib's agree.
      freshAge: RECENT_SIGN_IN_MINUTES * 60,
      cookieCache: { enabled: false },
    },
    account: { accountLinking: { enabled: false } },
    user: { deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 3600, max: 10 },
        '/request-password-reset': { window: 3600, max: 5 },
        '/send-verification-email': { window: 3600, max: 5 },
        '/two-factor/verify-totp': { window: 60, max: 5 },
        '/two-factor/verify-backup-code': { window: 60, max: 5 },
        '/verify-password': { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: secureCookies,
      cookiePrefix: 'w360',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies,
        path: '/',
      },
      ipAddress: {
        ...(config.TRUSTED_PROXIES
          ? {
              trustedProxies: config.TRUSTED_PROXIES.split(',')
                .map((p) => p.trim())
                .filter(Boolean),
            }
          : {}),
      },
    },
    onAPIError: {
      onError: (error) => {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'auth api error',
        );
      },
    },
    plugins: [
      twoFactor({
        issuer: 'HyFib W360',
        backupCodeOptions: { amount: 10, length: 12 },
      }),
      // Must be last: lets server actions set auth cookies.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
