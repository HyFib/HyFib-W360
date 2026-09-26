import 'server-only';
import { unstable_rethrow } from 'next/navigation';
import { isAppError, toError, type AppErrorCode, type FieldIssue } from '@w360/core';
import { getRuntime } from './runtime';
import { assertTrustedOrigin, correlationId } from './session';

export type ActionResult<T = null> =
  | { ok: true; data: T }
  | { ok: false; code: AppErrorCode; message: string; issues?: FieldIssue[]; reference?: string };

/**
 * Wraps every server action: verifies the request origin, converts typed application errors into
 * a serialisable result, lets Next.js navigation signals (redirect/notFound) propagate, and logs
 * unexpected errors with a correlation id instead of leaking internals to the browser.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await assertTrustedOrigin();
    return { ok: true, data: await fn() };
  } catch (error) {
    unstable_rethrow(error);
    if (isAppError(error)) {
      return {
        ok: false,
        code: error.code,
        message: error.publicMessage,
        ...(error.issues ? { issues: error.issues } : {}),
      };
    }
    const reference = await correlationId();
    const { logger } = await getRuntime();
    logger.error({ err: toError(error), correlationId: reference }, 'server action failed');
    return {
      ok: false,
      code: 'internal',
      message: 'Something went wrong. Please try again.',
      reference,
    };
  }
}
