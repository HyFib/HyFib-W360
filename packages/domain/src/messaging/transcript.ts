import { contactCards, inboundSummary } from '../webhooks/payloads';
import { MESSAGE_TYPE_NAMES, outboundText } from './message-text';

/**
 * A conversation's transcript as plain text (ADR-212): a header naming the contact, the number, the
 * company and who downloaded it when, then one entry per message, oldest first, with its time in
 * the company's time zone, who sent it, its words and, for a message that did not reach the
 * customer, what happened to it. Internal notes are left out. Plain text, never CSV, so no
 * spreadsheet reads any of it as a formula.
 */

export interface TranscriptHead {
  contactName: string | null;
  contactPhone: string | null;
  /** The WhatsApp number of the company the conversation is on. */
  number: string | null;
  companyName: string;
  timeZone: string;
  downloadedBy: string;
  downloadedAt: Date;
}

export interface TranscriptMessage {
  direction: 'inbound' | 'outbound';
  type: string;
  content: Record<string, unknown>;
  status: string;
  errorTitle: string | null;
  senderType: string;
  memberName: string | null;
  apiKeyName: string | null;
  campaignName: string | null;
  /** When it was sent: WhatsApp's time for a customer's message, else when HyFib wrote it. */
  at: Date;
}

/** `YYYY-MM-DD HH:MM` in the time zone. */
export function transcriptTime(at: Date, timeZone: string): string {
  const part = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`;
}

export function transcriptHeader(head: TranscriptHead): string {
  const contact =
    [head.contactName, head.contactPhone].filter(Boolean).join(' · ') ||
    'a contact without a name or number';
  return [
    `Conversation with ${contact}`,
    `WhatsApp number: ${head.number ?? 'unknown'}`,
    `Company: ${head.companyName}`,
    `Times are in ${head.timeZone}. Internal notes are not included.`,
    `Downloaded by ${head.downloadedBy} on ${transcriptTime(head.downloadedAt, head.timeZone)}.`,
    '',
    '',
  ].join('\n');
}

/** Who sent a message: the contact, the member, or what sent it for the company. */
export function transcriptSender(
  m: Pick<
    TranscriptMessage,
    'direction' | 'senderType' | 'memberName' | 'apiKeyName' | 'campaignName'
  >,
  contactName: string | null,
): string {
  if (m.direction === 'inbound') return contactName || 'Customer';
  switch (m.senderType) {
    case 'agent':
      return m.memberName || 'A member';
    case 'bot':
      return 'Automation';
    case 'campaign':
      return m.campaignName ? `Campaign “${m.campaignName}”` : 'Campaign';
    case 'api':
      return m.apiKeyName ? `API key “${m.apiKeyName}”` : 'API';
    default:
      return 'Sent automatically';
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A message's words in full, after what kind of message it is when it is not plain text. */
export function transcriptText(
  direction: 'inbound' | 'outbound',
  type: string,
  content: Record<string, unknown>,
): string {
  // As the thread shows them: a removed template keeps its words.
  if (content.redacted === true && type !== 'template') return '[Content removed]';
  if (content.tooLarge === true) return '[This message was too large to keep]';
  if (type === 'reaction') {
    const emoji = str(content.emoji);
    return emoji ? `[Reacted ${emoji}]` : '[Removed a reaction]';
  }
  // A contact card is named by the names on it, never their numbers or addresses.
  const cards = contactCards(type, content);
  const words =
    (cards
      ? cards
          .map((card) => card.name.formattedName)
          .filter(Boolean)
          .join(', ')
      : direction === 'inbound'
        ? inboundSummary(type, content).text
        : outboundText(type, content)
    )
      ?.replace(/\r\n?/g, '\n')
      .trim() || null;
  if (type === 'text') return words ?? '[Message]';
  const kind = MESSAGE_TYPE_NAMES[type] ?? 'Message';
  return words ? `[${kind}] ${words}` : `[${kind}]`;
}

/** What happened to a message of the company that did not reach the customer. */
function outcome(m: TranscriptMessage): string {
  if (m.direction !== 'outbound') return '';
  switch (m.status) {
    case 'failed':
      return m.errorTitle ? ` (not delivered: ${m.errorTitle})` : ' (not delivered)';
    case 'canceled':
      return ' (canceled)';
    case 'unknown_outcome':
      return ' (delivery unknown)';
    default:
      return '';
  }
}

/** One message: `[time] sender: words`, its further lines indented under the first. */
export function transcriptEntry(
  m: TranscriptMessage,
  contactName: string | null,
  timeZone: string,
): string {
  const lines = transcriptText(m.direction, m.type, m.content).split('\n');
  const words = lines.map((line, i) => (i === 0 ? line : `    ${line}`)).join('\n');
  return `[${transcriptTime(m.at, timeZone)}] ${transcriptSender(m, contactName)}: ${words}${outcome(m)}\n`;
}
