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
  MESSAGING_LIMITS,
  isListedMessagingLimit,
  messagingLimitRefusalMetadata,
  messagingLimitText,
  parseMessagingLimit,
} from './messaging-limit';
import {
  createOnboardingService,
  processChannelOnboarding,
  type OnboardingDeps,
} from './onboarding';

/** The values Meta's SDK lists for `whatsapp_business_manager_messaging_limit` (research M-059). */
const LIMITS = [
  'TIER_50',
  'TIER_250',
  'TIER_2K',
  'TIER_10K',
  'TIER_100K',
  'TIER_UNLIMITED',
  'UNTIERED',
];
const SCOPE =
  'unique customers outside a customer service window in a moving 24 hours (shared by the business portfolio)';
const FIELD = 'whatsapp_business_manager_messaging_limit';

describe("a number's messaging limit from Meta (ADR-398)", () => {
  it('lists exactly the values of Meta’s SDK', () => {
    expect([...MESSAGING_LIMITS]).toEqual(LIMITS);
    for (const limit of LIMITS) expect(isListedMessagingLimit(limit)).toBe(true);
    // The deprecated field's TIER_1K, other spellings and prototype names are not listed.
    for (const other of [
      'TIER_1K',
      'tier_2k',
      ' TIER_2K',
      'TIER_2K ',
      'untiered',
      '',
      'constructor',
      '__proto__',
      'toString',
    ]) {
      expect(isListedMessagingLimit(other), other).toBe(false);
    }
  });

  it('keeps any text as Meta gives it, and nothing else', () => {
    for (const limit of LIMITS) expect(parseMessagingLimit(limit)).toBe(limit);
    // A value the SDK does not list, exactly as given.
    expect(parseMessagingLimit('TIER_1K')).toBe('TIER_1K');
    expect(parseMessagingLimit(' tier_2k ')).toBe(' tier_2k ');
    // At most the 64 characters the column holds, an emoji never split.
    expect(parseMessagingLimit('T'.repeat(64))).toBe('T'.repeat(64));
    expect(parseMessagingLimit('T'.repeat(65))).toBe('T'.repeat(64));
    expect(parseMessagingLimit(`${'T'.repeat(63)}😀`)).toBe('T'.repeat(63));
    // Absent, empty or not text: Meta reported no limit.
    for (const none of [
      undefined,
      null,
      '',
      2000,
      0,
      true,
      false,
      ['TIER_2K'],
      { tier: 'TIER_2K' },
    ]) {
      expect(parseMessagingLimit(none), JSON.stringify(none)).toBeNull();
    }
  });

  it('words each tier by the customers it allows, and nothing else as a figure', () => {
    // Research gives no figure for TIER_50 (M-058 starts at 250): as Meta reports it.
    expect(messagingLimitText('TIER_50')).toBe('Messaging limit: TIER_50 (as Meta reports it)');
    expect(messagingLimitText('TIER_250')).toBe(`Messaging limit: 250 ${SCOPE}`);
    expect(messagingLimitText('TIER_2K')).toBe(`Messaging limit: 2,000 ${SCOPE}`);
    expect(messagingLimitText('TIER_10K')).toBe(`Messaging limit: 10,000 ${SCOPE}`);
    expect(messagingLimitText('TIER_100K')).toBe(`Messaging limit: 100,000 ${SCOPE}`);
    expect(messagingLimitText('TIER_UNLIMITED')).toBe(
      'Messaging limit: unlimited (shared by the business portfolio)',
    );
    // No documented meaning: as Meta reports it, without a number.
    expect(messagingLimitText('UNTIERED')).toBe('Messaging limit: untiered (as Meta reports it)');
    // Anything else, the deprecated field's TIER_1K and prototype names included, is unknown.
    for (const other of [
      'TIER_1K',
      'tier_2k',
      'TIER_2K ',
      'constructor',
      '__proto__',
      'toString',
    ]) {
      expect(messagingLimitText(other), other).toBe(`Messaging limit: unknown tier (${other})`);
    }
    expect(messagingLimitText(null)).toBe('Messaging limit: not reported by Meta');
    // No figure where none is documented.
    for (const none of ['TIER_50', 'UNTIERED', 'TIER_UNLIMITED', null]) {
      expect(messagingLimitText(none)).not.toMatch(/customers/);
    }
    for (const none of ['UNTIERED', 'TIER_UNLIMITED', null]) {
      expect(messagingLimitText(none)).not.toMatch(/[0-9]/);
    }
    expect(MESSAGING_LIMIT_NOTE).toBe(
      'A messaging limit is the number of unique customers a business can reach outside a customer service window in a moving 24 hours. Since 7 October 2025 Meta sets it per business portfolio, shared by all its numbers; HyFib shows the limit Meta reported when it last read the number.',
    );
  });
});

