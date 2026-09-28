import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  API_KEY_LIMITS,
  API_LIMITS,
  API_SCOPE_INFO,
  API_SCOPE_KEYS,
  can,
  hasRecentSignIn,
  RECENT_SIGN_IN_MINUTES,
  type ApiKeyView,
} from '@w360/domain';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { ApiKeyActions, CreateApiKeyForm } from '@/components/settings/api-keys';
import { CopyField } from '@/components/growth/copy-field';
import { SignInAgain } from '@/components/sign-in-again';
import { formatDateTime } from '@/lib/format';
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
  const { apiKeys, config, clock } = await getRuntime();
  const keys = await apiKeys.list(ctx);
  const tz = ctx.tenant.timezone;
  const apiBase = new URL('/api/v1', config.APP_BASE_URL).toString();
  const grantable = API_SCOPE_KEYS.filter((s) => can(ctx, API_SCOPE_INFO[s].permission));
  const activeCount = keys.filter((k) => k.state === 'active').length;
  const prefixes = new Map(keys.map((k) => [k.id, k.keyPrefix]));
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Using the API</CardTitle>
          <CardDescription>
            Your systems can send approved templates, create contacts, record consent and read
            message status through the HyFib W360 API. Each key belongs to the company and has only
            the scopes chosen for it. The audit log records changes to keys, and the contacts and
            consent a key records.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <CopyField label="Base URL" value={apiBase} />
          <p className="text-sm">
            Send the key as{' '}
            <code className="font-mono text-xs">Authorization: Bearer &lt;key&gt;</code>. Sending a
            message needs an <code className="font-mono text-xs">Idempotency-Key</code> header, so a
            retry never sends twice. Each key can make {API_LIMITS.keyRate.refillPerSecond} requests
            a second. The full reference is the{' '}
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
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            {activeCount} of {API_KEY_LIMITS.activeKeys} active keys. A key’s secret part is shown
            only when it is created; the list shows its public prefix.
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
                      {k.replacedByKeyId ? (
                        <Badge tone="neutral">
                          Rotated to {prefixes.get(k.replacedByKeyId) ?? 'a new key'}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="font-mono text-xs">{k.keyPrefix}_…</p>
                    <p className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <Badge key={s} tone="neutral">
                          {API_SCOPE_INFO[s].label}
                        </Badge>
                      ))}
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
                    </dl>
                    <ApiKeyActions
                      slug={ctx.tenant.slug}
                      keyId={k.id}
                      name={k.name}
                      rotatable={k.state === 'active' && !k.replacedByKeyId}
                      revocable={k.state === 'active'}
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
          {hasRecentSignIn(ctx, clock.now()) ? (
            <CreateApiKeyForm
              slug={ctx.tenant.slug}
              grantable={grantable}
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
