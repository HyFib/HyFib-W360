'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Textarea,
} from '@w360/ui';
import {
  AUTOMATION_LIMITS,
  NODE_TYPES,
  NODE_TYPE_LABELS,
  ORDER_PLACEHOLDERS,
  TRIGGER_LABELS,
  checkGraph,
  newNodeId,
  parseGraph,
  parseTrigger,
  starterGraph,
  triggerIssues,
  type AutomationGraph,
  type AutomationNode,
  type AutomationTrigger,
  type GraphIssue,
  type NodeType,
  type TriggerHours,
  type TriggerType,
} from '@w360/domain/automation-model';
import { saveAutomationAction } from '@/app/actions/automations';
import { ClientButton, useHydrated } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import { AutomationDiagram } from './automation-diagram';
import { AutomationSimulator } from './automation-simulator';
import { NodeFields, type EditorTemplate, type NodeFieldOptions } from './node-fields';

/**
 * The automation builder: trigger, steps (a structured list with a generated diagram), live
 * checks with the same code the server runs, and an in-browser simulator. Saving stores the draft;
 * publishing (elsewhere on the page) freezes it into a version.
 */
interface TriggerForm {
  type: TriggerType;
  keywords: string;
  match: 'exact' | 'contains';
  hours: TriggerHours;
  cooldownMinutes: number;
  /** The inputs of an automation started through the API, separated by commas (ADR-077). */
  inputs: string;
}

function triggerForm(trigger: AutomationTrigger | null): TriggerForm {
  if (!trigger)
    return {
      type: 'conversation_started',
      keywords: '',
      match: 'contains',
      hours: 'any',
      cooldownMinutes: 60,
      inputs: '',
    };
  const fromMessages = trigger.type !== 'store_event' && trigger.type !== 'api';
  return {
    type: trigger.type,
    keywords: trigger.type === 'keyword' ? trigger.keywords.join(', ') : '',
    match: trigger.type === 'keyword' ? trigger.match : 'contains',
    hours: fromMessages ? trigger.hours : 'any',
    cooldownMinutes: fromMessages ? trigger.cooldownMinutes : 60,
    inputs: trigger.type === 'api' ? trigger.inputs.join(', ') : '',
  };
}

function triggerInput(form: TriggerForm): unknown {
  // Started by a store's order messages: the rule decides when (delay, sending hours).
  if (form.type === 'store_event') return { type: 'store_event' };
  // Started through the API: each call gives the inputs (ADR-077).
  if (form.type === 'api') {
    return {
      type: 'api',
      inputs: form.inputs
        .split(/[\s,]+/)
        .map((i) => i.trim())
        .filter(Boolean),
    };
  }
  const common = { hours: form.hours, cooldownMinutes: form.cooldownMinutes };
  if (form.type !== 'keyword') return { type: form.type, ...common };
  return {
    type: 'keyword',
    keywords: form.keywords
      .split(/[\n,]+/)
      .map((k) => k.trim())
      .filter(Boolean),
    match: form.match,
    ...common,
  };
}

/** Answer names the steps save: questions, and values saved from web requests. */
function savedAnswers(graph: AutomationGraph): string[] {
  return [
    ...new Set(
      graph.nodes.flatMap((n) =>
        (n.type === 'ask_text' || n.type === 'ask_buttons' || n.type === 'ask_template') && n.saveAs
          ? [n.saveAs]
          : n.type === 'http_request'
            ? n.save.map((item) => item.saveAs)
            : [],
      ),
    ),
  ];
}

function uniqueAnswerName(graph: AutomationGraph): string {
  const used = new Set(savedAnswers(graph));
  for (let i = 1; ; i += 1) if (!used.has(`answer_${i}`)) return `answer_${i}`;
}

