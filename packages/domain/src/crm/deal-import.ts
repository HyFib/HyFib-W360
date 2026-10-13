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
  users,
  type Database,
  type ImportRowMessage,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { permissionsForRoles } from '../authz/permissions';
import { assertCan, type TenantContext } from '../authz/context';
import { CsvError, parseCsv, restoreCell, type CsvLimits, type ParsedCsv } from '../contacts/csv';
import { validDate, type AttributeValue } from '../contacts/fields';
import { CALLING_CODE_RE, normalizePhone, type PhoneInputMode } from '../contacts/phone';
import { parseInput } from '../validation';
import {
  loadDealFields,
  lockedDealFields,
  mergedDealAttributes,
  type DealFieldDefinition,
} from './deal-fields';
import { currencyDigits, MAX_DEAL_MINOR, parseAmountToMinor } from './money';

/**
 * Deals imported from CSV into one pipeline (ADR-374): each row a deal for a contact the company
 * already has, found by phone number, with a title and optionally a stage (by name), a value in the
 * pipeline's currency, an owner (by the member's email), an expected close date and custom field
 * values (ADR-373). One transaction: rows with errors are skipped and listed by row number, the
 * rest are added as members add deals, each with its timeline entry, and the import is audited.
 */

/** A smaller file than contacts take: every row adds a deal, a timeline entry and a webhook event. */
export const DEAL_IMPORT_LIMITS: CsvLimits = {
  // Server actions accept request bodies up to 1 MB (apps/web next.config.ts), multipart included.
  maxBytes: 1_000_000 - 24_000,
  maxRows: 1000,
  maxColumns: 50,
  maxFieldLength: 1000,
};

const column = z.number().int().min(0);

export const dealImportSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  pipelineId: z.uuid('Choose a pipeline.'),
  phoneFormat: z.enum(['international', 'national']),
  callingCode: z
    .string()
    .regex(CALLING_CODE_RE, 'Enter a country calling code such as 91')
    .optional(),
  mapping: z.object({
    phone: column,
    title: column,
    stage: column.nullable().default(null),
    value: column.nullable().default(null),
    owner: column.nullable().default(null),
    expectedCloseOn: column.nullable().default(null),
    fields: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), column).default({}),
  }),
});
export type DealImportOptions = z.input<typeof dealImportSchema>;

export interface DealImportResult {
  totalRows: number;
  created: number;
  errorCount: number;
  messages: ImportRowMessage[];
}

