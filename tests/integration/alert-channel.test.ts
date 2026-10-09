import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QUEUES } from '@w360/contracts';
import { isAppError, uuidv7 } from '@w360/core';
import { createEgressClient, DEFAULT_EGRESS_POLICY } from '@w360/core/egress';
import { sql, systemScope } from '@w360/db';
import {
  alertChannelAad,
  alertChannelTestBody,
  alertFailures,
  alertPostBody,
  createAlertChannelService,
  outboxAad,
  sendAlertPosts,
  type PlatformActor,
} from '@w360/domain';
import { createUser } from './helpers';
import { startWhatsAppFixture, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * A chat channel for the operations alerts (P5-10, ADR-338) against real PostgreSQL: only platform
 * owners set, test and remove it and choose the alerts it gets (ADR-340), through definer functions
 * that audit its host and never its address, which only the runtime role can read, sealed; the
 * alerts queue their posts in the transaction of their emails, and the posting job sends them to a
 * local receiver as JSON text, records each answer, tries a post again after a 5xx, a 429 or no
 * answer (1, 2, 4 and 8 minutes later) and gives up after a 4xx or its fifth attempt. The channel
 * is one row for the whole platform, so each test starts without one.
 */
let fx: WhatsAppFixture;
let owner: PlatformActor;
let operator: PlatformActor;
let receiver: Server;
let hookUrl = '';
/** What the receiver answers next, in turn; 200 once they are used up. */
const answers: number[] = [];
const received: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = [];

const BASE = 'https://app.w360.test';
const LOOPBACK = { allowLoopbackForTests: true };
/** The alerts a new channel gets (ADR-340). */
const OPERATIONS = ['failures', 'queues', 'integrations'];

const service = () =>
  createAlertChannelService({
    platformDb: fx.dbs.platform,
    keyring: fx.keyring,
    jobs: fx.jobs(),
    signer: fx.signer,
    egressPolicy: LOOPBACK,
    appBaseUrl: BASE,
  });
const egress = createEgressClient({ ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: true });
const send = () => sendAlertPosts({ db: fx.dbs.app, keyring: fx.keyring, egress });

async function staffOf(role: PlatformActor['role']): Promise<PlatformActor> {
  const user = await createUser(fx.dbs, { twoFactor: true, name: `Staff ${role}` });
  await fx.dbs.ownerPool.query(`INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, $2)`, [
    user.id,
    role,
  ]);
  return { userId: user.id, role, correlationId: uuidv7() };
}

async function expectCode(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.message).toMatch(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

const posts = () =>
  fx.query<{
    id: string;
    kind: string;
    body: string;
    attempts: number;
    sent: boolean;
    failed: boolean;
    last_status: number | null;
    last_error: string | null;
    wait_minutes: number;
  }>(
    `SELECT id, kind, body, attempts, sent_at IS NOT NULL AS sent, failed_at IS NOT NULL AS failed,
            last_status, last_error,
            round(extract(epoch FROM next_attempt_at - now()) / 60)::int AS wait_minutes
       FROM ops.platform_alert_posts ORDER BY created_at, id`,
  );
/** Makes every post waiting due now, as if its wait had passed. */
const due = () =>
  fx.query(
    `UPDATE ops.platform_alert_posts SET next_attempt_at = now()
      WHERE sent_at IS NULL AND failed_at IS NULL`,
  );
const auditOf = (actor: PlatformActor) =>
  fx.query<{ action: string; metadata: Record<string, unknown>; correlation_id: string | null }>(
    `SELECT action, metadata, correlation_id FROM ops.platform_audit_events
      WHERE actor_user_id = $1 AND action LIKE 'platform.alert_channel%' ORDER BY occurred_at, id`,
    [actor.userId],
  );

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      res.writeHead(answers.shift() ?? 200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/services/T0/B0/hook-secret-4f1c`;
  owner = await staffOf('platform_owner');
  operator = await staffOf('platform_operator');
});

beforeEach(async () => {
  await fx.query(`DELETE FROM ops.platform_alert_channel`);
  await fx.query(`DELETE FROM ops.platform_alert_posts`);
  answers.length = 0;
  received.length = 0;
});

afterAll(async () => {
  // No channel outlives the file: later files' alerts are emailed only.
  await fx?.query(`DELETE FROM ops.platform_alert_channel`);
  await fx?.query(`DELETE FROM ops.platform_alert_posts`);
  receiver?.closeAllConnections();
  receiver?.close();
  await fx?.close();
});

describe('the chat channel (ADR-338)', () => {
  it('lets platform owners set it, sealed under its row and audited by its host only', async () => {
    // The audit is append-only and the owner is the file's: this test's entries are those after.
    const before = (await auditOf(owner)).length;
    await expectCode(service().setChannel(operator, { url: hookUrl }), 'forbidden');
    // The definer function holds the same rule for a caller that skips the service.
    await expectCode(
      fx.dbs.platform.run(operator.userId, (tx) =>
        tx.execute(
          sql`select ops.platform_set_alert_channel(${uuidv7()}::uuid, 'v1:x', 'example.com', null)`,
        ),
      ),
      'forbidden',
      /Only a platform owner can set the chat channel/,
    );
    expect(await fx.query(`SELECT id FROM ops.platform_alert_channel`)).toEqual([]);

    expect(await service().setChannel(owner, { url: hookUrl })).toEqual({ host: '127.0.0.1' });
    const [row] = await fx.query<{
      id: string;
      url_ciphertext: string;
      host: string;
      set_by: string;
    }>(`SELECT id, url_ciphertext, host, set_by FROM ops.platform_alert_channel`);
    expect(row).toMatchObject({ host: '127.0.0.1', set_by: owner.userId });
    expect(row!.url_ciphertext).not.toContain('hook-secret');
    expect(fx.keyring.decryptString(row!.url_ciphertext, alertChannelAad(row!.id))).toBe(hookUrl);

    // A new address replaces the channel, as a new row: one channel at most.
    const replacement = `${hookUrl}-2`;
    await service().setChannel(owner, { url: replacement });
    const rows = await fx.query<{ id: string; url_ciphertext: string }>(
      `SELECT id, url_ciphertext FROM ops.platform_alert_channel`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(row!.id);
    expect(fx.keyring.decryptString(rows[0]!.url_ciphertext, alertChannelAad(rows[0]!.id))).toBe(
      replacement,
    );
    await expect(
      fx.query(
        `INSERT INTO ops.platform_alert_channel (id, url_ciphertext, host) VALUES ($1, 'v1:x', 'b')`,
        [uuidv7()],
      ),
    ).rejects.toThrow(/platform_alert_channel_one/);

    const audit = (await auditOf(owner)).slice(before);
    expect(audit.map((a) => [a.action, a.metadata])).toEqual([
      ['platform.alert_channel_set', { host: '127.0.0.1', kinds: OPERATIONS }],
      [
        'platform.alert_channel_set',
        { host: '127.0.0.1', previousHost: '127.0.0.1', kinds: OPERATIONS },
      ],
    ]);
    expect(audit[0]!.correlation_id).toBe(owner.correlationId);
    expect(JSON.stringify(audit)).not.toContain('hook-secret');

    // Every administrator reads the channel's state, never its address.
    const state = await service().state(operator);
    expect(state.channel).toMatchObject({
      host: '127.0.0.1',
      setByName: 'Staff platform_owner',
      lastSentAt: null,
      lastFailedAt: null,
      postsWaiting: 0,
      postsFailed: 0,
    });
    expect(JSON.stringify(state)).not.toContain('hook-secret');
  });

  it('gives the address to the runtime role alone, which may only read it and re-encrypt it', async () => {
    const can = async (role: string, column: string, privilege: string) =>
      (
        await fx.query<{ ok: boolean }>(
          `SELECT has_column_privilege($1, 'ops.platform_alert_channel', $2, $3) AS ok`,
          [role, column, privilege],
        )
      )[0]!.ok;
    for (const role of ['w360_platform', 'w360_auth']) {
      for (const column of ['url_ciphertext', 'host', 'set_by', 'kinds']) {
        expect(await can(role, column, 'SELECT'), `${role} ${column}`).toBe(false);
      }
    }
    expect(await can('w360_app', 'url_ciphertext', 'SELECT')).toBe(true);
    expect(await can('w360_app', 'url_ciphertext', 'UPDATE')).toBe(false);
    for (const column of ['host', 'kinds']) {
      expect(await can('w360_app', column, 'SELECT'), column).toBe(false);
      expect(await can('w360_app', column, 'UPDATE'), column).toBe(false);
    }
    const [table] = await fx.query<{ insert: boolean; delete: boolean; posts: boolean }>(
      `SELECT has_table_privilege('w360_app', 'ops.platform_alert_channel', 'INSERT') AS insert,
              has_table_privilege('w360_app', 'ops.platform_alert_channel', 'DELETE') AS delete,
              has_table_privilege('w360_app', 'ops.platform_alert_posts', 'SELECT')
                OR has_table_privilege('w360_platform', 'ops.platform_alert_posts', 'SELECT')
                AS posts`,
    );
    expect(table).toEqual({ insert: false, delete: false, posts: false });

    // Its re-encryption (the keyring sweep) replaces the value it opened, and only with another
    // sealed value.
    await service().setChannel(owner, { url: hookUrl });
    const [row] = await fx.query<{ id: string; url_ciphertext: string }>(
      `SELECT id, url_ciphertext FROM ops.platform_alert_channel`,
    );
    const resealed = fx.keyring.encrypt(hookUrl, alertChannelAad(row!.id));
    const reseal = (old: string, next: string) =>
      fx.dbs.app.run(systemScope, (tx) =>
        tx.execute<{ swapped: boolean }>(
          sql`select ops.reseal_platform_alert_channel(${row!.id}::uuid, ${old}, ${next}) as swapped`,
        ),
      );
    expect((await reseal('v1:another', resealed)).rows[0]?.swapped).toBe(false);
    await expectCode(reseal(row!.url_ciphertext, 'in clear'), 'precondition_failed');
    expect((await reseal(row!.url_ciphertext, resealed)).rows[0]?.swapped).toBe(true);
    const [after] = await fx.query<{ url_ciphertext: string }>(
      `SELECT url_ciphertext FROM ops.platform_alert_channel`,
    );
    expect(after?.url_ciphertext).toBe(resealed);
  });

  it('sends a test post to the channel as JSON text, and keeps its answer', async () => {
    const before = (await auditOf(owner)).length;
    await expectCode(service().sendTest(owner), 'not_found', /No chat channel is set/);
    await service().setChannel(owner, { url: hookUrl });
    await expectCode(service().sendTest(operator), 'forbidden');

    const { postId, wakeError } = await service().sendTest(owner);
    expect(wakeError).toBeNull();
    // The posting job is woken at once.
    const [signal] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job
        WHERE name = $1 AND singleton_key = 'alert-posts' AND state < 'active'`,
      [QUEUES.alertPosts.name],
    );
    expect(signal!.n).toBeGreaterThanOrEqual(1);

    expect(await send()).toEqual({
      claimed: 1,
      sent: 1,
      retrying: 0,
      failed: [],
      unopenable: null,
      purged: 0,
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: 'POST',
      path: '/services/T0/B0/hook-secret-4f1c',
      headers: { 'content-type': 'application/json', 'user-agent': 'HyFib-W360-Alerts/1' },
    });
    expect(JSON.parse(received[0]!.body)).toEqual({ text: alertChannelTestBody(BASE) });
    expect(await posts()).toMatchObject([
      { id: postId, kind: 'test', attempts: 1, sent: true, failed: false, last_status: 200 },
    ]);
    const state = await service().state(owner);
    expect(state.channel?.lastSentAt).toBeInstanceOf(Date);
    expect(state.posts).toMatchObject([{ id: postId, kind: 'test', lastStatus: 200 }]);
    expect((await auditOf(owner)).slice(before).map((a) => [a.action, a.metadata])).toEqual([
      ['platform.alert_channel_set', { host: '127.0.0.1', kinds: OPERATIONS }],
      ['platform.alert_channel_tested', { host: '127.0.0.1' }],
    ]);
    // Nothing more is due.
    expect(await send()).toMatchObject({ claimed: 0 });
  });

  it('tries a post again 1, 2, 4 and 8 minutes after a 5xx, a 429 or no answer, then gives up', async () => {
    await service().setChannel(owner, { url: hookUrl });
    await service().sendTest(owner);
    answers.push(503, 429, 500, 502, 504);
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await send(), `attempt ${attempt}`).toMatchObject({ claimed: 1, retrying: 1 });
      const [post] = await posts();
      expect(post).toMatchObject({ attempts: attempt, sent: false, failed: false });
      waits.push(post!.wait_minutes);
      // Not due before its wait has passed.
      expect(await send()).toMatchObject({ claimed: 0 });
      await due();
    }
    expect(waits).toEqual([1, 2, 4, 8]);
    const last = await send();
    expect(last).toMatchObject({ claimed: 1, retrying: 0 });
    expect(last.failed).toEqual([
      { id: expect.any(String), kind: 'test', status: 504, error: null },
    ]);
    expect(await posts()).toMatchObject([
      { attempts: 5, sent: false, failed: true, last_status: 504, last_error: null },
    ]);
    expect(received).toHaveLength(5);
    const state = await service().state(operator);
    expect(state.channel).toMatchObject({ lastSentAt: null, lastStatus: 504, postsFailed: 1 });
    expect(state.channel?.lastFailedAt).toBeInstanceOf(Date);
  });

  it('gives up at once on a 4xx, and records no answer and an address the guard refuses', async () => {
    await service().setChannel(owner, { url: hookUrl });
    await service().sendTest(owner);
    answers.push(404);
    expect(await send()).toMatchObject({
      claimed: 1,
      failed: [{ kind: 'test', status: 404, error: null }],
    });
    expect(await posts()).toMatchObject([{ attempts: 1, failed: true, last_status: 404 }]);

    // A closed port: no answer, tried again.
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const port = (closed.address() as AddressInfo).port;
    closed.close();
    await once(closed, 'close');
    await service().setChannel(owner, { url: `http://127.0.0.1:${port}/hook` });
    await service().sendTest(owner);
    expect(await send()).toMatchObject({ claimed: 1, retrying: 1 });
    const waiting = (await posts()).find((p) => !p.failed);
    expect(waiting).toMatchObject({ attempts: 1, last_status: null, last_error: 'connect_failed' });

    // The production policy refuses this address (http, loopback): failed for good, never sent.
    const guarded = await sendAlertPosts({
      db: fx.dbs.app,
      keyring: fx.keyring,
      egress: createEgressClient({ ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: false }),
    });
    expect(guarded.claimed).toBe(0);
    await due();
    const refused = await sendAlertPosts({
      db: fx.dbs.app,
      keyring: fx.keyring,
      egress: createEgressClient({ ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: false }),
    });
    expect(refused.failed).toMatchObject([{ status: null, error: 'scheme_not_allowed' }]);
  });

  it('fails the posts waiting when the channel is removed, and an interrupted last attempt', async () => {
    await expectCode(service().removeChannel(operator), 'forbidden');
    expect(await service().removeChannel(owner)).toEqual({ removed: false });
    await service().setChannel(owner, { url: hookUrl });
    await service().sendTest(owner);
    // A post whose fifth attempt's worker was lost: its lease ran out with no attempt left.
    const lost = uuidv7();
    await fx.query(
      `INSERT INTO ops.platform_alert_posts (id, kind, body, attempts, lease_until)
       VALUES ($1, 'queues', 'Queue x is falling behind', 5, now() - interval '1 minute')`,
      [lost],
    );
    expect(await send()).toMatchObject({ claimed: 1, sent: 1 });
    expect((await posts()).find((p) => p.id === lost)).toMatchObject({
      failed: true,
      last_error: 'interrupted',
    });

    await service().sendTest(owner);
    expect(await service().removeChannel(owner)).toEqual({ removed: true });
    expect((await posts()).filter((p) => !p.sent && !p.failed)).toEqual([]);
    expect((await posts()).at(-1)).toMatchObject({ failed: true, last_error: 'no_channel' });
    expect((await auditOf(owner)).at(-1)).toMatchObject({
      action: 'platform.alert_channel_removed',
      metadata: { host: '127.0.0.1' },
    });
    expect(await service().state(operator)).toMatchObject({ channel: null });
    // Without a channel an alert queues no post.
    const queued = await fx.dbs.app.run(systemScope, (tx) =>
      tx.execute<{ queued: boolean }>(
        sql`select ops.queue_platform_alert_post('failures', 'x') as queued`,
      ),
    );
    expect(queued.rows[0]?.queued).toBe(false);
    expect(await posts()).toHaveLength(3);
  });

  it('records as sent a post the channel’s removal failed while it was being sent', async () => {
    await service().setChannel(owner, { url: hookUrl });
    const [channel] = await fx.query<{ id: string }>(`SELECT id FROM ops.platform_alert_channel`);
    const { postId } = await service().sendTest(owner);
    const worker = <T extends Record<string, unknown>>(statement: ReturnType<typeof sql>) =>
      fx.dbs.app.run(systemScope, (tx) => tx.execute<T>(statement)).then((r) => r.rows);
    const claimed = await worker<{ id: string; attempts: number }>(
      sql`select id, attempts from ops.claim_platform_alert_posts(5)`,
    );
    expect(claimed).toEqual([{ id: postId, attempts: 1 }]);
    // Removed while the post is on its way: it fails as having no channel…
    await service().removeChannel(owner);
    expect(await posts()).toMatchObject([{ id: postId, failed: true, last_error: 'no_channel' }]);
    // …and the channel's 2xx makes it sent, while a failure no longer changes it.
    const finish = (status: number) =>
      worker<{ state: string }>(
        sql`select ops.finish_platform_alert_post(${postId}::uuid, 1, ${channel!.id}::uuid,
              ${status}::integer, null::text, true) as state`,
      );
    expect(await finish(503)).toEqual([{ state: 'stale' }]);
    expect(await finish(200)).toEqual([{ state: 'sent' }]);
    expect(await posts()).toMatchObject([
      { id: postId, sent: true, failed: false, last_status: 200, last_error: null },
    ]);
    expect(await finish(200)).toEqual([{ state: 'stale' }]);
  });

  it('posts an alert with its emails, in their transaction, with the email’s text', async () => {
    await service().setChannel(owner, { url: hookUrl });
    await fx.query(`UPDATE ops.platform_alerts SET last_sent_at = now() - interval '16 minutes'`);
    const letter = uuidv7();
    await fx.query(
      `INSERT INTO ops.dead_letters (id, source_queue, verified, failed_at)
       VALUES ($1, 'it.alert-channel', false, now())`,
      [letter],
    );
    const result = await alertFailures({
      db: fx.dbs.app,
      outbox: fx.notices().outbox,
      appBaseUrl: BASE,
    });
    expect(result).toMatchObject({ posted: true });
    expect(result.alerted).toBeGreaterThanOrEqual(1);
    const [email] = await fx.query<{ id: string; payload_ciphertext: string }>(
      `SELECT id, payload_ciphertext FROM ops.email_outbox
        WHERE to_address = (SELECT email FROM auth.users WHERE id = $1)
          AND kind = 'platform.notice' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [owner.userId],
    );
    const payload = JSON.parse(
      fx.keyring.decryptString(email!.payload_ciphertext, outboxAad(email!.id)),
    ) as { subject: string; lines: string[]; url: string; actionLabel: string };
    const [post] = await posts();
    expect(post).toMatchObject({ kind: 'failures', attempts: 0 });
    expect(post!.body).toBe(alertPostBody(payload));
    expect(post!.body.split('\n')[0]).toBe(payload.subject);

    expect(await send()).toMatchObject({ claimed: 1, sent: 1 });
    expect(JSON.parse(received.at(-1)!.body)).toEqual({ text: post!.body });
  });

  it('lets platform owners choose the alerts it gets, audited, and queues only those (ADR-340)', async () => {
    const before = (await auditOf(owner)).length;
    const queue = async (kind: string) =>
      (
        await fx.dbs.app.run(systemScope, (tx) =>
          tx.execute<{ queued: boolean }>(
            sql`select ops.queue_platform_alert_post(${kind}, ${'A post.'}) as queued`,
          ),
        )
      ).rows[0]?.queued;
    // Without a channel nothing is chosen, and nothing is queued.
    await expectCode(
      service().setKinds(owner, { kinds: ['failures'] }),
      'not_found',
      /No chat channel is set/,
    );
    expect(await queue('failures')).toBe(false);

    // A new channel gets the operations alerts, not the owners' financial ones.
    await service().setChannel(owner, { url: hookUrl });
    expect((await service().state(operator)).channel?.kinds).toEqual(OPERATIONS);
    expect(await queue('reconciliation')).toBe(false);
    expect(await queue('unsettled')).toBe(false);
    expect(await queue('test')).toBe(false);
    expect(await queue('queues')).toBe(true);

    await expectCode(service().setKinds(operator, { kinds: ['failures'] }), 'forbidden');
    // The definer function holds the same rules for a caller that skips the service.
    const direct = (actor: PlatformActor, kinds: string[]) =>
      fx.dbs.platform.run(actor.userId, (tx) =>
        tx.execute(
          sql`select ops.platform_set_alert_channel_kinds(${sql.param(kinds)}::text[], null)`,
        ),
      );
    await expectCode(direct(operator, ['failures']), 'forbidden', /Only a platform owner can/);
    await expectCode(direct(owner, []), 'precondition_failed', /Choose at least one/);
    await expectCode(direct(owner, ['failures', 'payments']), 'precondition_failed');

    const financial = ['failures', 'reconciliation', 'unsettled'];
    expect(
      await service().setKinds(owner, { kinds: ['unsettled', 'failures', 'reconciliation'] }),
    ).toEqual({ kinds: financial });
    // The same kinds again, given twice and in another order, change nothing and are not audited.
    expect(
      (await direct(owner, ['reconciliation', 'unsettled', 'failures', 'unsettled'])).rows,
    ).toEqual([{ platform_set_alert_channel_kinds: financial }]);
    expect(await queue('reconciliation')).toBe(true);
    expect(await queue('unsettled')).toBe(true);
    expect(await queue('queues')).toBe(false);
    expect((await posts()).map((p) => p.kind)).toEqual(['queues', 'reconciliation', 'unsettled']);

    // A new address keeps the kinds chosen.
    await service().setChannel(owner, { url: `${hookUrl}-2` });
    expect((await service().state(operator)).channel?.kinds).toEqual(financial);

    const audit = (await auditOf(owner)).slice(before);
    expect(audit.map((a) => [a.action, a.metadata])).toEqual([
      ['platform.alert_channel_set', { host: '127.0.0.1', kinds: OPERATIONS }],
      [
        'platform.alert_channel_kinds_set',
        { host: '127.0.0.1', kinds: financial, previousKinds: OPERATIONS },
      ],
      // The new address's entry names the owners' alerts it took over.
      [
        'platform.alert_channel_set',
        { host: '127.0.0.1', previousHost: '127.0.0.1', kinds: financial },
      ],
    ]);
    expect(audit[1]!.correlation_id).toBe(owner.correlationId);

    // The column holds one to five known kinds, and the posts a known kind, whoever writes them.
    for (const kinds of [
      `'{}'`,
      `ARRAY['payments']`,
      `ARRAY[NULL]::text[]`,
      `ARRAY[['failures']]`,
    ]) {
      await expect(
        fx.query(`UPDATE ops.platform_alert_channel SET kinds = ${kinds}`),
        kinds,
      ).rejects.toThrow(/platform_alert_channel_kinds_check/);
    }
    await expect(
      fx.query(
        `INSERT INTO ops.platform_alert_posts (id, kind, body) VALUES ($1, 'payments', 'x')`,
        [uuidv7()],
      ),
    ).rejects.toThrow(/platform_alert_posts_kind_check/);
  });

  it('deletes posts 7 days after they were sent or failed, and only those', async () => {
    const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    await fx.query(
      `INSERT INTO ops.platform_alert_posts (id, kind, body, created_at, sent_at, failed_at)
       VALUES ($1, 'test', 'a', now() - interval '9 days', now() - interval '8 days', NULL),
              ($2, 'test', 'b', now() - interval '9 days', NULL, now() - interval '8 days'),
              ($3, 'test', 'c', now() - interval '7 days', now() - interval '6 days', NULL),
              ($4, 'test', 'd', now() - interval '30 days', NULL, NULL)`,
      ids,
    );
    // No channel: the post waiting fails as having none, and is kept.
    const run = await send();
    expect(run).toMatchObject({ claimed: 0, purged: 2 });
    expect((await posts()).map((p) => [p.id, p.failed])).toEqual([
      [ids[3], true],
      [ids[2], false],
    ]);
  });
});
