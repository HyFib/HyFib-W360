import { z } from 'zod';
import { AppError, isAppError, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  contacts,
  crmActivities,
  crmDeals,
  crmPipelines,
  crmStages,
  eq,
  inArray,
  isNull,
  memberships,
  or,
  sql,
  users,
  type CrmActivityKind,
  type Database,
  type DealStatus,
  type ImportRowMessage,
  type Tx,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { permissionsForRoles } from '../authz/permissions';
import { assertCan, type TenantContext } from '../authz/context';
import { CsvError, parseCsv, restoreCell, type CsvLimits, type ParsedCsv } from '../contacts/csv';
import { validDate, type AttributeValue } from '../contacts/fields';
import { CALLING_CODE_RE, normalizePhone, type PhoneInputMode } from '../contacts/phone';
import { parseInput } from '../validation';
import { crmChangedBy } from './common';
import {
  loadDealFields,
  lockedDealFields,
  mergedDealAttributes,
  sameAttributes,
  type DealFieldDefinition,
} from './deal-fields';
import { currencyDigits, MAX_DEAL_MINOR, parseAmountToMinor } from './money';

/**
 * Deals imported from CSV into one pipeline (ADR-374, ADR-387). A row without a deal id adds a deal
 * for a contact the company already has, found by phone number, with a title and optionally a stage
 * (by name), a value in the pipeline's currency, an owner (a member's email or name), an expected
 * close date and custom field values (ADR-373). A row with a deal id (the `deal_id` column of the
 * deals export) changes that open deal of the pipeline instead: the cells given change, blank ones
 * leave values as they are. A row with the status `won` or `lost` also closes its deal, now, as the
 * deal page's close action does. The rows are checked first, read-only, and each says what it will
 * do; the import then runs in one transaction: rows with errors are skipped and listed by row
 * number, the rest are written as members' changes, each with its timeline entries, and the import
 * is audited with its counts.
 */

/** A smaller file than contacts take: every row adds a deal, a timeline entry and a webhook event. */
export const DEAL_IMPORT_LIMITS: CsvLimits = {
  // Server actions accept request bodies up to 1 MB (apps/web next.config.ts), multipart included,
  // and the import sends the checked deals' versions with the file (ADR-387): at most 1,000 ids
  // and versions, under 48 KB as JSON.
  maxBytes: 1_000_000 - 72_000,
  maxRows: 1000,
  maxColumns: 50,
  maxFieldLength: 1000,
};

const column = z.number().int().min(0);

/** A deal id as the export writes it (a UUID); others are reported per row, never looked up. */
const DEAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dealImportSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  pipelineId: z.uuid('Choose a pipeline.'),
  phoneFormat: z.enum(['international', 'national']),
  callingCode: z
    .string()
    .regex(CALLING_CODE_RE, 'Enter a country calling code such as 91')
    .optional(),
  mapping: z
    .object({
      /** Rows with a deal id change that deal (ADR-387); the column is optional. */
      dealId: column.nullable().default(null),
      phone: column.nullable().default(null),
      title: column.nullable().default(null),
      stage: column.nullable().default(null),
      value: column.nullable().default(null),
      currency: column.nullable().default(null),
      owner: column.nullable().default(null),
      expectedCloseOn: column.nullable().default(null),
      status: column.nullable().default(null),
      lostReason: column.nullable().default(null),
      fields: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), column).default({}),
    })
    // Without deal ids every row adds a deal, which needs its contact's number and a title.
    .refine((m) => m.dealId !== null || (m.phone !== null && m.title !== null), {
      message: 'Choose the columns with the phone number and the title, or the deal id column.',
    }),
  /**
   * The version of each deal the rows were checked against (ADR-387): a deal changed since then is
   * skipped, as an edit made on a stale deal page is refused.
   */
  expectedVersions: z
    .record(z.uuid(), z.number().int().min(1))
    .refine((r) => Object.keys(r).length <= DEAL_IMPORT_LIMITS.maxRows, 'Too many deals.')
    .default({}),
});
export type DealImportOptions = z.input<typeof dealImportSchema>;

/** What a row does, as the check before the import reports it. */
export type DealImportAction = 'create' | 'update' | 'unchanged' | 'skip';

export interface DealImportRow {
  /** The row's number in the file, counted from 2 (after the header). */
  row: number;
  action: DealImportAction;
  /** The outcome the row closes its deal with; null when it stays open (or the row is skipped). */
  close: 'won' | 'lost' | null;
  /** The deal the row changes; null for new deals and skipped rows. */
  dealId: string | null;
  /** The deal's title after the row; null for skipped rows. */
  title: string | null;
  /** Why the row is skipped. */
  message: string | null;
}

export interface DealImportCounts {
  /** New deals, closed ones included. */
  created: number;
  /** Existing deals changed, closed ones included. */
  updated: number;
  /** Deals closed, new or existing. */
  closed: number;
  /** Rows naming a deal whose values they already hold. */
  unchanged: number;
  /** Rows with errors, skipped. */
  errorCount: number;
}

