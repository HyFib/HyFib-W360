import { z } from 'zod';
import { AppError, notFound } from '@w360/core';
import { and, contacts, crmActivities, crmDeals, desc, eq, exactTimestamp, sql } from '@w360/db';
import { recordSystemAudit } from '../audit';
import { addActivity } from '../crm/common';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiContactNotFound } from './contact-view';
import { apiActor, assertScope, type ApiContext } from './context';
import { assertCrmInPlan, invalidField } from './deals';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';
import { API_LIMITS } from './model';

/**
 * Notes on the CRM timeline through the public API (ADR-268): with `notes.write` a key adds a note
 * to one of the company's contacts, or to one of its deals and so to the deal's contact, as members
 * add notes on the contact and deal pages, recorded as written through the API. With `notes.read`
 * (ADR-279) a key lists the company's notes and reads each one, members' and keys', saying which
 * wrote it (a key by its id, never which member); the rest of the timeline is never read through
 * the API. A key needs the CRM in the company's plan. Erasing a contact deletes its notes, so they
 * are no longer read; a merge moves them to the contact kept.
 */

/** The longest note, as members write them (and as `app.crm_activities` holds them). */
export const API_NOTE_MAX_LENGTH = 4000;

/** What `POST /notes` takes: a note as members write one, about a contact or a deal. */
export const apiCreateNoteSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, 'Give the note’s text in `body`.')
      .max(API_NOTE_MAX_LENGTH, `A note is limited to ${API_NOTE_MAX_LENGTH} characters.`)
      .describe(
        `The note, as members write one on the contact and deal pages: up to ${API_NOTE_MAX_LENGTH} characters, spaces around it trimmed.`,
      ),
    contactId: z
      .uuid()
      .optional()
      .describe('The customer the note is about, as GET /contacts gives them.'),
    dealId: z
      .uuid()
      .optional()
      .describe(
        'The deal the note is about (GET /deals): the note is on its contact’s timeline too.',
      ),
  })
  .strict()
  .refine((note) => note.contactId !== undefined || note.dealId !== undefined, {
    message: 'Give `contactId`, `dealId` or both.',
    path: ['contactId'],
  });

/** What `GET /notes` takes (ADR-279). */
export const apiCrmNoteListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    contactId: z
      .uuid()
      .optional()
      .describe(
        'Only the notes on this contact’s timeline: about the contact or one of its deals.',
      ),
    dealId: z.uuid().optional().describe('Only the notes about this deal.'),
    createdSince: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Only the notes added at or after this time.'),
  })
  .strict();

/** Who wrote a note: a member on the contact or deal page, or a key through the API. */
export type ApiNoteWriter = 'member' | 'api';

/** A note as `POST /notes` answers it and `GET /notes` reads it. */
export interface ApiNote {
  id: string;
  body: string;
  /** The contact whose timeline holds the note: the one given, or the deal's. */
  contactId: string;
  dealId: string | null;
  /** Who wrote it (ADR-279): never which member. */
  writtenBy: ApiNoteWriter;
  /** The key that wrote it, when `writtenBy` is `api`. */
  apiKeyId: string | null;
  createdAt: string;
}

const noteColumns = {
  id: crmActivities.id,
  // A note always has its text (`crm_activities_note`).
  body: sql<string>`${crmActivities.body}`,
  contactId: crmActivities.contactId,
  dealId: crmActivities.dealId,
  // Whether a member wrote it, never which: keys' notes have no member and name the key.
  byMember: sql<boolean>`(${crmActivities.actorMembershipId} IS NOT NULL)`,
  apiKeyId: sql<string | null>`(${crmActivities.data} ->> 'apiKeyId')`,
  createdAt: crmActivities.createdAt,
  cursorAt: exactTimestamp(crmActivities.createdAt),
};

/** A note as `noteColumns` reads it. */
export interface NoteRow {
  id: string;
  body: string;
  contactId: string;
  dealId: string | null;
  byMember: boolean;
  apiKeyId: string | null;
  createdAt: Date;
}

/** A note as the API gives it: who wrote it, a key by its id, never which member (ADR-279). */
export const toApiNote = (row: NoteRow): ApiNote => ({
  id: row.id,
  body: row.body,
  contactId: row.contactId,
  dealId: row.dealId,
  writtenBy: row.byMember ? 'member' : 'api',
  apiKeyId: row.byMember ? null : row.apiKeyId,
  createdAt: row.createdAt.toISOString(),
});

/**
 * The company's notes, members' and keys', newest first by when they were added, on exact keyset
 * pages: a page never skips or repeats a note (ADR-279). Filters combine. Only notes are read, never
 * the rest of the timeline, and only reads, so it records nothing.
 */
