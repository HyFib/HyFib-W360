import { describe, expect, it } from 'vitest';
import { hasAnyTarget, replyDueAt, targetFor, type ReplyTargets } from './sla';

const RETURNS = 'team-returns';

describe('reply targets per team (ADR-377)', () => {
  it('hold a conversation to its team’s own target, else the company’s', () => {
    const targets: ReplyTargets = {
      companyMinutes: 30,
      teamMinutes: new Map([[RETURNS, 10]]),
      calendar: null,
    };
    expect(targetFor(targets, RETURNS)).toEqual({ minutes: 10, calendar: null });
    expect(targetFor(targets, 'team-sales')).toEqual({ minutes: 30, calendar: null });
    expect(targetFor(targets, null)).toEqual({ minutes: 30, calendar: null });
    const start = new Date('2026-10-16T10:00:00Z');
    expect(replyDueAt(targetFor(targets, RETURNS), start)).toEqual(
      new Date('2026-10-16T10:10:00Z'),
    );
    expect(replyDueAt(targetFor(targets, null), start)).toEqual(new Date('2026-10-16T10:30:00Z'));
  });

  it('give a team’s conversations a target even when the company has none', () => {
    const targets: ReplyTargets = {
      companyMinutes: null,
      teamMinutes: new Map([[RETURNS, 45]]),
      calendar: null,
    };
    expect(hasAnyTarget(targets)).toBe(true);
    expect(targetFor(targets, RETURNS).minutes).toBe(45);
    expect(targetFor(targets, null).minutes).toBeNull();
    expect(replyDueAt(targetFor(targets, 'team-sales'), new Date())).toBeNull();
    expect(hasAnyTarget({ companyMinutes: null, teamMinutes: new Map(), calendar: null })).toBe(
      false,
    );
    expect(hasAnyTarget({ companyMinutes: 5, teamMinutes: new Map(), calendar: null })).toBe(true);
  });
});
