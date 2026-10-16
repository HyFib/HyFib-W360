import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { parseInput } from '../validation';
import type { BusinessCalendar, BusinessInterval } from './business-hours';
import {
  SLOW_REPLY_DEFAULTS,
  SLOW_REPLY_LATE_LIMIT_MS,
  buildSlowReplyRequest,
  planSlowReply,
  renderSlowReply,
  slowReplyConsentSkip,
  slowReplyDueAt,
  slowReplyOutcome,
  slowReplySettingsSchema,
  slowReplySinceChange,
  unknownSlowReplyPlaceholder,
} from './slow-reply';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Monday to Friday, 09:00 to 17:00 in Asia/Kolkata (UTC+05:30, no daylight saving). */
const weekdays: BusinessInterval[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  opens: 9 * 60,
  closes: 17 * 60,
}));
const kolkata: BusinessCalendar = {
  timezone: 'Asia/Kolkata',
  intervals: weekdays,
  closedDays: new Set(),
};
const neverOpen: BusinessCalendar = {
  timezone: 'Asia/Kolkata',
  intervals: [],
  closedDays: new Set(),
};

function issue(input: unknown): string {
  try {
    parseInput(slowReplySettingsSchema, input);
  } catch (error) {
    if (isAppError(error)) return error.publicMessage;
    throw error;
  }
  return 'valid';
}

describe('the automatic reply’s settings (ADR-384)', () => {
  it('take a trimmed text and whole minutes from 1 to 1440', () => {
    expect(
      parseInput(slowReplySettingsSchema, {
        enabled: true,
        text: '  Thanks {{name}}, {{company}} will reply soon.  ',
        delayMinutes: '20',
      }),
    ).toEqual({
      enabled: true,
      text: 'Thanks {{name}}, {{company}} will reply soon.',
      delayMinutes: 20,
    });
    expect(issue({ enabled: true, text: 'Hi', delayMinutes: 1 })).toBe('valid');
    expect(issue({ enabled: true, text: 'Hi', delayMinutes: 1440 })).toBe('valid');
    expect(issue({ enabled: true, text: 'Hi', delayMinutes: 0 })).toMatch(/at least 1 minute/);
    expect(issue({ enabled: true, text: 'Hi', delayMinutes: 1441 })).toMatch(/at most 1440/);
    expect(issue({ enabled: true, text: 'Hi', delayMinutes: 2.5 })).toMatch(/whole minutes/);
    // The defaults are a valid setting.
    expect(issue({ enabled: false, ...SLOW_REPLY_DEFAULTS })).toBe('valid');
  });

  it('refuse an empty or long text, unknown placeholders and placeholders alone', () => {
    expect(issue({ enabled: true, text: '   ', delayMinutes: 5 })).toMatch(/Write the automatic/);
    expect(issue({ enabled: true, text: 'x'.repeat(1024), delayMinutes: 5 })).toBe('valid');
    expect(issue({ enabled: true, text: 'x'.repeat(1025), delayMinutes: 5 })).toMatch(
      /at most 1024 characters/,
    );
    expect(issue({ enabled: true, text: 'Hello {{agent}}', delayMinutes: 5 })).toBe(
      'Unknown placeholder {{agent}}. Use {{name}} or {{company}}.',
    );
    expect(issue({ enabled: true, text: '{{name}} {{ company }}', delayMinutes: 5 })).toBe(
      'Write some words besides the placeholders.',
    );
  });

  it('know the placeholders {{name}} and {{company}} in any case, and nothing else', () => {
    expect(unknownSlowReplyPlaceholder('Hi {{ Name }} from {{COMPANY}}')).toBeNull();
    expect(unknownSlowReplyPlaceholder('Hi {{answer.city}}')).toBe('{{answer.city}}');
    expect(unknownSlowReplyPlaceholder('{{name}} and {{order.number}}')).toBe('{{order.number}}');
    expect(unknownSlowReplyPlaceholder('No placeholders')).toBeNull();
  });

  it('keep the time it was turned on while it stays on', () => {
    const since = new Date('2026-10-16T08:00:00Z');
    expect(slowReplySinceChange({ enabled: false, since: null }, true)).toBe('start');
    expect(slowReplySinceChange({ enabled: true, since }, true)).toBe('keep');
    // On without a time (never happens: the database requires one) starts it.
    expect(slowReplySinceChange({ enabled: true, since: null }, true)).toBe('start');
    expect(slowReplySinceChange({ enabled: false, since }, true)).toBe('start');
    expect(slowReplySinceChange({ enabled: true, since }, false)).toBe('clear');
    expect(slowReplySinceChange({ enabled: false, since: null }, false)).toBe('clear');
  });
});

