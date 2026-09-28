import { isAppError, type FieldIssue } from '@w360/core';
import { sql, systemScope, type Database } from '@w360/db';

/** The JSON error body of the public API (ADR-052). */
export interface ApiErrorBody {
  error: { code: string; message: string; reason?: string; issues?: FieldIssue[] };
  requestId: string;
}

/**
 * An application error as an API response. Only the public message, field issues and a curated
 * reason leave the server; anything else is a generic 500 that the caller logs with the request id.
 */
export function apiErrorResponse(
  error: unknown,
  requestId: string,
): { status: number; body: ApiErrorBody; internal: boolean } {
  if (isAppError(error)) {
    const reason = error.details?.apiReason;
    return {
      status: error.httpStatus,
      internal: false,
      body: {
        error: {
          code: error.code,
          message: error.publicMessage,
          ...(typeof reason === 'string' ? { reason } : {}),
          ...(error.issues ? { issues: error.issues } : {}),
        },
        requestId,
      },
    };
  }
  return {
    status: 500,
    internal: true,
    body: {
      error: { code: 'internal', message: 'Something went wrong. Retry later.' },
      requestId,
    },
  };
}

/** Transport-level errors (before any service runs). */
export const apiRequestError = (
  status: number,
  code: string,
  message: string,
  requestId: string,
): { status: number; body: ApiErrorBody } => ({
  status,
  body: { error: { code, message }, requestId },
});

/** Deletes expired idempotency keys across companies (the messaging sweep's retention). */
export async function purgeApiIdempotencyKeys(db: Database, limit = 1000): Promise<number> {
  return db.run(systemScope, async (tx) => {
    const res = await tx.execute<{ purged: number }>(
      sql`select ops.purge_api_idempotency_keys(${limit}) as purged`,
    );
    return res.rows[0]?.purged ?? 0;
  });
}
