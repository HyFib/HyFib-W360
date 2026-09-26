'use client';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  COMMON_TEMPLATE_LANGUAGES,
  TEMPLATE_LIMITS,
  positionalVariables,
  renderExample,
  validateDefinition,
  type TemplateButton,
  type TemplateDefinition,
} from '@w360/domain/template-definition';
import { Button, Field, Input, Select, Textarea } from '@w360/ui';
import { createTemplateDraftAction, updateTemplateDraftAction } from '@/app/actions/templates';
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

/**
 * Template draft editor with a live preview. Checks run here for fast feedback and again on the
 * server; Meta reviews the template after submission.
 */
export function TemplateEditor({
  slug,
  accounts,
  existing,
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
}) {
  const router = useRouter();
  const langList = useId();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [language, setLanguage] = useState(existing?.language ?? 'en');
  const [def, setDef] = useState<TemplateDefinition>(existing?.definition ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const update = (patch: Partial<TemplateDefinition>) => {
    setSaved(false);
    setDef((d) => ({ ...d, ...patch }));
  };
  const bodyVars = variableCount(def.body.text);
  const headerVars = def.header.type === 'text' ? variableCount(def.header.text) : 0;
  const issues = def.body.text ? validateDefinition(def) : [];
  const setButton = (index: number, button: TemplateButton) =>
    update({ buttons: def.buttons.map((b, i) => (i === index ? button : b)) });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const definition = {
      ...def,
      body: { ...def.body, examples: def.body.examples.slice(0, bodyVars) },
    };
    try {
      if (existing) {
        const result = await updateTemplateDraftAction(slug, existing.id, {
          expectedVersion: existing.version,
          definition,
        });
        if (!result.ok) setError(result.message);
        else {
          setSaved(true);
          router.refresh();
        }
      } else {
        const result = await createTemplateDraftAction(slug, {
          whatsappAccountId: accountId,
          name,
          language,
          definition,
        });
        if (!result.ok) setError(result.message);
        else router.push(`/c/${slug}/templates/${result.data.id}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <ClientForm onSubmit={submit} className="grid gap-4">
        <FormError message={error} />
        <FormSuccess message={saved ? 'Draft saved.' : null} />
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
          description="Utility: updates about something the customer asked for, with no promotion. Marketing: everything else. Meta may change the category."
        >
          {(aria) => (
            <Select
              {...aria}
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
                <Field id={`tpl-button-url-${i}`} label="Address (https://)">
                  {(aria) => (
                    <Input
                      {...aria}
                      type="url"
                      value={b.url}
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
          <Button type="submit" disabled={busy || (!existing && accounts.length === 0)}>
            {busy ? 'Saving…' : 'Save draft'}
          </Button>
        </div>
      </ClientForm>
      <div className="grid content-start gap-2">
        <p className="text-sm font-medium">Preview with example values</p>
        <TemplatePreview rendered={renderExample(def)} />
      </div>
    </div>
  );
}
