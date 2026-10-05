import { authenticatedUserScope, sql, type Database } from '@w360/db';
import { recordSecurityEvent } from '../audit';

/**
 * Sign-in history for each person (SEC-9, ADR-136). Every completed sign-in is a security event
 * `auth.sign_in` naming the person, the address and browser of the session it handed out, and in
 * its details how they signed in and the session's id. The web's Better Auth plugin records it after
 * each endpoint that signs people in, once Better Auth's two-factor plugin has decided; people read
 * only their own (`ops.my_sign_ins`).
 */

export const SIGN_IN_EVENT_TYPE = 'auth.sign_in';

export const SIGN_IN_METHODS = [
  'password',
  'password_trusted_device',
  'authenticator_code',
  'backup_code',
  'email_link',
] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

export const SIGN_IN_METHOD_LABELS: Record<SignInMethod, string> = {
  password: 'Password',
  password_trusted_device: 'Password on a trusted device (no code asked)',
  authenticator_code: 'Password and authenticator code',
  backup_code: 'Password and backup code',
  email_link: 'Email confirmation link',
};

/** Better Auth's endpoints that sign people in, and how. */
const SIGN_IN_PATHS: ReadonlyMap<
  string,
  Exclude<SignInMethod, 'password_trusted_device'>
> = new Map([
  ['/sign-in/email', 'password'],
  ['/two-factor/verify-totp', 'authenticator_code'],
  ['/two-factor/verify-backup-code', 'backup_code'],
  ['/verify-email', 'email_link'],
]);

export function isSignInPath(path: string | undefined): boolean {
  return path !== undefined && SIGN_IN_PATHS.has(path);
}

/** The session an endpoint handed out, as Better Auth's context holds it (`newSession`). */
export interface IssuedSession {
  session: { id: string; token: string; ipAddress?: string | null; userAgent?: string | null };
  user: { id: string; twoFactorEnabled?: boolean | null };
}

export interface SignIn {
  userId: string;
  sessionId: string;
  method: SignInMethod;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * The sign-in an endpoint completed, if any. `issued` is the session it handed out once every
 * plugin's hook ran: the two-factor plugin deletes the one the password step creates for someone
 * with two-factor on, until a code is given, and clears it. `prior` is the session the request came
 * with, as the endpoint found it: on the code and link endpoints a session issued to someone already
 * signed in as the same person renews theirs (turning two-factor on), which is no sign-in; signing in
 * with a password again while signed in is one.
 */
export function signInFrom(
  path: string | undefined,
  issued: IssuedSession | null,
  prior: { user: { id: string } } | null,
): SignIn | null {
  const base = path === undefined ? undefined : SIGN_IN_PATHS.get(path);
  if (base === undefined || issued === null) return null;
  if (base !== 'password' && prior !== null && prior.user.id === issued.user.id) return null;
  return {
    userId: issued.user.id,
    sessionId: issued.session.id,
    // With two-factor on, a session the password step hands out is one the device's trust allowed.
    method:
      base === 'password' && issued.user.twoFactorEnabled === true
        ? 'password_trusted_device'
        : base,
    ipAddress: issued.session.ipAddress || null,
    userAgent: issued.session.userAgent || null,
  };
}

export async function recordSignIn(db: Database, signIn: SignIn): Promise<void> {
  await recordSecurityEvent(
    db,
    {
      eventType: SIGN_IN_EVENT_TYPE,
      severity: 'info',
      userId: signIn.userId,
      details: { method: signIn.method, sessionId: signIn.sessionId },
    },
    { ipAddress: signIn.ipAddress, userAgent: signIn.userAgent },
  );
}

/** What the after hook reads of Better Auth's endpoint context. */
export interface SignInHookContext {
  path?: string;
  context: {
    newSession: IssuedSession | null;
    session: { user: { id: string } } | null;
    internalAdapter: { deleteSession(token: string): Promise<unknown> };
  };
}

/**
 * The after hook of the web's Better Auth plugin: records the sign-in an endpoint completed. A
 * sign-in that cannot be recorded fails: the session it would hand out is deleted and the error
 * thrown, so every session handed out has its sign-in in the history.
 */
export function signInRecorder(deps: {
  record: (signIn: SignIn) => Promise<void>;
  logger: { error(obj: { err: unknown }, msg: string): void };
}): (ctx: SignInHookContext) => Promise<void> {
  return async (ctx) => {
    const issued = ctx.context.newSession;
    const signIn = signInFrom(ctx.path, issued, ctx.context.session);
    if (signIn === null || issued === null) return;
    try {
      await deps.record(signIn);
    } catch (error) {
      try {
        await ctx.context.internalAdapter.deleteSession(issued.session.token);
      } catch (deleteError) {
        deps.logger.error(
          { err: deleteError },
          'a session whose sign-in could not be recorded could not be deleted',
        );
      }
      throw error;
    }
  };
}

/** Sign-ins Account & security lists. */
export const SIGN_IN_HISTORY_LIMIT = 20;

export interface SignInEntry {
  at: Date;
  /** Null for a method this release does not know. */
  method: SignInMethod | null;
  sessionId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Rows of `ops.my_sign_ins`. */
export function parseSignIns(
  rows: readonly {
    occurred_at: Date | string;
    method: string | null;
    session_id: string | null;
    ip_address: string | null;
    user_agent: string | null;
  }[],
): SignInEntry[] {
  return rows.map((r) => ({
    at: new Date(r.occurred_at),
    method: SIGN_IN_METHODS.find((m) => m === r.method) ?? null,
    sessionId: r.session_id,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
  }));
}

export function createAccountService(deps: { db: Database }) {
  return {
    /**
     * The person's last sign-ins, newest first (ADR-136). The caller has authenticated `userId`
     * (their session); the database returns that person's only.
     */
    async signInHistory(userId: string, limit = SIGN_IN_HISTORY_LIMIT): Promise<SignInEntry[]> {
      const rows = await deps.db.run(
        authenticatedUserScope(userId),
        async (tx) =>
          (
            await tx.execute<{
              occurred_at: Date | string;
              method: string | null;
              session_id: string | null;
              ip_address: string | null;
              user_agent: string | null;
            }>(sql`
              select occurred_at, method, session_id, host(ip_address) as ip_address, user_agent
                from ops.my_sign_ins(${limit})`)
          ).rows,
        { accessMode: 'read only' },
      );
      return parseSignIns(rows);
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
