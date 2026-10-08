import 'server-only';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import {
  PASSWORD_BREACHED_CODE,
  PASSWORD_BREACHED_MESSAGE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@w360/contracts';
import {
  isDatabaseQueryError,
  logLibraryLine,
  passwordBreachCheckFrom,
  withoutDriverErrors,
  withoutDriverErrorsFrom,
  type Logger,
  type WebConfig,
} from '@w360/core';
import { betterAuthSchema, systemScope, type Database } from '@w360/db';
import {
  checkPasswordBreaches,
  enqueueEmail,
  NUL_CHARACTER_MESSAGE,
  nulCharacterPathIn,
  passwordBeingSet,
  RECENT_SIGN_IN_MINUTES,
  recordSecurityEvent,
  type OutboxDeps,
} from '@w360/domain';
import { signInHistory } from './sign-in-history';

/**
 * Identity: email/password with mandatory email verification, TOTP two-factor with backup codes,
 * database-backed sessions (revocation takes effect immediately; no stateless cookie cache),
 * database-backed rate limits shared by all replicas, and built-in sign-up enumeration protection.
 * Better Auth queries the database on its own pool, so its failed queries never pass through
 * `db.run`: its log lines, API errors and server-side calls drop the driver's error (ADR-129).
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

  // Screening the passwords people set against breached ones (ADR-317), or null when it is off.
  const breachCheck = passwordBreachCheckFrom(config);

  const queueEmail = async (to: string, payload: Parameters<typeof enqueueEmail>[2]['payload']) => {
    await db.run(systemScope, (tx) =>
      enqueueEmail(outbox, tx, { to, payload }).then(() => undefined),
    );
  };

  const auth = betterAuth({
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
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
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
    // Members' auth forms (names, emails, passwords, tokens) are refused when they hold the NUL
    // character, as every other form is (ADR-130): PostgreSQL text cannot store it, so the query
    // would otherwise fail. A password being set that appears in known data breaches is refused
    // too (ADR-317); one that could not be checked is taken, and the check's failure logged.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (nulCharacterPathIn({ body: ctx.body, query: ctx.query, params: ctx.params }) !== null) {
          throw new APIError('BAD_REQUEST', { message: NUL_CHARACTER_MESSAGE });
        }
        const password = breachCheck ? passwordBeingSet(ctx.path, ctx.body) : null;
        if (breachCheck && password !== null) {
          const result = await checkPasswordBreaches(password, breachCheck);
          if (result.status === 'breached') {
            throw new APIError('BAD_REQUEST', {
              message: PASSWORD_BREACHED_MESSAGE,
              code: PASSWORD_BREACHED_CODE,
            });
          }
          if (result.status === 'unavailable') {
            logger.warn(
              { path: ctx.path, reason: result.reason },
              'password breach check unavailable: the password was taken unchecked',
            );
          }
        }
      }),
    },
    // Better Auth's own lines through ours: an error among a line's arguments (a failed query's
    // repeats its parameters: emails, names, session and verification tokens) is written without
    // the data it quotes, and the line's other arguments are left out.
    logger: {
      log: (level, message, ...args: unknown[]) =>
        logLibraryLine(logger, level, `better-auth: ${message}`, args),
    },
    onAPIError: {
      onError: (error) => {
        // A failed query is logged as its DatabaseQueryError; any other error by its message, as
        // before (an API error also holds the response's headers).
        const safe = withoutDriverErrors(error);
        logger.warn(
          {
            err: isDatabaseQueryError(safe)
              ? safe
              : error instanceof Error
                ? error.message
                : String(error),
          },
          'auth api error',
        );
      },
    },
    plugins: [
      twoFactor({
        issuer: 'HyFib W360',
        backupCodeOptions: { amount: 10, length: 12 },
      }),
      // After two-factor, which withdraws the password step's session until a code is given, and
      // before nextCookies: records each completed sign-in (ADR-136).
      signInHistory({ db, logger }),
      // Must be last: lets server actions set auth cookies.
      nextCookies(),
    ],
  });
  // Pages, routes and actions call these; an error they throw reaches Next.js's output.
  return { ...auth, api: withoutDriverErrorsFrom(auth.api) };
}

export type Auth = ReturnType<typeof createAuth>;
