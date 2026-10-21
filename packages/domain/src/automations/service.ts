import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, forbidden, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  apiKeys,
  asc,
  automationRunSteps,
  automationHttpCalls,
  automationEnrollments,
  automationRuns,
  automationVersions,
  automations,
  channelAccounts,
  commerceCatalogs,
  commerceProducts,
  commerceStoreMessageRules,
  commerceStoreOrders,
  commerceStores,
  contactFields,
  conversations,
  flows,
  desc,
  eq,
  gte,
  httpAllowedDomains,
  httpSecrets,
  inArray,
  isNull,
  memberships,
  messageTemplates,
  ne,
  sql,
  teams,
  users,
  type AutomationStatus,
  type Database,
  type HttpCallState,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { shownNumber } from '../contacts/number-masking';
import { recordAudit, type RequestMeta } from '../audit';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from '../messaging/events';
import { canSeeConversation, SERVICE_WINDOW_MS } from '../messaging/outbound';
import { STORE_MESSAGE_EVENT_INFO } from '../stores/messages-model';
import { linkButtons, renderPlaceholders, sendSpecFor } from '../templates/definition';
import { parseInput } from '../validation';
import { CSV_BOM, csvLine } from '../contacts/csv';
import { crmMembers } from '../crm/common';
import { loadPipelines } from '../crm/pipelines';
import { loadDealFields } from '../crm/deal-fields';
import { SENDABLE_STATUSES } from '../flows/service';
import { RUN_CSV_COLUMNS, runCsvLine, type RunCsvRow } from './runs-csv';
import {
  apiInputValues,
  canonicalJson,
  checkGraph,
  describeTrigger,
  parseGraph,
  parseTrigger,
  productsOf,
  PRODUCT_PICKER_LIMIT,
  starterGraph,
  starterTrigger,
  templatesOf,
  usesDealConditions,
  triggerIssues,
  type AutomationGraph,
  type AutomationTrigger,
  type GraphIssue,
  type GraphReferences,
  type TemplateReference,
} from './graph';
import { appendRunStep, endRun, endRunForHuman, lockActiveRun, signalAutomationRun } from './runs';
import { assertLiveAutomationAvailable, assertModule } from '../plans/entitlements';

/**
 * Automations for the web tier. Drafts are edited freely (`automations.write`); publishing
 * (`automations.publish`) checks the draft and freezes it into a numbered, immutable version that
 * new runs use, while runs in progress keep the version they started with. Pausing stops new runs;
 * archiving also stops runs in progress. Test runs execute a snapshot of the draft on a
 * conversation the member can see, sending real messages there.
 */
export interface AutomationServiceDeps {
  db: Database;
  clock: Clock;
  jobs: JobQueue;
  signer: JobSigner;
  /** http:// addresses in HTTP steps, for local test targets only (from configuration). */
  allowInsecureHttp?: boolean;
}

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name the automation.')
  .max(80, 'Names are limited to 80 characters.');
const descriptionSchema = z
  .string()
  .trim()
  .max(300, 'Descriptions are limited to 300 characters.')
  .nullable()
  .transform((v) => (v ? v : null));

const createSchema = z.object({ name: nameSchema, description: descriptionSchema.default(null) });
const idSchema = z.object({ id: z.uuid(), expectedVersion: z.number().int().min(0) });
const updateSchema = idSchema.extend({
  name: nameSchema,
  description: descriptionSchema,
  channelAccountId: z.uuid().nullable(),
  trigger: z.unknown(),
  graph: z.unknown(),
});
const publishSchema = idSchema.extend({
  note: z
    .string()
    .trim()
    .max(300, 'Notes are limited to 300 characters.')
    .nullable()
    .transform((v) => (v ? v : null)),
});
const statusSchema = idSchema.extend({ status: z.enum(['active', 'paused']) });
const testRunSchema = idSchema.extend({
  conversationId: z.uuid(),
  /** The order a test of an automation started by order messages reads (ADR-050). */
  storeOrderId: z.uuid().nullable().default(null),
  /** The inputs a test of an automation started through the API gives (ADR-077). */
  inputs: z.record(z.string(), z.unknown()).optional(),
});
const listRunsSchema = z.object({
  automationId: z.uuid().optional(),
  status: z
    .enum(['active', 'completed', 'handed_off', 'taken_over', 'stopped', 'failed'])
    .optional(),
  cursor: z.string().max(200).optional(),
});

/** A runs export's filters, as the list's (ADR-237). */
const exportRunsSchema = listRunsSchema.omit({ cursor: true });
/** Runs one batch of an export reads (ADR-237). */
const RUN_EXPORT_BATCH = 500;

export interface AutomationSummary {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  trigger: string | null;
  channelName: string | null;
  activeVersion: number | null;
  draftChanged: boolean;
  updatedAt: string;
  activeRuns: number;
  runsLast7Days: number;
}

export interface AutomationDetail {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  version: number;
  draft: {
    trigger: AutomationTrigger | null;
    graph: AutomationGraph | null;
    channelAccountId: string | null;
    updatedAt: string;
    updatedByName: string | null;
  };
  issues: GraphIssue[];
  draftChanged: boolean;
  activeVersion: { id: string; number: number; createdAt: string } | null;
  versions: {
    id: string;
    number: number;
    note: string | null;
    createdAt: string;
    createdByName: string | null;
    active: boolean;
  }[];
  /** Store rules that start this automation (members with `commerce.read`; null otherwise). */
  usedBy:
    { storeId: string; storeName: string; event: string; label: string; enabled: boolean }[] | null;
  options: {
    channels: { id: string; name: string; active: boolean; whatsappAccountId: string }[];
    /** The company's templates, for template steps (HyFib sends approved utility or marketing ones). */
    templates: AutomationTemplateOption[];
    teams: { id: string; name: string }[];
    /** Active members who can use the CRM, whom task steps may create tasks for (ADR-244). */
    crmMembers: { id: string; name: string }[];
    /** Active pipelines with their currency and active stages, for deal steps (ADR-245). */
    crmPipelines: AutomationPipelineOption[];
    /** The company's custom deal fields, oldest first, for steps that set them (ADR-386). */
    dealFields: AutomationDealFieldOption[];
    /** The company's forms that are not archived, for form steps (ADR-248). */
    flows: AutomationFlowOption[];
    /**
     * Products of the company's connected catalogs, for products steps (ADR-383): the first
     * `PRODUCT_PICKER_LIMIT` of each catalog by name and those the draft's steps send. Null for a
     * member who cannot see the catalogs (`commerce.read`).
     */
    products: AutomationProductOption[] | null;
    fields: { key: string; label: string; type: string }[];
    /** Domains HTTP steps may call, and the secrets they may use (never their values). */
    allowedDomains: string[];
    secrets: { name: string; domain: string }[];
    allowInsecureHttp: boolean;
  };
}

/** Steps that write to the CRM (ADR-244, ADR-245, ADR-250, ADR-251, ADR-386). */
const CRM_NODE_TYPES: ReadonlySet<string> = new Set([
  'create_task',
  'create_deal',
  'move_deal',
  'close_deal',
  'update_deal_fields',
]);

/** A custom deal field a step may set (ADR-386), with a choice field's options. */
export interface AutomationDealFieldOption {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'choice';
  options: string[] | null;
}

/** A form a form step may send (ADR-248): only one published at Meta can be sent. */
export interface AutomationFlowOption {
  id: string;
  name: string;
  whatsappAccountId: string;
  sendable: boolean;
}

/** A product of a connected catalog a products step may send (ADR-383). */
export interface AutomationProductOption {
  id: string;
  name: string;
  retailerId: string;
  priceText: string | null;
  catalogId: string;
  catalogName: string | null;
  whatsappAccountId: string;
}

/** An active pipeline a deal step may create deals in, with its active stages (ADR-245). */
export interface AutomationPipelineOption {
  id: string;
  name: string;
  currency: string;
  stages: { id: string; name: string }[];
}

export interface AutomationTemplateOption extends TemplateReference {
  id: string;
  language: string;
  /** The template's texts with their {{n}} markers (the simulator fills them in). */
  preview: { header: string | null; body: string; footer: string | null } | null;
}

export interface RunSummary {
  id: string;
  automationId: string;
  automationName: string;
  versionNumber: number | null;
  mode: 'live' | 'test';
  status: string;
  endReason: string | null;
  triggerType: string;
  /** The members' enrolment that started the run (ADR-401), or null. */
  enrollmentId: string | null;
  startedAt: string;
  endedAt: string | null;
  steps: number;
  messages: number;
  /** Present when the member can open the conversation. */
  conversationId: string | null;
}

