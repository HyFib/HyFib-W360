import { uuidv7, type Clock, type Keyring } from '@w360/core';
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
import type { JobQueue } from '../jobs/queue';
import { AUTOMATION_LIMITS, hostAllowed, type HttpHeaderPart, type HttpMethod } from './graph';
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
  save: { path: string; saveAs: string }[];
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

export { secretAad as httpSecretAad };

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
  if (typeof current === 'string') return current.slice(0, AUTOMATION_LIMITS.answerLength);
  if (typeof current === 'number' && Number.isFinite(current)) return String(current);
  if (typeof current === 'boolean') return current ? 'true' : 'false';
  return null;
}

/** Values to save from a response body, by answer name (missing or non-scalar values are left out). */
export function savedValuesFrom(
  body: Buffer,
  save: readonly { path: string; saveAs: string }[],
): Record<string, string> {
  if (save.length === 0 || body.length === 0) return {};
  let document: unknown;
  try {
    document = JSON.parse(body.toString('utf8'));
  } catch {
    // Not JSON: there is nothing to save, and the call's outcome still stands.
    return {};
  }
  const values: Record<string, string> = {};
  for (const item of save) {
    const value = valueAtPath(document, item.path);
    if (value !== null) values[item.saveAs] = value;
  }
  return values;
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
        savedValues: active ? outcome.values : {},
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
  values: Record<string, string>;
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
      values: ok ? savedValuesFrom(response.body, claimed.request.save) : {},
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
      values: {},
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
