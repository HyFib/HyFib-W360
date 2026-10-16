import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope } from '@w360/db';
import {
  SLOW_REPLY_DEFAULTS,
  createBusinessHoursService,
  createContactsService,
  createInboxService,
  createSlowReplyService,
  processSendIntent,
  queueTextMessage,
  sendSlowReplies,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * The automatic reply when members are slow to answer (ADR-384) against real PostgreSQL and the
 * test-only Graph stand-in: the definer sweep query, the company-scoped pass with its row locks,
 * the rows that make each reply turn get the text at most once, the send pipeline and its check of
 * consent at send time. Customer messages take the database's time, so each sweep is given a later
 * "now" instead of waiting. The sweep reads every company's turns; assertions read only this
 * file's companies (no other file turns the automatic reply on).
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx?.close();
});

const MINUTE = 60_000;
const rate = { capacity: 1000, refillPerSecond: 1000 };
const TEXT = 'Thanks {{name}}, {{company}} will reply soon.';
const at = (when: Date): Clock => ({ now: () => when });
const later = (from: Date, minutes: number) => new Date(from.getTime() + minutes * MINUTE);
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;
const service = () => createSlowReplyService({ db: fx.dbs.app, clock: systemClock });
const sweep = (when: Date) =>
  sendSlowReplies({ db: fx.dbs.app, clock: at(when), jobs: fx.jobs(), signer: fx.signer }, 500);
const inboxService = () =>
  createInboxService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.publicMessage).toMatch(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

/** A company with the automatic reply on after `delayMinutes`. */
async function companyWithSlowReply(delayMinutes = 10) {
  const c = await fx.company();
  const owner = await fx.ctx(c, c.owner);
  await service().updateSlowReplySettings(owner, { enabled: true, text: TEXT, delayMinutes });
  return { c, owner };
}

/** A customer writes; the reply turn their message opened. */
async function waitingCustomer(c: Company, from: string, text = 'Where is my order?') {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, text }] }));
  const [turn] = await fx.query<{ id: string; conversation_id: string; started_at: Date }>(
    `SELECT t.id, t.conversation_id, t.started_at FROM app.conversation_turns t
       JOIN app.conversations cv ON cv.tenant_id = t.tenant_id AND cv.id = t.conversation_id
       JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
      WHERE t.tenant_id = $1 AND t.ended_at IS NULL AND i.wa_id = $2`,
    [c.tenant.id, from],
  );
  if (!turn) throw new Error('no open reply turn');
  return turn;
}

const row = async (turnId: string) =>
  (
    await fx.query<{
      state: string;
      due_at: Date;
      message_id: string | null;
      skip_reason: string | null;
    }>(
      `SELECT state, due_at, message_id, skip_reason FROM app.slow_reply_messages WHERE turn_id = $1`,
      [turnId],
    )
  )[0];

/** The automatic replies of a conversation, oldest first. */
const automaticReplies = (conversationId: string) =>
  fx.query<{
    id: string;
    type: string;
    sender_type: string;
    status: string;
    content: Record<string, unknown>;
  }>(
    `SELECT id, type, sender_type, status, content FROM app.messages
      WHERE conversation_id = $1 AND content->>'slowReply' = 'true' ORDER BY created_at, id`,
    [conversationId],
  );

async function send(c: Company, messageId: string) {
  const [intent] = await fx.query<{ id: string }>(
    `SELECT id FROM app.send_intents WHERE message_id = $1`,
    [messageId],
  );
  return processSendIntent(
    {
      db: fx.dbs.app,
      keyring: fx.keyring,
      graph: fx.graph,
      clock: systemClock,
      rate,
      jobs: fx.jobs(),
      signer: fx.signer,
    },
    authorizedTenantScope(c.tenant.id, null),
    intent!.id,
  );
}

