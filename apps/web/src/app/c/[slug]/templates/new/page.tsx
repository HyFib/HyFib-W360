import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TEMPLATE_STARTERS, can, findTemplateStarter, starterDraft } from '@w360/domain';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { PageHeader } from '@/components/page-header';
import { TemplateEditor } from '@/components/templates/template-editor';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'New template' };
export const dynamic = 'force-dynamic';

const GROUPS = [
  { category: 'UTILITY', title: 'Utility' },
  { category: 'MARKETING', title: 'Marketing' },
] as const;

export default async function NewTemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ starter?: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'templates.write')) notFound();
  const { templates, consent } = await getRuntime();
  const accounts = (await templates.syncStatus(ctx))
    .filter((a) => a.status === 'connected')
    .map((a) => ({ id: a.id, name: a.name ?? 'WhatsApp account' }));
  // A starter (ADR-232) fills the draft; an unknown one starts a blank template.
  const starter = findTemplateStarter((await searchParams).starter ?? '');
  const keywords =
    starter?.definition.category === 'MARKETING' && can(ctx, 'contacts.read')
      ? (await consent.getSettings(ctx)).marketingOptOutKeywords
      : [];
  const draft = starter ? starterDraft(starter, { marketingOptOutKeywords: keywords }) : null;
  const base = `/c/${ctx.tenant.slug}/templates/new`;
  return (
    <>
      <Link
        href={`/c/${ctx.tenant.slug}/templates`}
        className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← Templates
      </Link>
      <PageHeader
        title="New template"
        description="Save a draft, then submit it to Meta for review. Text headers, a body with numbered variables, a footer and static buttons are supported."
      />
      {accounts.length === 0 ? (
        <Alert tone="warning" title="No connected WhatsApp account">
          Connect a WhatsApp number in Settings → Channels first.
        </Alert>
      ) : (
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Start from</CardTitle>
              <CardDescription>
                HyFib’s starters, in English. Change anything before you save: Meta reviews every
                template and decides its category.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {GROUPS.map((group) => (
                <nav key={group.category} aria-label={`${group.title} starters`}>
                  <h2 className="mb-1 text-sm font-medium">{group.title}</h2>
                  <ul className="grid gap-1 text-sm">
                    {TEMPLATE_STARTERS.filter((s) => s.definition.category === group.category).map(
                      (s) => (
                        <li key={s.key}>
                          <Link
                            href={`${base}?starter=${s.key}`}
                            aria-current={starter?.key === s.key ? 'page' : undefined}
                            className="text-primary underline-offset-4 hover:underline aria-[current=page]:font-semibold"
                          >
                            {s.label}
                          </Link>
                          <span className="text-muted-foreground"> — {s.description}</span>
                        </li>
                      ),
                    )}
                  </ul>
                </nav>
              ))}
              <p className="text-sm sm:col-span-2">
                <Link
                  href={base}
                  aria-current={starter ? undefined : 'page'}
                  className="text-primary underline-offset-4 hover:underline aria-[current=page]:font-semibold"
                >
                  A blank template
                </Link>
              </p>
            </CardContent>
          </Card>
          {starter ? (
            <Alert tone="info" title={`Started from “${starter.label}”`}>
              {starter.definition.category === 'MARKETING'
                ? draft?.optOutButton
                  ? `The ${draft.optOutButton} button lets customers stop offers: their tap records a marketing opt-out, as the keyword does.`
                  : 'Give customers a way to stop offers, such as a button with one of the marketing opt-out keywords in Settings → Messaging.'
                : 'Check the wording and the example values before you submit it.'}
            </Alert>
          ) : null}
          <Card>
            <CardContent className="pt-6">
              <TemplateEditor
                key={starter?.key ?? 'blank'}
                slug={ctx.tenant.slug}
                accounts={accounts}
                {...(draft ? { initial: { name: draft.name, definition: draft.definition } } : {})}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
