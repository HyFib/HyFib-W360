import { AppError, NUL } from '@w360/core';
import { NUL_CHARACTER_MESSAGE, nulCharacterPathIn, writtenKey } from '../validation';

/**
 * Where a request's query parameters or JSON body hold the NUL character (U+0000), which PostgreSQL
 * text cannot store, or null (ADR-124): a parameter by its name as sent, the body by the path that
 * validation issues use (`contacts.1.name`; empty for the body itself), in the body's order. The
 * body is walked without recursion, so no nesting a 64 KB body allows exhausts the stack.
 */
export function nulCharacterPath(query: Record<string, string>, body: unknown): string | null {
  for (const [name, value] of Object.entries(query)) {
    if (name.includes(NUL) || value.includes(NUL)) return writtenKey(name);
  }
  return nulCharacterPathIn(body);
}

/**
 * Refuses a request whose query parameters or JSON body hold the NUL character (422, naming where),
 * before anything reads it: it would otherwise reach the database and fail as an internal error.
 */
export function assertNoNulCharacter(query: Record<string, string>, body: unknown): void {
  const path = nulCharacterPath(query, body);
  if (path !== null) {
    throw new AppError('validation_failed', NUL_CHARACTER_MESSAGE, {
      issues: [{ path, message: NUL_CHARACTER_MESSAGE }],
    });
  }
}
