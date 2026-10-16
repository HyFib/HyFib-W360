import { describe, expect, it } from 'vitest';
import {
  OVERDUE_NOTICE_LATE_LIMIT_MS,
  overdueNoticeTooLate,
  overdueReplyEmail,
  responsibleMembers,
  targetText,
  type OverdueMember,
} from './overdue-replies';

const member = (id: string, role: OverdueMember['roles'][number]): OverdueMember => ({
  id,
  roles: [role],
  optOuts: [],
  email: `${id}@example.test`,
});

const owner = member('owner', 'owner');
const supervisor = member('supervisor', 'supervisor');
const agentA = member('agent-a', 'agent');
const agentB = member('agent-b', 'agent');
const marketer = member('marketer', 'marketer');
const everyone = [owner, supervisor, agentA, agentB, marketer];
const ids = (r: { members: OverdueMember[] }) => r.members.map((m) => m.id);

describe('the members responsible for an overdue reply (ADR-230)', () => {
  it('is the member it is assigned to', () => {
    const r = responsibleMembers(
      { assignedMembershipId: 'agent-a', teamId: 'team' },
      everyone,
      new Set(['agent-b']),
    );
    expect(r.reason).toBe('assigned');
    expect(ids(r)).toEqual(['agent-a']);
  });

  it('is the team when nobody has taken it, or its member can no longer see it', () => {
    const team = new Set(['agent-a', 'agent-b', 'marketer']);
    const unassigned = responsibleMembers(
      { assignedMembershipId: null, teamId: 'team' },
      everyone,
      team,
    );
    // A marketer in the team neither sees conversations nor replies.
    expect(unassigned).toMatchObject({ reason: 'team' });
    expect(ids(unassigned)).toEqual(['agent-a', 'agent-b']);
    // Assigned to someone no longer active: agents see only their own and unassigned ones, so
    // only members of the team who see every conversation are left.
    const gone = responsibleMembers(
      { assignedMembershipId: 'removed', teamId: 'team' },
      everyone,
      new Set(['agent-a', 'supervisor']),
    );
    expect(gone).toMatchObject({ reason: 'team' });
    expect(ids(gone)).toEqual(['supervisor']);
  });

  it('is the members who assign conversations when there is no team or nobody there can answer', () => {
    const noTeam = responsibleMembers(
      { assignedMembershipId: null, teamId: null },
      everyone,
      new Set(),
    );
    expect(noTeam.reason).toBe('routing');
    expect(ids(noTeam)).toEqual(['owner', 'supervisor']);
    const emptyTeam = responsibleMembers(
      { assignedMembershipId: null, teamId: 'team' },
      everyone,
      new Set(['marketer']),
    );
    expect(emptyTeam.reason).toBe('routing');
    expect(ids(emptyTeam)).toEqual(['owner', 'supervisor']);
    // An assignee who cannot reply (a marketer) is passed over too.
    const marketerAssigned = responsibleMembers(
      { assignedMembershipId: 'marketer', teamId: null },
      everyone,
      new Set(),
    );
    expect(marketerAssigned.reason).toBe('routing');
    expect(
      responsibleMembers({ assignedMembershipId: null, teamId: null }, [agentA], new Set()),
    ).toEqual({ reason: 'routing', members: [] });
  });
});