describe("the phone number read's messaging limit (ADR-398)", () => {
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

  it('asks for the limit with the number’s other facts and parses it', async () => {
    const cases: [unknown, string | null][] = [
      ['TIER_10K', 'TIER_10K'],
      ['UNTIERED', 'UNTIERED'],
      ['TIER_1K', 'TIER_1K'],
      [undefined, null],
      [2000, null],
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
        // The deprecated field is neither asked for nor read.
        messaging_limit_tier: 'TIER_1K',
        ...(given === undefined ? {} : { [FIELD]: given }),
      });
      const result = await graph.getPhoneNumber('1234', 'token');
      expect(asked.map((u) => `${u.pathname}?${u.searchParams.get('fields')}`)).toEqual([
        `/v26.0/1234?${FIELDS},${FIELD}`,
      ]);
      expect(result).toEqual({
        ok: true,
        data: {
          displayPhoneNumber: '+91 98000 00000',
          verifiedName: 'Acme',
          qualityRating: 'GREEN',
          nameStatus: 'APPROVED',
          codeVerificationStatus: 'VERIFIED',
          messagingLimit: kept,
        },
      });
    }
  });

  it('reads the rest without it when told, and then gives no limit', async () => {
    const { graph, asked } = client({ verified_name: 'Acme', [FIELD]: 'TIER_2K' });
    const result = await graph.getPhoneNumber('1234', 'token', { messagingLimit: false });
    expect(asked.map((u) => u.searchParams.get('fields'))).toEqual([FIELDS]);
    expect(result.ok && result.data).toMatchObject({ verifiedName: 'Acme', messagingLimit: null });
    const asking = client({ [FIELD]: 'TIER_2K' });
    await asking.graph.getPhoneNumber('1234', 'token', { messagingLimit: true });
    expect(asking.asked.map((u) => u.searchParams.get('fields'))).toEqual([`${FIELDS},${FIELD}`]);
  });
});

type PhoneRead = Awaited<ReturnType<GraphClient['getPhoneNumber']>>;
type Failure = Extract<GraphResult<never>, { ok: false }>;

