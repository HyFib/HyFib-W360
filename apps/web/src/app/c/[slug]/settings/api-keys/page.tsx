import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  API_KEY_LIMITS,
  API_KEY_REMINDER_DAYS,
  API_LIMITS,
  API_SCOPE_INFO,
  API_SCOPE_KEYS,
  apiKeyExpiresSoon,
  can,
  formatAllowedNetwork,
  hasRecentSignIn,
  MCP_MODERN_VERSION,
  MCP_PATH,
  MCP_TOOLS,
  RECENT_SIGN_IN_MINUTES,
  type ApiKeyView,
} from '@w360/domain';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import {
  ApiKeyActions,
  CompanyApiNetworks,
  CreateApiKeyForm,
} from '@/components/settings/api-keys';
import { CopyField } from '@/components/growth/copy-field';
import { SignInAgain } from '@/components/sign-in-again';
import { formatDate, formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'API keys' };
export const dynamic = 'force-dynamic';

const STATE_BADGES: Record<ApiKeyView['state'], { label: string; tone: 'success' | 'neutral' }> = {
  active: { label: 'Active', tone: 'success' },
  expired: { label: 'Expired', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'neutral' },
};

export default async function ApiKeysPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'developer.manage')) notFound();
  const { apiKeys, config, clock, plans } = await getRuntime();
  const keys = await apiKeys.list(ctx);
  const { allowedNetworks: companyNetworks } = await apiKeys.companyNetworks(ctx);
  const usage = await plans.usage(ctx);
  const apiLimit = usage.limits.apiRequests;
  const inPlan = apiLimit !== 0;
  const tz = ctx.tenant.timezone;
  const apiBase = new URL('/api/v1', config.APP_BASE_URL).toString();
  const mcpUrl = new URL(MCP_PATH, config.APP_BASE_URL).toString();
  // Scopes the plan leaves out (ADR-092): refused to requests, and not offered for new keys.
  const planScopes = usage.apiScopes;
  const notInPlan =
    planScopes === null ? [] : API_SCOPE_KEYS.filter((s) => !planScopes.includes(s));
  const grantable = API_SCOPE_KEYS.filter(
    (s) => can(ctx, API_SCOPE_INFO[s].permission) && !notInPlan.includes(s),
  );
  const activeCount = keys.filter((k) => k.state === 'active').length;
  const prefixes = new Map(keys.map((k) => [k.id, k.keyPrefix]));
  const now = clock.now();
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Using the API</CardTitle>
          <CardDescription>
            Your systems can send approved templates and replies (text, buttons, lists, products and
            reactions, quoting a message if they like), create contacts and change their details,
            custom fields and tags, record consent, read conversations, their messages (one
            conversation or all of them) and their notes, resolve and reopen conversations and add
            notes to them, start and stop automations, add webhook endpoints and follow their
            deliveries, and read message status through the HyFib W360 API. Each key belongs to the
            company and has only the scopes chosen for it. The audit log records changes to keys,
            the contacts and consent a key records or changes, the conversations it resolves or
            reopens, the automation runs it starts and stops, the webhook endpoints it adds and
            changes, and the deliveries it replays.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {inPlan ? (
            <p className="text-sm">
              {formatDate(usage.apiRequests.periodStart, tz)} to{' '}
              {formatDate(usage.apiRequests.periodEnd, tz)}:{' '}
              <strong>
                {usage.apiRequests.used.toLocaleString('en-IN')}
                {apiLimit === null ? '' : ` of ${apiLimit.toLocaleString('en-IN')}`}
              </strong>{' '}
              API requests
              {apiLimit === null
                ? '; your plan has no monthly limit.'
                : '. When they are used up, the API refuses requests until the next period.'}
            </p>
          ) : (
            <Alert tone="warning" title="The public API is not in your plan">
              Your company’s plan does not include the public API, so requests with its keys are
              refused and new keys cannot be created. Ask HyFib to change the plan.
            </Alert>
          )}
          {inPlan && planScopes !== null ? (
            <p className="text-sm">
              Your plan includes these scopes:{' '}
              {planScopes.map((s) => API_SCOPE_INFO[s].label).join(', ')}. Requests that need
              another scope are refused, whatever scopes their key has.
            </p>
          ) : null}
          <CopyField label="Base URL" value={apiBase} />
          <p className="text-sm">
            Send the key as{' '}
            <code className="font-mono text-xs">Authorization: Bearer &lt;key&gt;</code>. Sending a
            message needs an <code className="font-mono text-xs">Idempotency-Key</code> header, so a
            retry never sends twice. Each key can make {API_LIMITS.keyRate.refillPerSecond} requests
            a second, and can be limited to the addresses your systems call from and to a number of
            requests a month. The full reference is the{' '}
            <Link className="font-medium underline underline-offset-4" href="/developers">
              API reference
            </Link>
            , also as an{' '}
            <a
              className="font-medium underline underline-offset-4"
              href="/api/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
            >
              OpenAPI document
            </a>
            .
          </p>
          <CopyField
            label="Example: send a template"
            multiline
            value={[
              `curl -X POST ${apiBase}/messages \\`,
              `  -H "Authorization: Bearer $W360_API_KEY" \\`,
              `  -H "Idempotency-Key: $(uuidgen)" \\`,
              `  -H "Content-Type: application/json" \\`,
              `  -d '{"to":"+919876543210","templateId":"<template id>","variables":{"body":["Asha"]}}'`,
            ].join('\n')}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI assistants (MCP)</CardTitle>
          <CardDescription>
            AI assistants that support the Model Context Protocol can use the API through its MCP
            endpoint with an API key, as your systems do: each tool needs the same scopes as the API
            call it mirrors, and counts as that call against the key’s and the plan’s limits. Give
            an assistant its own key with read scopes only, unless you want it to send messages;
            sending tools message real customers, so have the assistant ask before each send.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {inPlan ? null : (
            <p className="text-sm text-muted-foreground">
              The MCP endpoint is part of the public API, so it refuses requests while your plan
              does not include the API.
            </p>
          )}
          <CopyField label="MCP endpoint" value={mcpUrl} />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">MCP tools and the scopes they need</caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Tool
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    What it does
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Scope needed
                  </th>
                </tr>
              </thead>
              <tbody>
                {MCP_TOOLS.map((tool) => (
                  <tr key={tool.name} className="border-t border-border">
                    <td className="py-1 pr-3 font-mono text-xs">{tool.name}</td>
                    <td className="py-1 pr-3">{tool.title}</td>
                    <td className="py-1">
                      {tool.scopes.map((s) => API_SCOPE_INFO[s].label).join(' or ')}
                      {tool.scopes.every((s) => notInPlan.includes(s)) ? (
                        <>
                          {' '}
                          <Badge tone="warning">Not in your plan</Badge>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm">
            Messages, names and other text your customers write reach the assistant as data; the
            tools tell it never to follow instructions found in them. The send tools need an{' '}
            <code className="font-mono text-xs">idempotencyKey</code> argument, so a retry never
            sends twice.
          </p>
          <CopyField
            label="Example client configuration"
            description="Many MCP clients read a configuration like this; check your client’s documentation for its exact format. Replace the placeholder with the key."
            multiline
            value={JSON.stringify(
              {
                mcpServers: {
                  'hyfib-w360': {
                    type: 'http',
                    url: mcpUrl,
                    headers: { Authorization: 'Bearer <your API key>' },
                  },
                },
              },
              null,
              2,
            )}
          />
          <CopyField
            label="Example: list the tools"
            multiline
            value={[
              `curl -X POST ${mcpUrl} \\`,
              `  -H "Authorization: Bearer $W360_API_KEY" \\`,
              `  -H "Content-Type: application/json" \\`,
              `  -H "Accept: application/json, text/event-stream" \\`,
              `  -H "MCP-Protocol-Version: ${MCP_MODERN_VERSION}" \\`,
              `  -H "Mcp-Method: tools/list" \\`,
              `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"${MCP_MODERN_VERSION}","io.modelcontextprotocol/clientCapabilities":{}}}}'`,
            ].join('\n')}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Addresses for all keys</CardTitle>
          <CardDescription>
            Hold every key of the company to the addresses your systems call from, including keys
            created later. A key that lists addresses of its own accepts only requests from both
            lists.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm">
            {companyNetworks ? (
              <>
                Keys accept requests only from{' '}
                <span className="font-mono text-xs">
                  {companyNetworks.map(formatAllowedNetwork).join(', ')}
                </span>
                .
              </>
            ) : (
              'Keys accept requests from any address, unless a key lists its own.'
            )}
          </p>
          <CompanyApiNetworks slug={ctx.tenant.slug} allowedNetworks={companyNetworks} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            {activeCount} of {API_KEY_LIMITS.activeKeys} active keys. A key’s secret part is shown
            only when it is created; the list shows its public prefix. Owners and administrators are
            emailed {API_KEY_REMINDER_DAYS} days before a key expires, unless it was rotated.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No API keys yet.</p>
          ) : (
            <ul className="grid gap-3">
              {keys.map((k) => {
                const badge = STATE_BADGES[k.state];
                return (
                  <li key={k.id} className="grid gap-2 rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{k.name}</span>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                      {apiKeyExpiresSoon(k, now) ? (
                        <Badge tone="warning">Expires soon</Badge>
                      ) : null}
                      {k.replacedByKeyId ? (
                        <Badge tone="neutral">
                          Rotated to {prefixes.get(k.replacedByKeyId) ?? 'a new key'}
                        </Badge>
                      ) : null}
                      {k.state === 'active' &&
                      k.monthlyRequestLimit !== null &&
                      k.requestsThisPeriod >= k.monthlyRequestLimit ? (
                        <Badge tone="warning">Monthly limit reached</Badge>
                      ) : null}
                    </div>
                    <p className="font-mono text-xs">{k.keyPrefix}_…</p>
                    <p className="flex flex-wrap gap-1">
                      {k.scopes.map((s) =>
                        notInPlan.includes(s) ? (
                          <Badge key={s} tone="warning">
                            {API_SCOPE_INFO[s].label}: not in your plan
                          </Badge>
                        ) : (
                          <Badge key={s} tone="neutral">
                            {API_SCOPE_INFO[s].label}
                          </Badge>
                        ),
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Accepts requests from{' '}
                      {k.allowedNetworks ? (
                        <span className="font-mono text-foreground">
                          {k.allowedNetworks.map(formatAllowedNetwork).join(', ')}
                        </span>
                      ) : companyNetworks ? (
                        'the addresses for all keys'
                      ) : (
                        'any address'
                      )}
                      {k.allowedNetworks && companyNetworks
                        ? ', when they are also among the addresses for all keys'
                        : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Requests this period:{' '}
                      <span className="text-foreground">
                        {k.requestsThisPeriod.toLocaleString('en-IN')}
                        {k.monthlyRequestLimit === null
                          ? ''
                          : ` of ${k.monthlyRequestLimit.toLocaleString('en-IN')}`}
                      </span>{' '}
                      {k.monthlyRequestLimit === null
                        ? '(no limit of its own)'
                        : '(its own monthly limit)'}
                    </p>
                    <dl className="grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <div>
                        <dt className="inline">Created </dt>
                        <dd className="inline">
                          {formatDateTime(k.createdAt, tz)}
                          {k.createdBy ? ` by ${k.createdBy}` : ''}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline">Last used </dt>
                        <dd className="inline">
                          {k.lastUsedAt ? formatDateTime(k.lastUsedAt, tz) : 'never'}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline">
                          {k.revokedAt
                            ? 'Revoked '
                            : k.state === 'expired'
                              ? 'Expired '
                              : 'Expires '}
                        </dt>
                        <dd className="inline">
                          {k.revokedAt
                            ? formatDateTime(k.revokedAt, tz)
                            : k.expiresAt
                              ? formatDateTime(k.expiresAt, tz)
                              : 'never'}
                        </dd>
                      </div>
                      {k.expiryRemindedAt ? (
                        <div>
                          <dt className="inline">Expiry reminder emailed </dt>
                          <dd className="inline">{formatDateTime(k.expiryRemindedAt, tz)}</dd>
                        </div>
                      ) : null}
                      {k.usageWarnedAt ? (
                        <div>
                          <dt className="inline">80% of its limit emailed </dt>
                          <dd className="inline">{formatDateTime(k.usageWarnedAt, tz)}</dd>
                        </div>
                      ) : null}
                      {k.usageNotifiedAt ? (
                        <div>
                          <dt className="inline">Limit reached emailed </dt>
                          <dd className="inline">{formatDateTime(k.usageNotifiedAt, tz)}</dd>
                        </div>
                      ) : null}
                    </dl>
                    <ApiKeyActions
                      slug={ctx.tenant.slug}
                      keyId={k.id}
                      name={k.name}
                      rotatable={inPlan && k.state === 'active' && !k.replacedByKeyId}
                      revocable={k.state === 'active'}
                      allowedNetworks={k.state === 'active' ? k.allowedNetworks : undefined}
                      monthlyRequestLimit={k.state === 'active' ? k.monthlyRequestLimit : undefined}
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
          <CardTitle>New API key</CardTitle>
          <CardDescription>
            Give each system its own key with only the scopes it needs. You can grant only what your
            own role allows.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!inPlan ? (
            <p className="text-sm text-muted-foreground">
              New keys cannot be created while the plan does not include the public API.
            </p>
          ) : hasRecentSignIn(ctx, clock.now()) ? (
            <CreateApiKeyForm
              slug={ctx.tenant.slug}
              grantable={grantable}
              notInPlan={notInPlan}
              atLimit={activeCount >= API_KEY_LIMITS.activeKeys}
            />
          ) : (
            <SignInAgain
              reason={`Creating or rotating a key needs a sign-in within the last ${RECENT_SIGN_IN_MINUTES} minutes.`}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
