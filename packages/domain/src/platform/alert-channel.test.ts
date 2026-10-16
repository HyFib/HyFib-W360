import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AppError, Keyring } from '@w360/core';
import { EgressError, type EgressClient, type EgressRequest } from '@w360/core/egress';
import { QUEUES } from '@w360/contracts';
import type { Database, SQL } from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import {
  ALERT_CHANNEL_DEFAULT_KINDS,
  ALERT_CHANNEL_FINANCIAL_KINDS,
  ALERT_CHANNEL_FORMAT_LABELS,
  ALERT_CHANNEL_FORMATS,
  ALERT_CHANNEL_KINDS,
  ALERT_POST_KIND_LABELS,
  ALERT_POST_KINDS,
  ALERT_POST_MAX_CHARS,
  TEAMS_MESSAGE_MAX_BYTES,
  alertChannelAad,
  alertChannelTestAlert,
  alertChannelTestBody,
  alertPostBody,
  alertPostFailureLabel,
  alertPostOutcome,
  alertPostPlain,
  alertPostRequestBody,
  chatEscape,
  chatUnescape,
  isAlertChannelFormat,
  teamsCardBody,
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
      'The alerts chosen under Operations → Alerts are posted here when they are emailed, with counts only.',
      `Open the alerts: ${BASE}/platform/ops/alerts`,
    ]);
  });
});

