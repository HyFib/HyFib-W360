'use server';
import { refresh } from 'next/cache';
import { queueTextMessage, resolveUnknownOutcome } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

export async function sendReplyAction(
  slug: string,
  input: { conversationId: string; text: string; clientKey: string; afterMessageId?: string },
): Promise<ActionResult<{ messageId: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { outbound } = await getRuntime();
    const { messageId } = await queueTextMessage(outbound, ctx, input);
    refresh();
    return { messageId };
  });
}

export async function assignConversationAction(
  slug: string,
  input: { conversationId: string; membershipId: string | null; expectedVersion: number },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { inbox } = await getRuntime();
    await inbox.assign(ctx, input);
    refresh();
    return null;
  });
}

export async function setConversationStatusAction(
  slug: string,
  input: { conversationId: string; status: 'open' | 'resolved'; expectedVersion: number },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { inbox } = await getRuntime();
    await inbox.setStatus(ctx, input);
    refresh();
    return null;
  });
}

export async function addNoteAction(
  slug: string,
  input: { conversationId: string; body: string; mentionIds?: string[] },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { inbox } = await getRuntime();
    await inbox.addNote(ctx, input);
    refresh();
    return null;
  });
}

export async function markConversationReadAction(
  slug: string,
  conversationId: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { inbox } = await getRuntime();
    await inbox.markRead(ctx, conversationId);
    return null;
  });
}

export async function resolveUnknownOutcomeAction(
  slug: string,
  input: { messageId: string; decision: 'mark_sent' | 'resend' },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { outbound } = await getRuntime();
    if (input.decision !== 'mark_sent' && input.decision !== 'resend') {
      throw new TypeError('Unknown decision');
    }
    await resolveUnknownOutcome(outbound, ctx, input);
    refresh();
    return null;
  });
}

export async function updateResponseTargetAction(
  slug: string,
  input: { minutes: number | null },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { inbox } = await getRuntime();
    await inbox.updateResponseTarget(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function setConversationTeamAction(
  slug: string,
  input: { conversationId: string; teamId: string | null; expectedVersion: number },
): Promise<ActionResult<{ assignedMembershipId: string | null }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { inbox } = await getRuntime();
    const result = await inbox.setTeam(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}
