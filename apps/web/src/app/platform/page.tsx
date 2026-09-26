import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { RevokeGrantButton } from '@/components/platform/platform-forms';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Platform administration' };
export const dynamic = 'force-dynamic';

export default async function PlatformHome({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const actor = await requirePlatformActor();
  const { q } = await searchParams;
  const { platform } = await getRuntime();
  const [companies, grants, audit] = await Promise.all([
    platform.listTenants(actor, { search: typeof q === 'string' ? q : undefined, limit: 100 }),
    platform.listActiveGrants(actor),
    platform.recentPlatformAudit(actor, 20),
  ]);
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Platform administration</h1>
      <p className="text-sm text-muted-foreground">
        Customer content is not visible here. Viewing company data requires a reasoned, time-boxed
        support grant that the company can see in its audit log.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Companies</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form className="flex gap-2" role="search">
            <label htmlFor="q" className="sr-only">
              Search companies
            </label>
            <Input
              id="q"
              name="q"
              defaultValue={typeof q === 'string' ? q : ''}
              placeholder="Search by name or address"
              className="max-w-sm"
            />
          </form>
          <Table>
            <THead>
              <TR>
                <TH>Company</TH>
                <TH>Status</TH>
                <TH>Members</TH>
                <TH>Billing mode</TH>
                <TH>Created</TH>
              </TR>
            </THead>
            <TBody>
              {companies.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <Link
                      href={`/platform/tenants/${c.id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {c.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">/{c.slug}</div>
                  </TD>
                  <TD>
                    <Badge tone={c.status === 'active' ? 'success' : 'warning'}>{c.status}</Badge>
                  </TD>
                  <TD>{c.activeMembers}</TD>
                  <TD>{c.billingMode}</TD>
                  <TD>{c.createdAt.toISOString().slice(0, 10)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Active support grants</CardTitle>
        </CardHeader>
        <CardContent>
          {grants.length === 0 ? (
            <EmptyState title="No active grants" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Company</TH>
                  <TH>Scopes</TH>
                  <TH>Reason</TH>
                  <TH>Expires</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {grants.map((g) => (
                  <TR key={g.id}>
                    <TD>{g.tenantName}</TD>
                    <TD className="text-xs">{g.scopes.join(', ')}</TD>
                    <TD className="max-w-xs text-sm">{g.reason}</TD>
                    <TD>{g.expiresAt.toUTCString()}</TD>
                    <TD>
                      {g.platformUserId === actor.userId ? (
                        <RevokeGrantButton grantId={g.id} />
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent platform actions</CardTitle>
        </CardHeader>
        <CardContent>
          {audit.length === 0 ? (
            <EmptyState title="No platform actions yet" />
          ) : (
            <ul className="grid gap-2 text-sm">
              {audit.map((a) => (
                <li key={a.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    <code className="text-xs">{a.action}</code>
                    {a.reason ? ` · ${a.reason}` : ''}
                  </span>
                  <time dateTime={a.occurredAt.toISOString()} className="text-muted-foreground">
                    {a.occurredAt.toUTCString()}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
