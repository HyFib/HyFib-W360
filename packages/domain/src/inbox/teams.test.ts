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
