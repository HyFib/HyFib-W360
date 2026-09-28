'use client';
import { useState } from 'react';
import { Button, Checkbox, Field, Input, Textarea } from '@w360/ui';
import {
  HTTP_WAIT_MINUTES,
  RUN_BUDGETS,
  advance,
  httpHeaderText,
  initialRunState,
  type AutomationGraph,
  type OrderPlaceholderValues,
  type RunEffect,
  type RunEvent,
  type RunFacts,
  type RunState,
} from '@w360/domain/automation-model';
import { ClientButton, ClientForm } from '@/components/client-form';
import type { EditorTemplate } from './node-fields';

/**
 * Tries the current (unsaved) steps in the browser with the interpreter the worker uses. Nothing
 * is sent or stored; facts about the contact and the business are set here, and an automation
 * started by order messages reads a sample order. It does not check the 24-hour window, the
 * WhatsApp number, the template's approval, consent or the hand-off lock: test runs do.
 */
const SIMULATION_RUN = '00000000-0000-4000-8000-000000000000';

/** The order a simulated run started by order messages reads. */
const sampleOrder = (customer: string, store: string): OrderPlaceholderValues => ({
  number: '#1001',
  customer_name: customer || null,
  total: '₹1,499.00',
  items: 'Darjeeling tea and 2 more',
  status_url: 'https://shop.example/orders/1001',
  tracking_number: 'AWB123456789',
  carrier: 'Delhivery',
  tracking_url: 'https://shop.example/track/AWB123456789',
  store,
});

/** A template's text with its {{n}} markers filled in. */
const fill = (text: string, values: readonly string[]) =>
  text.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, n: string) => values[Number(n) - 1] ?? whole);

type Entry =
  | { who: 'bot'; text: string }
  | {
      who: 'buttons';
      header: string | null;
      body: string;
      footer: string | null;
      buttons: { id: string; title: string }[];
    }
  | {
      who: 'template';
      name: string;
      header: string | null;
      body: string;
      footer: string | null;
      /** Tappable quick replies (an asking step), or the template's buttons shown as they are. */
      buttons: { id: string; title: string }[];
      staticButtons: string[];
    }
  | { who: 'customer'; text: string }
  | { who: 'note'; text: string }
  | { who: 'request'; method: string; url: string; headers: string[]; body: string | null };

type Status = 'idle' | 'waiting_reply' | 'waiting_timer' | 'waiting_http' | 'ended';

const END_TEXT: Record<string, string> = {
  end_node: 'The automation ended (End step).',
  no_next: 'The automation ended (nothing after that step).',
  budget_steps: 'The run failed: it reached the step limit.',
  budget_loop: 'The run failed: a step repeated too often.',
  budget_messages: 'The run failed: it reached the message limit.',
  budget_http: 'The run failed: it reached the web request limit.',
  error: 'The run could not continue.',
};

interface SimFacts {
  contactName: string;
  tags: string;
  fields: string;
  businessOpen: boolean;
}