describe('the alerts a channel gets (ADR-340, ADR-345)', () => {
  it('lists the operations alerts and then the owners’ ones, the operations ones by default', () => {
    expect(ALERT_CHANNEL_KINDS).toEqual([
      'failures',
      'queues',
      'integrations',
      'reconciliation',
      'unsettled',
      'refund_requests',
    ]);
    expect(ALERT_CHANNEL_DEFAULT_KINDS).toEqual(['failures', 'queues', 'integrations']);
    expect(ALERT_CHANNEL_FINANCIAL_KINDS).toEqual([
      'reconciliation',
      'unsettled',
      'refund_requests',
    ]);
    expect(ALERT_POST_KINDS).toEqual([...ALERT_CHANNEL_KINDS, 'test']);
    expect(ALERT_POST_KIND_LABELS).toEqual({
      failures: 'Failures',
      queues: 'Late queues',
      integrations: 'Failing integrations',
      reconciliation: 'Reconciliation findings',
      unsettled: 'Payments not seen in a settlement',
      refund_requests: 'Refund requests',
      test: 'Test post',
    });
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
    expect(alertPostFailureLabel('unticked', null)).toBe(
      'Its alert was unticked before it was sent',
    );
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
  const service = (answers: { rows: unknown[] }[], ring = keyring(), wake = true) => {
    const { platformDb, statements, options } = platformDbAnswering(answers);
    const enqueued: unknown[][] = [];
    const svc = createAlertChannelService({
      platformDb,
      keyring: ring,
      jobs: {
        enqueue: async (...args: unknown[]) => {
          enqueued.push(args);
          if (!wake) throw new Error('pg-boss is down');
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
    expect(await svc.setChannel(OWNER, { url: HOOK, format: 'text' })).toEqual({
      host: 'hooks.slack.com',
      format: 'text',
    });
    expect(statements).toHaveLength(1);
    const [set] = statements;
    expect(set?.actor).toBe('user-owner');
    expect(set?.sql).toBe('select ops.platform_set_alert_channel($1::uuid, $2, $3, $4, $5)');
    const [id, sealed, host, format, correlation] = set?.params ?? [];
    expect(host).toBe('hooks.slack.com');
    expect(format).toBe('text');
    expect(correlation).toBe('c-1');
    expect(JSON.stringify(set?.params)).not.toContain('XXXXXXXX');
    expect(ring.decryptString(String(sealed), alertChannelAad(String(id)))).toBe(HOOK);
    expect(() => ring.decryptString(String(sealed), alertChannelAad('another'))).toThrow();
  });

  it('lets only platform owners set, remove or test the channel, before reaching the database', async () => {
    const { svc, statements, enqueued } = service([]);
    for (const [call, what] of [
      [() => svc.setChannel(OPERATOR, { url: HOOK, format: 'text' }), 'set the chat channel'],
      [() => svc.setFormat(OPERATOR, { format: 'teams_card' }), 'choose the chat channel’s format'],
      [() => svc.removeChannel(OPERATOR), 'remove the chat channel'],
      [() => svc.sendTest(OPERATOR), 'test the chat channel'],
      [() => svc.setKinds(OPERATOR, { kinds: ['failures'] }), 'choose the chat channel’s alerts'],
    ] as const) {
      await expect(call()).rejects.toMatchObject({
        code: 'forbidden',
        message: `Only platform owners can ${what}.`,
      });
    }
    expect(statements).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it('refuses an address the egress guard would refuse, before reaching the database', async () => {
    const { svc, statements } = service([]);
    await expect(
      svc.setChannel(OWNER, { url: 'http://hooks.slack.com/x', format: 'text' }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      issues: [{ path: 'url' }],
    });
    await expect(svc.setChannel(OWNER, {})).rejects.toMatchObject({ code: 'validation_failed' });
    expect(statements).toEqual([]);
  });

  it('sets a channel in the Teams format, and refuses no format or an unknown one before the database (ADR-388)', async () => {
    const { svc, statements } = service([{ rows: [] }]);
    expect(await svc.setChannel(OWNER, { url: HOOK, format: 'teams_card' })).toEqual({
      host: 'hooks.slack.com',
      format: 'teams_card',
    });
    expect(statements[0]?.params[3]).toBe('teams_card');
    for (const input of [
      { url: HOOK },
      { url: HOOK, format: 'pagerduty' },
      { url: HOOK, format: 'TEXT' },
      { url: HOOK, format: null },
    ]) {
      await expect(svc.setChannel(OWNER, input), JSON.stringify(input)).rejects.toMatchObject({
        code: 'validation_failed',
        issues: [expect.objectContaining({ message: 'Choose one of the formats listed.' })],
      });
    }
    expect(statements).toHaveLength(1);
  });

  it('changes the format alone, never asking for the address, and gives back what it now is (ADR-388)', async () => {
    const { svc, statements } = service([
      { rows: [{ format: 'teams_card' }] },
      { rows: [{ format: 'pagerduty' }] },
      { rows: [] },
    ]);
    expect(await svc.setFormat(OWNER, { format: 'teams_card' })).toEqual({ format: 'teams_card' });
    expect(statements.map((s) => [s.actor, s.sql, s.params])).toEqual([
      [
        'user-owner',
        'select ops.platform_set_alert_channel_format($1, $2) as format',
        ['teams_card', 'c-1'],
      ],
    ]);
    // A format the database gave that the services do not know, or none, is an error.
    await expect(svc.setFormat(OWNER, { format: 'text' })).rejects.toThrow(
      'ops.platform_set_alert_channel_format gave no known format: pagerduty',
    );
    await expect(svc.setFormat(OWNER, { format: 'text' })).rejects.toThrow(/gave no known format/);
    for (const input of [{}, { format: 'card' }, { format: ['text'] }]) {
      await expect(svc.setFormat(OWNER, input)).rejects.toMatchObject({
        code: 'validation_failed',
        issues: [expect.objectContaining({ message: 'Choose one of the formats listed.' })],
      });
    }
    expect(statements).toHaveLength(3);
  });

  it('chooses the alerts the channel gets, once each in the console’s order, and gives back what it now gets', async () => {
    const { svc, statements } = service([
      { rows: [{ kinds: ['queues', 'reconciliation'] }] },
      { rows: [{ kinds: ['failures', 'gone'] }] },
    ]);
    expect(
      await svc.setKinds(OWNER, { kinds: ['reconciliation', 'queues', 'reconciliation'] }),
    ).toEqual({ kinds: ['queues', 'reconciliation'] });
    // A kind the database gave that the services do not know is left out.
    expect(await svc.setKinds(OWNER, { kinds: ['failures'] })).toEqual({ kinds: ['failures'] });
    expect(statements.map((s) => [s.actor, s.sql, s.params])).toEqual([
      [
        'user-owner',
        'select ops.platform_set_alert_channel_kinds($1::text[], $2) as kinds',
        [['queues', 'reconciliation'], 'c-1'],
      ],
      [
        'user-owner',
        'select ops.platform_set_alert_channel_kinds($1::text[], $2) as kinds',
        [['failures'], 'c-1'],
      ],
    ]);
  });

  it('refuses no alert, an alert it does not know and anything but a list, before reaching the database', async () => {
    const { svc, statements } = service([]);
    for (const input of [
      { kinds: [] },
      { kinds: ['failures', 'payments'] },
      { kinds: 'failures' },
      {},
    ]) {
      await expect(svc.setKinds(OWNER, input)).rejects.toMatchObject({
        code: 'validation_failed',
        issues: [expect.objectContaining({ message: 'Choose at least one of the alerts listed.' })],
      });
    }
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
    expect(await svc.sendTest(OWNER)).toEqual({ postId: 'post-1', wakeError: null });
    expect(statements.map((s) => [s.sql, s.params])).toEqual([
      [
        'select ops.platform_test_alert_channel($1, $2, $3) as id',
        [alertChannelTestBody(BASE), alertPostPlain(alertChannelTestAlert(BASE)), 'c-1'],
      ],
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

  it('gives back an error waking the job, the test post queued all the same', async () => {
    const { svc, statements, enqueued } = service([{ rows: [{ id: 'post-1' }] }], keyring(), false);
    const sent = await svc.sendTest(OWNER);
    expect(sent.postId).toBe('post-1');
    expect(sent.wakeError?.message).toBe('pg-boss is down');
    expect(statements).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
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
            kinds: ['refund_requests', 'unsettled', 'failures', 'gone'],
            format: 'teams_card',
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
        format: 'teams_card',
        // In the console's order, without a kind the services do not know.
        kinds: ['failures', 'unsettled', 'refund_requests'],
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
      'select host, set_by_name, set_at, last_sent_at, last_failed_at, last_status, last_error, posts_waiting, posts_failed, kinds, format from ops.platform_alert_channel_state()',
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
        sql: 'select ops.queue_platform_alert_post($1, $2, $3) as queued',
        // Escaped for the workers of the release before, and unescaped for this one's (ADR-388).
        params: ['queues', alertPostBody(alert), alertPostPlain(alert)],
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
  type Post = {
    id: string;
    kind: string;
    body: string;
    plain_body: string | null;
    attempts: number;
    created_at: string;
    format: string;
  };
  /** A post queued before migration 0304 (no unescaped text), claimed for the `text` format. */
  const post = (id: string, minute: number, kind = 'failures'): Post => ({
    id,
    kind,
    body: `${kind} body ${id}`,
    plain_body: null,
    attempts: 1,
    created_at: `2026-10-09T10:0${minute}:00Z`,
    format: 'text',
  });

  /**
   * A database answering the job's statements: the purge, the claim, the channel, each finish. Each
   * statement records its transaction, numbered from 1.
   */
  function jobDb(opts: {
    posts: Post[];
    channel: { id: string; url_ciphertext: string } | null;
    finish?: (params: unknown[]) => string;
  }) {
    const statements: { scope: unknown; tx: number; sql: string; params: unknown[] }[] = [];
    let transactions = 0;
    const db = {
      run: async (scope: unknown, fn: (tx: unknown) => Promise<unknown>) => {
        const tx = ++transactions;
        return fn({
          execute: async (q: SQL) => {
            const built = query(q);
            statements.push({ scope, tx, ...built });
            if (built.sql.includes('purge_platform_alert_posts')) return { rows: [{ purged: 2 }] };
            if (built.sql.includes('claim_platform_alert_posts')) return { rows: opts.posts };
            if (built.sql.includes('from ops.platform_alert_channel'))
              return { rows: opts.channel ? [opts.channel] : [] };
            if (built.sql.includes('finish_platform_alert_post'))
              return { rows: [{ state: opts.finish?.(built.params) ?? 'sent' }] };
            throw new Error(`unexpected statement: ${built.sql}`);
          },
        });
      },
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
    // The address is read in the claim's transaction, which holds the channel's row; the purge and
    // each finish have a transaction of their own.
    expect(statements.map((s) => [s.scope, s.tx, s.sql])).toEqual([
      [{ kind: 'system' }, 1, 'select ops.purge_platform_alert_posts() as purged'],
      [
        { kind: 'system' },
        2,
        'select id, kind, body, plain_body, attempts, created_at, format from ops.claim_platform_alert_posts($1, $2::text[])',
      ],
      [{ kind: 'system' }, 2, 'select id, url_ciphertext from ops.platform_alert_channel'],
      ...[3, 4, 5].map((tx): [unknown, number, string] => [
        { kind: 'system' },
        tx,
        'select ops.finish_platform_alert_post($1::uuid, $2::integer, $3::uuid, $4::integer, $5::text, $6::boolean) as state',
      ]),
    ]);
    // The job names the formats it renders: the claim hands out nothing for another.
    expect(statements[1]?.params).toEqual([5, ['text', 'teams_card']]);
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

  it('fails a post claimed when no channel is read, and claims nothing more when none is due', async () => {
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

  it('renders each post in the format it was claimed with, from its unescaped text (ADR-388)', async () => {
    const ring = keyring();
    const channel = { id: 'chan-1', url_ciphertext: ring.encrypt(HOOK, alertChannelAad('chan-1')) };
    const alert = {
      subject: '2 failures <need> a look',
      lines: ['Counts & queues.'],
      url: `${BASE}/platform/ops?a=1&b=2`,
      actionLabel: 'Open operations',
    };
    const queued = { body: alertPostBody(alert), plain_body: alertPostPlain(alert) };
    const { db } = jobDb({
      posts: [
        { ...post('a', 1), ...queued, format: 'teams_card' },
        // Queued before migration 0304: escaped only, unescaped for the card.
        { ...post('b', 2), body: alertPostBody(alert), format: 'teams_card' },
        { ...post('c', 3), ...queued, format: 'text' },
      ],
      channel,
    });
    const { egress, sent } = egressAnswering(() => 202);
    expect(await sendAlertPosts({ db, keyring: ring, egress })).toMatchObject({
      claimed: 3,
      sent: 3,
    });
    const card = teamsCardBody(
      [
        '2 failures <need> a look',
        'Counts & queues.',
        `Open operations: ${BASE}/platform/ops?a=1&b=2`,
      ].join('\n'),
    );
    expect(sent.map((r) => [r.headers, r.body])).toEqual([
      [{ 'content-type': 'application/json', 'user-agent': 'HyFib-W360-Alerts/1' }, card],
      [{ 'content-type': 'application/json', 'user-agent': 'HyFib-W360-Alerts/1' }, card],
      [
        { 'content-type': 'application/json', 'user-agent': 'HyFib-W360-Alerts/1' },
        JSON.stringify({ text: alertPostBody(alert) }),
      ],
    ]);
  });

  it('refuses a format the claim was not asked for, before sending anything', async () => {
    const ring = keyring();
    const channel = { id: 'chan-1', url_ciphertext: ring.encrypt(HOOK, alertChannelAad('chan-1')) };
    const { db, statements } = jobDb({
      posts: [{ ...post('a', 1), format: 'pagerduty' }],
      channel,
    });
    const { egress, sent } = egressAnswering(() => 200);
    await expect(sendAlertPosts({ db, keyring: ring, egress })).rejects.toThrow(
      'ops.claim_platform_alert_posts gave no known format: pagerduty',
    );
    expect(sent).toEqual([]);
    expect(statements.some((s) => s.sql.includes('finish_platform_alert_post'))).toBe(false);
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

describe('a post rendered in the channel’s format (ADR-388)', () => {
  const alert = {
    subject: '3 failures <b>need</b> a look',
    lines: ['2 jobs & 1 receipt *now*.', '   ', 'Counts only.'],
    url: `${BASE}/platform/ops?a=1&b=2`,
    actionLabel: 'Open operations',
  };
  const lines = [
    '3 failures <b>need</b> a look',
    '2 jobs & 1 receipt *now*.',
    'Counts only.',
    `Open operations: ${BASE}/platform/ops?a=1&b=2`,
  ];
  const cardWith = (body: unknown[]) => ({
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.2',
          body,
        },
      },
    ],
  });
  const cardOf = (texts: string[]) =>
    cardWith(
      texts.map((text, index) =>
        index === 0
          ? { type: 'TextBlock', text, weight: 'bolder', wrap: true }
          : { type: 'TextBlock', text, wrap: true },
      ),
    );
  const blocksOf = (message: string) =>
    (JSON.parse(message) as { attachments: { content: { body: { text: string }[] } }[] })
      .attachments[0]!.content.body;
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
  const MORE = { type: 'TextBlock', text: '…', wrap: true };

  it('lists the formats, `text` first, with their labels', () => {
    expect(ALERT_CHANNEL_FORMATS).toEqual(['text', 'teams_card']);
    expect(ALERT_CHANNEL_FORMAT_LABELS).toEqual({
      text: 'JSON text (Slack and similar)',
      teams_card: 'Microsoft Teams card (Workflows)',
    });
    expect(['text', 'teams_card'].map(isAlertChannelFormat)).toEqual([true, true]);
    expect(['', 'Text', 'teams', 'card', 'toString'].map(isAlertChannelFormat)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('keeps a post’s text unescaped, one a line, as the escaped body gives it escaped', () => {
    const plain = alertPostPlain(alert);
    expect(plain).toBe([lines[0], lines[1], '   ', lines[2], lines[3]].join('\n'));
    expect(chatEscape(plain)).toBe(alertPostBody(alert));
    expect(chatUnescape(alertPostBody(alert))).toBe(plain);
  });

  it('holds the unescaped text to 4,000 characters, cut before half a character, not before an ampersand', () => {
    const of = (line: string) => ({ subject: 's', lines: [line], url: BASE, actionLabel: 'Open' });
    // 's', a line of 3,970 and 'Open: ' and the link, on three lines: 4,000 exactly.
    expect(alertPostPlain(of('x'.repeat(3970)))).toHaveLength(4000);
    expect(alertPostPlain(of('x'.repeat(3970))).endsWith(`Open: ${BASE}`)).toBe(true);
    const over = alertPostPlain(of('x'.repeat(3971)));
    expect(over).toBe(`s\n${'x'.repeat(3971)}\nOpen: ${BASE}`.slice(0, 3999) + '…');
    expect(over).toHaveLength(4000);
    // Ampersands are text here, not the start of an escape: kept up to the cut.
    expect(alertPostPlain(of(`${'x'.repeat(3990)}${'&'.repeat(10)}`))).toBe(
      `s\n${'x'.repeat(3990)}${'&'.repeat(7)}…`,
    );
    expect(alertPostPlain(of(`${'x'.repeat(3996)}😀😀`))).toBe(`s\n${'x'.repeat(3996)}…`);
  });

  it('undoes exactly the three escapes, and only them, whatever the text', () => {
    for (const text of [
      'a & b < c > d',
      '&amp; &lt; &gt; &quot; &#39; &nbsp;',
      '&&&<<<>>>',
      '&am',
      '',
      'பணம் 😀 → “x”',
    ]) {
      expect(chatUnescape(chatEscape(text)), text).toBe(text);
    }
    // What `chatEscape` never writes stays as it is.
    expect(chatUnescape('&quot; &#38; &AMP; &amp')).toBe('&quot; &#38; &AMP; &amp');
    expect(chatUnescape('&amp;lt;')).toBe('&lt;');
    // A post cut by the escaped body's rule unescapes whole: the cut never splits an escape.
    const cut = alertPostBody({
      subject: 's',
      lines: [`${'x'.repeat(3990)}${'<'.repeat(10)}`],
      url: BASE,
      actionLabel: 'Open',
    });
    expect(chatUnescape(cut)).toBe(`s\n${'x'.repeat(3990)}<…`);
  });

  it('renders the text format as a JSON text member, escaped once from the unescaped text', () => {
    const plain = alertPostPlain(alert);
    expect(
      JSON.parse(alertPostRequestBody('text', { body: alertPostBody(alert), plainBody: plain })),
    ).toEqual({ text: alertPostBody(alert) });
    // The escaped body is not read when the unescaped text is there.
    expect(alertPostRequestBody('text', { body: 'stale', plainBody: 'a < b' })).toBe(
      JSON.stringify({ text: 'a &lt; b' }),
    );
    // Over 4,000 characters once escaped: cut before an escape, as the escaped body is.
    const long = `${'x'.repeat(3990)}${'&'.repeat(10)}`;
    const sent = JSON.parse(alertPostRequestBody('text', { body: 'x', plainBody: long })) as {
      text: string;
    };
    expect(sent.text).toBe(`${'x'.repeat(3990)}&amp;…`);
  });

  it('sends a post queued before migration 0304 as it was queued, never escaped twice', () => {
    const body = alertPostBody(alert);
    expect(alertPostRequestBody('text', { body, plainBody: null })).toBe(
      JSON.stringify({ text: body }),
    );
    expect(alertPostRequestBody('text', { body: 'a &amp; b', plainBody: null })).toBe(
      '{"text":"a &amp; b"}',
    );
  });

  it('renders a Teams card: a wrapping block a line, the subject in bold, blank lines left out, nothing escaped', () => {
    const card = alertPostRequestBody('teams_card', {
      body: alertPostBody(alert),
      plainBody: alertPostPlain(alert),
    });
    expect(JSON.parse(card)).toEqual(cardOf(lines));
    expect(card).not.toContain('&amp;');
    expect(card).not.toContain('&lt;');
    // The text as written, HTML among it, is what the card shows: never escaped for it.
    expect(card).toContain('"text":"3 failures <b>need</b> a look"');
  });

  it('renders a card from a post queued before migration 0304 by undoing its escapes', () => {
    const fromOld = alertPostRequestBody('teams_card', {
      body: alertPostBody(alert),
      plainBody: null,
    });
    expect(JSON.parse(fromOld)).toEqual(cardOf(lines));
    expect(
      JSON.parse(alertPostRequestBody('teams_card', { body: 'Queue x &amp;lt;', plainBody: null })),
    ).toEqual(cardOf(['Queue x &lt;']));
  });

  it('renders the test post in either format', () => {
    const test = alertChannelTestAlert(BASE);
    const post = { body: alertChannelTestBody(BASE), plainBody: alertPostPlain(test) };
    expect(JSON.parse(alertPostRequestBody('text', post))).toEqual({
      text: alertChannelTestBody(BASE),
    });
    expect(JSON.parse(alertPostRequestBody('teams_card', post))).toEqual(
      cardOf([
        'HyFib W360: a test post from the operations console',
        'The alerts chosen under Operations → Alerts are posted here when they are emailed, with counts only.',
        `Open the alerts: ${BASE}/platform/ops/alerts`,
      ]),
    );
  });

  it('keeps a card within Teams’ 28 KB, leaving out lines from the end for a last “…”', () => {
    expect(TEAMS_MESSAGE_MAX_BYTES).toBe(28_000);
    // 4,000 characters of alert in the most lines: every line kept would be about 88 KB.
    const texts = Array.from({ length: 2000 }, (_, i) => String(i % 10));
    const cut = teamsCardBody(texts.join('\n'));
    expect(bytes(cut)).toBeLessThanOrEqual(TEAMS_MESSAGE_MAX_BYTES);
    const blocks = blocksOf(cut);
    const kept = blocks.length - 1;
    expect(kept).toBeGreaterThan(500);
    expect(JSON.parse(cut)).toEqual(
      cardWith([...cardOf(texts.slice(0, kept)).attachments[0]!.content.body, MORE]),
    );
    // As many lines as fit: one more line and the last block would not.
    const block = bytes(JSON.stringify({ type: 'TextBlock', text: '0', wrap: true })) + 1;
    expect(bytes(cut) + block).toBeGreaterThan(TEAMS_MESSAGE_MAX_BYTES);
  });

  it('keeps a line that brings a cut card to exactly the limit', () => {
    const tooLong = 'y'.repeat(30_000);
    // A subject and a line that cannot fit: the subject and the last block.
    const frame = bytes(teamsCardBody(`s\n${tooLong}`));
    const empty = bytes(JSON.stringify({ type: 'TextBlock', text: '', wrap: true }));
    // A line whose block and comma fill the rest to the byte, before the line that cannot fit.
    const fill = 'x'.repeat(TEAMS_MESSAGE_MAX_BYTES - frame - empty - 1);
    const card = teamsCardBody(`s\n${fill}\n${tooLong}`);
    expect(bytes(card)).toBe(TEAMS_MESSAGE_MAX_BYTES);
    expect(blocksOf(card).map((b) => b.text)).toEqual(['s', fill, '…']);
  });

  it('counts the card in UTF-8 bytes, not characters', () => {
    // 400 lines of nine three-byte characters: about 21,200 characters serialized but 28,400 bytes.
    const euros = Array.from({ length: 400 }, () => '€'.repeat(9));
    expect(euros.join('\n').length).toBeLessThanOrEqual(ALERT_POST_MAX_CHARS);
    const card = teamsCardBody(euros.join('\n'));
    expect(card.length).toBeLessThan(TEAMS_MESSAGE_MAX_BYTES);
    expect(bytes(card)).toBeLessThanOrEqual(TEAMS_MESSAGE_MAX_BYTES);
    expect(blocksOf(card).at(-1)).toEqual(MORE);
    expect(blocksOf(card).length).toBeLessThan(400);
  });

  it('fits the longest single line whole, even escaped by JSON, and a card of exactly the limit', () => {
    const control = '\u0001'.repeat(ALERT_POST_MAX_CHARS);
    const whole = teamsCardBody(control);
    expect(bytes(whole)).toBeLessThanOrEqual(TEAMS_MESSAGE_MAX_BYTES);
    expect(JSON.parse(whole)).toEqual(cardOf([control]));
    // A subject and one line sized so the message is exactly the limit, kept whole; one byte more
    // and the line is left out.
    const frame = bytes(teamsCardBody('s\nx'));
    const exact = `s\n${'x'.repeat(1 + TEAMS_MESSAGE_MAX_BYTES - frame)}`;
    const card = teamsCardBody(exact);
    expect(bytes(card)).toBe(TEAMS_MESSAGE_MAX_BYTES);
    expect(JSON.parse(card)).toEqual(cardOf(exact.split('\n')));
    expect(JSON.parse(teamsCardBody(`${exact}x`))).toEqual(
      cardWith([{ type: 'TextBlock', text: 's', weight: 'bolder', wrap: true }, MORE]),
    );
  });
});
