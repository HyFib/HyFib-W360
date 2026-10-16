import { describe, expect, it } from 'vitest';
import type { Keyring } from '@w360/core';
import {
  auditEvents,
  channelAccounts,
  tenantEvents,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import type { TenantContext } from '../authz/context';
import { GraphClient, type GraphResult } from './graph';
import {
  MESSAGING_LIMIT_NOTE,
  MESSAGING_LIMIT_TIERS,
  isListedMessagingLimitTier,
  messagingLimitText,
  parseMessagingLimitTier,
} from './messaging-limit';
import {
  createOnboardingService,
  processChannelOnboarding,
  type OnboardingDeps,
} from './onboarding';

const TIERS = ['TIER_50', 'TIER_250', 'TIER_1K', 'TIER_10K', 'TIER_100K', 'TIER_UNLIMITED'];

describe("a number's messaging limit tier from Meta (ADR-398)", () => {
  it('lists exactly the tiers of Meta’s description', () => {
    expect([...MESSAGING_LIMIT_TIERS]).toEqual(TIERS);
    for (const tier of TIERS) expect(isListedMessagingLimitTier(tier)).toBe(true);
    for (const other of ['TIER_2K', 'UNTIERED', 'tier_1k', ' TIER_1K', 'TIER_1K ', '']) {
      expect(isListedMessagingLimitTier(other), other).toBe(false);
    }
  });

  it('keeps any text as Meta gives it, and nothing else', () => {
    for (const tier of TIERS) expect(parseMessagingLimitTier(tier)).toBe(tier);
    // A tier the description does not list, exactly as given.
    expect(parseMessagingLimitTier('TIER_2K')).toBe('TIER_2K');
    expect(parseMessagingLimitTier(' tier_1k ')).toBe(' tier_1k ');
    // At most the 64 characters the column holds, an emoji never split.
    expect(parseMessagingLimitTier('T'.repeat(64))).toBe('T'.repeat(64));
    expect(parseMessagingLimitTier('T'.repeat(65))).toBe('T'.repeat(64));
    expect(parseMessagingLimitTier(`${'T'.repeat(63)}😀`)).toBe('T'.repeat(63));
    // Absent, empty or not text: Meta reported no tier.
    for (const none of [
      undefined,
      null,
      '',
      1000,
      0,
      true,
      false,
      ['TIER_1K'],
      { tier: 'TIER_1K' },
    ]) {
      expect(parseMessagingLimitTier(none), JSON.stringify(none)).toBeNull();
    }
  });

  it('words a tier as Meta names it, any other as unknown, and none as not reported', () => {
    expect(messagingLimitText('TIER_50')).toBe('Messaging limit: TIER_50');
    expect(messagingLimitText('TIER_1K')).toBe('Messaging limit: TIER_1K');
    expect(messagingLimitText('TIER_UNLIMITED')).toBe('Messaging limit: TIER_UNLIMITED');
    expect(messagingLimitText('TIER_2K')).toBe('Messaging limit: unknown tier (TIER_2K)');
    expect(messagingLimitText('tier_1k')).toBe('Messaging limit: unknown tier (tier_1k)');
    expect(messagingLimitText(null)).toBe('Messaging limit: not reported by Meta');
    // Never a number of conversations or customers.
    for (const tier of [...TIERS, 'TIER_2K', null]) {
      expect(messagingLimitText(tier)).not.toMatch(/conversation|customer|[0-9],[0-9]/i);
    }
    expect(MESSAGING_LIMIT_NOTE).toBe(
      'A number’s messaging limit is the tier Meta reports for it, named as Meta names it. Since 7 October 2025 Meta sets messaging limits per business portfolio, shared by all its numbers.',
    );
  });
});

describe("the phone number read's tier (ADR-398)", () => {
  const FIELDS =
    'display_phone_number,verified_name,quality_rating,name_status,code_verification_status';

  /** A client whose Graph answers `body` and records the addresses asked. */
  function client(body: Record<string, unknown>) {
    const asked: URL[] = [];
    const graph = new GraphClient({
      baseUrl: 'https://graph.test',
      version: 'v26.0',
      fetchImpl: async (input) => {
        asked.push(new URL(String(input)));
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    return { graph, asked };
  }

  it('asks for the tier with the number’s other facts and parses it', async () => {
    const cases: [unknown, string | null][] = [
      ['TIER_10K', 'TIER_10K'],
      ['TIER_2K', 'TIER_2K'],
      [undefined, null],
      [1000, null],
      ['', null],
    ];
    for (const [given, kept] of cases) {
      const { graph, asked } = client({
        id: '1234',
        display_phone_number: '+91 98000 00000',
        verified_name: 'Acme',
        quality_rating: 'GREEN',
        name_status: 'APPROVED',
        code_verification_status: 'VERIFIED',
        ...(given === undefined ? {} : { messaging_limit_tier: given }),
      });
      const result = await graph.getPhoneNumber('1234', 'token');
      expect(asked.map((u) => `${u.pathname}?${u.searchParams.get('fields')}`)).toEqual([
        `/v26.0/1234?${FIELDS},messaging_limit_tier`,
      ]);
      expect(result).toEqual({
        ok: true,
        data: {
          displayPhoneNumber: '+91 98000 00000',
          verifiedName: 'Acme',
          qualityRating: 'GREEN',
          nameStatus: 'APPROVED',
          codeVerificationStatus: 'VERIFIED',
          messagingLimitTier: kept,
        },
      });
    }
  });

  it('reads the rest without it when told, and then gives no tier', async () => {
    const { graph, asked } = client({ verified_name: 'Acme', messaging_limit_tier: 'TIER_1K' });
    const result = await graph.getPhoneNumber('1234', 'token', { messagingLimitTier: false });
    expect(asked.map((u) => u.searchParams.get('fields'))).toEqual([FIELDS]);
    expect(result.ok && result.data).toMatchObject({
      verifiedName: 'Acme',
      messagingLimitTier: null,
    });
    const asking = client({ messaging_limit_tier: 'TIER_1K' });
    await asking.graph.getPhoneNumber('1234', 'token', { messagingLimitTier: true });
    expect(asking.asked.map((u) => u.searchParams.get('fields'))).toEqual([
      `${FIELDS},messaging_limit_tier`,
    ]);
  });
});

type PhoneRead = Awaited<ReturnType<GraphClient['getPhoneNumber']>>;
type Failure = Extract<GraphResult<never>, { ok: false }>;

describe("onboarding's health read and the tier (ADR-398)", () => {
  const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
  const CHANNEL = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
  const NOW = new Date('2026-10-16T10:00:00Z');
  const facts = {
    displayPhoneNumber: '+91 98000 00000',
    verifiedName: 'Acme',
    qualityRating: 'GREEN',
    nameStatus: 'APPROVED',
    codeVerificationStatus: 'VERIFIED',
  };
  const refused: Failure = {
    ok: false,
    kind: 'permanent',
    httpStatus: 400,
    code: 100,
    title: 'OAuthException',
    detail: '(#100) Tried accessing nonexisting field (messaging_limit_tier)',
  };

  /**
   * Runs the health step of a number in setup against a Graph answering `answers` in order, and
   * gives the outcome, the reads made (with their options) and what was written.
   */
  async function healthStep(answers: PhoneRead[]) {
    const reads: (Record<string, unknown> | undefined)[] = [];
    const updates: Record<string, unknown>[] = [];
    const audits: Record<string, unknown>[] = [];
    let events = 0;
    const query = (rows: unknown[]) => {
      const q: Record<string, unknown> = {};
      for (const step of ['from', 'innerJoin', 'where']) q[step] = () => q;
      q.then = (done: (r: unknown[]) => unknown) => Promise.resolve(rows).then(done);
      return q;
    };
    const tx = {
      select: () =>
        query([
          {
            id: CHANNEL,
            status: 'onboarding',
            step: 'health_check',
            phoneNumberId: '1234',
            pin: null,
            whatsappAccountId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03',
            wabaId: '5678',
            credential: 'sealed',
          },
        ]),
      // The number's row; a lost access also marks its account (not recorded here).
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          if (table === channelAccounts) updates.push(values);
          return { where: () => Promise.resolve() };
        },
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          if (table === auditEvents) audits.push(row);
          else if (table === tenantEvents) events += 1;
          else throw new Error('unexpected insert');
          return Promise.resolve();
        },
      }),
    } as unknown as Tx;
    const db = {
      run: (_scope: unknown, fn: (t: Tx) => unknown) => fn(tx),
    } as unknown as Database;
    const graph = {
      getPhoneNumber: (_id: string, _token: string, options?: Record<string, unknown>) => {
        reads.push(options);
        const answer = answers.shift();
        if (!answer) throw new Error('read not expected');
        return Promise.resolve(answer);
      },
    } as unknown as GraphClient;
    const keyring = { decryptString: () => 'token' } as unknown as Keyring;
    const outcome = await processChannelOnboarding(
      { db, keyring, graph, clock: { now: () => NOW } },
      { tenantId: TENANT } as unknown as TenantScope,
      CHANNEL,
    );
    return { outcome, reads, updates, audits, events };
  }

  it('stores the tier read with the health, at the same time', async () => {
    const run = await healthStep([{ ok: true, data: { ...facts, messagingLimitTier: 'TIER_1K' } }]);
    expect(run.outcome).toBe('active');
    expect(run.reads).toEqual([undefined]);
    expect(run.updates).toEqual([
      {
        status: 'active',
        onboardingStep: 'done',
        onboardingError: null,
        ...facts,
        messagingLimitTier: 'TIER_1K',
        messagingLimitCheckedAt: NOW,
        healthCheckedAt: NOW,
      },
    ]);
    expect(run.audits).toMatchObject([
      { action: 'channel.activated', subjectId: CHANNEL, metadata: {} },
    ]);
    expect(run.events).toBe(1);
  });

  it('reads once more without the tier when Graph refuses with code 100, and says so', async () => {
    const run = await healthStep([
      refused,
      { ok: true, data: { ...facts, messagingLimitTier: null } },
    ]);
    expect(run.outcome).toBe('active');
    expect(run.reads).toEqual([undefined, { messagingLimitTier: false }]);
    expect(run.updates).toEqual([
      {
        status: 'active',
        onboardingStep: 'done',
        onboardingError: null,
        ...facts,
        messagingLimitTier: null,
        messagingLimitCheckedAt: NOW,
        healthCheckedAt: NOW,
      },
    ]);
    expect(run.audits).toMatchObject([
      { action: 'channel.activated', metadata: { messagingLimitTier: 'refused' } },
    ]);
  });

  it('fails with the second read’s reason when that read fails too', async () => {
    const run = await healthStep([refused, { ...refused, detail: 'Unsupported get request.' }]);
    expect(run.outcome).toBe('failed');
    expect(run.reads).toEqual([undefined, { messagingLimitTier: false }]);
    expect(run.updates).toEqual([
      {
        status: 'failed',
        onboardingError: 'Setup failed at health_check: OAuthException: Unsupported get request.',
      },
    ]);
    expect(run.audits).toMatchObject([
      { action: 'channel.setup_failed', metadata: { step: 'health_check', code: 100 } },
    ]);
  });

  it('reads only once for any other failure, handled as before', async () => {
    const cases: [Failure, string][] = [
      [{ ...refused, code: 200, title: 'Permission Denied' }, 'failed'],
      [{ ...refused, code: undefined }, 'failed'],
      [{ ...refused, kind: 'retryable', httpStatus: 500 }, 'retry'],
      [{ ...refused, kind: 'unknown' }, 'retry'],
      [{ ...refused, kind: 'auth', httpStatus: 401, code: 190 }, 'needs_reconnect'],
    ];
    for (const [failure, outcome] of cases) {
      const run = await healthStep([failure]);
      expect(run.outcome, JSON.stringify(failure)).toBe(outcome);
      expect(run.reads, JSON.stringify(failure)).toEqual([undefined]);
      expect(
        run.updates.some((u) => 'messagingLimitTier' in u || 'messagingLimitCheckedAt' in u),
      ).toBe(false);
    }
  });
});

