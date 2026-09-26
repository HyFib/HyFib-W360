'use client';
import { useEffect } from 'react';
import { markConversationReadAction } from '@/app/actions/inbox';

/** Clears the unread counter when a member opens a conversation with unread messages. */
export function MarkRead({
  slug,
  conversationId,
  unread,
}: {
  slug: string;
  conversationId: string;
  unread: number;
}) {
  useEffect(() => {
    if (unread > 0) void markConversationReadAction(slug, conversationId);
  }, [slug, conversationId, unread]);
  return null;
}
