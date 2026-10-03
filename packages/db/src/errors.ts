import { AppError, isAppError, withoutDriverErrors } from '@w360/core';

/**
 * Maps PostgreSQL errors raised by our SECURITY DEFINER functions (custom SQLSTATE W34xx) and a
 * few standard constraint violations into typed application errors. No error leaves with the
 * database driver's error (ADR-129): a failed query's error repeats its parameters, and
 * PostgreSQL's can repeat values in its message and detail, so it is replaced by a
 * DatabaseQueryError that keeps the SQLSTATE and the names PostgreSQL gave. Anything unmapped is
 * rethrown that way, so it is logged as an internal error without the data.
 */
interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
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
  // Our functions' W34xx messages are fixed sentences written to be shown; read before the driver's
  // error is replaced.
  const message = findPgError(error)?.message ?? 'Database error';
  const safe = withoutDriverErrors(error);
  if (isAppError(safe)) return safe;
  const pgError = findPgError(safe);
  if (!pgError) return safe;
  switch (pgError.code) {
    case 'W3401':
      return new AppError('unauthenticated', message, { cause: safe });
    case 'W3403':
      return new AppError('forbidden', message, { cause: safe });
    case 'W3404':
      return new AppError('not_found', message, { cause: safe });
    case 'W3409':
      return new AppError('conflict', message, { cause: safe });
    case 'W3412':
      return new AppError('precondition_failed', message, { cause: safe });
    case 'W3429':
      return new AppError('rate_limited', message, { cause: safe });
    case 'W3402':
      return new AppError('insufficient_funds', message, { cause: safe });
    case '23505':
      return new AppError('conflict', 'A record with the same unique value already exists.', {
        cause: safe,
        details: pgError.constraint ? { constraint: pgError.constraint } : undefined,
      });
    case '42501':
      // insufficient_privilege, including RLS WITH CHECK violations: treat as forbidden.
      return new AppError('forbidden', 'Operation not permitted.', { cause: safe });
    case '40001':
    case '40P01':
      return new AppError(
        'conflict',
        'The operation conflicted with a concurrent change. Please retry.',
        {
          cause: safe,
          details: { retryable: true },
        },
      );
    default:
      return safe;
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
