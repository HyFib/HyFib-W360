import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  asc,
  contactFields,
  contactIdentities,
  contactTags,
  contacts,
  desc,
  eq,
  exactTimestamp,
  inArray,
  isNull,
  sql,
  suppressions,
  type ContactFieldType,
  type SQL,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import {
  MAX_CONTACT_FIELDS,
  MAX_TAGS_PER_CONTACT,
  apiFieldFilterValue,
  apiFieldValue,
  normalizeEmail,
  normalizeTag,
  type AttributeValue,
} from '../contacts/fields';
import { normalizePhone } from '../contacts/phone';
import type { OutboundDeps } from '../messaging/outbound';
import { encodeKeysetCursor, parseInput } from '../validation';
import { apiContactById, apiContactColumns, toApiContact, type ApiContact } from './contact-view';
import { apiActor, assertAnyScope, assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * Contact custom fields and contact changes through the public API (ADR-112): the company's field
 * definitions, values checked strictly against their field's type, and `PATCH /contacts/{id}`; the
 * filters `GET /contacts` finds contacts with (ADR-113), and the pages it and contact searches
 * (ADR-117) read.
 */

const FIELD_KEY = z.string().max(40);
const fieldValue = z.union([z.string(), z.number(), z.boolean()]);
const fieldCount = (v: Record<string, unknown>) => Object.keys(v).length <= MAX_CONTACT_FIELDS;
const FIELD_COUNT_MESSAGE = `Give at most ${MAX_CONTACT_FIELDS} fields.`;

/** Custom field values `POST /contacts` sets on a new contact, or fills on an existing one. */
export const apiContactFieldsSchema = z
  .record(FIELD_KEY, fieldValue)
  .refine(fieldCount, FIELD_COUNT_MESSAGE)
  .describe(
    'Custom field values by field key (GET /contact-fields), each of its field’s type: a string for text, a number, a date as YYYY-MM-DD, true or false for yes/no.',
  );

/** What a key changes in a contact: at least one of these. */
const contactChange = {
  name: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .describe('The contact’s name; null or an empty string clears it.'),
  email: z
    .string()
    .trim()
    .max(254)
    .nullable()
    .optional()
    .describe('An email address; null or an empty string clears it.'),
  fields: z
    .record(FIELD_KEY, fieldValue.nullable())
    .refine(fieldCount, FIELD_COUNT_MESSAGE)
    .optional()
    .describe(
      'Custom field values to set by field key (GET /contact-fields), each of its field’s type: a string for text, a number, a date as YYYY-MM-DD, true or false for yes/no. Null or an empty string clears a value; fields left out keep theirs.',
    ),
  addTags: z
    .array(z.string().max(40))
    .max(20)
    .optional()
    .describe('Tags to add (lower-cased; commas are not allowed).'),
  removeTags: z.array(z.string().max(40)).max(MAX_TAGS_PER_CONTACT).optional(),
};
type ContactChangeInput = z.infer<z.ZodObject<typeof contactChange>>;
const someChange = [
  (v: ContactChangeInput) =>
    v.name !== undefined ||
    v.email !== undefined ||
    v.fields !== undefined ||
    v.addTags !== undefined ||
    v.removeTags !== undefined,
  'Give name, email, fields, addTags or removeTags.',
] as const;

/**
 * `PATCH /contacts/{id}`: what any change takes, and a number typed for the contact (ADR-180), which
 * only this call changes: changing many contacts' numbers at once could swap them.
 */
export const apiContactUpdateSchema = z
  .object({
    ...contactChange,
    phone: z
      .string()
      .max(40)
      .optional()
      .describe(
        "The contact's number with its country code, starting with + (for example +919876543210). Only a number typed for the contact changes: one WhatsApp gave (the contact wrote to one of the company's numbers) is its identity and is refused, and so is a number another contact has or one on the company's suppression list.",
      ),
  })
  .strict()
  .refine(
    (v) => someChange[0](v) || v.phone !== undefined,
    'Give name, email, phone, fields, addTags or removeTags.',
  );

/**
 * `POST /contacts/update-many` (ADR-122): 1 to 100 contacts, each once, each with what
 * `PATCH /contacts/{id}` takes.
 */
export const apiUpdateManyContactsSchema = z
  .object({
    contacts: z
      .array(
        z
          .object({
            id: z.uuid().describe('The contact to change.'),
            ...contactChange,
          })
          .strict()
          .refine(...someChange),
      )
      .min(1, 'Give at least one contact.')
      .max(API_LIMITS.contactsPerChange, `Give at most ${API_LIMITS.contactsPerChange} contacts.`)
      .refine((items) => new Set(items.map((c) => c.id)).size === items.length, {
        message: 'Give each contact once.',
      })
      .describe(
        `Up to ${API_LIMITS.contactsPerChange} contacts, each with its id and what PATCH /contacts/{id} takes.`,
      ),
  })
  .strict();

/**
 * What `POST /contacts/update-matching` changes in each contact a search finds (ADR-165): custom
 * field values and tags, the same for every contact, at least one of them.
 */
export const apiContactsAlikeChangeSchema = z
  .object({
    fields: contactChange.fields,
    addTags: contactChange.addTags,
    removeTags: contactChange.removeTags,
  })
  .strict()
  .refine(
    (v) => v.fields !== undefined || v.addTags !== undefined || v.removeTags !== undefined,
    'Give fields, addTags or removeTags.',
  );

export interface ApiContactField {
  key: string;
  label: string;
  type: ContactFieldType;
  createdAt: string;
}

/** The OpenAPI description of a custom field. */
export const apiContactFieldSchema = z.object({
  key: z.string().describe('The key `fields` uses for its value; it never changes.'),
  label: z.string().describe('The name members see; it can change.'),
  type: z
    .enum(['text', 'number', 'date', 'boolean'])
    .describe('`text`, `number`, `date` (YYYY-MM-DD) or `boolean` (yes/no).'),
  createdAt: z.iso.datetime(),
});

const invalidField = (path: string, message: string) =>
  new AppError('validation_failed', message, { issues: [{ path, message }] });

/** Tags as the app keeps them (lower-cased, without commas), each once. */
export function apiTags(raw: readonly string[], path: string): string[] {
  const tags: string[] = [];
  for (const value of raw) {
    const tag = normalizeTag(value);
    if (!tag.ok) throw invalidField(path, tag.message);
    if (!tags.includes(tag.tag)) tags.push(tag.tag);
  }
  return tags;
}

/**
 * The values `fields` asks for, checked against the company's fields: an unknown key or a value of
 * another type is refused, naming `fields.<key>`. The field rows are locked against a deletion at
 * the same time, which then removes what this transaction writes once it commits; callers lock them
 * before the contact, as a deletion does. Null means "remove the value".
 */
export async function apiFieldChanges(
  tx: Tx,
  tenantId: string,
  input: Record<string, unknown>,
): Promise<Record<string, AttributeValue | null>> {
  return checkFieldChanges(await lockFields(tx, tenantId, Object.keys(input)), input, '');
}

type FieldDefinition = { key: string; label: string; type: ContactFieldType };

/** Locks the company's fields with these keys in one statement, as a deletion takes them. */
async function lockFields(tx: Tx, tenantId: string, keys: string[]): Promise<FieldDefinition[]> {
  if (keys.length === 0) return [];
  return tx
    .select({ key: contactFields.key, label: contactFields.label, type: contactFields.type })
    .from(contactFields)
    .where(and(eq(contactFields.tenantId, tenantId), inArray(contactFields.key, keys)))
    .for('share');
}

/** Checks values against locked fields; a refusal names `<at>fields.<key>`. */
function checkFieldChanges(
  defined: readonly FieldDefinition[],
  input: Record<string, unknown>,
  at: string,
): Record<string, AttributeValue | null> {
  const changes: Record<string, AttributeValue | null> = {};
  for (const key of Object.keys(input)) {
    const field = defined.find((f) => f.key === key);
    if (!field) {
      throw invalidField(
        `${at}fields.${key}`,
        `The company has no custom field with the key ${key} (GET /contact-fields).`,
      );
    }
    const checked = apiFieldValue(field, input[key]);
    if (!checked.ok) throw invalidField(`${at}fields.${key}`, checked.message);
    changes[key] = checked.value;
  }
  return changes;
}

/** The most custom fields one contact list filters on (ADR-113). */
export const MAX_FIELD_FILTERS = 5;

/**
 * The most contacts one page of a list filtered by name, tag or custom field reads (ADR-113,
 * ADR-124), whatever it shows: filters that leave out most of a company's contacts give short pages,
 * never a scan of every contact it has (as the message feed reads, ADR-088).
 */
export const API_CONTACT_SEARCH_WINDOW = 2000;

/**
 * One page of the company's contacts, newest first, on exact keyset pages (ADR-113): `narrow` holds
 * conditions read with the contacts (a number or an email address, which their indexes find), and
 * `filters`, when there are any, are checked in a window of at most API_CONTACT_SEARCH_WINDOW
 * contacts. A page whose filters leave out most contacts then holds fewer than the limit, or none,
 * and its cursor continues after the last contact it read, so pages never skip or repeat one. Run it
 * in a repeatable read transaction, so both reads see one snapshot.
 */
export async function apiContactPage(
  tx: Tx,
  tenantId: string,
  page: {
    cursor: { at: string; id: string } | null;
    limit: number;
    narrow: (SQL | undefined)[];
    filters: SQL[];
  },
): Promise<{ data: ApiContact[]; nextCursor: string | null }> {
  const { cursor } = page;
  const range = and(
    eq(contacts.tenantId, tenantId),
    isNull(contacts.erasedAt),
    ...page.narrow,
    cursor
      ? sql`(${contacts.createdAt}, ${contacts.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
      : undefined,
  );
  // The last contact this page may read; none when fewer remain or nothing is filtered.
  const [edge] =
    page.filters.length > 0
      ? await tx
          .select({ at: exactTimestamp(contacts.createdAt), id: contacts.id })
          .from(contacts)
          .where(range)
          .orderBy(desc(contacts.createdAt), desc(contacts.id))
          .offset(API_CONTACT_SEARCH_WINDOW - 1)
          .limit(1)
      : [];
  const rows = await tx
    .select({ ...apiContactColumns, cursorAt: exactTimestamp(contacts.createdAt) })
    .from(contacts)
    .where(
      and(
        range,
        edge
          ? sql`(${contacts.createdAt}, ${contacts.id}) >= (${edge.at}::timestamptz, ${edge.id}::uuid)`
          : undefined,
        ...page.filters,
      ),
    )
    .orderBy(desc(contacts.createdAt), desc(contacts.id))
    .limit(page.limit + 1);
  const shown = rows.slice(0, page.limit);
  const last = shown.at(-1);
  return {
    data: shown.map(toApiContact),
    nextCursor:
      rows.length > page.limit && last
        ? encodeKeysetCursor(last.cursorAt, last.id)
        : edge
          ? encodeKeysetCursor(edge.at, edge.id)
          : null,
  };
}

/** The custom field values `GET /contacts` finds contacts by, from `fields[<key>]` parameters. */
export const apiContactFieldFiltersSchema = z
  .record(FIELD_KEY, z.string().max(500))
  .refine(
    (v) => Object.keys(v).length <= MAX_FIELD_FILTERS,
    `Filter on at most ${MAX_FIELD_FILTERS} fields.`,
  );

/**
 * Query parameters as the contact list's schema reads them: `fields[<key>]=<value>` (the OpenAPI
 * `deepObject` style) become the `fields` object; anything else is left for the schema to check.
 */
export function contactListQuery(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const query: Record<string, unknown> = {};
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = /^fields\[(.+)\]$/.exec(name)?.[1];
    if (key === undefined) query[name] = value;
    else fields[key] = value;
  }
  if (Object.keys(fields).length > 0) query.fields = fields;
  return query;
}

/**
 * The email address and tag a contact list is filtered by, written as the app keeps them, and the
 * part of a name it looks for (ADR-124) without the spaces at its ends, as names are saved.
 */
export function apiContactListFilters(query: { email?: string; tag?: string; name?: string }): {
  email: string | null;
  tag: string | null;
  name: string | null;
} {
  let email: string | null = null;
  if (query.email !== undefined) {
    const checked = normalizeEmail(query.email);
    if (!checked.ok) throw invalidField('email', checked.message);
    if (!checked.email) throw invalidField('email', 'Give an email address to find.');
    email = checked.email;
  }
  let tag: string | null = null;
  if (query.tag !== undefined) {
    const checked = normalizeTag(query.tag);
    if (!checked.ok) throw invalidField('tag', checked.message);
    tag = checked.tag;
  }
  let name: string | null = null;
  if (query.name !== undefined) {
    name = query.name.trim();
    if (!name) throw invalidField('name', 'Give part of a name to find.');
  }
  return { email, tag, name };
}

/**
 * The condition one filtered field puts on contacts, as segments compare "equals": text equal
 * whatever its case, numbers equal as numbers, dates as written, yes/no as true or false.
 */
function fieldEqualsSql(key: string, value: AttributeValue): SQL {
  const json = sql`(${contacts.attributes} -> ${key}::text)`;
  const text = sql`(${contacts.attributes} ->> ${key}::text)`;
  if (typeof value === 'boolean') return sql`${json} = ${value ? 'true' : 'false'}::jsonb`;
  if (typeof value === 'number') {
    return sql`(case when jsonb_typeof(${json}) = 'number' then ${text}::numeric end) = ${String(value)}::numeric`;
  }
  return sql`lower(${text}) = lower(${value})`;
}

/**
 * The conditions `fields[<key>]` filters put on contacts (ADR-113), each value read with its
 * field's type. An unknown key or a value of another type is refused, naming `fields.<key>`.
 */
export async function apiFieldFilters(
  tx: Tx,
  tenantId: string,
  input: Record<string, string>,
): Promise<SQL[]> {
  const keys = Object.keys(input);
  if (keys.length === 0) return [];
  const defined = await tx
    .select({ key: contactFields.key, label: contactFields.label, type: contactFields.type })
    .from(contactFields)
    .where(and(eq(contactFields.tenantId, tenantId), inArray(contactFields.key, keys)));
  return keys.map((key) => {
    const field = defined.find((f) => f.key === key);
    if (!field) {
      throw invalidField(
        `fields.${key}`,
        `The company has no custom field with the key ${key} (GET /contact-fields).`,
      );
    }
    const checked = apiFieldFilterValue(field, input[key] ?? '');
    if (!checked.ok) throw invalidField(`fields.${key}`, checked.message);
    return fieldEqualsSql(key, checked.value);
  });
}

/**
 * The company's custom fields by label (at most 50, so in one page), for keys that read contacts or
 * define the fields (ADR-115).
 */
export async function apiListContactFields(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
): Promise<ApiContactField[]> {
  assertAnyScope(ctx, ['contacts.read', 'contact_fields.manage']);
  const rows = await deps.db.run(
    ctx.scope,
    (tx) =>
      tx
        .select({
          key: contactFields.key,
          label: contactFields.label,
          type: contactFields.type,
          createdAt: contactFields.createdAt,
        })
        .from(contactFields)
        .where(eq(contactFields.tenantId, ctx.tenant.id))
        .orderBy(asc(contactFields.label), asc(contactFields.key)),
    { accessMode: 'read only' },
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/**
 * A change checked before its transaction: the email and the number normalized and the tags as the
 * app keeps them.
 */
export interface ContactChange {
  name: string | null | undefined;
  email: string | null | undefined;
  /** The number to give the contact, as E.164 (ADR-180; `PATCH /contacts/{id}` only). */
  phone: string | undefined;
  fields: Record<string, unknown> | undefined;
  addTags: string[];
  removeTags: string[];
}

/** Checks what does not need the database; a refusal names `<at><field>`. */
function prepareContactChange(
  data: ContactChangeInput & { phone?: string },
  at: string,
): ContactChange {
  let phone: string | undefined;
  if (data.phone !== undefined) {
    const normalized = normalizePhone(data.phone, { kind: 'explicit' });
    if (!normalized.ok) throw invalidField(`${at}phone`, normalized.message);
    phone = normalized.e164;
  }
  let email: string | null | undefined;
  if (data.email !== undefined) {
    const normalized = normalizeEmail(data.email ?? '');
    if (!normalized.ok) throw invalidField(`${at}email`, normalized.message);
    email = normalized.email;
  }
  const addTags = apiTags(data.addTags ?? [], `${at}addTags`);
  const removeTags = apiTags(data.removeTags ?? [], `${at}removeTags`);
  const both = addTags.find((tag) => removeTags.includes(tag));
  if (both) {
    throw invalidField(`${at}removeTags`, `The tag ${both} cannot be both added and removed.`);
  }
  return { name: data.name, email, phone, fields: data.fields, addTags, removeTags };
}

/** What `FOR UPDATE` reads of a contact before changing it. */
const lockedContactColumns = {
  id: contacts.id,
  name: contacts.displayName,
  email: contacts.email,
  phone: contacts.phoneE164,
  attributes: contacts.attributes,
  erasedAt: contacts.erasedAt,
};

interface LockedContact {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  attributes: Record<string, AttributeValue>;
}

/**
 * Refuses a new number for a contact unless members could give it the same (ADR-180): a contact
 * whose number WhatsApp gave keeps it (it is the contact's identity), no other contact of the company
 * has the number, and it is not on the company's suppression list, as `POST /contacts` refuses.
 */
async function assertNumberFree(
  tx: Tx,
  tenantId: string,
  contactId: string,
  phone: string,
): Promise<void> {
  const [identity] = await tx
    .select({ id: contactIdentities.id })
    .from(contactIdentities)
    .where(
      and(eq(contactIdentities.tenantId, tenantId), eq(contactIdentities.contactId, contactId)),
    )
    .limit(1);
  if (identity) {
    throw new AppError(
      'precondition_failed',
      'This number comes from WhatsApp and cannot be changed.',
    );
  }
  const [suppressed] = await tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.tenantId, tenantId), eq(suppressions.phoneE164, phone)))
    .limit(1);
  if (suppressed) {
    throw new AppError(
      'precondition_failed',
      'This number is on the company’s suppression list, so no contact is given it.',
    );
  }
  const [taken] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.phoneE164, phone)))
    .limit(1);
  if (taken) throw new AppError('conflict', 'Another contact already has this phone number.');
}

/**
 * Applies a change to a contact the transaction has locked, as `PATCH /contacts/{id}` does: what
 * the contact already has changes nothing (no write, no audit entry, no `contact.updated`).
 */
async function changeLockedContact(
  tx: Tx,
  ctx: ApiContext,
  current: LockedContact,
  change: ContactChange,
  fieldChanges: Record<string, AttributeValue | null>,
  at: string,
): Promise<void> {
  const contactId = current.id;
  const thisContact = and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, contactId));
  const set: {
    displayName?: string | null;
    email?: string | null;
    phoneE164?: string;
    attributes?: Record<string, AttributeValue>;
  } = {};
  const changed: string[] = [];
  if (change.name !== undefined && (change.name || null) !== current.name) {
    set.displayName = change.name || null;
    changed.push('name');
  }
  if (change.email !== undefined && change.email !== current.email) {
    set.email = change.email;
    changed.push('email');
  }
  // A typed number changes as members change it (ADR-180), and only to one free for it.
  if (change.phone !== undefined && change.phone !== current.phone) {
    await assertNumberFree(tx, ctx.tenant.id, contactId, change.phone);
    set.phoneE164 = change.phone;
    changed.push('phone');
  }
  const fieldKeys: string[] = [];
  const next = new Map(Object.entries(current.attributes));
  for (const [key, value] of Object.entries(fieldChanges)) {
    if (value === null ? !next.has(key) : next.get(key) === value) continue;
    if (value === null) next.delete(key);
    else next.set(key, value);
    fieldKeys.push(key);
  }
  if (fieldKeys.length > 0) {
    set.attributes = Object.fromEntries(next);
    changed.push('fields');
  }

  let added: string[] = [];
  let removed: string[] = [];
  if (change.addTags.length > 0 || change.removeTags.length > 0) {
    const existing = (
      await tx
        .select({ tag: contactTags.tag })
        .from(contactTags)
        .where(and(eq(contactTags.tenantId, ctx.tenant.id), eq(contactTags.contactId, contactId)))
    ).map((r) => r.tag);
    added = change.addTags.filter((tag) => !existing.includes(tag));
    removed = change.removeTags.filter((tag) => existing.includes(tag));
    if (existing.length + added.length - removed.length > MAX_TAGS_PER_CONTACT) {
      throw invalidField(
        `${at}addTags`,
        `A contact can have at most ${MAX_TAGS_PER_CONTACT} tags.`,
      );
    }
    if (added.length > 0 || removed.length > 0) changed.push('tags');
  }

  if (Object.keys(set).length > 0) await tx.update(contacts).set(set).where(thisContact);
  if (added.length > 0) {
    await tx
      .insert(contactTags)
      .values(added.map((tag) => ({ id: uuidv7(), tenantId: ctx.tenant.id, contactId, tag })))
      .onConflictDoNothing();
  }
  if (removed.length > 0) {
    await tx
      .delete(contactTags)
      .where(
        and(
          eq(contactTags.tenantId, ctx.tenant.id),
          eq(contactTags.contactId, contactId),
          inArray(contactTags.tag, removed),
        ),
      );
  }
  if (changed.length > 0) {
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'contact.updated',
        subjectType: 'contact',
        subjectId: contactId,
        correlationId: ctx.requestId,
        metadata: {
          changed,
          fields: fieldKeys,
          tagsAdded: added.length,
          tagsRemoved: removed.length,
          source: 'api',
        },
      },
      apiActor(ctx),
    );
  }
}

/** The change of `POST /contacts/update-matching`, checked as far as it can be without reading. */
export function prepareContactsAlikeChange(
  input: z.infer<typeof apiContactsAlikeChangeSchema>,
): ContactChange {
  return prepareContactChange(input, 'change.');
}

/**
 * Applies one change to each of these contacts (ADR-165): the fields it sets checked once, the
 * contacts locked `FOR UPDATE` in id order, as changing many contacts locks them (ADR-122), then each
 * changed as `PATCH /contacts/{id}` changes one. A refusal names `change.<part>` and changes
 * nothing. Answers the contacts as they now are, in the order given; an erased one is left out.
 */
export async function changeContactsAlike(
  tx: Tx,
  ctx: ApiContext,
  ids: readonly string[],
  change: ContactChange,
): Promise<ApiContact[]> {
  if (ids.length === 0) return [];
  const keys = Object.keys(change.fields ?? {}).sort();
  const defined = await lockFields(tx, ctx.tenant.id, keys);
  const fieldChanges = change.fields ? checkFieldChanges(defined, change.fields, 'change.') : {};
  const locked = await tx
    .select(lockedContactColumns)
    .from(contacts)
    .where(and(eq(contacts.tenantId, ctx.tenant.id), inArray(contacts.id, [...ids])))
    .orderBy(asc(contacts.id))
    .for('update');
  for (const row of locked) {
    if (row.erasedAt) continue;
    await changeLockedContact(tx, ctx, row, change, fieldChanges, 'change.');
  }
  const rows = await tx
    .select(apiContactColumns)
    .from(contacts)
    .where(
      and(
        eq(contacts.tenantId, ctx.tenant.id),
        inArray(contacts.id, [...ids]),
        isNull(contacts.erasedAt),
      ),
    );
  const after = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = after.get(id);
    return row ? [toApiContact(row)] : [];
  });
}

/**
 * Changes a contact's name, email, number, custom field values and tags as a member's change does,
 * in one transaction with the contact row locked: an erased contact is not found, and what the
 * contact already has changes nothing (no audit entry, and the `contact.updated` webhook event is
 * captured only by a change). A number changes only when typed for the contact (ADR-180).
 */
export async function apiUpdateContact(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  contactId: string,
  input: unknown,
): Promise<ApiContact> {
  assertScope(ctx, 'contacts.write');
  if (!z.uuid().safeParse(contactId).success) throw notFound('Contact');
  const data = parseInput(apiContactUpdateSchema, input);
  const change = prepareContactChange(data, '');
  return deps.db.run(ctx.scope, async (tx) => {
    // The fields are locked before the contact, in the order a field's deletion takes them.
    const fieldChanges = data.fields ? await apiFieldChanges(tx, ctx.tenant.id, data.fields) : {};
    const [current] = await tx
      .select(lockedContactColumns)
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, contactId)))
      .for('update');
    if (!current || current.erasedAt) throw notFound('Contact');
    await changeLockedContact(tx, ctx, current, change, fieldChanges, '');
    const row = await apiContactById(tx, ctx.tenant.id, contactId);
    if (!row) throw notFound('Contact');
    return toApiContact(row);
  });
}

const unknownContact = (index: number) =>
  invalidField(
    `contacts.${index}.id`,
    'The company has no contact with this id, or it was erased (GET /contacts).',
  );

/**
 * Changes up to 100 contacts in one transaction, each as `PATCH /contacts/{id}` changes one, all of
 * them or none (ADR-122). Every field any change names is locked first, in one statement, as a
 * field's deletion takes them; then the contacts, in id order, so calls naming the same contacts
 * take turns. A contact of another company, an erased one, a value of the wrong type or too many
 * tags refuses the call naming its place (`contacts.<index>.…`) and nothing is changed. The
 * contacts are changed in the order given and answered in it.
 */
export async function apiUpdateManyContacts(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  input: unknown,
): Promise<ApiContact[]> {
  assertScope(ctx, 'contacts.write');
  const data = parseInput(apiUpdateManyContactsSchema, input);
  const changes = data.contacts.map((item, index) => ({
    id: item.id,
    change: prepareContactChange(item, `contacts.${index}.`),
  }));
  const ids = changes.map((c) => c.id);
  return deps.db.run(ctx.scope, async (tx) => {
    const keys = [...new Set(changes.flatMap((c) => Object.keys(c.change.fields ?? {})))].sort();
    const defined = await lockFields(tx, ctx.tenant.id, keys);
    const fieldChanges = changes.map((c, index) =>
      c.change.fields ? checkFieldChanges(defined, c.change.fields, `contacts.${index}.`) : {},
    );
    const locked = await tx
      .select(lockedContactColumns)
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenant.id), inArray(contacts.id, ids)))
      .orderBy(asc(contacts.id))
      .for('update');
    const byId = new Map(locked.map((row) => [row.id, row]));
    const work = changes.map((c, index) => {
      const row = byId.get(c.id);
      if (!row || row.erasedAt) throw unknownContact(index);
      return { row, change: c.change, fields: fieldChanges[index] ?? {} };
    });
    for (const [index, w] of work.entries()) {
      await changeLockedContact(tx, ctx, w.row, w.change, w.fields, `contacts.${index}.`);
    }
    const rows = await tx
      .select(apiContactColumns)
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenant.id), inArray(contacts.id, ids)));
    const after = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id, index) => {
      const row = after.get(id);
      if (!row) throw unknownContact(index);
      return toApiContact(row);
    });
  });
}
