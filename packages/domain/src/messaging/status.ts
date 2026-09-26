import type { MessageStatus } from '@w360/db';

/**
 * Delivery states only move forward. Ranks are spaced so `failed` outranks provider acceptance
 * and `sent` but not `delivered`/`read`: Meta documents rare cases where one message produces both
 * `delivered` and `failed`, and a later failure must not erase proof of delivery. Every provider
 * event is still kept in the immutable status history.
 */
export const STATUS_RANK: Record<MessageStatus, number> = {
  received: 0,
  queued: 10,
  sending: 15,
  unknown_outcome: 17,
  accepted: 20,
  sent: 30,
  failed: 35,
  delivered: 40,
  read: 50,
  played: 60,
  canceled: 5,
};

/** Maps a Meta status webhook value to our message status, or null when it is not a delivery state. */
export function providerStatusToMessageStatus(status: string): MessageStatus | null {
  switch (status) {
    case 'sent':
    case 'delivered':
    case 'read':
    case 'played':
    case 'failed':
      return status;
    default:
      return null;
  }
}

export function shouldAdvance(current: MessageStatus, next: MessageStatus): boolean {
  if (current === 'canceled') return false;
  return STATUS_RANK[next] > STATUS_RANK[current];
}
