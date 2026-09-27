import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock } from '@w360/core';
import { authorizedTenantScope } from '@w360/db';
import {
  createCsatService,
  createInboxService,
  createReportsService,
  processSendIntent,
  type TenantContext,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * CSAT surveys against real PostgreSQL and the test-only Graph stand-in (which checks interactive
 * payloads against the limits in Meta's OpenAPI spec): queued on resolve inside the service window,
 * skipped with a reason otherwise, re-checked at send time, and answered by the first button tap
 * without reopening the conversation or starting a reply turn.
 */
let fx: WhatsAppFixture;
beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  await fx?.close();
});

const rate = { capacity: 1000, refillPerSecond: 1000 };
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;

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

interface Setup {
  c: Company;
  owner: TenantContext;
  agent: TenantContext;
  inbox: ReturnType<typeof createInboxService>;
}

async function setup(): Promise<Setup> {
  const c = await fx.company();
  const owner = await fx.ctx(c, c.owner);
  const agent = await fx.ctx(c, c.agent);
  await createCsatService({ db: fx.dbs.app, clock: systemClock }).updateCsatSettings(owner, {
    enabled: true,
    question: 'How did we do today?',
    labels: ['Great', 'Okay', 'Poor'],
  });
  const inbox = createInboxService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
  });
  return { c, owner, agent, inbox };
}

async function inbound(c: Company, from: string, text = 'Hello') {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, text }] }));
  const [row] = await fx.query<{ id: string }>(
    `SELECT cv.id FROM app.conversations cv
       JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
      WHERE cv.tenant_id = $1 AND i.wa_id = $2`,
    [c.tenant.id, from],
  );
  if (!row) throw new Error('conversation not created');
  return row.id;
}

async function version(conversationId: string) {
  const [row] = await fx.query<{ version: number; status: string; unread_count: number }>(
    `SELECT version, status, unread_count FROM app.conversations WHERE id = $1`,
    [conversationId],
  );
  return row!;
}

async function resolve(s: Setup, conversationId: string) {
  await s.inbox.setStatus(s.agent, {
    conversationId,
    status: 'resolved',
    expectedVersion: (await version(conversationId)).version,
  });
}

async function surveys(conversationId: string) {
  return fx.query<{
    id: string;
    message_id: string | null;
    skip_reason: string | null;
    score: number | null;
    assigned_membership_id: string | null;
    resolved_by_membership_id: string | null;
    case_id: string | null;
  }>(
    `SELECT id, message_id, skip_reason, score, assigned_membership_id, resolved_by_membership_id, case_id
       FROM app.csat_surveys WHERE conversation_id = $1 ORDER BY created_at`,
    [conversationId],
  );
}

async function sendSurvey(c: Company, messageId: string) {
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
    authorizedTenantScope(c.tenant.id, c.agent.id),
    intent!.id,
  );
}

function tap(c: Company, from: string, buttonId: string, title: string, contextId: string) {
  return fx.deliver(
    fx.messagesBody(c, {
      messages: [
        {
          waId: from,
          type: 'interactive',
          extra: {
            interactive: { type: 'button_reply', button_reply: { id: buttonId, title } },
            context: { from: '919000000000', id: contextId },
          },
        },
      ],
    }),
  );
}

describe('CSAT settings', () => {
  it('are validated against WhatsApp’s button limits and managed by administrators', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const csat = createCsatService({ db: fx.dbs.app, clock: systemClock });
    expect(await csat.getCsatSettings(agent)).toEqual({
      enabled: false,
      question: 'How would you rate the help you received today?',
      labels: ['Great', 'Okay', 'Poor'],
    });
    await expectAppError(
      csat.updateCsatSettings(agent, { enabled: true, question: 'Q', labels: ['a', 'b', 'c'] }),
      'forbidden',
    );
    await expectAppError(
      csat.updateCsatSettings(owner, {
        enabled: true,
        question: 'Q',
        labels: ['Absolutely fantastic!!', 'Fine', 'Bad'],
      }),
      'validation_failed',
      /20 characters/,
    );
    await expectAppError(
      csat.updateCsatSettings(owner, { enabled: true, question: 'Q', labels: ['Ok', 'ok', 'No'] }),
      'validation_failed',
      /different/,
    );
  });
});

