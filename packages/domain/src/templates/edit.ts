import { AppError } from '@w360/core';
import {
  and,
  asc,
  automations,
  automationVersions,
  campaigns,
  commerceStoreMessageRules,
  commerceStores,
  eq,
  inArray,
  messageTemplates,
  sql,
  type CampaignStatus,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import type { Clock, Keyring } from '@w360/core';
import { recordSystemAudit } from '../audit';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { requestAccessCheck } from '../messaging/access';
import type { GraphClient, RemoteTemplate } from '../messaging/graph';
import {
  activeManagementPause,
  assertManagementOpen,
  managementResumeAt,
  noteManagementUsage,
  refusedForPause,
  type ManagementPaused,
} from '../messaging/management-pace';
import { validateDefinition, type TemplateDefinition } from './definition';
import {
  editReconciliation,
  editRefusalText,
  editTemplateRequest,
  SENDING_CAMPAIGN_STATUSES,
  templateEditRefusal,
} from './edit-model';
import {
  enqueueTemplateJob,
  insertStatusEvent,
  mapProviderTemplateStatus,
  requestSyncTx,
  templateAccount,
  wabaCredential,
} from './shared';

/**
 * Editing a template Meta has (ADR-404): the written-ahead request, its job and the sync's
 * settling of a lost answer. The decisions themselves are in `edit-model.ts`.
 */

/** Campaign statuses before a campaign is finished: drafts to paused. */
const UNFINISHED_CAMPAIGN_STATUSES: CampaignStatus[] = [
  'draft',
  'pending_approval',
  'scheduled',
  'running',
  'paused',
];
const USAGE_LIMIT = 50;

/** Where a template is used, as a member sees it before editing it. */
export interface TemplateUsage {
  /** Campaigns not finished yet that send it, `running` ones sending it now. */
  campaigns: { id: string; name: string; status: CampaignStatus }[];
  /** Published automations (active or paused) whose live version has a step sending it. */
  automations: { id: string; name: string; status: string }[];
  /** Order message and cart reminder rules of the company's stores that send it. */
  storeRules: { id: string; storeName: string | null; event: string; enabled: boolean }[];
}

/** Where the template is used (at most 50 of each kind), in the company's scope. */
export async function templateUsage(
  tx: Tx,
  tenantId: string,
  templateId: string,
): Promise<TemplateUsage> {
  const campaignRows = await tx
    .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.tenantId, tenantId),
        eq(campaigns.templateId, templateId),
        inArray(campaigns.status, UNFINISHED_CAMPAIGN_STATUSES),
      ),
    )
    .orderBy(asc(campaigns.name), asc(campaigns.id))
    .limit(USAGE_LIMIT);
  const automationRows = await tx
    .select({ id: automations.id, name: automations.name, status: automations.status })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.tenantId, automations.tenantId),
        eq(automationVersions.id, automations.activeVersionId),
      ),
    )
    .where(
      and(
        eq(automations.tenantId, tenantId),
        inArray(automations.status, ['active', 'paused']),
        sql`jsonb_path_exists(${automationVersions.graph}, '$.nodes[*] ? (@.templateId == $id)', jsonb_build_object('id', ${templateId}::text))`,
      ),
    )
    .orderBy(asc(automations.name), asc(automations.id))
    .limit(USAGE_LIMIT);
  const ruleRows = await tx
    .select({
      id: commerceStoreMessageRules.id,
      storeName: commerceStores.name,
      event: commerceStoreMessageRules.event,
      enabled: commerceStoreMessageRules.enabled,
    })
    .from(commerceStoreMessageRules)
    .innerJoin(
      commerceStores,
      and(
        eq(commerceStores.tenantId, commerceStoreMessageRules.tenantId),
        eq(commerceStores.id, commerceStoreMessageRules.storeId),
      ),
    )
    .where(
      and(
        eq(commerceStoreMessageRules.tenantId, tenantId),
        eq(commerceStoreMessageRules.templateId, templateId),
        eq(commerceStoreMessageRules.action, 'template'),
      ),
    )
    .orderBy(asc(commerceStoreMessageRules.event), asc(commerceStoreMessageRules.id))
    .limit(USAGE_LIMIT);
  return { campaigns: campaignRows, automations: automationRows, storeRules: ruleRows };
}