export async function apiListNotes(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiNote[]; nextCursor: string | null }> {
  assertScope(ctx, 'notes.read');
  const q = parseInput(apiCrmNoteListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      const rows = await tx
        .select(noteColumns)
        .from(crmActivities)
        .where(
          and(
            eq(crmActivities.tenantId, ctx.tenant.id),
            eq(crmActivities.kind, 'note'),
            q.contactId ? eq(crmActivities.contactId, q.contactId) : undefined,
            q.dealId ? eq(crmActivities.dealId, q.dealId) : undefined,
            q.createdSince
              ? sql`${crmActivities.createdAt} >= ${q.createdSince}::timestamptz`
              : undefined,
            cursor
              ? sql`(${crmActivities.createdAt}, ${crmActivities.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(crmActivities.createdAt), desc(crmActivities.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map(toApiNote),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** One of the company's notes (ADR-279); any other timeline entry is not found, as an unknown id. */
export async function apiGetNote(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  noteId: string,
): Promise<ApiNote> {
  assertScope(ctx, 'notes.read');
  if (!z.uuid().safeParse(noteId).success) throw notFound('Note');
  const [note] = await deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      return tx
        .select(noteColumns)
        .from(crmActivities)
        .where(
          and(
            eq(crmActivities.tenantId, ctx.tenant.id),
            eq(crmActivities.id, noteId),
            eq(crmActivities.kind, 'note'),
          ),
        );
    },
    { accessMode: 'read only' },
  );
  if (!note) throw notFound('Note');
  return toApiNote(note);
}

/**
 * Adds a note as members do (ADR-268), recorded as written by the key: to one of the company's
 * contacts (not erased), or to one of its deals and so to the deal's contact. The contact is locked
 * against erasure and merges until the note is in, as members' tasks lock it. The `note` activity
 * has no member actor and names the key, so the timeline says it came through the API; the audit log
 * names the key, never the note's text. With an Idempotency-Key a retry answers the first response.
 */
export async function apiCreateNote(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'notes.write');
  const data = parseInput(apiCreateNoteSchema, input);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    // Claimed in the note's transaction, so a refused note leaves the key unused (ADR-052).
    let claimed: string | null = null;
    if (idempotency) {
      const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
      if ('replay' in claim) return claim.replay;
      claimed = claim.claimed;
    }
    await assertCrmInPlan(tx, ctx.tenant.id);
    const dealId = data.dealId ?? null;
    let contactId = data.contactId ?? null;
    if (dealId) {
      const [deal] = await tx
        .select({ contactId: crmDeals.contactId })
        .from(crmDeals)
        .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, dealId)));
      if (!deal) {
        throw invalidField('dealId', 'Give the id of one of the company’s deals (GET /deals).');
      }
      if (contactId && contactId !== deal.contactId) {
        throw invalidField(
          'contactId',
          'The deal is another contact’s: leave `contactId` out, or give the deal’s contact.',
        );
      }
      contactId = deal.contactId;
    }
    if (!contactId) throw invalidField('contactId', 'Give `contactId`, `dealId` or both.');
    const [contact] = await tx
      .select({ erasedAt: contacts.erasedAt })
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, contactId)))
      .for('key share');
    if (dealId) {
      // Merges lock both contacts first, so once the deal's contact is locked the deal stays with
      // it; a contact gone means a merge moved the deal between the reads.
      if (!contact) {
        throw new AppError('conflict', 'The deal moved to another contact meanwhile; try again.');
      }
      if (contact.erasedAt) {
        throw new AppError('conflict', 'The deal’s contact was erased, so it takes no new notes.');
      }
    } else if (!contact || contact.erasedAt) {
      throw await apiContactNotFound(tx, ctx.tenant.id, contactId);
    }
    const id = await addActivity(tx, {
      tenantId: ctx.tenant.id,
      contactId,
      dealId,
      actorMembershipId: null,
      kind: 'note',
      body: data.body,
      data: { apiKeyId: ctx.key.id },
      at: now,
    });
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'crm.note_added',
        subjectType: 'crm_activity',
        subjectId: id,
        correlationId: ctx.requestId,
        metadata: { contactId, ...(dealId ? { dealId } : {}), source: 'api' },
      },
      apiActor(ctx),
    );
    const note: ApiNote = {
      id,
      body: data.body,
      contactId,
      dealId,
      writtenBy: 'api',
      apiKeyId: ctx.key.id,
      createdAt: now.toISOString(),
    };
    const response = { status: 201, body: { data: note } };
    if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
    return { ...response, replayed: false };
  });
}