export interface DealImportCheck extends DealImportCounts {
  totalRows: number;
  rows: DealImportRow[];
  /** The version of every deal the rows change or leave as it is, to send with the import. */
  expectedVersions: Record<string, number>;
}

export interface DealImportResult extends DealImportCounts {
  totalRows: number;
  messages: ImportRowMessage[];
}

/** A deal a row names by its id, as it is when the rows are planned. */
export interface ExistingDeal {
  id: string;
  pipelineId: string;
  stageId: string;
  contactId: string;
  status: DealStatus;
  title: string;
  valueMinor: number | null;
  ownerMembershipId: string | null;
  expectedCloseOn: string | null;
  attributes: Record<string, AttributeValue>;
  version: number;
  /** Its contact was erased: the deal can no longer be edited. */
  contactErased: boolean;
}

/** What the rows are checked against: the company's records, found before planning. */
export interface DealImportLookups {
  /** The pipeline the file is imported into. */
  pipelineId: string;
  currency: string;
  /** Active stages of the pipeline by lower-cased name, in order; the first takes rows without one. */
  stages: readonly { id: string; name: string }[];
  /** Live contacts by E.164 number. */
  contactsByPhone: ReadonlyMap<string, string>;
  /** Active members who can use the CRM, by lower-cased email. */
  ownersByEmail: ReadonlyMap<string, string>;
  /** The same members by lower-cased name (as the export writes owners); null when shared. */
  ownersByName: ReadonlyMap<string, string | null>;
  /** Every member's lower-cased email and name, by membership: a deal's owner as it is. */
  memberAliases: ReadonlyMap<string, readonly string[]>;
  fields: readonly DealFieldDefinition[];
  /** The company's deals the rows name, by id (lower case). */
  deals: ReadonlyMap<string, ExistingDeal>;
  /**
   * For the import: the versions the rows were checked against, by deal id. Null for the check,
   * which takes the deals as they are.
   */
  expectedVersions: ReadonlyMap<string, number> | null;
}

/** A deal's close, from the row's status and lost reason. */
export interface PlannedClose {
  outcome: 'won' | 'lost';
  lostReason: string | null;
}

export interface PlannedDeal {
  line: number;
  contactId: string;
  stageId: string;
  title: string;
  valueMinor: number | null;
  ownerMembershipId: string | null;
  expectedCloseOn: string | null;
  attributes: Record<string, AttributeValue>;
  close: PlannedClose | null;
}

/** A change to an existing deal: its values after the row, and what changed. */
export interface PlannedUpdate {
  line: number;
  deal: ExistingDeal;
  stageId: string;
  title: string;
  valueMinor: number | null;
  ownerMembershipId: string | null;
  expectedCloseOn: string | null;
  attributes: Record<string, AttributeValue>;
  /** The details changed, as the deal page's edit names them in its timeline entry. */
  fields: string[];
  close: PlannedClose | null;
}

type Mapping = z.output<typeof dealImportSchema>['mapping'];

const cell = (row: readonly string[], index: number | null) =>
  index === null ? '' : restoreCell(row[index] ?? '').trim();

/** The phone mode the options describe. */
export function phoneMode(opts: {
  phoneFormat: 'international' | 'national';
  callingCode?: string | undefined;
}): PhoneInputMode {
  return opts.phoneFormat === 'national'
    ? { kind: 'national', callingCode: opts.callingCode ?? '' }
    : { kind: 'international' };
}

/** The deal id a row names, or '' for a row that adds a deal. */
const dealIdCell = (row: readonly string[], mapping: Pick<Mapping, 'dealId'>) =>
  cell(row, mapping.dealId ?? null);

/** The numbers the rows adding deals name that are valid, to find their contacts in one query. */
export function importedPhones(
  rows: readonly (readonly string[])[],
  mapping: Pick<Mapping, 'phone'> & Partial<Pick<Mapping, 'dealId'>>,
  mode: PhoneInputMode,
): string[] {
  const phones = new Set<string>();
  if (mapping.phone === null) return [];
  for (const row of rows) {
    if (dealIdCell(row, { dealId: mapping.dealId ?? null })) continue;
    const phone = normalizePhone(cell(row, mapping.phone), mode);
    if (phone.ok) phones.add(phone.e164);
  }
  return [...phones];
}

/** The well-formed deal ids the rows name (lower case), to find the deals in one query. */
export function importedDealIds(
  rows: readonly (readonly string[])[],
  mapping: Pick<Mapping, 'dealId'>,
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = dealIdCell(row, mapping);
    if (DEAL_ID_RE.test(id)) ids.add(id.toLowerCase());
  }
  return [...ids];
}

