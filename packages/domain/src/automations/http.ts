import {
  clipText,
  NUL,
  NUL_REPLACEMENT,
  parseExternalJson,
  uuidv7,
  type Clock,
  type Keyring,
} from '@w360/core';
import { EgressError, type EgressClient } from '@w360/core/egress';
import { QUEUES } from '@w360/contracts';
import {
  and,
  automationHttpCalls,
  automationRuns,
  eq,
  httpAllowedDomains,
  httpSecrets,
  inArray,
  sql,
  systemScope,
  type Database,
  type HttpCallState,
  type TenantScope,
  type Tx,
} from '@w360/db';
import type { JobSigner } from '../jobs/envelope';
import { echoMatcher, looseSecretValuesOf } from './echo';
import type { JobQueue } from '../jobs/queue';
import {
  AUTOMATION_LIMITS,
  hostAllowed,
  httpHeaderText,
  responseHeaderRefusal,
  savedHeaderSecretRefusal,
  type HttpHeaderPart,
  type HttpMethod,
  type HttpSave,
} from './graph';
import type { RunEffect } from './interpreter';
import { signalAutomationRun, type AutomationRun } from './runs';

/**
 * Automation HTTP calls (queue `automation.http`). A call is written ahead: the runner inserts it
 * (queued, with the request encrypted) in the transaction of the step that makes it and waits. The
 * worker claims a queued call (in_flight) in one transaction, makes the request through the egress
 * client with no locks held, and records the outcome in another, then signals the run. A call is
 * only ever sent from the queued state, so retried jobs never send it twice; a call left in flight
 * (the worker died, or took longer than the run's deadline) is settled as unknown by the runner and
 * never retried, because the server may have acted on it.
 */

type HttpEffect = Extract<RunEffect, { kind: 'http_request' }>;

interface StoredRequest {
  url: string;
  headers: { name: string; parts: HttpHeaderPart[] }[];
  body: string | null;
  /** A request written before ADR-406 has `{path, saveAs}` items: JSON paths. */
  save: HttpSave[];
}

export const FINISHED_HTTP_STATES: ReadonlySet<HttpCallState> = new Set([
  'succeeded',
  'failed',
  'unknown',
  'canceled',
]);

/** Headroom over the egress deadline before a call in flight counts as abandoned. */
const LEASE_MARGIN_MS = 30_000;

const requestAad = (tenantId: string, callId: string) => `automation-http:${tenantId}:${callId}`;
const secretAad = (tenantId: string, secretId: string) => `http-secret:${tenantId}:${secretId}`;

export { secretAad as httpSecretAad, requestAad as httpRequestAad };

export interface HttpQueueDeps {
  jobs: JobQueue;
  signer: JobSigner;
  keyring: Keyring;
}

/**
 * Records a call to make and queues the worker's job (in the step's transaction). A rendered
 * address that does not parse is recorded as failed at once, so the run takes its failure branch.
 */
export async function queueHttpCall(
  tx: Tx,
  deps: HttpQueueDeps,
  input: { run: AutomationRun; nodeId: string; visit: number; effect: HttpEffect; now: Date },
): Promise<string> {
  const { run, effect, now } = input;
  const id = uuidv7();
  const valid = URL.canParse(effect.url);
  const url = valid ? new URL(effect.url) : null;
  // The host has no placeholders (publishing refuses them); the path is kept as written, so the
  // record never holds a customer's values (the rendered address is only in the encrypted request).
  const host = url?.hostname.slice(0, 253) || 'invalid';
  const path = effect.path.slice(0, 300) || '/';
  const stored: StoredRequest = {
    url: effect.url,
    headers: effect.headers,
    body: effect.body,
    save: effect.save,
  };
  await tx.insert(automationHttpCalls).values({
    id,
    tenantId: run.tenantId,
    runId: run.id,
    nodeId: input.nodeId,
    nodeVisit: input.visit,
    method: effect.method,
    host,
    path,
    createdAt: now,
    ...(valid
      ? {
          requestCiphertext: deps.keyring.encrypt(
            JSON.stringify(stored),
            requestAad(run.tenantId, id),
          ),
        }
      : { state: 'failed' as const, errorCode: 'invalid_url', finishedAt: now }),
  });
  if (valid) {
    await deps.jobs.enqueue(
      tx,
      QUEUES.automationHttp.name,
      deps.signer.sign({
        kind: 'automation.http',
        tenantId: run.tenantId,
        actorUserId: run.startedByUserId,
        ref: id,
      }),
      { singletonKey: id },
    );
  } else {
    await signalAutomationRun(deps, tx, {
      tenantId: run.tenantId,
      runId: run.id,
      actorUserId: run.startedByUserId,
      key: `h:${id}`,
    });
  }
  return id;
}

