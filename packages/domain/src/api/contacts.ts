import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  asc,
  contactFields,
  contactTags,
  contacts,
  eq,
  inArray,
  type ContactFieldType,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import {
  MAX_CONTACT_FIELDS,
  MAX_TAGS_PER_CONTACT,
  apiFieldValue,
  normalizeEmail,
  normalizeTag,
  type AttributeValue,
} from '../contacts/fields';
import type { OutboundDeps } from '../messaging/outbound';
import { parseInput } from '../validation';
import { apiContactById, toApiContact, type ApiContact } from './contact-view';
import { apiActor, assertScope, type ApiContext } from './context';

/**
 * Contact custom fields and contact changes through the public API (ADR-112): the company's field
 * definitions, values checked strictly against their field's type, and `PATCH /contacts/{id}`.
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
export const apiContactUpdateSchema = z
  .object({
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
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.email !== undefined ||
      v.fields !== undefined ||
      v.addTags !== undefined ||
      v.removeTags !== undefined,
    'Give name, email, fields, addTags or removeTags.',
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
  const keys = Object.keys(input);
  if (keys.length === 0) return {};
  const defined = await tx
    .select({ key: contactFields.key, label: contactFields.label, type: contactFields.type })
    .from(contactFields)
    .where(and(eq(contactFields.tenantId, tenantId), inArray(contactFields.key, keys)))
    .for('share');
  const changes: Record<string, AttributeValue | null> = {};
  for (const key of keys) {
    const field = defined.find((f) => f.key === key);
    if (!field) {
      throw invalidField(
        `fields.${key}`,
        `The company has no custom field with the key ${key} (GET /contact-fields).`,
      );
    }
    const checked = apiFieldValue(field, input[key]);
    if (!checked.ok) throw invalidField(`fields.${key}`, checked.message);
    changes[key] = checked.value;
  }
  return changes;
}

/** The company's custom fields by label (at most 50, so in one page). */
export async function apiListContactFields(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
): Promise<ApiContactField[]> {
  assertScope(ctx, 'contacts.read');
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
 * Changes a contact's name, email, custom field values and tags as a member's change does, in one
 * transaction with the contact row locked: an erased contact is not found, and what the contact
 * already has changes nothing (no audit entry, and the `contact.updated` webhook event is captured
 * only by a change). The phone number is not changed through the API.
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
  const email = data.email === undefined ? null : normalizeEmail(data.email ?? '');
  if (email && !email.ok) throw invalidField('email', email.message);
  const addTags = apiTags(data.addTags ?? [], 'addTags');
  const removeTags = apiTags(data.removeTags ?? [], 'removeTags');
  const both = addTags.find((tag) => removeTags.includes(tag));
  if (both) throw invalidField('removeTags', `The tag ${both} cannot be both added and removed.`);
  return deps.db.run(ctx.scope, async (tx) => {
    // The fields are locked before the contact, in the order a field's deletion takes them.
    const fieldChanges = data.fields ? await apiFieldChanges(tx, ctx.tenant.id, data.fields) : {};
    const thisContact = and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, contactId));
    const [current] = await tx
      .select({
        name: contacts.displayName,
        email: contacts.email,
        attributes: contacts.attributes,
        erasedAt: contacts.erasedAt,
      })
      .from(contacts)
      .where(thisContact)
      .for('update');
    if (!current || current.erasedAt) throw notFound('Contact');

    const set: {
      displayName?: string | null;
      email?: string | null;
      attributes?: Record<string, AttributeValue>;
    } = {};
    const changed: string[] = [];
    if (data.name !== undefined && (data.name || null) !== current.name) {
      set.displayName = data.name || null;
      changed.push('name');
    }
    if (email?.ok && email.email !== current.email) {
      set.email = email.email;
      changed.push('email');
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
    if (addTags.length > 0 || removeTags.length > 0) {
      const existing = (
        await tx
          .select({ tag: contactTags.tag })
          .from(contactTags)
          .where(and(eq(contactTags.tenantId, ctx.tenant.id), eq(contactTags.contactId, contactId)))
      ).map((r) => r.tag);
      added = addTags.filter((tag) => !existing.includes(tag));
      removed = removeTags.filter((tag) => existing.includes(tag));
      if (existing.length + added.length - removed.length > MAX_TAGS_PER_CONTACT) {
        throw invalidField('addTags', `A contact can have at most ${MAX_TAGS_PER_CONTACT} tags.`);
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
    const row = await apiContactById(tx, ctx.tenant.id, contactId);
    if (!row) throw notFound('Contact');
    return toApiContact(row);
  });
}
