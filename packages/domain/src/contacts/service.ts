import { z } from 'zod';
import { AppError, clipText, jsonbText, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  channelAccounts,
  contactConsents,
  contactFields,
  contactIdentities,
  contactImports,
  contacts,
  contactTags,
  conversations,
  CONTACT_FIELD_TYPES,
  desc,
  eq,
  exactTimestamp,
  inArray,
  isNull,
  outerColumn,
  sql,
  whatsappAccounts,
  type ContactFieldType,
  type ContactSource,
  type Database,
  type ImportRowMessage,
  type SQL,
  type Tx,
} from '@w360/db';
import { NUMBERS_HIDDEN, assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { recordConsentEvents, type ConsentEventInput } from '../consent/service';
import { SERVICE_WINDOW_MS, canSeeConversation } from '../messaging/outbound';
import {
  chunks,
  decodeKeysetCursor,
  encodeKeysetCursor,
  likePattern,
  parseInput,
} from '../validation';
import type { BulkFieldResult } from './bulk-fields';
import { BULK_TAG_LIMIT, type BulkTagResult } from './bulk-tags';
import { CsvError, CSV_BOM, csvLine, parseCsv, restoreCell, type CsvLimits } from './csv';
import {
  createContactField,
  deleteContactField,
  lockContactFieldValues,
  renameContactField,
  setContactFieldOptions,
} from './field-definitions';
import {
  MAX_CONTACT_FIELDS,
  MAX_TAGS_PER_CONTACT,
  coerceFieldValue,
  fieldOptionsSchema,
  normalizeEmail,
  normalizeTag,
  parseConsentCell,
  refineFieldOptions,
  sameOptions,
  type AttributeValue,
} from './fields';
import { seesNumbers, shownNumber } from './number-masking';
import { CALLING_CODE_RE, normalizePhone, type PhoneInputMode } from './phone';

/**
 * Contacts: one record per phone number per company. Manual entry, CSV import and inbound WhatsApp
 * messages all resolve to the same contact (unique index on the number; inbound identities link
 * to an existing contact with the same number).
 */
export const IMPORT_LIMITS: CsvLimits = {
  // Server actions accept request bodies up to 1 MB (apps/web next.config.ts), multipart included.
  maxBytes: 1_000_000 - 24_000,
  maxRows: 5000,
  maxColumns: 50,
  maxFieldLength: 1000,
};
const MAX_STORED_IMPORT_MESSAGES = 300;
const MAX_EXPORT_ROWS = 100_000;

export interface ContactListItem {
  id: string;
  displayName: string | null;
  phoneE164: string | null;
  email: string | null;
  source: ContactSource;
  tags: string[];
  marketing: 'opted_in' | 'opted_out' | null;
  utility: 'opted_in' | 'opted_out' | null;
  createdAt: Date;
}

export const contactFilterSchema = z.object({
  q: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(40).optional(),
  consent: z
    .enum(['any', 'marketing_opted_in', 'marketing_opted_out', 'marketing_unknown'])
    .default('any'),
});

/** A bulk tag edit (ADR-213): the filters, the tag, and how many contacts the member was shown. */
export const bulkTagSchema = z.object({
  filter: contactFilterSchema,
  tag: z.string().max(100),
  action: z.enum(['add', 'remove']),
  expectedCount: z.number().int().min(1).max(BULK_TAG_LIMIT),
});

/**
 * A bulk field edit (ADR-238): the filters, the field's key, the value as a member types it (empty
 * clears the field), and how many contacts the member was shown.
 */
export const bulkFieldSchema = z.object({
  filter: contactFilterSchema,
  key: z.string().max(40),
  value: z.string().max(1000),
  expectedCount: z.number().int().min(1).max(BULK_TAG_LIMIT),
});

export const listContactsSchema = contactFilterSchema.extend({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

export const createContactSchema = z.object({
  displayName: optionalText(200),
  phone: z.string().max(40),
  email: z.string().max(254).optional(),
  attributes: z.record(z.string(), z.string().max(1000)).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
});

export const updateContactSchema = z.object({
  displayName: optionalText(200),
  phone: z.string().max(40).optional(),
  email: z.string().max(254).optional(),
  attributes: z.record(z.string(), z.string().max(1000)).optional(),
});

const fieldLabelSchema = z.string().trim().min(1, 'Enter a label').max(80);

export const createFieldSchema = z
  .object({
    label: fieldLabelSchema,
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lower-case letters, digits and underscores')
      .optional(),
    type: z.enum(CONTACT_FIELD_TYPES, {
      error: 'Choose the type: text, number, date, yes/no or a choice.',
    }),
    /** A choice field's options (ADR-407); other types take none. */
    options: fieldOptionsSchema.optional(),
  })
  .superRefine(refineFieldOptions);

export const importMappingSchema = z.object({
  phone: z.number().int().min(0),
  name: z.number().int().min(0).nullable().default(null),
  email: z.number().int().min(0).nullable().default(null),
  tags: z.number().int().min(0).nullable().default(null),
  marketingConsent: z.number().int().min(0).nullable().default(null),
  fields: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.number().int().min(0)).default({}),
});

const attestation = z
  .string()
  .trim()
  .min(10, 'Describe how these contacts opted in (at least 10 characters)')
  .max(1000);

export const importOptionsSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mapping: importMappingSchema,
  phoneFormat: z.enum(['international', 'national']),
  callingCode: z
    .string()
    .regex(CALLING_CODE_RE, 'Enter a country calling code such as 91')
    .optional(),
  updateExisting: z.boolean().default(false),
  tags: z.array(z.string().max(100)).max(5).default([]),
  consent: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({ mode: z.literal('all_opted_in'), attestation }),
    z.object({ mode: z.literal('column'), attestation: attestation.optional() }),
  ]),
});
export type ImportOptions = z.input<typeof importOptionsSchema>;

export interface ImportResult {
  importId: string;
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errorCount: number;
  consentRecorded: number;
  messages: ImportRowMessage[];
}

export interface ContactFieldRow {
  id: string;
  key: string;
  label: string;
  type: ContactFieldType;
  /** A choice field's options, in order; null for every other type (ADR-407). */
  options: string[] | null;
}

/** How many times an import reads a number's contact again before reporting it as changing. */
export const IMPORT_RELOCK_ROUNDS = 3;

/**
 * Finds, for each number, the contact that has it once that contact is locked (ADR-407): reads the
 * contacts by number, locks those not locked yet, and keeps a number only when its locked contact
 * still has it (a contact already locked cannot change). A contact merged away or erased before its
 * lock does not come back, and one whose number changed is ignored for this number; those numbers
 * are read again, at most `IMPORT_RELOCK_ROUNDS` times. A number found on no contact, or still
 * changing, is `unsettled`, for the import to report as a row error, so every row of the file is
 * counted once.
 */
export async function settleLockedContacts(
  phones: readonly string[],
  deps: {
    selectByPhones: (phones: string[]) => Promise<(readonly [string, ContactLockRow])[]>;
    lockContacts: (ids: string[]) => Promise<ContactLockRow[]>;
    isLocked: (id: string) => boolean;
  },
): Promise<{ locked: Map<string, ContactLockRow>; unsettled: string[] }> {
  const locked = new Map<string, ContactLockRow>();
  let pending = [...new Set(phones)];
  for (let round = 0; round < IMPORT_RELOCK_ROUNDS && pending.length > 0; round += 1) {
    const found = await deps.selectByPhones(pending);
    const already = found.filter(([, e]) => deps.isLocked(e.id));
    const fresh = await deps.lockContacts(
      found.filter(([, e]) => !deps.isLocked(e.id)).map(([, e]) => e.id),
    );
    const freshById = new Map(fresh.map((e) => [e.id, e]));
    for (const [phone, e] of already) locked.set(phone, e);
    for (const [phone, e] of found) {
      const row = freshById.get(e.id);
      if (row && row.phoneE164 === phone) locked.set(phone, row);
    }
    pending = pending.filter((phone) => !locked.has(phone));
    // A number no contact has now was found by nobody: reading it again finds nobody either.
    const seen = new Set(found.map(([phone]) => phone));
    if (pending.every((phone) => !seen.has(phone))) break;
  }
  return { locked, unsettled: pending };
}