/** How many of the company's campaigns using the template are sending it now. */
async function sendingCampaignCount(tx: Tx, tenantId: string, templateId: string) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.tenantId, tenantId),
        eq(campaigns.templateId, templateId),
        inArray(campaigns.status, [...SENDING_CAMPAIGN_STATUSES]),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Sends a locked template Meta has an edit, as the Templates page and the API do (ADR-404): the
 * content is checked as the editor checks drafts (422), the edit as `templateEditRefusal` decides,
 * for a connected account (412) Meta is not throttling (503). Written ahead: the template records
 * the content sent, when, by whom (`actorUserId`, null for a key) and `edit_state = 'sending'`,
 * with an `edit_requested` status change, before the `template.edit` job is queued. Its status,
 * category and content stay what Meta reports until Meta answers.
 */
export async function writeEditTemplate(
  tx: Tx,
  deps: { jobs: JobQueue; signer: JobSigner },
  tenantId: string,
  row: Pick<
    typeof messageTemplates.$inferSelect,
    | 'id'
    | 'status'
    | 'providerTemplateId'
    | 'category'
    | 'components'
    | 'whatsappAccountId'
    | 'editState'
  >,
  definition: TemplateDefinition,
  actorUserId: string | null,
  at: Date,
  /** The company's time zone, for the time a pause ends (the API, which has none, gives UTC). */
  timeZone = 'UTC',
): Promise<void> {
  const issues = validateDefinition(definition);
  if (issues.length > 0) {
    throw new AppError('validation_failed', issues[0]?.message ?? 'Invalid template', { issues });
  }
  const refusal = templateEditRefusal(
    row,
    definition,
    await sendingCampaignCount(tx, tenantId, row.id),
  );
  if (refusal) throw refusal;
  const waba = await templateAccount(tx, tenantId, row.whatsappAccountId);
  if (waba.status !== 'connected') {
    throw new AppError(
      'precondition_failed',
      'Reconnect this WhatsApp account before editing templates.',
    );
  }
  // Meta throttles the account's management calls: say so rather than queue an edit (ADR-399).
  assertManagementOpen(waba.managementPausedUntil, at, timeZone);
  const category = row.category === 'MARKETING' ? 'MARKETING' : 'UTILITY';
  const request = editTemplateRequest(category, definition);
  const [updated] = await tx
    .update(messageTemplates)
    .set({
      editState: 'sending',
      editComponents: request.components,
      editError: null,
      editRequestedAt: at,
      editRequestedByUserId: actorUserId,
      // A new request: an earlier deferral for a pause no longer applies (ADR-399).
      managementDeferredUntil: null,
      version: sql`${messageTemplates.version} + 1`,
    })
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, row.id)))
    .returning({ version: messageTemplates.version });
  await insertStatusEvent(tx, tenantId, {
    templateId: row.id,
    status: 'edit_requested',
    source: 'edit',
    actorUserId,
    at,
  });
  await enqueueTemplateJob(
    tx,
    deps,
    'template.edit',
    tenantId,
    actorUserId,
    row.id,
    `${row.id}:edit:${updated?.version ?? 0}`,
  );
}

/** The edit columns cleared once an edit is settled as made. */
const EDIT_CLEARED = {
  editState: null,
  editComponents: null,
  editError: null,
  editRequestedAt: null,
  editRequestedByUserId: null,
  managementDeferredUntil: null,
} as const;

const knownCategory = (category: string) =>
  category === 'MARKETING' || category === 'UTILITY' || category === 'AUTHENTICATION'
    ? category
    : null;

