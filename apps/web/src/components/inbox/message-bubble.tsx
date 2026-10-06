import { formatMinor } from '@w360/domain/crm-money';
import { cn } from '@w360/ui/cn';
import { formatDateTime } from '@/lib/format';
import { flowAnswerText } from '@/lib/flow-labels';
import { isHttpsLink } from '@/lib/links';
import { UnknownOutcomeActions } from './unknown-outcome-actions';

export interface ThreadMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  type: string;
  content: unknown;
  status: string;
  errorCode: string | null;
  errorTitle: string | null;
  senderType: string;
  senderName: string | null;
  /** The API key that sent the message, for messages sent through the public API. */
  apiKeyName: string | null;
  createdAt: string;
  providerTimestamp: string | null;
  /** The message this one quotes, reacts to or taps a button of, in one line (ADR-082). */
  replyTo: { id: string; direction: 'inbound' | 'outbound'; text: string } | null;
}

/** Inbound messages that answer a message by their nature (taps, forms, carts): no quote shown. */
const ANSWER_TYPES = new Set(['interactive', 'button', 'order']);

/** An order message's label ("Order shipped · Tara Tea") from its content (order messages). */
function storeMessageLabel(content: unknown): string | null {
  if (typeof content !== 'object' || content === null) return null;
  const store = (content as { store?: { label?: unknown; name?: unknown } }).store;
  if (!store || typeof store.label !== 'string') return null;
  return typeof store.name === 'string' ? `${store.label} · ${store.name}` : store.label;
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending',
  accepted: 'Sent to WhatsApp',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  played: 'Played',
  failed: 'Not delivered',
  canceled: 'Canceled',
  unknown_outcome: 'Delivery unknown',
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The values a contact card gives under `key` in a list such as its phones (ADR-196). */
function cardValues(list: unknown, key: string): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    const value =
      typeof entry === 'object' && entry !== null
        ? text((entry as Record<string, unknown>)[key])
        : null;
    return value ? [value] : [];
  });
}

/** The people a contact card shares (ADR-196): each one's name, numbers and email addresses. */
function cardPeople(content: Record<string, unknown>): { name: string; reach: string }[] {
  const list: unknown[] = Array.isArray(content.contacts) ? content.contacts : [];
  return list.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const contact = entry as Record<string, unknown>;
    const name = (
      typeof contact.name === 'object' && contact.name !== null ? contact.name : {}
    ) as Record<string, unknown>;
    const parts = [text(name.first_name), text(name.last_name)].filter(Boolean).join(' ');
    return [
      {
        name: text(name.formatted_name) ?? (parts || 'A contact without a name'),
        reach: [
          ...cardValues(contact.phones, 'phone'),
          ...cardValues(contact.emails, 'email'),
        ].join(', '),
      },
    ];
  });
}

/** A location's coordinates in decimal degrees ("18.5204, 73.8567"), when it has both. */
function coordinates(content: Record<string, unknown>): string | null {
  const { latitude, longitude } = content;
  return typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    typeof longitude === 'number' &&
    Number.isFinite(longitude)
    ? `${latitude}, ${longitude}`
    : null;
}

/** What the file of a template's photo, video or document header is called (ADR-201). */
const HEADER_FILE_NAMES: Record<string, string> = {
  image: 'Photo',
  video: 'Video',
  document: 'Document',
};

/**
 * A file the customer sent, fetched from WhatsApp by this member's browser when shown (ADR-216):
 * photos and stickers in the page, voice notes and videos in a player that loads on play, and
 * documents as downloads. A file WhatsApp no longer keeps shows the photo's description instead.
 */
