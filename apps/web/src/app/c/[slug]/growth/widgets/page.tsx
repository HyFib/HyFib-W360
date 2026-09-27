import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { CopyField } from '@/components/growth/copy-field';
import { ChatWidgetForm, DeleteWidgetButton } from '@/components/growth/widget-forms';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Website button' };
export const dynamic = 'force-dynamic';

export default async function WidgetsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'campaigns.read')) notFound();
  const { growth, config } = await getRuntime();
  const [widgets, links] = await Promise.all([growth.listWidgets(ctx), growth.listLinks(ctx)]);
  const manage = can(ctx, 'campaigns.write');
  const base = config.APP_BASE_URL.replace(/\/$/, '');
  const linkOptions = links.map((l) => ({ id: l.id, name: l.name }));
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Website button</CardTitle>
          <CardDescription>
            A “chat with us” button for your website that opens one of your chat links. Add its
            script tag to your pages. The button sets no cookies, stores nothing in the visitor’s
            browser and loads nothing else; clicks are counted per day on the link it opens.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert tone="info" title="Sites with a Content Security Policy">
            Allow {base} in your site’s script-src so the button can load.
          </Alert>
          {widgets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No website buttons yet.</p>
          ) : (
            <ul className="grid gap-4">
              {widgets.map((w) => (
                <li key={w.id} className="grid gap-3 rounded-md border border-border p-4">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{w.label}</span>
                    <span className="text-muted-foreground">opens {w.linkName}</span>
                    {w.enabled ? (
                      <Badge tone="success">Shown</Badge>
                    ) : (
                      <Badge tone="neutral">Hidden</Badge>
                    )}
                    {w.linkArchived ? (
                      <Badge tone="warning">Link archived: the button does not appear</Badge>
                    ) : !w.channelActive ? (
                      <Badge tone="warning">Number not active: the button does not appear</Badge>
                    ) : null}
                  </p>
                  <CopyField
                    label="Script tag"
                    multiline
                    value={`<script src="${base}/widget/${w.publicId}.js" async></script>`}
                    description="Paste it before </body> on each page where the button should appear."
                  />
                  {manage ? (
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">
                        Edit “{w.label}”
                      </summary>
                      <div className="mt-3 grid gap-3">
                        <ChatWidgetForm
                          slug={ctx.tenant.slug}
                          links={
                            linkOptions.some((l) => l.id === w.linkId)
                              ? linkOptions
                              : [{ id: w.linkId, name: `${w.linkName} (archived)` }, ...linkOptions]
                          }
                          widget={w}
                        />
                        <DeleteWidgetButton
                          slug={ctx.tenant.slug}
                          id={w.id}
                          version={w.version}
                          label={w.label}
                        />
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
            <CardTitle>New website button</CardTitle>
          </CardHeader>
          <CardContent>
            <ChatWidgetForm slug={ctx.tenant.slug} links={linkOptions} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