type RowPlan =
  | { kind: 'error'; message: string }
  | { kind: 'create'; deal: PlannedDeal }
  | { kind: 'update'; update: PlannedUpdate }
  | { kind: 'unchanged'; deal: ExistingDeal };

/**
 * The rows checked against the company's records: a deal planned for each valid row adding one, a
 * change for each valid row naming a deal that it changes, and a message naming the row (counted
 * from 2, after the header) and the problem for each other. `rows` says what each row does.
 */
export function planDealRows(
  rows: readonly (readonly string[])[],
  mapping: Mapping,
  mode: PhoneInputMode,
  lookups: DealImportLookups,
): {
  deals: PlannedDeal[];
  updates: PlannedUpdate[];
  messages: ImportRowMessage[];
  rows: DealImportRow[];
  /** The version of each deal a planned row changes or leaves as it is, by id. */
  versions: Record<string, number>;
} {
  const deals: PlannedDeal[] = [];
  const updates: PlannedUpdate[] = [];
  const messages: ImportRowMessage[] = [];
  const outcomes: DealImportRow[] = [];
  const stageByName = new Map(lookups.stages.map((s) => [s.name.trim().toLowerCase(), s.id]));
  const firstStage = lookups.stages[0]?.id;
  /** The row that already changes each deal: a deal is changed by one row at most. */
  const claimed = new Map<string, number>();
  const versions: Record<string, number> = {};
  const fail = (message: string): RowPlan => ({ kind: 'error', message });

  const stageError = (name: string) =>
    name
      ? `The pipeline has no stage named “${name.slice(0, 80)}”.`
      : 'The pipeline has no active stage.';

  /** The row's currency, when it has one, must be the pipeline's (an export from another one). */
  const currencyError = (row: readonly string[]) => {
    const given = cell(row, mapping.currency).toUpperCase();
    return given && given !== lookups.currency
      ? `The row's currency is ${given.slice(0, 10)}; this pipeline uses ${lookups.currency}.`
      : null;
  };

  const readValue = (
    text: string,
  ): { ok: true; minor: number } | { ok: false; message: string } => {
    const minor = parseAmountToMinor(text, lookups.currency);
    if (minor === null || minor > MAX_DEAL_MINOR) {
      const digits = currencyDigits(lookups.currency);
      return {
        ok: false,
        message:
          digits === 0
            ? `Value must be an amount in ${lookups.currency} as a whole number.`
            : `Value must be an amount in ${lookups.currency} with at most ${digits} decimals.`,
      };
    }
    return { ok: true, minor };
  };

  /** An owner by email, or by name when one member has it (the export writes names). */
  const readOwner = (text: string): { ok: true; id: string } | { ok: false; message: string } => {
    const key = text.toLowerCase();
    const byEmail = lookups.ownersByEmail.get(key);
    if (byEmail) return { ok: true, id: byEmail };
    const byName = lookups.ownersByName.get(key);
    if (byName) return { ok: true, id: byName };
    if (byName === null) {
      return {
        ok: false,
        message: `More than one member is named “${text.slice(0, 80)}”; give the owner's email.`,
      };
    }
    return {
      ok: false,
      message: 'Owner must be the email or the name of an active member who can use the CRM.',
    };
  };

  /** The row's status and lost reason: open (or blank) keeps the deal open. */
  const readClose = (
    row: readonly string[],
  ): { ok: true; close: PlannedClose | null } | { ok: false; message: string } => {
    const status = cell(row, mapping.status).toLowerCase();
    const reason = cell(row, mapping.lostReason);
    if (status !== '' && status !== 'open' && status !== 'won' && status !== 'lost') {
      return { ok: false, message: 'Status must be open, won or lost.' };
    }
    if (reason && status !== 'lost') {
      return { ok: false, message: 'Only a lost deal takes a lost reason.' };
    }
    if (reason.length > 200) {
      return { ok: false, message: 'Lost reason is longer than 200 characters.' };
    }
    return {
      ok: true,
      close:
        status === 'won' || status === 'lost'
          ? { outcome: status, lostReason: reason || null }
          : null,
    };
  };

  const readFields = (
    row: readonly string[],
    current: Readonly<Record<string, AttributeValue>>,
    keepBlank: boolean,
  ): { ok: true; attributes: Record<string, AttributeValue> } | { ok: false; message: string } => {
    const given: Record<string, string> = {};
    for (const [key, index] of Object.entries(mapping.fields)) {
      const value = cell(row, index);
      // On a change, a blank cell leaves the value as it is.
      if (value || !keepBlank) given[key] = value;
    }
    try {
      return {
        ok: true,
        attributes:
          keepBlank && Object.keys(given).length === 0
            ? { ...current }
            : mergedDealAttributes(lookups.fields, current, given),
      };
    } catch (e) {
      if (isAppError(e)) return { ok: false, message: e.publicMessage };
      throw e;
    }
  };

  const planCreate = (row: readonly string[], line: number): RowPlan => {
    if (mapping.phone === null) {
      return fail('A new deal needs its contact’s phone number: choose the phone number column.');
    }
    const phone = normalizePhone(cell(row, mapping.phone), mode);
    if (!phone.ok) return fail(phone.message);
    const contactId = lookups.contactsByPhone.get(phone.e164);
    if (!contactId) {
      return fail('No contact has this phone number. Add or import the contact first.');
    }
    const title = cell(row, mapping.title);
    if (!title) return fail('Title is missing.');
    if (title.length > 120) return fail('Title is longer than 120 characters.');
    const stageName = cell(row, mapping.stage);
    const stageId = stageName ? stageByName.get(stageName.toLowerCase()) : firstStage;
    if (!stageId) return fail(stageError(stageName));
    const currency = currencyError(row);
    if (currency) return fail(currency);
    const valueText = cell(row, mapping.value);
    let valueMinor: number | null = null;
    if (valueText) {
      const value = readValue(valueText);
      if (!value.ok) return fail(value.message);
      valueMinor = value.minor;
    }
    const ownerText = cell(row, mapping.owner);
    let ownerMembershipId: string | null = null;
    if (ownerText) {
      const owner = readOwner(ownerText);
      if (!owner.ok) return fail(owner.message);
      ownerMembershipId = owner.id;
    }
    const closeOn = cell(row, mapping.expectedCloseOn);
    if (closeOn && !validDate(closeOn)) {
      return fail('Expected close date must be a date written as YYYY-MM-DD.');
    }
    const fields = readFields(row, {}, false);
    if (!fields.ok) return fail(fields.message);
    const close = readClose(row);
    if (!close.ok) return fail(close.message);
    return {
      kind: 'create',
      deal: {
        line,
        contactId,
        stageId,
        title,
        valueMinor,
        ownerMembershipId,
        expectedCloseOn: closeOn || null,
        attributes: fields.attributes,
        close: close.close,
      },
    };
  };

  const planUpdate = (row: readonly string[], line: number, idText: string): RowPlan => {
    if (!DEAL_ID_RE.test(idText)) {
      return fail('Deal id must be the id of a deal, as the deals export writes it.');
    }
    const id = idText.toLowerCase();
    const deal = lookups.deals.get(id);
    if (!deal) return fail('The company has no deal with this id.');
    const earlier = claimed.get(id);
    if (earlier !== undefined) return fail(`Row ${earlier} already changes this deal.`);
    if (deal.pipelineId !== lookups.pipelineId) {
      return fail('This deal is in another pipeline: choose its pipeline to change it.');
    }
    if (deal.status !== 'open') {
      return fail(`This deal is ${deal.status}: reopen it on its page to change it.`);
    }
    if (deal.contactErased) {
      return fail('The contact was erased; this deal can no longer be edited.');
    }
    if (lookups.expectedVersions) {
      const expected = lookups.expectedVersions.get(id);
      if (expected === undefined) {
        return fail('This deal was not among the rows checked. Check the rows again.');
      }
      if (expected !== deal.version) {
        return fail('Someone changed this deal after the rows were checked. Check the rows again.');
      }
    }
    const titleText = cell(row, mapping.title);
    if (titleText.length > 120) return fail('Title is longer than 120 characters.');
    const stageName = cell(row, mapping.stage);
    let stageId = deal.stageId;
    if (stageName) {
      const named = stageByName.get(stageName.toLowerCase());
      if (!named) return fail(stageError(stageName));
      stageId = named;
    }
    const currency = currencyError(row);
    if (currency) return fail(currency);
    const valueText = cell(row, mapping.value);
    let valueMinor = deal.valueMinor;
    if (valueText) {
      const value = readValue(valueText);
      if (!value.ok) return fail(value.message);
      valueMinor = value.minor;
    }
    const ownerText = cell(row, mapping.owner);
    let ownerMembershipId = deal.ownerMembershipId;
    const currentOwner = deal.ownerMembershipId
      ? (lookups.memberAliases.get(deal.ownerMembershipId) ?? [])
      : [];
    // The deal's owner as it is, even one who has left (as an export of the deal names them).
    if (ownerText && !currentOwner.includes(ownerText.toLowerCase())) {
      const owner = readOwner(ownerText);
      if (!owner.ok) return fail(owner.message);
      ownerMembershipId = owner.id;
    }
    const closeOn = cell(row, mapping.expectedCloseOn);
    if (closeOn && !validDate(closeOn)) {
      return fail('Expected close date must be a date written as YYYY-MM-DD.');
    }
    const attributes = readFields(row, deal.attributes, true);
    if (!attributes.ok) return fail(attributes.message);
    const close = readClose(row);
    if (!close.ok) return fail(close.message);
    const title = titleText || deal.title;
    const expectedCloseOn = closeOn || deal.expectedCloseOn;
    const fields: string[] = [];
    if (title !== deal.title) fields.push('title');
    if (valueMinor !== deal.valueMinor) fields.push('value');
    if (expectedCloseOn !== deal.expectedCloseOn) fields.push('expected_close_on');
    if (!sameAttributes(attributes.attributes, deal.attributes)) fields.push('custom_fields');
    claimed.set(id, line);
    versions[id] = deal.version;
    if (
      stageId === deal.stageId &&
      fields.length === 0 &&
      ownerMembershipId === deal.ownerMembershipId &&
      close.close === null
    ) {
      return { kind: 'unchanged', deal };
    }
    return {
      kind: 'update',
      update: {
        line,
        deal,
        stageId,
        title,
        valueMinor,
        ownerMembershipId,
        expectedCloseOn,
        attributes: attributes.attributes,
        fields,
        close: close.close,
      },
    };
  };

  rows.forEach((row, i) => {
    const line = i + 2;
    const idText = dealIdCell(row, mapping);
    const plan = idText ? planUpdate(row, line, idText) : planCreate(row, line);
    switch (plan.kind) {
      case 'error':
        messages.push({ row: line, level: 'error', message: plan.message });
        outcomes.push({
          row: line,
          action: 'skip',
          close: null,
          dealId: null,
          title: null,
          message: plan.message,
        });
        return;
      case 'create':
        deals.push(plan.deal);
        outcomes.push({
          row: line,
          action: 'create',
          close: plan.deal.close?.outcome ?? null,
          dealId: null,
          title: plan.deal.title,
          message: null,
        });
        return;
      case 'update':
        updates.push(plan.update);
        outcomes.push({
          row: line,
          action: 'update',
          close: plan.update.close?.outcome ?? null,
          dealId: plan.update.deal.id,
          title: plan.update.title,
          message: null,
        });
        return;
      case 'unchanged':
        outcomes.push({
          row: line,
          action: 'unchanged',
          close: null,
          dealId: plan.deal.id,
          title: plan.deal.title,
          message: null,
        });
    }
  });
  return { deals, updates, messages, rows: outcomes, versions };
}

