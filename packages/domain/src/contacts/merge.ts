import { z } from 'zod';
import { notFound, type Clock } from '@w360/core';
import {
  and,
  asc,
  channelAccounts,
  contactIdentities,
  contactMerges,
  contacts,
  contactTags,
  conversations,
  eq,
  sql,
  whatsappAccounts,
  type ContactSource,
  type Database,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { parseInput } from '../validation';
import { MAX_TAGS_PER_CONTACT, type AttributeValue } from './fields';

/**
 * Merging two contacts of a company (H-019, ADR-224). A member keeps one contact and merges the
 * other into it: the other contact's WhatsApp identities, conversations, consent history, tags,
 * field values, CRM records, orders, campaign sends, automation runs and form answers move to the
 * kept contact, which keeps its own name, number, email and field values and takes the other's
 * where it has none. The other contact is then deleted (`app.merge_contacts`), so anything still
 * naming it fails instead of landing on a contact nobody sees. Consent ends as the stricter of the
 * two: an opt-out of either contact stands, and a merge never adds an opt-in the kept contact did
 * not have. Contacts that each have a phone number, or a conversation on the same WhatsApp number,
 * stay separate: a contact has one number, and one conversation per company number.
 */

export const mergeContactsSchema = z.object({
  keepContactId: z.uuid(),
  mergeContactId: z.uuid(),
});

export type ConsentState = 'opted_in' | 'opted_out' | null;

/** One of the two contacts, as the merge compares them. */
export interface MergeSide {
  id: string;
  displayName: string | null;
  phoneE164: string | null;
  email: string | null;
  attributes: Record<string, AttributeValue>;
  source: ContactSource;
  createdAt: Date;
  erased: boolean;
  tags: string[];
  identities: {
    whatsappAccountName: string | null;
    waId: string | null;
    hasBsuid: boolean;
    profileName: string | null;
  }[];
  conversations: { channelAccountId: string; channelName: string | null }[];
  consent: { marketing: ConsentState; utility: ConsentState };
  /** Records that move with the contact. */
  counts: MergeCounts;
}

export interface MergeCounts {
  consentEvents: number;
  deals: number;
  tasks: number;
  notes: number;
  orders: number;
  storeMessages: number;
  campaignSends: number;
  automationRuns: number;
  flowAnswers: number;
}

/** Why two contacts cannot be merged. */
export type MergeRefusal =
  | { code: 'same_contact' }
  | { code: 'erased' }
  | { code: 'both_phones' }
  | { code: 'same_number'; channelName: string | null }
  | { code: 'too_many_tags'; count: number };

/** What a merge does to one purpose's consent. */
export interface ConsentOutcome {
  result: ConsentState;
  /** The merged contact's opt-out replaces the kept contact's state. */
  carriedOptOut: boolean;
  /** The merged contact opted in and the kept one has no record: the opt-in does not carry over. */
  optInNotCarried: boolean;
}

export interface MergePlan {
  refusals: MergeRefusal[];
  displayName: string | null;
  phoneE164: string | null;
  email: string | null;
  attributes: Record<string, AttributeValue>;
  /** Keys of the merged contact's field values the kept contact's own values replace. */
  droppedAttributes: string[];
  /** The merged contact's name and email, when the kept contact's own replace them. */
  droppedName: string | null;
  droppedEmail: string | null;
  tags: string[];
  consent: { marketing: ConsentOutcome; utility: ConsentOutcome };
}

/**
 * The stricter of two consent states: an opt-out of either contact stands; otherwise the kept
 * contact's state stays, so a merge never turns consent on. `app.merge_contacts` applies the same.
 */
export function mergedConsent(keep: ConsentState, merge: ConsentState): ConsentOutcome {
  if (merge === 'opted_out' && keep !== 'opted_out') {
    return { result: 'opted_out', carriedOptOut: true, optInNotCarried: false };
  }
  return { result: keep, carriedOptOut: false, optInNotCarried: merge === 'opted_in' && !keep };
}

/** What merging `merge` into `keep` would do, and why it cannot be done, if it cannot. */
export function planContactMerge(keep: MergeSide, merge: MergeSide): MergePlan {
  const refusals: MergeRefusal[] = [];
  const tags = [...new Set([...keep.tags, ...merge.tags])].sort();
  if (keep.id === merge.id) {
    refusals.push({ code: 'same_contact' });
  } else {
    if (keep.erased || merge.erased) refusals.push({ code: 'erased' });
    if (keep.phoneE164 && merge.phoneE164) refusals.push({ code: 'both_phones' });
    const keptNumbers = new Set(keep.conversations.map((c) => c.channelAccountId));
    for (const c of merge.conversations) {
      if (keptNumbers.has(c.channelAccountId)) {
        refusals.push({ code: 'same_number', channelName: c.channelName });
      }
    }
    if (tags.length > MAX_TAGS_PER_CONTACT) {
      refusals.push({ code: 'too_many_tags', count: tags.length });
    }
  }
  const droppedAttributes = Object.keys(merge.attributes)
    .filter((key) => key in keep.attributes && keep.attributes[key] !== merge.attributes[key])
    .sort();
  return {
    refusals,
    displayName: keep.displayName ?? merge.displayName,
    phoneE164: keep.phoneE164 ?? merge.phoneE164,
    email: keep.email ?? merge.email,
    attributes: { ...merge.attributes, ...keep.attributes },
    droppedAttributes,
    droppedName:
      keep.displayName && merge.displayName && keep.displayName !== merge.displayName
        ? merge.displayName
        : null,
    droppedEmail: keep.email && merge.email && keep.email !== merge.email ? merge.email : null,
    tags,
    consent: {
      marketing: mergedConsent(keep.consent.marketing, merge.consent.marketing),
      utility: mergedConsent(keep.consent.utility, merge.consent.utility),
    },
  };
}

/**
 * How the merge page explains a refusal. `app.merge_contacts` refuses the same cases again under
 * its locks, in fixed sentences that name neither the number nor the count.
 */
export function mergeRefusalMessage(refusal: MergeRefusal): string {
  switch (refusal.code) {
    case 'same_contact':
      return 'A contact cannot be merged into itself.';
    case 'erased':
      return 'An erased contact cannot be merged.';
    case 'both_phones':
      return 'Both contacts have a phone number. A contact keeps one number, so they stay separate.';
    case 'same_number':
      return `Both contacts have a conversation on ${refusal.channelName ?? 'the same WhatsApp number'}. Conversations cannot be joined, so they stay separate.`;
    case 'too_many_tags':
      return `Together these contacts have ${refusal.count} tags, more than the ${MAX_TAGS_PER_CONTACT} a contact can have. Remove some first.`;
  }
}

/** The merge's summary `app.merge_contacts` returns and the audit entry keeps: counts only. */
export const mergeSummarySchema = z.object({
  identities: z.number().int(),
  conversations: z.number().int(),
  consentEvents: z.number().int(),
  tags: z.number().int(),
  deals: z.number().int(),
  tasks: z.number().int(),
  notes: z.number().int(),
  orders: z.number().int(),
  storeMessages: z.number().int(),
  campaignSends: z.number().int(),
  automationRuns: z.number().int(),
  flowSends: z.number().int(),
  flowAnswers: z.number().int(),
  conversationSources: z.number().int(),
  optOutsCarried: z.array(z.enum(['marketing', 'utility'])),
});
export type MergeSummary = z.infer<typeof mergeSummarySchema>;

async function loadSide(tx: Tx, tenantId: string, contactId: string): Promise<MergeSide | null> {
  const [row] = await tx
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      phoneE164: contacts.phoneE164,
      email: contacts.email,
      attributes: contacts.attributes,
      source: contacts.source,
      createdAt: contacts.createdAt,
      erasedAt: contacts.erasedAt,
      marketing: sql<ConsentState>`(select cc.status from app.contact_consents cc
        where cc.tenant_id = ${tenantId} and cc.contact_id = ${contactId} and cc.purpose = 'marketing')`,
      utility: sql<ConsentState>`(select cc.status from app.contact_consents cc
        where cc.tenant_id = ${tenantId} and cc.contact_id = ${contactId} and cc.purpose = 'utility')`,
      consentEvents: sql<number>`(select count(*)::int from app.consent_events e
        where e.tenant_id = ${tenantId} and e.contact_id = ${contactId})`,
      deals: sql<number>`(select count(*)::int from app.crm_deals d
        where d.tenant_id = ${tenantId} and d.contact_id = ${contactId})`,
      tasks: sql<number>`(select count(*)::int from app.crm_tasks t
        where t.tenant_id = ${tenantId} and t.contact_id = ${contactId})`,
      notes: sql<number>`(select count(*)::int from app.crm_activities a
        where a.tenant_id = ${tenantId} and a.contact_id = ${contactId})`,
      orders: sql<number>`(select count(*)::int from app.commerce_orders o
        where o.tenant_id = ${tenantId} and o.contact_id = ${contactId})`,
      storeMessages: sql<number>`(select count(*)::int from app.commerce_store_messages s
        where s.tenant_id = ${tenantId} and s.contact_id = ${contactId})`,
      campaignSends: sql<number>`(select count(*)::int from app.campaign_recipients r
        where r.tenant_id = ${tenantId} and r.contact_id = ${contactId})`,
      automationRuns: sql<number>`(select count(*)::int from app.automation_runs r
        where r.tenant_id = ${tenantId} and r.contact_id = ${contactId})`,
      flowAnswers: sql<number>`(select count(*)::int from app.flow_responses f
        where f.tenant_id = ${tenantId} and f.contact_id = ${contactId})`,
    })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)));
  if (!row) return null;
  const tags = await tx
    .select({ tag: contactTags.tag })
    .from(contactTags)
    .where(and(eq(contactTags.tenantId, tenantId), eq(contactTags.contactId, contactId)))
    .orderBy(asc(contactTags.tag));
  const identities = await tx
    .select({
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
      and(eq(contactIdentities.tenantId, tenantId), eq(contactIdentities.contactId, contactId)),
    )
    .orderBy(asc(contactIdentities.createdAt), asc(contactIdentities.id));
  const threads = await tx
    .select({
      channelAccountId: conversations.channelAccountId,
      channelName: channelAccounts.displayPhoneNumber,
    })
    .from(conversations)
    .innerJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, conversations.tenantId),
        eq(channelAccounts.id, conversations.channelAccountId),
      ),
    )
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.contactId, contactId)))
    .orderBy(asc(conversations.createdAt), asc(conversations.id));
  return {
    id: row.id,
    displayName: row.displayName,
    phoneE164: row.phoneE164,
    email: row.email,
    attributes: row.attributes,
    source: row.source,
    createdAt: row.createdAt,
    erased: row.erasedAt !== null,
    tags: tags.map((t) => t.tag),
    identities,
    conversations: threads,
    consent: { marketing: row.marketing, utility: row.utility },
    counts: {
      consentEvents: row.consentEvents,
      deals: row.deals,
      tasks: row.tasks,
      notes: row.notes,
      orders: row.orders,
      storeMessages: row.storeMessages,
      campaignSends: row.campaignSends,
      automationRuns: row.automationRuns,
      flowAnswers: row.flowAnswers,
    },
  };
}