function defaultNode(
  type: NodeType,
  graph: AutomationGraph,
  allowedDomains: readonly string[],
  template: EditorTemplate | undefined,
): AutomationNode {
  const id = newNodeId(graph, type);
  switch (type) {
    case 'send_text':
      return { id, type, label: '', text: 'Write your message.', next: null };
    case 'send_template':
    case 'ask_template': {
      const fields = {
        templateId: template?.id ?? '',
        header: Array.from({ length: template?.headerParams ?? 0 }, () => ''),
        body: Array.from({ length: template?.bodyParams ?? 0 }, () => ''),
        links: Array.from({ length: template?.links.length ?? 0 }, () => ''),
      };
      if (type === 'send_template') return { id, type, label: '', ...fields, next: null };
      return {
        id,
        type,
        label: '',
        ...fields,
        buttons: (template?.quickReplies ?? []).map((q) => ({ ...q, next: null })),
        saveAs: null,
        replyNext: null,
        timeoutMinutes: 1380,
        timeoutNext: null,
      };
    }
    case 'ask_buttons':
      return {
        id,
        type,
        label: '',
        header: null,
        body: 'Write your question.',
        footer: null,
        buttons: [
          { title: 'Yes', next: null },
          { title: 'No', next: null },
        ],
        saveAs: null,
        retryText: null,
        retries: 1,
        noMatchNext: null,
        timeoutMinutes: 60,
        timeoutNext: null,
      };
    case 'ask_text':
      return {
        id,
        type,
        label: '',
        text: 'Write your question.',
        saveAs: uniqueAnswerName(graph),
        format: 'any',
        retryText: null,
        retries: 1,
        invalidNext: null,
        timeoutMinutes: 60,
        timeoutNext: null,
        next: null,
      };
    case 'condition':
      return {
        id,
        type,
        label: '',
        match: 'all',
        rules: [{ kind: 'business_hours', op: 'open' }],
        then: null,
        else: null,
      };
    case 'update_contact':
    case 'update_conversation':
      return { id, type, label: '', action: { kind: 'add_tag', tag: 'new tag' }, next: null };
    case 'wait':
      return { id, type, label: '', minutes: 60, next: null };
    case 'http_request': {
      const host = allowedDomains.find((d) => !d.startsWith('*.'));
      return {
        id,
        type,
        label: '',
        method: 'POST',
        url: host ? `https://${host}/` : 'https://',
        headers: [],
        body: null,
        save: [],
        next: null,
        failureNext: null,
      };
    }
    case 'handoff':
      return { id, type, label: '', teamId: null };
    case 'end':
      return { id, type, label: '' };
  }
}

/** Replaces every branch of `node` that goes to `target`. */
function retarget(node: AutomationNode, target: string, value: string | null): AutomationNode {
  const t = (v: string | null) => (v === target ? value : v);
  switch (node.type) {
    case 'send_text':
    case 'send_template':
    case 'update_contact':
    case 'update_conversation':
    case 'wait':
      return { ...node, next: t(node.next) };
    case 'ask_template':
      return {
        ...node,
        buttons: node.buttons.map((b) => ({ ...b, next: t(b.next) })),
        replyNext: t(node.replyNext),
        timeoutNext: t(node.timeoutNext),
      };
    case 'ask_buttons':
      return {
        ...node,
        buttons: node.buttons.map((b) => ({ ...b, next: t(b.next) })),
        noMatchNext: t(node.noMatchNext),
        timeoutNext: t(node.timeoutNext),
      };
    case 'ask_text':
      return {
        ...node,
        next: t(node.next),
        invalidNext: t(node.invalidNext),
        timeoutNext: t(node.timeoutNext),
      };
    case 'condition':
      return { ...node, then: t(node.then), else: t(node.else) };
    case 'http_request':
      return { ...node, next: t(node.next), failureNext: t(node.failureNext) };
    default:
      return node;
  }
}

export interface EditorAutomation {
  id: string;
  name: string;
  description: string | null;
  version: number;
  trigger: AutomationTrigger | null;
  graph: AutomationGraph | null;
  channelAccountId: string | null;
}