/** The counts of a plan, as the check shows them and the import reports and audits them. */
export function dealImportCounts(rows: readonly DealImportRow[]): DealImportCounts {
  const count = (pick: (row: DealImportRow) => boolean) => rows.filter(pick).length;
  return {
    created: count((r) => r.action === 'create'),
    updated: count((r) => r.action === 'update'),
    closed: count((r) => r.close !== null),
    unchanged: count((r) => r.action === 'unchanged'),
    errorCount: count((r) => r.action === 'skip'),
  };
}

/** The timeline entries of a change, in the order the API records a combined change (ADR-255). */
export function updateActivities(
  update: PlannedUpdate,
): { kind: CrmActivityKind; data: Record<string, unknown> }[] {
  const { deal } = update;
  const entries: { kind: CrmActivityKind; data: Record<string, unknown> }[] = [];
  if (update.stageId !== deal.stageId) {
    entries.push({
      kind: 'stage_changed',
      data: { fromStageId: deal.stageId, toStageId: update.stageId },
    });
  }
  if (update.fields.length > 0) {
    entries.push({
      kind: 'deal_updated',
      data: {
        fields: update.fields,
        ...(update.fields.includes('value')
          ? { valueFrom: deal.valueMinor, valueTo: update.valueMinor }
          : {}),
      },
    });
  }
  if (update.ownerMembershipId !== deal.ownerMembershipId) {
    entries.push({
      kind: 'owner_changed',
      data: { from: deal.ownerMembershipId, to: update.ownerMembershipId },
    });
  }
  if (update.close) entries.push(closeActivity(update.close, update.valueMinor));
  return entries.map((entry) => ({ ...entry, data: { ...entry.data, imported: true } }));
}