describe("onboarding's health read and the messaging limit (ADR-398)", () => {
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
    detail: `(#100) Tried accessing nonexisting field (${FIELD})`,
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

  /** The audit entries written, as action, subject and exact metadata. */
  const audited = (audits: Record<string, unknown>[]) =>
    audits.map((a) => [a.action, a.subjectId, a.metadata]);
  const setUp = (messagingLimit: string | null) => [
    {
      status: 'active',
      onboardingStep: 'done',
      onboardingError: null,
      ...facts,
      messagingLimit,
      messagingLimitCheckedAt: NOW,
      healthCheckedAt: NOW,
    },
  ];
  const plain: PhoneRead = { ok: true, data: { ...facts, messagingLimit: null } };

  it('stores the limit read with the health, at the same time', async () => {
    const run = await healthStep([{ ok: true, data: { ...facts, messagingLimit: 'TIER_2K' } }]);
    expect(run.outcome).toBe('active');
    expect(run.reads).toEqual([undefined]);
    expect(run.updates).toEqual(setUp('TIER_2K'));
    // Exactly no metadata: nothing was refused.
    expect(audited(run.audits)).toEqual([['channel.activated', CHANNEL, {}]]);
    expect(run.events).toBe(1);
  });

  it('reads once more without the limit when Graph refuses it, whatever the code, and audits what Graph answered', async () => {
    const refusals: Failure[] = [
      // A field Graph does not have.
      refused,
      // A permission, as the description's example for this read (403, code 200, its subcode).
      {
        ok: false,
        kind: 'permanent',
        httpStatus: 403,
        code: 200,
        subcode: 1349174,
        title: 'Permission Denied',
        detail: "Your app doesn't have permission to access this WhatsApp Account Number",
      },
      // An app without the capability.
      {
        ok: false,
        kind: 'permanent',
        httpStatus: 400,
        code: 3,
        title: 'OAuthException',
        detail: '(#3) Application does not have the capability to make this API call.',
      },
      // Code 10, which HyFib reads as lost access.
      {
        ok: false,
        kind: 'auth',
        httpStatus: 403,
        code: 10,
        title: 'OAuthException',
        detail: '(#10) Application does not have permission for this action',
      },
    ];
    for (const refusal of refusals) {
      const run = await healthStep([refusal, plain]);
      const label = String(refusal.code);
      expect(run.outcome, label).toBe('active');
      expect(run.reads, label).toEqual([undefined, { messagingLimit: false }]);
      expect(run.updates, label).toEqual(setUp(null));
      expect(audited(run.audits), label).toEqual([
        [
          'channel.activated',
          CHANNEL,
          {
            messagingLimit: 'refused',
            kind: refusal.kind,
            httpStatus: refusal.httpStatus,
            code: refusal.code,
            subcode: refusal.subcode ?? null,
            detail: refusal.detail,
          },
        ],
      ]);
    }
  });

  it('keeps no link or token of Meta’s message in the audit, and at most 200 of its characters', async () => {
    const run = await healthStep([
      {
        ...refused,
        detail: `Denied for EAAGm0PX4ZCpsBAKzz1234567890abcdef see https://graph.facebook.com/v26.0/1?access_token=EAAx123 ${'x'.repeat(300)}`,
      },
      plain,
    ]);
    const metadata = run.audits[0]!.metadata as Record<string, unknown>;
    expect(metadata.detail).toBe(`Denied for [token] see [link] ${'x'.repeat(170)}`);
    expect(String(metadata.detail)).toHaveLength(200);
    expect(messagingLimitRefusalMetadata({ kind: 'permanent' })).toEqual({
      messagingLimit: 'refused',
      kind: 'permanent',
      httpStatus: null,
      code: null,
      subcode: null,
      detail: null,
    });
  });

  it('fails with the second read’s reason when that read fails too', async () => {
    const run = await healthStep([refused, { ...refused, detail: 'Unsupported get request.' }]);
    expect(run.outcome).toBe('failed');
    expect(run.reads).toEqual([undefined, { messagingLimit: false }]);
    expect(run.updates).toEqual([
      {
        status: 'failed',
        onboardingError: 'Setup failed at health_check: OAuthException: Unsupported get request.',
      },
    ]);
    expect(audited(run.audits)).toEqual([
      ['channel.setup_failed', CHANNEL, { step: 'health_check', code: 100 }],
    ]);
  });

  it('still asks for a reconnect when Meta refuses the token on both reads', async () => {
    const revoked: Failure = {
      ok: false,
      kind: 'auth',
      httpStatus: 401,
      code: 190,
      title: 'OAuthException',
      detail: 'Error validating access token: The session has been invalidated.',
    };
    const run = await healthStep([revoked, revoked]);
    expect(run.outcome).toBe('needs_reconnect');
    expect(run.reads).toEqual([undefined, { messagingLimit: false }]);
    expect(run.updates).toEqual([
      {
        status: 'needs_reconnect',
        onboardingError: 'Meta rejected the stored token. Reconnect WhatsApp.',
      },
    ]);
    expect(run.audits).toEqual([]);
  });

  it('retries a failure that may pass without a second read, as before', async () => {
    const cases: Failure[] = [
      { ...refused, kind: 'retryable', httpStatus: 500 },
      { ...refused, kind: 'retryable', httpStatus: 429, code: 4 },
      { ...refused, kind: 'unknown', httpStatus: undefined, code: undefined },
    ];
    for (const failure of cases) {
      const run = await healthStep([failure]);
      expect(run.outcome, JSON.stringify(failure)).toBe('retry');
      expect(run.reads, JSON.stringify(failure)).toEqual([undefined]);
      expect(run.updates, JSON.stringify(failure)).toEqual([]);
      expect(run.audits, JSON.stringify(failure)).toEqual([]);
    }
  });
});

describe('Channels and the messaging limit (ADR-398)', () => {
  it('words the limit only for a number whose read asked for it', async () => {
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
      { ...base, storedLimit: null, limitCheckedAt: null },
      { ...base, storedLimit: null, limitCheckedAt: at },
      { ...base, storedLimit: 'TIER_100K', limitCheckedAt: at },
      { ...base, storedLimit: 'UNTIERED', limitCheckedAt: at },
      { ...base, storedLimit: 'TIER_1K', limitCheckedAt: at },
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
      `Messaging limit: 100,000 ${SCOPE}`,
      'Messaging limit: untiered (as Meta reports it)',
      'Messaging limit: unknown tier (TIER_1K)',
    ]);
    // The stored columns stay behind the wording.
    for (const view of listed) {
      expect(Object.keys(view)).not.toContain('storedLimit');
      expect(Object.keys(view)).not.toContain('limitCheckedAt');
    }
  });
});
