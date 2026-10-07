/**
 * The inbox's notice of overdue replies (ADR-241), browser-safe: the inbox service gives the reply
 * due times of the customers waiting in conversations the member can see, and the notice counts
 * those past due as the clock moves, so a wait turning overdue shows without a reload.
 */

/** At most this many waits come with a page, the earliest due first. */
export const WAITING_REPLY_LIMIT = 200;

/** A waiting customer's reply due time, without anything about the customer or conversation. */
export interface WaitingReply {
  /** When the reply is due under the first-response target (ISO 8601). */
  dueAt: string;
  /** The conversation is assigned to the member reading. */
  mine: boolean;
}

export interface OverdueCount {
  total: number;
  mine: number;
}

/** How many of the waits are past due at `now` (milliseconds since the epoch). */
export function countOverdue(waits: readonly WaitingReply[], now: number): OverdueCount {
  let total = 0;
  let mine = 0;
  for (const wait of waits) {
    if (Date.parse(wait.dueAt) > now) continue;
    total += 1;
    if (wait.mine) mine += 1;
  }
  return { total, mine };
}

/**
 * The notice, or null when nobody waits past the target. `capped` says more customers wait than
 * came with the page: when every wait that came is overdue, the true number may be larger.
 */
export function overdueNoticeText(
  count: OverdueCount,
  options: { capped: boolean; shown: number },
): string | null {
  if (count.total === 0) return null;
  const n = count.total.toLocaleString('en-IN');
  if (options.capped && count.total === options.shown) {
    return `At least ${n} customers are waiting past the reply target.`;
  }
  if (count.total === 1) {
    return count.mine === 1
      ? 'A customer in a conversation assigned to you is waiting past the reply target.'
      : 'A customer is waiting past the reply target.';
  }
  return `${n} customers are waiting past the reply target${
    count.mine > 0 ? `, ${count.mine.toLocaleString('en-IN')} of them assigned to you` : ''
  }.`;
}