/** A close's timeline entry, as the deal page's close action writes it. */
function closeActivity(
  close: PlannedClose,
  valueMinor: number | null,
): { kind: CrmActivityKind; data: Record<string, unknown> } {
  return close.outcome === 'won'
    ? { kind: 'deal_won', data: { valueMinor } }
    : { kind: 'deal_lost', data: {} };
}

function readCsv(text: string): ParsedCsv {
  try {
    return parseCsv(text, DEAL_IMPORT_LIMITS);
  } catch (error) {
    if (error instanceof CsvError) throw new AppError('validation_failed', error.message);
    throw error;
  }
}

/** The export's products columns (ADR-375, ADR-380) are never suggested: products are not imported. */
const PRODUCT_COLUMNS = new Set(['products', 'products_total']);

function suggestColumn(headers: readonly string[], pattern: RegExp): number | null {
  const index = headers.findIndex((h) => {
    const name = h.trim().toLowerCase();
    return !PRODUCT_COLUMNS.has(name) && pattern.test(name);
  });
  return index >= 0 ? index : null;
}

/** Rows inserted per statement. */
const INSERT_BATCH = 200;

type ParsedOptions = z.output<typeof dealImportSchema>;

function parseOptions(input: Record<string, unknown>): ParsedOptions {
  const opts = parseInput(dealImportSchema, input);
  if (opts.phoneFormat === 'national' && !opts.callingCode) {
    throw new AppError('validation_failed', 'Enter the country calling code for national numbers.');
  }
  return opts;
}

