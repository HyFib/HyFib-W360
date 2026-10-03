import { AppError } from '@w360/core';

/** What a request holding the NUL character is told (ADR-124). */
export const NUL_CHARACTER_MESSAGE = 'Text cannot hold the NUL character (U+0000).';

const NUL = '\u0000';

/** One value of a request body and how it was reached, for naming it without copying paths. */
interface Step {
  value: unknown;
  key: string | null;
  up: Step | null;
}

/** A name or key as an issue path writes it: with the NUL character written out as `\u0000`. */
const written = (part: string) => part.replaceAll(NUL, '\\u0000');

function pathOf(step: Step): string {
  const keys: string[] = [];
  for (let at: Step | null = step; at; at = at.up) if (at.key !== null) keys.push(written(at.key));
  return keys.reverse().join('.');
}

/**
 * Where a request's query parameters or JSON body hold the NUL character (U+0000), which PostgreSQL
 * text cannot store, or null (ADR-124): a parameter by its name as sent, the body by the path that
 * validation issues use (`contacts.1.name`; empty for the body itself), in the body's order. The
 * body is walked without recursion, so no nesting a 64 KB body allows exhausts the stack.
 */
export function nulCharacterPath(query: Record<string, string>, body: unknown): string | null {
  for (const [name, value] of Object.entries(query)) {
    if (name.includes(NUL) || value.includes(NUL)) return written(name);
  }
  const stack: Step[] = [{ value: body, key: null, up: null }];
  for (let step = stack.pop(); step; step = stack.pop()) {
    if (step.key?.includes(NUL)) return pathOf(step);
    const { value } = step;
    if (typeof value === 'string') {
      if (value.includes(NUL)) return pathOf(step);
    } else if (typeof value === 'object' && value !== null) {
      const entries = Array.isArray(value)
        ? value.map((item, i) => [String(i), item] as const)
        : Object.entries(value);
      // Pushed last to first, so the first is read first.
      for (const [key, item] of entries.reverse()) stack.push({ value: item, key, up: step });
    }
  }
  return null;
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
