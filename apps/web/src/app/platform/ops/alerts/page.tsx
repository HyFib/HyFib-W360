import type { Metadata } from 'next';
import {
  ALERT_POST_ATTEMPTS,
  ALERT_POST_KIND_LABELS,
  alertPostFailureLabel,
  type AlertPostView,
} from '@w360/domain';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { AlertChannelForms } from '@/components/platform/alert-channel-forms';
import { Utc } from '@/components/platform/ops';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Alerts · Operations' };
export const dynamic = 'force-dynamic';

function PostState({ post }: { post: AlertPostView }) {
  if (post.sentAt) return <Badge tone="success">Sent</Badge>;
  if (post.failedAt) return <Badge tone="danger">Failed</Badge>;
  return <Badge tone="neutral">Waiting</Badge>;
}

export default async function OpsAlertsPage() {
  const actor = await requirePlatformActor();
  const { alertChannel } = await getRuntime();
  const { channel, posts } = await alertChannel.state(actor);
  const owner = actor.role === 'platform_owner';
  const lastFailure = channel ? alertPostFailureLabel(channel.lastError, channel.lastStatus) : null;
  // The last post failed after the last one sent (or none was sent yet).
  const lastFailedAt = channel?.lastFailedAt ?? null;
  const lastSentAt = channel?.lastSentAt ?? null;
  const failingNow = lastFailedAt !== null && (lastSentAt === null || lastFailedAt > lastSentAt);
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Chat channel</CardTitle>
          <CardDescription>
            The operations alerts (failures, late queues and failing integrations) are emailed to
            every platform administrator, at most every 15 minutes each. With a chat channel set,
            each is also posted to it with the same counts-only text: an incoming webhook address
            that takes a JSON POST with a “text” member, as Slack’s incoming webhooks do. A post is
            tried up to {ALERT_POST_ATTEMPTS} times, so the channel may show one twice.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {channel ? (
            <>
              {failingNow ? (
                <Alert tone="warning" title="The last post failed">
                  {lastFailure}. Check the address, or replace it, and send a test post.
                </Alert>
              ) : null}
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
                <dt className="text-muted-foreground">Posts to</dt>
                <dd className="break-all font-mono">{channel.host}</dd>
                <dt className="text-muted-foreground">Set</dt>
                <dd>
                  <Utc at={channel.setAt} />
                  {channel.setByName ? ` by ${channel.setByName}` : null}
                </dd>
                <dt className="text-muted-foreground">Last post sent</dt>
                <dd>
                  <Utc at={channel.lastSentAt} />
                </dd>
                <dt className="text-muted-foreground">Last post failed</dt>
                <dd>
                  <Utc at={channel.lastFailedAt} />
                  {channel.lastFailedAt && lastFailure ? ` (${lastFailure})` : null}
                </dd>
                <dt className="text-muted-foreground">Posts waiting</dt>
                <dd className="tabular-nums">{channel.postsWaiting}</dd>
                <dt className="text-muted-foreground">Posts failed (kept 7 days)</dt>
                <dd className="tabular-nums">{channel.postsFailed}</dd>
              </dl>
            </>
          ) : (
            <EmptyState title="No chat channel is set" description="The alerts are emailed only." />
          )}
          {owner ? (
            <AlertChannelForms host={channel?.host ?? null} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Only platform owners can set, test or remove the chat channel.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Latest posts</CardTitle>
          <CardDescription>
            The 10 latest posts, kept 7 days after they are sent or fail. Their kind, times and the
            channel’s last answer only: a post’s text is its alert’s.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {posts.length === 0 ? (
            <EmptyState title="Nothing was posted yet" />
          ) : (
            <Table aria-label="Latest posts">
              <THead>
                <TR>
                  <TH>Alert</TH>
                  <TH>Queued</TH>
                  <TH>State</TH>
                  <TH>Attempts</TH>
                  <TH>Last answer</TH>
                </TR>
              </THead>
              <TBody>
                {posts.map((post) => (
                  <TR key={post.id}>
                    <TD>{ALERT_POST_KIND_LABELS[post.kind]}</TD>
                    <TD>
                      <Utc at={post.createdAt} />
                    </TD>
                    <TD>
                      <PostState post={post} />
                      <div className="text-xs text-muted-foreground">
                        {post.sentAt ? (
                          <Utc at={post.sentAt} />
                        ) : post.failedAt ? (
                          <Utc at={post.failedAt} />
                        ) : (
                          <>
                            Next attempt <Utc at={post.nextAttemptAt} />
                          </>
                        )}
                      </div>
                    </TD>
                    <TD className="tabular-nums">
                      {post.attempts} of {ALERT_POST_ATTEMPTS}
                    </TD>
                    <TD>{alertPostFailureLabel(post.lastError, post.lastStatus) ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
