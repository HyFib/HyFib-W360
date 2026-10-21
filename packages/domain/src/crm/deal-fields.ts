import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  asc,
  crmDealFields,
  crmDeals,
  eq,
  DEAL_FIELD_TYPES,
  sql,
  type Database,
  type DealFieldType,
  type Tx,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import {
  MAX_FIELD_OPTION_LENGTH,
  MAX_FIELD_OPTIONS,
  apiFieldValue,
  fieldKeyFromLabel,
  fieldOptionsSchema,
  refineFieldOptions,
  removedChosenOptions,
  sameOptions,
  type AttributeValue,
} from '../contacts/fields';
import { parseInput } from '../validation';
import { coerceDealFieldValue, type DealFieldShape } from './deal-field-values';

export { coerceDealFieldValue } from './deal-field-values';

/**
 * A company's custom deal fields (ADR-373): defined by owners and administrators in Settings →
 * Pipelines, filled in on deals by members who may change them. They take the types contact fields
 * do (ADR-115), or a choice among options of the company's own (ADR-385), and a field's key and
 * type never change, since values are stored by key on the deal (`crm_deals.attributes`) and were
 * checked against the type.
 *
 * A choice field's options can change later: added, reordered, and removed or renamed while no deal
 * has them chosen. An option some deal has chosen stays as it is written, so every stored value is
 * one of its field's options. Values are checked, and options changed, under the company's
 * deal-field lock (`lockedDealFields` shared, changes exclusive), so neither sees the other halfway.
 */

/** The most fields a company defines for its deals, as for contacts. */
export const MAX_DEAL_FIELDS = 50;
/**
 * The most a deal's values take as JSON, in bytes: below the database's 16 KiB bound on the stored
 * jsonb (0293), which adds a few bytes a value, so that a deal over it is refused by name here.
 */
export const MAX_DEAL_ATTRIBUTES_BYTES = 12_288;
/** The most options a choice field has (the database holds the same bound, 0301). */
export const MAX_DEAL_FIELD_OPTIONS = MAX_FIELD_OPTIONS;
/** The most characters an option has (the database holds the same bound, 0301). */
export const MAX_DEAL_FIELD_OPTION_LENGTH = MAX_FIELD_OPTION_LENGTH;

/** Whether a deal's values take more than `MAX_DEAL_ATTRIBUTES_BYTES` as JSON. */
export function dealAttributesTooLarge(next: Readonly<Record<string, AttributeValue>>): boolean {
  return Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_DEAL_ATTRIBUTES_BYTES;
}

function withinSize(next: Record<string, AttributeValue>): Record<string, AttributeValue> {
  if (dealAttributesTooLarge(next)) {
    const message = "A deal's custom field values are limited to 12 KiB in all.";
    throw new AppError('validation_failed', message, { issues: [{ path: 'fields', message }] });
  }
  return next;
}

export interface DealFieldDefinition {
  id: string;
  key: string;
  label: string;
  type: DealFieldType;
  /** A choice field's options, in order; null for every other type. */
  options: string[] | null;
  createdAt: Date;
}

/**
 * A choice field's options: 1 to 50, each trimmed, 1 to 80 characters without control characters,
 * none twice ignoring case, kept in the order given (the rules of contact fields' options since
 * ADR-407).
 */
export const dealFieldOptionsSchema = fieldOptionsSchema;

const labelSchema = z
  .string()
  .trim()
  .min(1, 'Enter a label')
  .max(80, 'Labels are limited to 80 characters.');

export const createDealFieldSchema = z
  .object({
    label: labelSchema,
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lower-case letters, digits and underscores')
      .optional(),
    type: z.enum(DEAL_FIELD_TYPES, {
      error: 'Choose the type: text, number, date, yes/no or a choice.',
    }),
    /** A choice field's options; other types take none. */
    options: dealFieldOptionsSchema.optional(),
  })
  .superRefine(refineFieldOptions);

const definition = {
  id: crmDealFields.id,
  key: crmDealFields.key,
  label: crmDealFields.label,
  type: crmDealFields.type,
  options: crmDealFields.options,
  createdAt: crmDealFields.createdAt,
};

/** The company's deal fields, oldest first, as forms and exports list them. */
export function loadDealFields(tx: Tx, tenantId: string): Promise<DealFieldDefinition[]> {
  return tx
    .select(definition)
    .from(crmDealFields)
    .where(eq(crmDealFields.tenantId, tenantId))
    .orderBy(asc(crmDealFields.createdAt), asc(crmDealFields.id));
}