/** A contact as an import reads it once locked. */
export interface ContactLockRow {
  id: string;
  phoneE164: string | null;
  displayName: string | null;
  email: string | null;
  attributes: Record<string, AttributeValue>;
}

/**
 * The patch an import writes over a contact's values (ADR-407), as `mergeAttributes` would change
 * them: the values given set, the keys given null removed (an import never gives null, since a
 * blank cell leaves a value alone, so for it `removed` is always empty; the rule is kept so the
 * patch means what `mergeAttributes` means); null when it changes nothing, compared value by value
 * with the locked row so an unchanged contact is not rewritten.
 */
export function attributePatch(
  current: Readonly<Record<string, AttributeValue>>,
  changes: Readonly<Record<string, AttributeValue | null>>,
): { set: Record<string, AttributeValue>; removed: string[] } | null {
  const set: Record<string, AttributeValue> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      if (Object.hasOwn(current, key)) removed.push(key);
    } else if (!Object.hasOwn(current, key) || !Object.is(current[key], value)) {
      set[key] = value;
    }
  }
  return Object.keys(set).length > 0 || removed.length > 0 ? { set, removed } : null;
}

/**
 * Whether a field takes the same values as it did: its id, type and options as written. An import
 * reads its rows against the fields before its transaction and checks them again under the lock
 * (ADR-407).
 */
export function sameFieldShape(a: ContactFieldRow, b: ContactFieldRow): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    (a.options === null || b.options === null
      ? a.options === b.options
      : sameOptions(a.options, b.options))
  );
}

function csvToAppError(error: unknown): never {
  if (error instanceof CsvError) throw new AppError('validation_failed', error.message);
  throw error;
}

function suggestColumn(headers: string[], pattern: RegExp): number | null {
  const index = headers.findIndex((h) => pattern.test(h.trim().toLowerCase()));
  return index >= 0 ? index : null;
}

/**
 * Links a WhatsApp identity to a contact by phone number, creating the contact when none exists.
 * Race-free without locks: the unique (company, number) index arbitrates concurrent creators.
 */
export async function contactForPhone(
  tx: Tx,
  tenantId: string,
  input: { phoneE164: string | null; displayName: string | null; source: ContactSource },
): Promise<string> {
  if (!input.phoneE164) {
    const id = uuidv7();
    await tx.insert(contacts).values({
      id,
      tenantId,
      displayName: input.displayName,
      phoneE164: null,
      source: input.source,
    });
    return id;
  }
  const [inserted] = await tx
    .insert(contacts)
    .values({
      id: uuidv7(),
      tenantId,
      displayName: input.displayName,
      phoneE164: input.phoneE164,
      source: input.source,
    })
    .onConflictDoNothing({
      target: [contacts.tenantId, contacts.phoneE164],
      where: sql`phone_e164 is not null`,
    })
    .returning({ id: contacts.id });
  if (inserted) return inserted.id;
  const [existing] = await tx
    .select({ id: contacts.id, displayName: contacts.displayName })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.phoneE164, input.phoneE164)));
  if (!existing) throw new Error('Contact with this number vanished during upsert');
  if (!existing.displayName && input.displayName) {
    await tx
      .update(contacts)
      .set({ displayName: input.displayName })
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, existing.id)));
  }
  return existing.id;
}

/**
 * WHERE conditions (over app.contacts) for the contacts page's filters: the company's contacts not
 * erased, matching the search, the tag and the marketing consent. Bulk edits (ADR-213, ADR-238) and
 * members' enrolments in an automation (ADR-401) take the contacts these match.
 */
export function contactFilterConditions(
  ctx: TenantContext,
  filter: z.infer<typeof contactFilterSchema>,
): SQL[] {
  return contactFilterConditionsFor(ctx.tenant.id, filter, { seesNumbers: seesNumbers(ctx) });
}

/**
 * The same conditions for a company without a member's context: an API key's enrolment (ADR-403),
 * whose filter never has a search (`seesNumbers` only says how a search by number compares).
 */
export function contactFilterConditionsFor(
  tenantId: string,
  filter: z.infer<typeof contactFilterSchema>,
  viewer: { seesNumbers: boolean },
): SQL[] {
  const conditions: SQL[] = [eq(contacts.tenantId, tenantId), isNull(contacts.erasedAt)];
  const q = filter.q?.trim();
  if (q) {
    const digits = q.replace(/[\s()+\-.]/g, '');
    if (/^[0-9]{3,15}$/.test(digits)) {
      // A member who sees numbers masked finds a contact by its whole number only: searching
      // by parts of numbers would reveal them digit by digit (ADR-226).
      conditions.push(
        viewer.seesNumbers
          ? sql`${contacts.phoneE164} like ${likePattern(digits)}`
          : eq(contacts.phoneE164, `+${digits}`),
      );
    } else {
      const pattern = likePattern(q);
      conditions.push(
        sql`(${contacts.displayName} ilike ${pattern} or ${contacts.email} ilike ${pattern})`,
      );
    }
  }
  if (filter.tag) {
    const tag = normalizeTag(filter.tag);
    // A tag the app would not keep matches nobody (ADR-403): no contact can have it, and skipping
    // it would take every contact into a bulk edit, an export or an enrolment.
    conditions.push(
      tag.ok
        ? sql`exists (select 1 from app.contact_tags t where t.tenant_id = ${contacts.tenantId}
                      and t.contact_id = ${contacts.id} and t.tag = ${tag.tag})`
        : sql`false`,
    );
  }
  const marketing = sql`(select cc.status from app.contact_consents cc
    where cc.tenant_id = ${contacts.tenantId} and cc.contact_id = ${contacts.id} and cc.purpose = 'marketing')`;
  if (filter.consent === 'marketing_opted_in') conditions.push(sql`${marketing} = 'opted_in'`);
  if (filter.consent === 'marketing_opted_out') conditions.push(sql`${marketing} = 'opted_out'`);
  if (filter.consent === 'marketing_unknown') conditions.push(sql`${marketing} is null`);
  return conditions;
}