/**
 * The call a run waiting for an HTTP result waits for (its node and visit), locked: the worker
 * cannot record a result while the runner decides between that result and the deadline. (The
 * worker locks the call and never waits on the run, so the runner's order, run then call, is safe.)
 */
export async function httpCallOfRun(tx: Tx, run: AutomationRun) {
  if (!run.currentNodeId) return null;
  const [call] = await tx
    .select({
      id: automationHttpCalls.id,
      state: automationHttpCalls.state,
      statusCode: automationHttpCalls.statusCode,
      errorCode: automationHttpCalls.errorCode,
      savedValues: automationHttpCalls.savedValues,
    })
    .from(automationHttpCalls)
    .where(
      and(
        eq(automationHttpCalls.tenantId, run.tenantId),
        eq(automationHttpCalls.runId, run.id),
        eq(automationHttpCalls.nodeId, run.currentNodeId),
        eq(automationHttpCalls.nodeVisit, run.nodeVisit),
      ),
    )
    .for('update');
  return call ?? null;
}

/** What a finished call's outcome is called in the run's step log: its status or error code. */
export const httpCallDetail = (call: {
  state: HttpCallState;
  statusCode: number | null;
  errorCode: string | null;
}): string => (call.statusCode !== null ? String(call.statusCode) : (call.errorCode ?? call.state));

/**
 * Settles a call the run can no longer wait for: one not started is cancelled (`not_started`); one
 * in flight may have been received, so its outcome becomes unknown (`no_result`) and it is never
 * retried. Returns the code for the run's step log.
 */
export async function settleOverdueHttpCall(
  tx: Tx,
  tenantId: string,
  callId: string,
  now: Date,
): Promise<string> {
  const [call] = await tx
    .select({
      state: automationHttpCalls.state,
      statusCode: automationHttpCalls.statusCode,
      errorCode: automationHttpCalls.errorCode,
    })
    .from(automationHttpCalls)
    .where(and(eq(automationHttpCalls.tenantId, tenantId), eq(automationHttpCalls.id, callId)))
    .for('update');
  if (!call) return 'missing_call';
  if (FINISHED_HTTP_STATES.has(call.state)) return httpCallDetail(call);
  const queued = call.state === 'queued';
  const errorCode = queued ? 'not_started' : 'no_result';
  await tx
    .update(automationHttpCalls)
    .set({
      state: queued ? 'canceled' : 'unknown',
      errorCode,
      finishedAt: now,
      leaseUntil: null,
      requestCiphertext: null,
    })
    .where(and(eq(automationHttpCalls.tenantId, tenantId), eq(automationHttpCalls.id, callId)));
  return errorCode;
}

/** Queued calls whose job was lost, for the minute sweep (ids of active companies only). */
export async function findDueHttpCalls(
  db: Database,
  limit = 200,
): Promise<{ tenantId: string; callId: string }[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; call_id: string }>(
        sql`select tenant_id, call_id from ops.automation_http_calls_due(${limit})`,
      );
      return res.rows.map((r) => ({ tenantId: r.tenant_id, callId: r.call_id }));
    },
    { accessMode: 'read only' },
  );
}

export async function signalHttpCall(
  deps: Pick<HttpQueueDeps, 'jobs' | 'signer'>,
  input: { tenantId: string; callId: string },
): Promise<void> {
  await deps.jobs.enqueue(
    null,
    QUEUES.automationHttp.name,
    deps.signer.sign({
      kind: 'automation.http',
      tenantId: input.tenantId,
      actorUserId: null,
      ref: input.callId,
    }),
    { singletonKey: input.callId },
  );
}

/** A value from a JSON response by a dotted path (keys and array positions); scalars only. */
export function valueAtPath(document: unknown, path: string): string | null {
  const value = scalarAtPath(document, path);
  return value === null ? null : clipText(value, AUTOMATION_LIMITS.answerLength);
}

