import type { z } from 'zod';
import { AppError } from '@w360/core';

/** Parses untrusted input with a zod schema, turning failures into a typed validation error. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('validation_failed', result.error.issues[0]?.message ?? 'Invalid input', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
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

export function encodeKeysetCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

export function decodeKeysetCursor(value: string | undefined): { at: Date; id: string } | null {
  if (!value) return null;
  const [at, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  const date = at ? new Date(at) : null;
  if (!id || !/^[0-9a-f-]{36}$/.test(id) || !date || Number.isNaN(date.getTime())) {
    throw new AppError('validation_failed', 'Invalid cursor.');
  }
  return { at: date, id };
}
