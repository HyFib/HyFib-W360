import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkPasswordBreaches,
  passwordBeingSet,
  passwordHashRange,
  rangeBreachCount,
} from './password-breaches';

const PASSWORD = 'correct horse battery staple 42';
const BASE = 'https://pwned.example.test';

/** SHA-1 of the password, upper-case hex, as the range API reads it. */
const hashOf = (password: string) =>
  createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();

/** A fetch that answers with `answer` and records what was asked. */
function fetchWith(answer: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('screening passwords against breached ones (ADR-317)', () => {
  it('cuts the SHA-1 hash after five characters, in upper case', () => {
    const hash = hashOf(PASSWORD);
    expect(passwordHashRange(PASSWORD)).toEqual({
      prefix: hash.slice(0, 5),
      suffix: hash.slice(5),
    });
    expect(passwordHashRange('password')).toEqual({
      prefix: '5BAA6',
      suffix: '1E4C9B93F3F0682250B6CF8331B7EE68FD8',
    });
  });

  it('reads a suffix’s count from a range, in any case, padding as 0, and refuses a range it cannot read', () => {
    const { suffix } = passwordHashRange(PASSWORD);
    const other = 'A'.repeat(35);
    expect(rangeBreachCount(`${other}:12\r\n${suffix}:3\r\n${'B'.repeat(35)}:0`, suffix)).toBe(3);
    expect(rangeBreachCount(`${suffix.toLowerCase()}:7`, suffix)).toBe(7);
    // Padding lists suffixes with a count of 0; one that is not listed was not breached.
    expect(rangeBreachCount(`${suffix}:0\n${other}:5`, suffix)).toBe(0);
    expect(rangeBreachCount(`${other}:5\n`, suffix)).toBe(0);
    expect(rangeBreachCount('', suffix)).toBe(0);
    // Listed twice, the larger count, wherever it is.
    expect(rangeBreachCount(`${suffix}:9\n${suffix}:0`, suffix)).toBe(9);
    expect(rangeBreachCount(`${suffix}:0\n${suffix}:9`, suffix)).toBe(9);
    for (const body of [
      `${suffix}`,
      `${suffix}:`,
      `${suffix}:-1`,
      `${suffix}:1.5`,
      `${suffix.slice(1)}:1`,
      `${suffix}0:1`,
      `${'G'.repeat(35)}:1`,
      `<html>${suffix}:1</html>`,
    ]) {
      expect(() => rangeBreachCount(body, suffix), body).toThrow();
    }
  });

  it('asks for the hash’s range only, padded, and says whether the password was breached', async () => {
    const { prefix, suffix } = passwordHashRange(PASSWORD);
    const breached = fetchWith(async () => new Response(`${'C'.repeat(35)}:1\r\n${suffix}:42`));
    expect(await checkPasswordBreaches(PASSWORD, { baseUrl: BASE, fetch: breached.fetch })).toEqual(
      {
        status: 'breached',
        count: 42,
      },
    );
    expect(breached.calls).toHaveLength(1);
    expect(breached.calls[0]!.url).toBe(`${BASE}/range/${prefix}`);
    expect(breached.calls[0]!.init).toMatchObject({
      headers: { 'Add-Padding': 'true', 'User-Agent': 'HyFib-W360' },
      redirect: 'error',
    });
    expect(breached.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    // The password and the rest of its hash never leave.
    expect(JSON.stringify(breached.calls)).not.toContain(suffix);
    expect(JSON.stringify(breached.calls)).not.toContain(PASSWORD);

    const clear = fetchWith(async () => new Response(`${suffix}:0\n${'D'.repeat(35)}:8`));
    expect(await checkPasswordBreaches(PASSWORD, { baseUrl: BASE, fetch: clear.fetch })).toEqual({
      status: 'clear',
    });
  });

  it('is unavailable, saying why without the password, when the service fails, answers an error, cannot be read or is too slow', async () => {
    const cases: [() => Promise<Response>, string][] = [
      [
        async () => Promise.reject(new TypeError(`fetch failed for ${PASSWORD}`)),
        'request failed: TypeError',
      ],
      [async () => new Response('busy', { status: 503 }), 'status 503'],
      [async () => new Response('<html>Gateway</html>'), 'range unreadable: Error'],
    ];
    for (const [answer, reason] of cases) {
      const { fetch } = fetchWith(answer);
      expect(await checkPasswordBreaches(PASSWORD, { baseUrl: BASE, fetch }), reason).toEqual({
        status: 'unavailable',
        reason,
      });
    }
    // A service that never answers is given up on after the timeout.
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    expect(
      await checkPasswordBreaches(PASSWORD, { baseUrl: BASE, fetch: hanging, timeoutMs: 5 }),
    ).toEqual({ status: 'unavailable', reason: 'request failed: TimeoutError' });
  });

  it('finds the password a request sets: signing up, resetting and changing it, within the lengths a password may have', () => {
    expect(passwordBeingSet('/sign-up/email', { email: 'a@b.test', password: PASSWORD })).toBe(
      PASSWORD,
    );
    expect(passwordBeingSet('/reset-password', { newPassword: PASSWORD, token: 't' })).toBe(
      PASSWORD,
    );
    expect(
      passwordBeingSet('/change-password', { currentPassword: 'x', newPassword: PASSWORD }),
    ).toBe(PASSWORD);
    // The password field of another request, a current password, or none.
    for (const [path, body] of [
      ['/sign-in/email', { password: PASSWORD }],
      ['/verify-password', { password: PASSWORD }],
      ['/two-factor/enable', { password: PASSWORD }],
      ['/change-password', { currentPassword: PASSWORD }],
      ['/reset-password', { password: PASSWORD }],
      ['/sign-up/email', { newPassword: PASSWORD }],
      ['/sign-up/email', null],
      ['/sign-up/email', 'password'],
      ['/sign-up/email', { password: 42 }],
      ['constructor', { password: PASSWORD }],
      ['__proto__', { password: PASSWORD }],
      [undefined, { password: PASSWORD }],
    ] as const) {
      expect(passwordBeingSet(path, body), `${path} ${JSON.stringify(body)}`).toBeNull();
    }
    // Lengths the auth library refuses anyway are not checked.
    expect(passwordBeingSet('/sign-up/email', { password: 'x'.repeat(11) })).toBeNull();
    expect(passwordBeingSet('/sign-up/email', { password: 'x'.repeat(12) })).toBe('x'.repeat(12));
    expect(passwordBeingSet('/sign-up/email', { password: 'x'.repeat(128) })).toBe('x'.repeat(128));
    expect(passwordBeingSet('/sign-up/email', { password: 'x'.repeat(129) })).toBeNull();
  });
});