/** As `valueAtPath`, before clipping (so the whole value can be checked for secrets). */
function scalarAtPath(document: unknown, path: string): string | null {
  let current: unknown = document;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!/^\d{1,4}$/.test(segment)) return null;
      current = current[Number(segment)];
    } else if (current && typeof current === 'object') {
      current = Object.prototype.hasOwnProperty.call(current, segment)
        ? (current as Record<string, unknown>)[segment]
        : undefined;
    } else {
      return null;
    }
  }
  if (typeof current === 'string') return current;
  if (typeof current === 'number' && Number.isFinite(current)) return String(current);
  if (typeof current === 'boolean') return current ? 'true' : 'false';
  return null;
}

/**
 * Whether a response's body can be saved as text (ADR-406): `text/*`, JSON and XML types
 * (`application/json`, `application/xml`, `…+json`, `…+xml`), in UTF-8 (no charset, utf-8 or
 * us-ascii). Anything else (images, PDFs, octet streams, other charsets, no content type) is not.
 */
export function textualContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const [essence = '', ...params] = contentType.split(';').map((p) => p.trim().toLowerCase());
  const textual =
    /^text\/[a-z0-9!#$&^_.+-]+$/.test(essence) ||
    /^application\/([a-z0-9!#$&^_.-]+\+)?(json|xml)$/.test(essence);
  if (!textual) return false;
  for (const param of params) {
    const at = param.indexOf('=');
    if (at < 0 || param.slice(0, at).trim() !== 'charset') continue;
    const charset = param
      .slice(at + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (charset !== 'utf-8' && charset !== 'utf8' && charset !== 'us-ascii') return false;
  }
  return true;
}

/**
 * A response header's value by name, case-insensitively. Node joins a header received several
 * times with ", " (keeping only the first for headers that allow one value, such as Content-Type),
 * and the egress client joins any list the same way, so a repeated header is one value: its values
 * in the order received, separated by a comma and a space (RFC 9110, section 5.3).
 */
export function responseHeaderValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  const values = Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === lower)
    .map(([, value]) => value);
  return values.length > 0 ? values.join(', ') : null;
}

/** What a successful response offers to save. */
export interface SavableResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
}

/** What the request carried, so that a saved value does not hand back a company secret. */
export interface SaveGuard {
  /** The request's headers, secrets shown as their placeholders (`httpHeaderText`). */
  requestHeaders?: readonly { name: string; value: string }[];
  /** The company's secret names when the call was claimed. */
  secretNames?: Iterable<string>;
  /** The secret values the request carried. */
  secretValues?: Iterable<string>;
  /**
   * Those of them the request sent touching a letter, a digit or another secret (`adjacentSecrets`,
   * a step published before the separator check): found anywhere in a value, not only as tokens.
   */
  looseSecretValues?: Iterable<string>;
}

/**
 * Why a value was left out for safety (ADR-406), recorded by answer name on the call (never the
 * value): a header refused as a credential or session, a header the step sends a secret in or
 * named like a company secret, a value holding a secret the request carried, or a value ending
 * with the start of one, which may be an echo cut inside it.
 */
export const HTTP_DROP_REASONS = [
  'refused_header',
  'secret_header',
  'echoed_secret',
  'possible_cut_echo',
] as const;
export type HttpDropReason = (typeof HTTP_DROP_REASONS)[number];

/** Outside text with each NUL character as U+FFFD, which PostgreSQL can store (ADR-130). */
const storable = (text: string): string => text.replaceAll(NUL, NUL_REPLACEMENT);

/** Parses a body as JSON once, for the values saved by path (undefined: empty or not JSON). */
function jsonDocument(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return parseExternalJson(body.toString('utf8'));
  } catch {
    // Not JSON: no path finds a value, and the call's outcome still stands.
    return undefined;
  }
}

/**
 * The whole value one source of a response offers, before clipping; null when it has none, or the
 * reason a header is refused.
 */