export interface RunDetail extends RunSummary {
  currentNodeId: string | null;
  waitingFor: 'reply' | 'timer' | 'http' | null;
  /** A message the run queued is waiting for Meta's acceptance (the run holds until then). */
  sending: boolean;
  waitUntil: string | null;
  endDetail: string | null;
  endedByName: string | null;
  startedByName: string | null;
  /** The order event that started the run (runs started by order messages). */
  storeEvent: string | null;
  /** The name of the API key that started the run (runs started through the API). */
  apiKeyName: string | null;
  /** The member whose enrolment started the run (ADR-401); null for other runs. */
  enrolledByName: string | null;
  /** The API key whose enrolment started the run (ADR-403); null for other runs. */
  enrolledByKeyName: string | null;
  /** The order the run reads (members with `commerce.read`; null when none or gone). */
  order: { id: string; name: string; storeName: string } | null;
  graph: AutomationGraph | null;
  /** Answers the run captured; only for members who can see the conversation. */
  variables: Record<string, string> | null;
  log: {
    seq: number;
    nodeId: string | null;
    nodeType: string | null;
    outcome: string;
    branch: string | null;
    detail: string | null;
    messageId: string | null;
    createdAt: string;
  }[];
  /**
   * The run's web requests: what was called (host and path, without the query) and the outcome.
   * Requests and saved values are not shown (saved values appear among the answers).
   */
  httpCalls: {
    id: string;
    nodeId: string;
    method: string;
    host: string;
    path: string;
    state: HttpCallState;
    statusCode: number | null;
    errorCode: string | null;
    durationMs: number | null;
    /**
     * Answers the call left out for safety, by name, with the reason (ADR-406): `refused_header`,
     * `secret_header`, `echoed_secret` or `possible_cut_echo`. Names only, never values.
     */
    droppedValues: Record<string, string>;
    createdAt: string;
    finishedAt: string | null;
  }[];
}

export interface ConversationAutomationState {
  runId: string;
  automationId: string;
  automationName: string;
  mode: 'live' | 'test';
  status: 'running' | 'waiting';
  waitingFor: 'reply' | 'timer' | 'http' | null;
  waitUntil: string | null;
  /** A message the run queued is waiting for Meta's acceptance. */
  sending: boolean;
  startedAt: string;
}

function definitionSha(input: {
  trigger: unknown;
  graph: unknown;
  channelAccountId: string | null;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime()) || !id || !z.uuid().safeParse(id).success) {
    throw new AppError('validation_failed', 'Invalid cursor.');
  }
  return { at, id };
}

const RUN_PAGE = 50;

type TemplateRow = Pick<
  typeof messageTemplates.$inferSelect,
  'id' | 'name' | 'language' | 'category' | 'status' | 'whatsappAccountId' | 'components'
>;

/** What the graph checks and the builder need to know about a template (its latest synced copy). */
function templateOption(t: TemplateRow): AutomationTemplateOption {
  const spec = sendSpecFor(t.category, t.components);
  const preview = spec.supported ? renderPlaceholders(spec.definition) : null;
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    whatsappAccountId: t.whatsappAccountId,
    unsupported: spec.supported ? null : spec.reason,
    headerParams: spec.supported ? spec.headerParams : 0,
    bodyParams: spec.supported ? spec.bodyParams : 0,
    links: spec.supported ? linkButtons(spec.definition) : [],
    quickReplies: spec.supported
      ? spec.definition.buttons.flatMap((b, index) =>
          b.type === 'QUICK_REPLY' ? [{ index, title: b.text }] : [],
        )
      : [],
    preview: preview
      ? { header: preview.header, body: preview.body, footer: preview.footer }
      : null,
  };
}