describe('when the automatic reply is due (ADR-384)', () => {
  it('counts the delay in absolute time without business hours', () => {
    const start = new Date('2026-09-25T11:00:00Z');
    expect(slowReplyDueAt(15, null, start)).toEqual(new Date('2026-09-25T11:15:00Z'));
  });

  it('counts the delay in business hours when they are on, as reply targets', () => {
    // Friday 16:50 local + 15 business minutes = Monday 09:05 local.
    expect(slowReplyDueAt(15, kolkata, new Date('2026-09-25T11:20:00Z'))).toEqual(
      new Date('2026-09-28T03:35:00Z'),
    );
    // Inside opening hours it is plain addition.
    expect(slowReplyDueAt(15, kolkata, new Date('2026-09-21T05:00:00Z'))).toEqual(
      new Date('2026-09-21T05:15:00Z'),
    );
    expect(slowReplyDueAt(15, neverOpen, new Date('2026-09-21T05:00:00Z'))).toBeNull();
  });
});

describe('what the sweep does with an open reply turn (ADR-384)', () => {
  const since = new Date('2026-09-21T00:00:00Z');
  const startedAt = new Date('2026-09-21T05:00:00Z');
  const base = {
    recorded: undefined,
    conversationStatus: 'open',
    automationActive: false,
    startedAt,
    since,
    delayMinutes: 15,
    calendar: null,
  } as const;

  it('handles a turn once its delay has passed', () => {
    const now = new Date(startedAt.getTime() + 15 * MINUTE);
    expect(planSlowReply({ ...base, now })).toEqual({
      kind: 'due',
      dueAt: new Date('2026-09-21T05:15:00Z'),
    });
    // A pending conversation still waits for a member; a waiting row is looked at again.
    expect(planSlowReply({ ...base, conversationStatus: 'pending', now }).kind).toBe('due');
    expect(planSlowReply({ ...base, recorded: 'waiting', now }).kind).toBe('due');
  });

  it('waits for a due time that is still ahead', () => {
    const now = new Date(startedAt.getTime() + 15 * MINUTE - 1);
    expect(planSlowReply({ ...base, now })).toEqual({
      kind: 'wait',
      dueAt: new Date('2026-09-21T05:15:00Z'),
    });
    // Business hours: Friday 16:50 local waits for Monday 09:05.
    const friday = new Date('2026-09-25T11:20:00Z');
    expect(
      planSlowReply({ ...base, calendar: kolkata, startedAt: friday, now: new Date(friday) }),
    ).toEqual({ kind: 'wait', dueAt: new Date('2026-09-28T03:35:00Z') });
  });

  it('looks again in a day when the calendar never opens for the delay', () => {
    const now = new Date('2026-09-22T00:00:00Z');
    expect(planSlowReply({ ...base, calendar: neverOpen, now })).toEqual({
      kind: 'wait',
      dueAt: new Date('2026-09-23T00:00:00Z'),
    });
  });

  it('never handles a turn twice, nor one an automation or a resolve owns', () => {
    const now = new Date(startedAt.getTime() + HOUR);
    expect(planSlowReply({ ...base, recorded: 'sent', now })).toEqual({ kind: 'ignore' });
    expect(planSlowReply({ ...base, recorded: 'skipped', now })).toEqual({ kind: 'ignore' });
    expect(planSlowReply({ ...base, conversationStatus: 'resolved', now })).toEqual({
      kind: 'ignore',
    });
    expect(planSlowReply({ ...base, conversationStatus: undefined, now })).toEqual({
      kind: 'ignore',
    });
    expect(planSlowReply({ ...base, automationActive: true, now })).toEqual({ kind: 'ignore' });
  });

  it('leaves waits that started before the reply was turned on', () => {
    const now = new Date(startedAt.getTime() + HOUR);
    expect(planSlowReply({ ...base, since: new Date(startedAt.getTime() + 1), now })).toEqual({
      kind: 'ignore',
    });
    // A wait that started the moment it was turned on gets it.
    expect(planSlowReply({ ...base, since: startedAt, now }).kind).toBe('due');
  });
});

