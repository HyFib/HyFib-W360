import { z } from 'zod';
import { AppError, forbidden, toError, uuidv7, type Keyring } from '@w360/core';
import {
  EgressError,
  parseEgressUrl,
  type EgressClient,
  type EgressErrorCode,
  type EgressPolicy,
} from '@w360/core/egress';
import { QUEUES } from '@w360/contracts';
import { sql, systemScope, type Database, type Tx } from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import type { OutboxDeps } from '../email/outbox';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { parseInput } from '../validation';
import { webhookErrorLabel } from '../webhooks/model';
import type { PlatformActor } from './service';

/**
 * A chat channel for the operations alerts (P5-10, ADR-338). The alerts about failures (ADR-091),
 * late queues (ADR-096) and failing integrations (ADR-139) email every platform administrator; a
 * platform owner can also set one chat channel, an incoming webhook address that takes a JSON
 * `POST` with a `text` member (Slack's incoming webhooks' format), and each alert is then also
 * queued as a post with its email's counts-only text, in the transaction that queues the emails.
 * The channel gets the alerts an owner chose (ADR-340): those three until an owner chooses
 * otherwise, and the owners' financial alerts (ADR-066, ADR-071) only once an owner adds them.
 * The worker sends the posts (queue `ops.alert-posts`) through the egress guard, each up to 5
 * times. The address holds the channel's secret: it is sealed with the keyring, only the runtime
 * role reads it (to send), and the console and the audit name its host only. Since ADR-388 the
 * channel has a format, a JSON `text` member or a Microsoft Teams Adaptive Card, and the worker
 * renders each post's body in it when it sends the post.
 */

/**
 * A post's characters at most, as escaped (`ops.platform_alert_posts.body`) and unescaped
 * (`plain_body`).
 */
export const ALERT_POST_MAX_CHARS = 4000;
/**
 * A Teams card message's serialized bytes at most (UTF-8). Microsoft gives the webhook's limit as
 * 28 KB without saying whether a KB is 1,000 or 1,024 bytes: 28,000 is within either.
 */
export const TEAMS_MESSAGE_MAX_BYTES = 28_000;
/** Attempts a post gets before it fails (`ops.claim_platform_alert_posts`). */
export const ALERT_POST_ATTEMPTS = 5;
/** Posts one run of the posting job claims at most, sent one after another. */
export const ALERT_POST_BATCH = 5;
/** A channel address's characters at most. */
export const ALERT_CHANNEL_URL_MAX = 2048;
/** The posting job's key: one run waits and one runs at most. */
export const ALERT_POSTS_JOB_KEY = 'alert-posts';
export const ALERT_POST_USER_AGENT = 'HyFib-W360-Alerts/1';

/** The alerts a channel can get, in the console's order (`ops.platform_alert_channel.kinds`). */
export const ALERT_CHANNEL_KINDS = [
  'failures',
  'queues',
  'integrations',
  'reconciliation',
  'unsettled',
  'refund_requests',
] as const;
export type AlertChannelKind = (typeof ALERT_CHANNEL_KINDS)[number];

/** What a new channel gets: the operations alerts, which every platform administrator is emailed. */
export const ALERT_CHANNEL_DEFAULT_KINDS: readonly AlertChannelKind[] = [
  'failures',
  'queues',
  'integrations',
];

/**
 * The owners' financial alerts (ADR-066, ADR-071) and refund requests (ADR-073, ADR-104, ADR-345),
 * which platform owners alone are emailed: a channel gets them only once an owner adds them, since
 * their posts reach whoever reads it.
 */
export const ALERT_CHANNEL_FINANCIAL_KINDS: readonly AlertChannelKind[] = [
  'reconciliation',
  'unsettled',
  'refund_requests',
];

export const ALERT_POST_KINDS = [...ALERT_CHANNEL_KINDS, 'test'] as const;
export type AlertPostKind = (typeof ALERT_POST_KINDS)[number];

