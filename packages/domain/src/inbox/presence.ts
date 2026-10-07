/**
 * Members who have a conversation open (ADR-243), browser-safe: while a member has a conversation
 * open and the page is visible, the page reports it every PRESENCE_REPORT_MS; the answer names the
 * other active members reported within PRESENCE_WINDOW_MS who can see the conversation, so two
 * members do not answer the same customer at once.
 */

/** The page reports an open conversation this often while it is visible. */
export const PRESENCE_REPORT_MS = 20_000;
/** Members reported within this long have the conversation open: two reports and some delay. */
export const PRESENCE_WINDOW_MS = 45_000;
/** At most this many of the other members are named; the rest are counted. */
export const PRESENCE_NAMES = 3;

/** The other members who have the conversation open: the first names, and how many there are. */
export interface ConversationViewers {
  names: string[];
  total: number;
}

/** What the conversation says about the others who have it open, or null when nobody else has. */
export function presenceText(viewers: ConversationViewers): string | null {
  const { names } = viewers;
  const total = Math.max(viewers.total, names.length);
  if (total === 0) return null;
  const others = total - names.length;
  const listed =
    others > 0
      ? [...names, others === 1 ? '1 other member' : `${others.toLocaleString('en-IN')} others`]
      : names;
  const list =
    listed.length === 1
      ? listed[0]
      : `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}`;
  return `${list} also ${total === 1 ? 'has' : 'have'} this conversation open.`;
}
