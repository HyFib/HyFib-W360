import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can, webhookErrorLabel, webhookHost, type WebhookDeliveryView } from '@w360/domain';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import {
  ReplayDeliveryButton,
  ReplayFailedDeliveriesForm,
  WebhookEndpointForm,
} from '@/components/settings/webhooks';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Webhook deliveries' };
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATE_BADGES: Record<
  WebhookDeliveryView['state'],
  { label: string; tone: 'success' | 'danger' | 'warning' | 'info' }
> = {
  succeeded: { label: 'Delivered', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  pending: { label: 'Waiting', tone: 'warning' },
  delivering: { label: 'Sending', tone: 'info' },
};

export default async function WebhookEndpointPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; endpointId: string }>;
  searchParams: Promise<{ failed?: string }>;
}) {
  const { slug, endpointId } = await params;
  const { failed } = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'developer.manage') || !UUID_RE.test(endpointId)) notFound();
  const { webhooks } = await getRuntime();
  const endpoint = (await webhooks.list(ctx)).find((e) => e.id === endpointId);
  if (!endpoint) notFound();
  const failedOnly = failed === '1';
  const [
    deliveries,
    automationChoices,
    channelChoices,
    teamChoices,
    templateChoices,
    assigneeChoices,
  ] = await Promise.all([
    webhooks.deliveries(ctx, { endpointId, failedOnly }),
    webhooks.automationChoices(ctx),
    webhooks.channelChoices(ctx),
    webhooks.teamChoices(ctx),
    webhooks.templateChoices(ctx),
    webhooks.assigneeChoices(ctx),
  ]);
  const tz = ctx.tenant.timezone;
  const host = webhookHost(endpoint.url) ?? endpoint.url;
  const base = `/c/${ctx.tenant.slug}/settings/webhooks`;
  const active = endpoint.state === 'active';
  return (
    <div className="grid grid-cols-1 gap-6">
      <p className="text-sm">
        <Link className="font-medium underline underline-offset-4" href={base}>
          All endpoints
        </Link>
      </p>
      <Card>
        <CardHeader>
          <CardTitle className="break-all">Deliveries to {host}</CardTitle>
          <CardDescription>
            The latest 100{failedOnly ? ' failed' : ''} deliveries, newest first. A replay sends the
            same event again as a new delivery, with the same event id. Replaying failed deliveries
            sends every event whose deliveries all failed in the period again, or only those of one
            event or whose last failure was of one kind, 500 at a time.
            {active ? '' : ' Turn the endpoint on to replay deliveries.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="flex flex-wrap gap-3 text-sm">
            {failedOnly ? (
              <Link
                className="font-medium underline underline-offset-4"
                href={`${base}/${endpointId}`}
              >
                Show all deliveries
              </Link>
            ) : (
              <Link
                className="font-medium underline underline-offset-4"
                href={`${base}/${endpointId}?failed=1`}
              >
                Show failed deliveries only
              </Link>
            )}
          </p>
          {active ? (
            <ReplayFailedDeliveriesForm
              slug={ctx.tenant.slug}
              endpointId={endpointId}
              events={endpoint.eventTypes}
            />
          ) : null}
          {deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {failedOnly ? 'No failed deliveries.' : 'No deliveries yet.'}
            </p>
          ) : (
            <ul className="grid gap-3" aria-label="Deliveries">
              {deliveries.map((d) => {
                const badge = STATE_BADGES[d.state];
                const error = webhookErrorLabel(d.lastError, d.lastStatusCode);
                return (
                  <li key={d.id} className="grid gap-2 rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{d.eventType}</span>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                      {d.replayOf ? <Badge tone="neutral">Replay</Badge> : null}
                    </div>
                    <dl className="grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <div>
                        <dt className="inline">Event </dt>
                        <dd className="inline font-mono break-all">{d.eventId}</dd>
                      </div>
                      <div>
                        <dt className="inline">Created </dt>
                        <dd className="inline">{formatDateTime(d.createdAt, tz)}</dd>
                      </div>
                      <div>
                        <dt className="inline">Attempts </dt>
                        <dd className="inline">{d.attempts}</dd>
                      </div>
                      {d.lastAttemptAt ? (
                        <div>
                          <dt className="inline">Last attempt </dt>
                          <dd className="inline">
                            {formatDateTime(d.lastAttemptAt, tz)}
                            {d.lastDurationMs !== null ? ` (${d.lastDurationMs} ms)` : ''}
                          </dd>
                        </div>
                      ) : null}
                      {error ? (
                        <div>
                          <dt className="inline">Result </dt>
                          <dd className="inline">{error}</dd>
                        </div>
                      ) : null}
                      {d.state === 'pending' ? (
                        <div>
                          <dt className="inline">Next attempt </dt>
                          <dd className="inline">{formatDateTime(d.nextAttemptAt, tz)}</dd>
                        </div>
                      ) : null}
                      {d.deliveredAt ? (
                        <div>
                          <dt className="inline">Delivered </dt>
                          <dd className="inline">{formatDateTime(d.deliveredAt, tz)}</dd>
                        </div>
                      ) : null}
                    </dl>
                    {active && (d.state === 'succeeded' || d.state === 'failed') ? (
                      <ReplayDeliveryButton
                        slug={ctx.tenant.slug}
                        deliveryId={d.id}
                        label={`${d.eventType} ${d.eventId}`}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Endpoint settings</CardTitle>
          <CardDescription>
            Changes apply to the next attempt, including retries of earlier events.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WebhookEndpointForm
            slug={ctx.tenant.slug}
            endpoint={{
              id: endpoint.id,
              url: endpoint.url,
              description: endpoint.description,
              eventTypes: endpoint.eventTypes,
              headerNames: endpoint.headerNames,
              messageStatuses: endpoint.messageStatuses,
              messageSenders: endpoint.messageSenders,
              contactParts: endpoint.contactParts,
              automationIds: endpoint.automations?.map((a) => a.id) ?? null,
              campaignStatuses: endpoint.campaignStatuses,
              orderStatuses: endpoint.orderStatuses,
              templateStatuses: endpoint.templateStatuses,
              conversationStatuses: endpoint.conversationStatuses,
              runEndStatuses: endpoint.runEndStatuses,
              channelIds: endpoint.channels?.map((c) => c.id) ?? null,
              teams: endpoint.teams,
              templateIds: endpoint.templates?.map((t) => t.id) ?? null,
              assignees: endpoint.assignees,
              oauth: endpoint.oauth,
            }}
            automationChoices={automationChoices}
            channelChoices={channelChoices}
            teamChoices={teamChoices}
            templateChoices={templateChoices}
            assigneeChoices={assigneeChoices}
          />
        </CardContent>
      </Card>
    </div>
  );
}
