import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AppError, Keyring } from '@w360/core';
import { EgressError, type EgressClient, type EgressRequest } from '@w360/core/egress';
import { QUEUES } from '@w360/contracts';
import type { Database, SQL } from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import {
  ALERT_POST_MAX_CHARS,
  alertChannelAad,
  alertChannelTestBody,
  alertPostBody,
  alertPostFailureLabel,
  alertPostOutcome,
  chatEscape,
  checkedAlertChannelUrl,
  createAlertChannelService,
  queueAlertPost,
  sendAlertPosts,
} from './alert-channel';
import type { PlatformActor } from './service';

const BASE = 'https://app.w360.test';
const HOOK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX';
const keyring = () => new Keyring({ primaryKeyId: 'k1', keys: { k1: randomBytes(32) } });
const OWNER: PlatformActor = { userId: 'user-owner', role: 'platform_owner', correlationId: 'c-1' };
const OPERATOR: PlatformActor = {
  userId: 'user-operator',
  role: 'platform_operator',
  correlationId: 'c-2',
};
const PRODUCTION = { allowLoopbackForTests: false };

const query = (q: SQL) => {
  const built = new PgDialect().sqlToQuery(q);
  return { sql: built.sql.replace(/\s+/g, ' ').trim(), params: built.params };
};

describe('a chat channel post’s text (ADR-338)', () => {
  it('escapes only the three characters Slack’s formatting reads', () => {
    expect(chatEscape('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(chatEscape('“Queues” → 5, ’quoted’ "q" \'q\' பணம் *bold* _x_')).toBe(
      '“Queues” → 5, ’quoted’ "q" \'q\' பணம் *bold* _x_',
    );
    // Escaped once: an entity already in the text is shown as written.
    expect(chatEscape('&amp;')).toBe('&amp;amp;');
  });

  it('gives an alert’s subject, lines and link one a line, escaped', () => {
    expect(
      alertPostBody({
        subject: '3 failures need a look',
        lines: ['2 jobs <late> & 1 receipt.', 'Counts only.'],
        url: `${BASE}/platform/ops?a=1&b=2`,
        actionLabel: 'Open operations',
      }),
    ).toBe(
      [
        '3 failures need a look',
        '2 jobs &lt;late&gt; &amp; 1 receipt.',
        'Counts only.',
        `Open operations: ${BASE}/platform/ops?a=1&amp;b=2`,
      ].join('\n'),
    );
  });

  it('keeps a post to 4,000 characters, cut before an escape or half a character', () => {
    const alert = (lines: string[]) => ({ subject: 's', lines, url: BASE, actionLabel: 'Open' });
    const fits = alertPostBody(alert(['x'.repeat(ALERT_POST_MAX_CHARS - 40)]));
    expect(fits.length).toBeLessThanOrEqual(ALERT_POST_MAX_CHARS);
    expect(fits.endsWith(`Open: ${BASE}`)).toBe(true);
    // 's', a line of 3,970 and 'Open: ' and the 21 characters of the link, on three lines: 4,000.
    const exact = alertPostBody(alert(['x'.repeat(3970)]));
    expect(exact).toHaveLength(4000);
    expect(exact.endsWith(`Open: ${BASE}`)).toBe(true);
    const over = alertPostBody(alert(['x'.repeat(3971)]));
    expect(over).toHaveLength(4000);
    expect(over.endsWith('…')).toBe(true);
    // 's\n' and 3,990 characters, then escapes: the cut falls inside the second `&amp;`.
    const escapes = alertPostBody(alert([`${'x'.repeat(3990)}${'&'.repeat(10)}`]));
    expect(escapes).toHaveLength(3998);
    expect(escapes.endsWith(`${'x'.repeat(3990)}&amp;…`)).toBe(true);
    // An emoji (two UTF-16 units) across the cut is left out whole.
    const emoji = alertPostBody(alert([`${'x'.repeat(3996)}😀😀`]));
    expect(emoji.endsWith(`${'x'.repeat(3996)}…`)).toBe(true);
    expect(emoji).toHaveLength(3999);
    const long = alertPostBody(alert(['y'.repeat(10_000)]));
    expect(long).toHaveLength(ALERT_POST_MAX_CHARS);
    expect(long.endsWith('y…')).toBe(true);
  });

  it('says what the test post is and links the Alerts tab', () => {
    const body = alertChannelTestBody(BASE);
    expect(body.split('\n')).toEqual([
      'HyFib W360: a test post from the operations console',
      'The operations alerts (failures, late queues and failing integrations) are posted here when they are emailed to platform administrators, with counts only.',
      `Open the alerts: ${BASE}/platform/ops/alerts`,
    ]);
  });
});

