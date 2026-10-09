'use client';
import { useState } from 'react';
import type { AlertChannelKind } from '@w360/domain';
import { Button, Checkbox, Field, Input, Label } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  removeAlertChannelAction,
  sendAlertChannelTestAction,
  setAlertChannelAction,
  setAlertChannelKindsAction,
} from '@/app/actions/platform';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/**
 * Setting, testing and removing the chat channel the operations alerts are posted to (platform
 * owners, ADR-338). The address is sent once and never shown back: the page names its host only.
 */
export function AlertChannelForms({ host }: { host: string | null }) {
  const [url, setUrl] = useState('');
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
    const result = await setAlertChannelAction({ url });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setUrl('');
    setDone(`Alerts are posted to ${result.data.host} from now on. Send a test post to check it.`);
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
          description="An https:// address that takes a JSON POST with a “text” member, such as a Slack incoming webhook (https://hooks.slack.com/services/…). It holds the channel’s secret: it is stored encrypted and never shown again."
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
            description={`Alerts are no longer posted to ${host}; they are still emailed to every platform administrator. Posts waiting fail as having no channel.`}
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
  /** One of the owners' financial alerts, which platform owners alone are emailed. */
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
    setDone('Saved: the alerts ticked are posted from now on.');
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
        reads the channel, with days and counts only: never a company, an amount, a payment id or a
        failed check’s error.
      </p>
      <div>
        <Button type="submit" disabled={busy || chosen.length === 0 || unchanged}>
          {busy ? 'Saving…' : 'Save the alerts posted'}
        </Button>
      </div>
    </ClientForm>
  );
}