/**
 * Merges are for owners and administrators: they cannot be undone, they move consent history and
 * delete a contact (contacts.delete), and they change contacts (contacts.write, which a suspended
 * company does not have).
 */
function assertCanMerge(ctx: TenantContext) {
  assertCan(ctx, 'contacts.write');
  assertCan(ctx, 'contacts.delete');
}

export function createContactMergeService(deps: { db: Database; clock: Clock }) {
  const { db } = deps;
  return {
    /** Both contacts and what merging the second into the first would do. */
    async previewMerge(
      ctx: TenantContext,
      keepContactId: string,
      mergeContactId: string,
    ): Promise<{ keep: MergeSide; merge: MergeSide; plan: MergePlan }> {
      assertCanMerge(ctx);
      const ids = mergeContactsSchema.safeParse({ keepContactId, mergeContactId });
      if (!ids.success) throw notFound('Contact');
      return db.run(
        ctx.scope,
        async (tx) => {
          const keep = await loadSide(tx, ctx.tenant.id, keepContactId);
          const merge = await loadSide(tx, ctx.tenant.id, mergeContactId);
          if (!keep || !merge) throw notFound('Contact');
          return { keep, merge, plan: planContactMerge(keep, merge) };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * Merges one contact into another (`app.merge_contacts` checks everything again under the
     * contacts' and their conversations' locks) and records it in the audit log with the counts.
     */
    async mergeContacts(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<MergeSummary> {
      assertCanMerge(ctx);
      const data = parseInput(mergeContactsSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const res = await tx.execute<{ summary: unknown }>(
          sql`select app.merge_contacts(${data.keepContactId}::uuid, ${data.mergeContactId}::uuid) as summary`,
        );
        const summary = mergeSummarySchema.parse(res.rows[0]?.summary);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'contact.merged',
            subjectType: 'contact',
            subjectId: data.keepContactId,
            metadata: { mergedContactId: data.mergeContactId, ...summary },
          },
          meta,
        );
        return summary;
      });
    },

    /** The contact a deleted contact was merged into, for links to it that still exist. */
    async mergedInto(
      ctx: TenantContext,
      contactId: string,
    ): Promise<{ keptContactId: string; mergedAt: Date } | null> {
      assertCan(ctx, 'contacts.read');
      if (!z.uuid().safeParse(contactId).success) return null;
      const [row] = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              keptContactId: contactMerges.keptContactId,
              mergedAt: contactMerges.mergedAt,
            })
            .from(contactMerges)
            .where(
              and(
                eq(contactMerges.tenantId, ctx.tenant.id),
                eq(contactMerges.mergedContactId, contactId),
              ),
            ),
        { accessMode: 'read only' },
      );
      return row ?? null;
    },
  };
}

export type ContactMergeService = ReturnType<typeof createContactMergeService>;
