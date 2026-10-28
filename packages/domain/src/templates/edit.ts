import { AppError, uuidv7 } from '@w360/core';
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
  or,
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
import { isRateLimited, type GraphClient, type RemoteTemplate } from '../messaging/graph';
import {
  activeManagementPause,
  assertManagementOpen,
  deferralDelaySeconds,
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
  TEMPLATE_EDIT_CONFIRM_WINDOW_MS,
  TEMPLATE_EDIT_SEND_MARGIN_MS,
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
  /**
   * Campaigns not finished yet that send it, as their own template or a variant's (ADR-405),
   * `running` ones sending it now. A name is null for a member who may not read campaigns (as for
   * automations and stores below).
   */
  campaigns: { id: string | null; name: string | null; status: CampaignStatus }[];
  // An id is null, as the name, for an item the caller may not read (`maskUsage`).
  /** Published automations (active or paused) whose live version has a step sending it. */
  automations: { id: string | null; name: string | null; status: string }[];
  /**
   * Automations with runs in progress (running or waiting) on a version that sends it, whatever
   * version is live now: each run keeps its own version, so they rely on the template too.
   */
  automationRuns: { id: string | null; name: string | null; runs: number }[];
  /** Order message and cart reminder rules of the company's stores that send it. */
  storeRules: { id: string | null; storeName: string | null; event: string; enabled: boolean }[];
}

/**
 * A campaign that sends the template: as its own (variant A) or as a variant's, whose template is
 * in `app.campaign_variants` (ADR-405).
 */
function campaignSends(templateId: string) {
  return or(
    eq(campaigns.templateId, templateId),
    sql`exists (select 1 from app.campaign_variants v
                 where v.tenant_id = ${campaigns.tenantId} and v.campaign_id = ${campaigns.id}
                   and v.template_id = ${templateId}::uuid)`,
  );
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
        campaignSends(templateId),
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
  // Active runs grouped by version first, so each version's graph is tested once, not once per
  // run; the versions that send the template are then summed per automation.
  const runRows = (
    await tx.execute<{ id: string; name: string; runs: number | string }>(sql`
      with versions as (
        select r.version_id, count(*) as runs
          from app.automation_runs r
         where r.tenant_id = ${tenantId} and r.status in ('running', 'waiting')
         group by r.version_id
      ), sending as (
        select v.automation_id, versions.runs
          from versions
          join app.automation_versions v on v.tenant_id = ${tenantId} and v.id = versions.version_id
         where jsonb_path_exists(v.graph, '$.nodes[*] ? (@.templateId == $id)',
                                 jsonb_build_object('id', ${templateId}::text))
      )
      select a.id, a.name, sum(sending.runs)::int as runs
        from sending
        join app.automations a on a.tenant_id = ${tenantId} and a.id = sending.automation_id
       group by a.id, a.name
       order by a.name, a.id
       limit ${USAGE_LIMIT}`)
  ).rows;
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
  return {
    campaigns: campaignRows,
    automations: automationRows,
    automationRuns: runRows.map((r) => ({ id: r.id, name: r.name, runs: Number(r.runs) })),
    storeRules: ruleRows,
  };
}

const STORE_EVENT_NAMES: Record<string, string> = {
  order_placed: 'new order',
  cod_confirmation: 'cash on delivery confirmation',
  order_shipped: 'order shipped',
  order_delivered: 'order delivered',
  order_cancelled: 'order cancelled',
  shipment_created: 'shipment sent',
  tracking_updated: 'tracking updated',
  cart_reminder: 'cart reminder',
  cart_second_reminder: 'second cart reminder',
};

/** Which names a caller may read in a usage list: a member's read permissions, a key's scopes. */
export interface UsageVisibility {
  campaigns: boolean;
  automations: boolean;
  stores: boolean;
}

/**
 * A usage list with the names the caller may not read left out: "a campaign", "an automation",
 * "a store" then stand for them (ADR-404). The Templates page and a refusal both show it so.
 */
