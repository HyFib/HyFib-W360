import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  asc,
  crmDealFields,
  crmDeals,
  eq,
  sql,
  type ContactFieldType,
  type Database,
  type Tx,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import {
  apiFieldValue,
  coerceFieldValue,
  fieldKeyFromLabel,
  type AttributeValue,
} from '../contacts/fields';
import { parseInput } from '../validation';

/**
 * A company's custom deal fields (ADR-373): defined by owners and administrators in Settings →
 * Pipelines, filled in on deals by members who may change them. They take the types contact fields
 * do (ADR-115), and a field's key and type never change, since values are stored by key on the deal
 * (`crm_deals.attributes`) and were checked against the type.
 */

/** The most fields a company defines for its deals, as for contacts. */
export const MAX_DEAL_FIELDS = 50;
/**
 * The most a deal's values take as JSON, in bytes: below the database's 16 KiB bound on the stored
 * jsonb (0293), which adds a few bytes a value, so that a deal over it is refused by name here.
 */
export const MAX_DEAL_ATTRIBUTES_BYTES = 12_288;

function withinSize(next: Record<string, AttributeValue>): Record<string, AttributeValue> {
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_DEAL_ATTRIBUTES_BYTES) {
    const message = "A deal's custom field values are limited to 12 KiB in all.";
    throw new AppError('validation_failed', message, { issues: [{ path: 'fields', message }] });
  }
  return next;
}

export interface DealFieldDefinition {
  id: string;
  key: string;
  label: string;
  type: ContactFieldType;
  createdAt: Date;
}

export const createDealFieldSchema = z.object({
  label: z.string().trim().min(1, 'Enter a label').max(80, 'Labels are limited to 80 characters.'),
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lower-case letters, digits and underscores')
    .optional(),
  type: z.enum(['text', 'number', 'date', 'boolean'], {
    error: 'Choose the type: text, number, date or yes/no.',
  }),
});

const definition = {
  id: crmDealFields.id,
  key: crmDealFields.key,
  label: crmDealFields.label,
  type: crmDealFields.type,
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
    const coerced = coerceFieldValue(field, raw);
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
 * number, a YYYY-MM-DD date or a boolean; null removes it), merged over the current ones. A key no
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
    const checked = apiFieldValue(field, raw);
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
): { key: string; label: string; type: ContactFieldType; value: AttributeValue }[] {
  return fields.flatMap((field) => {
    const value = attributes[field.key];
    return value === undefined
      ? []
      : [{ key: field.key, label: field.label, type: field.type, value }];
  });
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
            metadata: { key: field.key, type: field.type },
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
      const parsed = parseInput(createDealFieldSchema.shape.label, label);
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
