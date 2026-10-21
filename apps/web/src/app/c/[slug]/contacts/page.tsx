import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { BULK_TAG_LIMIT, can } from '@w360/domain';
import {
  Alert,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Label,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { BulkFieldForm } from '@/components/contacts/bulk-field-form';
import { BulkTagForm } from '@/components/contacts/bulk-tag-form';
import { ConsentBadge } from '@/components/contacts/consent-badge';
import { PageHeader } from '@/components/page-header';
import { formatShort } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Contacts' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

const CONSENT_FILTERS = [
  ['any', 'Any consent'],
  ['marketing_opted_in', 'Marketing: opted in'],
  ['marketing_opted_out', 'Marketing: opted out'],
  ['marketing_unknown', 'Marketing: not recorded'],
] as const;

export default async function ContactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'contacts.read')) notFound();
  const { contacts } = await getRuntime();
  const filter = {
    q: one(sp.q)?.slice(0, 100) || undefined,
    tag: one(sp.tag)?.slice(0, 40) || undefined,
    consent: CONSENT_FILTERS.some(([v]) => v === one(sp.consent)) ? one(sp.consent) : 'any',
  };
  let list: Awaited<ReturnType<typeof contacts.listContacts>>;
  let cursorError = false;
  try {
    list = await contacts.listContacts(ctx, { ...filter, cursor: one(sp.cursor) });
  } catch (error) {
    if (!isAppError(error) || error.code !== 'validation_failed') throw error;
    cursorError = true;
    list = await contacts.listContacts(ctx, filter);
  }
  const tags = await contacts.listTags(ctx);
  // Bulk tag and field edits (ADR-213, ADR-238) need the number of contacts the filters match.
  const matching =
    can(ctx, 'contacts.write') && list.items.length > 0
      ? await contacts.countContacts(ctx, filter)
      : 0;
  const fields = matching > 0 && matching <= BULK_TAG_LIMIT ? await contacts.listFields(ctx) : [];
  const base = `/c/${ctx.tenant.slug}/contacts`;
  const query = new URLSearchParams(
    Object.entries(filter).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== 'any',
    ),
  );
  const tz = ctx.tenant.timezone;

  return (
    <>
      <PageHeader
        title="Contacts"
        description="One record per phone number, with tags, custom fields and consent history."
        actions={
          <>
            {can(ctx, 'contacts.export') ? (
              <Button asChild variant="outline">
                <a href={`${base}/export?${query.toString()}`} download>
                  Export CSV
                </a>
              </Button>
            ) : null}
            {can(ctx, 'campaigns.read') ? (
              <Button asChild variant="outline">
                <Link href={`${base}/segments`}>Segments</Link>
              </Button>
            ) : null}
            {can(ctx, 'contacts.import') ? (
              <Button asChild variant="outline">
                <Link href={`${base}/import`}>Import</Link>
              </Button>
            ) : null}
            {can(ctx, 'contacts.write') ? (
              <Button asChild>
                <Link href={`${base}/new`}>Add contact</Link>
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid grid-cols-1 gap-4">
        <form
          method="get"
          className="flex flex-wrap items-end gap-3"
          role="search"
          aria-label="Filter contacts"
        >
          <div className="grid gap-1">
            <Label htmlFor="q">Search</Label>
            <Input
              id="q"
              name="q"
              defaultValue={filter.q ?? ''}
              placeholder="Name, email or number"
              className="w-64"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="tag">Tag</Label>
            <Select id="tag" name="tag" defaultValue={filter.tag ?? ''} className="w-44">
              <option value="">Any tag</option>
              {tags.map((t) => (
                <option key={t.tag} value={t.tag}>
                  {t.tag} ({t.count})
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="consent">Consent</Label>
            <Select id="consent" name="consent" defaultValue={filter.consent} className="w-56">
              {CONSENT_FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="outline">
            Apply
          </Button>
          {query.size > 0 ? (
            <Link href={base} className="text-sm text-primary underline-offset-4 hover:underline">
              Clear filters
            </Link>
          ) : null}
        </form>
        {cursorError ? (
          <Alert tone="warning">That page link has expired; showing the first page.</Alert>
        ) : null}
        {matching > BULK_TAG_LIMIT ? (
          <p className="text-sm text-muted-foreground">
            More than {BULK_TAG_LIMIT.toLocaleString('en-IN')} contacts match these filters. Narrow
            them to change a tag or a custom field on all of them at once.
          </p>
        ) : matching > 0 ? (
          <div className="grid gap-3">
            <BulkTagForm slug={ctx.tenant.slug} filter={filter} count={matching} />
            {fields.length > 0 ? (
              <BulkFieldForm
                slug={ctx.tenant.slug}
                filter={filter}
                count={matching}
                fields={fields}
              />
            ) : null}
          </div>
        ) : null}
        {can(ctx, 'automations.publish') && list.items.length > 0 ? (
          <Link
            href={`/c/${ctx.tenant.slug}/automations/enroll?${new URLSearchParams([
              ...query,
              ['source', 'contacts'],
            ]).toString()}`}
            className="justify-self-start text-sm text-primary underline-offset-4 hover:underline"
          >
            Enrol the contacts these filters match in an automation
          </Link>
        ) : null}
        {list.items.length === 0 ? (
          <EmptyState
            title={query.size > 0 ? 'No contacts match these filters' : 'No contacts yet'}
            description="Contacts appear when customers message your WhatsApp number, when you add them, or when you import a CSV file."
          />
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Phone</TH>
                    <TH>Tags</TH>
                    <TH>Consent</TH>
                    <TH>Added</TH>
                  </TR>
                </THead>
                <TBody>
                  {list.items.map((c) => (
                    <TR key={c.id}>
                      <TD className="font-medium">
                        <Link
                          href={`${base}/${c.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {c.displayName ?? c.phoneE164 ?? 'Unnamed contact'}
                        </Link>
                      </TD>
                      <TD className="tabular-nums">{c.phoneE164 ?? '—'}</TD>
                      <TD className="text-sm text-muted-foreground">{c.tags.join(', ') || '—'}</TD>
                      <TD>
                        <ConsentBadge purpose="marketing" status={c.marketing} />
                      </TD>
                      <TD className="text-sm text-muted-foreground">
                        {formatShort(c.createdAt.toISOString(), tz)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        )}
        {list.nextCursor ? (
          <Link
            href={`${base}?${new URLSearchParams([...query, ['cursor', list.nextCursor]]).toString()}`}
            className="justify-self-start text-sm text-primary underline-offset-4 hover:underline"
          >
            Next page →
          </Link>
        ) : null}
      </div>
    </>
  );
}
