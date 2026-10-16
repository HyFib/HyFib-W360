import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, type MetaConfig } from '@w360/core';
import { authorizedTenantScope } from '@w360/db';
import {
  checkAccessAndRefreshNumbers,
  createOnboardingService,
  refreshNumberFacts,
  type AccessCheckDeps,
} from '@w360/domain';
import { usageHeaderValue } from '../support/graph-stand-in';
import {
  APP_ID,
  APP_SECRET,
  startWhatsAppFixture,
  type Company,
  type WhatsAppFixture,
} from './whatsapp-fixture';

/**
 * The daily refresh of each active WhatsApp number's facts from Meta (ADR-402), against real
 * PostgreSQL and the test-only Graph stand-in: after a healthy access check, the account's active
 * numbers due a refresh are read with the health step's read and their quality rating and
 * messaging limit stored; numbers that are not active and other companies' numbers are untouched;
 * a refused limit is stored as none after the field-less read and audited as ADR-398 does; a
 * failed read changes no status and not the access check's outcome; a paused account is asked
 * nothing. Every assertion names this file's own companies and numbers, never a shared listing.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

afterEach(() => {
  fx.standIn.state.messagingLimitError = null;
  fx.standIn.state.usageHeader = null;
  fx.standIn.state.phoneNumberErrors.clear();
});

const FIELDS =
  'display_phone_number,verified_name,quality_rating,name_status,code_verification_status';
const WITH_LIMIT = `${FIELDS},whatsapp_business_manager_messaging_limit`;
const SCOPE =
  'unique customers outside a customer service window in a moving 24 hours (shared by the business portfolio)';
const HEALTHY = { outcome: 'healthy', webhooks: { state: 'subscribed' } };

function deps(): AccessCheckDeps {
  return {
    db: fx.dbs.app,
    keyring: fx.keyring,
    graph: fx.graph,
    clock: systemClock,
    meta: { appId: APP_ID, appSecret: APP_SECRET },
    notices: {
      outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
      appBaseUrl: 'https://app.w360.test',
    },
  };
}

const scopeOf = (c: Company) => authorizedTenantScope(c.tenant.id, null);
const run = (c: Company) => checkAccessAndRefreshNumbers(deps(), scopeOf(c), c.whatsappAccountId);

/** Meta knows the number, with this quality rating and messaging limit. */
function known(n: Company, quality: string, limit: string | null = 'TIER_2K') {
  fx.standIn.state.numbers.set(n.phoneNumberId, {
    display_phone_number: `+91 98${n.phoneNumberId.slice(-8)}`,
    verified_name: 'Refresh Traders',
  });
  fx.standIn.state.qualityRatings.set(n.phoneNumberId, quality);
  fx.standIn.state.messagingLimits.set(n.phoneNumberId, limit);
}

/** The `fields` of the reads of a number Graph received since `from`. */
const reads = (n: Company, from: number) =>
  fx.standIn.state.requests
    .slice(from)
    .filter((r) => r.method === 'GET' && r.path === `/v26.0/${n.phoneNumberId}`)
    .map((r) => r.query.fields);

async function numberRow(n: Company) {
  const [row] = await fx.query<{
    status: string;
    display_phone_number: string | null;
    verified_name: string | null;
    quality_rating: string | null;
    messaging_limit: string | null;
    messaging_limit_checked_at: Date | null;
    health_checked_at: Date | null;
    onboarding_error: string | null;
  }>(
    `SELECT status, display_phone_number, verified_name, quality_rating, messaging_limit,
            messaging_limit_checked_at, health_checked_at, onboarding_error
       FROM app.channel_accounts WHERE id = $1`,
    [n.channelAccountId],
  );
  return row!;
}

/** Makes the number's facts as old as a day and more, as before the next daily check. */
async function age(n: Company) {
  await fx.query(
    `UPDATE app.channel_accounts
        SET health_checked_at = now() - interval '25 hours',
            messaging_limit_checked_at = now() - interval '25 hours'
      WHERE id = $1`,
    [n.channelAccountId],
  );
}

