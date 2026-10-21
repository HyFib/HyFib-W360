import { AppError, uuidv7 } from '@w360/core';
import { and, contactFields, contacts, eq, sql, type ContactFieldType, type Tx } from '@w360/db';
import {
  MAX_CONTACT_FIELDS,
  fieldKeyFromLabel,
  optionChanges,
  removedChosenOptions,
  sameOptions,
} from './fields';

/**
 * A company's custom contact fields (ADR-115), defined by owners and administrators in Settings and
 * by API keys with `contact_fields.manage`: both call these in their own transaction, after checking
 * who may, and record the audit entry. A field's key and type never change, since values are stored
 * by key and were checked against the type.
 *
 * A choice field's options (ADR-407) can change later: added, reordered, and removed or renamed
 * while no contact has them chosen. An option some contact has chosen stays as it is written, so
 * every stored value is one of its field's options. Every write of values takes the company's
 * contact-field lock shared (`lockContactFieldValues`) before it reads the fields and before it
 * locks a contact, and a change of options takes it exclusively, so neither sees the other halfway,
 * as deal fields do (ADR-385). Additions take it exclusively too (ADR-115).
 */

export interface ContactFieldDefinition {
  id: string;
  key: string;
  label: string;
  type: ContactFieldType;
  /** A choice field's options, in order; null for every other type. */
  options: string[] | null;
  createdAt: Date;
}

/** A field's key: what `fields` and imports use for its values. */
export const CONTACT_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

const definition = {
  id: contactFields.id,
  key: contactFields.key,
  label: contactFields.label,
  type: contactFields.type,
  options: contactFields.options,
  createdAt: contactFields.createdAt,
};

/** The company's contact-field lock, taken exclusively by additions and changes of options. */
const fieldLockKey = (tenantId: string) =>
  sql`hashtextextended(${`contact-fields:${tenantId}`}, 0)`;

/**
 * Takes the company's contact-field lock shared until the transaction ends (ADR-407): every write of
 * contact field values takes it before reading the fields it checks values against, and before it
 * locks a contact, so a change of a choice field's options either finishes first, and the values are
 * checked against the new options, or waits until the values are stored and then sees them. The
 * writer then reads those fields `FOR SHARE`, still before the contact (ADR-112's order), so a
 * deletion of a field, which takes no advisory lock, waits for it or is waited for.
 */
export async function lockContactFieldValues(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${fieldLockKey(tenantId)})`);
}

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
  input: {
    label: string;
    type: ContactFieldType;
    key?: string | undefined;
    /** A choice field's options, checked by `fieldOptionsSchema`; other types take none. */
    options?: readonly string[] | undefined;
  },
): Promise<ContactFieldDefinition> {
  const key = input.key ?? fieldKeyFromLabel(input.label);
  await tx.execute(sql`select pg_advisory_xact_lock(${fieldLockKey(tenantId)})`);
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
    .values({
      id: uuidv7(),
      tenantId,
      key,
      label: input.label,
      type: input.type,
      options: input.type === 'choice' ? [...(input.options ?? [])] : null,
    })
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

/** Why a change of options that leaves out chosen options is refused, naming them. */
export function chosenContactOptionsMessage(options: readonly string[]): string {
  const named = options.map((option) => `“${option}”`).join(', ');
  return options.length === 1
    ? `Contacts have ${named} chosen, so it cannot be removed or renamed. Change those contacts first.`
    : `Contacts have ${named} chosen, so they cannot be removed or renamed. Change those contacts first.`;
}

/** What a change of a choice field's options did, for the audit entry (counts only). */
export interface ContactFieldOptionsChange {
  field: ContactFieldDefinition;
  /** False when the list given is the field's list already: nothing changed. */
  changed: boolean;
  added: number;
  removed: number;
}

/**
 * Gives a choice field a new list of options, checked by `fieldOptionsSchema` (ADR-407): options can
 * be added, reordered, and removed or renamed while no contact has them chosen. An option a contact
 * has chosen must stay in the list as it is written (a change of case is a rename), or the change
 * is refused naming it, so no contact is left with a value that is not an option. The company's
 * contact-field lock is taken exclusively, so a write of values checking them against the options
 * (`lockContactFieldValues`) finishes first, and its value is counted here, or waits and sees the new
 * options. Null when the company has no such field; the same list changes nothing (`changed`
 * false). Erased contacts hold no values, so every value counted is a live contact's.
 */
export async function setContactFieldOptions(
  tx: Tx,
  tenantId: string,
  ref: ContactFieldRef,
  next: readonly string[],
): Promise<ContactFieldOptionsChange | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(${fieldLockKey(tenantId)})`);
  const [field] = await tx.select(definition).from(contactFields).where(matching(tenantId, ref));
  if (!field) return null;
  if (field.type !== 'choice' || !field.options) {
    const message = 'Only choice fields have options.';
    throw new AppError('validation_failed', message, { issues: [{ path: 'options', message }] });
  }
  const current = field.options;
  if (sameOptions(current, next)) return { field, changed: false, added: 0, removed: 0 };
  const used = await tx
    .selectDistinct({ value: sql<string>`${contacts.attributes} ->> ${field.key}::text` })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), sql`${contacts.attributes} ? ${field.key}::text`));
  const kept = removedChosenOptions(
    current,
    next,
    used.map((row) => row.value),
  );
  if (kept.length > 0) {
    const message = chosenContactOptionsMessage(kept);
    throw new AppError('conflict', message, { issues: [{ path: 'options', message }] });
  }
  const [updated] = await tx
    .update(contactFields)
    .set({ options: [...next] })
    .where(and(eq(contactFields.tenantId, tenantId), eq(contactFields.id, field.id)))
    .returning(definition);
  if (!updated) return null;
  return { field: updated, changed: true, ...optionChanges(current, next) };
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
