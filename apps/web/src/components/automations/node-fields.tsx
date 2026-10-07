'use client';
import type { ReactNode } from 'react';
import { Button, Checkbox, Field, Input, Select, Textarea } from '@w360/ui';
import {
  ANSWER_FORMATS,
  AUTOMATION_LIMITS,
  COMPARISONS,
  FORM_CONTENT_TYPE,
  HTTP_BODY_METHODS,
  HTTP_METHODS,
  HTTP_WAIT_MINUTES,
  type AutomationNode,
  type ConditionRule,
  type HttpMethod,
  type NodeOf,
} from '@w360/domain/automation-model';
import { FLOW_LIMITS } from '@w360/domain/flow-json';

/**
 * Field editors for each step type. Every control is labelled; "next step" choices list the
 * automation's steps by name, plus ending the automation there.
 */
export interface StepChoice {
  id: string;
  label: string;
}

/** An active pipeline a deal step may use, with its currency and active stages. */
export interface EditorPipeline {
  id: string;
  name: string;
  currency: string;
  stages: { id: string; name: string }[];
}

/** A company template as the builder sees it (from the latest copy synced from Meta). */
export interface EditorTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  whatsappAccountId: string;
  /** Why HyFib cannot send it (for example a media header), or null. */
  unsupported: string | null;
  headerParams: number;
  bodyParams: number;
  /** Website buttons whose link ends with a value, in the order a step fills them (ADR-229). */
  links: readonly { index: number; text: string; url: string }[];
  /** Quick-reply buttons by their position among the template's buttons. */
  quickReplies: readonly { index: number; title: string }[];
  preview: { header: string | null; body: string; footer: string | null } | null;
}

export interface NodeFieldOptions {
  steps: StepChoice[];
  teams: { id: string; name: string }[];
  /** Active members who can use the CRM, whom task steps may create tasks for. */
  crmMembers: { id: string; name: string }[];
  /** Active pipelines with their currency and active stages, for deal steps. */
  crmPipelines: EditorPipeline[];
  /** The company's forms that can be sent, of the automation's number's account when it has one. */
  flows: { id: string; name: string }[];
  fields: { key: string; label: string; type: string }[];
  /** Answer names saved by questions and web requests in this automation. */
  answers: string[];
  /** Domains web request steps may call, and the secrets they may use (names only). */
  allowedDomains: string[];
  secrets: { name: string; domain: string }[];
  /** Templates a step can send: approved, utility or marketing, of the automation's number. */
  templates: EditorTemplate[];
  /** The automation starts from a store's order messages ({{order.<field>}} is available). */
  storeEvent: boolean;
  /** The inputs of an automation started through the API ({{input.<name>}}), else null. */
  apiInputs: string[] | null;
}

const COMPARISON_LABELS: Record<(typeof COMPARISONS)[number], string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  is_set: 'has a value',
  is_not_set: 'is empty',
  greater_than: 'is more than',
  less_than: 'is less than',
};

const FORMAT_LABELS: Record<(typeof ANSWER_FORMATS)[number], string> = {
  any: 'Any text',
  number: 'A number',
  email: 'An email address',
};

const PLACEHOLDER_HINT = 'Use {{name}}, {{company}} or {{answer.<name>}} to fill in values.';
const STORE_PLACEHOLDER_HINT =
  'Use {{name}}, {{company}}, {{answer.<name>}} or the order’s {{order.number}}, {{order.total}}, {{order.items}} and more.';
const hintFor = (options: NodeFieldOptions) =>
  options.storeEvent
    ? STORE_PLACEHOLDER_HINT
    : options.apiInputs
      ? `Use {{name}}, {{company}}, {{answer.<name>}} or the call’s inputs${
          options.apiInputs.length > 0
            ? ` (${options.apiInputs.map((i) => `{{input.${i}}}`).join(', ')})`
            : ', {{input.<name>}}'
        }.`
      : PLACEHOLDER_HINT;

