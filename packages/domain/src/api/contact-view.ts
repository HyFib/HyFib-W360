import { z } from 'zod';
import { AppError, notFound } from '@w360/core';
import { and, contactMerges, contacts, eq, isNull, outerColumn, sql, type Tx } from '@w360/db';

/**
 * A custom field's value: text and dates (`YYYY-MM-DD`) as strings, numbers, yes/no as booleans, a
 * choice as its option (a string, ADR-407).
 */
export type ApiFieldValue = string | number | boolean;

/**
 * A contact in the API's words (ADR-052), shared by the API and the contact webhooks (ADR-074), so
 * both describe a contact the same way. `fields` holds the values of the company's custom fields by
 * key (ADR-112).
 */
export interface ApiContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  fields: Record<string, ApiFieldValue>;
  consent: { marketing: 'opted_in' | 'opted_out' | null; utility: 'opted_in' | 'opted_out' | null };
  source: string;
  createdAt: string;
}

const consentValue = z.enum(['opted_in', 'opted_out']).nullable();

/** The OpenAPI description of a contact. */
export const apiContactSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  phone: z.string().nullable().describe('E.164, like +919876543210.'),
  email: z.string().nullable(),
  tags: z.array(z.string()),
  fields: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .describe(
      'Custom field values by field key (GET /contact-fields): text and dates (YYYY-MM-DD) as strings, numbers as numbers, yes/no as booleans, a choice as its option written as GET /contact-fields lists it. A field without a value is left out.',
    ),
  consent: z.object({ marketing: consentValue, utility: consentValue }),
  source: z.string().describe('Where the contact came from: whatsapp, manual, import, api, store.'),
  createdAt: z.iso.datetime(),
});

// Outer columns named in full: these selects have no joins, so drizzle would leave the table out
// and `id` would bind to the subquery's own table.
const consentState = (purpose: 'marketing' | 'utility') =>
  sql<'opted_in' | 'opted_out' | null>`(select cc.status from app.contact_consents cc
    where cc.tenant_id = ${outerColumn(contacts.tenantId)} and cc.contact_id = ${outerColumn(contacts.id)}
      and cc.purpose = ${purpose})`;

// Values of the fields the company defines only, so a value written for a field deleted at the
// same moment is never read.
const definedFieldValues = sql<Record<string, ApiFieldValue>>`coalesce((select
    jsonb_object_agg(f.key, ${outerColumn(contacts.attributes)} -> f.key)
  from app.contact_fields f
  where f.tenant_id = ${outerColumn(contacts.tenantId)}
    and ${outerColumn(contacts.attributes)} ? f.key), '{}'::jsonb)`;

export const apiContactColumns = {
  id: contacts.id,
  name: contacts.displayName,
  phone: contacts.phoneE164,
  email: contacts.email,
  source: contacts.source,
  createdAt: contacts.createdAt,
  erasedAt: contacts.erasedAt,
  tags: sql<string[]>`coalesce((select array_agg(t.tag order by t.tag) from app.contact_tags t
    where t.tenant_id = ${outerColumn(contacts.tenantId)} and t.contact_id = ${outerColumn(contacts.id)}), '{}')`,
  fields: definedFieldValues,
  marketing: consentState('marketing'),
  utility: consentState('utility'),
};

export type ApiContactRow = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  createdAt: Date;
  erasedAt: Date | null;
  tags: string[];
  fields: Record<string, ApiFieldValue>;
  marketing: 'opted_in' | 'opted_out' | null;
  utility: 'opted_in' | 'opted_out' | null;
};

export const toApiContact = (r: ApiContactRow): ApiContact => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  email: r.email,
  tags: r.tags,
  fields: r.fields,
  consent: { marketing: r.marketing, utility: r.utility },
  source: r.source,
  createdAt: r.createdAt.toISOString(),
});

/** The contact unless it was erased (the API treats an erased contact as not found). */
export async function apiContactById(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<ApiContactRow | null> {
  const [row] = await tx
    .select(apiContactColumns)
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, id), isNull(contacts.erasedAt)));
  return row ?? null;
}

/**
 * The error for a contact the API does not find (ADR-225). A contact merged into another names the
 * contact it belongs to now: app.contact_merges points at the contact kept by the latest merge.
 */
export async function apiContactNotFound(tx: Tx, tenantId: string, id: string): Promise<AppError> {
  const [merged] = await tx
    .select({ keptContactId: contactMerges.keptContactId })
    .from(contactMerges)
    .where(and(eq(contactMerges.tenantId, tenantId), eq(contactMerges.mergedContactId, id)));
  if (!merged) return notFound('Contact');
  return new AppError('not_found', 'This contact was merged into another contact.', {
    details: { apiReason: 'contact_merged', mergedInto: merged.keptContactId },
  });
}