function toFacts(sim: SimFacts, companyName: string, storeEvent: boolean): RunFacts {
  const fields: Record<string, string> = {};
  for (const line of sim.fields.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    contactName: sim.contactName.trim() || null,
    companyName,
    tags: new Set(
      sim.tags
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
    fields,
    businessOpen: sim.businessOpen,
    order: storeEvent ? sampleOrder(sim.contactName.trim(), companyName) : null,
  };
}

export function AutomationSimulator({
  graph,
  companyName,
  teams,
  templates,
  storeEvent,
}: {
  /** Null when the steps have structural errors. */
  graph: AutomationGraph | null;
  companyName: string;
  teams: { id: string; name: string }[];
  templates: EditorTemplate[];
  /** Started by order messages: the run reads a sample order. */
  storeEvent: boolean;
}) {
  const [sim, setSim] = useState<SimFacts>({
    contactName: 'Asha',
    tags: '',
    fields: '',
    businessOpen: true,
  });
  const [state, setState] = useState<RunState | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState('');
  const [httpValues, setHttpValues] = useState<Record<string, string>>({});

  if (!graph) {
    return (
      <p className="text-sm text-muted-foreground">
        Fix the errors in the steps to try the automation here.
      </p>
    );
  }

  const currentNode = state ? graph.nodes.find((n) => n.id === state.nodeId) : undefined;
  const httpNode = currentNode?.type === 'http_request' ? currentNode : null;

  const process = (from: RunState, first: RunEvent, lead: Entry[]) => {
    let current = from;
    let event = first;
    let facts = { ...sim };
    const out: Entry[] = [...lead];
    const apply = (effect: RunEffect) => {
      switch (effect.kind) {
        case 'send_text':
          out.push({ who: 'bot', text: effect.text });
          break;
        case 'send_buttons':
          out.push({
            who: 'buttons',
            header: effect.header,
            body: effect.body,
            footer: effect.footer,
            buttons: effect.buttons,
          });
          break;
        case 'send_template': {
          const template = templates.find((t) => t.id === effect.templateId);
          const preview = template?.preview;
          out.push({
            who: 'template',
            name: template?.name ?? 'Template',
            header: preview?.header ? fill(preview.header, effect.header) : null,
            body: preview ? fill(preview.body, effect.body) : effect.body.join(' · '),
            footer: preview?.footer ?? null,
            buttons: effect.buttons.map((b) => ({ id: b.payload, title: b.title })),
            staticButtons: effect.ask ? [] : (template?.quickReplies.map((q) => q.title) ?? []),
          });
          break;
        }
        case 'add_tag':
          facts = { ...facts, tags: [facts.tags, effect.tag].filter(Boolean).join(', ') };
          out.push({ who: 'note', text: `Tag “${effect.tag}” added to the contact.` });
          break;
        case 'remove_tag':
          facts = {
            ...facts,
            tags: facts.tags
              .split(',')
              .map((t) => t.trim())
              .filter((t) => t && t.toLowerCase() !== effect.tag)
              .join(', '),
          };
          out.push({ who: 'note', text: `Tag “${effect.tag}” removed from the contact.` });
          break;
        case 'set_field':
          facts = { ...facts, fields: `${facts.fields}\n${effect.field}=${effect.value}`.trim() };
          out.push({
            who: 'note',
            text: `Contact field ${effect.field} set to “${effect.value}”.`,
          });
          break;
        case 'http_request':
          out.push({
            who: 'request',
            method: effect.method,
            url: effect.url,
            headers: effect.headers.map((h) => `${h.name}: ${httpHeaderText(h.parts)}`),
            body: effect.body,
          });
          break;
        case 'handoff': {
          const team = teams.find((t) => t.id === effect.teamId);
          out.push({
            who: 'note',
            text: team
              ? `Handed to the ${team.name} team.`
              : 'Handed to people (routed like a new conversation).',
          });
          break;
        }
      }
    };
    let next: Status = status;
    for (let i = 0; i < RUN_BUDGETS.maxSteps + 5; i += 1) {
      const result = advance({
        graph,
        state: current,
        event,
        facts: toFacts(facts, companyName, storeEvent),
        runId: SIMULATION_RUN,
        now: new Date(),
      });
      if (result.noop) {
        out.push({
          who: 'note',
          text: 'The automation is not waiting for a reply; nothing happens.',
        });
        break;
      }
      current = result.state;
      result.effects.forEach(apply);
      if (result.status === 'running') {
        event = { kind: 'continue' };
        continue;
      }
      if (result.status === 'waiting') {
        const waitingNode = graph.nodes.find((n) => n.id === current.nodeId);
        const minutes =
          waitingNode?.type === 'wait'
            ? waitingNode.minutes
            : waitingNode?.type === 'ask_buttons' ||
                waitingNode?.type === 'ask_text' ||
                waitingNode?.type === 'ask_template'
              ? waitingNode.timeoutMinutes
              : 0;
        next =
          current.waiting?.for === 'timer'
            ? 'waiting_timer'
            : current.waiting?.for === 'http'
              ? 'waiting_http'
              : 'waiting_reply';
        out.push({
          who: 'note',
          text:
            next === 'waiting_timer'
              ? `Waiting ${minutes} minutes before continuing.`
              : next === 'waiting_http'
                ? `Nothing is sent here. Choose the result below (a real run waits up to ${HTTP_WAIT_MINUTES} minutes).`
                : `Waiting up to ${minutes} minutes for a reply.`,
        });
        if (next === 'waiting_http') setHttpValues({});
        break;
      }
      next = 'ended';
      // A hand-off already has its note (which team) from the effect above.
      if (result.endReason !== 'handoff_node') {
        out.push({
          who: 'note',
          text: END_TEXT[result.endReason ?? 'error'] ?? 'The automation ended.',
        });
      }
      break;
    }
    setSim(facts);
    setState(current);
    setStatus(next);
    setEntries((list) => [...list, ...out]);
  };

  const start = () => {
    setEntries([]);
    setStatus('idle');
    const first = initialRunState(graph);
    process(first, { kind: 'continue' }, [{ who: 'note', text: 'Started.' }]);
  };

  const reply = (textValue: string, buttonId: string | null) => {
    const lead: Entry[] = [{ who: 'customer', text: textValue }];
    if (!state || status !== 'waiting_reply') {
      setEntries((list) => [
        ...list,
        ...lead,
        {
          who: 'note',
          text:
            status === 'ended' || status === 'idle'
              ? 'No run is active. Start again to try from the first step.'
              : status === 'waiting_http'
                ? 'The automation is waiting for a web request; the message is kept in the inbox but not used.'
                : 'The automation is waiting on a timer; the message is kept in the inbox but not used.',
        },
      ]);
      return;
    }
    process(
      state,
      {
        kind: 'reply',
        reply: buttonId
          ? { type: 'button', text: textValue, buttonId }
          : { type: 'text', text: textValue, buttonId: null },
      },
      lead,
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
      <div className="grid gap-3">
        <div
          className="grid max-h-96 min-h-40 content-start gap-2 overflow-y-auto rounded-md border border-border bg-muted/30 p-3"
          aria-live="polite"
        >
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Press Start to run the steps.</p>
          ) : null}
          {entries.map((entry, i) => {
            if (entry.who === 'note')
              return (
                <p key={i} className="text-center text-xs text-muted-foreground">
                  {entry.text}
                </p>
              );
            if (entry.who === 'request')
              return (
                <div
                  key={i}
                  className="grid gap-1 rounded-md border border-dashed border-border bg-background px-3 py-2 text-xs"
                >
                  <span className="font-medium">Web request (not sent in the simulator)</span>
                  <code className="break-all">
                    {entry.method} {entry.url}
                  </code>
                  {entry.headers.map((h, j) => (
                    <code key={j} className="break-all text-muted-foreground">
                      {h}
                    </code>
                  ))}
                  {entry.body ? (
                    <code className="whitespace-pre-wrap break-all text-muted-foreground">
                      {entry.body}
                    </code>
                  ) : null}
                </div>
              );
            if (entry.who === 'customer')
              return (
                <p
                  key={i}
                  className="justify-self-start rounded-md bg-background px-3 py-2 text-sm shadow-xs"
                >
                  <span className="sr-only">Customer: </span>
                  {entry.text}
                </p>
              );
            if (entry.who === 'template')
              return (
                <div
                  key={i}
                  className="grid max-w-[85%] justify-self-end gap-2 rounded-md bg-primary/10 px-3 py-2 text-sm"
                >
                  <span className="text-xs text-muted-foreground">Template {entry.name}</span>
                  {entry.header ? <strong>{entry.header}</strong> : null}
                  <span className="whitespace-pre-wrap">{entry.body}</span>
                  {entry.footer ? (
                    <span className="text-xs text-muted-foreground">{entry.footer}</span>
                  ) : null}
                  {entry.buttons.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {entry.buttons.map((b) => (
                        <ClientButton
                          key={b.id}
                          size="sm"
                          variant="outline"
                          onClick={() => reply(b.title, b.id)}
                        >
                          {b.title}
                        </ClientButton>
                      ))}
                    </div>
                  ) : null}
                  {entry.staticButtons.length > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      Buttons: {entry.staticButtons.join(', ')}
                    </span>
                  ) : null}
                </div>
              );
            if (entry.who === 'bot')
              return (
                <p
                  key={i}
                  className="max-w-[85%] justify-self-end whitespace-pre-wrap rounded-md bg-primary/10 px-3 py-2 text-sm"
                >
                  <span className="sr-only">Automation: </span>
                  {entry.text}
                </p>
              );
            return (
              <div
                key={i}
                className="grid max-w-[85%] justify-self-end gap-2 rounded-md bg-primary/10 px-3 py-2 text-sm"
              >
                <span className="sr-only">Automation asks: </span>
                {entry.header ? <strong>{entry.header}</strong> : null}
                <span className="whitespace-pre-wrap">{entry.body}</span>
                {entry.footer ? (
                  <span className="text-xs text-muted-foreground">{entry.footer}</span>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {entry.buttons.map((b) => (
                    <ClientButton
                      key={b.id}
                      size="sm"
                      variant="outline"
                      onClick={() => reply(b.title, b.id)}
                    >
                      {b.title}
                    </ClientButton>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <ClientForm
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return;
            reply(text, null);
            setText('');
          }}
        >
          <label htmlFor="simulator-reply" className="sr-only">
            Customer message
          </label>
          <Input
            id="simulator-reply"
            className="min-w-48 flex-1"
            value={text}
            placeholder="Type as the customer"
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={!text.trim()}>
            Send
          </Button>
        </ClientForm>
        {status === 'waiting_http' && state && httpNode ? (
          <fieldset className="grid gap-3 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium">Result of the web request</legend>
            {httpNode.save.map((item) => (
              <Field
                key={item.saveAs}
                id={`sim-http-${item.saveAs}`}
                label={`${item.saveAs} (from ${item.path})`}
              >
                {(aria) => (
                  <Input
                    {...aria}
                    value={httpValues[item.saveAs] ?? ''}
                    onChange={(e) =>
                      setHttpValues({ ...httpValues, [item.saveAs]: e.target.value })
                    }
                  />
                )}
              </Field>
            ))}
            <div className="flex flex-wrap gap-2">
              <ClientButton
                size="sm"
                onClick={() =>
                  process(
                    state,
                    {
                      kind: 'http_result',
                      ok: true,
                      values: Object.fromEntries(
                        Object.entries(httpValues).filter(([, v]) => v !== ''),
                      ),
                      detail: '200',
                    },
                    [{ who: 'note', text: 'The server answers 200 OK.' }],
                  )
                }
              >
                Success
              </ClientButton>
              <ClientButton
                size="sm"
                variant="outline"
                onClick={() =>
                  process(state, { kind: 'http_result', ok: false, values: {}, detail: '500' }, [
                    { who: 'note', text: 'The server answers 500.' },
                  ])
                }
              >
                Failure
              </ClientButton>
            </div>
          </fieldset>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <ClientButton onClick={start}>{status === 'idle' ? 'Start' : 'Start again'}</ClientButton>
          <ClientButton
            variant="outline"
            disabled={
              status !== 'waiting_reply' && status !== 'waiting_timer' && status !== 'waiting_http'
            }
            onClick={() =>
              state &&
              process(state, { kind: 'deadline' }, [
                {
                  who: 'note',
                  text:
                    status === 'waiting_timer'
                      ? 'Time passes…'
                      : status === 'waiting_http'
                        ? 'No result comes…'
                        : 'No reply comes…',
                },
              ])
            }
          >
            Skip the wait
          </ClientButton>
        </div>
        <p className="text-xs text-muted-foreground">
          Nothing is sent or saved. Test runs on WhatsApp also check the 24-hour window, the number
          and the contact’s consent.
        </p>
      </div>
      <fieldset className="grid content-start gap-3">
        <legend className="mb-1 text-sm font-medium">Simulated contact</legend>
        <Field id="sim-name" label="Name">
          {(aria) => (
            <Input
              {...aria}
              value={sim.contactName}
              onChange={(e) => setSim({ ...sim, contactName: e.target.value })}
            />
          )}
        </Field>
        <Field id="sim-tags" label="Tags" description="Separated by commas.">
          {(aria) => (
            <Input
              {...aria}
              value={sim.tags}
              onChange={(e) => setSim({ ...sim, tags: e.target.value })}
            />
          )}
        </Field>
        <Field id="sim-fields" label="Contact fields" description="One key=value per line.">
          {(aria) => (
            <Textarea
              {...aria}
              rows={3}
              value={sim.fields}
              onChange={(e) => setSim({ ...sim, fields: e.target.value })}
            />
          )}
        </Field>
        <label htmlFor="sim-open" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="sim-open"
            checked={sim.businessOpen}
            onChange={(e) => setSim({ ...sim, businessOpen: e.target.checked })}
          />
          Business is open
        </label>
        {storeEvent ? (
          <div className="grid gap-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Sample order</p>
            <p>
              #1001 for the contact above, ₹1,499.00, “Darjeeling tea and 2 more”, sent with
              Delhivery (AWB123456789), from {companyName}.
            </p>
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}
