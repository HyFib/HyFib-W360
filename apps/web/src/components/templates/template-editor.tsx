'use client';
import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  COMMON_TEMPLATE_LANGUAGES,
  TEMPLATE_LIMITS,
  linkPrefix,
  positionalVariables,
  renderExample,
  validateDefinition,
  type TemplateButton,
  type TemplateDefinition,
} from '@w360/domain/template-definition';
import type { TemplateUsage } from '@w360/domain';
import { Button, Field, Input, Select, Textarea } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  createTemplateDraftAction,
  editTemplateAction,
  updateTemplateDraftAction,
} from '@/app/actions/templates';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import { TemplatePreview } from './template-preview';

const EMPTY: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'none' },
  body: { text: '', examples: [] },
  footer: null,
  buttons: [],
};

function variableCount(text: string): number {
  const vars = positionalVariables(text);
  return vars.ok ? new Set(vars.numbers).size : 0;
}

const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'waiting for approval',
  scheduled: 'scheduled',
  running: 'sending now',
  paused: 'paused',
};

const STORE_EVENT_LABEL: Record<string, string> = {
  order_placed: 'new order',
  cod_confirmation: 'cash on delivery confirmation',
  order_shipped: 'order shipped',
  order_delivered: 'order delivered',
  order_cancelled: 'order cancelled',
  cart_reminder: 'cart reminder',
  cart_second_reminder: 'second cart reminder',
};