/**
 * Settles an edit as made, in the caller's transaction: the edit columns are cleared and, when
 * Meta's template was read, its status, category and components stored as Meta reports them;
 * the status history gets an `edited` change naming the member who asked, and one for the status
 * Meta reports when it differs; the audit log a `template.edited` entry. False when the edit was
 * no longer the one sending (`requestedAt`).
 */
async function settleEditMade(
  tx: Tx,
  tenantId: string,
  row: {
    id: string;
    name: string;
    language: string;
    status: string;
    editRequestedAt: Date;
    editRequestedByUserId: string | null;
  },
  remote: RemoteTemplate | null,
  source: 'edit' | 'sync',
  reason: string,
  at: Date,
): Promise<boolean> {
  const status = remote ? mapProviderTemplateStatus(remote.status) : null;
  const category = remote ? knownCategory(remote.category) : null;
  const components =
    remote && JSON.stringify(remote.components).length <= 30_000 ? remote.components : null;
  const updated = await tx
    .update(messageTemplates)
    .set({
      ...EDIT_CLEARED,
      ...(remote && status
        ? { status, providerStatus: remote.status.slice(0, 32), lastSyncedAt: at }
        : {}),
      ...(category ? { category } : {}),
      ...(components ? { components } : {}),
      version: sql`${messageTemplates.version} + 1`,
    })
    .where(
      and(
        eq(messageTemplates.tenantId, tenantId),
        eq(messageTemplates.id, row.id),
        eq(messageTemplates.editState, 'sending'),
        eq(messageTemplates.editRequestedAt, row.editRequestedAt),
      ),
    )
    .returning({ id: messageTemplates.id });
  if (updated.length === 0) return false;
  await insertStatusEvent(tx, tenantId, {
    templateId: row.id,
    status: 'edited',
    reason,
    source,
    actorUserId: row.editRequestedByUserId,
    at,
  });
  if (status && status !== row.status) {
    await insertStatusEvent(tx, tenantId, {
      templateId: row.id,
      status,
      reason: 'Reported by Meta after the edit.',
      source,
      at,
    });
  }
  await recordSystemAudit(tx, tenantId, {
    action: 'template.edited',
    subjectType: 'template',
    subjectId: row.id,
    metadata: {
      name: row.name,
      language: row.language,
      requestedByUserId: row.editRequestedByUserId,
      ...(status ? { status } : {}),
    },
  });
  return true;
}

/**
 * Settles an edit as failed, in the caller's transaction: `failed` with the reason members read,
 * the content kept so it can be changed and sent again, an `edit_failed` status change and a
 * `template.edit_failed` audit entry. False when the edit was no longer the one sending.
 */
async function settleEditFailed(
  tx: Tx,
  tenantId: string,
  row: { id: string; editRequestedAt: Date; editRequestedByUserId: string | null },
  error: string,
  eventReason: string,
  source: 'edit' | 'sync',
  auditMetadata: Record<string, unknown>,
  at: Date,
): Promise<boolean> {
  const updated = await tx
    .update(messageTemplates)
    .set({ editState: 'failed', editError: error.slice(0, 1000), managementDeferredUntil: null })
    .where(
      and(
        eq(messageTemplates.tenantId, tenantId),
        eq(messageTemplates.id, row.id),
        eq(messageTemplates.editState, 'sending'),
        eq(messageTemplates.editRequestedAt, row.editRequestedAt),
      ),
    )
    .returning({ id: messageTemplates.id });
  if (updated.length === 0) return false;
  await insertStatusEvent(tx, tenantId, {
    templateId: row.id,
    status: 'edit_failed',
    reason: eventReason,
    source,
    actorUserId: row.editRequestedByUserId,
    at,
  });
  await recordSystemAudit(tx, tenantId, {
    action: 'template.edit_failed',
    subjectType: 'template',
    subjectId: row.id,
    result: 'failure',
    metadata: { ...auditMetadata, requestedByUserId: row.editRequestedByUserId },
  });
  return true;
}