export const ALERT_POST_KIND_LABELS: Record<AlertPostKind, string> = {
  failures: 'Failures',
  queues: 'Late queues',
  integrations: 'Failing integrations',
  reconciliation: 'Reconciliation findings',
  unsettled: 'Payments not seen in a settlement',
  refund_requests: 'Refund requests',
  test: 'Test post',
};

const isAlertPostKind = (value: string): value is AlertPostKind =>
  (ALERT_POST_KINDS as readonly string[]).includes(value);
const isAlertChannelKind = (value: string): value is AlertChannelKind =>
  (ALERT_CHANNEL_KINDS as readonly string[]).includes(value);

/**
 * How the channel reads a post (ADR-388, `ops.platform_alert_channel.format`): `text`, a JSON object
 * with a `text` member escaped as Slack's formatting reads it (ADR-338, every channel set before);
 * `teams_card`, the Adaptive Card message a Microsoft Teams webhook posts (a Workflows flow).
 */
export const ALERT_CHANNEL_FORMATS = ['text', 'teams_card'] as const;
export type AlertChannelFormat = (typeof ALERT_CHANNEL_FORMATS)[number];

export const ALERT_CHANNEL_FORMAT_LABELS: Record<AlertChannelFormat, string> = {
  text: 'JSON text (Slack and similar)',
  teams_card: 'Microsoft Teams card (Workflows)',
};

export const isAlertChannelFormat = (value: string): value is AlertChannelFormat =>
  (ALERT_CHANNEL_FORMATS as readonly string[]).includes(value);

/** A format a database function gave, which its check holds to the known ones. */
function knownFormat(value: string | undefined, source: string): AlertChannelFormat {
  if (value === undefined || !isAlertChannelFormat(value)) {
    throw new Error(`${source} gave no known format: ${String(value)}`);
  }
  return value;
}

/** The associated data a channel's address is sealed with: its row's id. */
export const alertChannelAad = (channelId: string) => `platform-alert-channel:${channelId}`;

/**
 * Text as Slack's message formatting reads it: `&`, `<` and `>` are its control characters, so
 * they are written `&amp;`, `&lt;` and `&gt;`, and nothing else is encoded.
 */
export function chatEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `chatEscape` undone: the three escapes it writes, and nothing else. Exact on what `chatEscape`
 * wrote, including a post cut by `alertPostBody`, which never cuts inside an escape: every `&` it
 * wrote begins one of the three.
 */
export function chatUnescape(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_, name: string) =>
    name === 'lt' ? '<' : name === 'gt' ? '>' : '&',
  );
}

/**
 * An alert as its email gives it (`failureAlert`, `lateQueueAlert`, `integrationAlert`,
 * `unsettledPaymentsAlert`), or as its post does (`settlementReconPost`).
 */
export interface AlertText {
  subject: string;
  lines: readonly string[];
  url: string;
  actionLabel: string;
}

/** An alert's subject, lines and link, one a line. */
const alertLines = (alert: AlertText) =>
  [alert.subject, ...alert.lines, `${alert.actionLabel}: ${alert.url}`].join('\n');

/**
 * Text held to 4,000 characters: cut before a character that would not be whole and, when it is
 * escaped, before an escape, and ended with an ellipsis.
 */