/** Where the template is used, as the confirmation of an edit lists it (ADR-404). */
function UsageList({ usage }: { usage: TemplateUsage }) {
  const items = [
    ...usage.campaigns.map(
      (c) =>
        `${c.name ? `Campaign “${c.name}”` : 'A campaign'} (${CAMPAIGN_STATUS_LABEL[c.status] ?? c.status})`,
    ),
    ...usage.automations.map(
      (a) =>
        `${a.name ? `Automation “${a.name}”` : 'An automation'} (${a.status === 'active' ? 'live' : 'paused'})`,
    ),
    ...usage.automationRuns
      .filter((r) => !usage.automations.some((a) => a.id === r.id))
      .map(
        (r) =>
          `${r.name ? `Automation “${r.name}”` : 'An automation'} (${r.runs} ${r.runs === 1 ? 'run' : 'runs'} in progress)`,
      ),
    ...usage.storeRules.map(
      (r) =>
        `${r.storeName ?? 'Store'}: ${STORE_EVENT_LABEL[r.event] ?? r.event} message (${r.enabled ? 'on' : 'off'})`,
    ),
  ];
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No unfinished campaign, published automation or store message uses this template.
      </p>
    );
  }
  return (
    <div className="grid gap-1 text-sm">
      <p className="font-medium">Used by</p>
      <ul className="list-disc pl-5" data-testid="template-usage">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Template editor with a live preview, for drafts and, with `atMeta`, for an edit of a template
 * Meta has (ADR-404: its name, language and category stay; the member confirms after seeing where
 * it is used). Checks run here for fast feedback and again on the server; Meta reviews the template
 * after submission.
 */
export function TemplateEditor({
  slug,
  accounts,
  existing,
  initial,
  atMeta,
}: {
  slug: string;
  accounts: { id: string; name: string }[];
  existing?: {
    id: string;
    version: number;
    name: string;
    language: string;
    definition: TemplateDefinition;
  };
  /** A new draft's name and content to start from, such as a starter's (ADR-232). */
  initial?: { name: string; definition: TemplateDefinition };
  /** Editing a template Meta has: where it is used, shown before the edit is sent. */
  atMeta?: { usage: TemplateUsage };
}) {
  const router = useRouter();
  const langList = useId();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [name, setName] = useState(existing?.name ?? initial?.name ?? '');
  const [language, setLanguage] = useState(existing?.language ?? 'en');
  const [def, setDef] = useState<TemplateDefinition>(
    existing?.definition ?? initial?.definition ?? EMPTY,
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, startTransition] = useTransition();

  const update = (patch: Partial<TemplateDefinition>) => {
    setSaved(false);
    setDef((d) => ({ ...d, ...patch }));
  };
  const bodyVars = variableCount(def.body.text);
  const headerVars = def.header.type === 'text' ? variableCount(def.header.text) : 0;
  const issues = def.body.text ? validateDefinition(def) : [];
  const setButton = (index: number, button: TemplateButton) =>
    update({ buttons: def.buttons.map((b, i) => (i === index ? button : b)) });

  const cleaned = (): TemplateDefinition => ({
    ...def,
    body: { ...def.body, examples: def.body.examples.slice(0, bodyVars) },
  });

  /** Sends the edit to Meta, once the member has confirmed it (ADR-404). */
  function sendEdit() {
    if (!existing) return;
    setError(null);
    setSaved(false);
    const definition = cleaned();
    startTransition(async () => {
      try {
        const result = await editTemplateAction(slug, existing.id, { definition });
        startTransition(() => {
          if (!result.ok) setError(result.message);
          else setSaved(true);
        });
      } catch {
        startTransition(() =>
          setError('The edit could not be sent because the connection failed. Try again.'),
        );
      }
    });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // An edit at Meta is sent from its confirmation dialog only.
    if (atMeta) return;
    setError(null);
    setSaved(false);
    const definition = cleaned();
    // The actions refresh the page on the server: their response carries the new render, so no
    // client refresh follows. State set after the await is wrapped again to stay in the
    // transition, so the message appears together with that render, not before it.
    startTransition(async () => {
      try {
        if (existing) {
          const result = await updateTemplateDraftAction(slug, existing.id, {
            expectedVersion: existing.version,
            definition,
          });
          startTransition(() => {
            if (!result.ok) setError(result.message);
            else setSaved(true);
          });
        } else {
          const result = await createTemplateDraftAction(slug, {
            whatsappAccountId: accountId,
            name,
            language,
            definition,
          });
          if (!result.ok) startTransition(() => setError(result.message));
          else router.push(`/c/${slug}/templates/${result.data.id}`);
        }
      } catch {
        startTransition(() =>
          setError('The draft could not be saved because the connection failed. Try again.'),
        );
      }
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <ClientForm onSubmit={submit} className="grid gap-4">
        <FormError message={error} />
        <FormSuccess
          message={
            saved
              ? atMeta
                ? 'Edit sent to Meta. The status updates here when Meta answers.'
                : 'Draft saved.'
              : null
          }
        />
        {!existing ? (
          <>
            {accounts.length > 1 ? (
              <Field id="tpl-account" label="WhatsApp account">
                {(aria) => (
                  <Select
                    {...aria}
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="tpl-name"
                label="Name"
                description="Lower-case letters, digits and underscores."
              >
                {(aria) => (
                  <Input
                    {...aria}
                    value={name}
                    required
                    maxLength={TEMPLATE_LIMITS.name}
                    pattern="[a-z0-9_]+"
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </Field>
              <Field
                id="tpl-language"
                label="Language code"
                description="For example en, en_US or hi."
              >
                {(aria) => (
                  <>
                    <Input
                      {...aria}
                      list={langList}
                      value={language}
                      required
                      onChange={(e) => setLanguage(e.target.value)}
                    />
                    <datalist id={langList}>
                      {COMMON_TEMPLATE_LANGUAGES.map((l) => (
                        <option key={l} value={l} />
                      ))}
                    </datalist>
                  </>
                )}
              </Field>
            </div>
          </>
        ) : null}
        <Field
          id="tpl-category"
          label="Category"
          description={
            atMeta
              ? 'The category stays as it is when a template Meta has is edited.'
              : 'Utility: updates about something the customer asked for, with no promotion. Marketing: everything else. Meta may change the category.'
          }
        >
          {(aria) => (
            <Select
              {...aria}
              disabled={atMeta !== undefined}
              value={def.category}
              onChange={(e) =>
                update({ category: e.target.value as TemplateDefinition['category'] })
              }
            >
              <option value="UTILITY">Utility</option>
              <option value="MARKETING">Marketing</option>
            </Select>
          )}
        </Field>
        <Field id="tpl-header-type" label="Header">
          {(aria) => (
            <Select
              {...aria}
              value={def.header.type}
              onChange={(e) =>
                update({
                  header:
                    e.target.value === 'text'
                      ? { type: 'text', text: '', example: null }
                      : { type: 'none' },
                })
              }
            >
              <option value="none">No header</option>
              <option value="text">Text header</option>
            </Select>
          )}
        </Field>
        {def.header.type === 'text' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="tpl-header" label="Header text" description="At most one variable, {{1}}.">
              {(aria) => (
                <Input
                  {...aria}
                  value={def.header.type === 'text' ? def.header.text : ''}
                  maxLength={TEMPLATE_LIMITS.headerText}
                  onChange={(e) =>
                    update({
                      header: {
                        type: 'text',
                        text: e.target.value,
                        example: def.header.type === 'text' ? def.header.example : null,
                      },
                    })
                  }
                />
              )}
            </Field>
            {headerVars > 0 ? (
              <Field id="tpl-header-example" label="Example for {{1}}">
                {(aria) => (
                  <Input
                    {...aria}
                    value={def.header.type === 'text' ? (def.header.example ?? '') : ''}
                    maxLength={TEMPLATE_LIMITS.exampleValue}
                    onChange={(e) =>
                      def.header.type === 'text' &&
                      update({ header: { ...def.header, example: e.target.value } })
                    }
                  />
                )}
              </Field>
            ) : null}
          </div>
        ) : null}
        <Field
          id="tpl-body"
          label="Body"
          description={`Use {{1}}, {{2}} … for values filled in when sending. ${def.body.text.length}/${TEMPLATE_LIMITS.bodyText}`}
        >
          {(aria) => (
            <Textarea
              {...aria}
              rows={5}
              required
              value={def.body.text}
              maxLength={TEMPLATE_LIMITS.bodyText}
              onChange={(e) => update({ body: { ...def.body, text: e.target.value } })}
            />
          )}
        </Field>
        {bodyVars > 0 ? (
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">
              Example values (Meta reviews these)
            </legend>
            {Array.from({ length: bodyVars }, (_, i) => (
              <Field key={i} id={`tpl-example-${i}`} label={`{{${i + 1}}}`}>
                {(aria) => (
                  <Input
                    {...aria}
                    value={def.body.examples[i] ?? ''}
                    maxLength={TEMPLATE_LIMITS.exampleValue}
                    onChange={(e) => {
                      const examples = [...def.body.examples];
                      examples[i] = e.target.value;
                      update({ body: { ...def.body, examples } });
                    }}
                  />
                )}
              </Field>
            ))}
          </fieldset>
        ) : null}
        <Field id="tpl-footer" label="Footer (optional)">
          {(aria) => (
            <Input
              {...aria}
              value={def.footer ?? ''}
              maxLength={TEMPLATE_LIMITS.footerText}
              onChange={(e) => update({ footer: e.target.value || null })}
            />
          )}
        </Field>
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-medium">Buttons (optional)</legend>
          {def.buttons.map((b, i) => (
            <div
              key={i}
              className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            >
              <Field
                id={`tpl-button-${i}`}
                label={
                  b.type === 'QUICK_REPLY'
                    ? 'Quick reply text'
                    : b.type === 'URL'
                      ? 'Website button text'
                      : 'Call button text'
                }
              >
                {(aria) => (
                  <Input
                    {...aria}
                    value={b.text}
                    maxLength={TEMPLATE_LIMITS.buttonText}
                    onChange={(e) => setButton(i, { ...b, text: e.target.value })}
                  />
                )}
              </Field>
              {b.type === 'URL' ? (
                <Field
                  id={`tpl-button-url-${i}`}
                  label="Address (https://)"
                  description="End it with {{1}} to add a value when sending, such as an order number."
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      type="url"
                      value={b.url}
                      maxLength={TEMPLATE_LIMITS.url}
                      onChange={(e) => setButton(i, { ...b, url: e.target.value })}
                    />
                  )}
                </Field>
              ) : b.type === 'PHONE_NUMBER' ? (
                <Field id={`tpl-button-phone-${i}`} label="Phone (+country code)">
                  {(aria) => (
                    <Input
                      {...aria}
                      inputMode="tel"
                      value={b.phoneNumber}
                      onChange={(e) => setButton(i, { ...b, phoneNumber: e.target.value })}
                    />
                  )}
                </Field>
              ) : (
                <span />
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => update({ buttons: def.buttons.filter((_, j) => j !== i) })}
              >
                Remove
              </Button>
              {b.type === 'URL' && linkPrefix(b.url) !== null ? (
                <div className="sm:col-span-3">
                  <Field
                    id={`tpl-button-example-${i}`}
                    label="Example for the link’s {{1}} (Meta reviews it)"
                  >
                    {(aria) => (
                      <Input
                        {...aria}
                        value={b.example ?? ''}
                        maxLength={TEMPLATE_LIMITS.exampleValue}
                        onChange={(e) => setButton(i, { ...b, example: e.target.value })}
                      />
                    )}
                  </Field>
                </div>
              ) : null}
            </div>
          ))}
          {def.buttons.length < TEMPLATE_LIMITS.buttons ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  update({ buttons: [...def.buttons, { type: 'QUICK_REPLY', text: '' }] })
                }
              >
                Add quick reply
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  update({ buttons: [...def.buttons, { type: 'URL', text: '', url: 'https://' }] })
                }
              >
                Add website button
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  update({
                    buttons: [...def.buttons, { type: 'PHONE_NUMBER', text: '', phoneNumber: '+' }],
                  })
                }
              >
                Add call button
              </Button>
            </div>
          ) : null}
        </fieldset>
        {issues.length > 0 ? (
          <ul className="grid gap-1 text-sm text-destructive" aria-live="polite">
            {issues.map((i, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        ) : null}
        <div>
          {atMeta ? (
            <ConfirmDialog
              title="Send this edit to Meta?"
              description="Meta reviews the new content. Until Meta takes it, sends use the content Meta has now; afterwards every send, including the ones below, uses the content Meta approves. Changing the variables or buttons is refused while anything below uses the template; wording is not. Meta decides how often a template can be edited and may refuse the edit."
              confirmLabel="Send edit to Meta"
              onConfirm={sendEdit}
              trigger={
                <Button type="button" disabled={busy || issues.length > 0}>
                  {busy ? 'Sending…' : 'Send edit to Meta'}
                </Button>
              }
            >
              <UsageList usage={atMeta.usage} />
            </ConfirmDialog>
          ) : (
            <Button type="submit" disabled={busy || (!existing && accounts.length === 0)}>
              {busy ? 'Saving…' : 'Save draft'}
            </Button>
          )}
        </div>
      </ClientForm>
      <div className="grid content-start gap-2">
        <p className="text-sm font-medium">Preview with example values</p>
        <TemplatePreview rendered={renderExample(def)} />
      </div>
    </div>
  );
}