export interface TemplateEditWorkerDeps {
  db: Database;
  keyring: Keyring;
  graph: GraphClient;
  clock: Clock;
}

/** `paused`: Meta throttles the account's management calls; nothing was sent (ADR-399). */
export type TemplateEditOutcome = 'done' | 'skipped' | 'retry' | ManagementPaused;

/**
 * Worker: sends the edit of a template whose edit is `sending` (`POST /{template-id}`), paced by
 * Meta's usage header (ADR-399). Meta's `success: true` makes the edit, and Meta's template is then
 * read again by id (`GET /{template-id}`) and stored as Meta reports it; when that read cannot be
 * made, a sync is requested instead and nothing is assumed. A refusal is recorded with Meta's code
 * and message. Only a connection that failed before sending is retried; a lost answer waits for the
 * sync, which finds the content sent in Meta's template or gives up after the window.
 */
export async function processTemplateEdit(
  deps: TemplateEditWorkerDeps,
  scope: TenantScope,
  templateId: string,
): Promise<TemplateEditOutcome> {
  const loaded = await deps.db.run(scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(messageTemplates)
      .where(
        and(eq(messageTemplates.tenantId, scope.tenantId), eq(messageTemplates.id, templateId)),
      );
    if (
      !row ||
      row.editState !== 'sending' ||
      !row.providerTemplateId ||
      !row.editComponents ||
      !row.editRequestedAt
    ) {
      return null;
    }
    const credential = await wabaCredential(
      tx,
      scope.tenantId,
      row.whatsappAccountId,
      deps.keyring,
    );
    return {
      row: {
        ...row,
        providerTemplateId: row.providerTemplateId,
        editComponents: row.editComponents,
        editRequestedAt: row.editRequestedAt,
      },
      credential,
    };
  });
  if (!loaded) return 'skipped';
  const { row, credential } = loaded;
  const fail = (error: string, eventReason: string, audit: Record<string, unknown>) =>
    deps.db.run(scope, (tx) =>
      settleEditFailed(
        tx,
        scope.tenantId,
        row,
        error,
        eventReason,
        'edit',
        audit,
        deps.clock.now(),
      ),
    );
  const defer = async (pausedUntil: Date): Promise<ManagementPaused> => {
    await deps.db.run(scope, (tx) =>
      tx
        .update(messageTemplates)
        .set({ managementDeferredUntil: managementResumeAt(pausedUntil) })
        .where(
          and(
            eq(messageTemplates.tenantId, scope.tenantId),
            eq(messageTemplates.id, templateId),
            eq(messageTemplates.editState, 'sending'),
            eq(messageTemplates.editRequestedAt, row.editRequestedAt),
          ),
        ),
    );
    return { paused: pausedUntil };
  };

  if (!credential) {
    await fail(
      'The WhatsApp account is not connected. Reconnect it and edit the template again.',
      'account not connected',
      { kind: 'not_connected' },
    );
    return 'done';
  }
  if (row.category !== 'MARKETING' && row.category !== 'UTILITY') {
    await fail(
      'Meta now lists this template in a category HyFib cannot edit. Edit it in WhatsApp Manager.',
      `category ${row.category}`,
      { kind: 'unsupported' },
    );
    return 'done';
  }
  const paused = activeManagementPause(credential.managementPausedUntil, deps.clock.now());
  if (paused) return defer(paused);
  const result = await deps.graph.editTemplate(row.providerTemplateId, credential.token, {
    category: row.category,
    components: row.editComponents as Record<string, unknown>[],
  });
  const pausedBy = await noteManagementUsage(deps, scope, credential, result);
  // Meta refused it for now and paused the account: sent again after the pause, no retry spent.
  if (refusedForPause(result, pausedBy)) return defer(pausedBy);
  if (result.ok) {
    // Read Meta's template again, unless the answer paused the account: no further call is made
    // then, and the sync the sweep signals after the pause reads it (ADR-399).
    let remote: RemoteTemplate | null = null;
    if (!pausedBy) {
      const read = await deps.graph.getTemplate(row.providerTemplateId, credential.token);
      await noteManagementUsage(deps, scope, credential, read);
      if (read.ok && read.data.id === row.providerTemplateId) remote = read.data;
    }
    await deps.db.run(scope, async (tx) => {
      const now = deps.clock.now();
      const settled = await settleEditMade(
        tx,
        scope.tenantId,
        row,
        remote,
        'edit',
        remote
          ? `Meta accepted the edit and reports the template as ${remote.status}.`
          : 'Meta accepted the edit; its status is read at the next sync.',
        now,
      );
      if (settled && !remote) await requestSyncTx(tx, scope.tenantId, row.whatsappAccountId, now);
    });
    return 'done';
  }
  if (result.kind === 'retryable' && result.httpStatus === undefined) {
    // The connection failed before the request was sent: safe to try again.
    return 'retry';
  }
  if (result.kind === 'unknown' || result.kind === 'retryable') {
    // Meta may or may not have made the edit; the sync decides from Meta's components.
    await deps.db.run(scope, async (tx) => {
      await tx
        .update(messageTemplates)
        .set({ editError: 'Waiting for Meta to confirm the edit.' })
        .where(
          and(
            eq(messageTemplates.tenantId, scope.tenantId),
            eq(messageTemplates.id, templateId),
            eq(messageTemplates.editState, 'sending'),
            eq(messageTemplates.editRequestedAt, row.editRequestedAt),
          ),
        );
      await requestSyncTx(tx, scope.tenantId, row.whatsappAccountId, deps.clock.now());
    });
    return 'done';
  }
  await deps.db.run(scope, async (tx) => {
    const now = deps.clock.now();
    await settleEditFailed(
      tx,
      scope.tenantId,
      row,
      editRefusalText(result),
      `${result.code ?? result.httpStatus ?? result.kind}: ${(result.detail ?? result.title).slice(0, 900)}`,
      'edit',
      {
        kind: result.kind,
        ...(result.code !== undefined ? { code: result.code } : {}),
      },
      now,
    );
    // Meta refused the token: check the account's access at once (ADR-137).
    if (result.kind === 'auth') {
      await requestAccessCheck(tx, scope.tenantId, row.whatsappAccountId, now);
    }
  });
  return 'done';
}

