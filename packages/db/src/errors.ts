import { AppError, isAppError } from '@w360/core';

/**
 * Maps PostgreSQL errors raised by our SECURITY DEFINER functions (custom SQLSTATE W34xx) and a
 * few standard constraint violations into typed application errors. Anything else is rethrown
 * unchanged so it is logged as an internal error.
 */
interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
  detail?: string;
}

function isPgError(value: unknown): value is PgErrorLike & Error {
  return value instanceof Error && typeof (value as PgErrorLike).code === 'string';
}

function findPgError(error: unknown): (PgErrorLike & Error) | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (isPgError(current)) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

export function mapDatabaseError(error: unknown): unknown {
  if (isAppError(error)) return error;
  const pgError = findPgError(error);
  if (!pgError) return error;
  const message = pgError.message ?? 'Database error';
  switch (pgError.code) {
    case 'W3401':
      return new AppError('unauthenticated', message, { cause: error });
    case 'W3403':
      return new AppError('forbidden', message, { cause: error });
    case 'W3404':
      return new AppError('not_found', message, { cause: error });
    case 'W3409':
      return new AppError('conflict', message, { cause: error });
    case 'W3412':
      return new AppError('precondition_failed', message, { cause: error });
    case 'W3429':
      return new AppError('rate_limited', message, { cause: error });
    case 'W3402':
      return new AppError('insufficient_funds', message, { cause: error });
    case '23505':
      return new AppError('conflict', 'A record with the same unique value already exists.', {
        cause: error,
        details: pgError.constraint ? { constraint: pgError.constraint } : undefined,
      });
    case '42501':
      // insufficient_privilege, including RLS WITH CHECK violations: treat as forbidden.
      return new AppError('forbidden', 'Operation not permitted.', { cause: error });
    case '40001':
    case '40P01':
      return new AppError('conflict', 'The operation conflicted with a concurrent change. Please retry.', {
        cause: error,
        details: { retryable: true },
      });
    default:
      return error;
  }
}

/** True when the error is a unique violation on the given constraint/index name. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = findPgError(error);
  if (pgError?.code === '23505') return constraint ? pgError.constraint === constraint : true;
  if (isAppError(error) && error.code === 'conflict' && constraint) {
    return error.details?.constraint === constraint;
  }
  return false;
}
