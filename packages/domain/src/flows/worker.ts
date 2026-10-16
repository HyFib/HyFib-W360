import { createHash } from 'node:crypto';
import { uuidv7, type Clock, type Keyring } from '@w360/core';
import {
  and,
  asc,
  channelAccounts,
  eq,
  flowKeyUploads,
  flowKeys,
  flows,
  desc,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  systemScope,
  type Database,
  type FlowMetaStatus,
  type TenantScope,
  type Tx,
} from '@w360/db';
import type { GraphClient, GraphResult, RemoteFlow } from '../messaging/graph';
import {
  activeManagementPause,
  isManagementPaused,
  managementResumeAt,
  pacedManagementCalls,
  untilPaused,
  type ManagementPaused,
} from '../messaging/management-pace';
import { wabaCredential } from '../templates/service';
import { generateFlowKeyPair } from './crypto';
import {
  PREVIOUS_KEY_HOURS,
  flowEndpointUrl,
  flowKeyAad,
  isOwnMetaFlow,
  metaFlowName,
} from './model';

/**
 * Worker side of WhatsApp Flows: the one pending operation on a flow (written ahead by the
 * service) is performed against Meta and its outcome recorded; a crash or a lost response leaves
 * the operation pending for the retry or the sweep, which repeat it safely (creation first looks for
 * the flow an earlier attempt may have made; publishing, deprecating and deleting check the state
 * Meta reports). Keys are generated, uploaded to every number of the account and checked.
 */

export interface FlowWorkerDeps {
  db: Database;
  keyring: Keyring;
  graph: GraphClient;
  clock: Clock;
  appBaseUrl: string;
}

/** `paused`: Meta throttles the account's management calls; what is left waits (ADR-399). */
export type FlowJobOutcome = 'done' | 'skipped' | 'retry' | ManagementPaused;

type PacedCall = ReturnType<typeof pacedManagementCalls>;

/** Operations pending longer than this are failed by the sweep instead of tried again. */
export const FLOW_SYNC_GIVE_UP_MS = 30 * 60_000;
/** Key uploads are tried this many times before they are marked failed. */
export const FLOW_KEY_UPLOAD_ATTEMPTS = 5;

const META_STATUSES = new Set<string>(['DRAFT', 'PUBLISHED', 'DEPRECATED', 'BLOCKED', 'THROTTLED']);
const metaStatus = (value: string | null): FlowMetaStatus | null =>
  value && META_STATUSES.has(value) ? (value as FlowMetaStatus) : null;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

type Failure = Extract<GraphResult<never>, { ok: false }>;

/** Whether a failure is worth another attempt (a connection problem, rate limit or outage). */
const transient = (f: Failure) => f.kind === 'retryable' || f.kind === 'unknown';

function failureMessage(f: Failure): string {
  if (f.kind === 'auth') {
    return 'Meta rejected the stored credential. Reconnect the WhatsApp account, then try again.';
  }
  return `Meta did not accept the change: ${(f.detail ?? f.title).slice(0, 800)}`;
}

/** Finds the flow an earlier attempt created (its name carries this flow's reference). */
async function findOwnFlow(
  graph: GraphClient,
  call: PacedCall,
  credential: { wabaId: string; token: string },
  publicId: string,
): Promise<{ ok: true; id: string | null } | Failure> {
  let after: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const listed = await call(() =>
      graph.listFlows(credential.wabaId, credential.token, { after }),
    );
    if (!listed.ok) return listed;
    const own = listed.data.flows.find((f) => isOwnMetaFlow(f.name, publicId));
    if (own) return { ok: true, id: own.id };
    if (!listed.data.after) return { ok: true, id: null };
    after = listed.data.after;
  }
  return { ok: true, id: null };
}