function readRows(opts: ParsedOptions, text: string): ParsedCsv {
  const csv = readCsv(text);
  if (csv.rows.length === 0) throw new AppError('validation_failed', 'The file has no data rows.');
  const { mapping } = opts;
  const columns = [
    mapping.dealId,
    mapping.phone,
    mapping.title,
    mapping.stage,
    mapping.value,
    mapping.currency,
    mapping.owner,
    mapping.expectedCloseOn,
    mapping.status,
    mapping.lostReason,
    ...Object.values(mapping.fields),
  ].filter((c): c is number => c !== null);
  if (columns.some((c) => c >= csv.headers.length)) {
    throw new AppError('validation_failed', 'The column mapping does not match the file.');
  }
  return csv;
}

/**
 * The company's records the rows are checked against, and the plan. For the import (`lock`), in the
 * order members' writes and erasure take them: the contacts of the rows (new deals' and changed
 * deals') against erasure, then the pipeline against archiving, then the deal fields against
 * deletion, then the deals named, FOR UPDATE, as the deal page's edit locks fields, contact and deal.
 * The check takes no lock (a read-only transaction).
 */
async function planImport(
  tx: Tx,
  ctx: TenantContext,
  opts: ParsedOptions,
  csv: ParsedCsv,
  lock: boolean,
) {
  const tenantId = ctx.tenant.id;
  const { mapping } = opts;
  const mode = phoneMode(opts);
  const phones = importedPhones(csv.rows, mapping, mode);
  const dealIds = importedDealIds(csv.rows, mapping);
  // A deal's contact never changes, so reading it before the locks is safe (lockDealForChange).
  const refs =
    dealIds.length === 0
      ? []
      : await tx
          .select({ contactId: crmDeals.contactId })
          .from(crmDeals)
          .where(and(eq(crmDeals.tenantId, tenantId), inArray(crmDeals.id, dealIds)));
  const dealContacts = [...new Set(refs.map((r) => r.contactId))];
  let contactRows: { id: string; phone: string | null; erasedAt: Date | null }[] = [];
  if (phones.length > 0 || dealContacts.length > 0) {
    // Contacts first, in one order, as a member's new deal and erasure lock them (ADR-373).
    const query = tx
      .select({ id: contacts.id, phone: contacts.phoneE164, erasedAt: contacts.erasedAt })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          or(
            phones.length > 0
              ? and(inArray(contacts.phoneE164, phones), isNull(contacts.erasedAt))
              : undefined,
            dealContacts.length > 0 ? inArray(contacts.id, dealContacts) : undefined,
          ),
        ),
      )
      .orderBy(asc(contacts.id));
    contactRows = lock ? await query.for('key share') : await query;
  }
  const pipelineQuery = tx
    .select({ archivedAt: crmPipelines.archivedAt, currency: crmPipelines.currency })
    .from(crmPipelines)
    .where(and(eq(crmPipelines.tenantId, tenantId), eq(crmPipelines.id, opts.pipelineId)));
  const [pipeline] = lock ? await pipelineQuery.for('share') : await pipelineQuery;
  if (!pipeline) throw new AppError('validation_failed', 'Choose a pipeline.');
  if (pipeline.archivedAt) throw new AppError('conflict', 'This pipeline is archived.');
  const stages = await tx
    .select({ id: crmStages.id, name: crmStages.name })
    .from(crmStages)
    .where(
      and(
        eq(crmStages.tenantId, tenantId),
        eq(crmStages.pipelineId, opts.pipelineId),
        isNull(crmStages.archivedAt),
      ),
    )
    .orderBy(asc(crmStages.position));
  const fields = lock ? await lockedDealFields(tx, tenantId) : await loadDealFields(tx, tenantId);
  for (const key of Object.keys(mapping.fields)) {
    if (!fields.some((f) => f.key === key)) {
      throw new AppError(
        'validation_failed',
        'The mapping names a deal field the company does not have.',
      );
    }
  }
  const members = await tx
    .select({
      id: memberships.id,
      roles: memberships.roles,
      status: memberships.status,
      email: users.email,
      name: sql<string>`coalesce(${memberships.displayName}, ${users.name})`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId));
  const owners = members.filter(
    (m) => m.status === 'active' && permissionsForRoles(m.roles).has('crm.read'),
  );
  const ownersByName = new Map<string, string | null>();
  for (const m of owners) {
    const name = m.name.trim().toLowerCase();
    ownersByName.set(name, ownersByName.has(name) ? null : m.id);
  }
  let dealRows: (typeof crmDeals.$inferSelect)[] = [];
  if (dealIds.length > 0) {
    const query = tx
      .select()
      .from(crmDeals)
      .where(and(eq(crmDeals.tenantId, tenantId), inArray(crmDeals.id, dealIds)))
      .orderBy(asc(crmDeals.id));
    dealRows = lock ? await query.for('update') : await query;
  }
  const erased = new Set(contactRows.filter((c) => c.erasedAt !== null).map((c) => c.id));
  const wantedPhones = new Set(phones);
  const plan = planDealRows(csv.rows, mapping, mode, {
    pipelineId: opts.pipelineId,
    currency: pipeline.currency,
    stages,
    contactsByPhone: new Map(
      contactRows.flatMap((c) =>
        c.phone && c.erasedAt === null && wantedPhones.has(c.phone)
          ? [[c.phone, c.id] as const]
          : [],
      ),
    ),
    ownersByEmail: new Map(owners.map((m) => [m.email.toLowerCase(), m.id])),
    ownersByName,
    memberAliases: new Map(
      members.map((m) => [m.id, [m.email.toLowerCase(), m.name.trim().toLowerCase()]]),
    ),
    fields,
    deals: new Map(
      dealRows.map((d) => [
        d.id,
        {
          id: d.id,
          pipelineId: d.pipelineId,
          stageId: d.stageId,
          contactId: d.contactId,
          status: d.status,
          title: d.title,
          valueMinor: d.valueMinor,
          ownerMembershipId: d.ownerMembershipId,
          expectedCloseOn: d.expectedCloseOn,
          attributes: d.attributes,
          version: d.version,
          contactErased: erased.has(d.contactId),
        },
      ]),
    ),
    expectedVersions: lock ? new Map(Object.entries(opts.expectedVersions)) : null,
  });
  return plan;
}

