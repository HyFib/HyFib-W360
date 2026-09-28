import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { PlanLimitHint } from '@/components/plan-limit';
import { AvailabilityToggle, DeleteTeamButton, TeamForm } from '@/components/settings/team-editor';
import { canUseInbox } from '@/server/inbox';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Teams' };
export const dynamic = 'force-dynamic';

export default async function TeamsSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!canUseInbox(ctx)) notFound();
  const { teams, plans } = await getRuntime();
  const supervise = can(ctx, 'inbox.supervise');
  const manageOthers = can(ctx, 'inbox.assign') && can(ctx, 'members.read');
  const [list, members, channels, usage] = await Promise.all([
    teams.listTeams(ctx),
    can(ctx, 'members.read') ? teams.teamMemberOptions(ctx) : Promise.resolve([]),
    can(ctx, 'channels.read') ? teams.channelOptions(ctx) : Promise.resolve([]),
    plans.usage(ctx),
  ]);
  const channelLabel = new Map(channels.map((c) => [c.id, c.label]));
  return (
    <div className="grid grid-cols-1 gap-6">
      {supervise ? (
        <PlanLimitHint
          ctx={ctx}
          one="team"
          what="teams"
          used={usage.teams}
          limit={usage.limits.teams}
        />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>How routing works</CardTitle>
          <CardDescription>
            A new conversation starts in the team whose routing keyword appears in the customer’s
            first message, otherwise in the team of the WhatsApp number it arrived on. Round-robin
            teams then assign it to the next available member. Teams decide who receives
            conversations, not who may read them. A reopened conversation stays with its assignee.
          </CardDescription>
        </CardHeader>
        {manageOthers && members.length > 0 ? (
          <CardContent className="grid gap-3">
            <h3 className="text-sm font-medium">Who is taking conversations</h3>
            <ul className="grid gap-2">
              {members.map((m) => (
                <li key={m.membershipId}>
                  <AvailabilityToggle
                    slug={ctx.tenant.slug}
                    available={m.available}
                    membershipId={m.membershipId}
                    name={m.membershipId === ctx.membership.id ? `${m.name} (you)` : m.name}
                  />
                </li>
              ))}
            </ul>
          </CardContent>
        ) : null}
      </Card>
      {list.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No teams yet.{supervise ? ' Create the first one below.' : ''}
          </CardContent>
        </Card>
      ) : (
        list.map((team) => (
          <Card key={team.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {team.name}
                <Badge tone={team.assignment === 'round_robin' ? 'info' : 'neutral'}>
                  {team.assignment === 'round_robin' ? 'Round robin' : 'Queue'}
                </Badge>
              </CardTitle>
              <CardDescription>
                {team.description ? `${team.description} · ` : ''}
                {team.openConversations} open, {team.unassignedConversations} unassigned
                {team.maxOpenPerMember ? ` · at most ${team.maxOpenPerMember} open per member` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div className="grid gap-1">
                  <dt className="text-muted-foreground">Members</dt>
                  <dd>
                    {team.members.length === 0 ? (
                      'None'
                    ) : (
                      <ul className="grid gap-0.5">
                        {team.members.map((m) => (
                          <li key={m.membershipId}>
                            {m.name}
                            <span className="text-muted-foreground">
                              {m.available ? ' · available' : ' · paused'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
                <div className="grid gap-1">
                  <dt className="text-muted-foreground">Numbers</dt>
                  <dd>
                    {team.channelIds.length === 0
                      ? 'None'
                      : team.channelIds.map((id) => channelLabel.get(id) ?? 'Number').join(', ')}
                  </dd>
                </div>
                <div className="grid gap-1">
                  <dt className="text-muted-foreground">Routing keywords</dt>
                  <dd>{team.routingKeywords.length ? team.routingKeywords.join(', ') : 'None'}</dd>
                </div>
              </dl>
              {supervise ? (
                <details className="rounded-md border border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium">Edit {team.name}</summary>
                  <div className="mt-4 grid gap-4">
                    <TeamForm
                      slug={ctx.tenant.slug}
                      members={members}
                      channels={channels}
                      team={{
                        id: team.id,
                        name: team.name,
                        description: team.description,
                        assignment: team.assignment,
                        maxOpenPerMember: team.maxOpenPerMember,
                        routingKeywords: team.routingKeywords,
                        memberIds: team.members.map((m) => m.membershipId),
                        channelIds: team.channelIds,
                      }}
                    />
                    <DeleteTeamButton slug={ctx.tenant.slug} teamId={team.id} name={team.name} />
                  </div>
                </details>
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
      {supervise ? (
        <Card>
          <CardHeader>
            <CardTitle>New team</CardTitle>
            <CardDescription>
              Group members who handle the same kind of conversations.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TeamForm slug={ctx.tenant.slug} members={members} channels={channels} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          Supervisors and administrators manage teams.
        </p>
      )}
    </div>
  );
}