describe('the automatic reply’s settings (ADR-384)', () => {
  it('start off, are validated, changed by administrators only and audited', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    expect(await service().getSlowReplySettings(agent)).toEqual({
      enabled: false,
      text: SLOW_REPLY_DEFAULTS.text,
      delayMinutes: SLOW_REPLY_DEFAULTS.delayMinutes,
    });
    await expectAppError(
      service().updateSlowReplySettings(agent, { enabled: true, text: 'Hi', delayMinutes: 5 }),
      'forbidden',
    );
    await expectAppError(
      service().updateSlowReplySettings(owner, {
        enabled: true,
        text: 'Hi {{agent}}',
        delayMinutes: 5,
      }),
      'validation_failed',
      /Unknown placeholder \{\{agent\}\}/,
    );
    await expectAppError(
      service().updateSlowReplySettings(owner, { enabled: true, text: 'Hi', delayMinutes: 0 }),
      'validation_failed',
      /at least 1 minute/,
    );

    await service().updateSlowReplySettings(owner, {
      enabled: true,
      text: TEXT,
      delayMinutes: '20',
    });
    expect(await service().getSlowReplySettings(agent)).toEqual({
      enabled: true,
      text: TEXT,
      delayMinutes: 20,
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'inbox.slow_reply_updated'`,
      [c.tenant.id],
    );
    expect(audit!.metadata).toEqual({ enabled: true, delayMinutes: 20 });

    // Saving again while on keeps the time it was turned on; turning it off clears it.
    const since = async () =>
      (
        await fx.query<{ since: Date | null }>(
          `SELECT slow_reply_since AS since FROM app.messaging_settings WHERE tenant_id = $1`,
          [c.tenant.id],
        )
      )[0]!.since;
    const first = await since();
    expect(first).toBeInstanceOf(Date);
    await service().updateSlowReplySettings(owner, { enabled: true, text: TEXT, delayMinutes: 30 });
    expect(await since()).toEqual(first);
    await service().updateSlowReplySettings(owner, {
      enabled: false,
      text: TEXT,
      delayMinutes: 30,
    });
    expect(await since()).toBeNull();
    // Turning it off needs no valid text or delay: invalid ones keep the stored values.
    await service().updateSlowReplySettings(owner, { enabled: false, text: ' ', delayMinutes: 0 });
    expect(await service().getSlowReplySettings(agent)).toEqual({
      enabled: false,
      text: TEXT,
      delayMinutes: 30,
    });
    await expectAppError(
      service().updateSlowReplySettings(owner, { enabled: true, text: ' ', delayMinutes: 30 }),
      'validation_failed',
      /Write the automatic reply/,
    );
    // The database refuses the reply on without a text, a delay or a start.
    await expect(
      fx.query(
        `UPDATE app.messaging_settings SET slow_reply_enabled = true, slow_reply_since = NULL
          WHERE tenant_id = $1`,
        [c.tenant.id],
      ),
    ).rejects.toThrow(/messaging_settings_slow_reply_on_check/);
  });
});

describe('the automatic reply when members are slow to answer (ADR-384)', () => {
  it('is sent once per wait after the delay, through the send pipeline, without ending the wait', async () => {
    const { c, owner } = await companyWithSlowReply(10);
    const phone = waId();
    const turn = await waitingCustomer(c, phone);

    // Not due yet: not even looked at.
    expect(await sweep(later(turn.started_at, 9))).toMatchObject({ sent: 0 });
    expect(await row(turn.id)).toBeUndefined();
    expect(await automaticReplies(turn.conversation_id)).toEqual([]);

    await sweep(later(turn.started_at, 11));
    const sent = await row(turn.id);
    expect(sent).toMatchObject({
      state: 'sent',
      due_at: later(turn.started_at, 10),
      skip_reason: null,
    });
    const body = `Thanks Priya Customer, Company ${c.tenant.slug} will reply soon.`;
    const [message, ...others] = await automaticReplies(turn.conversation_id);
    expect(others).toEqual([]);
    expect(message).toEqual({
      id: sent!.message_id,
      type: 'text',
      sender_type: 'system',
      status: 'queued',
      content: { text: body, slowReply: true },
    });
    const [intent] = await fx.query<{ id: string; request: unknown; actor_user_id: string | null }>(
      `SELECT id, request, actor_user_id FROM app.send_intents WHERE message_id = $1`,
      [message!.id],
    );
    expect(intent).toMatchObject({
      actor_user_id: null,
      request: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { body, preview_url: false },
      },
    });
    const [job] = await fx.query<{ data: unknown }>(
      `SELECT data FROM pgboss.job WHERE name = $1 AND singleton_key = $2`,
      [QUEUES.messageSend.name, intent!.id],
    );
    expect(fx.signer.verify(job!.data)).toMatchObject({
      kind: 'message.send',
      tenantId: c.tenant.id,
      actorUserId: null,
      ref: intent!.id,
    });

    // The thread shows it as an automatic message.
    const detail = await inboxService().getConversation(owner, turn.conversation_id);
    expect(detail.messages.find((m) => m.id === message!.id)).toMatchObject({
      direction: 'outbound',
      senderType: 'system',
      senderName: null,
      content: { text: body, slowReply: true },
    });

    // It is not a member's reply: the wait goes on.
    const [open] = await fx.query<{ ended_at: Date | null }>(
      `SELECT ended_at FROM app.conversation_turns WHERE id = $1`,
      [turn.id],
    );
    expect(open!.ended_at).toBeNull();

    // Later sweeps, and the customer writing again in the same wait, send nothing more.
    await waitingCustomer(c, phone, 'Hello?');
    await sweep(later(turn.started_at, 12));
    await sweep(later(turn.started_at, 40));
    expect(await automaticReplies(turn.conversation_id)).toHaveLength(1);

    // Meta's stand-in accepts it as a plain text.
    expect((await send(c, message!.id)).outcome).toBe('accepted');
    const request = fx.standIn.state.requests.filter((r) => r.path.endsWith('/messages')).at(-1)!;
    expect(request.body).toMatchObject({ to: phone, type: 'text', text: { body } });

    // Once a member replies the wait is over; the customer's next message starts a new one.
    await queueTextMessage(
      { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock },
      owner,
      { conversationId: turn.conversation_id, text: 'Checking now', clientKey: `slow-${turn.id}` },
    );
    const next = await waitingCustomer(c, phone, 'Any news?');
    expect(next.id).not.toBe(turn.id);
    await sweep(later(next.started_at, 11));
    expect(await row(next.id)).toMatchObject({ state: 'sent' });
    expect(await automaticReplies(turn.conversation_id)).toHaveLength(2);
  });

  it('is sent once when two sweeps run at the same time', async () => {
    const { c } = await companyWithSlowReply(10);
    const turns = [
      await waitingCustomer(c, waId()),
      await waitingCustomer(c, waId()),
      await waitingCustomer(c, waId()),
    ];
    const when = later(turns[2]!.started_at, 11);
    await Promise.all([sweep(when), sweep(when), sweep(when)]);
    for (const turn of turns) {
      expect(await row(turn.id)).toMatchObject({ state: 'sent' });
      expect(await automaticReplies(turn.conversation_id)).toHaveLength(1);
    }
  });

  it('is not sent when a member answered in time, nor in a resolved conversation', async () => {
    const { c, owner } = await companyWithSlowReply(10);
    const answered = await waitingCustomer(c, waId());
    await queueTextMessage(
      { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock },
      owner,
      {
        conversationId: answered.conversation_id,
        text: 'On its way',
        clientKey: `answered-${answered.id}`,
      },
    );
    const resolved = await waitingCustomer(c, waId());
    const [{ version }] = (await fx.query<{ version: number }>(
      `SELECT version FROM app.conversations WHERE id = $1`,
      [resolved.conversation_id],
    )) as [{ version: number }];
    await inboxService().setStatus(owner, {
      conversationId: resolved.conversation_id,
      status: 'resolved',
      expectedVersion: version,
    });

    await sweep(later(resolved.started_at, 30));
    for (const turn of [answered, resolved]) {
      expect(await row(turn.id)).toBeUndefined();
      expect(await automaticReplies(turn.conversation_id)).toEqual([]);
    }
  });

  it('is not sent to customers who were waiting before it was turned on, nor after it is off', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const before = await waitingCustomer(c, waId());
    await service().updateSlowReplySettings(owner, { enabled: true, text: TEXT, delayMinutes: 10 });
    const after = await waitingCustomer(c, waId());
    await service().updateSlowReplySettings(owner, {
      enabled: false,
      text: TEXT,
      delayMinutes: 10,
    });
    const off = await waitingCustomer(c, waId());

    await sweep(later(off.started_at, 30));
    for (const turn of [before, after, off]) {
      expect(await row(turn.id)).toBeUndefined();
      expect(await automaticReplies(turn.conversation_id)).toEqual([]);
    }
    // On again: only waits that start from now on.
    await service().updateSlowReplySettings(owner, { enabled: true, text: TEXT, delayMinutes: 10 });
    const again = await waitingCustomer(c, waId());
    await sweep(later(again.started_at, 11));
    expect(await row(again.id)).toMatchObject({ state: 'sent' });
    for (const turn of [before, after, off]) expect(await row(turn.id)).toBeUndefined();
  });

  it('is skipped for customers who opted out, outside the window, on an inactive number, or too late', async () => {
    const { c } = await companyWithSlowReply(10);
    const optedOut = await waitingCustomer(c, waId(), 'STOP');
    const late = await waitingCustomer(c, waId());
    await fx.query(
      `UPDATE app.conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`,
      [late.conversation_id],
    );
    await sweep(later(late.started_at, 11));
    expect(await row(optedOut.id)).toMatchObject({ state: 'skipped', skip_reason: 'opted_out' });
    expect(await row(late.id)).toMatchObject({ state: 'skipped', skip_reason: 'window_closed' });

    // More than an hour past its due time (the worker was down): skipped, not sent late.
    const missed = await waitingCustomer(c, waId());
    await sweep(later(missed.started_at, 10 + 61));
    expect(await row(missed.id)).toEqual({
      state: 'skipped',
      due_at: later(missed.started_at, 10),
      message_id: null,
      skip_reason: 'too_late',
    });

    const inactive = await companyWithSlowReply(10);
    const turn = await waitingCustomer(inactive.c, waId());
    await fx.query(`UPDATE app.channel_accounts SET status = 'disconnected' WHERE id = $1`, [
      inactive.c.channelAccountId,
    ]);
    await sweep(later(turn.started_at, 11));
    expect(await row(turn.id)).toMatchObject({
      state: 'skipped',
      skip_reason: 'channel_inactive',
    });

    for (const t of [optedOut, late, missed, turn]) {
      expect(await automaticReplies(t.conversation_id)).toEqual([]);
    }
  });

  it('is not sent when the customer opts out after it was queued', async () => {
    const { c } = await companyWithSlowReply(10);
    const phone = waId();
    const turn = await waitingCustomer(c, phone);
    await sweep(later(turn.started_at, 11));
    const queued = await row(turn.id);
    expect(queued).toMatchObject({ state: 'sent' });
    await waitingCustomer(c, phone, 'STOP');
    expect((await send(c, queued!.message_id!)).outcome).toBe('failed');
    const [message] = await fx.query<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM app.messages WHERE id = $1`,
      [queued!.message_id],
    );
    expect(message).toEqual({ status: 'failed', error_code: 'opted_out' });
  });

  it('is cancelled, not sent, when a member answers or resolves the conversation after it was queued', async () => {
    const { c, owner } = await companyWithSlowReply(10);
    const phones = [waId(), waId()];
    const answered = await waitingCustomer(c, phones[0]!);
    const resolved = await waitingCustomer(c, phones[1]!);
    await sweep(later(resolved.started_at, 11));
    const queued = [(await row(answered.id))!, (await row(resolved.id))!];
    expect(queued).toMatchObject([{ state: 'sent' }, { state: 'sent' }]);
    // Before the queued replies go out (the number was reconnecting, say), a member answers one
    // customer and resolves the other's conversation.
    await queueTextMessage(
      { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock },
      owner,
      {
        conversationId: answered.conversation_id,
        text: 'On its way',
        clientKey: `late-${answered.id}`,
      },
    );
    const [{ version }] = (await fx.query<{ version: number }>(
      `SELECT version FROM app.conversations WHERE id = $1`,
      [resolved.conversation_id],
    )) as [{ version: number }];
    await inboxService().setStatus(owner, {
      conversationId: resolved.conversation_id,
      status: 'resolved',
      expectedVersion: version,
    });
    for (const { message_id } of queued) {
      expect((await send(c, message_id!)).outcome).toBe('canceled');
      const [message] = await fx.query<{ status: string; error_code: string }>(
        `SELECT status, error_code FROM app.messages WHERE id = $1`,
        [message_id],
      );
      expect(message).toEqual({ status: 'canceled', error_code: 'slow_reply_answered' });
    }
    // Neither customer was sent anything.
    const sentTo = fx.standIn.state.requests
      .map((r) => (r.body as { to?: unknown } | undefined)?.to)
      .filter((to) => typeof to === 'string' && phones.includes(to));
    expect(sentTo).toEqual([]);
  });

  it('is skipped as erased for a customer erased while waiting', async () => {
    const { c, owner } = await companyWithSlowReply(10);
    const turn = await waitingCustomer(c, waId());
    const [{ contact_id }] = (await fx.query<{ contact_id: string }>(
      `SELECT contact_id FROM app.conversations WHERE id = $1`,
      [turn.conversation_id],
    )) as [{ contact_id: string }];
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: contact_id,
      suppress: false,
    });
    await sweep(later(turn.started_at, 11));
    expect(await row(turn.id)).toMatchObject({ state: 'skipped', skip_reason: 'contact_erased' });
    expect(await automaticReplies(turn.conversation_id)).toEqual([]);
  });

  it('skips a conversation another transaction holds, without waiting, and handles it next time', async () => {
    const { c } = await companyWithSlowReply(10);
    const turn = await waitingCustomer(c, waId());
    const holder = await fx.dbs.adminPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM app.conversations WHERE id = $1 FOR UPDATE', [
        turn.conversation_id,
      ]);
      // A sweep while the conversation is held neither waits for it nor records anything.
      await sweep(later(turn.started_at, 11));
      expect(await row(turn.id)).toBeUndefined();
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    await sweep(later(turn.started_at, 12));
    expect(await row(turn.id)).toMatchObject({ state: 'sent' });
    expect(await automaticReplies(turn.conversation_id)).toHaveLength(1);
  });

  it('counts the delay in business hours, and waits for the business to open', async () => {
    const { c, owner } = await companyWithSlowReply(10);
    const hours = createBusinessHoursService({ db: fx.dbs.app, clock: systemClock });
    await hours.updateBusinessHours(owner, { enabled: true, days: Array(7).fill('00:00-24:00') });
    const [{ timezone }] = (await fx.query<{ timezone: string }>(
      'SELECT timezone FROM app.tenants WHERE id = $1',
      [c.tenant.id],
    )) as [{ timezone: string }];
    const localDay = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    const first = await waitingCustomer(c, waId());
    const second = await waitingCustomer(c, waId());
    // Closed the day the customers wrote and the next (the company's dates), so the text is due
    // 10 minutes after the business opens the day after.
    const today = localDay(first.started_at);
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    await hours.addHoliday(owner, { day: today, name: 'Closed' });
    await hours.addHoliday(owner, { day: tomorrow, name: 'Closed' });

    await sweep(later(second.started_at, 11));
    const waiting = await row(first.id);
    expect(waiting).toMatchObject({ state: 'waiting', message_id: null, skip_reason: null });
    expect(await row(second.id)).toMatchObject({ state: 'waiting', due_at: waiting!.due_at });
    expect(waiting!.due_at.getTime()).toBeGreaterThan(later(first.started_at, 24 * 60).getTime());
    expect(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(waiting!.due_at),
    ).toBe('00:10');

    // Not looked at again before its due time.
    await sweep(new Date(waiting!.due_at.getTime() - MINUTE));
    expect(await row(first.id)).toMatchObject({ state: 'waiting' });

    // By then the first customer's window has closed unless they wrote again: the second wrote an
    // hour before (set directly, as the clock is not moved).
    await fx.query(`UPDATE app.conversations SET last_inbound_at = $1 WHERE id = $2`, [
      new Date(waiting!.due_at.getTime() - 60 * MINUTE),
      second.conversation_id,
    ]);
    await sweep(new Date(waiting!.due_at.getTime() + MINUTE));
    expect(await row(first.id)).toMatchObject({ state: 'skipped', skip_reason: 'window_closed' });
    expect(await row(second.id)).toMatchObject({ state: 'sent', due_at: waiting!.due_at });
    expect(await automaticReplies(second.conversation_id)).toHaveLength(1);
    expect(await automaticReplies(first.conversation_id)).toEqual([]);
  });

  it('lets only the runtime role run the sweep query, and keeps sent rows as they are', async () => {
    const [fn] = await fx.query<{ public: boolean; app: boolean; owner: string; definer: boolean }>(
      `SELECT has_function_privilege('public', p.oid, 'EXECUTE') AS public,
              has_function_privilege('w360_app', p.oid, 'EXECUTE') AS app,
              pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer
         FROM pg_proc p WHERE p.oid = 'ops.slow_reply_turns(timestamptz,integer)'::regprocedure`,
    );
    expect(fn).toEqual({ public: false, app: true, owner: 'w360_definer', definer: true });
    const { c } = await companyWithSlowReply(10);
    const turn = await waitingCustomer(c, waId());
    await sweep(later(turn.started_at, 11));
    expect(await row(turn.id)).toMatchObject({ state: 'sent' });
    await expect(
      fx.query(`UPDATE app.slow_reply_messages SET due_at = now() WHERE turn_id = $1`, [turn.id]),
    ).rejects.toThrow(/cannot change/);
    // A second row for the same turn is refused.
    await expect(
      fx.query(
        `INSERT INTO app.slow_reply_messages (id, tenant_id, turn_id, state, due_at, skip_reason)
         VALUES (gen_random_uuid(), $1, $2, 'skipped', now(), 'too_late')`,
        [c.tenant.id, turn.id],
      ),
    ).rejects.toThrow(/slow_reply_messages_turn_uq/);
  });
});