/** The active run of a conversation, for the inbox. */
export async function automationStateForConversation(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<ConversationAutomationState | null> {
  const [row] = await tx
    .select({
      runId: automationRuns.id,
      automationId: automationRuns.automationId,
      automationName: automations.name,
      mode: automationRuns.mode,
      status: automationRuns.status,
      waitingFor: automationRuns.waitingFor,
      waitUntil: automationRuns.waitUntil,
      pendingMessageId: automationRuns.pendingMessageId,
      startedAt: automationRuns.startedAt,
    })
    .from(automationRuns)
    .innerJoin(
      automations,
      and(
        eq(automations.tenantId, automationRuns.tenantId),
        eq(automations.id, automationRuns.automationId),
      ),
    )
    .where(
      and(
        eq(automationRuns.tenantId, tenantId),
        eq(automationRuns.conversationId, conversationId),
        inArray(automationRuns.status, ['running', 'waiting']),
      ),
    );
  if (!row) return null;
  return {
    runId: row.runId,
    automationId: row.automationId,
    automationName: row.automationName,
    mode: row.mode,
    status: row.status as 'running' | 'waiting',
    waitingFor: row.waitingFor,
    waitUntil: row.waitUntil?.toISOString() ?? null,
    sending: row.pendingMessageId !== null,
    startedAt: row.startedAt.toISOString(),
  };
}

export function createAutomationService(deps: AutomationServiceDeps) {
  const { db, clock } = deps;

  const stale = () =>
    new AppError(
      'conflict',
      'Someone else changed this automation. Reload to see the latest version, then try again.',
    );

  async function lockAutomation(tx: Tx, ctx: TenantContext, id: string, expectedVersion?: number) {
    const [row] = await tx
      .select()
      .from(automations)
      .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, id)))
      .for('update');
    if (!row) throw notFound('Automation');
    if (expectedVersion !== undefined && row.version !== expectedVersion) throw stale();
    return row;
  }

  /**
   * Products of connected catalogs (not removed): those `ids` names and, for the builder's
   * picker, the first `PRODUCT_PICKER_LIMIT` of each catalog by name (ADR-383), so every
   * catalog is listed however many products the others hold.
   */
  async function productOptions(
    tx: Tx,
    tenantId: string,
    ids: readonly string[],
    picker: boolean,
  ): Promise<AutomationProductOption[]> {
    const select = () =>
      tx
        .select({
          id: commerceProducts.id,
          name: commerceProducts.name,
          retailerId: commerceProducts.retailerId,
          priceText: commerceProducts.priceText,
          catalogId: commerceCatalogs.id,
          catalogName: commerceCatalogs.name,
          whatsappAccountId: commerceCatalogs.whatsappAccountId,
        })
        .from(commerceProducts)
        .innerJoin(
          commerceCatalogs,
          and(
            eq(commerceCatalogs.tenantId, commerceProducts.tenantId),
            eq(commerceCatalogs.id, commerceProducts.catalogId),
          ),
        );
    const live = and(
      eq(commerceProducts.tenantId, tenantId),
      isNull(commerceProducts.removedAt),
      isNull(commerceCatalogs.disconnectedAt),
    );
    const catalogs = picker
      ? await tx
          .select({ id: commerceCatalogs.id })
          .from(commerceCatalogs)
          .where(
            and(eq(commerceCatalogs.tenantId, tenantId), isNull(commerceCatalogs.disconnectedAt)),
          )
          .orderBy(asc(commerceCatalogs.name), asc(commerceCatalogs.id))
      : [];
    const listed: AutomationProductOption[] = [];
    for (const catalog of catalogs) {
      listed.push(
        ...(await select()
          .where(and(live, eq(commerceProducts.catalogId, catalog.id)))
          .orderBy(asc(commerceProducts.name), asc(commerceProducts.id))
          .limit(PRODUCT_PICKER_LIMIT)),
      );
    }
    const missing = ids.filter((id) => !listed.some((p) => p.id === id));
    const named =
      missing.length > 0
        ? await select().where(and(live, inArray(commerceProducts.id, missing)))
        : [];
    return [...listed, ...named];
  }

  async function references(
    tx: Tx,
    tenantId: string,
    products: { ids: readonly string[]; picker: boolean } = { ids: [], picker: false },
  ) {
    const teamRows = await tx
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.tenantId, tenantId))
      .orderBy(asc(sql`lower(${teams.name})`));
    const fieldRows = await tx
      .select({ key: contactFields.key, label: contactFields.label, type: contactFields.type })
      .from(contactFields)
      .where(eq(contactFields.tenantId, tenantId))
      .orderBy(asc(contactFields.label));
    const domainRows = await tx
      .select({ domain: httpAllowedDomains.domain })
      .from(httpAllowedDomains)
      .where(eq(httpAllowedDomains.tenantId, tenantId))
      .orderBy(asc(httpAllowedDomains.domain));
    const secretRows = await tx
      .select({ name: httpSecrets.name, domain: httpSecrets.domain })
      .from(httpSecrets)
      .where(eq(httpSecrets.tenantId, tenantId))
      .orderBy(asc(httpSecrets.name));
    const templateRows = await tx
      .select({
        id: messageTemplates.id,
        name: messageTemplates.name,
        language: messageTemplates.language,
        category: messageTemplates.category,
        status: messageTemplates.status,
        whatsappAccountId: messageTemplates.whatsappAccountId,
        components: messageTemplates.components,
      })
      .from(messageTemplates)
      .where(eq(messageTemplates.tenantId, tenantId))
      .orderBy(asc(messageTemplates.name), asc(messageTemplates.language));
    return {
      teamRows,
      fieldRows,
      crmMembers: (await crmMembers(tx, tenantId)).map((m) => ({
        id: m.membershipId,
        name: m.name,
      })),
      flows: (
        await tx
          .select({
            id: flows.id,
            name: flows.name,
            whatsappAccountId: flows.whatsappAccountId,
            metaFlowId: flows.metaFlowId,
            metaStatus: flows.metaStatus,
          })
          .from(flows)
          .where(and(eq(flows.tenantId, tenantId), isNull(flows.archivedAt)))
          .orderBy(asc(sql`lower(${flows.name})`))
      ).map((f): AutomationFlowOption => ({
        id: f.id,
        name: f.name,
        whatsappAccountId: f.whatsappAccountId,
        sendable:
          f.metaFlowId !== null &&
          f.metaStatus !== null &&
          SENDABLE_STATUSES.includes(f.metaStatus),
      })),
      crmPipelines: (await loadPipelines(tx, tenantId, { includeArchived: false })).map(
        (p): AutomationPipelineOption => ({
          id: p.id,
          name: p.name,
          currency: p.currency,
          stages: p.stages.filter((st) => !st.archived).map((st) => ({ id: st.id, name: st.name })),
        }),
      ),
      dealFields: (await loadDealFields(tx, tenantId)).map((f): AutomationDealFieldOption => ({
        key: f.key,
        label: f.label,
        type: f.type,
        options: f.options,
      })),
      domains: domainRows.map((d) => d.domain),
      secrets: secretRows,
      templates: templateRows.map(templateOption),
      products: await productOptions(tx, tenantId, products.ids, products.picker),
    };
  }

  /**
   * What a graph may refer to in this company (teams, fields, HTTP domains and secrets, templates),
   * and what its automation allows: order fields and the reply rule when it starts from order
   * messages, the trigger's inputs and the reply rule when it starts through the API, templates of
   * its number's WhatsApp account when it is limited to one.
   */
  function graphRefs(
    refs: Awaited<ReturnType<typeof references>>,
    context: { trigger: AutomationTrigger | null; channelWhatsappAccountId: string | null },
  ): GraphReferences {
    return {
      teamIds: new Set(refs.teamRows.map((t) => t.id)),
      crmMemberIds: new Set(refs.crmMembers.map((m) => m.id)),
      flows: new Map(
        refs.flows.map((f) => [
          f.id,
          { whatsappAccountId: f.whatsappAccountId, sendable: f.sendable },
        ]),
      ),
      crmPipelines: new Map(
        refs.crmPipelines.map((p) => [
          p.id,
          { currency: p.currency, stageIds: new Set(p.stages.map((st) => st.id)) },
        ]),
      ),
      products: new Map(
        refs.products.map((p) => [
          p.id,
          { catalogId: p.catalogId, whatsappAccountId: p.whatsappAccountId },
        ]),
      ),
      fieldKeys: new Set(refs.fieldRows.map((f) => f.key)),
      dealFields: new Map(refs.dealFields.map((f) => [f.key, f])),
      allowedDomains: refs.domains,
      secrets: new Map(refs.secrets.map((r) => [r.name, r.domain])),
      allowInsecureHttp: deps.allowInsecureHttp ?? false,
      templates: new Map(refs.templates.map((t) => [t.id, t])),
      storeEvent: context.trigger?.type === 'store_event',
      apiInputs: context.trigger?.type === 'api' ? new Set(context.trigger.inputs) : undefined,
      channelWhatsappAccountId: context.channelWhatsappAccountId,
    };
  }

  /** The WhatsApp account of an automation's number (null: any number, or it is gone). */
  async function channelAccountOf(tx: Tx, tenantId: string, channelAccountId: string | null) {
    if (!channelAccountId) return null;
    const [channel] = await tx
      .select({ whatsappAccountId: channelAccounts.whatsappAccountId })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.id, channelAccountId)));
    return channel ?? null;
  }

  /**
   * Publishing or testing a graph that sends marketing templates needs `campaigns.send`, as a
   * store rule or a template send does (ADR-050).
   */
  async function assertMayUseTemplates(
    tx: Tx,
    ctx: TenantContext,
    graph: AutomationGraph,
    action: 'publish' | 'test',
  ) {
    const ids = templatesOf(graph);
    if (ids.length === 0 || can(ctx, 'campaigns.send')) return;
    const [marketing] = await tx
      .select({ id: messageTemplates.id })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.tenantId, ctx.tenant.id),
          inArray(messageTemplates.id, ids),
          eq(messageTemplates.category, 'MARKETING'),
        ),
      )
      .limit(1);
    if (marketing) {
      throw forbidden(
        `${action === 'publish' ? 'Publishing' : 'Testing'} an automation that sends marketing templates needs the campaign sending permission.`,
      );
    }
  }

  /**
   * Publishing or testing a graph that creates CRM tasks or deals, or moves, closes or updates
   * deals, needs the CRM in the company's plan (ADR-249) and `crm.write`, as doing so in the CRM
   * does (ADR-244, ADR-245, ADR-250, ADR-251, ADR-386).
   */
  function assertMayChangeCrm(
    ctx: TenantContext,
    graph: AutomationGraph,
    action: 'publish' | 'test',
  ) {
    if (!graph.nodes.some((n) => CRM_NODE_TYPES.has(n.type))) return;
    assertModule(ctx.plan, 'crm');
    if (can(ctx, 'crm.write')) return;
    throw forbidden(
      `${action === 'publish' ? 'Publishing' : 'Testing'} an automation that changes the CRM needs the permission to edit the CRM.`,
    );
  }

  /**
   * Publishing or testing a graph whose conditions check deal fields (ADR-393) needs the CRM in the
   * company's plan, as deal steps do (ADR-249), and `crm.read`, as seeing deals does.
   */
  function assertMayCheckDeals(
    ctx: TenantContext,
    graph: AutomationGraph,
    action: 'publish' | 'test',
  ) {
    if (!usesDealConditions(graph)) return;
    assertModule(ctx.plan, 'crm');
    if (can(ctx, 'crm.read')) return;
    throw forbidden(
      `${action === 'publish' ? 'Publishing' : 'Testing'} an automation that checks deal fields needs the permission to see the CRM.`,
    );
  }

  /**
   * Publishing or testing a graph that sends forms needs WhatsApp Flows in the company's plan, as
   * sending a form in the inbox does (ADR-248).
   */
  function assertMaySendForms(ctx: TenantContext, graph: AutomationGraph) {
    if (graph.nodes.some((n) => n.type === 'send_flow')) assertModule(ctx.plan, 'flows');
  }

  /**
   * Publishing or testing a graph that sends products needs commerce in the company's plan and
   * `commerce.read`, as sending products in the inbox does (ADR-383).
   */
  function assertMaySendProducts(
    ctx: TenantContext,
    graph: AutomationGraph,
    action: 'publish' | 'test',
  ) {
    if (!graph.nodes.some((n) => n.type === 'send_products')) return;
    assertModule(ctx.plan, 'commerce');
    if (can(ctx, 'commerce.read')) return;
    throw forbidden(
      `${action === 'publish' ? 'Publishing' : 'Testing'} an automation that sends products needs the permission to see the catalogs.`,
    );
  }

  /** Parses and checks a draft; throws when it cannot be run. */
  async function runnableDraft(tx: Tx, row: typeof automations.$inferSelect) {
    const trigger = parseTrigger(row.draftTrigger);
    const graph = parseGraph(row.draftGraph);
    if (!trigger.ok) throw new AppError('precondition_failed', trigger.message);
    if (!graph.ok) {
      throw new AppError(
        'precondition_failed',
        graph.issues[0]?.message ?? 'The steps are not valid.',
      );
    }
    const channel = await channelAccountOf(tx, row.tenantId, row.draftChannelAccountId);
    if (row.draftChannelAccountId && !channel) {
      throw new AppError('precondition_failed', 'Choose a WhatsApp number again.');
    }
    const errors = [
      ...triggerIssues(trigger.trigger, row.draftChannelAccountId),
      ...checkGraph(
        graph.graph,
        graphRefs(
          await references(tx, row.tenantId, { ids: productsOf(graph.graph), picker: false }),
          {
            trigger: trigger.trigger,
            channelWhatsappAccountId: channel?.whatsappAccountId ?? null,
          },
        ),
      ),
    ].filter((i) => i.level === 'error');
    if (errors.length > 0) {
      throw new AppError(
        'precondition_failed',
        `Fix the automation first: ${errors[0]?.message ?? 'it has errors.'}`,
        { details: { errors: errors.length } },
      );
    }
    return { trigger: trigger.trigger, graph: graph.graph };
  }

  async function stopRunsOfAutomation(
    tx: Tx,
    ctx: TenantContext,
    automationId: string,
    now: Date,
  ): Promise<number> {
    const active = await tx
      .select({ id: automationRuns.id, conversationId: automationRuns.conversationId })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.tenantId, ctx.tenant.id),
          eq(automationRuns.automationId, automationId),
          inArray(automationRuns.status, ['running', 'waiting']),
        ),
      )
      .orderBy(asc(automationRuns.conversationId));
    let stopped = 0;
    for (const item of active) {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, item.conversationId)),
        )
        .for('update');
      const run = await lockActiveRun(tx, ctx.tenant.id, item.conversationId);
      if (!run || run.id !== item.id) continue;
      await appendRunStep(tx, ctx.tenant.id, run.id, {
        nodeId: run.currentNodeId,
        nodeType: null,
        outcome: 'stopped',
        detail: 'automation_archived',
      });
      await endRun(tx, run, {
        status: 'stopped',
        reason: 'automation_archived',
        endedByMembershipId: ctx.membership.id,
        now,
      });
      stopped += 1;
    }
    return stopped;
  }

  return {
    async listAutomations(
      ctx: TenantContext,
      input: { includeArchived?: boolean } = {},
    ): Promise<AutomationSummary[]> {
      assertCan(ctx, 'automations.read');
      const since = new Date(clock.now().getTime() - 7 * 86_400_000);
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({
              id: automations.id,
              name: automations.name,
              description: automations.description,
              status: automations.status,
              draftTrigger: automations.draftTrigger,
              draftGraph: automations.draftGraph,
              draftChannelAccountId: automations.draftChannelAccountId,
              updatedAt: automations.updatedAt,
              activeNumber: automationVersions.number,
              activeTrigger: automationVersions.trigger,
              activeSha: automationVersions.definitionSha256,
              activeChannelId: automationVersions.channelAccountId,
              channelName: sql<
                string | null
              >`coalesce(${channelAccounts.verifiedName}, ${channelAccounts.displayPhoneNumber})`,
              activeRuns: sql<number>`(select count(*)::int from app.automation_runs r
                 where r.tenant_id = ${automations.tenantId} and r.automation_id = ${automations.id}
                   and r.status in ('running', 'waiting'))`,
              recentRuns: sql<number>`(select count(*)::int from app.automation_runs r
                 where r.tenant_id = ${automations.tenantId} and r.automation_id = ${automations.id}
                   and r.mode = 'live' and r.started_at >= ${since.toISOString()}::timestamptz)`,
            })
            .from(automations)
            .leftJoin(
              automationVersions,
              and(
                eq(automationVersions.tenantId, automations.tenantId),
                eq(automationVersions.id, automations.activeVersionId),
              ),
            )
            .leftJoin(
              channelAccounts,
              and(
                eq(channelAccounts.tenantId, automations.tenantId),
                eq(
                  channelAccounts.id,
                  sql`coalesce(${automationVersions.channelAccountId}, ${automations.draftChannelAccountId})`,
                ),
              ),
            )
            .where(
              and(
                eq(automations.tenantId, ctx.tenant.id),
                input.includeArchived ? undefined : ne(automations.status, 'archived'),
              ),
            )
            .orderBy(asc(sql`lower(${automations.name})`), asc(automations.id));
          return rows.map((r) => {
            const live = parseTrigger(r.activeTrigger ?? r.draftTrigger);
            const draftSha = definitionSha({
              trigger: r.draftTrigger,
              graph: r.draftGraph,
              channelAccountId: r.draftChannelAccountId,
            });
            return {
              id: r.id,
              name: r.name,
              description: r.description,
              status: r.status,
              trigger: live.ok ? describeTrigger(live.trigger) : null,
              channelName: r.channelName,
              activeVersion: r.activeNumber,
              draftChanged: r.activeSha !== null && r.activeSha !== draftSha,
              updatedAt: r.updatedAt.toISOString(),
              activeRuns: r.activeRuns,
              runsLast7Days: r.recentRuns,
            };
          });
        },
        { accessMode: 'read only' },
      );
    },

    async getAutomation(ctx: TenantContext, id: string): Promise<AutomationDetail> {
      assertCan(ctx, 'automations.read');
      if (!z.uuid().safeParse(id).success) throw notFound('Automation');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [row] = await tx
            .select({
              automation: automations,
              updatedByName: users.name,
            })
            .from(automations)
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, automations.tenantId),
                eq(memberships.id, automations.draftUpdatedByMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, id)));
          if (!row) throw notFound('Automation');
          const a = row.automation;
          const versions = await tx
            .select({
              id: automationVersions.id,
              number: automationVersions.number,
              note: automationVersions.note,
              createdAt: automationVersions.createdAt,
              sha: automationVersions.definitionSha256,
              createdByName: users.name,
            })
            .from(automationVersions)
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, automationVersions.tenantId),
                eq(memberships.id, automationVersions.createdByMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .where(
              and(
                eq(automationVersions.tenantId, ctx.tenant.id),
                eq(automationVersions.automationId, a.id),
                eq(automationVersions.kind, 'published'),
              ),
            )
            .orderBy(desc(automationVersions.number));
          const channels = await tx
            .select({
              id: channelAccounts.id,
              name: sql<string>`coalesce(${channelAccounts.verifiedName}, ${channelAccounts.displayPhoneNumber}, ${channelAccounts.phoneNumberId})`,
              status: channelAccounts.status,
              whatsappAccountId: channelAccounts.whatsappAccountId,
            })
            .from(channelAccounts)
            .where(eq(channelAccounts.tenantId, ctx.tenant.id))
            .orderBy(asc(channelAccounts.createdAt));
          const trigger = parseTrigger(a.draftTrigger);
          const graph = parseGraph(a.draftGraph);
          const seesCatalogs = can(ctx, 'commerce.read');
          const refs = await references(tx, ctx.tenant.id, {
            ids: graph.ok ? productsOf(graph.graph) : [],
            picker: seesCatalogs,
          });
          const { teamRows, fieldRows } = refs;
          const issues: GraphIssue[] = [];
          if (!trigger.ok) issues.push({ level: 'error', nodeId: null, message: trigger.message });
          else issues.push(...triggerIssues(trigger.trigger, a.draftChannelAccountId));
          if (graph.ok) {
            issues.push(
              ...checkGraph(
                graph.graph,
                graphRefs(refs, {
                  trigger: trigger.ok ? trigger.trigger : null,
                  channelWhatsappAccountId:
                    channels.find((c) => c.id === a.draftChannelAccountId)?.whatsappAccountId ??
                    null,
                }),
              ),
            );
          } else {
            issues.push(...graph.issues.map((i) => ({ level: 'error' as const, ...i })));
          }
          const active = versions.find((v) => v.id === a.activeVersionId) ?? null;
          const draftSha = definitionSha({
            trigger: a.draftTrigger,
            graph: a.draftGraph,
            channelAccountId: a.draftChannelAccountId,
          });
          const usedBy = can(ctx, 'commerce.read')
            ? (
                await tx
                  .select({
                    storeId: commerceStores.id,
                    storeName: sql<string>`coalesce(${commerceStores.name}, ${commerceStores.shopDomain}, ${commerceStores.storeUrl})`,
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
                      eq(commerceStoreMessageRules.tenantId, ctx.tenant.id),
                      eq(commerceStoreMessageRules.automationId, a.id),
                      eq(commerceStoreMessageRules.action, 'automation'),
                    ),
                  )
                  .orderBy(asc(commerceStores.createdAt), asc(commerceStoreMessageRules.event))
              ).map((r) => ({ ...r, label: STORE_MESSAGE_EVENT_INFO[r.event].label }))
            : null;
          return {
            id: a.id,
            name: a.name,
            description: a.description,
            status: a.status,
            version: a.version,
            draft: {
              trigger: trigger.ok ? trigger.trigger : null,
              graph: graph.ok ? graph.graph : null,
              channelAccountId: a.draftChannelAccountId,
              updatedAt: a.draftUpdatedAt.toISOString(),
              updatedByName: row.updatedByName,
            },
            issues,
            usedBy,
            draftChanged: active ? active.sha !== draftSha : true,
            activeVersion: active
              ? {
                  id: active.id,
                  number: active.number ?? 0,
                  createdAt: active.createdAt.toISOString(),
                }
              : null,
            versions: versions.map((v) => ({
              id: v.id,
              number: v.number ?? 0,
              note: v.note,
              createdAt: v.createdAt.toISOString(),
              createdByName: v.createdByName,
              active: v.id === a.activeVersionId,
            })),
            options: {
              channels: channels.map((c) => ({
                id: c.id,
                name: c.name,
                active: c.status === 'active',
                whatsappAccountId: c.whatsappAccountId,
              })),
              templates: refs.templates,
              teams: teamRows,
              crmMembers: refs.crmMembers,
              crmPipelines: refs.crmPipelines,
              dealFields: refs.dealFields,
              flows: refs.flows,
              products: seesCatalogs ? refs.products : null,
              fields: fieldRows,
              allowedDomains: refs.domains,
              secrets: refs.secrets,
              allowInsecureHttp: deps.allowInsecureHttp ?? false,
            },
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** A published version's definition (read only), for showing what a run executed. */
    async getVersion(ctx: TenantContext, automationId: string, versionId: string) {
      assertCan(ctx, 'automations.read');
      if (!z.uuid().safeParse(automationId).success || !z.uuid().safeParse(versionId).success)
        throw notFound('Version');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [v] = await tx
            .select()
            .from(automationVersions)
            .where(
              and(
                eq(automationVersions.tenantId, ctx.tenant.id),
                eq(automationVersions.automationId, automationId),
                eq(automationVersions.id, versionId),
              ),
            );
          if (!v) throw notFound('Version');
          const trigger = parseTrigger(v.trigger);
          const graph = parseGraph(v.graph);
          return {
            id: v.id,
            kind: v.kind,
            number: v.number,
            note: v.note,
            createdAt: v.createdAt.toISOString(),
            trigger: trigger.ok ? trigger.trigger : null,
            graph: graph.ok ? graph.graph : null,
            channelAccountId: v.channelAccountId,
          };
        },
        { accessMode: 'read only' },
      );
    },

    async createAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.write');
      const data = parseInput(createSchema, input);
      const id = uuidv7();
      await db.run(ctx.scope, async (tx) => {
        const [taken] = await tx
          .select({ id: automations.id })
          .from(automations)
          .where(
            and(
              eq(automations.tenantId, ctx.tenant.id),
              sql`lower(btrim(${automations.name})) = lower(${data.name})`,
            ),
          );
        if (taken) throw new AppError('conflict', 'Another automation already has this name.');
        await tx.insert(automations).values({
          id,
          tenantId: ctx.tenant.id,
          name: data.name,
          description: data.description,
          status: 'draft',
          draftTrigger: starterTrigger(),
          draftGraph: starterGraph(),
          draftChannelAccountId: null,
          draftUpdatedByMembershipId: ctx.membership.id,
          createdByMembershipId: ctx.membership.id,
        });
        await recordAudit(
          tx,
          ctx,
          { action: 'automation.created', subjectType: 'automation', subjectId: id },
          meta,
        );
      });
      return { id };
    },

    /** Saves the draft. Structural problems are refused; graph issues are returned. */
    async updateAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.write');
      const data = parseInput(updateSchema, input);
      const trigger = parseTrigger(data.trigger);
      if (!trigger.ok) throw new AppError('validation_failed', trigger.message);
      const graph = parseGraph(data.graph);
      if (!graph.ok) {
        throw new AppError(
          'validation_failed',
          graph.issues[0]?.message ?? 'The steps are not valid.',
          {
            details: { issues: graph.issues },
          },
        );
      }
      return db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status === 'archived')
          throw new AppError('precondition_failed', 'Restore the automation before editing it.');
        const [taken] = await tx
          .select({ id: automations.id })
          .from(automations)
          .where(
            and(
              eq(automations.tenantId, ctx.tenant.id),
              ne(automations.id, row.id),
              sql`lower(btrim(${automations.name})) = lower(${data.name})`,
            ),
          );
        if (taken) throw new AppError('conflict', 'Another automation already has this name.');
        if (data.channelAccountId) {
          const [channel] = await tx
            .select({ id: channelAccounts.id })
            .from(channelAccounts)
            .where(
              and(
                eq(channelAccounts.tenantId, ctx.tenant.id),
                eq(channelAccounts.id, data.channelAccountId),
              ),
            );
          if (!channel)
            throw new AppError('validation_failed', 'Choose a WhatsApp number of this company.');
        }
        const now = clock.now();
        await tx
          .update(automations)
          .set({
            name: data.name,
            description: data.description,
            draftTrigger: trigger.trigger,
            draftGraph: graph.graph,
            draftChannelAccountId: data.channelAccountId,
            draftUpdatedAt: now,
            draftUpdatedByMembershipId: ctx.membership.id,
            version: sql`${automations.version} + 1`,
          })
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          { action: 'automation.draft_saved', subjectType: 'automation', subjectId: row.id },
          meta,
        );
        const channel = await channelAccountOf(tx, ctx.tenant.id, data.channelAccountId);
        return {
          version: row.version + 1,
          issues: [
            ...triggerIssues(trigger.trigger, data.channelAccountId),
            ...checkGraph(
              graph.graph,
              graphRefs(
                await references(tx, ctx.tenant.id, {
                  ids: productsOf(graph.graph),
                  picker: false,
                }),
                {
                  trigger: trigger.trigger,
                  channelWhatsappAccountId: channel?.whatsappAccountId ?? null,
                },
              ),
            ),
          ],
        };
      });
    },

    async publishAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.publish');
      const data = parseInput(publishSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status === 'archived')
          throw new AppError('precondition_failed', 'Restore the automation before publishing it.');
        // The first publication makes the automation live.
        if (row.status === 'draft') await assertLiveAutomationAvailable(tx, ctx.tenant.id, row.id);
        const { trigger, graph } = await runnableDraft(tx, row);
        await assertMayUseTemplates(tx, ctx, graph, 'publish');
        assertMayChangeCrm(ctx, graph, 'publish');
        assertMayCheckDeals(ctx, graph, 'publish');
        assertMaySendForms(ctx, graph);
        assertMaySendProducts(ctx, graph, 'publish');
        const sha = definitionSha({ trigger, graph, channelAccountId: row.draftChannelAccountId });
        if (row.activeVersionId) {
          const [current] = await tx
            .select({ sha: automationVersions.definitionSha256, number: automationVersions.number })
            .from(automationVersions)
            .where(
              and(
                eq(automationVersions.tenantId, ctx.tenant.id),
                eq(automationVersions.id, row.activeVersionId),
              ),
            );
          if (current?.sha === sha) {
            throw new AppError(
              'conflict',
              `Nothing changed since version ${current.number ?? ''}; it is already live.`,
            );
          }
        }
        const [last] = await tx
          .select({ n: sql<number>`coalesce(max(${automationVersions.number}), 0)::int` })
          .from(automationVersions)
          .where(
            and(
              eq(automationVersions.tenantId, ctx.tenant.id),
              eq(automationVersions.automationId, row.id),
            ),
          );
        const number = (last?.n ?? 0) + 1;
        const versionId = uuidv7();
        await tx.insert(automationVersions).values({
          id: versionId,
          tenantId: ctx.tenant.id,
          automationId: row.id,
          kind: 'published',
          number,
          trigger,
          graph,
          channelAccountId: row.draftChannelAccountId,
          definitionSha256: sha,
          note: data.note,
          createdByMembershipId: ctx.membership.id,
        });
        await tx
          .update(automations)
          .set({
            activeVersionId: versionId,
            status: row.status === 'draft' ? 'active' : row.status,
            version: sql`${automations.version} + 1`,
          })
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.published',
            subjectType: 'automation',
            subjectId: row.id,
            metadata: { version: number, versionId },
          },
          meta,
        );
        return { versionNumber: number, version: row.version + 1 };
      });
    },

    async setAutomationStatus(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.publish');
      const data = parseInput(statusSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status === 'archived' || row.status === 'draft' || !row.activeVersionId) {
          throw new AppError('precondition_failed', 'Publish the automation first.');
        }
        if (row.status === data.status) return { version: row.version };
        if (data.status === 'active')
          await assertLiveAutomationAvailable(tx, ctx.tenant.id, row.id);
        await tx
          .update(automations)
          .set({ status: data.status, version: sql`${automations.version} + 1` })
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: data.status === 'active' ? 'automation.activated' : 'automation.paused',
            subjectType: 'automation',
            subjectId: row.id,
          },
          meta,
        );
        return { version: row.version + 1 };
      });
    },

    /** Archives an automation: no new runs, and runs in progress stop. */
    async archiveAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.publish');
      const data = parseInput(idSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status === 'archived') return { stopped: 0 };
        await tx
          .update(automations)
          .set({ status: 'archived', version: sql`${automations.version} + 1` })
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        const stopped = await stopRunsOfAutomation(tx, ctx, row.id, clock.now());
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.archived',
            subjectType: 'automation',
            subjectId: row.id,
            metadata: { stoppedRuns: stopped },
          },
          meta,
        );
        return { stopped };
      });
    },

    /** Restores an archived automation as paused (published before) or as a draft. */
    async restoreAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.publish');
      const data = parseInput(idSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status !== 'archived') return;
        await tx
          .update(automations)
          .set({
            status: row.activeVersionId ? 'paused' : 'draft',
            version: sql`${automations.version} + 1`,
          })
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          { action: 'automation.restored', subjectType: 'automation', subjectId: row.id },
          meta,
        );
      });
    },

    /** Deletes an automation that never ran and has no versions (otherwise archive it). */
    async deleteAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.write');
      const data = parseInput(idSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        const [used] = await tx
          .select({ id: automationVersions.id })
          .from(automationVersions)
          .where(
            and(
              eq(automationVersions.tenantId, ctx.tenant.id),
              eq(automationVersions.automationId, row.id),
            ),
          )
          .limit(1);
        if (used) {
          throw new AppError(
            'conflict',
            'This automation has been published or tested, so its history is kept. Archive it instead.',
          );
        }
        await tx
          .delete(automations)
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.deleted',
            subjectType: 'automation',
            subjectId: row.id,
            metadata: { name: row.name },
          },
          meta,
        );
      });
    },

    /**
     * Runs a snapshot of the draft on a conversation the member can see (real messages are sent
     * there). The conversation must be open, inside the 24-hour window, not assigned to someone
     * else, and not handled by another automation. An automation started by order messages is
     * tested with an order the member chooses (`commerce.read` and `contacts.read`, as store
     * orders need), whose values its steps read; one started through the API with the inputs the
     * member gives.
     */
    async startTestRun(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.write');
      assertCan(ctx, 'inbox.reply');
      const data = parseInput(testRunSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status === 'archived')
          throw new AppError('precondition_failed', 'Restore the automation before testing it.');
        const { trigger, graph } = await runnableDraft(tx, row);
        await assertMayUseTemplates(tx, ctx, graph, 'test');
        assertMayChangeCrm(ctx, graph, 'test');
        assertMayCheckDeals(ctx, graph, 'test');
        assertMaySendForms(ctx, graph);
        assertMaySendProducts(ctx, graph, 'test');
        let storeOrderId: string | null = null;
        if (trigger.type === 'store_event') {
          // The steps send the order's customer details: seeing store orders needs both.
          assertCan(ctx, 'commerce.read');
          assertCan(ctx, 'contacts.read');
          if (!data.storeOrderId) {
            throw new AppError('validation_failed', 'Choose an order to test with.');
          }
          const [order] = await tx
            .select({ id: commerceStoreOrders.id })
            .from(commerceStoreOrders)
            .where(
              and(
                eq(commerceStoreOrders.tenantId, ctx.tenant.id),
                eq(commerceStoreOrders.id, data.storeOrderId),
                isNull(commerceStoreOrders.deletedAt),
                isNull(commerceStoreOrders.redactedAt),
              ),
            );
          if (!order) throw notFound('Order');
          storeOrderId = order.id;
        }
        let variables: Record<string, string> = {};
        if (trigger.type === 'api') {
          const inputs = apiInputValues(trigger.inputs, data.inputs);
          if (!inputs.ok) throw new AppError('validation_failed', inputs.message);
          variables = inputs.variables;
        }
        const [conv] = await tx
          .select({
            id: conversations.id,
            status: conversations.status,
            assignedMembershipId: conversations.assignedMembershipId,
            channelAccountId: conversations.channelAccountId,
            contactId: conversations.contactId,
            lastInboundAt: conversations.lastInboundAt,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, ctx.tenant.id),
              eq(conversations.id, data.conversationId),
            ),
          )
          .for('update');
        if (!conv || !canSeeConversation(ctx, conv.assignedMembershipId))
          throw notFound('Conversation');
        if (conv.status === 'resolved')
          throw new AppError('precondition_failed', 'Reopen the conversation to test on it.');
        const now = clock.now();
        if (
          !conv.lastInboundAt ||
          now.getTime() - conv.lastInboundAt.getTime() > SERVICE_WINDOW_MS
        ) {
          throw new AppError(
            'precondition_failed',
            'The 24-hour customer service window of this conversation is closed. Send a WhatsApp message to the number from the test phone first.',
          );
        }
        if (conv.assignedMembershipId && conv.assignedMembershipId !== ctx.membership.id) {
          throw forbidden('This conversation is assigned to another member.');
        }
        if (await lockActiveRun(tx, ctx.tenant.id, conv.id)) {
          throw new AppError('conflict', 'An automation is already handling this conversation.');
        }
        const sha = definitionSha({ trigger, graph, channelAccountId: row.draftChannelAccountId });
        const [snapshot] = await tx
          .select({ id: automationVersions.id })
          .from(automationVersions)
          .where(
            and(
              eq(automationVersions.tenantId, ctx.tenant.id),
              eq(automationVersions.automationId, row.id),
              eq(automationVersions.kind, 'test'),
              eq(automationVersions.definitionSha256, sha),
            ),
          )
          .limit(1);
        const versionId = snapshot?.id ?? uuidv7();
        if (!snapshot) {
          await tx.insert(automationVersions).values({
            id: versionId,
            tenantId: ctx.tenant.id,
            automationId: row.id,
            kind: 'test',
            number: null,
            trigger,
            graph,
            channelAccountId: row.draftChannelAccountId,
            definitionSha256: sha,
            note: null,
            createdByMembershipId: ctx.membership.id,
          });
        }
        const runId = uuidv7();
        await tx.insert(automationRuns).values({
          id: runId,
          tenantId: ctx.tenant.id,
          automationId: row.id,
          versionId,
          conversationId: conv.id,
          contactId: conv.contactId,
          channelAccountId: conv.channelAccountId,
          mode: 'test',
          triggerType: 'test',
          storeOrderId,
          variables,
          startedByMembershipId: ctx.membership.id,
          startedByUserId: ctx.user.id,
          status: 'running',
          currentNodeId: graph.start,
          nextStepAt: now,
          startedAt: now,
        });
        await appendRunStep(tx, ctx.tenant.id, runId, {
          nodeId: null,
          nodeType: null,
          outcome: 'started',
          detail: 'test',
        });
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: 'automation.started',
          conversationId: conv.id,
          payload: { runId, automationId: row.id },
        });
        await signalAutomationRun(deps, tx, {
          tenantId: ctx.tenant.id,
          runId,
          actorUserId: ctx.user.id,
          key: 'start',
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.test_started',
            subjectType: 'automation',
            subjectId: row.id,
            metadata: { runId, conversationId: conv.id },
          },
          meta,
        );
        return { runId };
      });
    },

    async listRuns(ctx: TenantContext, input: unknown = {}) {
      assertCan(ctx, 'automations.read');
      const data = parseInput(listRunsSchema, input);
      const cursor = data.cursor ? decodeCursor(data.cursor) : null;
      const inboxReader = can(ctx, 'inbox.read_all') || can(ctx, 'inbox.read_assigned');
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({
              run: automationRuns,
              automationName: automations.name,
              versionNumber: automationVersions.number,
              assigned: conversations.assignedMembershipId,
            })
            .from(automationRuns)
            .innerJoin(
              automations,
              and(
                eq(automations.tenantId, automationRuns.tenantId),
                eq(automations.id, automationRuns.automationId),
              ),
            )
            .innerJoin(
              automationVersions,
              and(
                eq(automationVersions.tenantId, automationRuns.tenantId),
                eq(automationVersions.id, automationRuns.versionId),
              ),
            )
            .innerJoin(
              conversations,
              and(
                eq(conversations.tenantId, automationRuns.tenantId),
                eq(conversations.id, automationRuns.conversationId),
              ),
            )
            .where(
              and(
                eq(automationRuns.tenantId, ctx.tenant.id),
                data.automationId ? eq(automationRuns.automationId, data.automationId) : undefined,
                data.status === 'active'
                  ? inArray(automationRuns.status, ['running', 'waiting'])
                  : data.status
                    ? eq(automationRuns.status, data.status)
                    : undefined,
                cursor
                  ? sql`(${automationRuns.startedAt}, ${automationRuns.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
            .limit(RUN_PAGE + 1);
          const page = rows.slice(0, RUN_PAGE);
          const last = page.at(-1);
          return {
            runs: page.map((r) => ({
              id: r.run.id,
              automationId: r.run.automationId,
              automationName: r.automationName,
              versionNumber: r.versionNumber,
              mode: r.run.mode,
              status: r.run.status,
              endReason: r.run.endReason,
              triggerType: r.run.triggerType,
              enrollmentId: r.run.enrollmentId,
              startedAt: r.run.startedAt.toISOString(),
              endedAt: r.run.endedAt?.toISOString() ?? null,
              steps: r.run.stepCount,
              messages: r.run.messageCount,
              conversationId:
                inboxReader && canSeeConversation(ctx, r.assigned) ? r.run.conversationId : null,
            })) satisfies RunSummary[],
            nextCursor:
              rows.length > RUN_PAGE && last ? encodeCursor(last.run.startedAt, last.run.id) : null,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * The runs the list shows as CSV (ADR-237), newest first, with its filters (an automation, a
     * status), streamed in batches. No customer data, so `automations.read` is enough; audited
     * before the first line.
     */
    async *exportRuns(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): AsyncGenerator<string> {
      assertCan(ctx, 'automations.read');
      const data = parseInput(exportRunsSchema, input ?? {});
      await db.run(ctx.scope, (tx) =>
        recordAudit(
          tx,
          ctx,
          {
            action: 'automation.runs_exported',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: { automationId: data.automationId ?? null, status: data.status ?? null },
          },
          meta,
        ),
      );
      yield CSV_BOM + csvLine(RUN_CSV_COLUMNS);
      let before: { at: Date; id: string } | null = null;
      for (;;) {
        const cursor: { at: Date; id: string } | null = before;
        const rows: RunCsvRow[] = await db.run(
          ctx.scope,
          (tx) =>
            tx
              .select({
                id: automationRuns.id,
                automationName: automations.name,
                versionNumber: automationVersions.number,
                mode: automationRuns.mode,
                status: automationRuns.status,
                endReason: automationRuns.endReason,
                triggerType: automationRuns.triggerType,
                startedAt: automationRuns.startedAt,
                endedAt: automationRuns.endedAt,
                steps: automationRuns.stepCount,
                messages: automationRuns.messageCount,
              })
              .from(automationRuns)
              .innerJoin(
                automations,
                and(
                  eq(automations.tenantId, automationRuns.tenantId),
                  eq(automations.id, automationRuns.automationId),
                ),
              )
              .innerJoin(
                automationVersions,
                and(
                  eq(automationVersions.tenantId, automationRuns.tenantId),
                  eq(automationVersions.id, automationRuns.versionId),
                ),
              )
              .where(
                and(
                  eq(automationRuns.tenantId, ctx.tenant.id),
                  data.automationId
                    ? eq(automationRuns.automationId, data.automationId)
                    : undefined,
                  data.status === 'active'
                    ? inArray(automationRuns.status, ['running', 'waiting'])
                    : data.status
                      ? eq(automationRuns.status, data.status)
                      : undefined,
                  cursor
                    ? sql`(${automationRuns.startedAt}, ${automationRuns.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`
                    : undefined,
                ),
              )
              .orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
              .limit(RUN_EXPORT_BATCH),
          { accessMode: 'read only' },
        );
        if (rows.length === 0) break;
        yield rows.map(runCsvLine).join('');
        const last = rows.at(-1);
        if (!last || rows.length < RUN_EXPORT_BATCH) break;
        before = { at: last.startedAt, id: last.id };
      }
    },

    async getRun(ctx: TenantContext, runId: string): Promise<RunDetail> {
      assertCan(ctx, 'automations.read');
      if (!z.uuid().safeParse(runId).success) throw notFound('Run');
      const inboxReader = can(ctx, 'inbox.read_all') || can(ctx, 'inbox.read_assigned');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [r] = await tx
            .select({
              run: automationRuns,
              automationName: automations.name,
              versionNumber: automationVersions.number,
              graph: automationVersions.graph,
              assigned: conversations.assignedMembershipId,
              apiKeyName: apiKeys.name,
              enrolledBy: automationEnrollments.createdByMembershipId,
              enrolledByKey: automationEnrollments.createdByApiKeyId,
            })
            .from(automationRuns)
            .leftJoin(
              automationEnrollments,
              and(
                eq(automationEnrollments.tenantId, automationRuns.tenantId),
                eq(automationEnrollments.id, automationRuns.enrollmentId),
              ),
            )
            .leftJoin(
              apiKeys,
              and(
                eq(apiKeys.tenantId, automationRuns.tenantId),
                eq(apiKeys.id, automationRuns.apiKeyId),
              ),
            )
            .innerJoin(
              automations,
              and(
                eq(automations.tenantId, automationRuns.tenantId),
                eq(automations.id, automationRuns.automationId),
              ),
            )
            .innerJoin(
              automationVersions,
              and(
                eq(automationVersions.tenantId, automationRuns.tenantId),
                eq(automationVersions.id, automationRuns.versionId),
              ),
            )
            .innerJoin(
              conversations,
              and(
                eq(conversations.tenantId, automationRuns.tenantId),
                eq(conversations.id, automationRuns.conversationId),
              ),
            )
            .where(and(eq(automationRuns.tenantId, ctx.tenant.id), eq(automationRuns.id, runId)));
          if (!r) throw notFound('Run');
          const memberIds = [
            r.run.endedByMembershipId,
            r.run.startedByMembershipId,
            r.enrolledBy,
          ].filter((x): x is string => x !== null);
          const names =
            memberIds.length > 0
              ? await tx
                  .select({ id: memberships.id, name: users.name })
                  .from(memberships)
                  .innerJoin(users, eq(users.id, memberships.userId))
                  .where(
                    and(
                      eq(memberships.tenantId, ctx.tenant.id),
                      inArray(memberships.id, memberIds),
                    ),
                  )
              : [];
          const nameOf = (id: string | null) => names.find((n) => n.id === id)?.name ?? null;
          // The key whose enrolment started the run (ADR-403).
          const [enrolledByKey] = r.enrolledByKey
            ? await tx
                .select({ name: apiKeys.name })
                .from(apiKeys)
                .where(and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, r.enrolledByKey)))
            : [];
          const steps = await tx
            .select()
            .from(automationRunSteps)
            .where(
              and(
                eq(automationRunSteps.tenantId, ctx.tenant.id),
                eq(automationRunSteps.runId, r.run.id),
              ),
            )
            .orderBy(asc(automationRunSteps.seq));
          const calls = await tx
            .select({
              id: automationHttpCalls.id,
              nodeId: automationHttpCalls.nodeId,
              method: automationHttpCalls.method,
              host: automationHttpCalls.host,
              path: automationHttpCalls.path,
              state: automationHttpCalls.state,
              statusCode: automationHttpCalls.statusCode,
              errorCode: automationHttpCalls.errorCode,
              durationMs: automationHttpCalls.durationMs,
              droppedValues: automationHttpCalls.droppedValues,
              createdAt: automationHttpCalls.createdAt,
              finishedAt: automationHttpCalls.finishedAt,
            })
            .from(automationHttpCalls)
            .where(
              and(
                eq(automationHttpCalls.tenantId, ctx.tenant.id),
                eq(automationHttpCalls.runId, r.run.id),
              ),
            )
            .orderBy(asc(automationHttpCalls.createdAt), asc(automationHttpCalls.id));
          const visible = inboxReader && canSeeConversation(ctx, r.assigned);
          const graph = parseGraph(r.graph);
          const [order] =
            r.run.storeOrderId && can(ctx, 'commerce.read')
              ? await tx
                  .select({
                    id: commerceStoreOrders.id,
                    name: commerceStoreOrders.name,
                    storeName: sql<string>`coalesce(${commerceStores.name}, ${commerceStores.shopDomain}, ${commerceStores.storeUrl})`,
                  })
                  .from(commerceStoreOrders)
                  .innerJoin(
                    commerceStores,
                    and(
                      eq(commerceStores.tenantId, commerceStoreOrders.tenantId),
                      eq(commerceStores.id, commerceStoreOrders.storeId),
                    ),
                  )
                  .where(
                    and(
                      eq(commerceStoreOrders.tenantId, ctx.tenant.id),
                      eq(commerceStoreOrders.id, r.run.storeOrderId),
                    ),
                  )
              : [];
          return {
            id: r.run.id,
            automationId: r.run.automationId,
            automationName: r.automationName,
            versionNumber: r.versionNumber,
            mode: r.run.mode,
            status: r.run.status,
            endReason: r.run.endReason,
            triggerType: r.run.triggerType,
            enrollmentId: r.run.enrollmentId,
            startedAt: r.run.startedAt.toISOString(),
            endedAt: r.run.endedAt?.toISOString() ?? null,
            steps: r.run.stepCount,
            messages: r.run.messageCount,
            conversationId: visible ? r.run.conversationId : null,
            currentNodeId: r.run.currentNodeId,
            waitingFor: r.run.waitingFor,
            sending: r.run.pendingMessageId !== null,
            waitUntil: r.run.waitUntil?.toISOString() ?? null,
            endDetail: r.run.endDetail,
            endedByName: nameOf(r.run.endedByMembershipId),
            startedByName: nameOf(r.run.startedByMembershipId),
            storeEvent: r.run.storeEvent,
            apiKeyName: r.apiKeyName,
            enrolledByName: nameOf(r.enrolledBy),
            enrolledByKeyName: enrolledByKey?.name ?? null,
            order: order ?? null,
            graph: graph.ok ? graph.graph : null,
            variables: visible ? r.run.variables : null,
            log: steps.map((s) => ({
              seq: s.seq,
              nodeId: s.nodeId,
              nodeType: s.nodeType,
              outcome: s.outcome,
              branch: s.branch,
              detail: s.detail,
              messageId: visible ? s.messageId : null,
              createdAt: s.createdAt.toISOString(),
            })),
            httpCalls: calls.map((c) => ({
              ...c,
              createdAt: c.createdAt.toISOString(),
              finishedAt: c.finishedAt?.toISOString() ?? null,
            })),
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** Stops a run; the conversation returns to people (routed as a new case). */
    async stopRun(ctx: TenantContext, runId: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.publish');
      if (!z.uuid().safeParse(runId).success) throw notFound('Run');
      await db.run(ctx.scope, async (tx) => {
        const [peek] = await tx
          .select({
            conversationId: automationRuns.conversationId,
            automationId: automationRuns.automationId,
          })
          .from(automationRuns)
          .where(and(eq(automationRuns.tenantId, ctx.tenant.id), eq(automationRuns.id, runId)));
        if (!peek) throw notFound('Run');
        await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, ctx.tenant.id),
              eq(conversations.id, peek.conversationId),
            ),
          )
          .for('update');
        const run = await lockActiveRun(tx, ctx.tenant.id, peek.conversationId);
        if (!run || run.id !== runId) throw new AppError('conflict', 'This run has already ended.');
        await appendRunStep(tx, ctx.tenant.id, run.id, {
          nodeId: run.currentNodeId,
          nodeType: null,
          outcome: 'stopped',
          detail: 'stopped_by_member',
        });
        await endRun(tx, run, {
          status: 'stopped',
          reason: 'stopped_by_member',
          endedByMembershipId: ctx.membership.id,
          now: clock.now(),
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.run_stopped',
            subjectType: 'automation_run',
            subjectId: run.id,
            metadata: { automationId: peek.automationId },
          },
          meta,
        );
      });
    },

    /**
     * A member takes a conversation over from the automation handling it: the run ends, queued bot
     * messages are cancelled, and the conversation is assigned to the member if nobody has it.
     */
    async takeOver(ctx: TenantContext, conversationId: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'inbox.reply');
      if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
      await db.run(ctx.scope, async (tx) => {
        const [conv] = await tx
          .select({
            id: conversations.id,
            assignedMembershipId: conversations.assignedMembershipId,
          })
          .from(conversations)
          .where(
            and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)),
          )
          .for('update');
        if (!conv || !canSeeConversation(ctx, conv.assignedMembershipId))
          throw notFound('Conversation');
        const runId = await endRunForHuman(tx, {
          tenantId: ctx.tenant.id,
          conversationId: conv.id,
          reason: 'take_over',
          actorMembershipId: ctx.membership.id,
          now: clock.now(),
        });
        if (!runId)
          throw new AppError('conflict', 'No automation is handling this conversation any more.');
        if (conv.assignedMembershipId === null) {
          await tx
            .update(conversations)
            .set({
              assignedMembershipId: ctx.membership.id,
              version: sql`${conversations.version} + 1`,
            })
            .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conv.id)));
          await emitTenantEvent(tx, ctx.tenant.id, {
            type: 'conversation.assigned',
            conversationId: conv.id,
            assignedMembershipId: ctx.membership.id,
            payload: { previous: null },
          });
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.taken_over',
            subjectType: 'conversation',
            subjectId: conv.id,
            metadata: { runId },
          },
          meta,
        );
      });
    },

    /**
     * Orders a test of an automation started by order messages can use: the latest orders of the
     * company's stores that are neither deleted nor redacted (ADR-050), for members who may see
     * store orders.
     */
    async testOrderOptions(ctx: TenantContext) {
      assertCan(ctx, 'automations.write');
      if (!can(ctx, 'commerce.read') || !can(ctx, 'contacts.read')) return [];
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({
              id: commerceStoreOrders.id,
              name: commerceStoreOrders.name,
              placedAt: commerceStoreOrders.placedAt,
              storeName: sql<string>`coalesce(${commerceStores.name}, ${commerceStores.shopDomain}, ${commerceStores.storeUrl})`,
            })
            .from(commerceStoreOrders)
            .innerJoin(
              commerceStores,
              and(
                eq(commerceStores.tenantId, commerceStoreOrders.tenantId),
                eq(commerceStores.id, commerceStoreOrders.storeId),
              ),
            )
            .where(
              and(
                eq(commerceStoreOrders.tenantId, ctx.tenant.id),
                isNull(commerceStoreOrders.deletedAt),
                isNull(commerceStoreOrders.redactedAt),
              ),
            )
            .orderBy(desc(commerceStoreOrders.placedAt), desc(commerceStoreOrders.id))
            .limit(20);
          return rows.map((r) => ({ id: r.id, label: `${r.name} · ${r.storeName}` }));
        },
        { accessMode: 'read only' },
      );
    },

    /** Conversations a member may run a test on: open, visible, recent customer message. */
    async testConversationOptions(ctx: TenantContext) {
      assertCan(ctx, 'automations.write');
      if (!can(ctx, 'inbox.reply')) return [];
      const since = new Date(clock.now().getTime() - SERVICE_WINDOW_MS);
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx.execute<{
            id: string;
            name: string | null;
            phone: string | null;
            assigned: string | null;
            last_inbound_at: Date;
          }>(sql`
            select c.id, coalesce(ct.display_name, ci.profile_name) as name, ct.phone_e164 as phone,
                   c.assigned_membership_id as assigned, c.last_inbound_at
              from app.conversations c
              join app.contacts ct on ct.tenant_id = c.tenant_id and ct.id = c.contact_id
              left join lateral (select i.profile_name from app.contact_identities i
                                  where i.tenant_id = c.tenant_id and i.contact_id = c.contact_id
                                  limit 1) ci on true
             where c.tenant_id = ${ctx.tenant.id}::uuid and c.status <> 'resolved'
               and c.last_inbound_at >= ${since.toISOString()}::timestamptz
               and (c.assigned_membership_id is null or c.assigned_membership_id = ${ctx.membership.id}::uuid)
             order by c.last_inbound_at desc
             limit 50`);
          return rows.rows
            .filter((r) => canSeeConversation(ctx, r.assigned))
            .map((r) => ({
              id: r.id,
              // The number as the member may see it (ADR-226).
              label: r.name ?? shownNumber(ctx, r.phone) ?? 'Unknown contact',
            }));
        },
        { accessMode: 'read only' },
      );
    },
  };
}

export type AutomationService = ReturnType<typeof createAutomationService>;

/** Runs of automations started in a period, by outcome (reports). */
export async function automationRunOutcomes(
  tx: Tx,
  tenantId: string,
  period: { start: Date; end: Date },
) {
  const res = await tx
    .select({
      status: automationRuns.status,
      reason: automationRuns.endReason,
      n: sql<number>`count(*)::int`,
    })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.tenantId, tenantId),
        eq(automationRuns.mode, 'live'),
        gte(automationRuns.startedAt, period.start),
        sql`${automationRuns.startedAt} < ${period.end.toISOString()}::timestamptz`,
      ),
    )
    .groupBy(automationRuns.status, automationRuns.endReason);
  return res;
}