describe('CSAT surveys', () => {
  it('are sent on resolve and answered by the first tap, without reopening', async () => {
    const s = await setup();
    const phone = waId();
    const conversationId = await inbound(s.c, phone);
    await s.inbox.assign(s.agent, {
      conversationId,
      membershipId: s.agent.membership.id,
      expectedVersion: (await version(conversationId)).version,
    });
    await resolve(s, conversationId);

    const [survey] = await surveys(conversationId);
    expect(survey).toMatchObject({
      skip_reason: null,
      assigned_membership_id: s.agent.membership.id,
      resolved_by_membership_id: s.agent.membership.id,
    });
    expect(survey?.case_id).not.toBeNull();
    const [message] = await fx.query<{ type: string; sender_type: string; content: unknown }>(
      `SELECT type, sender_type, content FROM app.messages WHERE id = $1`,
      [survey!.message_id],
    );
    expect(message).toMatchObject({
      type: 'interactive',
      sender_type: 'system',
      content: { csat: true, body: 'How did we do today?', buttons: ['Great', 'Okay', 'Poor'] },
    });

    // The stand-in accepts the payload only if it respects Meta's limits for reply buttons.
    const result = await sendSurvey(s.c, survey!.message_id!);
    expect(result.outcome).toBe('accepted');
    const sent = fx.standIn.state.requests.filter((r) => r.path.endsWith('/messages')).at(-1)!;
    expect(sent.body).toMatchObject({
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'How did we do today?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: `w360csat:${survey!.id}:3`, title: 'Great' } },
            { type: 'reply', reply: { id: `w360csat:${survey!.id}:2`, title: 'Okay' } },
            { type: 'reply', reply: { id: `w360csat:${survey!.id}:1`, title: 'Poor' } },
          ],
        },
      },
    });

    const turnsBefore = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.conversation_turns WHERE conversation_id = $1`,
      [conversationId],
    );
    await tap(s.c, phone, `w360csat:${survey!.id}:3`, 'Great', sent.wamid!);
    // A second tap does not change the answer.
    await tap(s.c, phone, `w360csat:${survey!.id}:1`, 'Poor', sent.wamid!);
    expect((await surveys(conversationId))[0]?.score).toBe(3);
    expect(await version(conversationId)).toMatchObject({ status: 'resolved', unread_count: 0 });
    const turnsAfter = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.conversation_turns WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(turnsAfter[0]?.n).toBe(turnsBefore[0]?.n);

    // Resolving again within a day does not ask again.
    await s.inbox.setStatus(s.agent, {
      conversationId,
      status: 'open',
      expectedVersion: (await version(conversationId)).version,
    });
    await resolve(s, conversationId);
    expect((await surveys(conversationId)).map((x) => x.skip_reason)).toEqual([
      null,
      'recently_surveyed',
    ]);

    const detail = await s.inbox.getConversation(s.owner, conversationId);
    expect(detail.csat).toMatchObject({ skipReason: 'recently_surveyed', score: null });
  });

  it('ignores taps that do not belong to the conversation’s survey message', async () => {
    const s = await setup();
    const phone = waId();
    const conversationId = await inbound(s.c, phone);
    await resolve(s, conversationId);
    const [survey] = await surveys(conversationId);
    await sendSurvey(s.c, survey!.message_id!);
    // Right button id, wrong message context: not recorded, and still no reopening.
    await tap(s.c, phone, `w360csat:${survey!.id}:1`, 'Poor', 'wamid.someone-else');
    expect((await surveys(conversationId))[0]?.score).toBeNull();
    expect((await version(conversationId)).status).toBe('resolved');
  });

  it('are skipped outside the service window and for opted-out contacts', async () => {
    const s = await setup();
    const late = await inbound(s.c, waId());
    await fx.query(
      `UPDATE app.conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`,
      [late],
    );
    await resolve(s, late);
    expect((await surveys(late)).map((x) => x.skip_reason)).toEqual(['window_closed']);

    const optedOut = await inbound(s.c, waId(), 'STOP');
    await resolve(s, optedOut);
    expect((await surveys(optedOut)).map((x) => x.skip_reason)).toEqual(['opted_out']);
  });

  it('are not sent when the contact opts out after the resolve', async () => {
    const s = await setup();
    const phone = waId();
    const conversationId = await inbound(s.c, phone);
    await resolve(s, conversationId);
    const [survey] = await surveys(conversationId);
    await inbound(s.c, phone, 'STOP');
    const result = await sendSurvey(s.c, survey!.message_id!);
    expect(result.outcome).toBe('failed');
    const [message] = await fx.query<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM app.messages WHERE id = $1`,
      [survey!.message_id],
    );
    expect(message).toEqual({ status: 'failed', error_code: 'opted_out' });
  });

  it('are counted in reports', async () => {
    const s = await setup();
    const phone = waId();
    const conversationId = await inbound(s.c, phone);
    await s.inbox.assign(s.agent, {
      conversationId,
      membershipId: s.agent.membership.id,
      expectedVersion: (await version(conversationId)).version,
    });
    await resolve(s, conversationId);
    const [survey] = await surveys(conversationId);
    await sendSurvey(s.c, survey!.message_id!);
    const sent = fx.standIn.state.requests.filter((r) => r.path.endsWith('/messages')).at(-1)!;
    await tap(s.c, phone, `w360csat:${survey!.id}:2`, 'Okay', sent.wamid!);
    const report = await createReportsService({ db: fx.dbs.app, clock: systemClock }).getReport(
      s.owner,
      { preset: 'last_7_days' },
    );
    expect(report.csat).toMatchObject({
      enabled: true,
      surveys: 1,
      sent: 1,
      answered: 1,
      ratings: { best: 0, middle: 1, worst: 0 },
      responseRate: { numerator: 1, denominator: 1 },
    });
    expect(report.agents.find((a) => a.membershipId === s.agent.membership.id)).toMatchObject({
      csatAnswered: 1,
      csatBest: 0,
    });
  });
});
