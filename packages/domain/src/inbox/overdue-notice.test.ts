import { describe, expect, it } from 'vitest';
import {
  WAITING_REPLY_LIMIT,
  countOverdue,
  overdueNoticeText,
  type WaitingReply,
} from './overdue-notice';

const at = (iso: string) => Date.parse(iso);
const waits: WaitingReply[] = [
  { dueAt: '2026-10-06T09:00:00.000Z', mine: true },
  { dueAt: '2026-10-06T09:05:00.000Z', mine: false },
  { dueAt: '2026-10-06T09:10:00.000Z', mine: true },
];

describe('the notice of overdue replies (ADR-241)', () => {
  it('counts the waits past due as the clock moves, those assigned to the member apart', () => {
    expect(WAITING_REPLY_LIMIT).toBe(200);
    expect(countOverdue(waits, at('2026-10-06T08:59:59.999Z'))).toEqual({ total: 0, mine: 0 });
    // Due at the very moment counts, as the inbox's own badge does.
    expect(countOverdue(waits, at('2026-10-06T09:00:00.000Z'))).toEqual({ total: 1, mine: 1 });
    expect(countOverdue(waits, at('2026-10-06T09:07:00.000Z'))).toEqual({ total: 2, mine: 1 });
    expect(countOverdue(waits, at('2026-10-06T10:00:00.000Z'))).toEqual({ total: 3, mine: 2 });
    expect(countOverdue([], at('2026-10-06T10:00:00.000Z'))).toEqual({ total: 0, mine: 0 });
  });

  it('says how many customers wait past the target, and how many of them are the member’s', () => {
    const shown = { capped: false, shown: 3 };
    expect(overdueNoticeText({ total: 0, mine: 0 }, shown)).toBeNull();
    expect(overdueNoticeText({ total: 1, mine: 0 }, shown)).toBe(
      'A customer is waiting past the reply target.',
    );
    expect(overdueNoticeText({ total: 1, mine: 1 }, shown)).toBe(
      'A customer in a conversation assigned to you is waiting past the reply target.',
    );
    expect(overdueNoticeText({ total: 3, mine: 0 }, shown)).toBe(
      '3 customers are waiting past the reply target.',
    );
    expect(overdueNoticeText({ total: 1500, mine: 1200 }, { capped: false, shown: 1500 })).toBe(
      '1,500 customers are waiting past the reply target, 1,200 of them assigned to you.',
    );
  });

  it('says “at least” when more customers wait than came with the page and all of those are late', () => {
    expect(overdueNoticeText({ total: 200, mine: 12 }, { capped: true, shown: 200 })).toBe(
      'At least 200 customers are waiting past the reply target.',
    );
    // Some of those that came are not late yet: the count is exact.
    expect(overdueNoticeText({ total: 150, mine: 0 }, { capped: true, shown: 200 })).toBe(
      '150 customers are waiting past the reply target.',
    );
  });
});