describe('a chat channel’s address (ADR-338)', () => {
  const refusal = (raw: string, policy = PRODUCTION) => {
    try {
      checkedAlertChannelUrl(raw, policy);
    } catch (error) {
      if (error instanceof AppError) return [error.code, error.message, error.issues];
      throw error;
    }
    return null;
  };

  it('takes an https address as the egress guard would call it, without its fragment, and names its host', () => {
    expect(checkedAlertChannelUrl(`  ${HOOK}#part `, PRODUCTION)).toEqual({
      url: HOOK,
      host: 'hooks.slack.com',
    });
    expect(
      checkedAlertChannelUrl('https://Chat.Example.COM:8443/hook?key=a b', PRODUCTION),
    ).toEqual({
      url: 'https://chat.example.com:8443/hook?key=a%20b',
      host: 'chat.example.com',
    });
  });

  it('refuses a blank address, another scheme, credentials, a privileged port or a long one, at url', () => {
    const issue = (message: string) => ['validation_failed', message, [{ path: 'url', message }]];
    expect(refusal('  ')).toEqual(issue('Give the channel’s incoming webhook address.'));
    expect(refusal('http://hooks.slack.com/services/x')).toEqual(
      issue('Only https:// addresses can be called.'),
    );
    expect(refusal('https://user:secret@hooks.slack.com/x')).toEqual(
      issue('Give the address without a user name or password.'),
    );
    expect(refusal('https://hooks.slack.com:22/x')).toEqual(
      issue('Use port 443 or a port from 1024 up.'),
    );
    // 'https://hooks.slack.com/' is 24 characters: 2,048 in all are taken, 2,049 are not.
    expect(refusal(`https://hooks.slack.com/${'a'.repeat(2024)}`)).toBeNull();
    expect(refusal(`https://hooks.slack.com/${'a'.repeat(2025)}`)).toEqual(
      issue('The address is too long.'),
    );
    expect(refusal('not an address')?.[0]).toBe('validation_failed');
  });

  it('takes a local http receiver only where configuration allows loopback egress (tests)', () => {
    expect(refusal('http://127.0.0.1:4555/hook')?.[1]).toBe(
      'Only https:// addresses can be called.',
    );
    expect(
      checkedAlertChannelUrl('http://127.0.0.1:4555/hook', { allowLoopbackForTests: true }),
    ).toEqual({ url: 'http://127.0.0.1:4555/hook', host: '127.0.0.1' });
  });
});

describe('a post’s attempt and its failure (ADR-338)', () => {
  it('sends on 2xx, tries again on 429, 5xx and no answer, and gives up on anything else', () => {
    expect(alertPostOutcome({ status: 200 })).toEqual({ status: 200, error: null, retry: false });
    expect(alertPostOutcome({ status: 204 })).toEqual({ status: 204, error: null, retry: false });
    expect(alertPostOutcome({ status: 429 })).toEqual({ status: 429, error: null, retry: true });
    expect(alertPostOutcome({ status: 500 })).toEqual({ status: 500, error: null, retry: true });
    expect(alertPostOutcome({ status: 599 })).toEqual({ status: 599, error: null, retry: true });
    for (const status of [100, 301, 400, 403, 404, 410, 499]) {
      expect(alertPostOutcome({ status }), String(status)).toEqual({
        status,
        error: null,
        retry: false,
      });
    }
    for (const status of [99, 600, 200.5, Number.NaN]) {
      expect(alertPostOutcome({ status }), String(status)).toEqual({
        status: null,
        error: 'invalid_status',
        retry: false,
      });
    }
    for (const error of ['dns_failed', 'connect_failed', 'timeout', 'network_error'] as const) {
      expect(alertPostOutcome({ error }), error).toEqual({ status: null, error, retry: true });
    }
    for (const error of [
      'address_blocked',
      'response_too_large',
      'invalid_url',
      'scheme_not_allowed',
      'credentials_in_url',
      'port_not_allowed',
      'header_not_allowed',
      'request_too_large',
    ] as const) {
      expect(alertPostOutcome({ error }), error).toEqual({ status: null, error, retry: false });
    }
  });

  it('labels a failure as the console shows it', () => {
    expect(alertPostFailureLabel(null, 404)).toBe('HTTP 404');
    expect(alertPostFailureLabel('timeout', null)).toBe('No answer within 10 seconds');
    expect(alertPostFailureLabel('address_blocked', null)).toBe(
      'The address is private or reserved',
    );
    expect(alertPostFailureLabel('interrupted', null)).toBe('The attempt was interrupted');
    expect(alertPostFailureLabel('no_channel', null)).toBe('No chat channel was set');
    expect(alertPostFailureLabel('unopenable', null)).toBe(
      'The address does not open with the configured keys',
    );
    expect(alertPostFailureLabel(null, null)).toBeNull();
  });
});