describe('Channels and the tier (ADR-398)', () => {
  it('words the tier only for a number whose read asked for it', async () => {
    const at = new Date('2026-10-16T10:00:00Z');
    const base = {
      id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02',
      whatsappAccountId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03',
      wabaId: '5678',
      phoneNumberId: '1234',
      displayPhoneNumber: '+91 98000 00000',
      verifiedName: 'Acme',
      status: 'active',
      onboardingStep: 'done',
      onboardingError: null,
      qualityRating: 'GREEN',
      nameStatus: 'APPROVED',
      healthCheckedAt: at,
      accountStatus: 'connected',
      accessCheckedAt: null,
      accessExpiresAt: null,
      webhooksCheckedAt: null,
      grantedScopes: [],
    };
    const rows = [
      // Its health read before ADR-398: never asked.
      { ...base, messagingLimitTier: null, messagingLimitCheckedAt: null },
      { ...base, messagingLimitTier: null, messagingLimitCheckedAt: at },
      { ...base, messagingLimitTier: 'TIER_100K', messagingLimitCheckedAt: at },
      { ...base, messagingLimitTier: 'TIER_2K', messagingLimitCheckedAt: at },
    ];
    const q: Record<string, unknown> = {};
    for (const step of ['from', 'innerJoin', 'where', 'orderBy']) q[step] = () => q;
    q.then = (done: (r: unknown[]) => unknown) => Promise.resolve(rows).then(done);
    const db = {
      run: (_scope: unknown, fn: (t: Tx) => unknown) => fn({ select: () => q } as unknown as Tx),
    } as unknown as Database;
    const service = createOnboardingService({
      db,
      clock: { now: () => at },
    } as unknown as OnboardingDeps);
    const ctx = { permissions: new Set(['channels.read']), tenant: { id: 't' }, scope: {} };
    const listed = await service.listChannels(ctx as unknown as TenantContext);
    expect(listed.map((c) => c.messagingLimit)).toEqual([
      null,
      'Messaging limit: not reported by Meta',
      'Messaging limit: TIER_100K',
      'Messaging limit: unknown tier (TIER_2K)',
    ]);
    // The stored columns stay behind the wording.
    for (const view of listed) {
      expect(Object.keys(view)).not.toContain('messagingLimitTier');
      expect(Object.keys(view)).not.toContain('messagingLimitCheckedAt');
    }
  });
});