function ReceivedFile({
  type,
  url,
  content,
}: {
  type: string;
  url: string;
  content: Record<string, unknown>;
}) {
  const caption = text(content.caption);
  const captionLine = caption ? (
    <span className="block whitespace-pre-wrap break-words">{caption}</span>
  ) : null;
  switch (type) {
    case 'image':
      return (
        <div className="grid gap-1">
          <a href={url} target="_blank" rel="noopener noreferrer" className="block w-fit">
            {/* eslint-disable-next-line @next/next/no-img-element -- fetched with the member's session, which Next's image optimiser would not send */}
            <img
              src={url}
              alt={caption ?? 'Sent by the customer'}
              loading="lazy"
              className="max-h-64 max-w-full rounded-md border border-border object-contain"
            />
          </a>
          {captionLine}
        </div>
      );
    case 'sticker':
      return (
        // eslint-disable-next-line @next/next/no-img-element -- fetched with the member's session, which Next's image optimiser would not send
        <img
          src={url}
          alt="Sticker from the customer"
          loading="lazy"
          className="h-32 w-32 object-contain"
        />
      );
    case 'audio':
    case 'video':
      return (
        <div className="grid gap-1">
          <span className="font-medium">
            {type === 'video' ? 'Video' : content.voice === true ? 'Voice message' : 'Audio'}
          </span>
          {type === 'video' ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- a customer's recording comes without captions
            <video controls preload="none" src={url} className="max-h-64 max-w-full rounded-md" />
          ) : (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- a customer's recording comes without captions
            <audio controls preload="none" src={url} className="w-64 max-w-full" />
          )}
          {captionLine}
          <a href={url} download className="w-fit text-xs underline opacity-80">
            Download {type === 'video' ? 'the video' : 'the recording'}
          </a>
        </div>
      );
    default:
      return (
        <div className="grid gap-1">
          <span className="font-medium">Document</span>
          <a href={url} download className="w-fit break-all underline">
            Download {text(content.filename) ?? 'the document'}
          </a>
          {captionLine}
        </div>
      );
  }
}

