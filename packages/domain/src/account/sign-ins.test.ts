import { describe, expect, it } from 'vitest';
import {
  SIGN_IN_METHODS,
  SIGN_IN_METHOD_LABELS,
  isSignInPath,
  parseSignIns,
  signInFrom,
  signInRecorder,
  type IssuedSession,
  type SignIn,
  type SignInHookContext,
} from './sign-ins';

const issued = (twoFactorEnabled = false): IssuedSession => ({
  session: {
    id: 'ses_new',
    token: 'tok_new',
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0',
  },
  user: { id: 'usr_maya', twoFactorEnabled },
});
const same = { user: { id: 'usr_maya' } };
const other = { user: { id: 'usr_ravi' } };

describe('which requests are sign-ins (ADR-136)', () => {
  it('watches only the endpoints that sign people in', () => {
    for (const path of [
      '/sign-in/email',
      '/two-factor/verify-totp',
      '/two-factor/verify-backup-code',
      '/verify-email',
    ]) {
      expect(isSignInPath(path), path).toBe(true);
    }
    for (const path of [
      undefined,
      '/get-session',
      '/two-factor/enable',
      '/two-factor/disable',
      '/change-password',
      '/sign-up/email',
      'toString',
      '__proto__',
    ]) {
      expect(isSignInPath(path), String(path)).toBe(false);
    }
  });

  it('records the session an endpoint handed out, with its address and browser', () => {
    expect(signInFrom('/sign-in/email', issued(), null)).toEqual({
      userId: 'usr_maya',
      sessionId: 'ses_new',
      method: 'password',
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0',
    });
    const unknown = issued();
    unknown.session.ipAddress = '';
    unknown.session.userAgent = undefined;
    expect(signInFrom('/sign-in/email', unknown, null)).toMatchObject({
      ipAddress: null,
      userAgent: null,
    });
  });

  it('records nothing when no session was handed out (the two-factor plugin withdrew it)', () => {
    for (const path of [
      '/sign-in/email',
      '/two-factor/verify-totp',
      '/two-factor/verify-backup-code',
      '/verify-email',
    ]) {
      expect(signInFrom(path, null, null), path).toBeNull();
    }
  });

  it('names how: the password, a trusted device, a code, a backup code or the link', () => {
    expect(signInFrom('/sign-in/email', issued(false), null)?.method).toBe('password');
    // Two-factor on, and the password step handed out a session: the device's trust skipped it.
    expect(signInFrom('/sign-in/email', issued(true), null)?.method).toBe(
      'password_trusted_device',
    );
    expect(signInFrom('/two-factor/verify-totp', issued(true), null)?.method).toBe(
      'authenticator_code',
    );
    expect(signInFrom('/two-factor/verify-backup-code', issued(true), null)?.method).toBe(
      'backup_code',
    );
    expect(signInFrom('/verify-email', issued(), null)?.method).toBe('email_link');
  });

  it('a renewal of the same person’s session is no sign-in; a password sign-in again is one', () => {
    // Turning two-factor on renews the session on the code endpoint; the link renews it too.
    expect(signInFrom('/two-factor/verify-totp', issued(), same)).toBeNull();
    expect(signInFrom('/two-factor/verify-backup-code', issued(), same)).toBeNull();
    expect(signInFrom('/verify-email', issued(), same)).toBeNull();
    // Signing in again while signed in (a step-up) and following a link while signed in as
    // someone else are sign-ins.
    expect(signInFrom('/sign-in/email', issued(), same)?.method).toBe('password');
    expect(signInFrom('/verify-email', issued(), other)?.method).toBe('email_link');
  });

  it('records nothing for other endpoints, even when they hand out a session', () => {
    for (const path of [undefined, '/two-factor/disable', '/change-password', '/get-session']) {
      expect(signInFrom(path, issued(), null), String(path)).toBeNull();
    }
  });
});

describe('the after hook (ADR-136)', () => {
  function context(path: string, overrides: Partial<SignInHookContext['context']> = {}) {
    const deleted: string[] = [];
    const ctx: SignInHookContext = {
      path,
      context: {
        newSession: issued(),
        session: null,
        internalAdapter: {
          deleteSession: async (token: string) => {
            deleted.push(token);
          },
        },
        ...overrides,
      },
    };
    return { ctx, deleted };
  }

  it('records a sign-in once, and nothing for a request that is none', async () => {
    const recorded: SignIn[] = [];
    const errors: unknown[] = [];
    const hook = signInRecorder({
      record: async (signIn) => {
        recorded.push(signIn);
      },
      logger: { error: (obj) => errors.push(obj.err) },
    });
    await hook(context('/sign-in/email').ctx);
    await hook(context('/two-factor/verify-totp', { newSession: null }).ctx);
    await hook(context('/two-factor/verify-totp', { session: same }).ctx);
    await hook(context('/two-factor/disable').ctx);
    expect(recorded).toEqual([expect.objectContaining({ method: 'password', userId: 'usr_maya' })]);
    expect(errors).toEqual([]);
  });

  it('fails a sign-in it cannot record, deleting the session it would hand out', async () => {
    const failure = new Error('insert failed');
    const errors: unknown[] = [];
    const hook = signInRecorder({
      record: async () => {
        throw failure;
      },
      logger: { error: (obj) => errors.push(obj.err) },
    });
    const { ctx, deleted } = context('/two-factor/verify-totp');
    await expect(hook(ctx)).rejects.toBe(failure);
    expect(deleted).toEqual(['tok_new']);
    expect(errors).toEqual([]);
  });

  it('still fails with the recording error when the session cannot be deleted, and logs that', async () => {
    const failure = new Error('insert failed');
    const deleteFailure = new Error('delete failed');
    const errors: unknown[] = [];
    const hook = signInRecorder({
      record: async () => {
        throw failure;
      },
      logger: { error: (obj) => errors.push(obj.err) },
    });
    const { ctx } = context('/sign-in/email', {
      internalAdapter: {
        deleteSession: async () => {
          throw deleteFailure;
        },
      },
    });
    await expect(hook(ctx)).rejects.toBe(failure);
    expect(errors).toEqual([deleteFailure]);
  });
});

describe('reading sign-ins (ADR-136)', () => {
  it('keeps known methods, and a method this release does not know as none', () => {
    const at = new Date('2026-10-03T09:30:00Z');
    expect(
      parseSignIns([
        {
          occurred_at: at,
          method: 'backup_code',
          session_id: 'ses_1',
          ip_address: '198.51.100.4',
          user_agent: 'Safari',
        },
        {
          occurred_at: '2026-10-02T08:00:00Z',
          method: 'passkey',
          session_id: null,
          ip_address: null,
          user_agent: null,
        },
        { occurred_at: at, method: null, session_id: null, ip_address: null, user_agent: null },
      ]),
    ).toEqual([
      {
        at,
        method: 'backup_code',
        sessionId: 'ses_1',
        ipAddress: '198.51.100.4',
        userAgent: 'Safari',
      },
      {
        at: new Date('2026-10-02T08:00:00Z'),
        method: null,
        sessionId: null,
        ipAddress: null,
        userAgent: null,
      },
      { at, method: null, sessionId: null, ipAddress: null, userAgent: null },
    ]);
  });

  it('labels every method', () => {
    for (const method of SIGN_IN_METHODS) expect(SIGN_IN_METHOD_LABELS[method]).toBeTruthy();
  });
});
