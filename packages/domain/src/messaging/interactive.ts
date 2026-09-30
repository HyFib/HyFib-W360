/**
 * Reply buttons and list messages: Meta's limits, and the Graph request and stored content for
 * each (ADR-080). Limits are from Meta's OpenAPI description of the messages endpoint
 * (docs/research/meta-whatsapp.md M-157, M-159, M-179); where it could not settle a limit, the
 * stricter reading is used (M-181).
 */

export const INTERACTIVE_LIMITS = {
  /** Header text, body and footer (M-159). */
  headerLength: 60,
  bodyLength: 1024,
  footerLength: 60,
  /** Reply buttons (M-157). */
  buttons: 3,
  buttonIdLength: 256,
  buttonTitleLength: 20,
  /** List messages (M-179): the button that opens the list, its sections and rows. */
  listButtonLength: 20,
  sections: 10,
  sectionTitleLength: 24,
  /** Meta's description allows 10 rows per section; 10 in all is the stricter reading (M-181). */
  rows: 10,
  rowIdLength: 200,
  rowTitleLength: 24,
  rowDescriptionLength: 72,
} as const;

/**
 * HyFib's own reply ids start with this (automation buttons `w360bot:`, satisfaction surveys
 * `w360csat:`), and taps are recognised by them: a survey tap does not reopen the conversation or
 * open a reply turn. Ids chosen by others (the API) must not start with it, in any case.
 */
export const RESERVED_REPLY_ID_PREFIX = 'w360';

export function isReservedReplyId(id: string): boolean {
  return id.toLowerCase().startsWith(RESERVED_REPLY_ID_PREFIX);
}

export interface ReplyButtonsMessage {
  header?: string | undefined;
  body: string;
  footer?: string | undefined;
  buttons: { id: string; title: string }[];
}

export interface ListMessage {
  header?: string | undefined;
  body: string;
  footer?: string | undefined;
  /** The label of the button that opens the list. */
  button: string;
  sections: {
    title?: string | undefined;
    rows: { id: string; title: string; description?: string | undefined }[];
  }[];
}

const frame = (message: { header?: string | undefined; footer?: string | undefined }) => ({
  ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
  ...(message.footer ? { footer: { text: message.footer } } : {}),
});

/** The `interactive` object of a reply buttons message (M-157). */
export function replyButtonsInteractive(message: ReplyButtonsMessage) {
  return {
    type: 'button',
    ...frame(message),
    body: { text: message.body },
    action: {
      buttons: message.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
    },
  };
}

/** The `interactive` object of a list message (M-179). */
export function listInteractive(message: ListMessage) {
  return {
    type: 'list',
    ...frame(message),
    body: { text: message.body },
    action: {
      button: message.button,
      sections: message.sections.map((section) => ({
        ...(section.title ? { title: section.title } : {}),
        rows: section.rows.map((row) => ({
          id: row.id,
          title: row.title,
          ...(row.description ? { description: row.description } : {}),
        })),
      })),
    },
  };
}

/**
 * What the inbox stores and shows for a reply buttons message: the automations' shape (titles
 * only), so it is drawn as their buttons are. Ids stay in the send request.
 */
export function replyButtonsContent(message: ReplyButtonsMessage) {
  return {
    header: message.header ?? null,
    body: message.body,
    footer: message.footer ?? null,
    buttons: message.buttons.map((b) => b.title),
  };
}

/** What the inbox stores and shows for a list message; row ids stay in the send request. */
export function listContent(message: ListMessage) {
  return {
    header: message.header ?? null,
    body: message.body,
    footer: message.footer ?? null,
    list: {
      button: message.button,
      sections: message.sections.map((section) => ({
        title: section.title ?? null,
        rows: section.rows.map((row) => ({
          title: row.title,
          description: row.description ?? null,
        })),
      })),
    },
  };
}