function rawValue(
  response: SavableResponse,
  item: HttpSave,
  guard: { requestHeaders: readonly { name: string; value: string }[]; secretNames: string[] },
  json: () => unknown,
): string | null | { refused: HttpDropReason } {
  switch (item.from) {
    case 'header': {
      // Checked when the automation is saved and again here (a secret may have been added since).
      if (responseHeaderRefusal(item.header) !== null) return { refused: 'refused_header' };
      if (savedHeaderSecretRefusal(item.header, guard.requestHeaders, guard.secretNames) !== null)
        return { refused: 'secret_header' };
      // Node reads header values as latin1: UTF-8 bytes in a header arrive as latin1 characters.
      const raw = responseHeaderValue(response.headers, item.header);
      return raw === null ? null : storable(raw);
    }
    case 'text': {
      if (response.body.length === 0) return null;
      if (!textualContentType(responseHeaderValue(response.headers, 'content-type'))) return null;
      // UTF-8 (invalid bytes as U+FFFD, a byte order mark dropped), outer white space trimmed.
      const text = storable(new TextDecoder('utf-8').decode(response.body)).trim();
      return text || null;
    }
    case 'status':
      return String(response.status);
    default: {
      const document = json();
      return document === undefined ? null : scalarAtPath(document, item.path);
    }
  }
}

/** Values to save from a response, and the answers left out for safety with the reason. */
export interface SavedValues {
  values: Record<string, string>;
  dropped: Record<string, HttpDropReason>;
}

/**
 * Values to save from a successful response, by answer name (ADR-406). Each comes from a JSON path
 * in the body (the default), a header, the body as text (textual content types only) or the status
 * code, clipped as answers are (to 1,000 UTF-16 code units, never splitting an emoji). A missing
 * or non-scalar value and a path into a body that is not JSON save nothing. A refused header, a
 * value holding a secret the request carried and one that may be an echo cut inside a secret
 * (checked on the whole value before clipping, in the encodings `echoMatcher` reads) are left out
 * and named in `dropped`.
 */
export function savedValuesFrom(
  response: SavableResponse,
  save: readonly HttpSave[],
  guard: SaveGuard = {},
): SavedValues {
  const out: SavedValues = { values: {}, dropped: {} };
  if (save.length === 0) return out;
  // One matcher per response: each secret's patterns are prepared once for every value saved.
  const echoes = echoMatcher(guard.secretValues ?? [], guard.looseSecretValues ?? []);
  const checks = {
    requestHeaders: guard.requestHeaders ?? [],
    secretNames: [...(guard.secretNames ?? [])],
  };
  let parsed: { document: unknown } | null = null;
  const json = () => (parsed ??= { document: jsonDocument(response.body) }).document;
  for (const item of save) {
    const raw = rawValue(response, item, checks, json);
    if (raw === null) continue;
    if (typeof raw !== 'string') {
      out.dropped[item.saveAs] = raw.refused;
      continue;
    }
    const value = clipText(raw, AUTOMATION_LIMITS.answerLength);
    // A server that echoes the request would otherwise hand a secret to whoever reads the answers.
    const echo = echoes(raw, value);
    if (echo !== null) {
      out.dropped[item.saveAs] = echo;
      continue;
    }
    out.values[item.saveAs] = value;
  }
  return out;
}

export interface HttpCallDeps extends HttpQueueDeps {
  db: Database;
  clock: Clock;
  egress: EgressClient;
  /** Egress deadline (the lease covers it plus a margin). */
  timeoutMs: number;
}

export type HttpCallOutcome = HttpCallState | 'idle';

interface Claimed {
  runId: string;
  actorUserId: string | null;
  method: HttpMethod;
  request: StoredRequest;
  secrets: Map<string, string>;
  /** The company's secret names, when the step saves a header (ADR-406). */
  secretNames: string[];
}

/**
 * Makes a queued call: claims it, sends the request with no locks held, records the outcome and
 * signals the run. Returns the call's final state ('idle' when there was nothing to do).
 */
