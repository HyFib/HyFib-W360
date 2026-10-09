import { AppError, jsonbSize, uuidv7 } from '@w360/core';
import { and, apiIdempotencyKeys, eq, lte, type Tx } from '@w360/db';
import type { ApiContext } from './context';
import { API_LIMITS } from './model';

/** An `Idempotency-Key` header and the hash of the request it came with. */
export interface IdempotencyInput {
  key: string;
  requestHash: string;
}

/** A response of the API: status, JSON body, and whether it is a stored response replayed. */
export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Claims the idempotency key inside the request's transaction (ADR-052). A new key returns its row
 * id; the request's work and `storeIdempotentResponse` follow in the same transaction, so an error
 * rolls the claim back with the work. A key used before returns the stored response, after the
 * first request committed (a concurrent insert waits on the unique index); the same key with
 * another request is refused. An expired row is reused.
 */
export async function claimIdempotencyKey(
  tx: Tx,
  ctx: ApiContext,
  input: IdempotencyInput,
  now: Date,
): Promise<{ claimed: string } | { replay: ApiResponse }> {
  const expiresAt = new Date(now.getTime() + API_LIMITS.idempotencyHours * 3_600_000);
  const inserted = await tx
    .insert(apiIdempotencyKeys)
    .values({
      id: uuidv7(),
      tenantId: ctx.tenant.id,
      apiKeyId: ctx.key.id,
      idempotencyKey: input.key,
      requestHash: input.requestHash,
      expiresAt,
    })
    .onConflictDoNothing({
      target: [
        apiIdempotencyKeys.tenantId,
        apiIdempotencyKeys.apiKeyId,
        apiIdempotencyKeys.idempotencyKey,
      ],
    })
    .returning({ id: apiIdempotencyKeys.id });
  if (inserted[0]) return { claimed: inserted[0].id };

  const match = and(
    eq(apiIdempotencyKeys.tenantId, ctx.tenant.id),
    eq(apiIdempotencyKeys.apiKeyId, ctx.key.id),
    eq(apiIdempotencyKeys.idempotencyKey, input.key),
  );
  const recycled = await tx
    .update(apiIdempotencyKeys)
    .set({ requestHash: input.requestHash, statusCode: null, response: null, expiresAt })
    .where(and(match, lte(apiIdempotencyKeys.expiresAt, now)))
    .returning({ id: apiIdempotencyKeys.id });
  if (recycled[0]) return { claimed: recycled[0].id };

  const [existing] = await tx.select().from(apiIdempotencyKeys).where(match);
  if (!existing) throw new Error('Idempotency key vanished while it was claimed');
  if (existing.requestHash !== input.requestHash) {
    throw new AppError(
      'validation_failed',
      'This Idempotency-Key was already used with a different request. Use a new key for a new request.',
      { details: { apiReason: 'idempotency_key_reused' } },
    );
  }
  if (existing.statusCode === null || existing.response === null) {
    throw new Error('A committed idempotency key has no stored response');
  }
  return { replay: { status: existing.statusCode, body: existing.response, replayed: true } };
}

/**
 * Keeps a request's answer with its claimed key, for a retry to get it again. An answer the
 * column's check would refuse (counted at most as `pg_column_size` counts it, `jsonbSize`) is
 * refused with a reason instead (ADR-339): the request's transaction rolls back with the claim, and
 * the request can be sent again without a key.
 */
export async function storeIdempotentResponse(
  tx: Tx,
  ctx: ApiContext,
  id: string,
  response: { status: number; body: Record<string, unknown> },
): Promise<void> {
  if (jsonbSize(response.body) > API_LIMITS.idempotentResponseBytes) {
    throw new AppError(
      'validation_failed',
      `The answer to this request takes more than ${API_LIMITS.idempotentResponseBytes / 1024} KiB, too much to keep with an Idempotency-Key. Send it without one.`,
      { details: { apiReason: 'idempotency_response_too_large' } },
    );
  }
  await tx
    .update(apiIdempotencyKeys)
    .set({ statusCode: response.status, response: response.body })
    .where(and(eq(apiIdempotencyKeys.tenantId, ctx.tenant.id), eq(apiIdempotencyKeys.id, id)));
}
