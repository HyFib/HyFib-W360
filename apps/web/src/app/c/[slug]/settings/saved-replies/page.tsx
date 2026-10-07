import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { DeleteSavedReplyButton, SavedReplyForm } from '@/components/settings/saved-replies';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Saved replies' };
export const dynamic = 'force-dynamic';

export default async function SavedRepliesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const manage = can(ctx, 'inbox.supervise');
  if (!manage && !can(ctx, 'inbox.reply')) notFound();
  const { savedReplies } = await getRuntime();
  const replies = await savedReplies.listSavedReplies(ctx);
  const tz = ctx.tenant.timezone;
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Saved replies</CardTitle>
          <CardDescription>
            Answers the team uses often. In a conversation, choose one to put it in the reply box,
            with the customer’s name filled in, then review and send it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {replies.length === 0 ? (
            <p className="text-sm text-muted-foreground">No saved replies yet.</p>
          ) : (
            <ul className="grid gap-3">
              {replies.map((r) => (
                <li key={r.id} className="grid gap-2 rounded-md border border-border p-3">
                  <p className="text-sm">
                    <span className="font-medium">{r.title}</span>{' '}
                    <span className="text-muted-foreground">/{r.shortcut}</span>
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm">{r.body}</p>
                  <p className="text-xs text-muted-foreground">
                    Updated {formatDateTime(r.updatedAt, tz)}
                    {r.updatedThroughApi
                      ? ' through the API'
                      : r.updatedByName
                        ? ` by ${r.updatedByName}`
                        : ''}
                  </p>
                  {manage ? (
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">
                        Edit /{r.shortcut}
                      </summary>
                      <div className="mt-3 grid gap-3">
                        <SavedReplyForm slug={ctx.tenant.slug} reply={r} />
                        <DeleteSavedReplyButton
                          slug={ctx.tenant.slug}
                          id={r.id}
                          shortcut={r.shortcut}
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
            <CardTitle>New saved reply</CardTitle>
          </CardHeader>
          <CardContent>
            <SavedReplyForm slug={ctx.tenant.slug} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          Supervisors and administrators manage saved replies.
        </p>
      )}
    </div>
  );
}
