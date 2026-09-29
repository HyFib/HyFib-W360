import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig, type AnyPgColumn, type PgTable } from 'drizzle-orm/pg-core';

/**
 * A timestamp as text in UTC with all six fractional digits (2026-09-29T08:15:30.123456Z), for
 * keyset cursors: JavaScript dates keep milliseconds only, and rows written in one transaction
 * share now() to the microsecond, so a cursor cut to milliseconds skips the rest of them.
 */
export function exactTimestamp(column: AnyPgColumn | SQL): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * A column named with its schema and table, for correlated subqueries in select fields. Drizzle
 * leaves table names out of a select without joins, so `${table.id}` inside such a subquery would
 * bind to the subquery's own `id` column instead of the outer row's.
 */
export function outerColumn(column: AnyPgColumn): SQL {
  const { name, schema } = getTableConfig(column.table as PgTable);
  return schema
    ? sql`${sql.identifier(schema)}.${sql.identifier(name)}.${sql.identifier(column.name)}`
    : sql`${sql.identifier(name)}.${sql.identifier(column.name)}`;
}
