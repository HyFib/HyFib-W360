'use client';
import { useId, useState } from 'react';
import { Button, Field, Input, Select, Textarea } from '@w360/ui';
import { sendFlowAction } from '@/app/actions/flows';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

function clientKey() {
  return `flow-${crypto.randomUUID()}`;
}

/** Sends a WhatsApp Flow (a form) in the conversation while the customer service window is open. */
export function FlowSender({
  slug,
  conversationId,
  flows,
}: {
  slug: string;
  conversationId: string;
  flows: { id: string; name: string; mode: 'published' | 'draft' }[];
}) {
  const p = useId();
  const [choice, setChoice] = useState(flows[0] ? `${flows[0].mode}:${flows[0].id}` : '');
  const [header, setHeader] = useState('');
  const [body, setBody] = useState('Please fill in this short form.');
  const [footer, setFooter] = useState('');
  const [cta, setCta] = useState('Open form');
  const [key, setKey] = useState(clientKey);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, flowId] = choice.split(':') as ['published' | 'draft', string];
  return (
    <ClientForm
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSent(null);
        void sendFlowAction(slug, {
          conversationId,
          flowId,
          mode,
          header,
          body,
          footer,
          cta,
          clientKey: key,
        }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else {
            setSent('Form sent.');
            setKey(clientKey());
          }
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={sent} />
      <Field id={`${p}-flow`} label="Form">
        {(aria) => (
          <Select {...aria} value={choice} onChange={(e) => setChoice(e.target.value)}>
            {flows.map((f) => (
              <option key={`${f.mode}:${f.id}`} value={`${f.mode}:${f.id}`}>
                {f.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id={`${p}-header`} label="Heading (optional)">
        {(aria) => (
          <Input
            {...aria}
            maxLength={60}
            value={header}
            onChange={(e) => setHeader(e.target.value)}
          />
        )}
      </Field>
      <Field id={`${p}-body`} label="Message">
        {(aria) => (
          <Textarea
            {...aria}
            rows={3}
            required
            maxLength={1024}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${p}-footer`} label="Footer (optional)">
          {(aria) => (
            <Input
              {...aria}
              maxLength={60}
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
            />
          )}
        </Field>
        <Field id={`${p}-cta`} label="Button text">
          {(aria) => (
            <Input
              {...aria}
              required
              maxLength={30}
              value={cta}
              onChange={(e) => setCta(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={busy || !flowId || !body.trim() || !cta.trim()}>
          {busy ? 'Sending…' : 'Send form'}
        </Button>
      </div>
    </ClientForm>
  );
}
