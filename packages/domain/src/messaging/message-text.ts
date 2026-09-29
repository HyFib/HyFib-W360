import { inboundSummary } from '../webhooks/payloads';

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The words of an outbound message: a text's body, a template's rendered body, the body of an
 * interactive message (automation buttons, satisfaction survey, products, a WhatsApp Flow), or a
 * reaction's emoji (ADR-082), as inbound reactions give theirs.
 */
export function outboundText(type: string, content: Record<string, unknown>): string | null {
  switch (type) {
    case 'text':
      return str(content.text);
    case 'reaction':
      return str(content.emoji);
    case 'template':
      return str(obj(content.rendered)?.body);
    case 'interactive':
      return str(content.body) ?? str(obj(content.products)?.body) ?? str(obj(content.flow)?.body);
    default:
      return null;
  }
}

/** What a message without words is called. */
const TYPE_NAMES: Record<string, string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  sticker: 'Sticker',
  location: 'Location',
  contacts: 'Contact card',
  interactive: 'Interactive message',
  button: 'Button reply',
  order: 'Order',
  template: 'Template',
  system: 'WhatsApp account update',
};

/** The longest snippet, in characters. */
export const SNIPPET_LENGTH = 120;

/**
 * One line naming a message, as the inbox shows the message a reply quotes or a reaction is for
 * (ADR-082): its words on one line, cut at `SNIPPET_LENGTH` characters, or what kind of message it
 * is. Removed content (an erased contact's) says so.
 */
export function messageSnippet(
  direction: 'inbound' | 'outbound',
  type: string,
  content: Record<string, unknown>,
): string {
  if (content.redacted === true) return 'Content removed';
  const words =
    type === 'reaction'
      ? str(content.emoji)
        ? `Reacted ${String(content.emoji)}`
        : 'Removed a reaction'
      : direction === 'inbound'
        ? inboundSummary(type, content).text
        : outboundText(type, content);
  const line = words?.replace(/\s+/g, ' ').trim() || TYPE_NAMES[type] || 'Message';
  const characters = Array.from(line);
  return characters.length > SNIPPET_LENGTH
    ? `${characters.slice(0, SNIPPET_LENGTH - 1).join('')}…`
    : line;
}