/** Renders message content as plain text only (never HTML), by type. */
function Body({
  type,
  content,
  replyTo,
  mediaUrl,
}: {
  type: string;
  content: unknown;
  replyTo: ThreadMessage['replyTo'];
  /** Where the browser fetches the file of a message the customer sent with one. */
  mediaUrl: string | null;
}) {
  const c = (typeof content === 'object' && content !== null ? content : {}) as Record<
    string,
    unknown
  >;
  if (c.redacted === true && type !== 'template') {
    return <p className="italic">Content removed</p>;
  }
  // Inbound content larger than a message may hold (ADR-131): kept without it.
  if (c.tooLarge === true) {
    return <p className="italic">This message was too large to keep.</p>;
  }
  switch (type) {
    case 'text':
      return (
        <div className="grid gap-1">
          {text(c.paymentLinkId) ? (
            <p className="text-xs font-medium uppercase tracking-wide opacity-70">
              Payment request
            </p>
          ) : null}
          <p className="whitespace-pre-wrap break-words">{text(c.text) ?? ''}</p>
        </div>
      );
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      if (mediaUrl) return <ReceivedFile type={type} url={mediaUrl} content={c} />;
      const link = text(c.link);
      return (
        <p className="whitespace-pre-wrap break-words">
          <span className="font-medium capitalize">{type}</span>
          {text(c.filename) ? ` · ${text(c.filename)}` : ''}
          {text(c.caption) ? <span className="block">{text(c.caption)}</span> : null}
          {/* Sent through the API from a link (ADR-194), which the API only takes as https. */}
          {isHttpsLink(link) ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="block break-all text-xs underline opacity-80"
            >
              {link}
            </a>
          ) : (
            <span className="block text-xs opacity-80">The file could not be read.</span>
          )}
        </p>
      );
    }
    case 'location':
      return (
        <p>
          <span className="font-medium">Location</span>
          {text(c.name) ? ` · ${text(c.name)}` : ''}
          {text(c.address) ? <span className="block">{text(c.address)}</span> : null}
          {coordinates(c) ? (
            <span className="block text-xs opacity-80">{coordinates(c)}</span>
          ) : null}
        </p>
      );
    case 'reaction':
      return (
        <p className="break-words">
          {text(c.emoji) ? `Reacted ${text(c.emoji)}` : 'Removed a reaction'}
          {replyTo ? <span className="text-xs opacity-80"> to “{replyTo.text}”</span> : null}
        </p>
      );
    case 'interactive': {
      const flow = (typeof c.flow === 'object' && c.flow !== null ? c.flow : null) as Record<
        string,
        unknown
      > | null;
      if (flow && c.interactiveType === 'nfm_reply') {
        // A completed WhatsApp Flow: its answers.
        const answers = (
          typeof flow.answers === 'object' && flow.answers !== null ? flow.answers : null
        ) as Record<string, unknown> | null;
        const entries = answers ? Object.entries(answers).slice(0, 40) : [];
        return (
          <div className="grid gap-1">
            <p className="text-xs font-medium uppercase tracking-wide opacity-70">Form submitted</p>
            {answers === null ? (
              <p className="text-xs opacity-80">
                {flow.tooLarge === true
                  ? 'The answers were larger than HyFib keeps.'
                  : 'The answers could not be read.'}
              </p>
            ) : entries.length === 0 ? (
              <p className="text-xs opacity-80">No answers.</p>
            ) : (
              <dl className="grid gap-0.5">
                {entries.map(([key, value]) => (
                  <div key={key} className="break-words">
                    <dt className="inline font-medium">{key}: </dt>
                    <dd className="inline">{flowAnswerText(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        );
      }
      if (flow) {
        // A form sent from the inbox.
        return (
          <div className="grid gap-1">
            <p className="text-xs font-medium uppercase tracking-wide opacity-70">
              Form: {text(flow.name) ?? 'WhatsApp Flow'}
              {flow.mode === 'draft' ? ' (draft, for testing)' : ''}
            </p>
            {text(flow.header) ? <p className="font-semibold">{text(flow.header)}</p> : null}
            <p className="whitespace-pre-wrap break-words">{text(flow.body) ?? ''}</p>
            {text(flow.footer) ? <p className="text-xs opacity-80">{text(flow.footer)}</p> : null}
            <p className="text-xs opacity-80">Button: {text(flow.cta) ?? ''}</p>
          </div>
        );
      }
      const products = (
        typeof c.products === 'object' && c.products !== null ? c.products : null
      ) as Record<string, unknown> | null;
      if (products) {
        // Products sent from the inbox or the API (a product, a product list or the catalog).
        const names = Array.isArray(products.names)
          ? (products.names as unknown[]).map((n) => text(n) ?? 'Unnamed product')
          : [];
        const title =
          products.kind === 'catalog'
            ? 'Catalog'
            : products.kind === 'product_list'
              ? `${names.length} products`
              : 'Product';
        return (
          <div className="grid gap-1">
            <p className="text-xs font-medium uppercase tracking-wide opacity-70">{title}</p>
            {text(products.header) ? (
              <p className="font-semibold">{text(products.header)}</p>
            ) : null}
            {text(products.body) ? (
              <p className="whitespace-pre-wrap break-words">{text(products.body)}</p>
            ) : null}
            {products.kind !== 'catalog' && names.length > 0 ? (
              <p className="text-xs opacity-80">{names.slice(0, 10).join(' · ')}</p>
            ) : null}
            {text(products.footer) ? (
              <p className="text-xs opacity-80">{text(products.footer)}</p>
            ) : null}
          </div>
        );
      }
      if (c.csat === true) {
        const buttons = Array.isArray(c.buttons)
          ? (c.buttons as unknown[]).map(text).filter(Boolean)
          : [];
        return (
          <div className="grid gap-1">
            <p className="text-xs font-medium uppercase tracking-wide opacity-70">CSAT survey</p>
            <p className="whitespace-pre-wrap break-words">{text(c.body) ?? ''}</p>
            {buttons.length > 0 ? (
              <p className="text-xs opacity-80">Buttons: {buttons.join(' · ')}</p>
            ) : null}
          </div>
        );
      }
      if (text(c.body)) {
        // Reply buttons (an automation's question or the API's) or a list sent through the API.
        const buttons = Array.isArray(c.buttons)
          ? (c.buttons as unknown[]).map(text).filter(Boolean)
          : [];
        const list =
          typeof c.list === 'object' && c.list !== null
            ? (c.list as { button?: unknown; sections?: unknown })
            : null;
        const sections = Array.isArray(list?.sections)
          ? (list.sections as { title?: unknown; rows?: unknown }[])
          : [];
        return (
          <div className="grid gap-1">
            {text(c.header) ? <p className="font-semibold">{text(c.header)}</p> : null}
            <p className="whitespace-pre-wrap break-words">{text(c.body) ?? ''}</p>
            {text(c.footer) ? <p className="text-xs opacity-80">{text(c.footer)}</p> : null}
            {buttons.length > 0 ? (
              <p className="text-xs opacity-80">Buttons: {buttons.join(' · ')}</p>
            ) : null}
            {list ? (
              <div className="grid gap-1 text-xs opacity-80">
                <p>List: {text(list.button) ?? ''}</p>
                {sections.map((section, i) => (
                  <div key={i}>
                    {text(section.title) ? (
                      <p className="font-medium">{text(section.title)}</p>
                    ) : null}
                    <ul className="list-disc pl-4">
                      {(Array.isArray(section.rows)
                        ? (section.rows as { title?: unknown; description?: unknown }[])
                        : []
                      ).map((row, j) => (
                        <li key={j} className="break-words">
                          {text(row.title) ?? ''}
                          {text(row.description) ? ` · ${text(row.description)}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      }
      const reply = (c.reply ?? {}) as Record<string, unknown>;
      const answer = text(reply.id)?.startsWith('w360csat:');
      return (
        <p>
          {answer ? (
            <span className="block text-xs font-medium uppercase tracking-wide opacity-70">
              CSAT answer
            </span>
          ) : null}
          {text(reply.title) ?? 'Interactive reply'}
        </p>
      );
    }
    case 'button':
      return <p>{text(c.text) ?? 'Button reply'}</p>;
    case 'contacts': {
      // Contacts beyond what a message may hold are left out, and counted (ADR-131).
      const omitted = typeof c.omittedContacts === 'number' ? c.omittedContacts : 0;
      return (
        <div className="grid gap-1">
          <p>Shared a contact card</p>
          {cardPeople(c).map((person, index) => (
            <p key={index} className="break-words">
              <span className="font-medium">{person.name}</span>
              {person.reach ? (
                <span className="block text-xs opacity-80">{person.reach}</span>
              ) : null}
            </p>
          ))}
          {omitted > 0 ? (
            <p className="text-xs opacity-80">
              {omitted} contact{omitted === 1 ? ' was' : 's were'} too large to keep
            </p>
          ) : null}
        </div>
      );
    }
    case 'order': {
      // A cart from the catalog (amounts in minor units, read when the webhook arrived).
      const order = (typeof c.order === 'object' && c.order !== null ? c.order : null) as Record<
        string,
        unknown
      > | null;
      if (!order) return <p>Sent an order that could not be read.</p>;
      const items = Array.isArray(order.items) ? (order.items as Record<string, unknown>[]) : [];
      const units = items.reduce(
        (n, i) => n + (typeof i.quantity === 'number' ? i.quantity : 0),
        0,
      );
      const subtotal =
        typeof order.subtotalMinor === 'number' && text(order.currency)
          ? formatMinor(order.subtotalMinor, order.currency as string)
          : null;
      return (
        <div className="grid gap-1">
          <p className="text-xs font-medium uppercase tracking-wide opacity-70">Order</p>
          <p>
            {units} item{units === 1 ? '' : 's'}
            {subtotal ? ` · ${subtotal}` : ''}
          </p>
          {typeof order.dropped === 'number' && order.dropped > 0 ? (
            <p className="text-xs opacity-80">
              {order.dropped} item{order.dropped === 1 ? '' : 's'} could not be read
            </p>
          ) : null}
          {text(order.note) ? (
            <p className="whitespace-pre-wrap break-words">{text(order.note)}</p>
          ) : null}
        </div>
      );
    }
    case 'system':
      return <p className="italic">WhatsApp account update</p>;
    case 'template': {
      if (c.redacted === true) return <p className="italic">Content removed</p>;
      const rendered = (c.rendered ?? {}) as Record<string, unknown>;
      const template = (c.template ?? {}) as Record<string, unknown>;
      const campaign = (c.campaign ?? {}) as Record<string, unknown>;
      const buttons = Array.isArray(rendered.buttons)
        ? (rendered.buttons as { text?: unknown }[]).map((b) => text(b.text)).filter(Boolean)
        : [];
      // A photo, video or document header sent through the API from an https link (ADR-201).
      const headerMedia = (c.headerMedia ?? {}) as Record<string, unknown>;
      const headerLink = text(headerMedia.link);
      return (
        <div className="grid gap-1">
          <p className="text-xs font-medium uppercase tracking-wide opacity-70">
            {text(campaign.name) ? `Campaign “${text(campaign.name)}” · ` : ''}Template ·{' '}
            {text(template.name) ?? 'unknown'}
          </p>
          {headerLink?.startsWith('https://') ? (
            <p>
              <span className="font-medium">
                {HEADER_FILE_NAMES[text(headerMedia.type) ?? ''] ?? 'File'}
              </span>
              <a
                href={headerLink}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="block break-all text-xs underline opacity-80"
              >
                {headerLink}
              </a>
            </p>
          ) : null}
          {text(rendered.header) ? <p className="font-semibold">{text(rendered.header)}</p> : null}
          <p className="whitespace-pre-wrap break-words">{text(rendered.body) ?? ''}</p>
          {text(rendered.footer) ? (
            <p className="text-xs opacity-80">{text(rendered.footer)}</p>
          ) : null}
          {buttons.length > 0 ? (
            <p className="text-xs opacity-80">Buttons: {buttons.join(' · ')}</p>
          ) : null}
        </div>
      );
    }
    default:
      return <p className="italic">This message type is not supported yet.</p>;
  }
}

/** The message types a customer sends a file with (ADR-216). */
const FILE_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

export function MessageBubble({
  slug,
  conversationId,
  message,
  timeZone,
  canResolveUnknown,
}: {
  slug: string;
  conversationId: string;
  message: ThreadMessage;
  timeZone: string;
  canResolveUnknown: boolean;
}) {
  const outbound = message.direction === 'outbound';
  const content = message.content as { id?: unknown } | null;
  const mediaUrl =
    !outbound &&
    FILE_TYPES.has(message.type) &&
    typeof content?.id === 'string' &&
    content.id.length > 0
      ? `/c/${slug}/inbox/${conversationId}/media/${message.id}`
      : null;
  const at = formatDateTime(message.providerTimestamp ?? message.createdAt, timeZone);
  return (
    <li className={cn('flex', outbound ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg border px-3 py-2 text-sm sm:max-w-[70%]',
          outbound ? 'border-primary/30 bg-primary/10' : 'border-border bg-background',
        )}
      >
        <span className="sr-only">
          {outbound
            ? message.senderType === 'campaign'
              ? 'Campaign message'
              : message.senderType === 'system'
                ? 'Automatic message'
                : message.senderType === 'bot'
                  ? 'Automation replied'
                  : message.senderType === 'api'
                    ? 'Sent through the API'
                    : `${message.senderName ?? 'Your team'} replied`
            : 'Customer wrote'}
          :{' '}
        </span>
        {message.replyTo &&
        message.type !== 'reaction' &&
        !(message.direction === 'inbound' && ANSWER_TYPES.has(message.type)) ? (
          <blockquote className="mb-1 border-l-2 border-muted-foreground/40 pl-2 text-xs text-muted-foreground">
            <span className="font-medium">
              <span className="sr-only">Quoting </span>
              {message.replyTo.direction === 'inbound' ? 'Customer' : 'Your team'}
            </span>
            <span className="block break-words">{message.replyTo.text}</span>
          </blockquote>
        ) : null}
        <Body
          type={message.type}
          content={message.content}
          replyTo={message.replyTo}
          mediaUrl={mediaUrl}
        />
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <time dateTime={message.providerTimestamp ?? message.createdAt}>{at}</time>
          {outbound && message.senderType === 'system' ? (
            <span>· {storeMessageLabel(message.content) ?? 'Sent automatically'}</span>
          ) : null}
          {outbound && message.senderType === 'bot' ? <span>· Automation</span> : null}
          {outbound && message.senderType === 'api' ? (
            <span>· API{message.apiKeyName ? ` (${message.apiKeyName})` : ''}</span>
          ) : null}
          {outbound && message.senderName && message.senderType !== 'system' ? (
            <span>· {message.senderName}</span>
          ) : null}
          {outbound ? (
            <span className={message.status === 'failed' ? 'text-destructive' : undefined}>
              · {STATUS_LABELS[message.status] ?? message.status}
            </span>
          ) : null}
        </p>
        {outbound && message.status === 'failed' && (message.errorTitle || message.errorCode) ? (
          <p className="mt-1 text-xs text-destructive">
            {message.errorTitle ?? 'Delivery failed'}
            {message.errorCode ? ` (${message.errorCode})` : ''}
          </p>
        ) : null}
        {outbound && message.status === 'unknown_outcome' && canResolveUnknown ? (
          <UnknownOutcomeActions slug={slug} messageId={message.id} />
        ) : null}
      </div>
    </li>
  );
}