export async function processHttpCall(
  deps: HttpCallDeps,
  scope: TenantScope,
  callId: string,
): Promise<HttpCallOutcome> {
  const tenantId = scope.tenantId;
  const claimed = await deps.db.run(scope, async (tx): Promise<Claimed | HttpCallOutcome> => {
    const now = deps.clock.now();
    const [call] = await tx
      .select()
      .from(automationHttpCalls)
      .where(and(eq(automationHttpCalls.tenantId, tenantId), eq(automationHttpCalls.id, callId)))
      .for('update');
    if (!call || call.state !== 'queued' || !call.requestCiphertext) return 'idle';
    const [run] = await tx
      .select({
        status: automationRuns.status,
        waitingFor: automationRuns.waitingFor,
        currentNodeId: automationRuns.currentNodeId,
        nodeVisit: automationRuns.nodeVisit,
        waitUntil: automationRuns.waitUntil,
        actorUserId: automationRuns.startedByUserId,
      })
      .from(automationRuns)
      .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, call.runId)));
    if (
      !run ||
      run.status !== 'waiting' ||
      run.waitingFor !== 'http' ||
      run.currentNodeId !== call.nodeId ||
      run.nodeVisit !== call.nodeVisit
    ) {
      // The run no longer waits for this call (it ended, or a member took over): never send it.
      await tx
        .update(automationHttpCalls)
        .set({
          state: 'canceled',
          errorCode: 'run_ended',
          finishedAt: now,
          requestCiphertext: null,
        })
        .where(eq(automationHttpCalls.id, call.id));
      return 'canceled';
    }
    if (run.waitUntil !== null && run.waitUntil <= now) {
      // Past the run's deadline (the job waited, for example while the company was suspended):
      // too late to send; the run takes its failure branch.
      await tx
        .update(automationHttpCalls)
        .set({
          state: 'canceled',
          errorCode: 'not_started',
          finishedAt: now,
          requestCiphertext: null,
        })
        .where(eq(automationHttpCalls.id, call.id));
      await signalAutomationRun(deps, tx, {
        tenantId,
        runId: call.runId,
        actorUserId: run.actorUserId,
        key: `h:${call.id}`,
      });
      return 'canceled';
    }
    const request = JSON.parse(
      deps.keyring.decryptString(call.requestCiphertext, requestAad(tenantId, call.id)),
    ) as StoredRequest;
    // The company's current rules apply when the request is made (the list may have changed).
    const domains = await tx
      .select({ domain: httpAllowedDomains.domain })
      .from(httpAllowedDomains)
      .where(eq(httpAllowedDomains.tenantId, tenantId));
    const host = URL.canParse(request.url) ? new URL(request.url).hostname : null;
    const names = collectSecretNames(request);
    const secrets = new Map<string, string>();
    let secretRefusal: 'secret_missing' | 'secret_domain_mismatch' | null = null;
    if (names.size > 0 && host !== null) {
      const rows = await tx
        .select({
          id: httpSecrets.id,
          name: httpSecrets.name,
          domain: httpSecrets.domain,
          value: httpSecrets.valueCiphertext,
        })
        .from(httpSecrets)
        .where(and(eq(httpSecrets.tenantId, tenantId), inArray(httpSecrets.name, [...names])));
      for (const row of rows) {
        // A secret only ever goes to the domain it was saved for.
        if (!hostAllowed(host, [row.domain])) {
          secretRefusal = 'secret_domain_mismatch';
          continue;
        }
        secrets.set(row.name, deps.keyring.decryptString(row.value, secretAad(tenantId, row.id)));
      }
      if (!secretRefusal && [...names].some((name) => !secrets.has(name))) {
        secretRefusal = 'secret_missing';
      }
    }
    const refusal =
      host === null ||
      !hostAllowed(
        host,
        domains.map((d) => d.domain),
      )
        ? 'domain_not_allowed'
        : secretRefusal;
    if (refusal) {
      // Refused before sending: a known failure, and the run takes its failure branch.
      await tx
        .update(automationHttpCalls)
        .set({ state: 'failed', errorCode: refusal, finishedAt: now, requestCiphertext: null })
        .where(eq(automationHttpCalls.id, call.id));
      await signalAutomationRun(deps, tx, {
        tenantId,
        runId: call.runId,
        actorUserId: run.actorUserId,
        key: `h:${call.id}`,
      });
      return 'failed';
    }
    // A header named like a company secret is never saved, whenever the secret was added.
    const secretNames = request.save.some((item) => item.from === 'header')
      ? (
          await tx
            .select({ name: httpSecrets.name })
            .from(httpSecrets)
            .where(eq(httpSecrets.tenantId, tenantId))
        ).map((row) => row.name)
      : [];
    await tx
      .update(automationHttpCalls)
      .set({
        state: 'in_flight',
        startedAt: now,
        leaseUntil: new Date(now.getTime() + deps.timeoutMs + LEASE_MARGIN_MS),
      })
      .where(eq(automationHttpCalls.id, call.id));
    return {
      runId: call.runId,
      actorUserId: run.actorUserId,
      method: call.method,
      request,
      secrets,
      secretNames,
    };
  });
  if (typeof claimed === 'string') return claimed;

  // The request, outside any transaction.
  const outcome = await send(deps.egress, claimed);

  return deps.db.run(scope, async (tx) => {
    const now = deps.clock.now();
    const [call] = await tx
      .select({ state: automationHttpCalls.state })
      .from(automationHttpCalls)
      .where(and(eq(automationHttpCalls.tenantId, tenantId), eq(automationHttpCalls.id, callId)))
      .for('update');
    // The runner settled it as unknown in the meantime (past the run's deadline): that stands.
    if (!call || call.state !== 'in_flight') return call?.state ?? 'idle';
    const [run] = await tx
      .select({ status: automationRuns.status })
      .from(automationRuns)
      .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, claimed.runId)));
    const active = run?.status === 'running' || run?.status === 'waiting';
    await tx
      .update(automationHttpCalls)
      .set({
        state: outcome.state,
        statusCode: outcome.statusCode,
        errorCode: outcome.errorCode,
        durationMs: outcome.durationMs,
        // Values are only kept for a run that can still use them (never after an erasure).
        savedValues: active ? outcome.saved.values : {},
        // The answers left out for safety, by name and reason (never a value), for the run page.
        droppedValues: outcome.saved.dropped,
        finishedAt: now,
        leaseUntil: null,
        requestCiphertext: null,
      })
      .where(eq(automationHttpCalls.id, callId));
    if (active) {
      await signalAutomationRun(deps, tx, {
        tenantId,
        runId: claimed.runId,
        actorUserId: claimed.actorUserId,
        key: `h:${callId}`,
      });
    }
    return outcome.state;
  });
}

