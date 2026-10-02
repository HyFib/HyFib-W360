import { AppError, uuidv7 } from '@w360/core';
import { and, contactFields, contacts, eq, sql, type ContactFieldType, type Tx } from '@w360/db';
import { MAX_CONTACT_FIELDS, fieldKeyFromLabel } from './fields';

/**
 * A company's custom contact fields (ADR-115), defined by owners and administrators in Settings and
 * by API keys with `contact_fields.manage`: both call these in their own transaction, after checking
 * who may, and record the audit entry. A field's key and type never change, since values are stored
 * by key and were checked against the type.
 */

export interface ContactFieldDefinition {
  id: string;
  key: string;
  label: string;
  type: ContactFieldType;
  createdAt: Date;
}

/** A field's key: what `fields` and imports use for its values. */
export const CONTACT_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

const definition = {
  id: contactFields.id,
  key: contactFields.key,
  label: contactFields.label,
  type: contactFields.type,
  createdAt: contactFields.createdAt,
};

/** Which field: by id (Settings) or by key (the API). */
export type ContactFieldRef = { id: string } | { key: string };

const matching = (tenantId: string, ref: ContactFieldRef) =>
  and(
    eq(contactFields.tenantId, tenantId),
    'id' in ref ? eq(contactFields.id, ref.id) : eq(contactFields.key, ref.key),
  );

/**
 * Adds a field, its key made from the label unless given. A company's additions take turns under one
 * lock, so two at once cannot both pass the limit; a key the company has is refused, naming `key`.
 */
export async function createContactField(
  tx: Tx,
  tenantId: string,
  input: { label: string; type: ContactFieldType; key?: string | undefined },
): Promise<ContactFieldDefinition> {
  const key = input.key ?? fieldKeyFromLabel(input.label);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`contact-fields:${tenantId}`}, 0))`,
  );
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(contactFields)
    .where(eq(contactFields.tenantId, tenantId));
  if (count >= MAX_CONTACT_FIELDS) {
    throw new AppError(
      'validation_failed',
      `A company can define at most ${MAX_CONTACT_FIELDS} fields.`,
    );
  }
  const [row] = await tx
    .insert(contactFields)
    .values({ id: uuidv7(), tenantId, key, label: input.label, type: input.type })
    .onConflictDoNothing()
    .returning(definition);
  if (!row) {
    const message = `A field with the key "${key}" already exists.`;
    throw new AppError('conflict', message, { issues: [{ path: 'key', message }] });
  }
  return row;
}

/**
 * Gives a field a new label; null when the company has no such field. The same label changes
 * nothing (`renamed` false), so a repeated request leaves no trace.
 */
export async function renameContactField(
  tx: Tx,
  tenantId: string,
  ref: ContactFieldRef,
  label: string,
): Promise<{ field: ContactFieldDefinition; renamed: boolean } | null> {
  const [renamed] = await tx
    .update(contactFields)
    .set({ label })
    .where(and(matching(tenantId, ref), sql`${contactFields.label} is distinct from ${label}`))
    .returning(definition);
  if (renamed) return { field: renamed, renamed: true };
  const [current] = await tx.select(definition).from(contactFields).where(matching(tenantId, ref));
  return current ? { field: current, renamed: false } : null;
}

/**
 * Deletes a field and its values on every contact; null when the company has no such field. The
 * field row goes first, then the contacts: a change of a contact's values locks the fields it names
 * before the contact (ADR-112), so it waits for the deletion, or the deletion for it, and its value
 * is removed either way.
 */
export async function deleteContactField(
  tx: Tx,
  tenantId: string,
  ref: ContactFieldRef,
): Promise<ContactFieldDefinition | null> {
  const [row] = await tx.delete(contactFields).where(matching(tenantId, ref)).returning(definition);
  if (!row) return null;
  await tx
    .update(contacts)
    .set({ attributes: sql`${contacts.attributes} - ${row.key}::text` })
    .where(and(eq(contacts.tenantId, tenantId), sql`${contacts.attributes} ? ${row.key}::text`));
  return row;
}