describe('the overdue reply email (ADR-230)', () => {
  const base = { targetMinutes: 30, businessHours: false, timeZone: 'Asia/Kolkata' };
  const at = new Date('2026-10-06T04:30:00Z');

  it('names the target in words', () => {
    expect([1, 30, 60, 90, 61, 120, 1440].map(targetText)).toEqual([
      '1 minute',
      '30 minutes',
      '1 hour',
      '1 hour 30 minutes',
      '1 hour 1 minute',
      '2 hours',
      '24 hours',
    ]);
  });

  it('tells one member about one conversation, without the customer', () => {
    expect(
      overdueReplyEmail({
        ...base,
        items: [{ reason: 'assigned', teamName: null, startedAt: at }],
      }),
    ).toEqual({
      subject: 'A customer is waiting past your reply target',
      lines: [
        'A customer has waited longer than your company’s reply target of 30 minutes, in a conversation assigned to you.',
        'They have been waiting since 6 Oct 2026, 10:00 am (Asia/Kolkata).',
        'Open the conversation to reply; this email leaves out the customer’s details and messages.',
      ],
    });
    const team = overdueReplyEmail({
      ...base,
      businessHours: true,
      targetMinutes: 90,
      items: [{ reason: 'team', teamName: 'Returns', startedAt: at }],
    });
    expect(team.lines[0]).toBe(
      'A customer has waited longer than your company’s reply target of 1 hour 30 minutes of business hours, in a conversation for the Returns team that nobody has taken yet.',
    );
    expect(
      overdueReplyEmail({ ...base, items: [{ reason: 'routing', teamName: null, startedAt: at }] })
        .lines[0],
    ).toContain('in a conversation that no member who can reply has taken.');
  });

  it('names the team’s own target when the conversation’s team has one (ADR-377)', () => {
    const team = { reason: 'team' as const, teamName: 'Returns', startedAt: at };
    expect(
      overdueReplyEmail({ ...base, items: [{ ...team, teamTargetMinutes: 15 }] }).lines[0],
    ).toBe(
      'A customer has waited longer than the Returns team’s reply target of 15 minutes, in a conversation for the Returns team that nobody has taken yet.',
    );
    // The company may have no target of its own.
    const assigned = { reason: 'assigned' as const, teamName: 'Returns', teamTargetMinutes: 90 };
    expect(
      overdueReplyEmail({
        ...base,
        targetMinutes: null,
        businessHours: true,
        items: [{ ...assigned, startedAt: at }],
      }).lines[0],
    ).toBe(
      'A customer has waited longer than the Returns team’s reply target of 1 hour 30 minutes of business hours, in a conversation assigned to you.',
    );
    // A burst against one target names it; against several, says so.
    const burst = (items: Parameters<typeof overdueReplyEmail>[0]['items']) =>
      overdueReplyEmail({ ...base, items }).lines[0];
    expect(
      burst([
        { ...team, teamTargetMinutes: 15 },
        { ...team, teamTargetMinutes: 15, startedAt: new Date('2026-10-06T04:40:00Z') },
      ]),
    ).toBe('2 customers have waited longer than the Returns team’s reply target of 15 minutes.');
    expect(
      burst([
        { ...team, teamTargetMinutes: 15 },
        { reason: 'routing', teamName: null, startedAt: at },
      ]),
    ).toBe(
      '2 customers have waited longer than their reply targets: their teams’ own, or your company’s.',
    );
  });

  it('names the team’s own business hours when its due time was counted in them (ADR-389)', () => {
    const team = { reason: 'team' as const, teamName: 'Returns', startedAt: at };
    // The company's target, counted in the team's own week.
    expect(
      overdueReplyEmail({
        ...base,
        businessHours: true,
        items: [{ ...team, teamOwnHours: true }],
      }).lines[0],
    ).toBe(
      'A customer has waited longer than your company’s reply target of 30 minutes of the Returns team’s business hours, in a conversation for the Returns team that nobody has taken yet.',
    );
    // The team's own target, counted in its own week.
    expect(
      overdueReplyEmail({
        ...base,
        businessHours: true,
        items: [{ ...team, teamTargetMinutes: 15, teamOwnHours: true }],
      }).lines[0],
    ).toBe(
      'A customer has waited longer than the Returns team’s reply target of 15 minutes of its business hours, in a conversation for the Returns team that nobody has taken yet.',
    );
  });

  it('counts the replies of a burst in one email, the longest wait first', () => {
    const email = overdueReplyEmail({
      ...base,
      items: [
        { reason: 'assigned', teamName: null, startedAt: new Date('2026-10-06T05:00:00Z') },
        { reason: 'routing', teamName: null, startedAt: at },
        { reason: 'assigned', teamName: null, startedAt: new Date('2026-10-06T05:10:00Z') },
      ],
    });
    expect(email).toEqual({
      subject: '3 customers are waiting past your reply target',
      lines: [
        '3 customers have waited longer than your company’s reply target of 30 minutes.',
        'Their conversations: 2 assigned to you; 1 not taken by a member who can reply.',
        'The longest has been waiting since 6 Oct 2026, 10:00 am (Asia/Kolkata).',
        'Open the inbox, longest wait first, to reply; this email leaves out the customers’ details and messages.',
      ],
    });
  });
});

describe('when an overdue notice is too late (ADR-230, ADR-389)', () => {
  const dueAt = new Date('2026-10-12T05:00:00Z');
  const after = (ms: number) => new Date(dueAt.getTime() + ms);

  it('is more than a day after the reply was due', () => {
    expect(OVERDUE_NOTICE_LATE_LIMIT_MS).toBe(24 * 3_600_000);
    expect(
      overdueNoticeTooLate({ now: after(OVERDUE_NOTICE_LATE_LIMIT_MS), dueAt, waitedUntil: null }),
    ).toBe(false);
    expect(
      overdueNoticeTooLate({
        now: after(OVERDUE_NOTICE_LATE_LIMIT_MS + 1),
        dueAt,
        waitedUntil: null,
      }),
    ).toBe(true);
  });

  it('counts from the time a waiting notice was put off to, when that is later', () => {
    // Planned again two days after it fell due (its team's week changed): not late for having waited.
    const replanned = after(2 * 24 * 3_600_000);
    expect(
      overdueNoticeTooLate({
        now: after(2 * 24 * 3_600_000 + 60_000),
        dueAt,
        waitedUntil: replanned,
      }),
    ).toBe(false);
    expect(
      overdueNoticeTooLate({
        now: new Date(replanned.getTime() + OVERDUE_NOTICE_LATE_LIMIT_MS + 1),
        dueAt,
        waitedUntil: replanned,
      }),
    ).toBe(true);
    // An earlier time put off to changes nothing.
    expect(
      overdueNoticeTooLate({
        now: after(OVERDUE_NOTICE_LATE_LIMIT_MS + 1),
        dueAt,
        waitedUntil: new Date(dueAt.getTime() - 60_000),
      }),
    ).toBe(true);
  });
});