function NextSelect({
  id,
  label,
  value,
  self,
  options,
  onChange,
  description,
}: {
  id: string;
  label: string;
  value: string | null;
  self: string;
  options: NodeFieldOptions;
  onChange: (next: string | null) => void;
  description?: ReactNode;
}) {
  return (
    <Field id={id} label={label} description={description}>
      {(aria) => (
        <Select
          {...aria}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">End the automation here</option>
          {options.steps.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id === self ? `${s.label} (this step)` : s.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function MinutesInput({
  id,
  label,
  value,
  onChange,
  description,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  description?: ReactNode;
}) {
  return (
    <Field id={id} label={label} description={description}>
      {(aria) => (
        <Input
          {...aria}
          type="number"
          inputMode="numeric"
          min={1}
          max={AUTOMATION_LIMITS.minutes}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
        />
      )}
    </Field>
  );
}

function RetryFields({
  prefix,
  retries,
  retryText,
  onChange,
  limit,
}: {
  prefix: string;
  retries: number;
  retryText: string | null;
  onChange: (patch: { retries?: number; retryText?: string | null }) => void;
  limit: number;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
      <Field id={`${prefix}-retries`} label="Ask again">
        {(aria) => (
          <Select
            {...aria}
            value={String(retries)}
            onChange={(e) => onChange({ retries: Number(e.target.value) })}
          >
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'Never' : n === 1 ? 'Once' : `${n} times`}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        id={`${prefix}-retry-text`}
        label="Text when asking again (optional)"
        description="Empty: the question is repeated as it is."
      >
        {(aria) => (
          <Input
            {...aria}
            value={retryText ?? ''}
            maxLength={limit}
            onChange={(e) => onChange({ retryText: e.target.value || null })}
          />
        )}
      </Field>
    </div>
  );
}

function RuleEditor({
  prefix,
  rule,
  options,
  onChange,
  onRemove,
}: {
  prefix: string;
  rule: ConditionRule;
  options: NodeFieldOptions;
  onChange: (rule: ConditionRule) => void;
  onRemove: (() => void) | null;
}) {
  const kindSelect = (
    <Field id={`${prefix}-kind`} label="Check">
      {(aria) => (
        <Select
          {...aria}
          value={rule.kind}
          onChange={(e) => {
            const kind = e.target.value as ConditionRule['kind'];
            if (kind === 'answer')
              onChange({ kind, variable: options.answers[0] ?? 'answer', op: 'equals', value: '' });
            else if (kind === 'field')
              onChange({ kind, field: options.fields[0]?.key ?? 'field', op: 'equals', value: '' });
            else if (kind === 'tag' || kind === 'conversation_tag')
              onChange({ kind, op: 'has', tag: '' });
            else onChange({ kind, op: 'open' });
          }}
        >
          <option value="answer">A saved answer</option>
          <option value="field">A contact field</option>
          <option value="tag">A contact tag</option>
          <option value="conversation_tag">A conversation tag</option>
          <option value="business_hours">Business hours</option>
        </Select>
      )}
    </Field>
  );
  let rest: ReactNode;
  if (rule.kind === 'answer' || rule.kind === 'field') {
    const valueless = rule.op === 'is_set' || rule.op === 'is_not_set';
    rest = (
      <>
        {rule.kind === 'answer' ? (
          <Field id={`${prefix}-variable`} label="Answer">
            {(aria) => (
              <Select
                {...aria}
                value={rule.variable}
                onChange={(e) => onChange({ ...rule, variable: e.target.value })}
              >
                {[...new Set([...options.answers, rule.variable])].map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <Field id={`${prefix}-field`} label="Field">
            {(aria) => (
              <Select
                {...aria}
                value={rule.field}
                onChange={(e) => onChange({ ...rule, field: e.target.value })}
              >
                {options.fields.length === 0 ? <option value={rule.field}>No fields</option> : null}
                {options.fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field id={`${prefix}-op`} label="Comparison">
          {(aria) => (
            <Select
              {...aria}
              value={rule.op}
              onChange={(e) =>
                onChange({ ...rule, op: e.target.value as (typeof COMPARISONS)[number] })
              }
            >
              {COMPARISONS.map((c) => (
                <option key={c} value={c}>
                  {COMPARISON_LABELS[c]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {valueless ? null : (
          <Field id={`${prefix}-value`} label="Value">
            {(aria) => (
              <Input
                {...aria}
                value={rule.value ?? ''}
                maxLength={AUTOMATION_LIMITS.ruleValueLength}
                onChange={(e) => onChange({ ...rule, value: e.target.value })}
              />
            )}
          </Field>
        )}
      </>
    );
  } else if (rule.kind === 'tag' || rule.kind === 'conversation_tag') {
    rest = (
      <>
        <Field id={`${prefix}-op`} label={rule.kind === 'tag' ? 'Contact' : 'Conversation'}>
          {(aria) => (
            <Select
              {...aria}
              value={rule.op}
              onChange={(e) => onChange({ ...rule, op: e.target.value as 'has' | 'has_not' })}
            >
              <option value="has">has the tag</option>
              <option value="has_not">does not have the tag</option>
            </Select>
          )}
        </Field>
        <Field id={`${prefix}-tag`} label="Tag">
          {(aria) => (
            <Input
              {...aria}
              value={rule.tag}
              maxLength={40}
              onChange={(e) => onChange({ ...rule, tag: e.target.value })}
            />
          )}
        </Field>
      </>
    );
  } else {
    rest = (
      <Field id={`${prefix}-op`} label="The business is">
        {(aria) => (
          <Select
            {...aria}
            value={rule.op}
            onChange={(e) => onChange({ ...rule, op: e.target.value as 'open' | 'closed' })}
          >
            <option value="open">open</option>
            <option value="closed">closed</option>
          </Select>
        )}
      </Field>
    );
  }
  return (
    <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2 lg:grid-cols-4">
      {kindSelect}
      {rest}
      {onRemove ? (
        <div className="flex items-end">
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
            Remove rule
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The editable fields of one step. */
export function NodeFields({
  node,
  options,
  onChange,
}: {
  node: AutomationNode;
  options: NodeFieldOptions;
  onChange: (node: AutomationNode) => void;
}) {
  const p = `step-${node.id}`;
  const patch = <T extends AutomationNode>(n: T, values: Partial<T>) =>
    onChange({ ...n, ...values });
  switch (node.type) {
    case 'send_text':
      return (
        <div className="grid gap-4">
          <Field id={`${p}-text`} label="Message" description={hintFor(options)}>
            {(aria) => (
              <Textarea
                {...aria}
                rows={3}
                value={node.text}
                maxLength={AUTOMATION_LIMITS.textLength}
                onChange={(e) => patch(node, { text: e.target.value })}
              />
            )}
          </Field>
          <NextSelect
            id={`${p}-next`}
            label="Then"
            value={node.next}
            self={node.id}
            options={options}
            onChange={(next) => patch(node, { next })}
          />
        </div>
      );
    case 'send_flow':
      return (
        <div className="grid gap-4">
          <Field
            id={`${p}-flow`}
            label="Form"
            description="A published form of the number's WhatsApp account. The customer's answers go to the contact as the form maps them."
          >
            {(aria) => (
              <Select
                {...aria}
                value={node.flowId}
                onChange={(e) => patch(node, { flowId: e.target.value })}
              >
                {options.flows.some((f) => f.id === node.flowId) ? null : (
                  <option value={node.flowId}>Choose a form</option>
                )}
                {options.flows.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id={`${p}-body`} label="Message" description={hintFor(options)}>
            {(aria) => (
              <Textarea
                {...aria}
                rows={3}
                value={node.body}
                maxLength={FLOW_LIMITS.bodyLength}
                onChange={(e) => patch(node, { body: e.target.value })}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={`${p}-header`} label="Header (optional)">
              {(aria) => (
                <Input
                  {...aria}
                  value={node.header ?? ''}
                  maxLength={FLOW_LIMITS.headerLength}
                  onChange={(e) => patch(node, { header: e.target.value || null })}
                />
              )}
            </Field>
            <Field id={`${p}-footer`} label="Footer (optional)">
              {(aria) => (
                <Input
                  {...aria}
                  value={node.footer ?? ''}
                  maxLength={FLOW_LIMITS.footerLength}
                  onChange={(e) => patch(node, { footer: e.target.value || null })}
                />
              )}
            </Field>
            <Field id={`${p}-cta`} label="Button">
              {(aria) => (
                <Input
                  {...aria}
                  value={node.cta}
                  maxLength={FLOW_LIMITS.ctaLength}
                  onChange={(e) => patch(node, { cta: e.target.value })}
                />
              )}
            </Field>
          </div>
          <NextSelect
            id={`${p}-next`}
            label="Then"
            value={node.next}
            self={node.id}
            options={options}
            onChange={(next) => patch(node, { next })}
          />
        </div>
      );
    case 'ask_buttons':
      return <AskButtonsFields node={node} options={options} onChange={onChange} />;
    case 'send_template':
    case 'ask_template':
      return <TemplateFields node={node} options={options} onChange={onChange} />;
    case 'http_request':
      return <HttpRequestFields node={node} options={options} onChange={onChange} />;
    case 'ask_text':
      return (
        <div className="grid gap-4">
          <Field id={`${p}-text`} label="Question" description={hintFor(options)}>
            {(aria) => (
              <Textarea
                {...aria}
                rows={2}
                value={node.text}
                maxLength={AUTOMATION_LIMITS.textLength}
                onChange={(e) => patch(node, { text: e.target.value })}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={`${p}-save`}
              label="Save the answer as"
              description="Lower-case letters, digits and _ ; use it as {{answer.name}}."
            >
              {(aria) => (
                <Input
                  {...aria}
                  value={node.saveAs}
                  maxLength={32}
                  onChange={(e) => patch(node, { saveAs: e.target.value })}
                />
              )}
            </Field>
            <Field id={`${p}-format`} label="Accept">
              {(aria) => (
                <Select
                  {...aria}
                  value={node.format}
                  onChange={(e) =>
                    patch(node, { format: e.target.value as NodeOf<'ask_text'>['format'] })
                  }
                >
                  {ANSWER_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {FORMAT_LABELS[f]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <RetryFields
            prefix={p}
            retries={node.retries}
            retryText={node.retryText}
            limit={AUTOMATION_LIMITS.textLength}
            onChange={(values) => patch(node, values)}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <NextSelect
              id={`${p}-next`}
              label="After an answer"
              value={node.next}
              self={node.id}
              options={options}
              onChange={(next) => patch(node, { next })}
            />
            <NextSelect
              id={`${p}-invalid`}
              label="After an answer that does not fit"
              value={node.invalidNext}
              self={node.id}
              options={options}
              onChange={(invalidNext) => patch(node, { invalidNext })}
            />
            <NextSelect
              id={`${p}-timeout`}
              label="If there is no reply"
              value={node.timeoutNext}
              self={node.id}
              options={options}
              onChange={(timeoutNext) => patch(node, { timeoutNext })}
            />
          </div>
          <MinutesInput
            id={`${p}-minutes`}
            label="Wait for a reply (minutes)"
            value={node.timeoutMinutes}
            onChange={(timeoutMinutes) => patch(node, { timeoutMinutes })}
          />
        </div>
      );
    case 'condition':
      return (
        <div className="grid gap-4">
          <Field id={`${p}-match`} label="Go to “yes” when">
            {(aria) => (
              <Select
                {...aria}
                value={node.match}
                onChange={(e) => patch(node, { match: e.target.value as 'all' | 'any' })}
              >
                <option value="all">all rules are true</option>
                <option value="any">any rule is true</option>
              </Select>
            )}
          </Field>
          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm font-medium">Rules</legend>
            {node.rules.map((rule, i) => (
              <RuleEditor
                key={i}
                prefix={`${p}-rule-${i}`}
                rule={rule}
                options={options}
                onChange={(r) =>
                  patch(node, { rules: node.rules.map((x, j) => (j === i ? r : x)) })
                }
                onRemove={
                  node.rules.length > 1
                    ? () => patch(node, { rules: node.rules.filter((_, j) => j !== i) })
                    : null
                }
              />
            ))}
            {node.rules.length < AUTOMATION_LIMITS.rules ? (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    patch(node, { rules: [...node.rules, { kind: 'business_hours', op: 'open' }] })
                  }
                >
                  Add rule
                </Button>
              </div>
            ) : null}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <NextSelect
              id={`${p}-then`}
              label="Yes: then"
              value={node.then}
              self={node.id}
              options={options}
              onChange={(then) => patch(node, { then })}
            />
            <NextSelect
              id={`${p}-else`}
              label="No: then"
              value={node.else}
              self={node.id}
              options={options}
              onChange={(value) => patch(node, { else: value })}
            />
          </div>
        </div>
      );
    case 'update_contact': {
      const action = node.action;
      return (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${p}-action`} label="Change">
              {(aria) => (
                <Select
                  {...aria}
                  value={action.kind}
                  onChange={(e) => {
                    const kind = e.target.value;
                    if (kind === 'set_field')
                      patch(node, {
                        action: { kind, field: options.fields[0]?.key ?? 'field', value: '' },
                      });
                    else
                      patch(node, {
                        action: {
                          kind: kind as 'add_tag' | 'remove_tag',
                          tag: 'tag' in action ? action.tag : '',
                        },
                      });
                  }}
                >
                  <option value="add_tag">Add a tag</option>
                  <option value="remove_tag">Remove a tag</option>
                  <option value="set_field">Set a contact field</option>
                </Select>
              )}
            </Field>
            {action.kind === 'set_field' ? (
              <Field id={`${p}-field`} label="Field">
                {(aria) => (
                  <Select
                    {...aria}
                    value={action.field}
                    onChange={(e) => patch(node, { action: { ...action, field: e.target.value } })}
                  >
                    {options.fields.length === 0 ? (
                      <option value={action.field}>No contact fields yet</option>
                    ) : null}
                    {options.fields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : (
              <Field id={`${p}-tag`} label="Tag">
                {(aria) => (
                  <Input
                    {...aria}
                    value={action.tag}
                    maxLength={40}
                    onChange={(e) => patch(node, { action: { ...action, tag: e.target.value } })}
                  />
                )}
              </Field>
            )}
          </div>
          {action.kind === 'set_field' ? (
            <Field id={`${p}-value`} label="Value" description={hintFor(options)}>
              {(aria) => (
                <Input
                  {...aria}
                  value={action.value}
                  maxLength={AUTOMATION_LIMITS.fieldValueLength}
                  onChange={(e) => patch(node, { action: { ...action, value: e.target.value } })}
                />
              )}
            </Field>
          ) : null}
          <NextSelect
            id={`${p}-next`}
            label="Then"
            value={node.next}
            self={node.id}
            options={options}
            onChange={(next) => patch(node, { next })}
          />
        </div>
      );
    }
    case 'update_conversation': {
      const action = node.action;
      return (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${p}-action`} label="Change">
              {(aria) => (
                <Select
                  {...aria}
                  value={action.kind}
                  onChange={(e) =>
                    patch(node, {
                      action: {
                        kind: e.target.value as 'add_tag' | 'remove_tag',
                        tag: action.tag,
                      },
                    })
                  }
                >
                  <option value="add_tag">Add a tag to the conversation</option>
                  <option value="remove_tag">Remove a tag from the conversation</option>
                </Select>
              )}
            </Field>
            <Field
              id={`${p}-tag`}
              label="Tag"
              description="As members tag conversations in the inbox: lower case, without commas."
            >
              {(aria) => (
                <Input
                  {...aria}
                  value={action.tag}
                  maxLength={40}
                  onChange={(e) => patch(node, { action: { ...action, tag: e.target.value } })}
                />
              )}
            </Field>
          </div>
          <NextSelect
            id={`${p}-next`}
            label="Then"
            value={node.next}
            self={node.id}
            options={options}
            onChange={(next) => patch(node, { next })}
          />
        </div>
      );
    }
    case 'create_task':
      return (
        <div className="grid gap-4">
          <Field
            id={`${p}-task`}
            label="Task"
            description={`The task about the contact, in the CRM. ${hintFor(options)}`}
          >
            {(aria) => (
              <Input
                {...aria}
                value={node.title}
                maxLength={AUTOMATION_LIMITS.taskTitleLength}
                onChange={(e) => patch(node, { title: e.target.value })}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={`${p}-assignee`}
              label="For"
              description="An active member who can use the CRM. If they no longer can when the step runs, no task is created and the run goes on."
            >
              {(aria) => (
                <Select
                  {...aria}
                  value={node.assigneeMembershipId}
                  onChange={(e) => patch(node, { assigneeMembershipId: e.target.value })}
                >
                  {options.crmMembers.some((m) => m.id === node.assigneeMembershipId) ? null : (
                    <option value={node.assigneeMembershipId}>Choose a member</option>
                  )}
                  {options.crmMembers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              id={`${p}-due`}
              label="Due after (hours)"
              description="Left empty, the task has no due time."
            >
              {(aria) => (
                <Input
                  {...aria}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={AUTOMATION_LIMITS.taskDueHours}
                  value={
                    node.dueInHours !== null && Number.isFinite(node.dueInHours)
                      ? node.dueInHours
                      : ''
                  }
                  onChange={(e) =>
                    patch(node, {
                      dueInHours:
                        e.target.value === '' ? null : Number.parseInt(e.target.value, 10),
                    })
                  }
                />
              )}
            </Field>
          </div>
          <label htmlFor={`${p}-remind`} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={`${p}-remind`}
              checked={node.remind === true}
              onChange={(e) =>
                patch(node, e.target.checked ? { remind: true } : { remind: undefined })
              }
            />
            Email them a reminder when it is due
          </label>
          <NextSelect
            id={`${p}-next`}
            label="Then"
            value={node.next}
            self={node.id}
            options={options}
            onChange={(next) => patch(node, { next })}
          />
        </div>
      );
    case 'create_deal': {
      const pipeline = options.crmPipelines.find((pl) => pl.id === node.pipelineId);
      return (
        <div className="grid gap-4">
          <Field
            id={`${p}-deal`}
            label="Deal"
            description={`The deal for the contact, from this conversation. ${hintFor(options)}`}
          >
            {(aria) => (
              <Input
                {...aria}
                value={node.title}
                maxLength={AUTOMATION_LIMITS.dealTitleLength}
                onChange={(e) => patch(node, { title: e.target.value })}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={`${p}-pipeline`}
              label="Pipeline"
              description="No deal is created when the contact already has an open deal in it."
            >
              {(aria) => (
                <Select
                  {...aria}
                  value={node.pipelineId}
                  onChange={(e) => {
                    const next = options.crmPipelines.find((pl) => pl.id === e.target.value);
                    patch(node, {
                      pipelineId: e.target.value,
                      stageId: next?.stages[0]?.id ?? '',
                    });
                  }}
                >
                  {pipeline ? null : <option value={node.pipelineId}>Choose a pipeline</option>}
                  {options.crmPipelines.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {pl.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id={`${p}-stage`} label="Stage">
              {(aria) => (
                <Select
                  {...aria}
                  value={node.stageId}
                  onChange={(e) => patch(node, { stageId: e.target.value })}
                >
                  {pipeline?.stages.some((st) => st.id === node.stageId) ? null : (
                    <option value={node.stageId}>Choose a stage</option>
                  )}
                  {(pipeline?.stages ?? []).map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              id={`${p}-value`}
              label={pipeline ? `Value (${pipeline.currency})` : 'Value'}
              description="Left empty, the deal has no value."
            >
              {(aria) => (
                <Input
                  {...aria}
                  inputMode="decimal"
                  value={node.value ?? ''}
                  maxLength={AUTOMATION_LIMITS.dealValueLength}
                  onChange={(e) => patch(node, { value: e.target.value || null })}
                />
              )}
            </Field>
            <Field
              id={`${p}-owner`}
              label="Owner"
              description="If they can no longer use the CRM when the step runs, the deal has no owner."
            >
              {(aria) => (
                <Select
                  {...aria}
                  value={node.ownerMembershipId ?? ''}
                  onChange={(e) => patch(node, { ownerMembershipId: e.target.value || null })}
                >
                  <option value="">Nobody</option>
                  {node.ownerMembershipId &&
                  !options.crmMembers.some((m) => m.id === node.ownerMembershipId) ? (
                    <option value={node.ownerMembershipId}>
                      A member who can no longer use the CRM
                    </option>
                  ) : null}
                  {options.crmMembers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              id={`${p}-close`}
              label="Expected to close after (days)"
              description="Counted on the company's calendar from the day the step runs; left empty, no date."
            >
              {(aria) => (
                <Input
                  {...aria}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={AUTOMATION_LIMITS.dealCloseDays}
                  value={
                    typeof node.closeInDays === 'number' && Number.isFinite(node.closeInDays)
                      ? node.closeInDays
                      : ''
                  }
                  onChange={(e) =>
                    patch(node, {
                      closeInDays:
                        e.target.value === '' ? undefined : Number.parseInt(e.target.value, 10),
                    })
                  }
                />
              )}
            </Field>
          </div>
          <NextSelect
            id={`${p}-next`}
            label="Then"
            value={node.next}
            self={node.id}
            options={options}
            onChange={(next) => patch(node, { next })}
          />
        </div>
      );
    }
    case 'wait':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <MinutesInput
            id={`${p}-minutes`}
            label="Wait (minutes)"
            value={node.minutes}
            onChange={(minutes) => patch(node, { minutes })}
            description="Messages after about 24 hours without a customer message cannot be sent."
          />
          <NextSelect
            id={`${p}-next`}
            label="Then"
            value={node.next}
            self={node.id}
            options={options}
            onChange={(next) => patch(node, { next })}
          />
        </div>
      );
    case 'handoff':
      return (
        <Field
          id={`${p}-team`}
          label="Team"
          description="The conversation goes to this team (round-robin teams assign a member). Without a team it is routed like a new conversation of the number."
        >
          {(aria) => (
            <Select
              {...aria}
              value={node.teamId ?? ''}
              onChange={(e) => patch(node, { teamId: e.target.value || null })}
            >
              <option value="">Route like a new conversation</option>
              {options.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );
    case 'end':
      return <p className="text-sm text-muted-foreground">The automation ends here.</p>;
  }
}

function AskButtonsFields({
  node,
  options,
  onChange,
}: {
  node: NodeOf<'ask_buttons'>;
  options: NodeFieldOptions;
  onChange: (node: AutomationNode) => void;
}) {
  const p = `step-${node.id}`;
  const patch = (values: Partial<NodeOf<'ask_buttons'>>) => onChange({ ...node, ...values });
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${p}-header`} label="Header (optional)">
          {(aria) => (
            <Input
              {...aria}
              value={node.header ?? ''}
              maxLength={AUTOMATION_LIMITS.headerLength}
              onChange={(e) => patch({ header: e.target.value || null })}
            />
          )}
        </Field>
        <Field id={`${p}-footer`} label="Footer (optional)">
          {(aria) => (
            <Input
              {...aria}
              value={node.footer ?? ''}
              maxLength={AUTOMATION_LIMITS.footerLength}
              onChange={(e) => patch({ footer: e.target.value || null })}
            />
          )}
        </Field>
      </div>
      <Field id={`${p}-body`} label="Question" description={hintFor(options)}>
        {(aria) => (
          <Textarea
            {...aria}
            rows={2}
            value={node.body}
            maxLength={AUTOMATION_LIMITS.questionLength}
            onChange={(e) => patch({ body: e.target.value })}
          />
        )}
      </Field>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">
          Buttons (up to {AUTOMATION_LIMITS.buttons}, titles up to{' '}
          {AUTOMATION_LIMITS.buttonTitleLength} characters)
        </legend>
        {node.buttons.map((button, i) => (
          <div
            key={i}
            className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[1fr_1fr_auto]"
          >
            <Field id={`${p}-button-${i}`} label={`Button ${i + 1}`}>
              {(aria) => (
                <Input
                  {...aria}
                  value={button.title}
                  maxLength={AUTOMATION_LIMITS.buttonTitleLength}
                  onChange={(e) =>
                    patch({
                      buttons: node.buttons.map((b, j) =>
                        j === i ? { ...b, title: e.target.value } : b,
                      ),
                    })
                  }
                />
              )}
            </Field>
            <NextSelect
              id={`${p}-button-${i}-next`}
              label="Then"
              value={button.next}
              self={node.id}
              options={options}
              onChange={(next) =>
                patch({ buttons: node.buttons.map((b, j) => (j === i ? { ...b, next } : b)) })
              }
            />
            <div className="flex items-end">
              {node.buttons.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => patch({ buttons: node.buttons.filter((_, j) => j !== i) })}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        ))}
        {node.buttons.length < AUTOMATION_LIMITS.buttons ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                patch({
                  buttons: [
                    ...node.buttons,
                    { title: `Option ${node.buttons.length + 1}`, next: null },
                  ],
                })
              }
            >
              Add button
            </Button>
          </div>
        ) : null}
      </fieldset>
      <Field
        id={`${p}-save`}
        label="Save the chosen button as (optional)"
        description="Use it as {{answer.name}} or in a condition."
      >
        {(aria) => (
          <Input
            {...aria}
            value={node.saveAs ?? ''}
            maxLength={32}
            onChange={(e) => patch({ saveAs: e.target.value || null })}
          />
        )}
      </Field>
      <RetryFields
        prefix={p}
        retries={node.retries}
        retryText={node.retryText}
        limit={AUTOMATION_LIMITS.questionLength}
        onChange={(values) => patch(values)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <NextSelect
          id={`${p}-nomatch`}
          label="If the reply matches no button"
          value={node.noMatchNext}
          self={node.id}
          options={options}
          onChange={(noMatchNext) => patch({ noMatchNext })}
          description="A typed reply that equals a button title counts as that button."
        />
        <NextSelect
          id={`${p}-timeout`}
          label="If there is no reply"
          value={node.timeoutNext}
          self={node.id}
          options={options}
          onChange={(timeoutNext) => patch({ timeoutNext })}
        />
      </div>
      <MinutesInput
        id={`${p}-minutes`}
        label="Wait for a reply (minutes)"
        value={node.timeoutMinutes}
        onChange={(timeoutMinutes) => patch({ timeoutMinutes })}
      />
    </div>
  );
}

/** Keeps `count` values, as many of the current ones as fit, the rest empty. */
const resized = (values: readonly string[], count: number) =>
  Array.from({ length: count }, (_, i) => values[i] ?? '');

function TemplateFields({
  node,
  options,
  onChange,
}: {
  node: NodeOf<'send_template' | 'ask_template'>;
  options: NodeFieldOptions;
  onChange: (node: AutomationNode) => void;
}) {
  const p = `step-${node.id}`;
  const template = options.templates.find((t) => t.id === node.templateId) ?? null;
  const choose = (id: string) => {
    const next = options.templates.find((t) => t.id === id);
    if (!next) return;
    const header = resized(node.header, next.headerParams);
    const body = resized(node.body, next.bodyParams);
    const links = resized(node.links, next.links.length);
    if (node.type === 'ask_template') {
      // One branch per quick-reply button, keeping where a button that stayed the same went.
      const buttons = next.quickReplies.map((q) => ({
        index: q.index,
        title: q.title,
        next: node.buttons.find((b) => b.index === q.index && b.title === q.title)?.next ?? null,
      }));
      onChange({ ...node, templateId: next.id, header, body, links, buttons });
    } else {
      onChange({ ...node, templateId: next.id, header, body, links });
    }
  };
  const setParam = (part: 'header' | 'body' | 'links', index: number, value: string) =>
    onChange({ ...node, [part]: node[part].map((v, j) => (j === index ? value : v)) });
  return (
    <div className="grid gap-4">
      <Field
        id={`${p}-template`}
        label="Template"
        description="Approved utility and marketing templates. WhatsApp delivers templates even when the customer has not written in the last 24 hours."
      >
        {(aria) => (
          <Select {...aria} value={template?.id ?? ''} onChange={(e) => choose(e.target.value)}>
            {template ? null : <option value="">Choose a template</option>}
            {options.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.language}, {t.category === 'MARKETING' ? 'marketing' : 'utility'})
              </option>
            ))}
          </Select>
        )}
      </Field>
      {template?.preview ? (
        <div className="grid gap-1 rounded-md bg-muted p-3 text-sm">
          {template.preview.header ? (
            <p className="font-medium">{template.preview.header}</p>
          ) : null}
          <p className="whitespace-pre-wrap">{template.preview.body}</p>
          {template.preview.footer ? (
            <p className="text-muted-foreground">{template.preview.footer}</p>
          ) : null}
        </div>
      ) : null}
      {template?.category === 'MARKETING' ? (
        <p className="text-sm text-muted-foreground">
          A marketing template goes only to contacts who opted in to marketing messages, within the
          company’s frequency cap. Publishing it needs the campaign sending permission.
        </p>
      ) : null}
      {node.header.map((value, i) => (
        <Field
          key={`header-${i}`}
          id={`${p}-header-${i}`}
          label="Header variable {{1}}"
          description={hintFor(options)}
        >
          {(aria) => (
            <Input
              {...aria}
              value={value}
              maxLength={1000}
              onChange={(e) => setParam('header', i, e.target.value)}
            />
          )}
        </Field>
      ))}
      {node.body.map((value, i) => (
        <Field
          key={`body-${i}`}
          id={`${p}-body-${i}`}
          label={`Variable {{${i + 1}}}`}
          description={i === 0 ? hintFor(options) : undefined}
        >
          {(aria) => (
            <Input
              {...aria}
              value={value}
              maxLength={1000}
              onChange={(e) => setParam('body', i, e.target.value)}
            />
          )}
        </Field>
      ))}
      {node.links.map((value, i) => (
        <Field
          key={`link-${i}`}
          id={`${p}-link-${i}`}
          label={`End of the “${template?.links[i]?.text ?? ''}” link`}
          description={`Replaces {{1}} in ${template?.links[i]?.url ?? 'the link'}. Placeholders work; the result cannot hold spaces or change the website, or the run fails.`}
        >
          {(aria) => (
            <Input
              {...aria}
              value={value}
              maxLength={1000}
              onChange={(e) => setParam('links', i, e.target.value)}
            />
          )}
        </Field>
      ))}
      {node.type === 'send_template' ? (
        <NextSelect
          id={`${p}-next`}
          label="Then"
          value={node.next}
          self={node.id}
          options={options}
          onChange={(next) => onChange({ ...node, next })}
        />
      ) : (
        <>
          {node.buttons.length > 0 ? (
            <fieldset className="grid gap-3">
              <legend className="mb-1 text-sm font-medium">When the customer taps</legend>
              {node.buttons.map((button, i) => (
                <NextSelect
                  key={button.index}
                  id={`${p}-button-${button.index}`}
                  label={`“${button.title}”`}
                  value={button.next}
                  self={node.id}
                  options={options}
                  onChange={(next) =>
                    onChange({
                      ...node,
                      buttons: node.buttons.map((b, j) => (j === i ? { ...b, next } : b)),
                    })
                  }
                />
              ))}
            </fieldset>
          ) : (
            <p className="text-sm text-muted-foreground">
              This template has no quick-reply buttons: any reply continues with the step below.
            </p>
          )}
          <Field
            id={`${p}-save`}
            label="Save the tapped button as (optional)"
            description="Use it as {{answer.name}} or in a condition."
          >
            {(aria) => (
              <Input
                {...aria}
                value={node.saveAs ?? ''}
                maxLength={32}
                onChange={(e) => onChange({ ...node, saveAs: e.target.value || null })}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <NextSelect
              id={`${p}-reply`}
              label={
                node.buttons.length > 0
                  ? 'If the reply is not a button'
                  : 'When the customer replies'
              }
              value={node.replyNext}
              self={node.id}
              options={options}
              onChange={(replyNext) => onChange({ ...node, replyNext })}
              description={
                node.buttons.length > 0
                  ? 'A typed reply that equals a button’s text counts as that button.'
                  : undefined
              }
            />
            <NextSelect
              id={`${p}-timeout`}
              label="If there is no reply"
              value={node.timeoutNext}
              self={node.id}
              options={options}
              onChange={(timeoutNext) => onChange({ ...node, timeoutNext })}
            />
          </div>
          <MinutesInput
            id={`${p}-minutes`}
            label="Wait for a reply (minutes)"
            value={node.timeoutMinutes}
            onChange={(timeoutMinutes) => onChange({ ...node, timeoutMinutes })}
          />
        </>
      )}
    </div>
  );
}

function HttpRequestFields({
  node,
  options,
  onChange,
}: {
  node: NodeOf<'http_request'>;
  options: NodeFieldOptions;
  onChange: (node: AutomationNode) => void;
}) {
  const p = `step-${node.id}`;
  const patch = (values: Partial<NodeOf<'http_request'>>) => onChange({ ...node, ...values });
  const hasBody = HTTP_BODY_METHODS.has(node.method);
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <Field id={`${p}-method`} label="Method">
          {(aria) => (
            <Select
              {...aria}
              value={node.method}
              onChange={(e) => {
                const method = e.target.value as HttpMethod;
                patch({ method, body: HTTP_BODY_METHODS.has(method) ? node.body : null });
              }}
            >
              {HTTP_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          id={`${p}-url`}
          label="Address"
          description={
            <>
              An https:// address on an allowed domain
              {options.allowedDomains.length > 0
                ? ` (${options.allowedDomains.join(', ')})`
                : ': none yet, an administrator adds them under Settings → Web requests'}
              . Placeholders in the path or query are URL-encoded.
            </>
          }
        >
          {(aria) => (
            <Input
              {...aria}
              value={node.url}
              maxLength={AUTOMATION_LIMITS.httpUrlLength}
              spellCheck={false}
              onChange={(e) => patch({ url: e.target.value })}
            />
          )}
        </Field>
      </div>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">
          Headers (up to {AUTOMATION_LIMITS.httpHeaders})
        </legend>
        <p className="text-sm text-muted-foreground">
          Use {'{{secret.<name>}}'} for keys and tokens
          {options.secrets.length > 0
            ? `: ${options.secrets.map((s) => `${s.name} (sent only to ${s.domain})`).join(', ')}`
            : '; an administrator adds secrets under Settings → Web requests'}
          . Values are printable ASCII; customer text in them is percent-encoded.
        </p>
        {node.headers.map((header, i) => (
          <div
            key={i}
            className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[1fr_2fr_auto]"
          >
            <Field id={`${p}-header-${i}-name`} label={`Header ${i + 1} name`}>
              {(aria) => (
                <Input
                  {...aria}
                  value={header.name}
                  maxLength={60}
                  spellCheck={false}
                  onChange={(e) =>
                    patch({
                      headers: node.headers.map((h, j) =>
                        j === i ? { ...h, name: e.target.value } : h,
                      ),
                    })
                  }
                />
              )}
            </Field>
            <Field id={`${p}-header-${i}-value`} label={`Header ${i + 1} value`}>
              {(aria) => (
                <Input
                  {...aria}
                  value={header.value}
                  maxLength={AUTOMATION_LIMITS.httpHeaderValueLength}
                  spellCheck={false}
                  onChange={(e) =>
                    patch({
                      headers: node.headers.map((h, j) =>
                        j === i ? { ...h, value: e.target.value } : h,
                      ),
                    })
                  }
                />
              )}
            </Field>
            <div className="flex items-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => patch({ headers: node.headers.filter((_, j) => j !== i) })}
              >
                Remove<span className="sr-only"> header {i + 1}</span>
              </Button>
            </div>
          </div>
        ))}
        {node.headers.length < AUTOMATION_LIMITS.httpHeaders ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                patch({
                  headers: [
                    ...node.headers,
                    node.headers.length === 0 && options.secrets[0]
                      ? {
                          name: 'Authorization',
                          value: `Bearer {{secret.${options.secrets[0].name}}}`,
                        }
                      : { name: 'X-Header', value: '' },
                  ],
                })
              }
            >
              Add header
            </Button>
          </div>
        ) : null}
      </fieldset>
      {hasBody ? (
        <Field id={`${p}-format`} label="Body format">
          {(aria) => (
            <Select
              {...aria}
              value={node.bodyFormat ?? 'json'}
              onChange={(e) => patch({ bodyFormat: e.target.value === 'form' ? 'form' : 'json' })}
            >
              <option value="json">JSON (application/json)</option>
              <option value="form">Form fields ({FORM_CONTENT_TYPE})</option>
            </Select>
          )}
        </Field>
      ) : null}
      {hasBody ? (
        <Field
          id={`${p}-body`}
          label="Body (optional)"
          description={
            node.bodyFormat === 'form'
              ? 'Fields as name=value joined by &, written URL-encoded, for example phone={{answer.phone}}&note=Hello%20there; placeholder values are URL-encoded. Do not add a Content-Type header.'
              : `JSON, sent as application/json. Put placeholders inside quotes, for example {"order": "{{answer.order_no}}"}; their values are escaped.`
          }
        >
          {(aria) => (
            <Textarea
              {...aria}
              rows={4}
              spellCheck={false}
              className="font-mono"
              value={node.body ?? ''}
              maxLength={AUTOMATION_LIMITS.httpBodyLength}
              onChange={(e) => patch({ body: e.target.value || null })}
            />
          )}
        </Field>
      ) : null}
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">
          Save from the response (up to {AUTOMATION_LIMITS.httpSaves})
        </legend>
        <p className="text-sm text-muted-foreground">
          Values from a successful JSON response, by path (for example data.order.status). Use them
          as {'{{answer.<name>}}'}; a value the response lacks stays empty.
        </p>
        {node.save.map((item, i) => (
          <div
            key={i}
            className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[2fr_1fr_auto]"
          >
            <Field id={`${p}-save-${i}-path`} label={`Value ${i + 1} path`}>
              {(aria) => (
                <Input
                  {...aria}
                  value={item.path}
                  maxLength={200}
                  spellCheck={false}
                  onChange={(e) =>
                    patch({
                      save: node.save.map((s, j) => (j === i ? { ...s, path: e.target.value } : s)),
                    })
                  }
                />
              )}
            </Field>
            <Field id={`${p}-save-${i}-as`} label={`Save value ${i + 1} as`}>
              {(aria) => (
                <Input
                  {...aria}
                  value={item.saveAs}
                  maxLength={32}
                  spellCheck={false}
                  onChange={(e) =>
                    patch({
                      save: node.save.map((s, j) =>
                        j === i ? { ...s, saveAs: e.target.value } : s,
                      ),
                    })
                  }
                />
              )}
            </Field>
            <div className="flex items-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => patch({ save: node.save.filter((_, j) => j !== i) })}
              >
                Remove<span className="sr-only"> value {i + 1}</span>
              </Button>
            </div>
          </div>
        ))}
        {node.save.length < AUTOMATION_LIMITS.httpSaves ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                patch({
                  save: [
                    ...node.save,
                    { path: 'data.status', saveAs: `result_${node.save.length + 1}` },
                  ],
                })
              }
            >
              Add value
            </Button>
          </div>
        ) : null}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <NextSelect
          id={`${p}-next`}
          label="After a successful response"
          value={node.next}
          self={node.id}
          options={options}
          onChange={(next) => patch({ next })}
          description="A 2xx status."
        />
        <NextSelect
          id={`${p}-failure`}
          label="If the call fails"
          value={node.failureNext}
          self={node.id}
          options={options}
          onChange={(failureNext) => patch({ failureNext })}
          description={`Another status, a refused or failed call, or no result within ${HTTP_WAIT_MINUTES} minutes. A call that may have reached the server is never repeated.`}
        />
      </div>
    </div>
  );
}
