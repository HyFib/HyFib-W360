import type { z } from 'zod';
import { AppError, NUL } from '@w360/core';

/** What text holding the NUL character is told (ADR-124, ADR-130). */
export const NUL_CHARACTER_MESSAGE = 'Text cannot hold the NUL character (U+0000).';

/** One value of an input and how it was reached, for naming it without copying paths. */
interface Step {
  value: unknown;
  key: string | null;
  up: Step | null;
}

/** A name or key as an issue path writes it: with the NUL character written out as `\u0000`. */
export const writtenKey = (part: string) => part.replaceAll(NUL, '\\u0000');

function pathOf(step: Step): string {
  const keys: string[] = [];
  for (let at: Step | null = step; at; at = at.up)
    if (at.key !== null) keys.push(writtenKey(at.key));
  return keys.reverse().join('.');
}

/**
 * Where `value` holds the NUL character (U+0000), which PostgreSQL text cannot store, or null: the
 * path validation issues use (`contacts.1.name`; empty for the value itself), in the value's order.
 * Walked without recursion, so no nesting exhausts the stack.
 */
export function nulCharacterPathIn(value: unknown): string | null {
  const stack: Step[] = [{ value, key: null, up: null }];
  for (let step = stack.pop(); step; step = stack.pop()) {
    if (step.key?.includes(NUL)) return pathOf(step);
    const at = step.value;
    if (typeof at === 'string') {
      if (at.includes(NUL)) return pathOf(step);
    } else if (typeof at === 'object' && at !== null) {
      const entries = Array.isArray(at)
        ? at.map((item, i) => [String(i), item] as const)
        : Object.entries(at);
      // Pushed last to first, so the first is read first.
      for (const [key, item] of entries.reverse()) stack.push({ value: item, key, up: step });
    }
  }
  return null;
}

/**
 * Parses untrusted input with a zod schema, turning failures into a typed validation error. What
 * the schema keeps is refused when it holds the NUL character (ADR-130), naming where: PostgreSQL
 * text cannot store it, so it would otherwise fail in the database as an internal error.
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('validation_failed', result.error.issues[0]?.message ?? 'Invalid input', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const path = nulCharacterPathIn(result.data);
  if (path !== null) {
    throw new AppError('validation_failed', NUL_CHARACTER_MESSAGE, {
      issues: [{ path, message: NUL_CHARACTER_MESSAGE }],
    });
  }
  return result.data;
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Escapes LIKE/ILIKE wildcards so user text matches literally (backslash is the escape). */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** A cursor's timestamp: UTC, ISO 8601, up to six fractional digits (cursors made before microseconds had three). */
const CURSOR_TIME_RE = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const CURSOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether a cursor's time exists as written: JavaScript turns 30 February into 2 March and 24:00
 * into the next day, where PostgreSQL refuses them, so the date must come back unchanged.
 */
function isCursorTime(at: string): boolean {
  if (!CURSOR_TIME_RE.test(at)) return false;
  const ms = Date.parse(at);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === at.slice(0, 19);
}

/**
 * A keyset cursor: the last row's timestamp exactly as PostgreSQL keeps it (select it with
 * `exactTimestamp` from @w360/db) and its id. Compare with `(column, id) < (at::timestamptz, id)`.
 */
export function encodeKeysetCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`).toString('base64url');
}

export function decodeKeysetCursor(value: string | undefined): { at: string; id: string } | null {
  if (!value) return null;
  const [at, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (!id || !CURSOR_ID_RE.test(id) || !at || !isCursorTime(at)) {
    throw new AppError('validation_failed', 'Invalid cursor.');
  }
  return { at, id };
}
