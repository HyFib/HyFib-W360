import { describe, expect, it } from 'vitest';
import { previousKeyRetirementCutoff } from './worker';

/**
 * When an account's previous flow key may be retired (ADR-399): never while the active key's
 * upload is pending, and 24 hours after the later of its replacement and the active key's latest
 * successful upload.
 */
const GRACE_START = new Date('2026-10-15T10:00:00.000Z'); // now minus 24 hours

describe('previousKeyRetirementCutoff', () => {
  it('waits while the active key still has an upload pending, however old the replacement', () => {
    expect(
      previousKeyRetirementCutoff(GRACE_START, {
        activeUploadPending: true,
        activeLastUploadedAt: null,
      }),
    ).toBeNull();
    expect(
      previousKeyRetirementCutoff(GRACE_START, {
        activeUploadPending: true,
        activeLastUploadedAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ).toBeNull();
  });

  it('waits 24 hours after the active key’s latest successful upload', () => {
    for (const at of [GRACE_START, new Date(GRACE_START.getTime() + 1)]) {
      expect(
        previousKeyRetirementCutoff(GRACE_START, {
          activeUploadPending: false,
          activeLastUploadedAt: at,
        }),
      ).toBeNull();
    }
  });

  it('retires by the replacement time once the last upload is over 24 hours old, or there is none', () => {
    for (const at of [new Date(GRACE_START.getTime() - 1), null]) {
      expect(
        previousKeyRetirementCutoff(GRACE_START, {
          activeUploadPending: false,
          activeLastUploadedAt: at,
        }),
      ).toBe(GRACE_START);
    }
  });
});