/** What the rows are checked against: the company's records, found before planning. */
export interface DealImportLookups {
  currency: string;
  /** Active stages of the pipeline by lower-cased name, in order; the first takes rows without one. */
  stages: readonly { id: string; name: string }[];
  /** Live contacts by E.164 number. */
  contactsByPhone: ReadonlyMap<string, string>;
  /** Active members who can use the CRM, by lower-cased email. */
  ownersByEmail: ReadonlyMap<string, string>;
  fields: readonly DealFieldDefinition[];
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

/** The numbers the rows name that are valid, to find their contacts in one query. */
export function importedPhones(
  rows: readonly (readonly string[])[],
  mapping: Mapping,
  mode: PhoneInputMode,
): string[] {
  const phones = new Set<string>();
  for (const row of rows) {
    const phone = normalizePhone(cell(row, mapping.phone), mode);
    if (phone.ok) phones.add(phone.e164);
  }
  return [...phones];
}

/**
 * The rows checked against the company's records: a deal planned for each valid row, a message
 * naming the row (counted from 2, after the header) and the problem for each other.
 */
export function planDealRows(
  rows: readonly (readonly string[])[],
  mapping: Mapping,
  mode: PhoneInputMode,
  lookups: DealImportLookups,
): { deals: PlannedDeal[]; messages: ImportRowMessage[] } {
  const deals: PlannedDeal[] = [];
  const messages: ImportRowMessage[] = [];
  const stageByName = new Map(lookups.stages.map((s) => [s.name.trim().toLowerCase(), s.id]));
  const firstStage = lookups.stages[0]?.id;
  rows.forEach((row, i) => {
    const line = i + 2;
    const error = (message: string) => {
      messages.push({ row: line, level: 'error', message });
    };
    const phone = normalizePhone(cell(row, mapping.phone), mode);
    if (!phone.ok) return error(phone.message);
    const contactId = lookups.contactsByPhone.get(phone.e164);
    if (!contactId) {
      return error('No contact has this phone number. Add or import the contact first.');
    }
    const title = cell(row, mapping.title);
    if (!title) return error('Title is missing.');
    if (title.length > 120) return error('Title is longer than 120 characters.');
    const stageName = cell(row, mapping.stage);
    const stageId = stageName ? stageByName.get(stageName.toLowerCase()) : firstStage;
    if (!stageId) {
      return error(
        stageName
          ? `The pipeline has no stage named “${stageName.slice(0, 80)}”.`
          : 'The pipeline has no active stage.',
      );
    }
    const valueText = cell(row, mapping.value);
    let valueMinor: number | null = null;
    if (valueText) {
      valueMinor = parseAmountToMinor(valueText, lookups.currency);
      if (valueMinor === null || valueMinor > MAX_DEAL_MINOR) {
        const digits = currencyDigits(lookups.currency);
        return error(
          digits === 0
            ? `Value must be an amount in ${lookups.currency} as a whole number.`
            : `Value must be an amount in ${lookups.currency} with at most ${digits} decimals.`,
        );
      }
    }
    const ownerEmail = cell(row, mapping.owner).toLowerCase();
    let ownerMembershipId: string | null = null;
    if (ownerEmail) {
      ownerMembershipId = lookups.ownersByEmail.get(ownerEmail) ?? null;
      if (!ownerMembershipId) {
        return error('Owner must be the email of an active member who can use the CRM.');
      }
    }
    const closeOn = cell(row, mapping.expectedCloseOn);
    if (closeOn && !validDate(closeOn)) {
      return error('Expected close date must be a date written as YYYY-MM-DD.');
    }
    const given: Record<string, string> = {};
    for (const [key, index] of Object.entries(mapping.fields)) given[key] = cell(row, index);
    let attributes: Record<string, AttributeValue>;
    try {
      attributes = mergedDealAttributes(lookups.fields, {}, given);
    } catch (e) {
      if (isAppError(e)) return error(e.publicMessage);
      throw e;
    }
    deals.push({
      line,
      contactId,
      stageId,
      title,
      valueMinor,
      ownerMembershipId,
      expectedCloseOn: closeOn || null,
      attributes,
    });
  });
  return { deals, messages };
}

function readCsv(text: string): ParsedCsv {
  try {
    return parseCsv(text, DEAL_IMPORT_LIMITS);
  } catch (error) {
    if (error instanceof CsvError) throw new AppError('validation_failed', error.message);
    throw error;
  }
}

function suggestColumn(headers: readonly string[], pattern: RegExp): number | null {
  const index = headers.findIndex((h) => pattern.test(h.trim().toLowerCase()));
  return index >= 0 ? index : null;
}

/** Rows inserted per statement. */
const INSERT_BATCH = 200;

/**
 * Deal import (ADR-374): for owners, administrators and supervisors, who may both change deals and
 * import contacts (`crm.write` and `contacts.import`).
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
        const index = headers.findIndex((h) => {
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
          phone: suggestColumn(headers, /phone|mobile|whatsapp|msisdn|number/),
          title: suggestColumn(headers, /^title$|deal.?(name|title)|^name$|subject/),
          stage: suggestColumn(headers, /stage|status/),
          value: suggestColumn(headers, /value|amount|price|total/),
          owner: suggestColumn(headers, /owner|assignee|rep|e-?mail/),
          expectedCloseOn: suggestColumn(headers, /close|due|expected/),
          fields: suggestedFields,
        },
      };
    },

    /**
     * Imports the file's deals into the pipeline in one transaction. Contacts are locked against
     * erasure (key share) before the deal fields, as a member's new deal locks them; the pipeline is
     * locked against archiving. Every imported deal is recorded as the member's, with a
     * `deal_created` timeline entry marked as imported; the import is audited with its counts.
     */
    async importDeals(
      ctx: TenantContext,
      input: { text: string } & Record<string, unknown>,
      meta: RequestMeta = {},
    ): Promise<DealImportResult> {
      assertCan(ctx, 'crm.write');
      assertCan(ctx, 'contacts.import');
      const opts = parseInput(dealImportSchema, input);
      if (opts.phoneFormat === 'national' && !opts.callingCode) {
        throw new AppError(
          'validation_failed',
          'Enter the country calling code for national numbers.',
        );
      }
      const csv = readCsv(input.text);
      if (csv.rows.length === 0)
        throw new AppError('validation_failed', 'The file has no data rows.');
      const { mapping } = opts;
      const columns = [
        mapping.phone,
        mapping.title,
        mapping.stage,
        mapping.value,
        mapping.owner,
        mapping.expectedCloseOn,
        ...Object.values(mapping.fields),
      ].filter((c): c is number => c !== null);
      if (columns.some((c) => c >= csv.headers.length)) {
        throw new AppError('validation_failed', 'The column mapping does not match the file.');
      }
      const mode = phoneMode(opts);
      const phones = importedPhones(csv.rows, mapping, mode);

      return db.run(ctx.scope, async (tx) => {
        // Contacts first, in one order, as a member's new deal and erasure lock them (ADR-373).
        const contactRows =
          phones.length === 0
            ? []
            : await tx
                .select({ id: contacts.id, phone: contacts.phoneE164 })
                .from(contacts)
                .where(
                  and(
                    eq(contacts.tenantId, ctx.tenant.id),
                    inArray(contacts.phoneE164, phones),
                    isNull(contacts.erasedAt),
                  ),
                )
                .orderBy(asc(contacts.id))
                .for('key share');
        const [pipeline] = await tx
          .select({ archivedAt: crmPipelines.archivedAt, currency: crmPipelines.currency })
          .from(crmPipelines)
          .where(
            and(eq(crmPipelines.tenantId, ctx.tenant.id), eq(crmPipelines.id, opts.pipelineId)),
          )
          .for('share');
        if (!pipeline) throw new AppError('validation_failed', 'Choose a pipeline.');
        if (pipeline.archivedAt) throw new AppError('conflict', 'This pipeline is archived.');
        const stages = await tx
          .select({ id: crmStages.id, name: crmStages.name })
          .from(crmStages)
          .where(
            and(
              eq(crmStages.tenantId, ctx.tenant.id),
              eq(crmStages.pipelineId, opts.pipelineId),
              isNull(crmStages.archivedAt),
            ),
          )
          .orderBy(asc(crmStages.position));
        const fields = await lockedDealFields(tx, ctx.tenant.id);
        for (const key of Object.keys(mapping.fields)) {
          if (!fields.some((f) => f.key === key)) {
            throw new AppError(
              'validation_failed',
              'The mapping names a deal field the company does not have.',
            );
          }
        }
        const members = await tx
          .select({ id: memberships.id, roles: memberships.roles, email: users.email })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.status, 'active')));
        const ownersByEmail = new Map(
          members
            .filter((m) => permissionsForRoles(m.roles).has('crm.read'))
            .map((m) => [m.email.toLowerCase(), m.id]),
        );
        const contactsByPhone = new Map(
          contactRows.flatMap((c) => (c.phone ? [[c.phone, c.id] as const] : [])),
        );
        const { deals, messages } = planDealRows(csv.rows, mapping, mode, {
          currency: pipeline.currency,
          stages,
          contactsByPhone,
          ownersByEmail,
          fields,
        });

        const now = clock.now();
        for (let start = 0; start < deals.length; start += INSERT_BATCH) {
          const batch = deals
            .slice(start, start + INSERT_BATCH)
            .map((d) => ({ ...d, id: uuidv7() }));
          await tx.insert(crmDeals).values(
            batch.map((d) => ({
              id: d.id,
              tenantId: ctx.tenant.id,
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
              tenantId: ctx.tenant.id,
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
        const result: DealImportResult = {
          totalRows: csv.rows.length,
          created: deals.length,
          errorCount: messages.filter((m) => m.level === 'error').length,
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