/** Performs a flow's pending operation at Meta. */
export async function processFlowSync(
  deps: FlowWorkerDeps,
  scope: TenantScope,
  flowId: string,
): Promise<FlowJobOutcome> {
  const claimed = await deps.db.run(scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(flows)
      .where(and(eq(flows.tenantId, scope.tenantId), eq(flows.id, flowId)))
      .for('update');
    if (!row || !row.syncOp || (row.syncState !== 'queued' && row.syncState !== 'running')) {
      return null;
    }
    if (row.syncState === 'queued') {
      await tx
        .update(flows)
        .set({ syncState: 'running' })
        .where(and(eq(flows.tenantId, scope.tenantId), eq(flows.id, flowId)));
    }
    const credential = await wabaCredential(
      tx,
      scope.tenantId,
      row.whatsappAccountId,
      deps.keyring,
    );
    return { row, op: row.syncOp, credential };
  });
  if (!claimed) return 'skipped';
  const { row, op, credential } = claimed;

  /** Records the outcome, only if the flow still waits for this same operation. */
  const settle = (set: Partial<typeof flows.$inferInsert>) =>
    deps.db.run(scope, async (tx) => {
      await tx
        .update(flows)
        .set({
          syncOp: null,
          syncState: 'idle',
          syncError: null,
          syncedAt: deps.clock.now(),
          ...set,
        })
        .where(
          and(
            eq(flows.tenantId, scope.tenantId),
            eq(flows.id, flowId),
            eq(flows.syncOp, op),
            inArray(flows.syncState, ['queued', 'running']),
          ),
        );
    });
  const fail = async (message: string) => {
    await settle({ syncOp: op, syncState: 'failed', syncError: message, syncedAt: row.syncedAt });
    return 'done' as const;
  };
  const onFailure = async (f: Failure): Promise<FlowJobOutcome> =>
    transient(f) ? 'retry' : fail(failureMessage(f));

  if (!credential) {
    return fail('The WhatsApp account is not connected. Reconnect it, then try again.');
  }
  /**
   * Deferred because Meta throttles the account's management calls (ADR-399): records when the job
   * runs again, while the flow still waits for this operation, so the sweep's 30-minute give-up
   * counts from then.
   */
  const defer = async (pausedUntil: Date): Promise<ManagementPaused> => {
    await deps.db.run(scope, (tx) =>
      tx
        .update(flows)
        .set({ managementDeferredUntil: managementResumeAt(pausedUntil) })
        .where(
          and(
            eq(flows.tenantId, scope.tenantId),
            eq(flows.id, flowId),
            eq(flows.syncOp, op),
            inArray(flows.syncState, ['queued', 'running']),
          ),
        ),
    );
    return { paused: pausedUntil };
  };
  // While Meta throttles the account's management calls nothing is asked (ADR-399).
  const paused = activeManagementPause(credential.managementPausedUntil, deps.clock.now());
  if (paused) return defer(paused);
  const call = pacedManagementCalls(deps, scope, credential);
  const outcome = await untilPaused(async (): Promise<FlowJobOutcome> => {
    const token = credential.token;
    const endpointUri = row.dataApiVersion ? flowEndpointUrl(deps.appBaseUrl, row.publicId) : null;
    const metadata = {
      name: metaFlowName(row.name, row.publicId),
      categories: row.categories,
      endpointUri,
    };
    let metaFlowId = row.metaFlowId;
    let validationErrors = row.validationErrors;
    let uploadedJsonSha256 = row.uploadedJsonSha256;

    if (op === 'create' || op === 'upload') {
      if (!metaFlowId) {
        const found = await findOwnFlow(deps.graph, call, credential, row.publicId);
        if (!found.ok) return onFailure(found);
        if (found.id) {
          metaFlowId = found.id;
        } else {
          const created = await call(() =>
            deps.graph.createFlow(credential.wabaId, token, metadata),
          );
          if (!created.ok) return onFailure(created);
          metaFlowId = created.data.id;
        }
        // Kept at once: a crash before the upload must not lose the flow Meta now has.
        const id = metaFlowId;
        await deps.db.run(scope, (tx) =>
          tx
            .update(flows)
            .set({ metaFlowId: id, metaStatus: 'DRAFT' })
            .where(and(eq(flows.tenantId, scope.tenantId), eq(flows.id, flowId))),
        );
      } else {
        const existing = metaFlowId;
        const updated = await call(() => deps.graph.updateFlowMetadata(existing, token, metadata));
        if (!updated.ok) return onFailure(updated);
      }
      const target = metaFlowId;
      const uploaded = await call(() => deps.graph.uploadFlowJson(target, token, row.flowJson));
      if (!uploaded.ok) return onFailure(uploaded);
      validationErrors = uploaded.data.validationErrors;
      uploadedJsonSha256 = sha256(row.flowJson);
    }
    const flowRef = metaFlowId;
    if (!flowRef) return fail('This flow is not at Meta yet. Send it to Meta first.');

    const current = async (): Promise<GraphResult<RemoteFlow>> =>
      call(() => deps.graph.getFlow(flowRef, token));

    if (op === 'publish' || op === 'deprecate') {
      const target = op === 'publish' ? 'PUBLISHED' : 'DEPRECATED';
      const before = await current();
      if (!before.ok) return onFailure(before);
      if (before.data.status !== target) {
        const done =
          op === 'publish'
            ? await call(() => deps.graph.publishFlow(flowRef, token))
            : await call(() => deps.graph.deprecateFlow(flowRef, token));
        if (!done.ok) return onFailure(done);
      }
    } else if (op === 'delete') {
      const before = await current();
      if (!before.ok) {
        if (before.kind !== 'permanent') return onFailure(before);
        // Meta cannot read it: it may already be gone. The member can archive it in HyFib.
        return fail(
          `Meta could not read this flow (${(before.detail ?? before.title).slice(0, 300)}). If it was already deleted there, archive it.`,
        );
      }
      if (before.data.status !== 'DRAFT') {
        return fail('Only draft flows can be deleted at Meta; deprecate a published flow instead.');
      }
      const deleted = await call(() => deps.graph.deleteFlow(flowRef, token));
      if (!deleted.ok) return onFailure(deleted);
      await settle({
        metaFlowId: null,
        metaStatus: null,
        previewUrl: null,
        previewExpiresAt: null,
        health: null,
        archivedAt: deps.clock.now(),
      });
      return 'done';
    }

    const remote = await current();
    if (!remote.ok) return onFailure(remote);
    await settle({
      metaFlowId: flowRef,
      metaStatus: metaStatus(remote.data.status),
      validationErrors:
        op === 'create' || op === 'upload' ? validationErrors : remote.data.validationErrors,
      uploadedJsonSha256,
      health: remote.data.health,
      previewUrl: remote.data.previewUrl,
      previewExpiresAt: remote.data.previewExpiresAt,
    });
    return 'done';
  });
  return isManagementPaused(outcome) ? defer(outcome.paused) : outcome;
}

