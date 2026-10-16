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
import { formatDayLong } from '@/lib/report-format';

export interface TeamFormValues {
  id?: string;
  name: string;
  description: string | null;
  assignment: 'manual' | 'round_robin';
  maxOpenPerMember: number | null;
  routingKeywords: string[];
  firstResponseTargetMinutes: number | null;
  /** The team's own week as seven days of text (ADR-389); null uses the company's hours. */
  businessHours: string[] | null;
  /** The team's own closed days, YYYY-MM-DD (ADR-392); null uses the company's closed days. */
  closedDays: string[] | null;
  memberIds: string[];
  channelIds: string[];
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const CLOSED_WEEK = ['', '', '', '', '', '', ''];

/** Creates or edits a team: members, numbers that start conversations in it, and routing. */
export function TeamForm({
  slug,
  team,
  members,
  channels,
  companyHours,
}: {
  slug: string;
  team?: TeamFormValues;
  members: { membershipId: string; name: string }[];
  channels: { id: string; label: string }[];
  /**
   * The company's business hours: whether they are on, and its time zone (ADR-389), and its closed
   * days (YYYY-MM-DD), from which a team's own list starts (ADR-392).
   */
  companyHours: { on: boolean; timeZone: string; closedDays: string[] };
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
  const [ownHours, setOwnHours] = useState((team?.businessHours ?? null) !== null);
  const [hours, setHours] = useState<string[]>(team?.businessHours ?? CLOSED_WEEK);
  const [ownClosedDays, setOwnClosedDays] = useState((team?.closedDays ?? null) !== null);
  // A team's own list starts from the company's closed days: remove the days the team works.
  const [closedDays, setClosedDays] = useState<string[]>(
    team?.closedDays ?? companyHours.closedDays,
  );
  const [newClosedDay, setNewClosedDay] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>(team?.memberIds ?? []);
  const [channelIds, setChannelIds] = useState<string[]>(team?.channelIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
  const addClosedDay = () => {
    if (!newClosedDay) return;
    setClosedDays((list) => [...new Set([...list, newClosedDay])].sort());
    setNewClosedDay('');
  };

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
          businessHours: ownHours ? hours : null,
          closedDays: ownClosedDays ? closedDays : null,
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
              setOwnHours(false);
              setHours(CLOSED_WEEK);
              setOwnClosedDays(false);
              setClosedDays(companyHours.closedDays);
              setNewClosedDay('');
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
          description="Customers waiting in the team’s conversations are due a reply within it, in business hours when they are on (the team’s own, else the company’s). Empty uses the company’s target (Settings → Inbox)."
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
        <legend className="text-sm font-medium">Business hours</legend>
        <p className="text-sm text-muted-foreground">
          The hours in which the team’s reply target and the automatic reply’s delay count. A team’s
          own hours apply only while business hours are on in Settings → Inbox; the time zone (
          {companyHours.timeZone}) stays the company’s.
          {companyHours.on
            ? ''
            : ' Business hours are off now, so every conversation counts absolute time.'}
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`${prefix}-hours`}
            className="mt-1"
            checked={!ownHours}
            onChange={() => setOwnHours(false)}
          />
          <span>Use the company’s business hours</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`${prefix}-hours`}
            className="mt-1"
            checked={ownHours}
            onChange={() => setOwnHours(true)}
          />
          <span>Its own weekly schedule</span>
        </label>
        {ownHours ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {DAYS.map((day, i) => (
              <Field
                key={day}
                id={`${prefix}-hours-${i}`}
                label={day}
                {...(i === 0
                  ? { description: 'Ranges like 09:00-13:00, 14:00-18:00. Empty: closed.' }
                  : {})}
              >
                {(aria) => (
                  <Input
                    {...aria}
                    value={hours[i] ?? ''}
                    placeholder="Closed"
                    autoComplete="off"
                    onChange={(e) =>
                      setHours((prev) => prev.map((d, j) => (j === i ? e.target.value : d)))
                    }
                  />
                )}
              </Field>
            ))}
          </div>
        ) : null}
      </fieldset>
      <fieldset className="grid min-w-0 gap-2">
        <legend className="text-sm font-medium">Closed days</legend>
        <p className="text-sm text-muted-foreground">
          Whole days on which the team’s reply target and the automatic reply’s delay do not count,
          as days of {companyHours.timeZone}. A list of the team’s own replaces the company’s closed
          days (Settings → Inbox) for it, so the team can work on a public holiday or close on a day
          of its own. It applies while business hours are on.
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`${prefix}-closed-days`}
            className="mt-1"
            checked={!ownClosedDays}
            onChange={() => setOwnClosedDays(false)}
          />
          <span>Use the company’s closed days</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`${prefix}-closed-days`}
            className="mt-1"
            checked={ownClosedDays}
            onChange={() => setOwnClosedDays(true)}
          />
          <span>
            Its own closed days
            <span className="block text-muted-foreground">
              Starts from the company’s; remove the days the team works and add its own.
            </span>
          </span>
        </label>
        {ownClosedDays ? (
          <div className="grid min-w-0 gap-3">
            {closedDays.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No closed days: the team works on every day its week opens.
              </p>
            ) : (
              <ul
                className="flex min-w-0 flex-wrap gap-2"
                aria-label={`Closed days of ${name.trim() || 'the team'}`}
              >
                {closedDays.map((day) => (
                  <li
                    key={day}
                    className="inline-flex items-center gap-1 rounded-md border border-border py-0.5 pl-2 text-sm"
                  >
                    {formatDayLong(day)}
                    <ClientButton
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setClosedDays((list) => list.filter((d) => d !== day))}
                    >
                      Remove<span className="sr-only"> {formatDayLong(day)}</span>
                    </ClientButton>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <Field id={`${prefix}-closed-day`} label="Add a closed day">
                {(aria) => (
                  <Input
                    {...aria}
                    type="date"
                    value={newClosedDay}
                    onChange={(e) => setNewClosedDay(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter adds the day instead of saving the team.
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addClosedDay();
                      }
                    }}
                  />
                )}
              </Field>
              <ClientButton
                type="button"
                variant="outline"
                disabled={!newClosedDay}
                onClick={addClosedDay}
              >
                Add day
              </ClientButton>
            </div>
          </div>
        ) : null}
      </fieldset>
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