/**
 * Checks a value sent through the public API against the field's type, strictly, as contact fields
 * are (ADR-112): a choice takes one of its options as text, as written (spaces around it are
 * ignored, as for text values); null or an empty string removes the value.
 */
export function apiDealFieldValue(
  field: Pick<DealFieldDefinition, 'label' | 'type' | 'options'>,
  value: unknown,
): { ok: true; value: AttributeValue | null } | { ok: false; message: string } {
  if (field.type !== 'choice') return apiFieldValue(field, value);
  if (value === null) return { ok: true, value: null };
  const given = typeof value === 'string' ? value.trim() : null;
  if (given === '') return { ok: true, value: null };
  return given !== null && (field.options ?? []).includes(given)
    ? { ok: true, value: given }
    : {
        ok: false,
        message: `${field.label} takes one of its options, written as GET /deal-fields lists them.`,
      };
}

/**
 * Locks the company's deal fields against deletion until the transaction ends and returns them, so
 * values written to a deal are checked against fields that still exist when they are stored; a
 * deletion takes the same lock, then strips its key from every deal.
 */
export async function lockedDealFields(tx: Tx, tenantId: string): Promise<DealFieldDefinition[]> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${`deal-fields:${tenantId}`}, 0))`,
  );
  return loadDealFields(tx, tenantId);
}

/**
 * A deal's values after a change: the values given (field key to the text a member typed, empty to
 * remove) checked against their fields and merged over the current ones. A key no field has is
 * refused, naming it; values of fields that no longer exist are dropped; values over
 * `MAX_DEAL_ATTRIBUTES_BYTES` in all are refused.
 */
export function mergedDealAttributes(
  fields: readonly DealFieldDefinition[],
  current: Readonly<Record<string, AttributeValue>>,
  given: Readonly<Record<string, string>>,
): Record<string, AttributeValue> {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const next = new Map(Object.entries(keptDealAttributes(fields, current)));
  for (const [key, raw] of Object.entries(given)) {
    const field = byKey.get(key);
    const path = `fields.${key}`;
    if (!field) {
      const message = 'This deal field no longer exists.';
      throw new AppError('validation_failed', message, { issues: [{ path, message }] });
    }
    const coerced = coerceDealFieldValue(field, raw);
    if (!coerced.ok) {
      throw new AppError('validation_failed', coerced.message, {
        issues: [{ path, message: coerced.message }],
      });
    }
    if (coerced.value === null) next.delete(key);
    else next.set(key, coerced.value);
  }
  return withinSize(Object.fromEntries(next));
}

/**
 * A deal's values after an API change: each value given as JSON of its field's type (text, a
 * number, a YYYY-MM-DD date, a boolean or one of a choice's options; null removes it), merged over
 * the current ones. A key no
 * field has is refused, naming it; values of fields that no longer exist are dropped; values over
 * `MAX_DEAL_ATTRIBUTES_BYTES` in all are refused.
 */
export function apiMergedDealAttributes(
  fields: readonly DealFieldDefinition[],
  current: Readonly<Record<string, AttributeValue>>,
  given: Readonly<Record<string, unknown>>,
): Record<string, AttributeValue> {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const next = new Map(Object.entries(keptDealAttributes(fields, current)));
  for (const [key, raw] of Object.entries(given)) {
    const field = byKey.get(key);
    const path = `fields.${key}`;
    if (!field) {
      const message = 'The company has no deal field with this key (GET /deal-fields).';
      throw new AppError('validation_failed', message, { issues: [{ path, message }] });
    }
    const checked = apiDealFieldValue(field, raw);
    if (!checked.ok) {
      throw new AppError('validation_failed', checked.message, {
        issues: [{ path, message: checked.message }],
      });
    }
    if (checked.value === null) next.delete(key);
    else next.set(key, checked.value);
  }
  return withinSize(Object.fromEntries(next));
}

/**
 * A deal's values after an automation's step sets some (ADR-386): each value given as typed (null
 * to clear the field) checked against its field, as a member's are, and merged over the current
 * ones. The step changes all of them or none: instead of values, it gets the note of the first that
 * cannot be set, naming its field (`deal_field_missing:<key>` for a field that no longer exists,
 * `deal_field_empty:<key>` for a value whose placeholders filled in nothing,
 * `deal_field_invalid:<key>` for a value the field does not take), or `deal_fields_too_large` when
 * the values would be over `MAX_DEAL_ATTRIBUTES_BYTES` in all. Values of fields that no longer
 * exist are dropped, as for a member's change.
 */
export function stepDealAttributes(
  fields: readonly (DealFieldShape & { key: string })[],
  current: Readonly<Record<string, AttributeValue>>,
  given: readonly { field: string; value: string | null }[],
): { ok: true; attributes: Record<string, AttributeValue> } | { ok: false; note: string } {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const next = new Map(Object.entries(keptDealAttributes(fields, current)));
  for (const { field: key, value } of given) {
    const field = byKey.get(key);
    if (!field) return { ok: false, note: `deal_field_missing:${key}` };
    if (value === null) {
      next.delete(key);
      continue;
    }
    if (!value.trim()) return { ok: false, note: `deal_field_empty:${key}` };
    const coerced = coerceDealFieldValue(field, value);
    if (!coerced.ok || coerced.value === null) {
      return { ok: false, note: `deal_field_invalid:${key}` };
    }
    next.set(key, coerced.value);
  }
  const attributes = Object.fromEntries(next);
  return dealAttributesTooLarge(attributes)
    ? { ok: false, note: 'deal_fields_too_large' }
    : { ok: true, attributes };
}

/** A deal's values of fields that still exist. */
export function keptDealAttributes(
  fields: readonly { key: string }[],
  attributes: Readonly<Record<string, AttributeValue>>,
): Record<string, AttributeValue> {
  const keys = new Set(fields.map((field) => field.key));
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => keys.has(key)));
}

/** Whether two sets of values hold the same keys and values, whatever their order. */
export function sameAttributes(
  a: Readonly<Record<string, AttributeValue>>,
  b: Readonly<Record<string, AttributeValue>>,
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

/** A deal's values as shown: only those of fields that still exist, in the fields' order. */
export function shownDealAttributes(
  fields: readonly DealFieldDefinition[],
  attributes: Readonly<Record<string, AttributeValue>>,
): { key: string; label: string; type: DealFieldType; value: AttributeValue }[] {
  return fields.flatMap((field) => {
    const value = attributes[field.key];
    return value === undefined
      ? []
      : [{ key: field.key, label: field.label, type: field.type, value }];
  });
}

/** Shared with contact fields' options (ADR-407). */
export { removedChosenOptions, sameOptions };

/** Why a change of options that leaves out chosen options is refused, naming them. */
export function chosenOptionsMessage(options: readonly string[]): string {
  const named = options.map((option) => `“${option}”`).join(', ');
  return options.length === 1
    ? `Deals have ${named} chosen, so it cannot be removed or renamed. Change those deals first.`
    : `Deals have ${named} chosen, so they cannot be removed or renamed. Change those deals first.`;
}

/**
 * Settings → Pipelines' deal fields: listed to anyone who reads the CRM, changed by owners and
 * administrators (`tenant.settings.manage`), each change in the audit log.
 */
export function dealFieldOperations(deps: { db: Database }) {
  const { db } = deps;
  return {
    async listDealFields(ctx: TenantContext): Promise<DealFieldDefinition[]> {
      assertCan(ctx, 'crm.read');
      return db.run(ctx.scope, (tx) => loadDealFields(tx, ctx.tenant.id), {
        accessMode: 'read only',
      });
    },

    /**
     * Adds a field, its key made from the label unless given. The company's additions take turns
     * under one lock, so two at once cannot both pass the limit; a key the company has is refused.
     */
    async createDealField(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(createDealFieldSchema, input);
      const key = data.key ?? fieldKeyFromLabel(data.label);
      return db.run(ctx.scope, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`deal-fields:${ctx.tenant.id}`}, 0))`,
        );
        const [{ count } = { count: 0 }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(crmDealFields)
          .where(eq(crmDealFields.tenantId, ctx.tenant.id));
        if (count >= MAX_DEAL_FIELDS) {
          throw new AppError(
            'validation_failed',
            `A company can define at most ${MAX_DEAL_FIELDS} deal fields.`,
          );
        }
        const [field] = await tx
          .insert(crmDealFields)
          .values({
            id: uuidv7(),
            tenantId: ctx.tenant.id,
            key,
            label: data.label,
            type: data.type,
            options: data.type === 'choice' ? (data.options ?? null) : null,
          })
          .onConflictDoNothing()
          .returning(definition);
        if (!field) {
          const message = `A deal field with the key "${key}" already exists.`;
          throw new AppError('conflict', message, { issues: [{ path: 'key', message }] });
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'crm.deal_field_created',
            subjectType: 'crm_deal_field',
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

    /** Gives a field a new label; the same label changes nothing and leaves no trace. */
    async renameDealField(
      ctx: TenantContext,
      fieldId: string,
      label: string,
      meta: RequestMeta = {},
    ) {
      assertCan(ctx, 'tenant.settings.manage');
      const parsed = parseInput(labelSchema, label);
      if (!z.uuid().safeParse(fieldId).success) throw notFound('Deal field');
      await db.run(ctx.scope, async (tx) => {
        const matching = and(
          eq(crmDealFields.tenantId, ctx.tenant.id),
          eq(crmDealFields.id, fieldId),
        );
        const [renamed] = await tx
          .update(crmDealFields)
          .set({ label: parsed })
          .where(and(matching, sql`${crmDealFields.label} is distinct from ${parsed}`))
          .returning(definition);
        if (!renamed) {
          const [current] = await tx.select(definition).from(crmDealFields).where(matching);
          if (!current) throw notFound('Deal field');
          return;
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'crm.deal_field_renamed',
            subjectType: 'crm_deal_field',
            subjectId: fieldId,
            metadata: { key: renamed.key },
          },
          meta,
        );
      });
    },

    /**
     * Gives a choice field a new list of options (ADR-385): options can be added, reordered, and
     * removed or renamed while no deal has them chosen. An option a deal has chosen must stay in the
     * list as it is written, or the change is refused naming it, so no deal is left with a value
     * that is not an option. The company's field lock is taken exclusively, so a deal change
     * checking its values (`lockedDealFields`) finishes first or sees the new options. The same list
     * changes nothing and leaves no trace.
     */
    async setDealFieldOptions(
      ctx: TenantContext,
      fieldId: string,
      options: unknown,
      meta: RequestMeta = {},
    ) {
      assertCan(ctx, 'tenant.settings.manage');
      const next = parseInput(dealFieldOptionsSchema, options);
      if (!z.uuid().safeParse(fieldId).success) throw notFound('Deal field');
      await db.run(ctx.scope, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`deal-fields:${ctx.tenant.id}`}, 0))`,
        );
        const [field] = await tx
          .select(definition)
          .from(crmDealFields)
          .where(and(eq(crmDealFields.tenantId, ctx.tenant.id), eq(crmDealFields.id, fieldId)));
        if (!field) throw notFound('Deal field');
        if (field.type !== 'choice' || !field.options) {
          const message = 'Only choice fields have options.';
          throw new AppError('validation_failed', message, {
            issues: [{ path: 'options', message }],
          });
        }
        const current = field.options;
        if (sameOptions(current, next)) return;
        const used = await tx
          .selectDistinct({ value: sql<string>`${crmDeals.attributes} ->> ${field.key}::text` })
          .from(crmDeals)
          .where(
            and(
              eq(crmDeals.tenantId, ctx.tenant.id),
              sql`${crmDeals.attributes} ? ${field.key}::text`,
            ),
          );
        const kept = removedChosenOptions(
          current,
          next,
          used.map((row) => row.value),
        );
        if (kept.length > 0) {
          const message = chosenOptionsMessage(kept);
          throw new AppError('conflict', message, { issues: [{ path: 'options', message }] });
        }
        await tx
          .update(crmDealFields)
          .set({ options: next })
          .where(and(eq(crmDealFields.tenantId, ctx.tenant.id), eq(crmDealFields.id, fieldId)));
        const before = new Set(current);
        const after = new Set(next);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'crm.deal_field_options_changed',
            subjectType: 'crm_deal_field',
            subjectId: fieldId,
            metadata: {
              key: field.key,
              options: next.length,
              added: next.filter((option) => !before.has(option)).length,
              removed: current.filter((option) => !after.has(option)).length,
            },
          },
          meta,
        );
      });
    },

    /**
     * Deletes a field and its value on every deal. It takes the company's field lock exclusively,
     * so a deal change checking its values against the fields (`lockedDealFields`) either finishes
     * first, and its value is stripped here, or waits and no longer finds the field.
     */
    async deleteDealField(ctx: TenantContext, fieldId: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      if (!z.uuid().safeParse(fieldId).success) throw notFound('Deal field');
      await db.run(ctx.scope, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`deal-fields:${ctx.tenant.id}`}, 0))`,
        );
        const [field] = await tx
          .delete(crmDealFields)
          .where(and(eq(crmDealFields.tenantId, ctx.tenant.id), eq(crmDealFields.id, fieldId)))
          .returning(definition);
        if (!field) throw notFound('Deal field');
        await tx
          .update(crmDeals)
          .set({ attributes: sql`${crmDeals.attributes} - ${field.key}::text` })
          .where(
            and(
              eq(crmDeals.tenantId, ctx.tenant.id),
              sql`${crmDeals.attributes} ? ${field.key}::text`,
            ),
          );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'crm.deal_field_deleted',
            subjectType: 'crm_deal_field',
            subjectId: fieldId,
            metadata: { key: field.key },
          },
          meta,
        );
      });
    },
  };
}