/** A platform database that records each statement and answers it in turn. */
function platformDbAnswering(answers: { rows: unknown[] }[]) {
  const statements: { actor: string; sql: string; params: unknown[] }[] = [];
  const options: unknown[] = [];
  const platformDb = {
    run: async (actor: string, fn: (tx: unknown) => Promise<unknown>, given?: unknown) => {
      options.push(given);
      return fn({
        execute: async (q: SQL) => {
          statements.push({ actor, ...query(q) });
          const next = answers.shift();
          if (!next) throw new Error(`unexpected statement: ${query(q).sql}`);
          return next;
        },
      });
    },
  } as unknown as PlatformDatabase;
  return { platformDb, statements, options };
}

describe('Operations → Alerts’ service (ADR-338)', () => {
  const service = (answers: { rows: unknown[] }[], ring = keyring()) => {
    const { platformDb, statements, options } = platformDbAnswering(answers);
    const enqueued: unknown[][] = [];
    const svc = createAlertChannelService({
      platformDb,
      keyring: ring,
      jobs: {
        enqueue: async (...args: unknown[]) => {
          enqueued.push(args);
          return 'job-1';
        },
      } as never,
      signer: { sign: (envelope: unknown) => ({ signed: envelope }) } as never,
      egressPolicy: PRODUCTION,
      appBaseUrl: BASE,
    });
    return { svc, statements, enqueued, options };
  };

  it('seals the address under a new row’s id and stores it with its host, never in clear', async () => {
    const ring = keyring();
    const { svc, statements } = service([{ rows: [] }], ring);
    expect(await svc.setChannel(OWNER, { url: HOOK })).toEqual({ host: 'hooks.slack.com' });
    expect(statements).toHaveLength(1);
    const [set] = statements;
    expect(set?.actor).toBe('user-owner');
    expect(set?.sql).toBe('select ops.platform_set_alert_channel($1::uuid, $2, $3, $4)');
    const [id, sealed, host, correlation] = set?.params ?? [];
    expect(host).toBe('hooks.slack.com');
    expect(correlation).toBe('c-1');
    expect(JSON.stringify(set?.params)).not.toContain('XXXXXXXX');
    expect(ring.decryptString(String(sealed), alertChannelAad(String(id)))).toBe(HOOK);
    expect(() => ring.decryptString(String(sealed), alertChannelAad('another'))).toThrow();
  });

  it('lets only platform owners set, remove or test the channel, before reaching the database', async () => {
    const { svc, statements, enqueued } = service([]);
    for (const [call, what] of [
      [() => svc.setChannel(OPERATOR, { url: HOOK }), 'set'],
      [() => svc.removeChannel(OPERATOR), 'remove'],
      [() => svc.sendTest(OPERATOR), 'test'],
    ] as const) {
      await expect(call()).rejects.toMatchObject({
        code: 'forbidden',
        message: `Only platform owners can ${what} the chat channel.`,
      });
    }
    expect(statements).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it('refuses an address the egress guard would refuse, before reaching the database', async () => {
    const { svc, statements } = service([]);
    await expect(svc.setChannel(OWNER, { url: 'http://hooks.slack.com/x' })).rejects.toMatchObject({
      code: 'validation_failed',
      issues: [{ path: 'url' }],
    });
    await expect(svc.setChannel(OWNER, {})).rejects.toMatchObject({ code: 'validation_failed' });
    expect(statements).toEqual([]);
  });

  it('removes the channel, saying whether one was set', async () => {
    const { svc, statements } = service([
      { rows: [{ removed: true }] },
      { rows: [{ removed: false }] },
    ]);
    expect(await svc.removeChannel(OWNER)).toEqual({ removed: true });
    expect(await svc.removeChannel(OWNER)).toEqual({ removed: false });
    expect(statements.map((s) => [s.sql, s.params])).toEqual([
      ['select ops.platform_remove_alert_channel($1) as removed', ['c-1']],
      ['select ops.platform_remove_alert_channel($1) as removed', ['c-1']],
    ]);
  });

  it('queues a test post and then wakes the posting job outside the post’s transaction', async () => {
    const { svc, statements, enqueued } = service([{ rows: [{ id: 'post-1' }] }]);
    expect(await svc.sendTest(OWNER)).toEqual({ postId: 'post-1' });
    expect(statements.map((s) => [s.sql, s.params])).toEqual([
      ['select ops.platform_test_alert_channel($1, $2) as id', [alertChannelTestBody(BASE), 'c-1']],
    ]);
    expect(enqueued).toEqual([
      [
        null,
        QUEUES.alertPosts.name,
        {
          signed: {
            kind: QUEUES.alertPosts.name,
            tenantId: null,
            actorUserId: 'user-owner',
            ref: 'post-1',
          },
        },
        { singletonKey: 'alert-posts' },
      ],
    ]);
  });

  it('reads the channel and the latest posts in one snapshot, as dates and numbers', async () => {
    const { svc, statements, options } = service([
      {
        rows: [
          {
            host: 'hooks.slack.com',
            set_by_name: 'Asha Rao',
            set_at: '2026-10-09T10:00:00Z',
            last_sent_at: null,
            last_failed_at: '2026-10-09T10:05:00Z',
            last_status: 404,
            last_error: null,
            posts_waiting: 1,
            posts_failed: '2',
          },
        ],
      },
      {
        rows: [
          {
            id: 'post-1',
            kind: 'queues',
            created_at: '2026-10-09T10:04:00Z',
            attempts: 1,
            next_attempt_at: '2026-10-09T10:04:00Z',
            sent_at: null,
            failed_at: '2026-10-09T10:05:00Z',
            last_status: 404,
            last_error: null,
          },
          { id: 'post-2', kind: 'unknown' },
        ],
      },
    ]);
    expect(await svc.state(OPERATOR)).toEqual({
      channel: {
        host: 'hooks.slack.com',
        setByName: 'Asha Rao',
        setAt: new Date('2026-10-09T10:00:00Z'),
        lastSentAt: null,
        lastFailedAt: new Date('2026-10-09T10:05:00Z'),
        lastStatus: 404,
        lastError: null,
        postsWaiting: 1,
        postsFailed: 2,
      },
      posts: [
        {
          id: 'post-1',
          kind: 'queues',
          createdAt: new Date('2026-10-09T10:04:00Z'),
          attempts: 1,
          nextAttemptAt: new Date('2026-10-09T10:04:00Z'),
          sentAt: null,
          failedAt: new Date('2026-10-09T10:05:00Z'),
          lastStatus: 404,
          lastError: null,
        },
      ],
    });
    expect(statements.map((s) => s.sql)).toEqual([
      'select host, set_by_name, set_at, last_sent_at, last_failed_at, last_status, last_error, posts_waiting, posts_failed from ops.platform_alert_channel_state()',
      'select id, kind, created_at, attempts, next_attempt_at, sent_at, failed_at, last_status, last_error from ops.platform_alert_posts_recent()',
    ]);
    expect(options).toEqual([{ accessMode: 'read only', isolationLevel: 'repeatable read' }]);
  });
});

describe('an alert’s post, queued with its emails (ADR-338)', () => {
  const alert = {
    subject: '2 failures need a look',
    lines: ['Counts & queues.'],
    url: `${BASE}/platform/ops`,
    actionLabel: 'Open operations',
  };
  async function queueWith(queued: boolean) {
    const statements: { sql: string; params: unknown[] }[] = [];
    const enqueued: unknown[][] = [];
    const tx = {
      execute: async (q: SQL) => {
        statements.push(query(q));
        return { rows: [{ queued }] };
      },
    };
    const outbox = {
      keyring: keyring(),
      jobs: {
        enqueue: async (...args: unknown[]) => {
          enqueued.push(args);
          return 'job-1';
        },
      },
      signer: { sign: (envelope: unknown) => ({ signed: envelope }) },
    } as never;
    const result = await queueAlertPost(outbox, tx as never, 'queues', alert);
    return { result, statements, enqueued, tx };
  }

  it('queues the alert’s text while a channel is set, and wakes the posting job in its transaction', async () => {
    const { result, statements, enqueued, tx } = await queueWith(true);
    expect(result).toBe(true);
    expect(statements).toEqual([
      {
        sql: 'select ops.queue_platform_alert_post($1, $2) as queued',
        params: ['queues', alertPostBody(alert)],
      },
    ]);
    expect(enqueued).toEqual([
      [
        tx,
        QUEUES.alertPosts.name,
        {
          signed: {
            kind: QUEUES.alertPosts.name,
            tenantId: null,
            actorUserId: null,
            ref: 'queues',
          },
        },
        { singletonKey: 'alert-posts' },
      ],
    ]);
  });

  it('wakes nothing without a channel', async () => {
    const { result, enqueued } = await queueWith(false);
    expect(result).toBe(false);
    expect(enqueued).toEqual([]);
  });
});

describe('the posting job (ADR-338)', () => {
  type Post = { id: string; kind: string; body: string; attempts: number; created_at: string };
  const post = (id: string, minute: number, kind = 'failures'): Post => ({
    id,
    kind,
    body: `${kind} body ${id}`,
    attempts: 1,
    created_at: `2026-10-09T10:0${minute}:00Z`,
  });

  /** A database answering the job's statements: the purge, the claim, the channel, each finish. */
  function jobDb(opts: {
    posts: Post[];
    channel: { id: string; url_ciphertext: string } | null;
    finish?: (params: unknown[]) => string;
  }) {
    const statements: { scope: unknown; sql: string; params: unknown[] }[] = [];
    const db = {
      run: async (scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: async (q: SQL) => {
            const built = query(q);
            statements.push({ scope, ...built });
            if (built.sql.includes('purge_platform_alert_posts')) return { rows: [{ purged: 2 }] };
            if (built.sql.includes('claim_platform_alert_posts')) return { rows: opts.posts };
            if (built.sql.includes('from ops.platform_alert_channel'))
              return { rows: opts.channel ? [opts.channel] : [] };
            if (built.sql.includes('finish_platform_alert_post'))
              return { rows: [{ state: opts.finish?.(built.params) ?? 'sent' }] };
            throw new Error(`unexpected statement: ${built.sql}`);
          },
        }),
    } as unknown as Database;
    return { db, statements };
  }

  function egressAnswering(answer: (req: EgressRequest) => number | EgressError) {
    const sent: EgressRequest[] = [];
    const egress: EgressClient = {
      request: async (req) => {
        sent.push(req);
        const got = answer(req);
        if (got instanceof EgressError) throw got;
        return {
          status: got,
          headers: {},
          body: Buffer.from('ok'),
          address: '192.0.2.1',
          durationMs: 5,
        };
      },
    } as EgressClient;
    return { egress, sent };
  }

  it('sends the posts claimed, oldest first, as JSON text to the opened address, and records each', async () => {
    const ring = keyring();
    const channel = { id: 'chan-1', url_ciphertext: ring.encrypt(HOOK, alertChannelAad('chan-1')) };
    const { db, statements } = jobDb({
      posts: [post('b', 2, 'queues'), post('a', 1), post('c', 2, 'test')],
      channel,
    });
    const { egress, sent } = egressAnswering(() => 200);
    expect(await sendAlertPosts({ db, keyring: ring, egress })).toEqual({
      claimed: 3,
      sent: 3,
      retrying: 0,
      failed: [],
      unopenable: null,
      purged: 2,
    });
    expect(sent).toEqual(
      ['failures body a', 'queues body b', 'test body c'].map((text) => ({
        method: 'POST',
        url: HOOK,
        headers: { 'content-type': 'application/json', 'user-agent': 'HyFib-W360-Alerts/1' },
        body: JSON.stringify({ text }),
      })),
    );
    expect(statements.map((s) => [s.scope, s.sql])).toEqual([
      [{ kind: 'system' }, 'select ops.purge_platform_alert_posts() as purged'],
      [
        { kind: 'system' },
        'select id, kind, body, attempts, created_at from ops.claim_platform_alert_posts($1)',
      ],
      [{ kind: 'system' }, 'select id, url_ciphertext from ops.platform_alert_channel'],
      ...['a', 'b', 'c'].map((): [unknown, string] => [
        { kind: 'system' },
        'select ops.finish_platform_alert_post($1::uuid, $2::integer, $3::uuid, $4::integer, $5::text, $6::boolean) as state',
      ]),
    ]);
    expect(statements[1]?.params).toEqual([5]);
    expect(statements.slice(3).map((s) => s.params)).toEqual(
      ['a', 'b', 'c'].map((id) => [id, 1, 'chan-1', 200, null, false]),
    );
  });

  it('records a refusal, a retry and no answer with what the channel said, and counts them', async () => {
    const ring = keyring();
    const channel = { id: 'chan-1', url_ciphertext: ring.encrypt(HOOK, alertChannelAad('chan-1')) };
    const answers: Record<string, number | EgressError> = {
      'failures body a': 404,
      'failures body b': 503,
      'failures body c': new EgressError('timeout', 'No answer within 10 seconds.', true),
    };
    const { db, statements } = jobDb({
      posts: [post('a', 1), post('b', 2), post('c', 3)],
      channel,
      // The database decides: here the 503 is retried and the timeout was the post's last attempt.
      finish: (params) => (params[0] === 'b' ? 'retrying' : 'failed'),
    });
    const { egress } = egressAnswering((req) => answers[JSON.parse(String(req.body)).text] ?? 200);
    expect(await sendAlertPosts({ db, keyring: ring, egress })).toEqual({
      claimed: 3,
      sent: 0,
      retrying: 1,
      failed: [
        { id: 'a', kind: 'failures', status: 404, error: null },
        { id: 'c', kind: 'failures', status: null, error: 'timeout' },
      ],
      unopenable: null,
      purged: 2,
    });
    expect(statements.slice(3).map((s) => s.params)).toEqual([
      ['a', 1, 'chan-1', 404, null, false],
      ['b', 1, 'chan-1', 503, null, true],
      ['c', 1, 'chan-1', null, 'timeout', true],
    ]);
  });

  it('sends nothing when an address does not open, and records it to be tried again', async () => {
    const ring = keyring();
    const channel = {
      id: 'chan-1',
      url_ciphertext: keyring().encrypt(HOOK, alertChannelAad('chan-1')),
    };
    const { db, statements } = jobDb({ posts: [post('a', 1)], channel, finish: () => 'retrying' });
    const { egress, sent } = egressAnswering(() => 200);
    const result = await sendAlertPosts({ db, keyring: ring, egress });
    expect(result).toMatchObject({ claimed: 1, sent: 0, retrying: 1, failed: [] });
    expect(result.unopenable).toEqual(expect.any(String));
    expect(result.unopenable).not.toContain('hooks.slack.com');
    expect(sent).toEqual([]);
    expect(statements.at(-1)?.params).toEqual(['a', 1, 'chan-1', null, 'unopenable', true]);
  });

  it('fails a post claimed as the channel was removed, and claims nothing more when none is due', async () => {
    const { db, statements } = jobDb({
      posts: [post('a', 1)],
      channel: null,
      finish: () => 'stale',
    });
    const { egress, sent } = egressAnswering(() => 200);
    expect(await sendAlertPosts({ db, keyring: keyring(), egress })).toMatchObject({
      claimed: 1,
      sent: 0,
      retrying: 0,
      failed: [],
    });
    expect(sent).toEqual([]);
    expect(statements.at(-1)?.params).toEqual(['a', 1, null, null, 'no_channel', false]);

    const idle = jobDb({ posts: [], channel: null });
    expect(await sendAlertPosts({ db: idle.db, keyring: keyring(), egress })).toEqual({
      claimed: 0,
      sent: 0,
      retrying: 0,
      failed: [],
      unopenable: null,
      purged: 2,
    });
    expect(idle.statements).toHaveLength(2);
  });

  it('lets an error other than the egress guard’s through, to be retried after the lease', async () => {
    const ring = keyring();
    const channel = { id: 'chan-1', url_ciphertext: ring.encrypt(HOOK, alertChannelAad('chan-1')) };
    const { db } = jobDb({ posts: [post('a', 1)], channel });
    const egress = {
      request: async () => {
        throw new TypeError('bug');
      },
    } as unknown as EgressClient;
    await expect(sendAlertPosts({ db, keyring: ring, egress })).rejects.toThrow('bug');
  });
});
