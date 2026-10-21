import { conflict, type Clock } from '@w360/core';
import { sql, type Database, type Tx } from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import { recordAudit, type RequestMeta } from '../audit';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { deletionRecipients, formatCompanyTime } from './deletion';
import { EXPORT_TABLES, MEMBER_ACCOUNT_COLUMNS, type ExportTableSpec } from './export-spec';

/**
 * The company export (P5-11, ADR-055): gzip-compressed JSON Lines, streamed from one read-only,
 * repeatable-read transaction in the company's scope, so every table is read as of the same
 * moment. Nothing is stored. Lines:
 *
 * - `{"format": "hyfib-w360-company-export", "version": 1, "company": {...}, "exportedAt": ...,
 *   "tables": [...]}`
 * - `{"table": "app.contacts", "row": {...}}`, one per row, with the columns of the export spec;
 * - `{"end": true, "counts": {"app.contacts": 12, ...}}`: a file without it is incomplete.
 *
 * 64-bit integers (money in minor units) are strings; times are ISO 8601 in UTC; bytes (saved
 * replies' files, ADR-411) are base64 text.
 */
export const EXPORT_FORMAT = 'hyfib-w360-company-export';
export const EXPORT_VERSION = 1;

export interface CompanyExportDeps extends OutboxDeps {
  db: Database;
  clock: Clock;
  appBaseUrl: string;
}

const PAGE_SIZE = 1_000;

const identifier = (name: string) => `"${name.replace(/"/g, '""')}"`;
const qualified = (table: string) => table.split('.').map(identifier).join('.');

const pageSizeOf = (spec: ExportTableSpec) => spec.pageSize ?? PAGE_SIZE;

/** A row as the export writes it: bytes (a bytea column) as base64 text. */
export function exportRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
        : value;
  }
  return out;
}

/** The SQL selecting one page of a table's rows, keyset-paged by id. */
function pageQuery(spec: ExportTableSpec, afterId: string | null) {
  const columns = spec.columns.map((c) => `t.${identifier(c)}`);
  const from =
    spec.table === 'app.memberships'
      ? // Members come with the name and email of their account.
        `${qualified(spec.table)} t JOIN auth.users u ON u.id = t.user_id`
      : `${qualified(spec.table)} t`;
  if (spec.table === 'app.memberships') {
    columns.push(
      `u.name AS ${identifier(MEMBER_ACCOUNT_COLUMNS[0])}`,
      `u.email AS ${identifier(MEMBER_ACCOUNT_COLUMNS[1])}`,
    );
  }
  const hasId = spec.columns.includes('id');
  const keyset = hasId && afterId !== null ? sql` AND t.id > ${afterId}::uuid` : sql``;
  const order = hasId ? sql.raw(` ORDER BY t.id LIMIT ${pageSizeOf(spec)}`) : sql``;
  return sql`${sql.raw(`SELECT ${columns.join(', ')} FROM ${from} WHERE t.tenant_id = `)}${sql`(SELECT app.current_tenant_id())`}${keyset}${order}`;
}

async function writeTable(
  tx: Tx,
  spec: ExportTableSpec,
  write: (line: string) => Promise<void>,
): Promise<number> {
  let count = 0;
  let afterId: string | null = null;
  for (;;) {
    const result: { rows: Record<string, unknown>[] } = await tx.execute<Record<string, unknown>>(
      pageQuery(spec, afterId),
    );
    for (const row of result.rows) {
      await write(`${JSON.stringify({ table: spec.table, row: exportRow(row) })}\n`);
      count += 1;
    }
    const last: Record<string, unknown> | undefined = result.rows.at(-1);
    if (!spec.columns.includes('id') || result.rows.length < pageSizeOf(spec) || !last)
      return count;
    afterId = String(last.id);
  }
}

/**
 * Writes the company's export through `write` (which should wait while the reader is slow). The
 * start is audited and every owner and administrator is emailed first (so an export that is then
 * refused or cut short is still reported); only one export of a company runs at a time.
 */
export async function writeCompanyExport(
  deps: CompanyExportDeps,
  ctx: TenantContext,
  write: (chunk: string) => Promise<void>,
  meta: RequestMeta = {},
): Promise<{ counts: Record<string, number> }> {
  assertCan(ctx, 'tenant.export');
  const exportedAt = deps.clock.now();
  assertRecentSignIn(ctx, exportedAt);
  await deps.db.run(ctx.scope, async (tx) => {
    await recordAudit(
      tx,
      ctx,
      { action: 'tenant.exported', subjectType: 'tenant', subjectId: ctx.tenant.id },
      meta,
    );
    for (const person of await deletionRecipients(tx, ctx.tenant.id)) {
      await enqueueEmail(deps, tx, {
        to: person.email,
        tenantId: ctx.tenant.id,
        payload: {
          kind: 'tenant.notice',
          companyName: ctx.tenant.name,
          subject: 'Company data exported',
          lines: [
            `${ctx.user.name} started downloading a full export of ${ctx.tenant.name}'s data on ${formatCompanyTime(exportedAt, ctx.tenant.timezone)}.`,
            'If you did not expect this, check who has owner access in Settings, Members.',
          ],
          url: `${deps.appBaseUrl}/c/${ctx.tenant.slug}/settings/members`,
          actionLabel: 'Review members',
        },
      });
    }
  });

  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`company-export:${ctx.tenant.id}`}, 0)) as locked`,
      );
      if (lock.rows[0]?.locked !== true) {
        throw conflict('An export of this company is already running. Try again when it ends.');
      }
      await write(
        `${JSON.stringify({
          format: EXPORT_FORMAT,
          version: EXPORT_VERSION,
          company: {
            id: ctx.tenant.id,
            name: ctx.tenant.name,
            slug: ctx.tenant.slug,
            timezone: ctx.tenant.timezone,
          },
          exportedAt: exportedAt.toISOString(),
          tables: EXPORT_TABLES.map((spec) => spec.table),
        })}\n`,
      );
      const counts: Record<string, number> = {};
      for (const spec of EXPORT_TABLES) counts[spec.table] = await writeTable(tx, spec, write);
      await write(`${JSON.stringify({ end: true, counts })}\n`);
      return { counts };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
