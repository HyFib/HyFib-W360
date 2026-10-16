'use client';
import { useId, useState } from 'react';
import { Button, Checkbox, Field, Input, Textarea } from '@w360/ui';
import {
  createTeamAction,
  deleteTeamAction,
  setAvailabilityAction,
  updateTeamAction,
} from '@/app/actions/inbox-settings';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

export interface TeamFormValues {
  id?: string;
  name: string;
  description: string | null;
  assignment: 'manual' | 'round_robin';
  maxOpenPerMember: number | null;
  routingKeywords: string[];
  firstResponseTargetMinutes: number | null;
  memberIds: string[];
  channelIds: string[];
}

/** Creates or edits a team: members, numbers that start conversations in it, and routing. */
export function TeamForm({
  slug,
  team,
  members,
  channels,
}: {
  slug: string;
  team?: TeamFormValues;
  members: { membershipId: string; name: string }[];
  channels: { id: string; label: string }[];
}) {
  const prefix = useId();
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [assignment, setAssignment] = useState<'manual' | 'round_robin'>(
    team?.assignment ?? 'manual',
  );
  const [limit, setLimit] = useState(team?.maxOpenPerMember ? String(team.maxOpenPerMember) : '');
  const [keywords, setKeywords] = useState((team?.routingKeywords ?? []).join(', '));
  const [target, setTarget] = useState(
    team?.firstResponseTargetMinutes ? String(team.firstResponseTargetMinutes) : '',
  );
  const [memberIds, setMemberIds] = useState<string[]>(team?.memberIds ?? []);
  const [channelIds, setChannelIds] = useState<string[]>(team?.channelIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(null);
        const input = {
          name,
          description,
          assignment,
          maxOpenPerMember: limit,
          routingKeywords: keywords,
          firstResponseTargetMinutes: target,
          memberIds,
          channelIds,
        };
        const done = (routed: number) => {
          const assigned =
            routed > 0
              ? ` ${routed} waiting ${routed === 1 ? 'conversation was' : 'conversations were'} assigned.`
              : '';
          setSaved(`${team ? 'Team saved.' : 'Team created.'}${assigned}`);
        };
        if (team?.id) {
          void updateTeamAction(slug, team.id, input).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
            else done(r.data.routed);
          });
        } else {
          void createTeamAction(slug, input).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
            else {
              done(r.data.routed);
              setName('');
              setDescription('');
              setAssignment('manual');
              setLimit('');
              setKeywords('');
              setTarget('');
              setMemberIds([]);
              setChannelIds([]);
            }
          });
        }
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-name`} label="Team name">
          {(aria) => (
            <Input
              {...aria}
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field id={`${prefix}-description`} label="Description (optional)">
          {(aria) => (
            <Input
              {...aria}
              maxLength={300}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">New conversations</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`${prefix}-assignment`}
            className="mt-1"
            checked={assignment === 'manual'}
            onChange={() => setAssignment('manual')}
          />
          <span>
            Wait in the team’s queue
            <span className="block text-muted-foreground">Members claim them themselves.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`${prefix}-assignment`}
            className="mt-1"
            checked={assignment === 'round_robin'}
            onChange={() => setAssignment('round_robin')}
          />
          <span>
            Assign in turn (round robin)
            <span className="block text-muted-foreground">
              Each new conversation goes to the next member who is available, skipping members at
              their limit. With nobody available it waits in the queue.
            </span>
          </span>
        </label>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${prefix}-limit`}
          label="Open conversations per member (optional)"
          description="Round robin stops giving a member conversations at this many open ones."
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          )}
        </Field>
        <Field
          id={`${prefix}-target`}
          label="Reply target in minutes (optional)"
          description="Customers waiting in the team’s conversations are due a reply within it, in business hours when they are on. Empty uses the company’s target (Settings → Inbox)."
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              inputMode="numeric"
              min={1}
              max={1440}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          )}
        </Field>
        <Field
          id={`${prefix}-keywords`}
          label="Routing keywords (optional)"
          description="Comma-separated words. A customer’s first message containing one of them starts in this team."
        >
          {(aria) => (
            <Textarea
              {...aria}
              rows={2}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
          )}
        </Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Members</legend>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active members can answer conversations yet.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {members.map((m) => (
              <label key={m.membershipId} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={memberIds.includes(m.membershipId)}
                  onChange={(e) =>
                    setMemberIds((list) => toggle(list, m.membershipId, e.target.checked))
                  }
                />
                {m.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Numbers that start conversations here</legend>
        {channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">No WhatsApp numbers are connected.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={channelIds.includes(c.id)}
                  onChange={(e) => setChannelIds((list) => toggle(list, c.id, e.target.checked))}
                />
                {c.label}
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          A number starts conversations in one team; choosing it here moves it from another team.
        </p>
      </fieldset>
      <div>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : team ? 'Save team' : 'Create team'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function DeleteTeamButton({
  slug,
  teamId,
  name,
}: {
  slug: string;
  teamId: string;
  name: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            Delete “{name}”? Its conversations stay with their assignees but leave the team.
          </span>
          <ClientButton
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void deleteTeamAction(slug, teamId).then((r) => {
                setBusy(false);
                if (!r.ok) setError(r.message);
              });
            }}
          >
            Delete team
          </ClientButton>
          <ClientButton size="sm" variant="outline" onClick={() => setConfirming(false)}>
            Keep it
          </ClientButton>
        </div>
      ) : (
        <div>
          <ClientButton size="sm" variant="outline" onClick={() => setConfirming(true)}>
            Delete…<span className="sr-only"> team {name}</span>
          </ClientButton>
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}

/**
 * Switches whether a member takes new conversations automatically. Without `membershipId` it is
 * the current member's own switch.
 */
export function AvailabilityToggle({
  slug,
  available,
  membershipId,
  name,
}: {
  slug: string;
  available: boolean;
  membershipId?: string;
  name?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const label = name ? `${name}: ` : '';
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={
              available
                ? 'size-2 rounded-full bg-success'
                : 'size-2 rounded-full bg-muted-foreground'
            }
          />
          {label}
          {available ? 'Available for new conversations' : 'Not taking new conversations'}
        </span>
        <ClientButton
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            setNotice(null);
            void setAvailabilityAction(slug, {
              available: !available,
              ...(membershipId ? { membershipId } : {}),
            }).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
              else if (r.data.routed > 0)
                setNotice(
                  `${r.data.routed} waiting ${r.data.routed === 1 ? 'conversation was' : 'conversations were'} assigned.`,
                );
            });
          }}
        >
          {available ? 'Pause' : 'Take conversations'}
          {name ? <span className="sr-only"> for {name}</span> : null}
        </ClientButton>
      </div>
      {notice ? (
        <p className="text-xs text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}
      <FormError message={error} />
    </div>
  );
}
