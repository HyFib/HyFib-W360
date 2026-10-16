import { describe, expect, it } from 'vitest';
import { teamSchema } from './teams';

const team = (firstResponseTargetMinutes: unknown) =>
  teamSchema.safeParse({ name: 'Returns', firstResponseTargetMinutes });
const TARGET_ERROR = 'Enter a reply target from 1 to 1,440 minutes, or leave it empty.';

describe('a team’s own reply target in its settings (ADR-377)', () => {
  it('takes 1 to 1,440 minutes, and an empty field as none', () => {
    expect(team('').data?.firstResponseTargetMinutes).toBeNull();
    expect(team(undefined).data?.firstResponseTargetMinutes).toBeNull();
    expect(team(null).data?.firstResponseTargetMinutes).toBeNull();
    expect(team('15').data?.firstResponseTargetMinutes).toBe(15);
    expect(team(1).data?.firstResponseTargetMinutes).toBe(1);
    expect(team('1440').data?.firstResponseTargetMinutes).toBe(1440);
    for (const wrong of ['0', '1441', '1.5', '-5', 'soon']) {
      const result = team(wrong);
      expect(result.success, wrong).toBe(false);
      expect(result.error?.issues[0]?.message, wrong).toBe(TARGET_ERROR);
    }
  });

  it('says what a limit takes when it is not a number', () => {
    const result = teamSchema.safeParse({ name: 'Returns', maxOpenPerMember: 'many' });
    expect(result.error?.issues[0]?.message).toBe(
      'Enter a limit from 1 to 500, or leave it empty.',
    );
    expect(teamSchema.parse({ name: 'Returns', maxOpenPerMember: '' }).maxOpenPerMember).toBeNull();
  });
});

describe('a team’s own business hours in its settings (ADR-389)', () => {
  const withHours = (businessHours: unknown) =>
    teamSchema.safeParse({ name: 'Night', businessHours });

  it('takes seven days of ranges, and nothing as the company’s business hours', () => {
    expect(teamSchema.parse({ name: 'Night' }).businessHours).toBeNull();
    expect(withHours(null).data?.businessHours).toBeNull();
    expect(
      withHours(['', '', '', '', '', '10:00-14:00', '10:00-14:00']).data?.businessHours,
    ).toEqual([
      { weekday: 6, opens: 600, closes: 840 },
      { weekday: 7, opens: 600, closes: 840 },
    ]);
  });

  it('refuses a week the company’s schedule would refuse, naming the day', () => {
    const refused = (input: unknown) =>
      withHours(input).error?.issues.map((i) => [i.path.join('.'), i.message]);
    expect(refused(['', '', '', '', '', '', ''])).toEqual([
      [
        'businessHours',
        'Add at least one opening time for the team, or let it use the company’s business hours.',
      ],
    ]);
    expect(refused(['', 'nine to five', '', '', '', '', ''])).toEqual([
      ['businessHours.1', 'Tuesday: Write times as ranges like 09:00-17:30 (got “nine to five”).'],
    ]);
    expect(
      refused([
        '09:00-10:00, 11:00-12:00, 13:00-14:00, 15:00-16:00, 17:00-18:00',
        '',
        '',
        '',
        '',
        '',
        '',
      ]),
    ).toEqual([['businessHours.0', 'Monday: Use at most 4 time ranges a day.']]);
    expect(refused('09:00-17:00')?.[0]?.[0]).toBe('businessHours');
  });
});

describe('a team’s own closed days in its settings (ADR-392)', () => {
  it('takes a list of dates, nothing as the company’s closed days, and an empty list as none', () => {
    expect(teamSchema.parse({ name: 'Care' }).closedDays).toBeNull();
    expect(teamSchema.parse({ name: 'Care', closedDays: null }).closedDays).toBeNull();
    expect(teamSchema.parse({ name: 'Care', closedDays: [] }).closedDays).toEqual([]);
    expect(
      teamSchema.parse({ name: 'Care', closedDays: ['2026-12-25', '2026-11-08', '2026-11-08'] })
        .closedDays,
    ).toEqual(['2026-11-08', '2026-12-25']);
  });

  it('refuses what is not a real date, naming the entry under closedDays', () => {
    const issues = (closedDays: unknown) =>
      teamSchema
        .safeParse({ name: 'Care', closedDays })
        .error?.issues.map((i) => [i.path.join('.'), i.message]);
    expect(issues(['2026-11-08', '2026-11-31'])).toEqual([['closedDays.1', 'Enter a real date.']]);
    expect(issues(['tomorrow'])).toEqual([['closedDays.0', 'Enter the date as YYYY-MM-DD.']]);
    expect(issues('2026-11-08')?.[0]?.[0]).toBe('closedDays');
  });
});
