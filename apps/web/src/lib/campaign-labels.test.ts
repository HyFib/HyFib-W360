import { describe, expect, it } from 'vitest';
import { failureReasonLabel } from './campaign-labels';

describe('the reasons of the failed sends by reason (ADR-347)', () => {
  it('gives a code the meaning HyFib knows, marks third-party meanings and guesses none', () => {
    expect(failureReasonLabel('131049', 1)).toBe(
      'Meta limited marketing messages to this customer. Wait at least 24 hours before trying again.',
    );
    expect(failureReasonLabel('window_closed', 1)).toBe(
      'The 24-hour customer service window closed before the message could be sent.',
    );
    expect(failureReasonLabel('retryable', 1)).toBe(
      'No attempt could connect to Meta, so the message was not sent.',
    );
    expect(failureReasonLabel('131026', 1)).toBe(
      'Message undeliverable. (meaning from third-party documentation)',
    );
    // A code without a recorded meaning, a Meta code or an HTTP status alike.
    expect(failureReasonLabel('500', 1)).toBe('Not described here');
    expect(failureReasonLabel('131999', 1)).toBe('Not described here');
  });

  it('names failures without a code and the codes left over together', () => {
    expect(failureReasonLabel('', 1)).toBe('Failed without a code');
    expect(failureReasonLabel(null, 1)).toBe('1 other code');
    expect(failureReasonLabel(null, 3)).toBe('3 other codes');
  });
});
