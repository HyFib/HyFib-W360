import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig, type AnyPgColumn, type PgTable } from 'drizzle-orm/pg-core';

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
