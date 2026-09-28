import { describe, expect, it } from 'vitest';
import { secondsUntil } from './quota';

describe('Retry-After for a used-up month', () => {
  it('counts whole seconds up to the next period, and never less than one', () => {
    const now = new Date('2026-09-28T10:00:00.000Z');
    expect(secondsUntil(new Date('2026-10-01T00:00:00.000Z'), now)).toBe(223_200);
    expect(secondsUntil(new Date('2026-09-28T10:00:00.001Z'), now)).toBe(1);
    expect(secondsUntil(new Date('2026-09-28T10:00:01.500Z'), now)).toBe(2);
    expect(secondsUntil(now, now)).toBe(1);
    expect(secondsUntil(new Date('2026-09-28T09:00:00.000Z'), now)).toBe(1);
  });
});