function capPost(text: string, escaped: boolean): string {
  if (text.length <= ALERT_POST_MAX_CHARS) return text;
  let cut = text.slice(0, ALERT_POST_MAX_CHARS - 1);
  if (escaped) cut = cut.replace(/&[a-z]*$/, '');
  return `${cut.replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/** Unescaped text as the `text` format sends it: escaped, then held to 4,000 characters. */
const escapedPost = (plain: string) => capPost(chatEscape(plain), true);

/**
 * A post's body for an alert in the `text` format (`ops.platform_alert_posts.body`): its subject,
 * its lines and its link, one a line, escaped; at most 4,000 characters, cut before an escape or a
 * character that would not be whole.
 */
export function alertPostBody(alert: AlertText): string {
  return escapedPost(alertLines(alert));
}

/**
 * A post's text unescaped (`ops.platform_alert_posts.plain_body`, ADR-388), which the worker renders
 * in the channel's format when it sends the post: its subject, lines and link, one a line, at most
 * 4,000 characters, cut before a character that would not be whole.
 */
export function alertPostPlain(alert: AlertText): string {
  return capPost(alertLines(alert), false);
}

/** The test post: what the channel will receive, and where the console is. */
export function alertChannelTestAlert(appBaseUrl: string): AlertText {
  return {
    subject: 'HyFib W360: a test post from the operations console',
    lines: [
      'The alerts chosen under Operations → Alerts are posted here when they are emailed, with counts only.',
    ],
    url: new URL('/platform/ops/alerts', appBaseUrl).toString(),
    actionLabel: 'Open the alerts',
  };
}

/** The test post's body in the `text` format. */
export function alertChannelTestBody(appBaseUrl: string): string {
  return alertPostBody(alertChannelTestAlert(appBaseUrl));
}

/** A post as the worker claims it: its text escaped, and unescaped when it was queued with it. */
export interface AlertPostText {
  body: string;
  plainBody: string | null;
}

interface TeamsTextBlock {
  type: 'TextBlock';
  text: string;
  weight?: 'bolder';
  wrap: true;
}

/** A Teams webhook message carrying one Adaptive Card of the blocks given, serialized. */
function teamsMessage(blocks: readonly TeamsTextBlock[]): string {
  return JSON.stringify({
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.2',
          body: blocks,
        },
      },
    ],
  });
}

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * A post's text as a Teams card message (ADR-388): each line that is not blank a `TextBlock` that
 * wraps, the first (the subject) in bold. Not escaped: Adaptive Cards show HTML as written, and the
 * alerts' text names nothing a company writes (ADR-388), so no Markdown can be put in it. Held to
 * `TEAMS_MESSAGE_MAX_BYTES` serialized: should it not fit, which 4,000 characters reach only in
 * thousands of short lines, the lines from the end are left out for a last block "…".
 */
export function teamsCardBody(text: string): string {
  const blocks: TeamsTextBlock[] = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) =>
      index === 0
        ? { type: 'TextBlock', text: line, weight: 'bolder', wrap: true }
        : { type: 'TextBlock', text: line, wrap: true },
    );
  const whole = teamsMessage(blocks);
  if (utf8Bytes(whole) <= TEAMS_MESSAGE_MAX_BYTES) return whole;
  const more: TeamsTextBlock = { type: 'TextBlock', text: '…', wrap: true };
  // The message's bytes are its frame's, its blocks' and a comma before each block after the
  // first: the longest run of blocks from the first that fits before the last block is kept.
  let size = utf8Bytes(teamsMessage([more]));
  let kept = 0;
  for (const block of blocks) {
    const next = size + utf8Bytes(JSON.stringify(block)) + 1;
    if (next > TEAMS_MESSAGE_MAX_BYTES) break;
    size = next;
    kept += 1;
  }
  const cut = teamsMessage([...blocks.slice(0, kept), more]);
  if (utf8Bytes(cut) > TEAMS_MESSAGE_MAX_BYTES) {
    throw new Error('a Teams card message was cut but is still over its size limit');
  }
  return cut;
}

/**
 * A post's request body in the channel's format, rendered when it is sent (ADR-388). A post queued
 * with its text unescaped is rendered from it. One queued without (before migration 0304, or by a
 * worker of the release before during the rollout) holds the text escaped for the `text` format: it
 * is sent as it is in that format, and unescaped exactly for a card, so no text is ever escaped
 * twice nor left escaped in a card.
 */
export function alertPostRequestBody(format: AlertChannelFormat, post: AlertPostText): string {
  switch (format) {
    case 'text':
      return JSON.stringify({
        text: post.plainBody === null ? post.body : escapedPost(post.plainBody),
      });
    case 'teams_card':
      return teamsCardBody(post.plainBody ?? chatUnescape(post.body));
  }
}

/**
 * A channel's address as it will be called, held to the egress guard's rules (https, no
 * credentials, port 443 or an unprivileged one), without its fragment, and its host, the only part
 * of it the console and the audit name.
 */
export function checkedAlertChannelUrl(
  raw: string,
  policy: Pick<EgressPolicy, 'allowLoopbackForTests'>,
): { url: string; host: string } {
  const invalid = (message: string) =>
    new AppError('validation_failed', message, { issues: [{ path: 'url', message }] });
  const given = raw.trim();
  if (!given) throw invalid('Give the channel’s incoming webhook address.');
  let target: ReturnType<typeof parseEgressUrl>;
  try {
    target = parseEgressUrl(given, policy);
  } catch (error) {
    if (!(error instanceof EgressError)) throw error;
    // The guard's own advice is to move credentials to a header, which a channel has none of.
    throw invalid(
      error.code === 'credentials_in_url'
        ? 'Give the address without a user name or password.'
        : error.message,
    );
  }
  target.url.hash = '';
  const url = target.url.toString();
  // Normalising (percent-encoding) can lengthen what was entered.
  if (url.length > ALERT_CHANNEL_URL_MAX) throw invalid('The address is too long.');
  return { url, host: target.hostname.toLowerCase() };
}

/**
 * What a post's or the channel's last failure says: an HTTP status, an egress error code, or one
 * the database or the worker writes (`no_channel`, `unticked`, `interrupted`, `unopenable`).
 */
export function alertPostFailureLabel(error: string | null, status: number | null): string | null {
  switch (error) {
    case 'no_channel':
      return 'No chat channel was set';
    case 'unticked':
      return 'Its alert was unticked before it was sent';
    case 'unopenable':
      return 'The address does not open with the configured keys';
    default:
      return webhookErrorLabel(error, status);
  }
}

/** An attempt's answer, as `ops.finish_platform_alert_post` records it. */
export interface AlertPostOutcome {
  status: number | null;
  error: string | null;
  /** Whether another attempt may succeed. */
  retry: boolean;
}

/** Egress failures after which another attempt may succeed: no answer came. */
const ANSWERLESS: ReadonlySet<EgressErrorCode> = new Set([
  'dns_failed',
  'connect_failed',
  'timeout',
  'network_error',
]);

/**
 * An attempt's outcome: a 2xx status is sent; a 429 (Slack takes about one post a second on a
 * webhook) and a 5xx may pass, as may no answer; any other status, a status outside 100 to 599 and
 * an address the guard refuses do not.
 */
export function alertPostOutcome(
  answer: { status: number } | { error: EgressErrorCode },
): AlertPostOutcome {
  if ('error' in answer) {
    return { status: null, error: answer.error, retry: ANSWERLESS.has(answer.error) };
  }
  const { status } = answer;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return { status: null, error: 'invalid_status', retry: false };
  }
  return { status, error: null, retry: status === 429 || status >= 500 };
}

const ALERT_POST_HEADERS = {
  'content-type': 'application/json',
  'user-agent': ALERT_POST_USER_AGENT,
} as const;

/** One post through the egress client: its JSON request body, rendered in the channel's format. */
async function attemptPost(
  egress: EgressClient,
  url: string,
  body: string,
): Promise<AlertPostOutcome> {
  try {
    const response = await egress.request({
      method: 'POST',
      url,
      headers: ALERT_POST_HEADERS,
      body,
    });
    // The answer's body is read up to the egress limit and discarded.
    return alertPostOutcome({ status: response.status });
  } catch (error) {
    if (!(error instanceof EgressError)) throw error;
    return alertPostOutcome({ error: error.code });
  }
}

/** Signals the posting job, in the transaction given (null: at once). */
async function signalAlertPosts(
  deps: { jobs: JobQueue; signer: JobSigner },
  tx: Tx | null,
  actorUserId: string | null,
  ref: string,
): Promise<void> {
  // The job claims the posts due from the database: nothing in its payload is trusted.
  await deps.jobs.enqueue(
    tx,
    QUEUES.alertPosts.name,
    deps.signer.sign({ kind: QUEUES.alertPosts.name, tenantId: null, actorUserId, ref }),
    { singletonKey: ALERT_POSTS_JOB_KEY },
  );
}

/**
 * Queues an alert's post, in the transaction that queues its emails, while a channel is set that
 * gets the alert's kind, and signals the posting job in the same transaction; whether it was
 * queued.
 */
export async function queueAlertPost(
  outbox: OutboxDeps,
  tx: Tx,
  kind: AlertChannelKind,
  alert: AlertText,
): Promise<boolean> {
  const res = await tx.execute<{ queued: boolean }>(
    sql`select ops.queue_platform_alert_post(${kind}, ${alertPostBody(alert)}, ${alertPostPlain(alert)}) as queued`,
  );
  const queued = res.rows[0]?.queued === true;
  if (queued) await signalAlertPosts(outbox, tx, null, kind);
  return queued;
}

export interface AlertPostsDeps {
  db: Database;
  keyring: Keyring;
  egress: EgressClient;
}

export interface AlertPostsResult {
  claimed: number;
  sent: number;
  retrying: number;
  /** Posts that failed for good this run, by id, kind and their last answer. */
  failed: { id: string; kind: AlertPostKind; status: number | null; error: string | null }[];
  /** Why the channel's address did not open with the configured keys; null when it did. */
  unopenable: string | null;
  /** Posts sent or failed more than 7 days ago, deleted. */
  purged: number;
}

/**
 * The posting job (every minute, and when an alert or a test post is queued): deletes the posts
 * kept 7 days, claims up to `limit` posts due and sends them one after another, oldest first, to
 * the channel's address and in its format when they were claimed, recording each attempt's answer.
 * The claim names the formats this job renders (ADR-388). Never logs nor returns the address or a
 * post's body. Posting is at least once: a post whose answer did not come is tried again, so the
 * channel may show it twice.
 */
export async function sendAlertPosts(
  deps: AlertPostsDeps,
  limit: number = ALERT_POST_BATCH,
): Promise<AlertPostsResult> {
  const purge = await deps.db.run(systemScope, (tx) =>
    tx.execute<{ purged: number }>(sql`select ops.purge_platform_alert_posts() as purged`),
  );
  // The address is read in the claim's transaction, which holds the channel's row (0261): the posts
  // claimed go to the address they were claimed for, never to one that replaced it since.
  const { claimed, channel } = await deps.db.run(systemScope, async (tx) => {
    const due = await tx.execute<{
      id: string;
      kind: string;
      body: string;
      plain_body: string | null;
      attempts: number;
      created_at: Date | string;
      format: string;
    }>(
      sql`select id, kind, body, plain_body, attempts, created_at, format
            from ops.claim_platform_alert_posts(${limit}, ${sql.param([...ALERT_CHANNEL_FORMATS])}::text[])`,
    );
    if (due.rows.length === 0) return { claimed: due.rows, channel: null };
    const channels = await tx.execute<{ id: string; url_ciphertext: string }>(
      sql`select id, url_ciphertext from ops.platform_alert_channel`,
    );
    return { claimed: due.rows, channel: channels.rows[0] ?? null };
  });
  const result: AlertPostsResult = {
    claimed: claimed.length,
    sent: 0,
    retrying: 0,
    failed: [],
    unopenable: null,
    purged: Number(purge.rows[0]?.purged ?? 0),
  };
  if (claimed.length === 0) return result;
  let url: string | null = null;
  if (channel) {
    try {
      url = deps.keyring.decryptString(channel.url_ciphertext, alertChannelAad(channel.id));
    } catch (error) {
      // Recorded on each post as `unopenable` and reported for the worker's log.
      result.unopenable = toError(error).message;
    }
  }
  const posts = [...claimed].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || (a.id < b.id ? -1 : 1),
  );
  for (const post of posts) {
    // The claim hands out posts only in the formats it was given, all of which this job renders.
    const format = knownFormat(post.format, 'ops.claim_platform_alert_posts');
    // No channel cannot follow a claim that returned posts, which holds the channel's row until the
    // address is read; should it, the posts fail rather than go anywhere.
    const outcome: AlertPostOutcome = !channel
      ? { status: null, error: 'no_channel', retry: false }
      : url === null
        ? { status: null, error: 'unopenable', retry: true }
        : await attemptPost(
            deps.egress,
            url,
            alertPostRequestBody(format, { body: post.body, plainBody: post.plain_body }),
          );
    const finished = await deps.db.run(systemScope, (tx) =>
      tx.execute<{ state: string }>(
        sql`select ops.finish_platform_alert_post(${post.id}::uuid, ${post.attempts}::integer,
              ${channel?.id ?? null}::uuid, ${outcome.status}::integer, ${outcome.error}::text,
              ${outcome.retry}::boolean) as state`,
      ),
    );
    const state = finished.rows[0]?.state;
    if (state === 'sent') result.sent += 1;
    else if (state === 'retrying') result.retrying += 1;
    else if (state === 'failed') {
      result.failed.push({
        id: post.id,
        kind: isAlertPostKind(post.kind) ? post.kind : 'test',
        status: outcome.status,
        error: outcome.error,
      });
    }
    // 'stale': another attempt claimed the post after this one's lease ran out, or the channel's
    // removal or its alert's unticking failed it on its way and the answer was no 2xx.
  }
  return result;
}

/** The channel as the console shows it: never its address. */
export interface AlertChannelView {
  host: string;
  /** How it reads a post (ADR-388). */
  format: AlertChannelFormat;
  /** The alerts it gets, in the console's order. */
  kinds: AlertChannelKind[];
  setByName: string | null;
  setAt: Date;
  lastSentAt: Date | null;
  lastFailedAt: Date | null;
  lastStatus: number | null;
  lastError: string | null;
  postsWaiting: number;
  postsFailed: number;
}

/** A post as the console lists it: never its body. */
export interface AlertPostView {
  id: string;
  kind: AlertPostKind;
  createdAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  lastStatus: number | null;
  lastError: string | null;
}

export interface AlertChannelDeps {
  platformDb: PlatformDatabase;
  keyring: Keyring;
  jobs: JobQueue;
  signer: JobSigner;
  egressPolicy: Pick<EgressPolicy, 'allowLoopbackForTests'>;
  appBaseUrl: string;
}

const CHOOSE_FORMAT = 'Choose one of the formats listed.';
const setChannelSchema = z.object({
  url: z
    .string({ error: 'Give the channel’s incoming webhook address.' })
    .max(ALERT_CHANNEL_URL_MAX, 'The address is too long.'),
  format: z.enum(ALERT_CHANNEL_FORMATS, { error: CHOOSE_FORMAT }),
});
const setFormatSchema = z.object({
  format: z.enum(ALERT_CHANNEL_FORMATS, { error: CHOOSE_FORMAT }),
});

const CHOOSE_KINDS = 'Choose at least one of the alerts listed.';
const setKindsSchema = z.object({
  kinds: z
    .array(z.enum(ALERT_CHANNEL_KINDS, { error: CHOOSE_KINDS }), { error: CHOOSE_KINDS })
    .min(1, CHOOSE_KINDS),
});

const date = (value: Date | string) => new Date(value);
const dateOrNull = (value: Date | string | null) => (value === null ? null : new Date(value));

/** Operations → Alerts (ADR-338): the chat channel, for platform owners to set, remove and test. */
export function createAlertChannelService(deps: AlertChannelDeps) {
  const ownersOnly = (actor: PlatformActor, what: string) => {
    if (actor.role !== 'platform_owner') {
      throw forbidden(`Only platform owners can ${what}.`);
    }
  };
  return {
    /** The channel, if one is set, and the 10 latest posts (platform administrators). */
    async state(
      actor: PlatformActor,
    ): Promise<{ channel: AlertChannelView | null; posts: AlertPostView[] }> {
      return deps.platformDb.run(
        actor.userId,
        async (tx) => {
          const channel = await tx.execute<{
            host: string;
            set_by_name: string | null;
            set_at: Date | string;
            last_sent_at: Date | string | null;
            last_failed_at: Date | string | null;
            last_status: number | null;
            last_error: string | null;
            posts_waiting: number;
            posts_failed: number;
            kinds: string[] | null;
            format: string;
          }>(sql`select host, set_by_name, set_at, last_sent_at, last_failed_at, last_status,
                        last_error, posts_waiting, posts_failed, kinds, format
                   from ops.platform_alert_channel_state()`);
          const posts = await tx.execute<{
            id: string;
            kind: string;
            created_at: Date | string;
            attempts: number;
            next_attempt_at: Date | string;
            sent_at: Date | string | null;
            failed_at: Date | string | null;
            last_status: number | null;
            last_error: string | null;
          }>(sql`select id, kind, created_at, attempts, next_attempt_at, sent_at, failed_at,
                        last_status, last_error
                   from ops.platform_alert_posts_recent()`);
          const c = channel.rows[0];
          return {
            channel: c
              ? {
                  host: c.host,
                  format: knownFormat(c.format, 'ops.platform_alert_channel_state'),
                  kinds: ALERT_CHANNEL_KINDS.filter((k) => (c.kinds ?? []).includes(k)),
                  setByName: c.set_by_name,
                  setAt: date(c.set_at),
                  lastSentAt: dateOrNull(c.last_sent_at),
                  lastFailedAt: dateOrNull(c.last_failed_at),
                  lastStatus: c.last_status === null ? null : Number(c.last_status),
                  lastError: c.last_error,
                  postsWaiting: Number(c.posts_waiting),
                  postsFailed: Number(c.posts_failed),
                }
              : null,
            posts: posts.rows.flatMap((p) =>
              isAlertPostKind(p.kind)
                ? [
                    {
                      id: p.id,
                      kind: p.kind,
                      createdAt: date(p.created_at),
                      attempts: Number(p.attempts),
                      nextAttemptAt: date(p.next_attempt_at),
                      sentAt: dateOrNull(p.sent_at),
                      failedAt: dateOrNull(p.failed_at),
                      lastStatus: p.last_status === null ? null : Number(p.last_status),
                      lastError: p.last_error,
                    },
                  ]
                : [],
            ),
          };
        },
        // One snapshot for the channel and its posts.
        { accessMode: 'read only', isolationLevel: 'repeatable read' },
      );
    },

    /**
     * Sets the channel with its format (platform owners, ADR-388), replacing one set before: the
     * address is checked, sealed under a new row's id and stored; the audit names its host and
     * format.
     */
    async setChannel(
      actor: PlatformActor,
      input: unknown,
    ): Promise<{ host: string; format: AlertChannelFormat }> {
      ownersOnly(actor, 'set the chat channel');
      const data = parseInput(setChannelSchema, input);
      const { url, host } = checkedAlertChannelUrl(data.url, deps.egressPolicy);
      const id = uuidv7();
      const sealed = deps.keyring.encrypt(url, alertChannelAad(id));
      await deps.platformDb.run(actor.userId, (tx) =>
        tx.execute(
          sql`select ops.platform_set_alert_channel(${id}::uuid, ${sealed}, ${host}, ${data.format}, ${actor.correlationId})`,
        ),
      );
      return { host, format: data.format };
    },

    /**
     * Changes the channel's format alone (platform owners, ADR-388), its address kept and never
     * asked for again; a change is audited with the host and the formats before and after, and the
     * posts waiting are sent in the new format. Not found when no channel is set.
     */
    async setFormat(actor: PlatformActor, input: unknown): Promise<{ format: AlertChannelFormat }> {
      ownersOnly(actor, 'choose the chat channel’s format');
      const data = parseInput(setFormatSchema, input);
      const res = await deps.platformDb.run(actor.userId, (tx) =>
        tx.execute<{ format: string }>(
          sql`select ops.platform_set_alert_channel_format(${data.format}, ${actor.correlationId}) as format`,
        ),
      );
      return {
        format: knownFormat(res.rows[0]?.format, 'ops.platform_set_alert_channel_format'),
      };
    },

    /**
     * Chooses the alerts the channel gets (platform owners, ADR-340), at least one, kept in the
     * console's order; the change is audited with the kinds before and after. Not found when no
     * channel is set.
     */
    async setKinds(actor: PlatformActor, input: unknown): Promise<{ kinds: AlertChannelKind[] }> {
      ownersOnly(actor, 'choose the chat channel’s alerts');
      const data = parseInput(setKindsSchema, input);
      const chosen = ALERT_CHANNEL_KINDS.filter((k) => data.kinds.includes(k));
      const res = await deps.platformDb.run(actor.userId, (tx) =>
        tx.execute<{ kinds: string[] }>(
          sql`select ops.platform_set_alert_channel_kinds(${sql.param(chosen)}::text[], ${actor.correlationId}) as kinds`,
        ),
      );
      const kinds = res.rows[0]?.kinds;
      if (!kinds) throw new Error('ops.platform_set_alert_channel_kinds returned no kinds');
      return { kinds: kinds.filter(isAlertChannelKind) };
    },

    /** Removes the channel (platform owners); the posts waiting fail. False when none was set. */
    async removeChannel(actor: PlatformActor): Promise<{ removed: boolean }> {
      ownersOnly(actor, 'remove the chat channel');
      const res = await deps.platformDb.run(actor.userId, (tx) =>
        tx.execute<{ removed: boolean }>(
          sql`select ops.platform_remove_alert_channel(${actor.correlationId}) as removed`,
        ),
      );
      return { removed: res.rows[0]?.removed === true };
    },

    /**
     * Queues a test post (platform owners) and signals the posting job, which sends it at once. The
     * signal goes after the post's transaction committed, so the job finds it; should it fail, the
     * post is queued and audited all the same and the minute run sends it, so the error is given
     * back for the caller to log and say so.
     */
    async sendTest(actor: PlatformActor): Promise<{ postId: string; wakeError: Error | null }> {
      ownersOnly(actor, 'test the chat channel');
      // Rendered in the channel's format when it is sent, as an alert's post is.
      const alert = alertChannelTestAlert(deps.appBaseUrl);
      const res = await deps.platformDb.run(actor.userId, (tx) =>
        tx.execute<{ id: string }>(
          sql`select ops.platform_test_alert_channel(${alertPostBody(alert)}, ${alertPostPlain(alert)}, ${actor.correlationId}) as id`,
        ),
      );
      const postId = res.rows[0]?.id;
      if (!postId) throw new Error('ops.platform_test_alert_channel returned no post');
      try {
        await signalAlertPosts(deps, null, actor.userId, postId);
        return { postId, wakeError: null };
      } catch (error) {
        return { postId, wakeError: toError(error) };
      }
    },
  };
}

export type AlertChannelService = ReturnType<typeof createAlertChannelService>;
