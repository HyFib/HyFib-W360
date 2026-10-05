import Link from 'next/link';
import type { WhatsAppAccessIssue } from '@w360/domain';
import { Alert, Button } from '@w360/ui';
import { formatDateTime } from '@/lib/format';

/**
 * The company's WhatsApp accounts whose access needs attention (ADR-137): Meta no longer accepts
 * it, it expires within 7 days, or the expiry Meta reported has passed; and the accounts whose
 * webhooks HyFib's app is no longer subscribed to (ADR-138). On every page of the company (with a
 * link to Channels for the members who can reconnect) and on Channels itself.
 */
export function WhatsAppAccessAlerts({
  issues,
  slug,
  timeZone,
  canManage,
  onChannelsPage = false,
}: {
  issues: WhatsAppAccessIssue[];
  slug: string;
  timeZone: string;
  canManage: boolean;
  onChannelsPage?: boolean;
}) {
  const action =
    canManage && !onChannelsPage ? (
      <Button asChild size="sm" variant="outline">
        <Link href={`/c/${slug}/settings/channels`}>Open Channels</Link>
      </Button>
    ) : undefined;
  const reconnect = !canManage
    ? 'Ask an owner or administrator to reconnect it.'
    : onChannelsPage
      ? 'Choose Connect WhatsApp and pick the same account and one of its numbers in Meta’s window; HyFib then checks its other numbers with the new access.'
      : 'Connect the same account again on Channels.';
  return issues.map((issue) => {
    const key = `${issue.whatsappAccountId}:${issue.kind}`;
    return issue.kind === 'reconnect' ? (
      <Alert key={key} tone="danger" title="Reconnect WhatsApp" action={action}>
        Meta no longer accepts HyFib’s access to {issue.account}: {issue.reason}
        {issue.since ? ` (found ${formatDateTime(issue.since, timeZone)})` : ''}. Its numbers cannot
        send messages until it is reconnected. {reconnect}
      </Alert>
    ) : issue.kind === 'webhooks' ? (
      <Alert
        key={key}
        tone="danger"
        title="WhatsApp messages are not reaching HyFib"
        action={action}
      >
        Meta no longer sends HyFib the messages and updates of {issue.account}: HyFib’s app is not
        subscribed to the account, and subscribing it again failed
        {issue.since ? ` (found ${formatDateTime(issue.since, timeZone)})` : ''}. HyFib tries again
        every 30 minutes, and reconnecting the account also subscribes it. {reconnect}
      </Alert>
    ) : issue.kind === 'expired' ? (
      <Alert key={key} tone="danger" title="HyFib’s access to WhatsApp expired" action={action}>
        Meta reported that HyFib’s access to {issue.account} would expire on{' '}
        {formatDateTime(issue.expiresAt, timeZone)}. HyFib is checking it again; until it is
        reconnected, its numbers cannot send messages. {reconnect}
      </Alert>
    ) : (
      <Alert
        key={key}
        tone="warning"
        title="HyFib’s access to WhatsApp expires soon"
        action={action}
      >
        Meta reports that HyFib’s access to {issue.account} expires on{' '}
        {formatDateTime(issue.expiresAt, timeZone)}. Its numbers cannot send messages after that
        until it is reconnected. {reconnect}
      </Alert>
    );
  });
}
