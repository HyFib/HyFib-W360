'use client';
import { useState } from 'react';
import type { AlertChannelFormat, AlertChannelKind } from '@w360/domain';
import { Button, Checkbox, Field, Input, Label, Select } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  removeAlertChannelAction,
  sendAlertChannelTestAction,
  setAlertChannelAction,
  setAlertChannelFormatAction,
  setAlertChannelKindsAction,
} from '@/app/actions/platform';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/** Labels in quotes, as a sentence lists them: “A”, “B” and “C”. */
const quotedList = (labels: readonly string[]) => {
  const quoted = labels.map((label) => `“${label}”`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}` : quoted[0];
};

/** A format the channel can take, as the page lists it (ADR-388). */
export interface AlertFormatOption {
  format: AlertChannelFormat;
  label: string;
}

/** What each format posts, under the format's field. */
const FORMAT_DESCRIPTIONS: Record<AlertChannelFormat, string> = {
  text: 'A JSON POST with a “text” member, as Slack’s incoming webhooks take (https://hooks.slack.com/services/…).',
  teams_card:
    'An Adaptive Card, one line of the alert a block, for a Microsoft Teams webhook made with the Workflows app (the template “Send webhook alerts to a channel”, or a flow starting “When a Teams webhook request is received” that posts the card).',
};

/** The format's choice, a select of the formats listed and a description of the one chosen. */
function FormatField({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: readonly AlertFormatOption[];
  value: AlertChannelFormat;
  onChange: (format: AlertChannelFormat) => void;
}) {
  return (
    <Field id={id} label={label} description={FORMAT_DESCRIPTIONS[value]}>
      {(aria) => (
        <Select
          {...aria}
          value={value}
          onChange={(e) => {
            const chosen = options.find((o) => o.format === e.target.value);
            if (chosen) onChange(chosen.format);
          }}
        >
          {options.map((option) => (
            <option key={option.format} value={option.format}>
              {option.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/**
 * Setting, testing and removing the chat channel the operations alerts are posted to (platform
 * owners, ADR-338), with its format (ADR-388). The address is sent once and never shown back: the
 * page names its host only. A new address keeps the alerts the channel gets (ADR-340), so the form
 * names the platform owners' alerts among them, which would reach the new address's readers too.
 */
export function AlertChannelForms({
  host,
  format,
  formats,
  ownersAlerts,
}: {
  host: string | null;
  /** The channel's format, which a replacement starts from; null when no channel is set. */
  format: AlertChannelFormat | null;
  formats: readonly AlertFormatOption[];
  /** The labels of the platform owners' alerts the channel gets. */
  ownersAlerts: readonly string[];
}) {
  const [url, setUrl] = useState('');
  // Null follows the channel's format as the page gives it, which may change on another form.
  const [pickedFormat, setPickedFormat] = useState<AlertChannelFormat | null>(null);
  const chosenFormat = pickedFormat ?? format ?? 'text';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const begin = () => {
    setBusy(true);
    setError(null);
    setDone(null);
  };
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    begin();
    const result = await setAlertChannelAction({ url, format: chosenFormat });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setUrl('');
    setPickedFormat(null);
    const label = formats.find((o) => o.format === result.data.format)?.label ?? result.data.format;
    setDone(
      `Alerts are posted to ${result.data.host} from now on, as ${label}. Send a test post to check it.`,
    );
  }
  async function test() {
    begin();
    const result = await sendAlertChannelTestAction();
    setBusy(false);
    if (!result.ok) setError(result.message);
    else
      setDone(
        result.data.woken
          ? 'Test post queued: the worker sends it within seconds. Reload to see its outcome.'
          : 'Test post queued: the worker sends it within a minute. Reload to see its outcome.',
      );
  }
  async function remove() {
    begin();
    const result = await removeAlertChannelAction();
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setDone('Chat channel removed: alerts are emailed only.');
  }
  return (
    <div className="grid gap-4">
      <FormError message={error} />
      <FormSuccess message={done} />
      <ClientForm onSubmit={submit} className="grid max-w-xl gap-3">
        <Field
          id="alert-channel-url"
          label={host ? 'Replace the channel’s address' : 'The channel’s incoming webhook address'}
          description={`An https:// incoming webhook address that takes the format below. It holds the channel’s secret: it is stored encrypted and never shown again.${
            host && ownersAlerts.length > 0
              ? ` A new address gets the alerts posted now, among them the platform owners’ ${quotedList(ownersAlerts)}: untick ${ownersAlerts.length === 1 ? 'it first if its readers should not see it' : 'them first if its readers should not see them'}.`
              : ''
          }`}
        >
          {(aria) => (
            <Input
              {...aria}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              maxLength={2048}
              required
            />
          )}
        </Field>
        <FormatField
          id="alert-channel-new-format"
          label={host ? 'Format of the new address' : 'Format'}
          options={formats}
          value={chosenFormat}
          onChange={setPickedFormat}
        />
        <div>
          <Button type="submit" disabled={busy || !url.trim()}>
            {busy ? 'Saving…' : host ? 'Replace the channel' : 'Set the channel'}
          </Button>
        </div>
      </ClientForm>
      {host ? (
        <div className="flex flex-wrap gap-2">
          <ClientButton variant="outline" disabled={busy} onClick={() => void test()}>
            Send a test post
          </ClientButton>
          <ConfirmDialog
            title="Remove the chat channel?"
            description={`Alerts are no longer posted to ${host}; they are still emailed as before, the operations alerts to every platform administrator and the platform owners’ alerts to platform owners. Posts waiting fail as having no channel.`}
            confirmLabel="Remove"
            destructive
            onConfirm={() => void remove()}
            trigger={
              <ClientButton variant="outline" disabled={busy}>
                Remove the channel
              </ClientButton>
            }
          />
        </div>
      ) : null}
    </div>
  );
}

/** An alert the channel can get, as the page lists it. */
export interface AlertKindOption {
  kind: AlertChannelKind;
  label: string;
  /** One of the platform owners' alerts (financial ones and refund requests), emailed to them alone. */
  financial: boolean;
}

/**
 * Choosing the alerts the chat channel gets (platform owners, ADR-340): at least one, saved
 * together. The page gives the options in its order, the financial ones marked.
 */
export function AlertChannelKindsForm({
  options,
  kinds,
}: {
  options: readonly AlertKindOption[];
  kinds: readonly AlertChannelKind[];
}) {
  const [chosen, setChosen] = useState<AlertChannelKind[]>([...kinds]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const unchanged = chosen.length === kinds.length && chosen.every((k) => kinds.includes(k));
  const toggle = (kind: AlertChannelKind, on: boolean) =>
    setChosen(options.map((o) => o.kind).filter((k) => (k === kind ? on : chosen.includes(k))));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await setAlertChannelKindsAction({ kinds: chosen });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setDone(
      'Saved: the alerts ticked are posted from now on, and posts waiting of the others are not sent.',
    );
  }
  return (
    <ClientForm onSubmit={submit} className="grid max-w-xl gap-3">
      <FormError message={error} />
      <FormSuccess message={done} />
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Alerts posted</legend>
        {options.map((option) => (
          <div key={option.kind} className="flex items-center gap-2">
            <Checkbox
              id={`alert-kind-${option.kind}`}
              checked={chosen.includes(option.kind)}
              onChange={(e) => toggle(option.kind, e.target.checked)}
            />
            <Label htmlFor={`alert-kind-${option.kind}`} className="font-normal">
              {option.label}
              {option.financial ? ' (platform owners’ alert)' : null}
            </Label>
          </div>
        ))}
      </fieldset>
      <p className="text-sm text-muted-foreground">
        Platform owners’ alerts are emailed to platform owners only. Posted, they reach whoever
        reads the channel, with days and counts only: never a company, an amount, a payment id, a
        refund’s reason or a failed check’s error.
      </p>
      <div>
        <Button type="submit" disabled={busy || chosen.length === 0 || unchanged}>
          {busy ? 'Saving…' : 'Save the alerts posted'}
        </Button>
      </div>
    </ClientForm>
  );
}

/**
 * Changing the chat channel's format alone (platform owners, ADR-388): the address stays as it is
 * and is not asked for, and the posts waiting are sent in the format saved.
 */
export function AlertChannelFormatForm({
  options,
  format,
}: {
  options: readonly AlertFormatOption[];
  format: AlertChannelFormat;
}) {
  // Null follows the channel's format as the page gives it.
  const [picked, setPicked] = useState<AlertChannelFormat | null>(null);
  const chosen = picked ?? format;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await setAlertChannelFormatAction({ format: chosen });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPicked(null);
    setDone(
      'Saved: posts, those waiting among them, are sent in this format from now on. Send a test post to check it.',
    );
  }
  return (
    <ClientForm onSubmit={submit} className="grid max-w-xl gap-3">
      <FormError message={error} />
      <FormSuccess message={done} />
      <FormatField
        id="alert-channel-format"
        label="Format posted"
        options={options}
        value={chosen}
        onChange={setPicked}
      />
      <div>
        <Button type="submit" disabled={busy || chosen === format}>
          {busy ? 'Saving…' : 'Save the format'}
        </Button>
      </div>
    </ClientForm>
  );
}