/**
 * Fails a flow operation that has waited too long (the sweep calls this for old operations): asked
 * more than 30 minutes ago, and not deferred for a pause to less than 30 minutes ago (ADR-399).
 */
export async function giveUpFlowSync(
  deps: { db: Database; clock: Clock },
  scope: TenantScope,
  flowId: string,
) {
  await deps.db.run(scope, (tx) =>
    tx
      .update(flows)
      .set({
        syncState: 'failed',
        syncError:
          'This did not finish within 30 minutes (Meta did not answer, or the company was suspended). Try again.',
      })
      .where(
        and(
          eq(flows.tenantId, scope.tenantId),
          eq(flows.id, flowId),
          inArray(flows.syncState, ['queued', 'running']),
          lt(flows.syncRequestedAt, new Date(deps.clock.now().getTime() - FLOW_SYNC_GIVE_UP_MS)),
          or(
            isNull(flows.managementDeferredUntil),
            lt(
              flows.managementDeferredUntil,
              new Date(deps.clock.now().getTime() - FLOW_SYNC_GIVE_UP_MS),
            ),
          ),
        ),
      ),
  );
}

const normalizePem = (pem: string) => pem.replace(/\s+/g, '');

/**
 * When the account's previous key may be retired (its private key erased): never while the active
 * key still has an upload pending (Meta may still encrypt with the previous key, for example while
 * a pause defers the upload, ADR-399), and only 24 hours after the later of its replacement and the
 * active key's latest successful upload, so Meta has a full grace period with the new key. A failed
 * upload does not hold it back, as before. Null: not yet.
 */
export function previousKeyRetirementCutoff(
  replacedBefore: Date,
  facts: { activeUploadPending: boolean; activeLastUploadedAt: Date | null },
): Date | null {
  if (facts.activeUploadPending) return null;
  if (facts.activeLastUploadedAt && facts.activeLastUploadedAt >= replacedBefore) return null;
  return replacedBefore;
}

/**
 * Retires the account's previous keys whose grace period has passed (`previousKeyRetirementCutoff`),
 * in the job's transaction, after the active key's uploads for new numbers were written.
 */