interface SendOutcome {
  state: 'succeeded' | 'failed' | 'unknown';
  statusCode: number | null;
  errorCode: string | null;
  durationMs: number | null;
  saved: SavedValues;
}

/** Fills secrets into the headers and sends the request through the egress client. */
async function send(egress: EgressClient, claimed: Claimed): Promise<SendOutcome> {
  const headers: Record<string, string> = {};
  for (const header of claimed.request.headers) {
    // Every secret was found when the call was claimed (a missing one refuses the call).
    headers[header.name] = header.parts
      .map((part) => ('secret' in part ? (claimed.secrets.get(part.secret) ?? '') : part.text))
      .join('');
  }
  try {
    const response = await egress.request({
      method: claimed.method,
      url: claimed.request.url,
      headers,
      body: claimed.request.body,
    });
    const ok = response.status >= 200 && response.status <= 299;
    return {
      state: ok ? 'succeeded' : 'failed',
      statusCode: response.status,
      errorCode: null,
      durationMs: response.durationMs,
      saved: ok
        ? savedValuesFrom(response, claimed.request.save, {
            requestHeaders: claimed.request.headers.map((h) => ({
              name: h.name,
              value: httpHeaderText(h.parts),
            })),
            secretNames: claimed.secretNames,
            secretValues: claimed.secrets.values(),
            // Secrets a step published before the separator check sends touching other text.
            looseSecretValues: looseSecretValuesOf(claimed.request.headers, claimed.secrets),
          })
        : { values: {}, dropped: {} },
    };
  } catch (error) {
    if (!(error instanceof EgressError)) throw error;
    // Sent without a complete answer: the server may have acted on it, so the outcome is unknown.
    // (A response over the size limit did arrive: the call failed, with a known reply.)
    const unknown = error.sent && error.code !== 'response_too_large';
    return {
      state: unknown ? 'unknown' : 'failed',
      statusCode: null,
      errorCode: error.code,
      durationMs: null,
      saved: { values: {}, dropped: {} },
    };
  }
}

function collectSecretNames(request: StoredRequest): Set<string> {
  const names = new Set<string>();
  for (const header of request.headers) {
    for (const part of header.parts) if ('secret' in part) names.add(part.secret);
  }
  return names;
}