async function audits(n: Company, action: string) {
  return fx.query<{ result: string; metadata: Record<string, unknown> }>(
    `SELECT result, metadata FROM app.audit_events
      WHERE tenant_id = $1 AND action = $2 AND subject_id = $3 ORDER BY occurred_at, id`,
    [n.tenant.id, action, n.channelAccountId],
  );
}

function metaConfig(): MetaConfig {
  return {
    appId: APP_ID,
    appSecret: APP_SECRET,
    webhookSecrets: [APP_SECRET],
    graphApiVersion: 'v26.0',
    graphBaseUrl: fx.standIn.baseUrl,
    webhookVerifyToken: 'verify',
    embeddedSignupConfigId: '777',
  };
}

describe('the daily refresh of each active number’s facts (ADR-402)', () => {
  it('stores the quality rating and limit of the account’s active numbers only, after a healthy check', async () => {
    const c = await fx.company();
    const second = await fx.addNumber(c);
    const others = {
      onboarding: await fx.addNumber(c, { status: 'onboarding' }),
      failed: await fx.addNumber(c, { status: 'failed' }),
      disconnected: await fx.addNumber(c, { status: 'disconnected' }),
      needsReconnect: await fx.addNumber(c, { status: 'needs_reconnect' }),
    };
    // Another company, whose active number Meta knows too.
    const d = await fx.company();
    known(c, 'YELLOW', 'TIER_10K');
    known(second, 'RED', 'TIER_100K');
    for (const n of [...Object.values(others), d]) known(n, 'RED', 'TIER_250');

    const from = fx.standIn.state.requests.length;
    const result = await run(c);
    expect(result.access).toEqual(HEALTHY);
    expect(result.numbersError).toBeUndefined();
    expect(result.numbers?.outcome).toBe('done');
    expect(result.numbers?.left).toBe(0);
    expect(result.numbers?.numbers.map((n) => n.channelAccountId).sort()).toEqual(
      [c.channelAccountId, second.channelAccountId].sort(),
    );
    expect(result.numbers?.numbers.every((n) => n.state === 'refreshed')).toBe(true);

    for (const [n, quality, limit] of [
      [c, 'YELLOW', 'TIER_10K'],
      [second, 'RED', 'TIER_100K'],
    ] as const) {
      const row = await numberRow(n);
      expect(row).toMatchObject({
        status: 'active',
        display_phone_number: `+91 98${n.phoneNumberId.slice(-8)}`,
        verified_name: 'Refresh Traders',
        quality_rating: quality,
        messaging_limit: limit,
      });
      expect(row.health_checked_at).not.toBeNull();
      expect(row.messaging_limit_checked_at).toEqual(row.health_checked_at);
      // One read, with the limit.
      expect(reads(n, from)).toEqual([WITH_LIMIT]);
    }
    // Numbers that are not active, and the other company's number, are neither read nor changed.
    for (const [status, n] of [...Object.entries(others), ['other company', d] as const]) {
      expect(reads(n, from), status).toEqual([]);
      const row = await numberRow(n);
      expect(row.health_checked_at, status).toBeNull();
      expect(row.quality_rating, status).toBeNull();
      expect(row.messaging_limit, status).toBeNull();
    }
    expect((await numberRow(others.needsReconnect)).status).toBe('needs_reconnect');

    // Channels shows them with the time of the read.
    const service = createOnboardingService({
      db: fx.dbs.app,
      keyring: fx.keyring,
      jobs: fx.jobs(),
      signer: fx.signer,
      clock: systemClock,
      graph: fx.graph,
      meta: metaConfig(),
    });
    const shown = (await service.listChannels(await fx.ctx(c, c.agent))).find(
      (ch) => ch.id === c.channelAccountId,
    );
    expect(shown).toMatchObject({
      qualityRating: 'YELLOW',
      messagingLimit: `Messaging limit: 10,000 ${SCOPE}`,
      healthCheckedAt: (await numberRow(c)).health_checked_at!.toISOString(),
    });

    // Checked again within 20 hours (a check asked after a refused send): not read again.
    const again = fx.standIn.state.requests.length;
    expect((await run(c)).numbers).toEqual({ outcome: 'done', numbers: [], left: 0 });
    expect(reads(c, again)).toEqual([]);

    // The next day: read again, and Meta's new facts replace the old ones.
    await age(c);
    known(c, 'GREEN', 'TIER_UNLIMITED');
    const nextDay = fx.standIn.state.requests.length;
    expect((await run(c)).numbers?.numbers).toEqual([
      { channelAccountId: c.channelAccountId, state: 'refreshed', limitRefused: false },
    ]);
    expect(reads(c, nextDay)).toEqual([WITH_LIMIT]);
    expect(await numberRow(c)).toMatchObject({
      quality_rating: 'GREEN',
      messaging_limit: 'TIER_UNLIMITED',
    });
    // A refresh audits nothing routine.
    expect(await audits(c, 'channel.messaging_limit_refused')).toEqual([]);
    expect(await audits(c, 'channel.activated')).toEqual([]);
  });

  it('gives a number set up before the limit was read its limit at once', async () => {
    const c = await fx.company();
    known(c, 'GREEN', 'TIER_2K');
    // Its health was read recently, but never with the limit (before ADR-398).
    await fx.query(
      `UPDATE app.channel_accounts SET health_checked_at = now() - interval '1 hour',
              quality_rating = 'GREEN' WHERE id = $1`,
      [c.channelAccountId],
    );
    expect((await run(c)).numbers?.numbers).toEqual([
      { channelAccountId: c.channelAccountId, state: 'refreshed', limitRefused: false },
    ]);
    const row = await numberRow(c);
    expect(row.messaging_limit).toBe('TIER_2K');
    expect(row.messaging_limit_checked_at).toEqual(row.health_checked_at);
  });

  it('stores a refused limit as none after the field-less read, audited as ADR-398 does, once', async () => {
    const c = await fx.company();
    known(c, 'YELLOW', 'TIER_2K');
    expect((await run(c)).numbers?.numbers[0]).toMatchObject({ state: 'refreshed' });
    expect((await numberRow(c)).messaging_limit).toBe('TIER_2K');

    await age(c);
    const missing =
      '(#100) Tried accessing nonexisting field (whatsapp_business_manager_messaging_limit)';
    fx.standIn.state.messagingLimitError = { status: 400, code: 100, message: missing };
    const from = fx.standIn.state.requests.length;
    const result = await run(c);
    expect(result.access).toEqual(HEALTHY);
    expect(result.numbers?.numbers).toEqual([
      { channelAccountId: c.channelAccountId, state: 'refreshed', limitRefused: true },
    ]);
    // The read with the limit was refused; the same read without it was made once.
    expect(reads(c, from)).toEqual([WITH_LIMIT, FIELDS]);
    const row = await numberRow(c);
    expect(row).toMatchObject({
      status: 'active',
      quality_rating: 'YELLOW',
      messaging_limit: null,
    });
    expect(row.messaging_limit_checked_at).toEqual(row.health_checked_at);
    const refusal = {
      result: 'failure',
      metadata: {
        messagingLimit: 'refused',
        kind: 'permanent',
        httpStatus: 400,
        code: 100,
        subcode: null,
        detail: missing,
      },
    };
    expect(await audits(c, 'channel.messaging_limit_refused')).toEqual([refusal]);

    // Refused again the next day: Channels already says "not reported", so no second entry.
    await age(c);
    expect((await run(c)).numbers?.numbers).toEqual([
      { channelAccountId: c.channelAccountId, state: 'refreshed', limitRefused: true },
    ]);
    expect(await audits(c, 'channel.messaging_limit_refused')).toEqual([refusal]);

    // A refusal HyFib reads as lost access (code 10) marks nothing for reconnecting either.
    await age(c);
    fx.standIn.state.messagingLimitError = {
      status: 403,
      code: 10,
      message: '(#10) Application does not have permission for this action',
    };
    expect((await run(c)).numbers?.numbers).toEqual([
      { channelAccountId: c.channelAccountId, state: 'refreshed', limitRefused: true },
    ]);
    const [states] = await fx.query<{ number: string; account: string }>(
      `SELECT c.status AS number, w.status AS account
         FROM app.channel_accounts c
         JOIN app.whatsapp_accounts w ON w.tenant_id = c.tenant_id AND w.id = c.whatsapp_account_id
        WHERE c.id = $1`,
      [c.channelAccountId],
    );
    expect(states).toEqual({ number: 'active', account: 'connected' });
  });

  it('changes no status and not the access check’s outcome when a read fails', async () => {
    const c = await fx.company();
    const second = await fx.addNumber(c);
    known(c, 'YELLOW', 'TIER_10K');
    known(second, 'RED', 'TIER_250');
    expect((await run(c)).numbers?.outcome).toBe('done');
    await age(c);
    await age(second);
    const before = await numberRow(c);

    // Meta refuses the token for this number's reads (with and without the limit).
    fx.standIn.state.phoneNumberErrors.set(c.phoneNumberId, {
      status: 401,
      code: 190,
      message: 'Error validating access token: The session has been invalidated.',
    });
    const from = fx.standIn.state.requests.length;
    const result = await run(c);
    expect(result.access).toEqual(HEALTHY);
    expect(result.numbers?.outcome).toBe('done');
    expect(result.numbers?.numbers).toEqual(
      expect.arrayContaining([
        {
          channelAccountId: c.channelAccountId,
          state: 'failed',
          kind: 'auth',
          error: expect.stringContaining('auth 190'),
        },
        { channelAccountId: second.channelAccountId, state: 'refreshed', limitRefused: false },
      ]),
    );
    expect(reads(c, from)).toEqual([WITH_LIMIT, FIELDS]);
    // Nothing of the failed number changed: its status, facts and "Checked" time stay.
    expect(await numberRow(c)).toEqual(before);
    const [account] = await fx.query<{ status: string; token_checked_at: Date | null }>(
      'SELECT status, token_checked_at FROM app.whatsapp_accounts WHERE id = $1',
      [c.whatsappAccountId],
    );
    expect(account!.status).toBe('connected');
    expect(account!.token_checked_at).not.toBeNull();
    expect(await audits(c, 'channel.messaging_limit_refused')).toEqual([]);

    // A read Meta refuses for now (a rate limit without a pause): no second read, still due, and
    // read again at the next check.
    fx.standIn.state.phoneNumberErrors.set(c.phoneNumberId, {
      status: 400,
      code: 80007,
      message: 'Rate limit hit',
    });
    const limited = fx.standIn.state.requests.length;
    expect((await run(c)).numbers?.numbers).toEqual([
      expect.objectContaining({
        channelAccountId: c.channelAccountId,
        state: 'failed',
        kind: 'retryable',
      }),
    ]);
    expect(reads(c, limited)).toEqual([WITH_LIMIT]);
    fx.standIn.state.phoneNumberErrors.clear();
    expect((await run(c)).numbers?.numbers).toEqual([
      { channelAccountId: c.channelAccountId, state: 'refreshed', limitRefused: false },
    ]);
  });

  it('asks Graph nothing for the numbers of a paused account', async () => {
    const c = await fx.company();
    known(c, 'YELLOW', 'TIER_10K');

    // Paused before the check: neither the access nor the numbers are asked.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET management_paused_until = now() + interval '5 minutes'
        WHERE id = $1`,
      [c.whatsappAccountId],
    );
    let from = fx.standIn.state.requests.length;
    const paused = await run(c);
    expect(paused.access.outcome).toBe('paused');
    expect(paused.numbers).toBeNull();
    expect((await refreshNumberFacts(deps(), scopeOf(c), c.whatsappAccountId)).outcome).toBe(
      'paused',
    );
    expect(reads(c, from)).toEqual([]);
    expect((await numberRow(c)).health_checked_at).toBeNull();

    // Paused by the access check's own response: the check is healthy, the numbers wait.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET management_paused_until = NULL WHERE id = $1`,
      [c.whatsappAccountId],
    );
    fx.standIn.state.usageHeader = usageHeaderValue({
      [c.wabaId]: { callCount: 100, regainMinutes: 5 },
    });
    from = fx.standIn.state.requests.length;
    const result = await run(c);
    expect(result.access).toEqual(HEALTHY);
    expect(result.numbers).toMatchObject({ outcome: 'paused', numbers: [], left: 1 });
    expect(result.numbers?.pausedUntil).toBeInstanceOf(Date);
    expect(reads(c, from)).toEqual([]);
    expect((await numberRow(c)).health_checked_at).toBeNull();
  });
});