export function maskUsage(usage: TemplateUsage, visible: UsageVisibility): TemplateUsage {
  const published = new Set(usage.automations.map((a) => a.id));
  return {
    campaigns: usage.campaigns.map((c) => (visible.campaigns ? c : { ...c, id: null, name: null })),
    automations: usage.automations.map((a) =>
      visible.automations ? a : { ...a, id: null, name: null },
    ),
    // A published automation is not listed again for its runs; that is decided before ids go.
    automationRuns: usage.automationRuns
      .filter((a) => !published.has(a.id))
      .map((a) => (visible.automations ? a : { ...a, id: null, name: null })),
    storeRules: usage.storeRules.map((r) =>
      visible.stores ? r : { ...r, id: null, storeName: null },
    ),
  };
}

/** What uses the template, as a refusal names it ("campaign “Diwali”", …). */
export function usageLabels(usage: TemplateUsage): string[] {
  const published = new Set(usage.automations.flatMap((a) => (a.id ? [a.id] : [])));
  return [
    ...usage.campaigns.map((c) => (c.name ? `campaign “${c.name}”` : 'a campaign')),
    ...usage.automations.map((a) => (a.name ? `automation “${a.name}”` : 'an automation')),
    ...usage.automationRuns
      .filter((a) => a.id === null || !published.has(a.id))
      .map(
        (a) =>
          `${a.name ? `automation “${a.name}”` : 'an automation'} (${a.runs} ${a.runs === 1 ? 'run' : 'runs'} in progress)`,
      ),
    ...usage.storeRules.map(
      (r) =>
        `${r.storeName ? `the ${r.storeName} ` : 'a store’s '}${STORE_EVENT_NAMES[r.event] ?? r.event} message`,
    ),
  ];
}

/**
 * The company's campaigns using the template (as their own or a variant's) that are scheduled or
 * sending, read under a share lock: a runner starting one holds its row, so the edit waits for it,
 * and a campaign that has not started cannot start before the edit's transaction ends.
 */
async function sendingCampaigns(tx: Tx, tenantId: string, templateId: string) {
  return tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.tenantId, tenantId),
        campaignSends(templateId),
        inArray(campaigns.status, [...SENDING_CAMPAIGN_STATUSES]),
      ),
    )
    .for('share');
}

/**
 * Sends a locked template Meta has an edit, as the Templates page and the API do (ADR-404): the
 * content is checked as the editor checks drafts (422), the edit as `templateEditRefusal` decides
 * (campaigns scheduled or sending, and what still sends the template when its variables or buttons
 * change), for a connected account (412) Meta is not throttling (503). Written ahead: the template
 * records a new edit id, the content sent, when (the database's time), by whom (`actorUserId`,
 * null for a key) and `edit_state = 'sending'`, with an `edit_requested` status change, before the
 * `template.edit` job is queued with the edit's id. Its status, category and content stay what
 * Meta reports until Meta answers.
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
  /** The names the caller may read, for a refusal that names what uses the template. */
  visible: UsageVisibility,
  /** The company's time zone, for the time a pause ends (the API, which has none, gives UTC). */
  timeZone = 'UTC',
): Promise<void> {
  const issues = validateDefinition(definition);
  if (issues.length > 0) {
    throw new AppError('validation_failed', issues[0]?.message ?? 'Invalid template', { issues });
  }
  const refusal = await templateEditRefusal(row, definition, {
    sendingCampaigns: (await sendingCampaigns(tx, tenantId, row.id)).length,
    users: async () => usageLabels(maskUsage(await templateUsage(tx, tenantId, row.id), visible)),
  });
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
  const editId = uuidv7();
  await tx
    .update(messageTemplates)
    .set({
      editId,
      editState: 'sending',
      editComponents: request.components,
      editError: null,
      // The database's time: the window that gives up on it is judged on the database's clock.
      editRequestedAt: sql`now()`,
      editRequestedByUserId: actorUserId,
      editAttemptedAt: null,
      editFailedAt: null,
      // A new request: an earlier deferral for a pause no longer applies (ADR-399).
      managementDeferredUntil: null,
      version: sql`${messageTemplates.version} + 1`,
    })
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, row.id)));
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
    templateEditRef(row.id, editId),
    `${row.id}:edit:${editId}`,
  );
}

