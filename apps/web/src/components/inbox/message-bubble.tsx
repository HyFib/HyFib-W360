import { cn } from '@w360/ui/cn';
import { formatDateTime } from '@/lib/format';
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
  createdAt: string;
  providerTimestamp: string | null;
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

/** Renders message content as plain text only (never HTML), by type. */
function Body({ type, content }: { type: string; content: unknown }) {
  const c = (typeof content === 'object' && content !== null ? content : {}) as Record<
    string,
    unknown
  >;
  if (c.redacted === true && type !== 'template') {
    return <p className="italic">Content removed</p>;
  }
  switch (type) {
    case 'text':
      return <p className="whitespace-pre-wrap break-words">{text(c.text) ?? ''}</p>;
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker':
      return (
        <p className="whitespace-pre-wrap break-words">
          <span className="font-medium capitalize">{type}</span>
          {text(c.filename) ? ` · ${text(c.filename)}` : ''}
          {text(c.caption) ? <span className="block">{text(c.caption)}</span> : null}
          <span className="block text-xs opacity-80">Media download is not available yet.</span>
        </p>
      );
    case 'location':
      return (
        <p>
          <span className="font-medium">Location</span>
          {text(c.name) ? ` · ${text(c.name)}` : ''}
          {text(c.address) ? <span className="block">{text(c.address)}</span> : null}
        </p>
      );
    case 'reaction':
      return <p>{text(c.emoji) ? `Reacted ${text(c.emoji)}` : 'Removed a reaction'}</p>;
    case 'interactive': {
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
        // A question with reply buttons sent by an automation.
        const buttons = Array.isArray(c.buttons)
          ? (c.buttons as unknown[]).map(text).filter(Boolean)
          : [];
        return (
          <div className="grid gap-1">
            {text(c.header) ? <p className="font-semibold">{text(c.header)}</p> : null}
            <p className="whitespace-pre-wrap break-words">{text(c.body) ?? ''}</p>
            {text(c.footer) ? <p className="text-xs opacity-80">{text(c.footer)}</p> : null}
            {buttons.length > 0 ? (
              <p className="text-xs opacity-80">Buttons: {buttons.join(' · ')}</p>
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
    case 'contacts':
      return <p>Shared a contact card</p>;
    case 'order':
      return <p>Sent an order{text(c.text) ? `: ${text(c.text)}` : ''}</p>;
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
      return (
        <div className="grid gap-1">
          <p className="text-xs font-medium uppercase tracking-wide opacity-70">
            {text(campaign.name) ? `Campaign “${text(campaign.name)}” · ` : ''}Template ·{' '}
            {text(template.name) ?? 'unknown'}
          </p>
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

export function MessageBubble({
  slug,
  message,
  timeZone,
  canResolveUnknown,
}: {
  slug: string;
  message: ThreadMessage;
  timeZone: string;
  canResolveUnknown: boolean;
}) {
  const outbound = message.direction === 'outbound';
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
                  : `${message.senderName ?? 'Your team'} replied`
            : 'Customer wrote'}
          :{' '}
        </span>
        <Body type={message.type} content={message.content} />
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <time dateTime={message.providerTimestamp ?? message.createdAt}>{at}</time>
          {outbound && message.senderType === 'system' ? <span>· Sent automatically</span> : null}
          {outbound && message.senderType === 'bot' ? <span>· Automation</span> : null}
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
