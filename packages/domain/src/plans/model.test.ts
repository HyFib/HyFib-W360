import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../authz/permissions';
import {
  MODULE_WRITE_PERMISSIONS,
  PLAN_MODULE_KEYS,
  moduleOfPermission,
  planGivesAccess,
  usagePeriod,
} from './model';

const at = (iso: string) => new Date(iso);

describe('usagePeriod', () => {
  it('starts monthly periods on the anchor day and keeps its time of day', () => {
    const anchor = at('2026-01-05T10:30:00.000Z');
    expect(usagePeriod(anchor, at('2026-01-05T10:30:00.000Z'))).toEqual({
      start: at('2026-01-05T10:30:00.000Z'),
      end: at('2026-02-05T10:30:00.000Z'),
    });
    expect(usagePeriod(anchor, at('2026-02-05T10:29:59.999Z'))).toEqual({
      start: at('2026-01-05T10:30:00.000Z'),
      end: at('2026-02-05T10:30:00.000Z'),
    });
    // The period changes exactly at the anchor instant, not at midnight.
    expect(usagePeriod(anchor, at('2026-02-05T10:30:00.000Z')).start).toEqual(
      at('2026-02-05T10:30:00.000Z'),
    );
    expect(usagePeriod(anchor, at('2027-03-20T00:00:00.000Z'))).toEqual({
      start: at('2027-03-05T10:30:00.000Z'),
      end: at('2027-04-05T10:30:00.000Z'),
    });
  });

  it('uses the last day of shorter months and returns to the anchor day after them', () => {
    const anchor = at('2026-01-31T00:00:00.000Z');
    expect(usagePeriod(anchor, at('2026-02-15T00:00:00.000Z'))).toEqual({
      start: at('2026-01-31T00:00:00.000Z'),
      end: at('2026-02-28T00:00:00.000Z'),
    });
    expect(usagePeriod(anchor, at('2026-03-01T00:00:00.000Z'))).toEqual({
      start: at('2026-02-28T00:00:00.000Z'),
      end: at('2026-03-31T00:00:00.000Z'),
    });
    expect(usagePeriod(anchor, at('2026-04-30T12:00:00.000Z'))).toEqual({
      start: at('2026-04-30T00:00:00.000Z'),
      end: at('2026-05-31T00:00:00.000Z'),
    });
    // Leap year.
    expect(usagePeriod(anchor, at('2028-02-29T12:00:00.000Z')).start).toEqual(
      at('2028-02-29T00:00:00.000Z'),
    );
  });

  it('periods are contiguous, and a moment before the anchor falls in the first one', () => {
    const anchor = at('2026-03-31T23:59:00.000Z');
    let previous = usagePeriod(anchor, anchor);
    for (let i = 0; i < 30; i += 1) {
      const next = usagePeriod(anchor, previous.end);
      expect(next.start).toEqual(previous.end);
      expect(next.end.getTime()).toBeGreaterThan(next.start.getTime());
      previous = next;
    }
    expect(usagePeriod(anchor, at('2026-03-01T00:00:00.000Z')).start).toEqual(anchor);
  });
});

describe('plan modules', () => {
  it('each module takes away only write permissions that exist, and reading stays', () => {
    const all = new Set<string>(PERMISSIONS);
    for (const module of PLAN_MODULE_KEYS) {
      for (const permission of MODULE_WRITE_PERMISSIONS[module]) {
        expect(all.has(permission)).toBe(true);
        expect(permission.endsWith('.read')).toBe(false);
        expect(moduleOfPermission(permission)).toBe(module);
      }
    }
    expect(moduleOfPermission('automations.read')).toBeNull();
    expect(moduleOfPermission('campaigns.send')).toBeNull();
    expect(moduleOfPermission('commerce.manage')).toBe('commerce');
  });

  it('only expired and canceled plans restrict a company', () => {
    expect(planGivesAccess('complimentary')).toBe(true);
    expect(planGivesAccess('trialing')).toBe(true);
    expect(planGivesAccess('active')).toBe(true);
    expect(planGivesAccess('past_due')).toBe(true);
    expect(planGivesAccess('expired')).toBe(false);
    expect(planGivesAccess('canceled')).toBe(false);
  });
});