/** A `template.edit` job's reference: the template and the edit it sends. */
export function templateEditRef(templateId: string, editId: string): string {
  return `${templateId}:${editId}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The template and edit a `template.edit` job's reference names, or null for any other text. */
export function parseTemplateEditRef(ref: string): { templateId: string; editId: string } | null {
  const [templateId, editId, ...rest] = ref.split(':');
  if (rest.length > 0 || !templateId || !editId) return null;
  return UUID_RE.test(templateId) && UUID_RE.test(editId) ? { templateId, editId } : null;
}

/** The edit columns cleared once an edit is settled as made. */
const EDIT_CLEARED = {
  editId: null,
  editState: null,
  editComponents: null,
  editError: null,
  editRequestedAt: null,
  editRequestedByUserId: null,
  editAttemptedAt: null,
  editFailedAt: null,
  managementDeferredUntil: null,
} as const;

const knownCategory = (category: string) =>
  category === 'MARKETING' || category === 'UTILITY' || category === 'AUTHENTICATION'
    ? category
    : null;

/** The open edit a settle applies to: its template, its id, and who asked. */
interface EditRef {
  id: string;
  name: string;
  language: string;
  editId: string;
  editRequestedByUserId: string | null;
}

/**
 * Locks the template and gives its status and edit state now, when its open edit is still `editId`
 * in one of `states`; null otherwise (another edit, or none).
 */
async function lockOpenEdit(
  tx: Tx,
  tenantId: string,
  templateId: string,
  editId: string,
  states: readonly ('sending' | 'failed')[],
) {
  const [current] = await tx
    .select({ status: messageTemplates.status, editState: messageTemplates.editState })
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.tenantId, tenantId),
        eq(messageTemplates.id, templateId),
        eq(messageTemplates.editId, editId),
        inArray(messageTemplates.editState, [...states]),
      ),
    )
    .for('update');
  return current ?? null;
}

/**
 * Settles an edit as made, in the caller's transaction: the edit columns are cleared and, when
 * Meta's template was read, its status, category and components stored as Meta reports them;
 * the status history gets an `edited` change naming the member who asked, and one for the status
 * Meta reports when it differs from the status stored now (the row is locked first, so a sync in
 * between is not repeated); the audit log a `template.edited` entry. False when the open edit is
 * no longer this one in one of `states`.
 */
async function settleEditMade(
  tx: Tx,
  tenantId: string,
  row: EditRef,
  remote: RemoteTemplate | null,
  source: 'edit' | 'sync',
  reason: string,
  states: readonly ('sending' | 'failed')[],
  at: Date,
): Promise<boolean> {
  const current = await lockOpenEdit(tx, tenantId, row.id, row.editId, states);
  if (!current) return false;
  const status = remote ? mapProviderTemplateStatus(remote.status) : null;
  const category = remote ? knownCategory(remote.category) : null;
  const components =
    remote && JSON.stringify(remote.components).length <= 30_000 ? remote.components : null;
  await tx
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
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, row.id)));
  await insertStatusEvent(tx, tenantId, {
    templateId: row.id,
    status: 'edited',
    reason,
    source,
    actorUserId: row.editRequestedByUserId,
    at,
  });
  if (status && status !== current.status) {
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
 * Settles a sending edit as failed, in the caller's transaction: `failed` with the reason members
 * read, the content kept so it can be changed and sent again (and so a sync can still confirm it,
 * should Meta apply it late), an `edit_failed` status change and a `template.edit_failed` audit
 * entry. False when the open edit is no longer this one, sending.
 */
async function settleEditFailed(
  tx: Tx,
  tenantId: string,
  row: EditRef,
  error: string,
  eventReason: string,
  source: 'edit' | 'sync',
  auditMetadata: Record<string, unknown>,
  at: Date,
): Promise<boolean> {
  if (!(await lockOpenEdit(tx, tenantId, row.id, row.editId, ['sending']))) return false;
  await tx
    .update(messageTemplates)
    .set({
      editState: 'failed',
      editError: error.slice(0, 1000),
      editFailedAt: sql`now()`,
      managementDeferredUntil: null,
    })
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, row.id)));
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

/** The database's time, in milliseconds (a computed value is read as a number, not a column). */
export async function databaseNow(tx: Tx): Promise<Date> {
  const res = await tx.execute<{ ms: number | string }>(
    sql`select (extract(epoch from now()) * 1000)::float8 as ms`,
  );
  return new Date(Number(res.rows[0]?.ms));
}

export interface TemplateEditWorkerDeps {
  db: Database;
  keyring: Keyring;
  graph: GraphClient;
  clock: Clock;
}

/** `paused`: Meta throttles the account's management calls; nothing was sent (ADR-399). */
export type TemplateEditOutcome = 'done' | 'skipped' | 'retry' | ManagementPaused;

const UNSENT_IN_TIME =
  'HyFib could not send the edit to Meta within 10 minutes of the request. Send it again.';

/**
 * Worker: sends the edit its reference names (`POST /{template-id}`), at most once, paced by
 * Meta's usage header (ADR-399). Nothing happens unless the template's open edit is still that
 * edit and `sending`. Before the request the job commits `edit_attempted_at` in its own
 * transaction, and only while the window has a minute left (the database's clock); a job run again
 * after an attempt (a retry after a crash, an expired job) sends nothing and asks for a sync, which
 * confirms the edit from Meta's components or gives up after the window; a job too late settles
 * the edit as not sent. Meta's `success: true` makes the edit, and Meta's template is then read
 * again by id (`GET /{template-id}`) and stored as Meta reports it; when that read cannot be made,
 * a sync is requested instead and nothing is assumed. A refusal is recorded with Meta's code and
 * message. Only an answer that proves Meta did nothing clears the attempt before a retry or a
 * deferral: a connection that failed before sending, and a rate limit (HTTP 429 or a rate-limit
 * code). Any other retryable answer (5xx, codes 1, 2, 131000) may have done the work: the attempt
 * stays, and the sync settles it, after the pause when that answer paused the account.
 */
export async function processTemplateEdit(
  deps: TemplateEditWorkerDeps,
  scope: TenantScope,
  ref: string,
): Promise<TemplateEditOutcome> {
  const target = parseTemplateEditRef(ref);
  if (!target) return 'skipped';
  const { templateId, editId } = target;
  const loaded = await deps.db.run(scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(messageTemplates)
      .where(
        and(eq(messageTemplates.tenantId, scope.tenantId), eq(messageTemplates.id, templateId)),
      );
    if (
      !row ||
      row.editId !== editId ||
      row.editState !== 'sending' ||
      !row.providerTemplateId ||
      !row.editComponents
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
        editId,
        providerTemplateId: row.providerTemplateId,
        editComponents: row.editComponents,
      },
      credential,
    };
  });
  if (!loaded) return 'skipped';
  const { row, credential } = loaded;
  const thisEdit = and(
    eq(messageTemplates.tenantId, scope.tenantId),
    eq(messageTemplates.id, templateId),
    eq(messageTemplates.editId, editId),
    eq(messageTemplates.editState, 'sending'),
  );
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
  const requestSync = () =>
    deps.db.run(scope, (tx) =>
      requestSyncTx(tx, scope.tenantId, row.whatsappAccountId, deps.clock.now()),
    );
  /** Meta has nothing of this attempt: a later run may send it. */
  const clearAttempt = () =>
    deps.db.run(scope, (tx) =>
      tx.update(messageTemplates).set({ editAttemptedAt: null }).where(thisEdit),
    );
  /**
   * Defers the job for Meta's pause. The deferral is stored on the database's clock (the window is
   * judged on it): the database's now plus the wait this worker's clock sees. `clear`: Meta has
   * nothing of the attempt, so it is cleared for the run after the pause.
   */
  const defer = async (pausedUntil: Date, clear: boolean): Promise<ManagementPaused> => {
    const wait = deferralDelaySeconds(pausedUntil, deps.clock.now());
    await deps.db.run(scope, (tx) =>
      tx
        .update(messageTemplates)
        .set({
          managementDeferredUntil: sql`now() + make_interval(secs => ${wait})`,
          ...(clear ? { editAttemptedAt: null } : {}),
        })
        .where(thisEdit),
    );
    return { paused: pausedUntil };
  };

  if (row.editAttemptedAt) {
    // An earlier run may have reached Meta: never sent twice; the sync settles it.
    await requestSync();
    return 'done';
  }
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
  if (paused) return defer(paused, false);

  // The one attempt, committed before the request, while the window has a minute left.
  const attempt = await deps.db.run(scope, async (tx) => {
    const marked = await tx
      .update(messageTemplates)
      .set({ editAttemptedAt: sql`now()` })
      .where(
        and(
          thisEdit,
          sql`${messageTemplates.editAttemptedAt} is null`,
          sql`greatest(${messageTemplates.editRequestedAt}, coalesce(${messageTemplates.managementDeferredUntil}, ${messageTemplates.editRequestedAt})) > now() - make_interval(secs => ${(TEMPLATE_EDIT_CONFIRM_WINDOW_MS - TEMPLATE_EDIT_SEND_MARGIN_MS) / 1000})`,
        ),
      )
      .returning({ id: messageTemplates.id });
    if (marked.length > 0) return 'marked' as const;
    const [now] = await tx
      .select({ attemptedAt: messageTemplates.editAttemptedAt })
      .from(messageTemplates)
      .where(thisEdit);
    if (!now) return 'gone' as const;
    return now.attemptedAt ? ('attempted' as const) : ('late' as const);
  });
  if (attempt === 'gone') return 'skipped';
  if (attempt === 'attempted') {
    await requestSync();
    return 'done';
  }
  if (attempt === 'late') {
    await fail(UNSENT_IN_TIME, 'not sent within the confirmation window', { kind: 'not_sent' });
    return 'done';
  }

  const result = await deps.graph.editTemplate(row.providerTemplateId, credential.token, {
    category: row.category,
    components: row.editComponents as Record<string, unknown>[],
  });
  const pausedBy = await noteManagementUsage(deps, scope, credential, result);
  // Rate limited: Meta did nothing, so it is sent again after the pause (no retry spent) or, when
  // the answer paused nothing, retried.
  if (!result.ok && isRateLimited(result)) {
    if (pausedBy) return defer(pausedBy, true);
    await clearAttempt();
    return 'retry';
  }
  if (refusedForPause(result, pausedBy)) {
    // Another retryable answer that paused the account: Meta may have made the edit. The attempt
    // stays; the sync after the pause settles it from Meta's components.
    await deps.db.run(scope, async (tx) => {
      await tx
        .update(messageTemplates)
        .set({ editError: 'Waiting for Meta to confirm the edit.' })
        .where(thisEdit);
      await requestSyncTx(tx, scope.tenantId, row.whatsappAccountId, deps.clock.now());
    });
    return defer(pausedBy, false);
  }
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
        ['sending', 'failed'],
        now,
      );
      if (settled && !remote) await requestSyncTx(tx, scope.tenantId, row.whatsappAccountId, now);
    });
    return 'done';
  }
  if (result.kind === 'retryable' && result.httpStatus === undefined) {
    // The connection failed before the request was sent: Meta has nothing, safe to try again.
    await clearAttempt();
    return 'retry';
  }
  if (result.kind === 'unknown' || result.kind === 'retryable') {
    // Meta may or may not have made the edit; the sync decides from Meta's components.
    await deps.db.run(scope, async (tx) => {
      await tx
        .update(messageTemplates)
        .set({ editError: 'Waiting for Meta to confirm the edit.' })
        .where(thisEdit);
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
 * Sync: settles an open edit against Meta's listing (`editReconciliation`), in the sync's
 * transaction, the window judged on the database's time (`dbNow`). A sending or failed edit whose
 * content Meta's template shows is made; a sending one without it fails after the window.
 * `remote` null: Meta no longer lists the template, so a sending edit cannot have been made.
 */
export async function reconcileTemplateEdit(
  tx: Tx,
  tenantId: string,
  row: typeof messageTemplates.$inferSelect,
  remote: RemoteTemplate | null,
  now: Date,
  dbNow: Date,
): Promise<void> {
  if (!row.editState || !row.editId || !row.editRequestedAt || !row.editComponents) return;
  const edit = { ...row, editId: row.editId };
  if (!remote) {
    if (row.editState !== 'sending') return;
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
    dbNow,
  );
  if (outcome === 'confirmed') {
    await settleEditMade(
      tx,
      tenantId,
      edit,
      remote,
      'sync',
      row.editState === 'failed'
        ? 'Meta lists the edited content after the edit was reported as failed.'
        : 'Meta lists the edited content (its answer to the edit was lost).',
      ['sending', 'failed'],
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
