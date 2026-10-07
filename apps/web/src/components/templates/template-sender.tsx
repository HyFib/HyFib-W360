'use client';
import { useMemo, useRef, useState } from 'react';
import type { RenderedTemplate } from '@w360/domain';
import { Button, Field, Input, Select } from '@w360/ui';
import { sendTemplateAction } from '@/app/actions/contacts';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import { TemplatePreview } from './template-preview';

export interface SendableTemplate {
  id: string;
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  whatsappAccountId: string;
  headerParams: number;
  bodyParams: number;
  /**
   * The website buttons whose link ends with a value given when sending (ADR-228), in the order
   * the values are given: the button's position among the buttons, its text and its link, ending
   * with {{1}}.
   */
  links: { index: number; text: string; url: string }[];
  /** The template text with its {{n}} placeholders. */
  preview: RenderedTemplate;
}

export interface SenderChannel {
  id: string;
  label: string;
  whatsappAccountId: string;
}

function fill(text: string, values: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n: string) => values[Number(n) - 1] || m);
}

/** The preview's buttons, each website button whose link ends with a value showing its link. */
function previewButtons(template: SendableTemplate, values: string[]): RenderedTemplate['buttons'] {
  return template.preview.buttons.map((b, index) => {
    const i = template.links.findIndex((link) => link.index === index);
    const link = template.links[i];
    if (!link) return b;
    const value = values[i];
    return { ...b, url: value ? `${link.url.slice(0, -'{{1}}'.length)}${value}` : link.url };
  });
}

/**
 * Sends an approved template to one contact. Consent and suppression are checked by the server
 * when queueing and again right before dispatch. One idempotency key per submission; it is kept
 * after a network failure so retrying cannot send twice.
 */
export function TemplateSender({
  slug,
  contactId,
  channels,
  templates,
}: {
  slug: string;
  contactId: string;
  channels: SenderChannel[];
  templates: SendableTemplate[];
}) {
  const [channelId, setChannelId] = useState(channels[0]?.id ?? '');
  const channel = channels.find((c) => c.id === channelId);
  const available = useMemo(
    () => templates.filter((t) => t.whatsappAccountId === channel?.whatsappAccountId),
    [templates, channel],
  );
  const [templateId, setTemplateId] = useState(available[0]?.id ?? '');
  const template = available.find((t) => t.id === templateId);
  const [header, setHeader] = useState('');
  const [body, setBody] = useState<string[]>([]);
  const [links, setLinks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingKey = useRef<string | null>(null);

  if (channels.length === 0) {
    return <p className="text-sm text-muted-foreground">No active WhatsApp number is connected.</p>;
  }

  const bodyValues = Array.from({ length: template?.bodyParams ?? 0 }, (_, i) => body[i] ?? '');
  const linkValues = Array.from({ length: template?.links.length ?? 0 }, (_, i) => links[i] ?? '');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!template || !channel) return;
    pendingKey.current ??= crypto.randomUUID().replaceAll('-', '');
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await sendTemplateAction(slug, {
        contactId,
        channelAccountId: channel.id,
        templateId: template.id,
        params: {
          header: template.headerParams ? [header] : [],
          body: bodyValues,
          buttons: linkValues,
        },
        clientKey: pendingKey.current,
      });
      if (result.ok) {
        pendingKey.current = null;
        setNotice('Template queued. Its delivery status appears in the conversation.');
        setHeader('');
        setBody([]);
        setLinks([]);
      } else {
        setError(result.message);
        if (result.code !== 'internal') pendingKey.current = null;
      }
    } catch {
      setError('The template could not be sent because the connection failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ClientForm onSubmit={submit} className="grid gap-3">
      <FormError message={error} />
      <FormSuccess message={notice} />
      {channels.length > 1 ? (
        <Field id="send-channel" label="From number">
          {(aria) => (
            <Select
              {...aria}
              value={channelId}
              onChange={(e) => {
                setChannelId(e.target.value);
                setTemplateId('');
              }}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {available.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No approved template you can send is available for this number.
        </p>
      ) : (
        <>
          <Field id="send-template" label="Template">
            {(aria) => (
              <Select
                {...aria}
                value={templateId}
                onChange={(e) => {
                  setTemplateId(e.target.value);
                  setHeader('');
                  setBody([]);
                  setLinks([]);
                }}
              >
                <option value="">Choose a template</option>
                {available.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.language}, {t.category.toLowerCase()})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {template && template.headerParams > 0 ? (
            <Field id="send-header" label="Header variable {{1}}">
              {(aria) => (
                <Input
                  {...aria}
                  value={header}
                  maxLength={1000}
                  required
                  onChange={(e) => setHeader(e.target.value)}
                />
              )}
            </Field>
          ) : null}
          {bodyValues.map((value, i) => (
            <Field key={i} id={`send-body-${i}`} label={`Body variable {{${i + 1}}}`}>
              {(aria) => (
                <Input
                  {...aria}
                  value={value}
                  maxLength={1000}
                  required
                  onChange={(e) => {
                    const next = [...bodyValues];
                    next[i] = e.target.value;
                    setBody(next);
                  }}
                />
              )}
            </Field>
          ))}
          {template
            ? template.links.map((link, i) => (
                <Field
                  key={`link-${i}`}
                  id={`send-link-${i}`}
                  label={`End of the “${link.text}” link`}
                  description={`Replaces {{1}} in ${link.url}, without spaces.`}
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      value={linkValues[i] ?? ''}
                      maxLength={1000}
                      required
                      onChange={(e) => {
                        const next = [...linkValues];
                        next[i] = e.target.value;
                        setLinks(next);
                      }}
                    />
                  )}
                </Field>
              ))
            : null}
          {template ? (
            <TemplatePreview
              label="Message preview"
              rendered={{
                ...template.preview,
                header: template.preview.header ? fill(template.preview.header, [header]) : null,
                body: fill(template.preview.body, bodyValues),
                buttons: previewButtons(template, linkValues),
              }}
            />
          ) : null}
          <div>
            <Button type="submit" disabled={busy || !template}>
              {busy ? 'Sending…' : 'Send template'}
            </Button>
          </div>
        </>
      )}
    </ClientForm>
  );
}
