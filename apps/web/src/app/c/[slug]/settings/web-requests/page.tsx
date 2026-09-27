import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import {
  AddDomainForm,
  DeleteSecretButton,
  RemoveDomainButton,
  SecretForm,
} from '@/components/settings/web-requests';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Web requests' };
export const dynamic = 'force-dynamic';

export default async function WebRequestsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'automations.read') && !can(ctx, 'integrations.read')) notFound();
  const { webRequests } = await getRuntime();
  const settings = await webRequests.settings(ctx);
  const tz = ctx.tenant.timezone;
  const manage = settings.canManage;
  const domainNames = settings.domains.map((d) => d.domain);
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Allowed domains</CardTitle>
          <CardDescription>
            Automation steps can call only these domains, over https, and never private, internal or
            cloud-metadata addresses. Redirects are not followed. Removing a domain makes steps that
            call it fail from their next call on.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {settings.domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">No domains allowed yet.</p>
          ) : (
            <ul className="grid gap-3">
              {settings.domains.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="grid gap-1">
                    <p className="font-mono text-sm">{d.domain}</p>
                    <p className="text-xs text-muted-foreground">
                      Added {formatDateTime(d.createdAt, tz)}
                      {d.createdByName ? ` by ${d.createdByName}` : ''}
                    </p>
                  </div>
                  {manage ? (
                    <RemoveDomainButton slug={ctx.tenant.slug} id={d.id} domain={d.domain} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {manage ? <AddDomainForm slug={ctx.tenant.slug} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Secrets</CardTitle>
          <CardDescription>
            Keys and tokens for request headers, such as an API key. Steps refer to a secret by name
            ({'{{secret.name}}'}); the value is stored encrypted, is never shown again and is only
            ever sent to the domain it is saved for.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert tone="warning" title="Allow only domains you trust">
            A secret is sent in requests to its domain. If that server echoes request headers back,
            anyone who can edit automations could read the secret from its response.
          </Alert>
          {settings.secrets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No secrets yet.</p>
          ) : (
            <ul className="grid gap-3">
              {settings.secrets.map((s) => (
                <li key={s.id} className="grid gap-2 rounded-md border border-border p-3">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono font-medium">{s.name}</span>
                    <span className="text-muted-foreground">sent only to</span>
                    <span className="font-mono">{s.domain}</span>
                    {s.domainAllowed ? null : (
                      <Badge tone="warning">Domain no longer allowed: steps using it fail</Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Version {s.version}, updated {formatDateTime(s.updatedAt, tz)}
                    {s.updatedByName ? ` by ${s.updatedByName}` : ''}
                  </p>
                  {manage ? (
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">
                        Replace {s.name}
                      </summary>
                      <div className="mt-3 grid gap-3">
                        <SecretForm slug={ctx.tenant.slug} domains={domainNames} secret={s} />
                        <DeleteSecretButton slug={ctx.tenant.slug} id={s.id} name={s.name} />
                      </div>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {manage ? (
        <Card>
          <CardHeader>
            <CardTitle>New secret</CardTitle>
          </CardHeader>
          <CardContent>
            <SecretForm slug={ctx.tenant.slug} domains={domainNames} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          Administrators manage allowed domains and secrets.
        </p>
      )}
    </div>
  );
}
