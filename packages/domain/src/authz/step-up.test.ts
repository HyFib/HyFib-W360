import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import type { TenantContext } from './context';
import {
  RECENT_SIGN_IN_MINUTES,
  assertRecentSignIn,
  hasRecentSignIn,
  recentSignInUntil,
} from './step-up';

const signedIn = new Date('2026-09-28T10:00:00Z');
const ctx = (signedInAt: Date | null) => ({ signedInAt }) as TenantContext;
const later = (minutes: number, seconds = 0) =>
  new Date(signedIn.getTime() + minutes * 60_000 + seconds * 1_000);

describe('recent sign-in (step-up, ADR-056)', () => {
  it('lasts fifteen minutes from the sign-in, the window of the authentication library', () => {
    expect(RECENT_SIGN_IN_MINUTES).toBe(15);
    expect(recentSignInUntil(ctx(signedIn))).toEqual(later(15));
    expect(hasRecentSignIn(ctx(signedIn), signedIn)).toBe(true);
    expect(hasRecentSignIn(ctx(signedIn), later(14, 59))).toBe(true);
    expect(hasRecentSignIn(ctx(signedIn), later(15))).toBe(false);
    expect(hasRecentSignIn(ctx(signedIn), later(60))).toBe(false);
  });

  it('never counts a context without an interactive sign-in', () => {
    expect(recentSignInUntil(ctx(null))).toBeNull();
    expect(hasRecentSignIn(ctx(null), signedIn)).toBe(false);
  });

  it('refuses with step_up_required and a message that says what to do', () => {
    expect(() => assertRecentSignIn(ctx(signedIn), later(14))).not.toThrow();
    for (const stale of [ctx(signedIn), ctx(null)]) {
      try {
        assertRecentSignIn(stale, later(16));
        throw new Error('expected a refusal');
      } catch (error) {
        expect(isAppError(error)).toBe(true);
        if (isAppError(error)) {
          expect(error.code).toBe('step_up_required');
          expect(error.publicMessage).toMatch(/sign in again/i);
        }
      }
    }
  });
});
