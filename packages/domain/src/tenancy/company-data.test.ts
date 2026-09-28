import { describe, expect, it } from 'vitest';
import { formatCompanyTime } from './deletion';
import { EXPORT_EXCLUDED_TABLES, EXPORT_TABLES, MEMBER_ACCOUNT_COLUMNS } from './export-spec';

describe('formatCompanyTime', () => {
  it('shows the moment in the company’s time zone with the zone named', () => {
    const at = new Date('2026-10-12T08:35:00Z');
    expect(formatCompanyTime(at, 'Asia/Kolkata')).toBe('12 October 2026 at 14:05 GMT+5:30');
    expect(formatCompanyTime(at, 'UTC')).toBe('12 October 2026 at 08:35 UTC');
    // The date follows the zone too (still 31 December in New York).
    expect(formatCompanyTime(new Date('2027-01-01T03:10:00Z'), 'America/New_York')).toBe(
      '31 December 2026 at 22:10 GMT-5',
    );
  });
});

describe('export spec', () => {
  it('names each table once, schema-qualified, and never both exported and excluded', () => {
    const tables = EXPORT_TABLES.map((spec) => spec.table);
    expect(new Set(tables).size).toBe(tables.length);
    for (const table of [...tables, ...Object.keys(EXPORT_EXCLUDED_TABLES)]) {
      expect(table).toMatch(/^(app|ops)\.[a-z][a-z0-9_]*$/);
    }
    expect(tables.filter((table) => table in EXPORT_EXCLUDED_TABLES)).toEqual([]);
    for (const reason of Object.values(EXPORT_EXCLUDED_TABLES))
      expect(reason.length).toBeGreaterThan(10);
  });

  it('lists each column once, never tenant_id, and gives a reason for every omitted column', () => {
    for (const spec of EXPORT_TABLES) {
      expect(spec.columns.length, spec.table).toBeGreaterThan(0);
      expect(new Set(spec.columns).size, spec.table).toBe(spec.columns.length);
      expect(spec.columns, spec.table).not.toContain('tenant_id');
      for (const [column, reason] of Object.entries(spec.omitted ?? {})) {
        expect(spec.columns, `${spec.table}.${column}`).not.toContain(column);
        expect(reason.length, `${spec.table}.${column}`).toBeGreaterThan(10);
      }
    }
  });

  it('adds the member’s name and email to memberships without clashing with its columns', () => {
    const memberships = EXPORT_TABLES.find((spec) => spec.table === 'app.memberships');
    expect(memberships).toBeDefined();
    for (const column of MEMBER_ACCOUNT_COLUMNS) expect(memberships!.columns).not.toContain(column);
  });
});
