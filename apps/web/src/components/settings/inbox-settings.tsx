'use client';
import { useState } from 'react';
import { Button, Checkbox, Field, Input, Textarea } from '@w360/ui';
import {
  addClosedDayAction,
  removeClosedDayAction,
  updateBusinessHoursAction,
  updateCsatSettingsAction,
} from '@/app/actions/inbox-settings';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Weekly opening hours in the company's time zone; reply timers pause outside them. */
export function BusinessHoursForm({
  slug,
  initial,
  timeZone,
  canEdit,
}: {
  slug: string;
  initial: { enabled: boolean; days: string[] };
  timeZone: string;
  canEdit: boolean;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [days, setDays] = useState(initial.days);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(false);
        void updateBusinessHoursAction(slug, { enabled, days }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else setSaved(true);
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved ? 'Business hours saved.' : null} />
      <fieldset disabled={!canEdit} className="grid gap-4">
        <label htmlFor="bh-on" className="flex items-start gap-2 text-sm">
          <Checkbox id="bh-on" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>
            Count the first-response target in business hours
            <span className="block text-muted-foreground">
              Reply timers pause while the business is closed, and reports add reply times in
              business hours. Times are in {timeZone} (Settings → General).
            </span>
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {DAYS.map((name, i) => (
            <Field
              key={name}
              id={`bh-day-${i}`}
              label={name}
              {...(i === 0
                ? { description: 'Ranges like 09:00-13:00, 14:00-18:00. Empty: closed.' }
                : {})}
            >
              {(aria) => (
                <Input
                  {...aria}
                  value={days[i] ?? ''}
                  placeholder="Closed"
                  autoComplete="off"
                  onChange={(e) =>
                    setDays((prev) => prev.map((d, j) => (j === i ? e.target.value : d)))
                  }
                />
              )}
            </Field>
          ))}
        </div>
        {canEdit ? (
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save business hours'}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only members who manage company settings can change this.
          </p>
        )}
      </fieldset>
    </ClientForm>
  );
}

/** Whole days the business is closed (public holidays and similar). */
export function ClosedDaysManager({
  slug,
  days,
  canEdit,
}: {
  slug: string;
  days: { id: string; day: string; label: string; name: string }[];
  canEdit: boolean;
}) {
  const [day, setDay] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-4">
      {days.length === 0 ? (
        <p className="text-sm text-muted-foreground">No closed days.</p>
      ) : (
        <ul className="grid gap-2" aria-label="Closed days">
          {days.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span>
                <span className="font-medium">{d.label}</span> · {d.name}
              </span>
              {canEdit ? (
                <ClientButton
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    void removeClosedDayAction(slug, d.id).then((r) => {
                      setBusy(false);
                      if (!r.ok) setError(r.message);
                    });
                  }}
                >
                  Remove<span className="sr-only"> {d.label}</span>
                </ClientButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <FormError message={error} />
      {canEdit ? (
        <ClientForm
          className="grid items-end gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            void addClosedDayAction(slug, { day, name }).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
              else {
                setDay('');
                setName('');
              }
            });
          }}
        >
          <Field id="cd-day" label="Date">
            {(aria) => (
              <Input
                {...aria}
                type="date"
                required
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            )}
          </Field>
          <Field id="cd-name" label="Name">
            {(aria) => (
              <Input
                {...aria}
                required
                maxLength={80}
                value={name}
                placeholder="For example Diwali"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <div>
            <Button type="submit" variant="outline" disabled={busy || !day || !name.trim()}>
              Add closed day
            </Button>
          </div>
        </ClientForm>
      ) : null}
    </div>
  );
}

/** The rating question sent with three reply buttons after a member resolves a conversation. */
export function CsatSettingsForm({
  slug,
  initial,
  canEdit,
}: {
  slug: string;
  initial: { enabled: boolean; question: string; labels: [string, string, string] };
  canEdit: boolean;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [question, setQuestion] = useState(initial.question);
  const [labels, setLabels] = useState<string[]>([...initial.labels]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const ratings = ['Best rating', 'Middle rating', 'Worst rating'];
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(false);
        void updateCsatSettingsAction(slug, { enabled, question, labels }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else setSaved(true);
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved ? 'CSAT settings saved.' : null} />
      <fieldset disabled={!canEdit} className="grid gap-4">
        <label htmlFor="csat-on" className="flex items-start gap-2 text-sm">
          <Checkbox id="csat-on" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>
            Ask customers to rate the help they received
            <span className="block text-muted-foreground">
              Sent as a WhatsApp message with three buttons when a member resolves a conversation,
              only inside the 24-hour customer service window, at most once a day per conversation,
              and never to customers who opted out.
            </span>
          </span>
        </label>
        <Field id="csat-question" label="Question" description="Up to 1024 characters.">
          {(aria) => (
            <Textarea
              {...aria}
              rows={2}
              maxLength={1024}
              required
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          {ratings.map((label, i) => (
            <Field
              key={label}
              id={`csat-label-${i}`}
              label={label}
              description="Up to 20 characters."
            >
              {(aria) => (
                <Input
                  {...aria}
                  maxLength={20}
                  required
                  value={labels[i] ?? ''}
                  onChange={(e) =>
                    setLabels((prev) => prev.map((l, j) => (j === i ? e.target.value : l)))
                  }
                />
              )}
            </Field>
          ))}
        </div>
        {canEdit ? (
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save CSAT settings'}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only members who manage company settings can change this.
          </p>
        )}
      </fieldset>
    </ClientForm>
  );
}
