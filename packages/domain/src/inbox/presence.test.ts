import { describe, expect, it } from 'vitest';
import { PRESENCE_NAMES, PRESENCE_REPORT_MS, PRESENCE_WINDOW_MS, presenceText } from './presence';

describe('members who have a conversation open (ADR-243)', () => {
  it('reports every 20 seconds and counts reports within 45 seconds: one report may be late', () => {
    expect(PRESENCE_REPORT_MS).toBe(20_000);
    expect(PRESENCE_WINDOW_MS).toBe(45_000);
    expect(PRESENCE_WINDOW_MS).toBeGreaterThan(2 * PRESENCE_REPORT_MS);
    expect(PRESENCE_NAMES).toBe(3);
  });

  it('names the others, and counts those beyond the names shown', () => {
    expect(presenceText({ names: [], total: 0 })).toBeNull();
    expect(presenceText({ names: ['Ravi'], total: 1 })).toBe(
      'Ravi also has this conversation open.',
    );
    expect(presenceText({ names: ['Meena', 'Ravi'], total: 2 })).toBe(
      'Meena and Ravi also have this conversation open.',
    );
    expect(presenceText({ names: ['Arun', 'Meena', 'Ravi'], total: 3 })).toBe(
      'Arun, Meena and Ravi also have this conversation open.',
    );
    expect(presenceText({ names: ['Arun', 'Meena', 'Ravi'], total: 4 })).toBe(
      'Arun, Meena, Ravi and 1 other member also have this conversation open.',
    );
    expect(presenceText({ names: ['Arun', 'Meena', 'Ravi'], total: 1503 })).toBe(
      'Arun, Meena, Ravi and 1,500 others also have this conversation open.',
    );
  });

  it('never counts fewer members than it names', () => {
    expect(presenceText({ names: ['Meena', 'Ravi'], total: 0 })).toBe(
      'Meena and Ravi also have this conversation open.',
    );
    expect(presenceText({ names: [], total: 2 })).toBe(
      '2 others also have this conversation open.',
    );
  });
});