export function createContactsService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;
  const filterConditions = contactFilterConditions;

  async function selectContacts(
    tx: Tx,
    conditions: SQL[],
    cursor: { at: string; id: string } | null,
    limit: number,
  ) {
    return tx
      .select({
        id: contacts.id,
        displayName: contacts.displayName,
        phoneE164: contacts.phoneE164,
        email: contacts.email,
        source: contacts.source,
        attributes: contacts.attributes,
        createdAt: contacts.createdAt,
        cursorAt: exactTimestamp(contacts.createdAt),
        // Outer columns named in full: this select has no joins, so drizzle would leave the table
        // out and `id` would bind to the subquery's own table.
        tags: sql<string[]>`coalesce((select array_agg(t.tag order by t.tag) from app.contact_tags t
          where t.tenant_id = ${outerColumn(contacts.tenantId)} and t.contact_id = ${outerColumn(contacts.id)}), '{}')`,
        marketing: sql<
          'opted_in' | 'opted_out' | null
        >`(select cc.status from app.contact_consents cc
          where cc.tenant_id = ${outerColumn(contacts.tenantId)} and cc.contact_id = ${outerColumn(contacts.id)} and cc.purpose = 'marketing')`,
        utility: sql<'opted_in' | 'opted_out' | null>`(select cc.status from app.contact_consents cc
          where cc.tenant_id = ${outerColumn(contacts.tenantId)} and cc.contact_id = ${outerColumn(contacts.id)} and cc.purpose = 'utility')`,
      })
      .from(contacts)
      .where(
        and(
          ...conditions,
          cursor
            ? sql`(${contacts.createdAt}, ${contacts.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(contacts.createdAt), desc(contacts.id))
      .limit(limit);
  }

  async function loadFields(tx: Tx, tenantId: string): Promise<ContactFieldRow[]> {
    return tx
      .select({
        id: contactFields.id,
        key: contactFields.key,
        label: contactFields.label,
        type: contactFields.type,
        options: contactFields.options,
      })
      .from(contactFields)
      .where(eq(contactFields.tenantId, tenantId))
      .orderBy(asc(contactFields.label));
  }

  /**
   * The fields with these keys, read under the company's contact-field lock (ADR-407), for writes
   * of their values: taken before any contact is locked, so a choice field's options cannot change
   * until they commit. Only the rows of the keys written are then locked `FOR SHARE`, still before
   * the contact, in the order a field's deletion takes them (ADR-112), as the API's `lockFields`
   * does: a deletion of one of them in progress is waited for and its field is then gone, or the
   * deletion waits and removes what this transaction writes; other fields' renames and deletions
   * do not wait. A key no field has is simply not returned.
   */
  async function lockedFields(
    tx: Tx,
    tenantId: string,
    keys: readonly string[],
  ): Promise<ContactFieldRow[]> {
    if (keys.length === 0) return [];
    if (keys.length > MAX_CONTACT_FIELDS) {
      const message = `A company has at most ${MAX_CONTACT_FIELDS} custom fields.`;
      throw new AppError('validation_failed', message, {
        issues: [{ path: 'attributes', message }],
      });
    }
    await lockContactFieldValues(tx, tenantId);
    return tx
      .select({
        id: contactFields.id,
        key: contactFields.key,
        label: contactFields.label,
        type: contactFields.type,
        options: contactFields.options,
      })
      .from(contactFields)
      .where(and(eq(contactFields.tenantId, tenantId), inArray(contactFields.key, [...keys])))
      .orderBy(asc(contactFields.key))
      .for('share');
  }

  /** Validates raw attribute strings against the field definitions (empty value = remove). */
  function coerceAttributes(
    fields: ContactFieldRow[],
    raw: Record<string, string>,
  ): Record<string, AttributeValue | null> {
    const out: Record<string, AttributeValue | null> = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = fields.find((f) => f.key === key);
      if (!field) throw new AppError('validation_failed', 'Unknown custom field.');
      const result = coerceFieldValue(field, value);
      if (!result.ok) throw new AppError('validation_failed', result.message);
      out[key] = result.value;
    }
    return out;
  }

  function mergeAttributes(
    current: Record<string, AttributeValue>,
    changes: Record<string, AttributeValue | null>,
  ): Record<string, AttributeValue> {
    const next = new Map(Object.entries(current));
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    return Object.fromEntries(next);
  }

  function normalizeTags(raw: readonly string[]): string[] {
    const tags: string[] = [];
    for (const value of raw) {
      const tag = normalizeTag(value);
      if (!tag.ok) throw new AppError('validation_failed', tag.message);
      if (!tags.includes(tag.tag)) tags.push(tag.tag);
    }
    return tags;
  }

  async function insertTags(tx: Tx, tenantId: string, pairs: { contactId: string; tag: string }[]) {
    for (const part of chunks(pairs, 1000)) {
      await tx
        .insert(contactTags)
        .values(part.map((p) => ({ id: uuidv7(), tenantId, contactId: p.contactId, tag: p.tag })))
        .onConflictDoNothing();
    }
  }

  /**
   * Locks the contacts a bulk edit's filters match, in id order, and returns their ids: refused
   * beyond BULK_TAG_LIMIT contacts, or when the filters no longer match the number the member was
   * shown (ADR-213). A tag edit locks them `FOR UPDATE`, which an automation step's key share lock
   * waits for before it changes a tag, so the two take turns on a contact's tags. A field edit
   * changes only `attributes`, never `tenant_id` or `id` (the only key other tables reference;
   * the number's unique index is partial, so no key), so it locks `FOR NO KEY UPDATE` (ADR-407):
   * automation steps' key share locks and foreign key checks (tags, consent events, a message's
   * conversation) do not wait for it, and it cannot join a deletion and an automation step in a
   * cycle; steps that set a field or create a deal, Flow answers and a first name from WhatsApp
   * still wait until it commits.
   */
  async function lockMatching(
    tx: Tx,
    ctx: TenantContext,
    filter: z.infer<typeof contactFilterSchema>,
    expectedCount: number,
    done: 'tagged' | 'edited',
  ): Promise<string[]> {
    const locked = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(...filterConditions(ctx, filter)))
      .orderBy(asc(contacts.id))
      .limit(BULK_TAG_LIMIT + 1)
      .for(done === 'tagged' ? 'update' : 'no key update');
    if (locked.length > BULK_TAG_LIMIT) {
      throw new AppError(
        'validation_failed',
        `At most ${BULK_TAG_LIMIT.toLocaleString('en-IN')} contacts can be ${done} at once. Narrow the filters first.`,
      );
    }
    if (locked.length !== expectedCount) {
      throw new AppError(
        'conflict',
        `These filters now match ${locked.length.toLocaleString('en-IN')} contacts, not ${expectedCount.toLocaleString('en-IN')}. Review them and try again.`,
      );
    }
    return locked.map((c) => c.id);
  }

  async function lockContact(tx: Tx, ctx: TenantContext, contactId: string) {
    if (!z.uuid().safeParse(contactId).success) throw notFound('Contact');
    const [row] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, contactId)))
      .for('update');
    if (!row) throw notFound('Contact');
    if (row.erasedAt) throw new AppError('conflict', 'This contact was erased.');
    return row;
  }

  return {
    async listContacts(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'contacts.read');
      const q = parseInput(listContactsSchema, input ?? {});
      const cursor = decodeKeysetCursor(q.cursor);
      const rows = await db.run(
        ctx.scope,
        (tx) => selectContacts(tx, filterConditions(ctx, q), cursor, q.limit + 1),
        { accessMode: 'read only' },
      );
      const items: ContactListItem[] = rows.slice(0, q.limit).map((r) => ({
        id: r.id,
        displayName: r.displayName,
        phoneE164: shownNumber(ctx, r.phoneE164),
        email: r.email,
        source: r.source,
        tags: r.tags,
        marketing: r.marketing,
        utility: r.utility,
        createdAt: r.createdAt,
      }));
      const last = rows.slice(0, q.limit).at(-1);
      return {
        items,
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },

    /** How many contacts the filters match, counted up to one more than BULK_TAG_LIMIT. */
    async countContacts(ctx: TenantContext, input: unknown): Promise<number> {
      assertCan(ctx, 'contacts.read');
      const filter = parseInput(contactFilterSchema, input ?? {});
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ id: contacts.id })
            .from(contacts)
            .where(and(...filterConditions(ctx, filter)))
            .limit(BULK_TAG_LIMIT + 1),
        { accessMode: 'read only' },
      );
      return rows.length;
    },

    /**
     * Adds a tag to, or removes it from, every contact the filters match (ADR-213), under those
     * contacts' locks: refused beyond BULK_TAG_LIMIT contacts, or when the filters no longer match
     * the number the member was shown. A contact that has the most tags a contact can have keeps
     * its tags. Each changed contact is a change in the contact feed and a webhook event, as one
     * member's edit is; the audit entry counts them, without the search text.
     */
    async bulkTagContacts(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<BulkTagResult> {
      assertCan(ctx, 'contacts.write');
      const data = parseInput(bulkTagSchema, input);
      const tag = normalizeTag(data.tag);
      if (!tag.ok) {
        throw new AppError('validation_failed', tag.message, {
          issues: [{ path: 'tag', message: tag.message }],
        });
      }
      return db.run(ctx.scope, async (tx) => {
        const ids = await lockMatching(tx, ctx, data.filter, data.expectedCount, 'tagged');
        const current = await tx.execute<{ id: string; tagged: boolean; tags: number }>(sql`
          select c.id,
                 exists (select 1 from app.contact_tags t where t.tenant_id = ${ctx.tenant.id}::uuid
                           and t.contact_id = c.id and t.tag = ${tag.tag}) as tagged,
                 (select count(*)::int from app.contact_tags t where t.tenant_id = ${ctx.tenant.id}::uuid
                    and t.contact_id = c.id) as tags
            from unnest(${sql.param(ids)}::uuid[]) as c(id)`);
        let changed: number;
        let unchanged = 0;
        let atLimit = 0;
        if (data.action === 'add') {
          const add: string[] = [];
          for (const row of current.rows) {
            if (row.tagged) unchanged += 1;
            else if (row.tags >= MAX_TAGS_PER_CONTACT) atLimit += 1;
            else add.push(row.id);
          }
          await insertTags(
            tx,
            ctx.tenant.id,
            add.map((contactId) => ({ contactId, tag: tag.tag })),
          );
          changed = add.length;
        } else {
          const removed = await tx
            .delete(contactTags)
            .where(
              and(
                eq(contactTags.tenantId, ctx.tenant.id),
                eq(contactTags.tag, tag.tag),
                sql`${contactTags.contactId} = any(${sql.param(ids)}::uuid[])`,
              ),
            )
            .returning({ id: contactTags.id });
          changed = removed.length;
          unchanged = ids.length - removed.length;
        }
        const result: BulkTagResult = {
          action: data.action,
          tag: tag.tag,
          matched: ids.length,
          changed,
          unchanged,
          atLimit,
        };
        await recordAudit(
          tx,
          ctx,
          {
            action: 'contacts.bulk_tagged',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: {
              ...result,
              filter: {
                q: Boolean(data.filter.q),
                tag: data.filter.tag ?? null,
                consent: data.filter.consent,
              },
            },
          },
          meta,
        );
        return result;
      });
    },

    /**
     * Sets one custom field to one value, or clears it, on every contact the filters match
     * (ADR-238), under the locks, limit and count check of a bulk tag edit. The value is checked
     * against the field's type as one contact's edit checks it; a contact that already has it (or,
     * clearing, has none) is left as it is. Each changed contact is a change in the contact feed
     * and a `contact.updated` webhook event (the triggers of 0090 and 0091); the audit entry names
     * the field and counts the contacts, never the value or the search text.
     */
    async bulkSetField(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<BulkFieldResult> {
      assertCan(ctx, 'contacts.write');
      const data = parseInput(bulkFieldSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const field = (await lockedFields(tx, ctx.tenant.id, [data.key])).find(
          (f) => f.key === data.key,
        );
        if (!field) {
          const message = 'Choose one of the company’s custom fields.';
          throw new AppError('validation_failed', message, {
            issues: [{ path: 'key', message }],
          });
        }
        const coerced = coerceFieldValue(field, data.value);
        if (!coerced.ok) {
          throw new AppError('validation_failed', coerced.message, {
            issues: [{ path: 'value', message: coerced.message }],
          });
        }
        const ids = await lockMatching(tx, ctx, data.filter, data.expectedCount, 'edited');
        const current = sql`(${contacts.attributes} -> ${field.key}::text)`;
        const value = coerced.value === null ? null : jsonbText(coerced.value);
        const changed = await tx
          .update(contacts)
          .set({
            attributes:
              value === null
                ? sql`${contacts.attributes} - ${field.key}::text`
                : sql`${contacts.attributes} || jsonb_build_object(${field.key}::text, ${value}::jsonb)`,
          })
          .where(
            and(
              eq(contacts.tenantId, ctx.tenant.id),
              sql`${contacts.id} = any(${sql.param(ids)}::uuid[])`,
              value === null
                ? sql`${current} is not null`
                : sql`${current} is distinct from ${value}::jsonb`,
            ),
          )
          .returning({ id: contacts.id });
        const result: BulkFieldResult = {
          key: field.key,
          label: field.label,
          value: coerced.value,
          matched: ids.length,
          changed: changed.length,
          unchanged: ids.length - changed.length,
        };
        await recordAudit(
          tx,
          ctx,
          {
            action: 'contacts.bulk_field_set',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: {
              key: field.key,
              cleared: coerced.value === null,
              matched: result.matched,
              changed: result.changed,
              unchanged: result.unchanged,
              filter: {
                q: Boolean(data.filter.q),
                tag: data.filter.tag ?? null,
                consent: data.filter.consent,
              },
            },
          },
          meta,
        );
        return result;
      });
    },

    async getContact(ctx: TenantContext, contactId: string) {
      assertCan(ctx, 'contacts.read');
      if (!z.uuid().safeParse(contactId).success) throw notFound('Contact');
      const now = clock.now();
      return db.run(
        ctx.scope,
        async (tx) => {
          const [contact] = await tx
            .select()
            .from(contacts)
            .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, contactId)));
          if (!contact) throw notFound('Contact');
          const tags = await tx
            .select({ tag: contactTags.tag })
            .from(contactTags)
            .where(
              and(eq(contactTags.tenantId, ctx.tenant.id), eq(contactTags.contactId, contactId)),
            )
            .orderBy(asc(contactTags.tag));
          const identities = await tx
            .select({
              id: contactIdentities.id,
              whatsappAccountId: contactIdentities.whatsappAccountId,
              whatsappAccountName: whatsappAccounts.name,
              waId: contactIdentities.waId,
              hasBsuid: sql<boolean>`${contactIdentities.bsuid} is not null`,
              profileName: contactIdentities.profileName,
            })
            .from(contactIdentities)
            .innerJoin(
              whatsappAccounts,
              and(
                eq(whatsappAccounts.tenantId, contactIdentities.tenantId),
                eq(whatsappAccounts.id, contactIdentities.whatsappAccountId),
              ),
            )
            .where(
              and(
                eq(contactIdentities.tenantId, ctx.tenant.id),
                eq(contactIdentities.contactId, contactId),
              ),
            );
          const threads = await tx
            .select({
              id: conversations.id,
              channelAccountId: conversations.channelAccountId,
              channelName: channelAccounts.displayPhoneNumber,
              channelStatus: channelAccounts.status,
              whatsappAccountId: channelAccounts.whatsappAccountId,
              assignedMembershipId: conversations.assignedMembershipId,
              lastMessageAt: conversations.lastMessageAt,
              lastInboundAt: conversations.lastInboundAt,
            })
            .from(conversations)
            .innerJoin(
              channelAccounts,
              and(
                eq(channelAccounts.tenantId, conversations.tenantId),
                eq(channelAccounts.id, conversations.channelAccountId),
              ),
            )
            .where(
              and(
                eq(conversations.tenantId, ctx.tenant.id),
                eq(conversations.contactId, contactId),
              ),
            )
            .orderBy(desc(conversations.lastMessageAt));
          const fields = await loadFields(tx, ctx.tenant.id);
          return {
            // Numbers as this member may see them (ADR-226).
            contact: { ...contact, phoneE164: shownNumber(ctx, contact.phoneE164) },
            tags: tags.map((t) => t.tag),
            identities: identities.map((i) => ({ ...i, waId: shownNumber(ctx, i.waId) })),
            conversations: threads.map((t) => ({
              id: t.id,
              channelAccountId: t.channelAccountId,
              channelName: t.channelName,
              channelActive: t.channelStatus === 'active',
              whatsappAccountId: t.whatsappAccountId,
              lastMessageAt: t.lastMessageAt,
              windowOpen:
                t.lastInboundAt !== null &&
                now.getTime() - t.lastInboundAt.getTime() <= SERVICE_WINDOW_MS,
              canOpen: canSeeConversation(ctx, t.assignedMembershipId),
            })),
            fields,
          };
        },
        { accessMode: 'read only' },
      );
    },

    async createContact(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'contacts.write');
      const data = parseInput(createContactSchema, input);
      const phone = normalizePhone(data.phone, { kind: 'explicit' });
      if (!phone.ok) throw new AppError('validation_failed', phone.message);
      const email = normalizeEmail(data.email ?? '');
      if (!email.ok) throw new AppError('validation_failed', email.message);
      const tags = normalizeTags(data.tags ?? []);
      return db.run(ctx.scope, async (tx) => {
        const fields = await lockedFields(tx, ctx.tenant.id, Object.keys(data.attributes ?? {}));
        const attributes = mergeAttributes({}, coerceAttributes(fields, data.attributes ?? {}));
        const id = uuidv7();
        const [row] = await tx
          .insert(contacts)
          .values({
            id,
            tenantId: ctx.tenant.id,
            displayName: data.displayName,
            phoneE164: phone.e164,
            email: email.email,
            attributes,
            source: 'manual',
          })
          .onConflictDoNothing({
            target: [contacts.tenantId, contacts.phoneE164],
            where: sql`phone_e164 is not null`,
          })
          .returning({ id: contacts.id });
        if (!row) {
          const [existing] = await tx
            .select({ id: contacts.id })
            .from(contacts)
            .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.phoneE164, phone.e164)));
          throw new AppError('conflict', 'A contact with this phone number already exists.', {
            details: existing ? { contactId: existing.id } : undefined,
          });
        }
        await insertTags(
          tx,
          ctx.tenant.id,
          tags.map((tag) => ({ contactId: id, tag })),
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'contact.created',
            subjectType: 'contact',
            subjectId: id,
            metadata: { source: 'manual' },
          },
          meta,
        );
        return { id };
      });
    },

    async updateContact(
      ctx: TenantContext,
      contactId: string,
      input: unknown,
      meta: RequestMeta = {},
    ) {
      assertCan(ctx, 'contacts.write');
      const data = parseInput(updateContactSchema, input);
      await db.run(ctx.scope, async (tx) => {
        // The fields before the contact, as every write of values takes them (ADR-407).
        const fields = await lockedFields(tx, ctx.tenant.id, Object.keys(data.attributes ?? {}));
        const current = await lockContact(tx, ctx, contactId);
        const set: Partial<typeof contacts.$inferInsert> = {};
        if (data.displayName !== current.displayName) set.displayName = data.displayName;
        if (data.email !== undefined) {
          const email = normalizeEmail(data.email);
          if (!email.ok) throw new AppError('validation_failed', email.message);
          if (email.email !== current.email) set.email = email.email;
        }
        if (data.phone !== undefined) {
          // A member who sees numbers masked cannot replace one they cannot see (ADR-226).
          if (current.phoneE164 !== null && !seesNumbers(ctx)) {
            throw new AppError('forbidden', NUMBERS_HIDDEN);
          }
          const phone = normalizePhone(data.phone, { kind: 'explicit' });
          if (!phone.ok) throw new AppError('validation_failed', phone.message);
          if (phone.e164 !== current.phoneE164) {
            const [identity] = await tx
              .select({ id: contactIdentities.id })
              .from(contactIdentities)
              .where(
                and(
                  eq(contactIdentities.tenantId, ctx.tenant.id),
                  eq(contactIdentities.contactId, contactId),
                ),
              )
              .limit(1);
            if (identity) {
              throw new AppError(
                'precondition_failed',
                'This number comes from WhatsApp and cannot be changed.',
              );
            }
            const [taken] = await tx
              .select({ id: contacts.id })
              .from(contacts)
              .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.phoneE164, phone.e164)));
            if (taken) {
              throw new AppError('conflict', 'Another contact already has this phone number.', {
                details: { contactId: taken.id },
              });
            }
            set.phoneE164 = phone.e164;
          }
        }
        if (data.attributes) {
          const next = mergeAttributes(
            current.attributes,
            coerceAttributes(fields, data.attributes),
          );
          if (JSON.stringify(next) !== JSON.stringify(current.attributes)) set.attributes = next;
        }
        const changed = Object.keys(set);
        if (changed.length === 0) return;
        await tx
          .update(contacts)
          .set(set)
          .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, contactId)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'contact.updated',
            subjectType: 'contact',
            subjectId: contactId,
            metadata: { fields: changed },
          },
          meta,
        );
      });
    },

    async addTags(ctx: TenantContext, contactId: string, rawTags: string[]) {
      assertCan(ctx, 'contacts.write');
      const tags = normalizeTags(rawTags);
      if (tags.length === 0) return;
      await db.run(ctx.scope, async (tx) => {
        await lockContact(tx, ctx, contactId);
        const existing = await tx
          .select({ tag: contactTags.tag })
          .from(contactTags)
          .where(
            and(eq(contactTags.tenantId, ctx.tenant.id), eq(contactTags.contactId, contactId)),
          );
        const all = new Set([...existing.map((e) => e.tag), ...tags]);
        if (all.size > MAX_TAGS_PER_CONTACT) {
          throw new AppError(
            'validation_failed',
            `A contact can have at most ${MAX_TAGS_PER_CONTACT} tags.`,
          );
        }
        await insertTags(
          tx,
          ctx.tenant.id,
          tags.map((tag) => ({ contactId, tag })),
        );
      });
    },

    async removeTag(ctx: TenantContext, contactId: string, rawTag: string) {
      assertCan(ctx, 'contacts.write');
      const tag = normalizeTag(rawTag);
      if (!tag.ok) throw new AppError('validation_failed', tag.message);
      await db.run(ctx.scope, async (tx) => {
        await lockContact(tx, ctx, contactId);
        await tx
          .delete(contactTags)
          .where(
            and(
              eq(contactTags.tenantId, ctx.tenant.id),
              eq(contactTags.contactId, contactId),
              eq(contactTags.tag, tag.tag),
            ),
          );
      });
    },

    async listTags(ctx: TenantContext) {
      assertCan(ctx, 'contacts.read');
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({ tag: contactTags.tag, count: sql<number>`count(*)::int` })
            .from(contactTags)
            .where(eq(contactTags.tenantId, ctx.tenant.id))
            .groupBy(contactTags.tag)
            .orderBy(asc(contactTags.tag))
            .limit(500);
          return rows;
        },
        { accessMode: 'read only' },
      );
    },

    async listFields(ctx: TenantContext) {
      assertCan(ctx, 'contacts.read');
      return db.run(ctx.scope, (tx) => loadFields(tx, ctx.tenant.id), { accessMode: 'read only' });
    },

    async createField(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(createFieldSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const field = await createContactField(tx, ctx.tenant.id, data);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'contact_field.created',
            subjectType: 'contact_field',
            subjectId: field.id,
            metadata: {
              key: field.key,
              type: field.type,
              ...(field.options ? { options: field.options.length } : {}),
            },
          },
          meta,
        );
        return { id: field.id, key: field.key };
      });
    },

    async renameField(ctx: TenantContext, fieldId: string, label: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const parsed = parseInput(fieldLabelSchema, label);
      if (!z.uuid().safeParse(fieldId).success) throw notFound('Field');
      await db.run(ctx.scope, async (tx) => {
        const result = await renameContactField(tx, ctx.tenant.id, { id: fieldId }, parsed);
        if (!result) throw notFound('Field');
        if (result.renamed) {
          await recordAudit(
            tx,
            ctx,
            {
              action: 'contact_field.renamed',
              subjectType: 'contact_field',
              subjectId: fieldId,
              metadata: { key: result.field.key },
            },
            meta,
          );
        }
      });
    },

    /**
     * Gives a choice field a new list of options (ADR-407), as Settings → Messaging sends it: options
     * can be added, reordered, and removed or renamed while no contact has them chosen; an option a
     * contact has chosen must stay as it is written, or the change is refused naming it. Audited
     * with the counts, never the options; the same list changes nothing and leaves no trace.
     */
    async setFieldOptions(
      ctx: TenantContext,
      fieldId: string,
      options: unknown,
      meta: RequestMeta = {},
    ) {
      assertCan(ctx, 'tenant.settings.manage');
      const next = parseInput(fieldOptionsSchema, options);
      if (!z.uuid().safeParse(fieldId).success) throw notFound('Field');
      await db.run(ctx.scope, async (tx) => {
        const result = await setContactFieldOptions(tx, ctx.tenant.id, { id: fieldId }, next);
        if (!result) throw notFound('Field');
        if (!result.changed) return;
        await recordAudit(
          tx,
          ctx,
          {
            action: 'contact_field.options_changed',
            subjectType: 'contact_field',
            subjectId: fieldId,
            metadata: {
              key: result.field.key,
              options: next.length,
              added: result.added,
              removed: result.removed,
            },
          },
          meta,
        );
      });
    },

    /** Deletes a field definition and its values on every contact. */
    async deleteField(ctx: TenantContext, fieldId: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      if (!z.uuid().safeParse(fieldId).success) throw notFound('Field');
      await db.run(ctx.scope, async (tx) => {
        const field = await deleteContactField(tx, ctx.tenant.id, { id: fieldId });
        if (!field) throw notFound('Field');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'contact_field.deleted',
            subjectType: 'contact_field',
            subjectId: fieldId,
            metadata: { key: field.key },
          },
          meta,
        );
      });
    },

    /**
     * Erases a contact's personal data (app.erase_contact): identities, tags, custom values, name,
     * number and email are removed, messages are redacted, queued sends are cancelled and consent
     * history ends with opt-outs. With `suppress`, the number stays on the suppression list.
     */
    async eraseContact(
      ctx: TenantContext,
      input: { contactId: string; suppress: boolean },
      meta: RequestMeta = {},
    ) {
      assertCan(ctx, 'contacts.delete');
      if (!z.uuid().safeParse(input.contactId).success) throw notFound('Contact');
      await db.run(ctx.scope, async (tx) => {
        const res = await tx.execute<{ erased: boolean }>(
          sql`select app.erase_contact(${input.contactId}::uuid, ${input.suppress}) as erased`,
        );
        if (res.rows[0]?.erased !== true) {
          throw new AppError('conflict', 'This contact was already erased.');
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'contact.erased',
            subjectType: 'contact',
            subjectId: input.contactId,
            metadata: { suppressed: input.suppress },
          },
          meta,
        );
      });
    },

    async previewImport(ctx: TenantContext, input: { fileName: string; text: string }) {
      assertCan(ctx, 'contacts.import');
      let parsed;
      try {
        parsed = parseCsv(input.text, IMPORT_LIMITS);
      } catch (error) {
        csvToAppError(error);
      }
      if (parsed.rows.length === 0)
        throw new AppError('validation_failed', 'The file has no data rows.');
      const fields = await db.run(ctx.scope, (tx) => loadFields(tx, ctx.tenant.id), {
        accessMode: 'read only',
      });
      const headers = parsed.headers;
      const suggestedFields: Record<string, number> = {};
      for (const field of fields) {
        const index = headers.findIndex((h) => {
          const n = h.trim().toLowerCase();
          return n === field.key || n === field.label.trim().toLowerCase();
        });
        if (index >= 0) suggestedFields[field.key] = index;
      }
      return {
        fileName: clipText(input.fileName, 200),
        headers,
        sample: parsed.rows.slice(0, 5).map((r) => r.map(restoreCell)),
        totalRows: parsed.rows.length,
        fields,
        suggested: {
          phone: suggestColumn(headers, /phone|mobile|whatsapp|msisdn|number/),
          name: suggestColumn(headers, /^name$|full.?name|contact.?name|customer.?name/),
          email: suggestColumn(headers, /e-?mail/),
          tags: suggestColumn(headers, /^tags?$|labels?|groups?|segments?/),
          marketingConsent: suggestColumn(headers, /consent|opt.?in|marketing|subscri/),
          fields: suggestedFields,
        },
      };
    },

    /**
     * Imports contacts from CSV in one transaction (all rows or none). Rows with errors are skipped
     * and reported by row number. Consent: opt-outs in the file are always recorded; opt-ins only
     * with the importing member's attestation of how opt-in was collected, and never over an
     * existing opt-out.
     */
    async importContacts(
      ctx: TenantContext,
      input: { text: string } & Record<string, unknown>,
      meta: RequestMeta = {},
    ): Promise<ImportResult> {
      assertCan(ctx, 'contacts.import');
      const opts = parseInput(importOptionsSchema, input);
      if (opts.phoneFormat === 'national' && !opts.callingCode) {
        throw new AppError(
          'validation_failed',
          'Enter the country calling code for national numbers.',
        );
      }
      if (opts.consent.mode === 'column' && opts.mapping.marketingConsent === null) {
        throw new AppError('validation_failed', 'Choose the column that holds marketing consent.');
      }
      let csv;
      try {
        csv = parseCsv(input.text, IMPORT_LIMITS);
      } catch (error) {
        csvToAppError(error);
      }
      const width = csv.headers.length;
      const columns = [
        opts.mapping.phone,
        opts.mapping.name,
        opts.mapping.email,
        opts.mapping.tags,
        opts.mapping.marketingConsent,
        ...Object.values(opts.mapping.fields),
      ].filter((c): c is number => c !== null);
      if (columns.some((c) => c >= width))
        throw new AppError('validation_failed', 'The column mapping does not match the file.');
      const globalTags = normalizeTags(opts.tags);
      const mode: PhoneInputMode =
        opts.phoneFormat === 'national'
          ? { kind: 'national', callingCode: opts.callingCode ?? '' }
          : { kind: 'international' };
      const attestationText =
        'attestation' in opts.consent ? (opts.consent.attestation ?? null) : null;

      const fields = await db.run(ctx.scope, (tx) => loadFields(tx, ctx.tenant.id), {
        accessMode: 'read only',
      });
      for (const key of Object.keys(opts.mapping.fields)) {
        if (!fields.some((f) => f.key === key))
          throw new AppError('validation_failed', 'Unknown custom field in the mapping.');
      }

      interface Row {
        line: number;
        name: string | null;
        email: string | null;
        attributes: Record<string, AttributeValue | null>;
        tags: string[];
        consent: 'opt_in' | 'opt_out' | null;
      }
      const messages: ImportRowMessage[] = [];
      const records = new Map<string, Row>();
      const cell = (row: string[], index: number | null) =>
        index === null ? '' : restoreCell(row[index] ?? '').trim();
      csv.rows.forEach((row, i) => {
        const line = i + 2;
        const error = (message: string) => messages.push({ row: line, level: 'error', message });
        const phone = normalizePhone(cell(row, opts.mapping.phone), mode);
        if (!phone.ok) return error(phone.message);
        const duplicate = records.get(phone.e164);
        if (duplicate) return error(`Same phone number as row ${duplicate.line}.`);
        const name = cell(row, opts.mapping.name);
        if (name.length > 200) return error('Name is longer than 200 characters.');
        const email = normalizeEmail(cell(row, opts.mapping.email));
        if (!email.ok) return error(email.message);
        const attributes: Record<string, AttributeValue | null> = {};
        for (const [key, index] of Object.entries(opts.mapping.fields)) {
          const field = fields.find((f) => f.key === key);
          if (!field) return error('Unknown custom field.');
          const value = coerceFieldValue(field, cell(row, index));
          if (!value.ok) return error(value.message);
          if (value.value !== null) attributes[key] = value.value;
        }
        const tags: string[] = [];
        for (const raw of cell(row, opts.mapping.tags).split(/[;,|]/)) {
          if (!raw.trim()) continue;
          const tag = normalizeTag(raw);
          if (!tag.ok) return error(tag.message);
          if (!tags.includes(tag.tag)) tags.push(tag.tag);
        }
        if (tags.length > 10) return error('A row can carry at most 10 tags.');
        let consent: Row['consent'] = null;
        if (opts.consent.mode === 'all_opted_in') consent = 'opt_in';
        if (opts.consent.mode === 'column') {
          const value = parseConsentCell(cell(row, opts.mapping.marketingConsent));
          if (value === 'unrecognised') {
            messages.push({
              row: line,
              level: 'notice',
              message: 'Marketing consent value not recognised; consent left unchanged.',
            });
          } else if (value !== 'blank') {
            consent = value;
          }
        }
        if (consent === 'opt_in' && !attestationText) {
          messages.push({
            row: line,
            level: 'notice',
            message: 'Opt-in not recorded: no statement of how consent was collected.',
          });
          consent = null;
        }
        records.set(phone.e164, {
          line,
          name: name || null,
          email: email.email,
          attributes,
          tags,
          consent,
        });
      });

      const now = clock.now();
      const result = await db.run(ctx.scope, async (tx) => {
        // The values were read against the fields above; under the company's contact-field lock
        // (ADR-407) the fields mapped must be as they were then, so no value is stored that a
        // field's options or type no longer take.
        if (Object.keys(opts.mapping.fields).length > 0) {
          const locked = await lockedFields(tx, ctx.tenant.id, Object.keys(opts.mapping.fields));
          for (const key of Object.keys(opts.mapping.fields)) {
            const before = fields.find((f) => f.key === key);
            const after = locked.find((f) => f.key === key);
            if (!before || !after || !sameFieldShape(before, after)) {
              throw new AppError(
                'conflict',
                'The custom fields changed while the file was read. Import it again.',
              );
            }
          }
        }
        const importId = uuidv7();
        let created = 0;
        let updated = 0;
        let skipped = 0;
        const touched = new Map<string, Row>(); // contact id -> row
        const contactColumns = {
          id: contacts.id,
          phoneE164: contacts.phoneE164,
          displayName: contacts.displayName,
          email: contacts.email,
          attributes: contacts.attributes,
        };
        const selectByPhones = async (phones: string[]) => {
          const rows = await tx
            .select(contactColumns)
            .from(contacts)
            .where(and(eq(contacts.tenantId, ctx.tenant.id), inArray(contacts.phoneE164, phones)));
          return rows.flatMap((r) => (r.phoneE164 ? [[r.phoneE164, r] as const] : []));
        };
        /**
         * Locks contacts the import may change in id order, as bulk edits and field deletions lock
         * them, and reads them as they are once locked: values are written as a patch over the
         * locked row, so a value a field's deletion removed meanwhile, or a member's change of
         * another field, is never written back from an earlier read (ADR-407). An import that adds
         * tags (a tag column or tags for every row) locks `FOR UPDATE`, as bulk tag edits do, so an
         * automation step adding a tag (which takes its contact's key share lock, counts the tags,
         * then adds one) takes turns with it. Otherwise `FOR NO KEY UPDATE`: the import changes the
         * name, email and values, never `tenant_id` or `id` (the only key other tables reference),
         * so automation steps' key share locks and foreign key checks (tags, consent events, a
         * message's conversation) do not wait for it; steps that set a field or create a deal, Flow
         * answers and a first name from WhatsApp still wait until it commits.
         */
        const lockMode =
          globalTags.length > 0 || opts.mapping.tags !== null ? 'update' : 'no key update';
        const lockedIds = new Set<string>();
        const lockContacts = async (ids: string[]) => {
          const rows: ContactLockRow[] = [];
          for (const part of chunks([...ids].sort(), 1000)) {
            rows.push(
              ...(await tx
                .select(contactColumns)
                .from(contacts)
                .where(and(eq(contacts.tenantId, ctx.tenant.id), inArray(contacts.id, part)))
                .orderBy(asc(contacts.id))
                .for(lockMode)),
            );
          }
          for (const row of rows) lockedIds.add(row.id);
          return rows;
        };
        if (opts.updateExisting) {
          // Every contact the file names that exists now, locked before any is changed, all in id
          // order. A contact merged into, or created by another request, during the import is
          // found below and locked then; a created one has a later id (UUIDv7) than those locked
          // here, a kept contact of a merge may not, so that rare case can cycle, which
          // PostgreSQL detects (the member imports again).
          const known: string[] = [];
          for (const part of chunks([...records.keys()], 1000)) {
            for (const [, e] of await selectByPhones(part)) known.push(e.id);
          }
          await lockContacts(known);
        }
        for (const part of chunks([...records.entries()], 500)) {
          const existing = new Map(await selectByPhones(part.map(([phone]) => phone)));
          const fresh = part
            .filter(([phone]) => !existing.has(phone))
            .map(([phone, r]) => ({
              id: uuidv7(),
              tenantId: ctx.tenant.id,
              displayName: r.name,
              phoneE164: phone,
              email: r.email,
              attributes: mergeAttributes({}, r.attributes),
              source: 'import' as const,
            }));
          if (fresh.length > 0) {
            const inserted = await tx
              .insert(contacts)
              .values(fresh)
              .onConflictDoNothing({
                target: [contacts.tenantId, contacts.phoneE164],
                where: sql`phone_e164 is not null`,
              })
              .returning({ id: contacts.id, phoneE164: contacts.phoneE164 });
            const insertedPhones = new Set(inserted.map((i) => i.phoneE164));
            for (const row of inserted) {
              const r = row.phoneE164 ? records.get(row.phoneE164) : undefined;
              if (!r) continue;
              created += 1;
              touched.set(row.id, r);
            }
            // Numbers another request created meanwhile are handled like existing contacts.
            const raced = fresh.map((f) => f.phoneE164).filter((p) => !insertedPhones.has(p));
            if (raced.length > 0) {
              for (const [phone, e] of await selectByPhones(raced)) existing.set(phone, e);
            }
          }
          if (opts.updateExisting) {
            // A contact read here but not locked above (created or merged into since) is locked
            // now and read again, so the patch is decided on the locked row; a number whose
            // contact keeps changing is reported instead of being dropped or applied elsewhere.
            const pending = [...existing]
              .filter(([, e]) => !lockedIds.has(e.id))
              .map(([phone]) => phone);
            if (pending.length > 0) {
              for (const phone of pending) existing.delete(phone);
              const settledRows = await settleLockedContacts(pending, {
                selectByPhones,
                lockContacts,
                isLocked: (id) => lockedIds.has(id),
              });
              for (const [phone, e] of settledRows.locked) existing.set(phone, e);
              for (const phone of settledRows.unsettled) {
                const r = records.get(phone);
                if (r) {
                  messages.push({
                    row: r.line,
                    level: 'error',
                    message: 'This contact changed during the import; import it again.',
                  });
                }
              }
            }
          }
          for (const [phone, e] of existing) {
            const r = records.get(phone);
            if (!r) continue;
            if (!opts.updateExisting) {
              skipped += 1;
              messages.push({
                row: r.line,
                level: 'notice',
                message: 'A contact with this number already exists; it was left unchanged.',
              });
              continue;
            }
            // The contact was locked above, so `e` is as it is now. Values are written as a patch
            // (set the given values, remove those given empty), never as the whole object.
            const set: { displayName?: string; email?: string; attributes?: SQL } = {};
            if (r.name && r.name !== e.displayName) set.displayName = r.name;
            if (r.email && r.email !== e.email) set.email = r.email;
            const patch = attributePatch(e.attributes, r.attributes);
            if (patch) {
              set.attributes = sql`(${contacts.attributes} || ${jsonbText(patch.set)}::jsonb) - ${sql.param(patch.removed)}::text[]`;
            }
            if (Object.keys(set).length > 0) {
              await tx
                .update(contacts)
                .set(set)
                .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, e.id)));
            }
            updated += 1;
            touched.set(e.id, r);
          }
        }

        const tagPairs: { contactId: string; tag: string }[] = [];
        for (const [contactId, r] of touched) {
          for (const tag of new Set([...globalTags, ...r.tags])) tagPairs.push({ contactId, tag });
        }
        await insertTags(tx, ctx.tenant.id, tagPairs);

        const consentRows = [...touched].filter(([, r]) => r.consent !== null);
        const events: ConsentEventInput[] = [];
        for (const part of chunks(consentRows, 500)) {
          const states = new Map(
            (
              await tx
                .select({ contactId: contactConsents.contactId, status: contactConsents.status })
                .from(contactConsents)
                .where(
                  and(
                    eq(contactConsents.tenantId, ctx.tenant.id),
                    eq(contactConsents.purpose, 'marketing'),
                    inArray(
                      contactConsents.contactId,
                      part.map(([id]) => id),
                    ),
                  ),
                )
            ).map((s) => [s.contactId, s.status]),
          );
          for (const [contactId, r] of part) {
            const current = states.get(contactId);
            if (r.consent === 'opt_in' && current === 'opted_out') {
              messages.push({
                row: r.line,
                level: 'notice',
                message:
                  'Kept the existing marketing opt-out; the opt-in in the file was not recorded.',
              });
              continue;
            }
            if (
              (r.consent === 'opt_in' && current === 'opted_in') ||
              (r.consent === 'opt_out' && current === 'opted_out')
            ) {
              continue;
            }
            events.push({
              tenantId: ctx.tenant.id,
              contactId,
              purpose: 'marketing',
              action: r.consent === 'opt_in' ? 'opt_in' : 'opt_out',
              source: 'import',
              evidence: { importId, row: r.line },
              actorType: 'user',
              actorId: ctx.user.id,
              occurredAt: now,
            });
          }
        }
        for (const part of chunks(events, 1000)) await recordConsentEvents(tx, part);

        messages.sort((a, b) => a.row - b.row);
        const errorCount = messages.filter((m) => m.level === 'error').length;
        await tx.insert(contactImports).values({
          id: importId,
          tenantId: ctx.tenant.id,
          fileName: opts.fileName,
          totalRows: csv.rows.length,
          createdCount: created,
          updatedCount: updated,
          skippedCount: skipped,
          errorCount,
          consentRecordedCount: events.length,
          errors: messages.slice(0, MAX_STORED_IMPORT_MESSAGES),
          consentAttestation: attestationText,
          createdByUserId: ctx.user.id,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'contacts.imported',
            subjectType: 'contact_import',
            subjectId: importId,
            metadata: {
              totalRows: csv.rows.length,
              created,
              updated,
              skipped,
              errors: errorCount,
              consentRecorded: events.length,
            },
          },
          meta,
        );
        return {
          importId,
          totalRows: csv.rows.length,
          created,
          updated,
          skipped,
          errorCount,
          consentRecorded: events.length,
          messages: messages.slice(0, MAX_STORED_IMPORT_MESSAGES),
        };
      });
      return result;
    },

    async listImports(ctx: TenantContext) {
      assertCan(ctx, 'contacts.import');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: contactImports.id,
              fileName: contactImports.fileName,
              totalRows: contactImports.totalRows,
              createdCount: contactImports.createdCount,
              updatedCount: contactImports.updatedCount,
              skippedCount: contactImports.skippedCount,
              errorCount: contactImports.errorCount,
              consentRecordedCount: contactImports.consentRecordedCount,
              createdAt: contactImports.createdAt,
            })
            .from(contactImports)
            .where(eq(contactImports.tenantId, ctx.tenant.id))
            .orderBy(desc(contactImports.createdAt))
            .limit(20),
        { accessMode: 'read only' },
      );
    },

    /**
     * Streams contacts as CSV (formula-safe). Rows are read in keyset batches, each in its own
     * read-only transaction, so a large export never holds a long transaction open.
     */
    async *exportContacts(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): AsyncGenerator<string> {
      assertCan(ctx, 'contacts.export');
      const filter = parseInput(contactFilterSchema, input ?? {});
      const fields = await db.run(ctx.scope, async (tx) => {
        const list = await loadFields(tx, ctx.tenant.id);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'contacts.exported',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: {
              filter: { q: Boolean(filter.q), tag: filter.tag ?? null, consent: filter.consent },
            },
          },
          meta,
        );
        return list;
      });
      yield CSV_BOM +
        csvLine([
          'phone',
          'name',
          'email',
          'tags',
          'marketing_consent',
          'utility_consent',
          'source',
          'created_at',
          ...fields.map((f) => f.key),
        ]);
      let cursor: { at: string; id: string } | null = null;
      let exported = 0;
      const conditions = filterConditions(ctx, filter);
      while (exported < MAX_EXPORT_ROWS) {
        const batch = await db.run(ctx.scope, (tx) => selectContacts(tx, conditions, cursor, 500), {
          accessMode: 'read only',
        });
        if (batch.length === 0) break;
        let chunk = '';
        for (const r of batch) {
          chunk += csvLine([
            // As the member may see it (ADR-226): masked numbers stay masked in the file.
            shownNumber(ctx, r.phoneE164),
            r.displayName,
            r.email,
            r.tags.join('; '),
            r.marketing ?? '',
            r.utility ?? '',
            r.source,
            r.createdAt.toISOString(),
            ...fields.map((f) => {
              const v = r.attributes[f.key];
              return v === undefined ? '' : String(v);
            }),
          ]);
        }
        exported += batch.length;
        yield chunk;
        const last = batch.at(-1);
        if (!last || batch.length < 500) break;
        cursor = { at: last.cursorAt, id: last.id };
      }
    },

    /** Whether the member may message this contact from the contact page (used by the UI). */
    canSendTemplates(ctx: TenantContext): boolean {
      return can(ctx, 'inbox.reply') || can(ctx, 'campaigns.send');
    },
  };
}

export type ContactsService = ReturnType<typeof createContactsService>;
