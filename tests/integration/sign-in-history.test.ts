import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, uuidv7 } from '@w360/core';
import { authenticatedUserScope, sql, systemScope } from '@w360/db';
import {
  createAccountService,
  recordSecurityEvent,
  recordSignIn,
  type SignIn,
  type SignInMethod,
} from '@w360/domain';
import { connectTestDatabases, createUser, type TestDatabases } from './helpers';

/**
 * Sign-in history (SEC-9, ADR-136) against real PostgreSQL: every completed sign-in is a security
 * event `auth.sign_in`, and people read only their own, newest first, through ops.my_sign_ins; the
 * application role reads no security event otherwise. Which requests are sign-ins is decided by the
 * web's Better Auth plugin (unit tests, and the e2e test of the Account page).
 */
let dbs: TestDatabases;

async function admin<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

const signIn = (userId: string, method: SignInMethod, extra: Partial<SignIn> = {}): SignIn => ({
  userId,
  sessionId: `ses_${uuidv7()}`,
  method,
  ipAddress: '203.0.113.9',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0',
  ...extra,
});

beforeAll(() => {
  dbs = connectTestDatabases();
});

afterAll(async () => {
  await dbs.close();
});

describe('sign-in history (ADR-136)', () => {
  it('returns the person’s own sign-ins, newest first, and nobody else’s', async () => {
    const maya = await createUser(dbs);
    const ravi = await createUser(dbs);
    const account = createAccountService({ db: dbs.app });
    const first = signIn(maya.id, 'email_link', { ipAddress: '::ffff:198.51.100.7' });
    const second = signIn(maya.id, 'authenticator_code', { ipAddress: null, userAgent: null });
    const third = signIn(maya.id, 'backup_code');
    await recordSignIn(dbs.app, first);
    await recordSignIn(dbs.app, signIn(ravi.id, 'password'));
    await recordSignIn(dbs.app, second);
    // The person's other security events are no sign-ins.
    await recordSecurityEvent(dbs.app, {
      eventType: 'auth.password_reset',
      severity: 'info',
      userId: maya.id,
    });
    await recordSignIn(dbs.app, third);

    const history = await account.signInHistory(maya.id);
    expect(history.map((h) => [h.method, h.sessionId, h.ipAddress, h.userAgent])).toEqual([
      ['backup_code', third.sessionId, '203.0.113.9', third.userAgent],
      ['authenticator_code', second.sessionId, null, null],
      // An IPv4 address mapped into IPv6 is kept as IPv4.
      ['email_link', first.sessionId, '198.51.100.7', first.userAgent],
    ]);
    expect(history[0]!.at.getTime()).toBeGreaterThanOrEqual(history[1]!.at.getTime());
    expect(history[1]!.at.getTime()).toBeGreaterThanOrEqual(history[2]!.at.getTime());
    expect((await account.signInHistory(ravi.id)).map((h) => h.method)).toEqual(['password']);
    expect(await account.signInHistory((await createUser(dbs)).id)).toEqual([]);
  });

  it('returns the last 20 by default, and 100 at most', async () => {
    const lee = await createUser(dbs);
    // 105 sign-ins, one a minute over the last 105 minutes, the newest `ses_1`.
    await admin(
      `INSERT INTO ops.security_events (event_type, severity, user_id, occurred_at, details)
       SELECT 'auth.sign_in', 'info', $1, now() - make_interval(mins => g),
              jsonb_build_object('method', 'password', 'sessionId', 'ses_' || g)
         FROM generate_series(1, 105) AS g`,
      [lee.id],
    );
    const account = createAccountService({ db: dbs.app });
    expect((await account.signInHistory(lee.id)).map((h) => h.sessionId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `ses_${i + 1}`),
    );
    expect(await account.signInHistory(lee.id, 500)).toHaveLength(100);
    expect(await account.signInHistory(lee.id, 0)).toEqual([]);
    expect(await account.signInHistory(lee.id, -5)).toEqual([]);
  });

  it('refuses without a signed-in person; the application role reads no security event itself', async () => {
    await expectCode(
      dbs.app.run(systemScope, (tx) => tx.execute(sql`select * from ops.my_sign_ins(5)`)),
      'unauthenticated',
    );
    const maya = await createUser(dbs);
    await recordSignIn(dbs.app, signIn(maya.id, 'password'));
    await expectCode(
      dbs.app.run(authenticatedUserScope(maya.id), (tx) =>
        tx.execute(sql`select user_id from ops.security_events`),
      ),
      'forbidden',
    );
  });

  it('runs for the application role only, as a definer with a pinned search path', async () => {
    const fn = 'ops.my_sign_ins(integer)';
    for (const [role, allowed] of [
      ['w360_app', true],
      ['w360_platform', false],
      ['w360_auth', false],
    ] as const) {
      const [row] = await admin<{ ok: boolean }>(
        `SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`,
        [role, fn],
      );
      expect(row!.ok, role).toBe(allowed);
    }
    const [definition] = await admin<{ definer: boolean; owner: string; config: string[] }>(
      `SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [fn],
    );
    expect(definition).toEqual({
      definer: true,
      owner: 'w360_definer',
      config: ['search_path=pg_catalog, pg_temp'],
    });
    // The definer reads the columns it returns and writes none; the application role still only
    // inserts security events.
    const [grants] = await admin<Record<string, boolean>>(
      `SELECT has_column_privilege('w360_definer', 'ops.security_events', 'details', 'SELECT') AS definer_read,
              has_table_privilege('w360_definer', 'ops.security_events', 'INSERT') AS definer_insert,
              has_column_privilege('w360_definer', 'ops.security_events', 'details', 'UPDATE') AS definer_update,
              has_table_privilege('w360_app', 'ops.security_events', 'SELECT') AS app_read,
              has_table_privilege('w360_app', 'ops.security_events', 'INSERT') AS app_insert`,
    );
    expect(grants).toEqual({
      definer_read: true,
      definer_insert: false,
      definer_update: false,
      app_read: false,
      app_insert: true,
    });
  });

  it('looks a person’s sign-ins up by an index of sign-ins', async () => {
    const client = await dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT occurred_at FROM ops.security_events e
          WHERE e.event_type = 'auth.sign_in' AND e.user_id = 'usr_x'
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT 20`,
      );
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
        'security_events_sign_ins_idx',
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
