import type { Metadata } from 'next';
import { assertCan, can } from '@w360/domain';
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
import { LiveEvents } from '@/components/inbox/live-events';
import { ChannelActions } from '@/components/settings/channel-actions';
import { RequireOwnDocument } from '@/components/require-own-document';
import { WhatsAppAccessAlerts } from '@/components/settings/whatsapp-access-alerts';
import { WhatsAppConnect } from '@/components/settings/whatsapp-connect';
import { formatDateTime } from '@/lib/format';
import { liveEventCursor } from '@/server/inbox';
import { PlanLimitHint } from '@/components/plan-limit';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Channels' };
export const dynamic = 'force-dynamic';

const STATUS: Record<
  string,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }
> = {
  onboarding: { label: 'Setting up', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  needs_reconnect: { label: 'Reconnect needed', tone: 'warning' },
  failed: { label: 'Setup failed', tone: 'danger' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
};

const STEP: Record<string, string> = {
  subscribe_app: 'Subscribing to webhooks',
  register_number: 'Registering the number',
  health_check: 'Checking number health',
  done: 'Complete',
};

export default async function ChannelsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'channels.read');
  const { onboarding, meta, plans } = await getRuntime();
  const since = await liveEventCursor(ctx);
  const [channels, accessIssues] = onboarding
    ? await Promise.all([onboarding.listChannels(ctx), onboarding.accessIssues(ctx)])
    : [[], []];
  const usage = await plans.usage(ctx);
  const canManage = can(ctx, 'channels.manage');
  const signupReady = Boolean(meta?.embeddedSignupConfigId);

  return (
    <div className="grid gap-6">
      <RequireOwnDocument />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>WhatsApp numbers</CardTitle>
            <LiveEvents slug={ctx.tenant.slug} since={since} />
          </div>
          <CardDescription>
            Connect your own WhatsApp Business Account through Meta’s signup. Meta bills your
            account directly for WhatsApp conversations.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <WhatsAppAccessAlerts
            issues={accessIssues}
            slug={ctx.tenant.slug}
            timeZone={ctx.tenant.timezone}
            canManage={canManage}
            onChannelsPage
          />
          {canManage ? (
            <PlanLimitHint
              ctx={ctx}
              one="WhatsApp number"
              what="WhatsApp numbers"
              used={usage.numbers}
              limit={usage.limits.numbers}
            />
          ) : null}
          {!meta ? (
            <Alert tone="warning" title="Not available yet">
              WhatsApp connection is not configured on this platform. It requires the platform’s
              Meta app to complete business verification and app review.
            </Alert>
          ) : !signupReady ? (
            <Alert tone="warning" title="Signup not configured">
              The Meta Embedded Signup configuration id is missing on this platform.
            </Alert>
          ) : canManage ? (
            <WhatsAppConnect slug={ctx.tenant.slug} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Only owners and administrators can connect numbers.
            </p>
          )}
          {channels.length === 0 ? (
            <EmptyState
              title="No numbers connected"
              description="Connected numbers and their setup status appear here."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Number</TH>
                  <TH>Status</TH>
                  <TH>Quality</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {channels.map((ch) => {
                  const label = ch.displayPhoneNumber ?? `Number ${ch.phoneNumberId}`;
                  const status = STATUS[ch.status] ?? {
                    label: ch.status,
                    tone: 'neutral' as const,
                  };
                  return (
                    <TR key={ch.id}>
                      <TD>
                        <div className="font-medium">{label}</div>
                        <div className="text-xs text-muted-foreground">
                          {ch.verifiedName ?? 'Name pending'} · WABA {ch.wabaId}
                        </div>
                      </TD>
                      <TD>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {ch.status === 'onboarding' && ch.onboardingStep ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {STEP[ch.onboardingStep]}
                          </div>
                        ) : null}
                        {ch.onboardingError ? (
                          <div className="mt-1 max-w-sm text-xs text-destructive">
                            {ch.onboardingError}
                          </div>
                        ) : null}
                      </TD>
                      <TD>
                        <div className="text-sm">{ch.qualityRating ?? '—'}</div>
                        {ch.healthCheckedAt ? (
                          <div className="text-xs text-muted-foreground">
                            Checked {formatDateTime(ch.healthCheckedAt, ctx.tenant.timezone)}
                          </div>
                        ) : null}
                        {ch.accountStatus === 'connected' && ch.accessCheckedAt ? (
                          <div className="text-xs text-muted-foreground">
                            Access checked {formatDateTime(ch.accessCheckedAt, ctx.tenant.timezone)}
                          </div>
                        ) : null}
                        {ch.accountStatus === 'connected' && ch.accessExpiresAt ? (
                          <div className="text-xs text-muted-foreground">
                            Access {ch.accessExpired ? 'expired' : 'expires'}{' '}
                            {formatDateTime(ch.accessExpiresAt, ctx.tenant.timezone)}
                          </div>
                        ) : null}
                      </TD>
                      <TD className="text-right">
                        {canManage ? (
                          <ChannelActions
                            slug={ctx.tenant.slug}
                            channelAccountId={ch.id}
                            status={ch.status}
                            label={label}
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