describe('whether a due automatic reply is sent (ADR-384)', () => {
  const dueAt = new Date('2026-10-16T10:00:00Z');
  const ok = { dueAt, now: dueAt, channelStatus: 'active', lastInboundAt: dueAt };

  it('sends on an active number inside the service window, up to an hour late', () => {
    expect(slowReplyOutcome(ok)).toBe('send');
    const hourLate = new Date(dueAt.getTime() + SLOW_REPLY_LATE_LIMIT_MS);
    expect(slowReplyOutcome({ ...ok, now: hourLate, lastInboundAt: hourLate })).toBe('send');
    expect(
      slowReplyOutcome({
        ...ok,
        now: new Date(hourLate.getTime() + 1),
        lastInboundAt: hourLate,
      }),
    ).toBe('too_late');
    expect(SLOW_REPLY_LATE_LIMIT_MS).toBe(HOUR);
  });

  it('counts lateness from the time a waiting row was put off to, when that is later', () => {
    // The row waited until Monday morning; the delay was cut meanwhile, so the due time computed
    // now is days earlier. Looked at when it said, it is not late.
    const putOffTo = new Date(dueAt.getTime() + 60 * HOUR);
    const seen = new Date(putOffTo.getTime() + 5 * MINUTE);
    const atLook = { ...ok, now: seen, lastInboundAt: seen };
    expect(slowReplyOutcome({ ...atLook, waitedUntil: putOffTo })).toBe('send');
    expect(slowReplyOutcome({ ...atLook, waitedUntil: null })).toBe('too_late');
    expect(slowReplyOutcome(atLook)).toBe('too_late');
    // An earlier put-off time does not move lateness back.
    expect(slowReplyOutcome({ ...atLook, waitedUntil: new Date(dueAt.getTime() - HOUR) })).toBe(
      'too_late',
    );
    // A row put off and then forgotten for more than the limit is still late.
    const longAfter = new Date(putOffTo.getTime() + SLOW_REPLY_LATE_LIMIT_MS + 1);
    expect(
      slowReplyOutcome({ ...ok, now: longAfter, lastInboundAt: longAfter, waitedUntil: putOffTo }),
    ).toBe('too_late');
  });

  it('skips an inactive number and a closed window', () => {
    expect(slowReplyOutcome({ ...ok, channelStatus: 'disconnected' })).toBe('channel_inactive');
    expect(slowReplyOutcome({ ...ok, channelStatus: null })).toBe('channel_inactive');
    expect(slowReplyOutcome({ ...ok, lastInboundAt: null })).toBe('window_closed');
    expect(slowReplyOutcome({ ...ok, lastInboundAt: new Date(dueAt.getTime() - 24 * HOUR) })).toBe(
      'send',
    );
    expect(
      slowReplyOutcome({ ...ok, lastInboundAt: new Date(dueAt.getTime() - 24 * HOUR - 1) }),
    ).toBe('window_closed');
    // Lateness is decided first.
    expect(
      slowReplyOutcome({
        ...ok,
        now: new Date(dueAt.getTime() + 2 * HOUR),
        channelStatus: 'disconnected',
      }),
    ).toBe('too_late');
  });

  it('follows the contact’s consent as CSAT questions do', () => {
    expect(slowReplyConsentSkip('opted_out')).toBe('opted_out');
    expect(slowReplyConsentSkip('suppressed')).toBe('suppressed');
    expect(slowReplyConsentSkip('contact_erased')).toBe('contact_erased');
    expect(slowReplyConsentSkip('no_marketing_opt_in')).toBe('opted_out');
  });
});

describe('the automatic reply’s message (ADR-384)', () => {
  it('fills the customer’s and the company’s names', () => {
    expect(
      renderSlowReply('Hi {{name}}, {{ Company }} will reply soon.', {
        contactName: 'Priya',
        companyName: 'Tara Tea',
      }),
    ).toBe('Hi Priya, Tara Tea will reply soon.');
    // Without a name the placeholder is empty, and the text is trimmed.
    expect(
      renderSlowReply('{{name}} Thanks for waiting.', { contactName: null, companyName: 'Tara' }),
    ).toBe('Thanks for waiting.');
  });

  it('is a plain WhatsApp text without link previews', () => {
    expect(buildSlowReplyRequest('919845000001', 'Thanks for waiting.')).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919845000001',
      type: 'text',
      text: { body: 'Thanks for waiting.', preview_url: false },
    });
  });
});
