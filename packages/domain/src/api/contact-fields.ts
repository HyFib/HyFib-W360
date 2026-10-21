import { z } from 'zod';
import { notFound } from '@w360/core';
import { CONTACT_FIELD_TYPES } from '@w360/db';
import { recordSystemAudit } from '../audit';
import {
  CONTACT_FIELD_KEY_RE,
  createContactField,
  deleteContactField,
  renameContactField,
  setContactFieldOptions,
  type ContactFieldDefinition,
} from '../contacts/field-definitions';
import { fieldOptionsSchema, refineFieldOptions } from '../contacts/fields';
import type { OutboundDeps } from '../messaging/outbound';
import { parseInput } from '../validation';
import type { ApiContactField } from './contacts';
import { apiActor, assertScope, type ApiContext } from './context';
import type { ApiResponse, IdempotencyInput } from './idempotency';
import { idempotent } from './resources';

/**
 * Defining contact fields through the public API (ADR-115): a key with `contact_fields.manage`
 * adds, renames and deletes the company's custom fields as owners and administrators do in Settings,
 * through the same functions, and is audited as the key. A field is named by its key, which, like its
 * type, never changes. A choice field's options (ADR-407) change through `PATCH`, under the rules
 * Settings follows.
 */

const options = fieldOptionsSchema.describe(
  'A choice field’s options, in order: 1 to 50, each trimmed, 1 to 80 characters without line breaks or control characters, none twice ignoring case.',
);

const label = z
  .string()
  .trim()
  .min(1, 'Enter a label')
  .max(80)
  .describe('The name members see, 1 to 80 characters.');

export const apiContactFieldCreateSchema = z
  .object({
    label,
    type: z
      .enum(CONTACT_FIELD_TYPES)
      .describe(
        '`text`, `number`, `date` (YYYY-MM-DD), `boolean` (yes/no) or `choice` (one of `options`); it never changes.',
      ),
    key: z
      .string()
      .regex(CONTACT_FIELD_KEY_RE, 'Use lower-case letters, digits and underscores')
      .optional()
      .describe(
        'The key `fields` uses for the values: a lower-case letter, then up to 39 lower-case letters, digits and underscores. Made from the label when left out; it never changes.',
      ),
    options: options.optional().describe('Required for a `choice` field; no other type takes it.'),
  })
  .strict()
  .superRefine(refineFieldOptions);

export const apiContactFieldUpdateSchema = z
  .object({
    label: label.optional(),
    options: options
      .optional()
      .describe(
        'A choice field’s new options. Options can be added, reordered, and removed or renamed while no contact has them chosen; one a contact has chosen must stay as it is written, or the change is refused with 409 naming it (path `options`). The same list changes nothing.',
      ),
  })
  .strict()
  .refine((v) => v.label !== undefined || v.options !== undefined, 'Give label or options.')
  // The refinement is not part of the JSON schema; the document says it with minProperties.
  .meta({ minProperties: 1, description: 'Give the label, the options, or both.' });

const toApi = (field: ContactFieldDefinition): ApiContactField => ({
  key: field.key,
  label: field.label,
  type: field.type,
  options: field.options,
  createdAt: field.createdAt.toISOString(),
});

/** A key in a path that no field can have is not found, as an id that is not a UUID is. */
function fieldKey(key: string): string {
  if (!CONTACT_FIELD_KEY_RE.test(key)) throw notFound('Contact field');
  return key;
}

/** Adds a field: 201 with it, once per `Idempotency-Key` when one is given. */
export async function apiCreateContactField(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'contact_fields.manage');
  const data = parseInput(apiContactFieldCreateSchema, input);
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, deps.clock.now(), async () => {
      const field = await createContactField(tx, ctx.tenant.id, data);
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'contact_field.created',
          subjectType: 'contact_field',
          subjectId: field.id,
          correlationId: ctx.requestId,
          metadata: {
            key: field.key,
            type: field.type,
            ...(field.options ? { options: field.options.length } : {}),
          },
        },
        apiActor(ctx),
      );
      return { status: 201, body: { data: toApi(field) } };
    }),
  );
}

/**
 * Gives a field a new label, a choice field new options (ADR-407), or both, in one transaction;
 * what the field has already changes nothing, so a retry needs no key. Options of another type of
 * field are refused (422), and options a contact has chosen left out (409), saving nothing.
 */
export async function apiUpdateContactField(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  key: string,
  input: unknown,
): Promise<ApiContactField> {
  assertScope(ctx, 'contact_fields.manage');
  const data = parseInput(apiContactFieldUpdateSchema, input);
  const ref = { key: fieldKey(key) };
  return deps.db.run(ctx.scope, async (tx) => {
    let field: ContactFieldDefinition | null = null;
    if (data.options !== undefined) {
      const result = await setContactFieldOptions(tx, ctx.tenant.id, ref, data.options);
      if (!result) throw notFound('Contact field');
      field = result.field;
      if (result.changed) {
        await recordSystemAudit(
          tx,
          ctx.tenant.id,
          {
            action: 'contact_field.options_changed',
            subjectType: 'contact_field',
            subjectId: result.field.id,
            correlationId: ctx.requestId,
            metadata: {
              key: result.field.key,
              options: data.options.length,
              added: result.added,
              removed: result.removed,
            },
          },
          apiActor(ctx),
        );
      }
    }
    if (data.label !== undefined) {
      const result = await renameContactField(tx, ctx.tenant.id, ref, data.label);
      if (!result) throw notFound('Contact field');
      field = result.field;
      if (result.renamed) {
        await recordSystemAudit(
          tx,
          ctx.tenant.id,
          {
            action: 'contact_field.renamed',
            subjectType: 'contact_field',
            subjectId: result.field.id,
            correlationId: ctx.requestId,
            metadata: { key: result.field.key },
          },
          apiActor(ctx),
        );
      }
    }
    if (!field) throw notFound('Contact field');
    return toApi(field);
  });
}

/** Deletes a field and its values on every contact, as Settings does. */
export async function apiDeleteContactField(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  key: string,
): Promise<{ key: string; deleted: true }> {
  assertScope(ctx, 'contact_fields.manage');
  const ref = { key: fieldKey(key) };
  return deps.db.run(ctx.scope, async (tx) => {
    const field = await deleteContactField(tx, ctx.tenant.id, ref);
    if (!field) throw notFound('Contact field');
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'contact_field.deleted',
        subjectType: 'contact_field',
        subjectId: field.id,
        correlationId: ctx.requestId,
        metadata: { key: field.key },
      },
      apiActor(ctx),
    );
    return { key: field.key, deleted: true };
  });
}