async function retirePreviousKeys(
  tx: Tx,
  tenantId: string,
  whatsappAccountId: string,
  activeKeyId: string,
  now: Date,
): Promise<void> {
  const graceStart = new Date(now.getTime() - PREVIOUS_KEY_HOURS * 3_600_000);
  const [pending] = await tx
    .select({ id: flowKeyUploads.id })
    .from(flowKeyUploads)
    .where(
      and(
        eq(flowKeyUploads.tenantId, tenantId),
        eq(flowKeyUploads.keyId, activeKeyId),
        eq(flowKeyUploads.state, 'pending'),
      ),
    )
    .limit(1);
  const [uploaded] = await tx
    .select({ at: flowKeyUploads.uploadedAt })
    .from(flowKeyUploads)
    .where(
      and(
        eq(flowKeyUploads.tenantId, tenantId),
        eq(flowKeyUploads.keyId, activeKeyId),
        isNotNull(flowKeyUploads.uploadedAt),
      ),
    )
    .orderBy(desc(flowKeyUploads.uploadedAt))
    .limit(1);
  const cutoff = previousKeyRetirementCutoff(graceStart, {
    activeUploadPending: pending !== undefined,
    activeLastUploadedAt: uploaded?.at ?? null,
  });
  if (!cutoff) return;
  await tx
    .update(flowKeys)
    .set({ state: 'retired', privateKeyCiphertext: null, retiredAt: now })
    .where(
      and(
        eq(flowKeys.tenantId, tenantId),
        eq(flowKeys.whatsappAccountId, whatsappAccountId),
        eq(flowKeys.state, 'previous'),
        lt(flowKeys.replacedAt, cutoff),
      ),
    );
}

/**
 * Makes sure the account has an active key, uploads it to every active number that does not have
 * it yet, checks what Meta reports, and retires a replaced key after its grace period.
 */
