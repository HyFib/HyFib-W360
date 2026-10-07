import { describe, expect, it } from 'vitest';
import {
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
