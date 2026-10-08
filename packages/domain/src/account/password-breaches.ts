import { createHash } from 'node:crypto';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@w360/contracts';

/**
 * Screening a password a person sets against passwords exposed in data breaches (ADR-317, SEC-2),
 * with the Pwned Passwords range API and k-anonymity: HyFib sends the first five characters of the
 * password's SHA-1 hash and reads the suffixes of the breached passwords that share them, so the
 * password and its full hash never leave HyFib. Responses are padded (`Add-Padding: true`): padding
 * suffixes have a count of 0 and are no breach. The request and response are as Better Auth's own
 * plugin uses them; the API's documentation could not be read from here
 * (docs/research/pwned-passwords.md).
 */

/** How long a check may take before the password is taken unchecked. */
export const PASSWORD_BREACH_CHECK_TIMEOUT_MS = 3_000;

export interface PasswordBreachCheckDeps {
  /** The range API's origin (`passwordBreachCheckFrom`). */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type PasswordBreachResult =
  | { status: 'breached'; count: number }
  | { status: 'clear' }
  /** The check could not be made; why, without the password or its hash. */
  | { status: 'unavailable'; reason: string };

/** A password's SHA-1 hash as the range API reads it: upper-case hex, cut after five characters. */
export function passwordHashRange(password: string): { prefix: string; suffix: string } {
  const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  return { prefix: hash.slice(0, 5), suffix: hash.slice(5) };
}

/**
 * How many breaches a range gives for a suffix: 0 when it is not listed, or listed as padding (the
 * most, should it be listed twice). A line that is not a suffix (35 hexadecimal characters), a
 * colon and a whole number makes the range unreadable.
 */
export function rangeBreachCount(body: string, suffix: string): number {
  const wanted = suffix.toUpperCase();
  let count = 0;
  for (const line of body.split(/\r?\n/)) {
    if (line === '') continue;
    const match = /^([0-9A-Fa-f]{35}):([0-9]{1,15})$/.exec(line);
    if (!match) throw new Error('A line of the range is not a suffix and a count.');
    const [, listed = '', times = '0'] = match;
    if (listed.toUpperCase() === wanted) count = Math.max(count, Number(times));
  }
  return count;
}

/** The auth API's requests that set a password (Better Auth's paths), and the field that holds it. */
const PASSWORD_FIELDS = new Map([
  ['/sign-up/email', 'password'],
  ['/reset-password', 'newPassword'],
  ['/change-password', 'newPassword'],
]);

/**
 * The password a request of the auth API sets: signing up, resetting a forgotten password and
 * changing one. Null for any other request, and for a password outside the lengths a person may
 * set, which the auth library refuses before anything is stored.
 */
export function passwordBeingSet(path: string | undefined, body: unknown): string | null {
  const field = path === undefined ? undefined : PASSWORD_FIELDS.get(path);
  if (field === undefined || typeof body !== 'object' || body === null) return null;
  const value: unknown = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string') return null;
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) return null;
  return value;
}

/** Checks a password with the range API: breached, clear, or unavailable and why. */
export async function checkPasswordBreaches(
  password: string,
  deps: PasswordBreachCheckDeps,
): Promise<PasswordBreachResult> {
  const { prefix, suffix } = passwordHashRange(password);
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${deps.baseUrl}/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'HyFib-W360' },
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? PASSWORD_BREACH_CHECK_TIMEOUT_MS),
    });
  } catch (error) {
    return { status: 'unavailable', reason: `request failed: ${errorName(error)}` };
  }
  if (!response.ok) return { status: 'unavailable', reason: `status ${response.status}` };
  let count: number;
  try {
    count = rangeBreachCount(await response.text(), suffix);
  } catch (error) {
    return { status: 'unavailable', reason: `range unreadable: ${errorName(error)}` };
  }
  return count > 0 ? { status: 'breached', count } : { status: 'clear' };
}

/** An error's class, never its message: a request's message can quote what it sent. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
