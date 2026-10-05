import { customType } from 'drizzle-orm/pg-core';
import { jsonbText } from '@w360/core';

/**
 * A jsonb column whose values are written as JSON PostgreSQL stores (ADR-131). Drizzle's own jsonb
 * writes `JSON.stringify`'s text, which escapes a lone UTF-16 surrogate (half of an emoji, cut by a
 * clip or sent as an escape) as `\ud83d`; jsonb refuses that (22P02), failing the whole statement.
 * `jsonbText` writes such a half as U+FFFD, as text columns store it. Values are read as drizzle's
 * jsonb reads them: node-postgres parses jsonb, and text is parsed when it arrives as text.
 */
export const jsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (value) => jsonbText(value),
  fromDriver: (value) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  },
});