/**
 * Sync: settles an edit still sending against Meta's listing (`editReconciliation`), in the sync's
 * transaction. `remote` null: Meta no longer lists the template, so the edit cannot have been made.
 */
export async function reconcileTemplateEdit(
  tx: Tx,
  tenantId: string,
  row: typeof messageTemplates.$inferSelect,
  remote: RemoteTemplate | null,
  now: Date,
): Promise<void> {
  if (row.editState !== 'sending' || !row.editRequestedAt || !row.editComponents) return;
  const edit = { ...row, editRequestedAt: row.editRequestedAt };
  if (!remote) {
    await settleEditFailed(
      tx,
      tenantId,
      edit,
      'Meta no longer lists this template, so the edit was not made.',
      'no longer listed by Meta',
      'sync',
      { kind: 'not_listed' },
      now,
    );
    return;
  }
  const outcome = editReconciliation(
    {
      state: row.editState,
      components: row.editComponents,
      requestedAt: row.editRequestedAt,
      deferredUntil: row.managementDeferredUntil,
    },
    remote.category,
    remote.components,
    now,
  );
  if (outcome === 'confirmed') {
    await settleEditMade(
      tx,
      tenantId,
      edit,
      remote,
      'sync',
      'Meta lists the edited content (its answer to the edit was lost).',
      now,
    );
  } else if (outcome === 'unconfirmed') {
    await settleEditFailed(
      tx,
      tenantId,
      edit,
      'HyFib could not confirm the edit: Meta’s template does not show the new content. Check it in WhatsApp Manager, or edit it again.',
      'not confirmed by Meta within the confirmation window',
      'sync',
      { kind: 'unconfirmed' },
      now,
    );
  }
}
