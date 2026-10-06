import { clipText, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  conversationNotes,
  conversations,
  emailOutbox,
  eq,
  memberships,
  noteMentions,
  sql,
  tenants,
  users,
  type Database,
  type TenantRole,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { permissionsForRoles } from '../authz/permissions';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';

/**
 * Emails to members mentioned in a note who have not opened its conversation (ADR-211, queue
 * `note.mention`). Adding the note schedules one job per member it mentions (not its author), due
 * `MENTION_EMAIL_DELAY_MS` later; the mention row decides under its lock. A mention already read,
 * gone with its note, of a member who can no longer see the conversation, or followed by a newer
 * unread mention of the member in the same conversation (whose own job emails then) is not
 * emailed. The email names who mentioned them and links to the conversation, never the note or
 * the customer: an email stays readable after its reader loses access.
 */
export const MENTION_EMAIL_DELAY_MS = 10 * 60_000;

/** A mention whose email is this late (the company was suspended, the worker was down) is dropped. */
export const MENTION_EMAIL_LATE_LIMIT_MS = 24 * 3_600_000;

export async function scheduleMentionEmail(
  deps: { jobs: JobQueue; signer: JobSigner },
  tx: Tx,
  input: { tenantId: string; mentionId: string; at: Date },
): Promise<void> {
  await deps.jobs.enqueue(
    tx,
    QUEUES.noteMention.name,
    deps.signer.sign({
      kind: 'note.mention',
      tenantId: input.tenantId,
      actorUserId: null,
      ref: input.mentionId,
    }),
    { singletonKey: input.mentionId, startAfter: input.at },
  );
}

/** The email to a member mentioned in a note: who mentioned them and how many are unread there. */
export function mentionEmailNotice(input: { authorName: string; unread: number }): {
  subject: string;
  lines: string[];
} {
  const author = clipText(input.authorName, 120);
  return {
    subject: `${author} mentioned you in a note`,
    lines: [
      `${author} mentioned you in a note on a conversation in the inbox, and you have not opened the conversation since.`,
      ...(input.unread > 1
        ? [`You have ${input.unread.toLocaleString('en-IN')} unread mentions in that conversation.`]
        : []),
      'Open the conversation to read the note; this email leaves out the note and the customer’s details.',
    ],
  };
}

export interface MentionEmailDeps {
  db: Database;
  clock: Clock;
  outbox: OutboxDeps;
  appBaseUrl: string;
}

export type MentionEmailOutcome =
  'sent' | 'gone' | 'read' | 'too_late' | 'cannot_see' | 'newer' | 'already_sent';

/** Emails the member a mention names, unless the mention row says it is not needed (see above). */
export async function sendMentionEmail(
  deps: MentionEmailDeps,
  scope: TenantScope,
  mentionId: string,
): Promise<MentionEmailOutcome> {
  const tenantId = scope.tenantId;
  return deps.db.run(scope, async (tx) => {
    const [mention] = await tx
      .select({
        membershipId: noteMentions.membershipId,
        noteId: noteMentions.noteId,
        readAt: noteMentions.readAt,
        createdAt: noteMentions.createdAt,
      })
      .from(noteMentions)
      .where(and(eq(noteMentions.tenantId, tenantId), eq(noteMentions.id, mentionId)))
      .for('update');
    if (!mention) return 'gone';
    if (mention.readAt) return 'read';
    if (deps.clock.now().getTime() - mention.createdAt.getTime() > MENTION_EMAIL_LATE_LIMIT_MS)
      return 'too_late';
    const [note] = await tx
      .select({
        conversationId: conversationNotes.conversationId,
        authorName: sql<string | null>`(select coalesce(m.display_name, u.name)
            from app.memberships m join auth.users u on u.id = m.user_id
           where m.tenant_id = ${conversationNotes.tenantId}
             and m.id = ${conversationNotes.authorMembershipId})`,
        assignedMembershipId: conversations.assignedMembershipId,
        company: tenants.name,
        slug: tenants.slug,
      })
      .from(conversationNotes)
      .innerJoin(
        conversations,
        and(
          eq(conversations.tenantId, conversationNotes.tenantId),
          eq(conversations.id, conversationNotes.conversationId),
        ),
      )
      .innerJoin(tenants, eq(tenants.id, conversationNotes.tenantId))
      .where(
        and(eq(conversationNotes.tenantId, tenantId), eq(conversationNotes.id, mention.noteId)),
      );
    if (!note) return 'gone';
    const [member] = await tx
      .select({ status: memberships.status, roles: memberships.roles, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, mention.membershipId)));
    // The same rule as the inbox's: every conversation, or unassigned ones and their own.
    const granted = member ? permissionsForRoles(member.roles as TenantRole[]) : null;
    const canSee =
      member?.status === 'active' &&
      granted !== null &&
      (granted.has('inbox.read_all') ||
        (granted.has('inbox.read_assigned') &&
          (note.assignedMembershipId === null ||
            note.assignedMembershipId === mention.membershipId)));
    if (!member || !canSee) return 'cannot_see';
    // The member's unread mentions in the conversation: only the newest one's job emails.
    const res = await tx.execute<{ unread: number; newer: boolean }>(sql`
      select count(*)::int as unread,
             coalesce(bool_or((m.created_at, m.id) > (me.created_at, me.id)), false) as newer
        from app.note_mentions m
        join app.conversation_notes n on n.tenant_id = m.tenant_id and n.id = m.note_id
        join app.note_mentions me on me.tenant_id = m.tenant_id and me.id = ${mentionId}::uuid
       where m.tenant_id = ${tenantId}::uuid and m.membership_id = me.membership_id
         and n.conversation_id = ${note.conversationId}::uuid and m.read_at is null`);
    const counted = res.rows[0];
    if (counted?.newer) return 'newer';
    const dedupeKey = `note-mention:${mentionId}`;
    // A job run again after its transaction committed finds its email queued.
    const [queued] = await tx
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(eq(emailOutbox.dedupeKey, dedupeKey));
    if (queued) return 'already_sent';
    const { subject, lines } = mentionEmailNotice({
      authorName: note.authorName ?? 'A member',
      unread: counted?.unread ?? 1,
    });
    await enqueueEmail(deps.outbox, tx, {
      to: member.email,
      tenantId,
      dedupeKey,
      payload: {
        kind: 'tenant.notice',
        companyName: note.company,
        subject,
        lines,
        url: new URL(`/c/${note.slug}/inbox/${note.conversationId}`, deps.appBaseUrl).toString(),
        actionLabel: 'Open conversation',
      },
    });
    return 'sent';
  });
}