/**
 * Deal import (ADR-374, ADR-387): for owners, administrators and supervisors, who may both change
 * deals and import contacts (`crm.write` and `contacts.import`).
 */
export function dealImportOperations(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;
  return {
    /** The file's columns, its first rows and the columns that look like each detail. */
    async previewDealImport(ctx: TenantContext, input: { fileName: string; text: string }) {
      assertCan(ctx, 'crm.write');
      assertCan(ctx, 'contacts.import');
      const csv = readCsv(input.text);
      if (csv.rows.length === 0)
        throw new AppError('validation_failed', 'The file has no data rows.');
      const fields = await db.run(ctx.scope, (tx) => loadDealFields(tx, ctx.tenant.id), {
        accessMode: 'read only',
      });
      const headers = csv.headers;
      const suggestedFields: Record<string, number> = {};
      for (const field of fields) {
        // The last match: the export writes custom fields after its own columns, by key.
        const index = headers.findLastIndex((h) => {
          const n = h.trim().toLowerCase();
          return n === field.key || n === field.label.trim().toLowerCase();
        });
        if (index >= 0) suggestedFields[field.key] = index;
      }
      return {
        fileName: input.fileName.slice(0, 200),
        headers,
        sample: csv.rows.slice(0, 5).map((r) => r.map(restoreCell)),
        totalRows: csv.rows.length,
        fields: fields.map((f) => ({ key: f.key, label: f.label, type: f.type })),
        suggested: {
          dealId: suggestColumn(headers, /^deal.?id$/),
          phone: suggestColumn(headers, /phone|mobile|whatsapp|msisdn|number/),
          title: suggestColumn(headers, /^title$|deal.?(name|title)|^name$|subject/),
          stage: suggestColumn(headers, /stage/),
          value: suggestColumn(headers, /value|amount|price|total/),
          currency: suggestColumn(headers, /^currency$/),
          owner: suggestColumn(headers, /owner|assignee|rep|e-?mail/),
          expectedCloseOn: suggestColumn(headers, /close|due|expected/),
          status: suggestColumn(headers, /^(deal.?)?status$|outcome/),
          lostReason: suggestColumn(headers, /lost.?reason/),
          fields: suggestedFields,
        },
      };
    },

    /**
     * What each row would do, before anything is written (ADR-387): add a deal (closed or not),
     * change a deal (and close it), leave it as it is, or be skipped, and why. Read-only; the
     * versions of the deals named are returned to be sent with the import.
     */
    async checkDealImport(
      ctx: TenantContext,
      input: { text: string } & Record<string, unknown>,
    ): Promise<DealImportCheck> {
      assertCan(ctx, 'crm.write');
      assertCan(ctx, 'contacts.import');
      const opts = parseOptions(input);
      const csv = readRows(opts, input.text);
      const plan = await db.run(ctx.scope, (tx) => planImport(tx, ctx, opts, csv, false), {
        accessMode: 'read only',
      });
      return {
        totalRows: csv.rows.length,
        ...dealImportCounts(plan.rows),
        rows: plan.rows,
        expectedVersions: plan.versions,
      };
    },

    /**
     * Imports the file in one transaction (locks as `planImport` says). Every new deal is recorded
     * as the member's, with a `deal_created` timeline entry marked as imported; a closed one is then
     * closed by the member, now, with its `deal_won` or `deal_lost` entry. Every change is the
     * member's, with the entries the deal page's move, edit and close write, marked as imported,
     * and a new version. The import is audited with its counts.
     */
    async importDeals(
      ctx: TenantContext,
      input: { text: string } & Record<string, unknown>,
      meta: RequestMeta = {},
    ): Promise<DealImportResult> {
      assertCan(ctx, 'crm.write');
      assertCan(ctx, 'contacts.import');
      const opts = parseOptions(input);
      const csv = readRows(opts, input.text);

      return db.run(ctx.scope, async (tx) => {
        const { deals, updates, messages, rows } = await planImport(tx, ctx, opts, csv, true);
        const tenantId = ctx.tenant.id;
        const now = clock.now();
        const created = deals.map((d) => ({ ...d, id: uuidv7() }));
        for (let start = 0; start < created.length; start += INSERT_BATCH) {
          const batch = created.slice(start, start + INSERT_BATCH);
          await tx.insert(crmDeals).values(
            batch.map((d) => ({
              id: d.id,
              tenantId,
              pipelineId: opts.pipelineId,
              stageId: d.stageId,
              contactId: d.contactId,
              conversationId: null,
              title: d.title,
              valueMinor: d.valueMinor,
              ownerMembershipId: d.ownerMembershipId,
              expectedCloseOn: d.expectedCloseOn,
              attributes: d.attributes,
              stageEnteredAt: now,
              createdByMembershipId: ctx.membership.id,
            })),
          );
          await tx.insert(crmActivities).values(
            batch.map((d) => ({
              id: uuidv7(),
              tenantId,
              contactId: d.contactId,
              dealId: d.id,
              taskId: null,
              actorMembershipId: ctx.membership.id,
              kind: 'deal_created' as const,
              data: { stageId: d.stageId, valueMinor: d.valueMinor, imported: true },
              body: null,
              createdAt: now,
            })),
          );
        }
        // New deals closed in the file: closed as the deal page closes them, after being added.
        for (const d of created) {
          if (!d.close) continue;
          await tx
            .update(crmDeals)
            .set({
              status: d.close.outcome,
              closedAt: now,
              closedByMembershipId: ctx.membership.id,
              lostReason: d.close.lostReason,
              version: 2,
              ...crmChangedBy('member'),
            })
            .where(and(eq(crmDeals.tenantId, tenantId), eq(crmDeals.id, d.id)));
          const entry = closeActivity(d.close, d.valueMinor);
          await tx.insert(crmActivities).values({
            id: uuidv7(),
            tenantId,
            contactId: d.contactId,
            dealId: d.id,
            taskId: null,
            actorMembershipId: ctx.membership.id,
            kind: entry.kind,
            data: { ...entry.data, imported: true },
            body: null,
            createdAt: now,
          });
        }
        for (const u of updates) {
          await tx
            .update(crmDeals)
            .set({
              stageId: u.stageId,
              ...(u.stageId !== u.deal.stageId ? { stageEnteredAt: now } : {}),
              title: u.title,
              valueMinor: u.valueMinor,
              ownerMembershipId: u.ownerMembershipId,
              expectedCloseOn: u.expectedCloseOn,
              attributes: u.attributes,
              ...(u.close
                ? {
                    status: u.close.outcome,
                    closedAt: now,
                    closedByMembershipId: ctx.membership.id,
                    lostReason: u.close.lostReason,
                  }
                : {}),
              version: u.deal.version + 1,
              ...crmChangedBy('member'),
            })
            .where(and(eq(crmDeals.tenantId, tenantId), eq(crmDeals.id, u.deal.id)));
          const entries = updateActivities(u);
          await tx.insert(crmActivities).values(
            entries.map((entry) => ({
              id: uuidv7(),
              tenantId,
              contactId: u.deal.contactId,
              dealId: u.deal.id,
              taskId: null,
              actorMembershipId: ctx.membership.id,
              kind: entry.kind,
              data: entry.data,
              body: null,
              createdAt: now,
            })),
          );
        }
        const result: DealImportResult = {
          totalRows: csv.rows.length,
          ...dealImportCounts(rows),
          messages,
        };
        await recordAudit(
          tx,
          ctx,
          {
            action: 'crm.deals_imported',
            subjectType: 'crm_pipeline',
            subjectId: opts.pipelineId,
            metadata: {
              fileName: opts.fileName,
              totalRows: result.totalRows,
              created: result.created,
              updated: result.updated,
              closed: result.closed,
              unchanged: result.unchanged,
              skipped: result.errorCount,
              errorCount: result.errorCount,
            },
          },
          meta,
        );
        return result;
      });
    },
  };
}
