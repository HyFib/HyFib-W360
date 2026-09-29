import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  can,
  WEBHOOK_EVENT_INFO,
  WEBHOOK_LIMITS,
  webhookHost,
  type WebhookEndpointView,
} from '@w360/domain';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { WebhookEndpointActions, WebhookEndpointForm } from '@/components/settings/webhooks';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Webhooks' };
export const dynamic = 'force-dynamic';

function stateBadge(endpoint: WebhookEndpointView) {
  if (endpoint.state === 'active') return <Badge tone="success">On</Badge>;
  return endpoint.disabledReason === 'failing' ? (
    <Badge tone="danger">Turned off: failing</Badge>
  ) : (
    <Badge tone="neutral">Off</Badge>
  );
}

export default async function WebhooksPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'developer.manage')) notFound();
  const { webhooks } = await getRuntime();
  const endpoints = await webhooks.list(ctx);
  const tz = ctx.tenant.timezone;
  const base = `/c/${ctx.tenant.slug}/settings/webhooks`;
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Webhooks</CardTitle>
          <CardDescription>
            Your systems can receive what happens in HyFib W360 as it happens: messages and their
            status, consent changes, template status, conversations resolved, reopened or assigned,
            contacts added, changed or erased, and automations starting and ending. Each event is a
            signed JSON POST to your endpoint.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p>
            Check the <code className="font-mono text-xs">W360-Signature</code> header before
            trusting a request: it holds the time and an HMAC-SHA256 of{' '}
            <code className="font-mono text-xs">&lt;time&gt;.&lt;body&gt;</code> made with the
            endpoint’s secret. Answer with a 2xx status within 10 seconds; anything else is retried
            up to {WEBHOOK_LIMITS.attempts} times over about two days.
          </p>
          <p>
            An event can arrive more than once and out of order: use its id to ignore repeats. The
            bodies are described in the{' '}
            <a
              className="font-medium underline underline-offset-4"
              href="/api/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
            >
              OpenAPI document
            </a>{' '}
            under <code className="font-mono text-xs">webhooks</code>. Deliveries are kept{' '}
            {WEBHOOK_LIMITS.retentionDays} days.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Endpoints</CardTitle>
          <CardDescription>
            {endpoints.length} of {WEBHOOK_LIMITS.endpoints} endpoints. An endpoint that fails every
            delivery for {WEBHOOK_LIMITS.disableAfterHours} hours is turned off, and owners and
            administrators are emailed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {endpoints.length === 0 ? (
            <p className="text-sm text-muted-foreground">No endpoints yet.</p>
          ) : (
            <ul className="grid gap-3" aria-label="Endpoints">
              {endpoints.map((e) => {
                const host = webhookHost(e.url) ?? e.url;
                return (
                  <li key={e.id} className="grid gap-2 rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-all">{host}</span>
                      {stateBadge(e)}
                    </div>
                    <p className="font-mono text-xs break-all">{e.url}</p>
                    {e.description ? <p className="text-sm">{e.description}</p> : null}
                    <p className="flex flex-wrap gap-1">
                      {e.eventTypes.map((t) => (
                        <Badge key={t} tone="neutral">
                          {WEBHOOK_EVENT_INFO[t].label}
                        </Badge>
                      ))}
                    </p>
                    <dl className="grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <div>
                        <dt className="inline">Last 24 hours </dt>
                        <dd className="inline">
                          {e.recent.succeeded} delivered, {e.recent.failed} failed,{' '}
                          {e.recent.pending + e.recent.delivering} waiting
                        </dd>
                      </div>
                      <div>
                        <dt className="inline">Last success </dt>
                        <dd className="inline">
                          {e.lastSuccessAt ? formatDateTime(e.lastSuccessAt, tz) : 'none yet'}
                        </dd>
                      </div>
                      {e.failingSince ? (
                        <div>
                          <dt className="inline">Failing since </dt>
                          <dd className="inline">{formatDateTime(e.failingSince, tz)}</dd>
                        </div>
                      ) : null}
                      {e.disabledAt ? (
                        <div>
                          <dt className="inline">Turned off </dt>
                          <dd className="inline">{formatDateTime(e.disabledAt, tz)}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="inline">Secret </dt>
                        <dd className="inline">
                          version {e.secretVersion}
                          {e.previousSecretExpiresAt
                            ? `; the previous one also signs until ${formatDateTime(e.previousSecretExpiresAt, tz)}`
                            : ''}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline">Added </dt>
                        <dd className="inline">
                          {formatDateTime(e.createdAt, tz)}
                          {e.createdByKey
                            ? ` by the API key “${e.createdByKey.name}” (${e.createdByKey.keyPrefix}_…)`
                            : e.createdBy
                              ? ` by ${e.createdBy}`
                              : ''}
                        </dd>
                      </div>
                    </dl>
                    <p className="text-sm">
                      <Link
                        className="font-medium underline underline-offset-4"
                        href={`${base}/${e.id}`}
                      >
                        Deliveries and settings<span className="sr-only"> for {host}</span>
                      </Link>
                    </p>
                    <WebhookEndpointActions
                      slug={ctx.tenant.slug}
                      endpointId={e.id}
                      host={host}
                      active={e.state === 'active'}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>New endpoint</CardTitle>
          <CardDescription>
            Choose the events it receives. Its signing secret is shown once, when it is added.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WebhookEndpointForm
            slug={ctx.tenant.slug}
            atLimit={endpoints.length >= WEBHOOK_LIMITS.endpoints}
          />
        </CardContent>
      </Card>
    </div>
  );
}