export async function processFlowKeys(
  deps: FlowWorkerDeps,
  scope: TenantScope,
  whatsappAccountId: string,
): Promise<FlowJobOutcome> {
  const now = deps.clock.now();
  let [active] = await deps.db.run(scope, (tx) =>
    tx
      .select()
      .from(flowKeys)
      .where(
        and(
          eq(flowKeys.tenantId, scope.tenantId),
          eq(flowKeys.whatsappAccountId, whatsappAccountId),
          eq(flowKeys.state, 'active'),
        ),
      ),
  );
  if (!active) {
    // Generated outside the transaction (it takes a moment); a concurrent job's key wins.
    const pair = generateFlowKeyPair();
    const id = uuidv7();
    await deps.db.run(scope, (tx) =>
      tx
        .insert(flowKeys)
        .values({
          id,
          tenantId: scope.tenantId,
          whatsappAccountId,
          publicKeyPem: pair.publicKeyPem,
          fingerprint: pair.fingerprint,
          privateKeyCiphertext: deps.keyring.encrypt(
            pair.privateKeyPem,
            flowKeyAad(scope.tenantId, id),
          ),
        })
        .onConflictDoNothing(),
    );
    [active] = await deps.db.run(scope, (tx) =>
      tx
        .select()
        .from(flowKeys)
        .where(
          and(
            eq(flowKeys.tenantId, scope.tenantId),
            eq(flowKeys.whatsappAccountId, whatsappAccountId),
            eq(flowKeys.state, 'active'),
          ),
        ),
    );
    if (!active) return 'retry';
  }
  const key = active;

  const work = await deps.db.run(scope, async (tx) => {
    const numbers = await tx
      .select({ id: channelAccounts.id, phoneNumberId: channelAccounts.phoneNumberId })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, scope.tenantId),
          eq(channelAccounts.whatsappAccountId, whatsappAccountId),
          eq(channelAccounts.status, 'active'),
        ),
      )
      .orderBy(asc(channelAccounts.id));
    for (const n of numbers) {
      await tx
        .insert(flowKeyUploads)
        .values({ id: uuidv7(), tenantId: scope.tenantId, keyId: key.id, channelAccountId: n.id })
        .onConflictDoNothing();
    }
    await retirePreviousKeys(tx, scope.tenantId, whatsappAccountId, key.id, now);
    const pending = await tx
      .select({
        id: flowKeyUploads.id,
        attempts: flowKeyUploads.attempts,
        channelAccountId: flowKeyUploads.channelAccountId,
      })
      .from(flowKeyUploads)
      .where(
        and(
          eq(flowKeyUploads.tenantId, scope.tenantId),
          eq(flowKeyUploads.keyId, key.id),
          eq(flowKeyUploads.state, 'pending'),
        ),
      );
    const credential = await wabaCredential(tx, scope.tenantId, whatsappAccountId, deps.keyring);
    return { numbers: new Map(numbers.map((n) => [n.id, n.phoneNumberId])), pending, credential };
  });
  if (work.pending.length === 0) return 'done';
  if (!work.credential) {
    // Nothing can be uploaded until the account is reconnected (its setup is retried from the page).
    await deps.db.run(scope, (tx) =>
      tx
        .update(flowKeyUploads)
        .set({ state: 'failed', errorCode: 'account_not_connected' })
        .where(
          and(
            eq(flowKeyUploads.tenantId, scope.tenantId),
            eq(flowKeyUploads.keyId, key.id),
            eq(flowKeyUploads.state, 'pending'),
          ),
        ),
    );
    return 'done';
  }
  // While Meta throttles the account's management calls no key is uploaded (ADR-399).
  const credential = work.credential;
  const paused = activeManagementPause(credential.managementPausedUntil, deps.clock.now());
  if (paused) return { paused };
  const call = pacedManagementCalls(deps, scope, credential);

  return untilPaused(async (): Promise<FlowJobOutcome> => {
    let retry = false;
    for (const upload of work.pending) {
      const phoneNumberId = work.numbers.get(upload.channelAccountId);
      const record = (set: Partial<typeof flowKeyUploads.$inferInsert>) =>
        deps.db.run(scope, (tx) =>
          tx
            .update(flowKeyUploads)
            .set({ attempts: sql`${flowKeyUploads.attempts} + 1`, ...set })
            .where(
              and(eq(flowKeyUploads.tenantId, scope.tenantId), eq(flowKeyUploads.id, upload.id)),
            ),
        );
      if (!phoneNumberId) {
        // The number was disconnected since: its upload is no longer needed.
        await record({ state: 'failed', errorCode: 'number_inactive' });
        continue;
      }
      const failed = async (f: Failure) => {
        const lastTry = upload.attempts + 1 >= FLOW_KEY_UPLOAD_ATTEMPTS;
        if (transient(f) && !lastTry) {
          retry = true;
          await record({ errorCode: f.title.slice(0, 64) });
        } else {
          await record({
            state: 'failed',
            errorCode: (f.code ? String(f.code) : f.title).slice(0, 64),
          });
        }
      };
      const uploaded = await call(() =>
        deps.graph.setBusinessPublicKey(phoneNumberId, credential.token, key.publicKeyPem),
      );
      if (!uploaded.ok) {
        await failed(uploaded);
        continue;
      }
      const checked = await call(() =>
        deps.graph.getBusinessPublicKey(phoneNumberId, credential.token),
      );
      if (!checked.ok) {
        await failed(checked);
        continue;
      }
      const sameKey =
        checked.data.publicKeyPem !== null &&
        normalizePem(checked.data.publicKeyPem) === normalizePem(key.publicKeyPem);
      const valid = sameKey && checked.data.signatureStatus === 'VALID';
      await record({
        state: 'uploaded',
        signatureStatus: checked.data.signatureStatus,
        errorCode: valid ? null : sameKey ? 'signature_mismatch' : 'different_key',
        uploadedAt: deps.clock.now(),
        checkedAt: deps.clock.now(),
      });
    }
    return retry ? 'retry' : 'done';
  });
}

export interface FlowWorkItem {
  tenantId: string;
  kind: 'sync' | 'keys';
  ref: string;
}

/** Work the minute sweep re-signals (lost jobs, keys to upload or retire), for active companies. */
export async function findDueFlowWork(db: Database, limit = 200): Promise<FlowWorkItem[]> {
  const res = await db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; kind: string; ref: string }>(
        sql`select tenant_id, kind, ref from ops.flow_work_due(${limit})`,
      ),
    { accessMode: 'read only' },
  );
  return res.rows.map((r) => ({
    tenantId: r.tenant_id,
    kind: r.kind === 'keys' ? 'keys' : 'sync',
    ref: r.ref,
  }));
}