export function AutomationEditor({
  slug,
  companyName,
  canWrite,
  automation,
  channels,
  templates,
  teams,
  fields,
  web,
}: {
  slug: string;
  companyName: string;
  canWrite: boolean;
  automation: EditorAutomation;
  channels: { id: string; name: string; active: boolean; whatsappAccountId: string }[];
  /** The company's templates (the checks need them all; steps offer the ones they can send). */
  templates: EditorTemplate[];
  teams: { id: string; name: string }[];
  fields: { key: string; label: string; type: string }[];
  /** What web request steps may use: allowed domains and secrets (names and domains only). */
  web: {
    allowedDomains: string[];
    secrets: { name: string; domain: string }[];
    allowInsecureHttp: boolean;
  };
}) {
  // Every control is in the fieldset below, which stays disabled until hydration: an edit made
  // before it would show in the field but never reach the draft (see useHydrated).
  const hydrated = useHydrated();
  const [name, setName] = useState(automation.name);
  const [description, setDescription] = useState(automation.description ?? '');
  const [channelAccountId, setChannelAccountId] = useState(automation.channelAccountId);
  const [trigger, setTrigger] = useState<TriggerForm>(() => triggerForm(automation.trigger));
  const [graph, setGraph] = useState<AutomationGraph>(automation.graph ?? starterGraph());
  const [version, setVersion] = useState(automation.version);
  const [dirty, setDirty] = useState(false);
  const [newType, setNewType] = useState<NodeType>('send_text');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const storeEvent = trigger.type === 'store_event';
  const apiStart = trigger.type === 'api';
  const channelWhatsappAccountId =
    channels.find((c) => c.id === channelAccountId)?.whatsappAccountId ?? null;
  // Templates a step can send: approved utility or marketing ones HyFib supports, of the number's
  // WhatsApp account when the automation is limited to one number.
  const usableTemplates = useMemo(
    () =>
      templates.filter(
        (t) =>
          t.status === 'approved' &&
          !t.unsupported &&
          (t.category === 'UTILITY' || t.category === 'MARKETING') &&
          (!channelWhatsappAccountId || t.whatsappAccountId === channelWhatsappAccountId),
      ),
    [templates, channelWhatsappAccountId],
  );
  const parsedTrigger = useMemo(() => parseTrigger(triggerInput(trigger)), [trigger]);
  const apiInputs = useMemo(
    () =>
      parsedTrigger.ok && parsedTrigger.trigger.type === 'api'
        ? parsedTrigger.trigger.inputs
        : null,
    [parsedTrigger],
  );
  const refs = useMemo(
    () => ({
      teamIds: new Set(teams.map((t) => t.id)),
      fieldKeys: new Set(fields.map((f) => f.key)),
      allowedDomains: web.allowedDomains,
      secrets: new Map(web.secrets.map((s) => [s.name, s.domain])),
      allowInsecureHttp: web.allowInsecureHttp,
      templates: new Map(templates.map((t) => [t.id, t])),
      storeEvent,
      apiInputs: apiInputs ? new Set(apiInputs) : undefined,
      channelWhatsappAccountId,
    }),
    [teams, fields, web, templates, storeEvent, apiInputs, channelWhatsappAccountId],
  );
  const parsedGraph = useMemo(() => parseGraph(graph), [graph]);
  const issues: GraphIssue[] = useMemo(() => {
    const list: GraphIssue[] = [];
    if (!parsedTrigger.ok)
      list.push({ level: 'error', nodeId: null, message: parsedTrigger.message });
    else list.push(...triggerIssues(parsedTrigger.trigger, channelAccountId));
    if (parsedGraph.ok) list.push(...checkGraph(parsedGraph.graph, refs));
    else list.push(...parsedGraph.issues.map((i) => ({ level: 'error' as const, ...i })));
    return list;
  }, [parsedTrigger, parsedGraph, refs, channelAccountId]);
  const errors = issues.filter((i) => i.level === 'error');
  const structural = !parsedTrigger.ok || !parsedGraph.ok || !name.trim();

  const change = (fn: () => void) => {
    fn();
    setDirty(true);
    setSaved(null);
  };
  const updateNode = (node: AutomationNode) =>
    change(() =>
      setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === node.id ? node : n)) })),
    );
  const removeNode = (id: string) =>
    change(() =>
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.filter((n) => n.id !== id).map((n) => retarget(n, id, null)),
      })),
    );
  const moveNode = (id: string, delta: -1 | 1) =>
    change(() =>
      setGraph((g) => {
        const i = g.nodes.findIndex((n) => n.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= g.nodes.length) return g;
        const nodes = [...g.nodes];
        [nodes[i], nodes[j]] = [nodes[j] as AutomationNode, nodes[i] as AutomationNode];
        return { ...g, nodes };
      }),
    );

  const stepChoices = graph.nodes.map((n) => ({
    id: n.id,
    label: n.label ? `${n.label} (${n.id})` : `${NODE_TYPE_LABELS[n.type]} (${n.id})`,
  }));
  const answers = savedAnswers(graph);
  const options: NodeFieldOptions = {
    steps: stepChoices,
    teams,
    fields,
    answers,
    allowedDomains: web.allowedDomains,
    secrets: web.secrets,
    templates: usableTemplates,
    storeEvent,
    apiInputs,
  };
  const templateStep = (t: NodeType) => t === 'send_template' || t === 'ask_template';

  const save = () => {
    setSaving(true);
    setError(null);
    setSaved(null);
    void saveAutomationAction(slug, {
      id: automation.id,
      expectedVersion: version,
      name,
      description: description || null,
      channelAccountId,
      trigger: triggerInput(trigger),
      graph,
    }).then((r) => {
      setSaving(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setVersion(r.data.version);
      setDirty(false);
      const problems = r.data.issues.filter((i) => i.level === 'error').length;
      setSaved(
        problems > 0
          ? `Draft saved. Fix ${problems} error${problems === 1 ? '' : 's'} before publishing.`
          : 'Draft saved.',
      );
    });
  };

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6">
      <fieldset disabled={!canWrite || !hydrated} className="grid min-w-0 grid-cols-1 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>When it starts</CardTitle>
            <CardDescription>
              Automations start only in conversations nobody is assigned to and no other automation
              is handling. When several match, an exact keyword wins, then a keyword in the message,
              then a new conversation, then any message. An automation started by order messages
              runs when a store’s rule chooses it for an order event, and one started through the
              API when your systems call it with a key.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="automation-name" label="Name">
                {(aria) => (
                  <Input
                    {...aria}
                    value={name}
                    maxLength={80}
                    onChange={(e) => change(() => setName(e.target.value))}
                  />
                )}
              </Field>
              <Field id="automation-channel" label="WhatsApp number">
                {(aria) => (
                  <Select
                    {...aria}
                    value={channelAccountId ?? ''}
                    onChange={(e) => change(() => setChannelAccountId(e.target.value || null))}
                  >
                    <option value="">Every number</option>
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.active ? '' : ' (not active)'}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Field id="automation-description" label="Description (optional)">
              {(aria) => (
                <Input
                  {...aria}
                  value={description}
                  maxLength={300}
                  onChange={(e) => change(() => setDescription(e.target.value))}
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="trigger-type" label="Start when">
                {(aria) => (
                  <Select
                    {...aria}
                    value={trigger.type}
                    onChange={(e) =>
                      change(() => setTrigger({ ...trigger, type: e.target.value as TriggerType }))
                    }
                  >
                    {(Object.keys(TRIGGER_LABELS) as TriggerType[]).map((t) => (
                      <option key={t} value={t}>
                        {TRIGGER_LABELS[t]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {storeEvent || apiStart ? null : (
                <Field id="trigger-hours" label="Business hours">
                  {(aria) => (
                    <Select
                      {...aria}
                      value={trigger.hours}
                      onChange={(e) =>
                        change(() =>
                          setTrigger({ ...trigger, hours: e.target.value as TriggerHours }),
                        )
                      }
                    >
                      <option value="any">At any time</option>
                      <option value="open">Only while open</option>
                      <option value="closed">Only while closed</option>
                    </Select>
                  )}
                </Field>
              )}
              {storeEvent || apiStart ? null : (
                <Field
                  id="trigger-cooldown"
                  label="Not again for (minutes)"
                  description="In the same conversation. 0: no pause."
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={AUTOMATION_LIMITS.cooldownMinutes}
                      value={
                        Number.isFinite(trigger.cooldownMinutes) ? trigger.cooldownMinutes : ''
                      }
                      onChange={(e) =>
                        change(() =>
                          setTrigger({
                            ...trigger,
                            cooldownMinutes: Number.parseInt(e.target.value, 10),
                          }),
                        )
                      }
                    />
                  )}
                </Field>
              )}
            </div>
            {storeEvent ? (
              <Alert tone="info">
                <p>
                  Choose this automation in a store’s Order messages (Stores → a store → Order
                  messages) for an order event: the store’s delay and sending hours decide when it
                  starts. WhatsApp allows only templates until the customer replies, so start with a
                  template step and continue from its reply branches.
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer font-medium">Order fields for texts</summary>
                  <ul className="mt-1 grid gap-0.5">
                    {(Object.keys(ORDER_PLACEHOLDERS) as (keyof typeof ORDER_PLACEHOLDERS)[]).map(
                      (field) => (
                        <li key={field}>
                          <code>{`{{order.${field}}}`}</code>: {ORDER_PLACEHOLDERS[field]}
                        </li>
                      ),
                    )}
                  </ul>
                </details>
              </Alert>
            ) : null}
            {apiStart ? (
              <>
                <Field
                  id="trigger-inputs"
                  label="Inputs"
                  description={`Names separated by commas, such as appointment_time, doctor (at most ${AUTOMATION_LIMITS.apiInputs}). Every start gives a text for each; steps use them as {{input.<name>}}.`}
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      value={trigger.inputs}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) =>
                        change(() => setTrigger({ ...trigger, inputs: e.target.value }))
                      }
                    />
                  )}
                </Field>
                <Alert tone="info">
                  <p>
                    Your systems start this automation for one contact at a time with an API key
                    that has the “Start automations” scope (Settings → API keys), after it is
                    published. It sends from the WhatsApp number chosen above. WhatsApp allows only
                    templates until the customer replies, so start with a template step and continue
                    from its reply branches.
                  </p>
                </Alert>
              </>
            ) : null}
            {trigger.type === 'keyword' ? (
              <div className="grid gap-4 sm:grid-cols-[1fr_260px]">
                <Field
                  id="trigger-keywords"
                  label="Keywords"
                  description="Separated by commas. Case and punctuation are ignored; words must match whole."
                >
                  {(aria) => (
                    <Textarea
                      {...aria}
                      rows={2}
                      value={trigger.keywords}
                      onChange={(e) =>
                        change(() => setTrigger({ ...trigger, keywords: e.target.value }))
                      }
                    />
                  )}
                </Field>
                <Field id="trigger-match" label="Match">
                  {(aria) => (
                    <Select
                      {...aria}
                      value={trigger.match}
                      onChange={(e) =>
                        change(() =>
                          setTrigger({ ...trigger, match: e.target.value as 'exact' | 'contains' }),
                        )
                      }
                    >
                      <option value="contains">Message contains a keyword</option>
                      <option value="exact">Message is exactly a keyword</option>
                    </Select>
                  )}
                </Field>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Steps</CardTitle>
            <CardDescription>
              Each step says what happens next. Loops must pass through a question or a wait, and
              every run is limited (200 steps, 20 visits to one step, 50 messages, 7 days).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <AutomationDiagram graph={graph} />
            {issues.length > 0 ? (
              <div className="grid gap-2" aria-live="polite">
                {errors.length > 0 ? (
                  <Alert tone="danger">
                    <p className="font-medium">
                      {errors.length} error{errors.length === 1 ? '' : 's'} to fix before publishing
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {errors.map((issue, i) => (
                        <li key={i}>
                          {issue.nodeId ? (
                            <a href={`#step-${issue.nodeId}`} className="underline">
                              {issue.nodeId}
                            </a>
                          ) : null}
                          {issue.nodeId ? ': ' : ''}
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  </Alert>
                ) : null}
                {issues.some((i) => i.level === 'warning') ? (
                  <Alert tone="warning">
                    <ul className="list-disc pl-5">
                      {issues
                        .filter((i) => i.level === 'warning')
                        .map((issue, i) => (
                          <li key={i}>
                            {issue.nodeId ? `${issue.nodeId}: ` : ''}
                            {issue.message}
                          </li>
                        ))}
                    </ul>
                  </Alert>
                ) : null}
              </div>
            ) : null}
            <Field id="graph-start" label="First step">
              {(aria) => (
                <Select
                  {...aria}
                  value={graph.start}
                  onChange={(e) => change(() => setGraph({ ...graph, start: e.target.value }))}
                >
                  {stepChoices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <ol className="grid gap-4">
              {graph.nodes.map((node, index) => {
                const nodeIssues = issues.filter((i) => i.nodeId === node.id);
                return (
                  <li key={node.id} id={`step-${node.id}`} className="scroll-mt-24">
                    <section
                      aria-labelledby={`step-${node.id}-title`}
                      className="grid gap-4 rounded-lg border border-border p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3
                          id={`step-${node.id}-title`}
                          className="flex flex-wrap items-center gap-2 font-medium"
                        >
                          <span>{node.label || NODE_TYPE_LABELS[node.type]}</span>
                          <span className="font-mono text-xs text-muted-foreground">{node.id}</span>
                          {node.label ? (
                            <Badge tone="neutral">{NODE_TYPE_LABELS[node.type]}</Badge>
                          ) : null}
                          {node.id === graph.start ? <Badge tone="info">First step</Badge> : null}
                          {nodeIssues.some((i) => i.level === 'error') ? (
                            <Badge tone="danger">Needs a fix</Badge>
                          ) : null}
                        </h3>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={index === 0}
                            onClick={() => moveNode(node.id, -1)}
                            aria-label={`Move ${node.id} up`}
                          >
                            Up
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={index === graph.nodes.length - 1}
                            onClick={() => moveNode(node.id, 1)}
                            aria-label={`Move ${node.id} down`}
                          >
                            Down
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={node.id === graph.start}
                            onClick={() => removeNode(node.id)}
                            aria-label={`Delete step ${node.id}`}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                      {nodeIssues.length > 0 ? (
                        <ul className="grid gap-1 text-sm">
                          {nodeIssues.map((issue, i) => (
                            <li
                              key={i}
                              className={
                                issue.level === 'error'
                                  ? 'text-destructive'
                                  : 'text-muted-foreground'
                              }
                            >
                              {issue.message}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <Field id={`step-${node.id}-label`} label="Step name (optional)">
                        {(aria) => (
                          <Input
                            {...aria}
                            value={node.label ?? ''}
                            maxLength={AUTOMATION_LIMITS.labelLength}
                            onChange={(e) => updateNode({ ...node, label: e.target.value })}
                          />
                        )}
                      </Field>
                      <NodeFields node={node} options={options} onChange={updateNode} />
                    </section>
                  </li>
                );
              })}
            </ol>
            {graph.nodes.length < AUTOMATION_LIMITS.nodes ? (
              <div className="flex flex-wrap items-end gap-2">
                <Field id="new-step-type" label="Add a step">
                  {(aria) => (
                    <Select
                      {...aria}
                      value={newType}
                      onChange={(e) => setNewType(e.target.value as NodeType)}
                    >
                      {NODE_TYPES.map((t) => (
                        <option
                          key={t}
                          value={t}
                          disabled={templateStep(t) && usableTemplates.length === 0}
                        >
                          {NODE_TYPE_LABELS[t]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Button
                  type="button"
                  variant="outline"
                  disabled={templateStep(newType) && usableTemplates.length === 0}
                  onClick={() =>
                    change(() =>
                      setGraph((g) => ({
                        ...g,
                        nodes: [
                          ...g.nodes,
                          defaultNode(newType, g, web.allowedDomains, usableTemplates[0]),
                        ],
                      })),
                    )
                  }
                >
                  Add step
                </Button>
                {usableTemplates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Template steps need an approved utility or marketing template
                    {channelWhatsappAccountId ? ' of this number’s WhatsApp account' : ''}.
                  </p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {canWrite ? (
          <div className="sticky bottom-0 z-10 grid gap-2 border-t border-border bg-background/95 py-3 backdrop-blur">
            <FormError message={error} />
            <FormSuccess message={saved} />
            <div className="flex flex-wrap items-center gap-3">
              <ClientButton onClick={save} disabled={saving || !dirty || structural}>
                {saving ? 'Saving…' : 'Save draft'}
              </ClientButton>
              <span className="text-sm text-muted-foreground" aria-live="polite">
                {dirty ? 'Unsaved changes' : 'All changes saved'}
              </span>
            </div>
          </div>
        ) : null}
      </fieldset>

      <Card>
        <CardHeader>
          <CardTitle>Try it</CardTitle>
          <CardDescription>
            Run the current steps here, as a customer would experience them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AutomationSimulator
            graph={parsedGraph.ok ? parsedGraph.graph : null}
            companyName={companyName}
            teams={teams}
            templates={templates}
            storeEvent={storeEvent}
            apiInputs={apiInputs}
          />
        </CardContent>
      </Card>
    </div>
  );
}
