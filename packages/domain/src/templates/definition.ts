import { z } from 'zod';

/**
 * Template content as HyFib edits it, and its translation to and from Meta's component format
 * (docs/research/meta-whatsapp.md M-084, M-090 and the official OpenAPI examples: HEADER with
 * `format: TEXT` and `example.header_text`, BODY with `example.body_text`, FOOTER, BUTTONS with
 * QUICK_REPLY / URL / PHONE_NUMBER).
 *
 * Scope: MARKETING and UTILITY templates with an optional text header, positional variables
 * ({{1}}, {{2}} ...), an optional footer and static buttons. Creating media headers (needs the
 * Resumable Upload API and media storage), URL buttons with variables (the example format is not
 * confirmed), named variables, authentication templates, carousels and other component types are
 * not supported yet; synced templates using them are shown but cannot be sent from HyFib. Synced
 * templates with a photo, video or document header are sent only through the API, which gives a
 * link to the file (ADR-201).
 *
 * Length limits below are HyFib guardrails chosen to stay inside Meta's published constraints as
 * far as we know them; they are not a verified statement of Meta's limits (Meta validates on
 * submission and its answer is shown to the member).
 */
export const TEMPLATE_LIMITS = {
  name: 512,
  headerText: 60,
  bodyText: 1024,
  footerText: 60,
  buttonText: 25,
  buttons: 10,
  urlButtons: 2,
  phoneButtons: 1,
  bodyVariables: 20,
  exampleValue: 200,
  url: 2000,
  parameterValue: 1000,
} as const;

export const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
export const TEMPLATE_LANGUAGE_RE = /^[a-z]{2,3}(_[A-Z]{2,4})?$/;

/** Frequently used language codes, offered as suggestions (Meta validates the code on submit). */
export const COMMON_TEMPLATE_LANGUAGES = [
  'en',
  'en_US',
  'en_GB',
  'hi',
  'ta',
  'te',
  'kn',
  'ml',
  'mr',
  'bn',
  'gu',
  'pa',
  'ur',
  'ar',
  'es',
  'pt_BR',
  'fr',
  'de',
  'id',
] as const;

const VARIABLE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export type TemplateButton =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string }
  | { type: 'PHONE_NUMBER'; text: string; phoneNumber: string };

export interface TemplateDefinition {
  category: 'MARKETING' | 'UTILITY';
  header: { type: 'none' } | { type: 'text'; text: string; example: string | null };
  body: { text: string; examples: string[] };
  footer: string | null;
  buttons: TemplateButton[];
}

const trimmed = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} is limited to ${max} characters`);

export const templateDefinitionSchema = z.object({
  category: z.enum(['MARKETING', 'UTILITY']),
  header: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({
      type: z.literal('text'),
      text: trimmed(TEMPLATE_LIMITS.headerText, 'Header'),
      example: z.string().trim().max(TEMPLATE_LIMITS.exampleValue).nullable().default(null),
    }),
  ]),
  body: z.object({
    text: trimmed(TEMPLATE_LIMITS.bodyText, 'Body'),
    examples: z
      .array(z.string().trim().max(TEMPLATE_LIMITS.exampleValue))
      .max(TEMPLATE_LIMITS.bodyVariables)
      .default([]),
  }),
  footer: z
    .string()
    .trim()
    .max(
      TEMPLATE_LIMITS.footerText,
      `Footer is limited to ${TEMPLATE_LIMITS.footerText} characters`,
    )
    .nullable()
    .default(null)
    .transform((v) => (v ? v : null)),
  buttons: z
    .array(
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('QUICK_REPLY'),
          text: trimmed(TEMPLATE_LIMITS.buttonText, 'Button text'),
        }),
        z.object({
          type: z.literal('URL'),
          text: trimmed(TEMPLATE_LIMITS.buttonText, 'Button text'),
          url: z.string().trim().max(TEMPLATE_LIMITS.url),
        }),
        z.object({
          type: z.literal('PHONE_NUMBER'),
          text: trimmed(TEMPLATE_LIMITS.buttonText, 'Button text'),
          phoneNumber: z
            .string()
            .trim()
            .regex(/^\+[1-9][0-9]{6,14}$/, 'Phone buttons need a number like +919876543210'),
        }),
      ]),
    )
    .max(TEMPLATE_LIMITS.buttons, `At most ${TEMPLATE_LIMITS.buttons} buttons`)
    .default([]),
});

export type DefinitionIssue = { path: string; message: string };

/** Positional variable numbers in order of appearance, or an error for other placeholder forms. */
export function positionalVariables(
  text: string,
): { ok: true; numbers: number[] } | { ok: false; message: string } {
  const numbers: number[] = [];
  for (const match of text.matchAll(VARIABLE_RE)) {
    const inner = match[1] ?? '';
    if (!/^[1-9][0-9]?$/.test(inner)) {
      return { ok: false, message: 'Use numbered variables such as {{1}} and {{2}}.' };
    }
    numbers.push(Number(inner));
  }
  return { ok: true, numbers };
}

function variableCount(
  text: string,
  label: string,
  issues: DefinitionIssue[],
  path: string,
): number {
  const vars = positionalVariables(text);
  if (!vars.ok) {
    issues.push({ path, message: `${label}: ${vars.message}` });
    return 0;
  }
  const distinct = [...new Set(vars.numbers)].sort((a, b) => a - b);
  if (distinct.some((n, i) => n !== i + 1)) {
    issues.push({ path, message: `${label}: number variables from {{1}} without gaps.` });
  }
  return distinct.length;
}

/** Validates a definition beyond its shape (variables, examples, button rules). */
export function validateDefinition(def: TemplateDefinition): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  if (def.header.type === 'text') {
    const count = variableCount(def.header.text, 'Header', issues, 'header.text');
    if (count > 1)
      issues.push({ path: 'header.text', message: 'Header: at most one variable ({{1}}).' });
    if (count === 1 && !def.header.example) {
      issues.push({ path: 'header.example', message: 'Header: give an example value for {{1}}.' });
    }
  }
  const bodyCount = variableCount(def.body.text, 'Body', issues, 'body.text');
  if (bodyCount > TEMPLATE_LIMITS.bodyVariables) {
    issues.push({
      path: 'body.text',
      message: `Body: at most ${TEMPLATE_LIMITS.bodyVariables} variables.`,
    });
  }
  if (
    def.body.examples.length < bodyCount ||
    def.body.examples.slice(0, bodyCount).some((e) => !e)
  ) {
    issues.push({
      path: 'body.examples',
      message: 'Body: give an example value for every variable.',
    });
  }
  if (def.footer && /\{\{/.test(def.footer)) {
    issues.push({ path: 'footer', message: 'Footer: variables are not allowed.' });
  }
  const urls = def.buttons.filter((b) => b.type === 'URL');
  const phones = def.buttons.filter((b) => b.type === 'PHONE_NUMBER');
  if (urls.length > TEMPLATE_LIMITS.urlButtons) {
    issues.push({
      path: 'buttons',
      message: `At most ${TEMPLATE_LIMITS.urlButtons} website buttons.`,
    });
  }
  if (phones.length > TEMPLATE_LIMITS.phoneButtons) {
    issues.push({
      path: 'buttons',
      message: `At most ${TEMPLATE_LIMITS.phoneButtons} phone button.`,
    });
  }
  def.buttons.forEach((b, i) => {
    if (/\{\{/.test(b.text))
      issues.push({ path: `buttons.${i}.text`, message: 'Button text cannot contain variables.' });
    if (b.type === 'URL') {
      if (/\{\{/.test(b.url)) {
        issues.push({
          path: `buttons.${i}.url`,
          message: 'Website buttons with variables are not supported yet.',
        });
      } else if (!isHttpsUrl(b.url)) {
        issues.push({
          path: `buttons.${i}.url`,
          message: 'Website buttons need an https:// address.',
        });
      }
    }
  });
  return issues;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** Meta `components` for POST /{waba}/message_templates. */
export function toMetaComponents(def: TemplateDefinition): Record<string, unknown>[] {
  const components: Record<string, unknown>[] = [];
  if (def.header.type === 'text') {
    const hasVariable = /\{\{/.test(def.header.text);
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: def.header.text,
      ...(hasVariable && def.header.example
        ? { example: { header_text: [def.header.example] } }
        : {}),
    });
  }
  const bodyVars = positionalVariables(def.body.text);
  const bodyCount = bodyVars.ok ? new Set(bodyVars.numbers).size : 0;
  components.push({
    type: 'BODY',
    text: def.body.text,
    ...(bodyCount > 0 ? { example: { body_text: [def.body.examples.slice(0, bodyCount)] } } : {}),
  });
  if (def.footer) components.push({ type: 'FOOTER', text: def.footer });
  if (def.buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: def.buttons.map((b) => {
        switch (b.type) {
          case 'QUICK_REPLY':
            return { type: 'QUICK_REPLY', text: b.text };
          case 'URL':
            return { type: 'URL', text: b.text, url: b.url };
          case 'PHONE_NUMBER':
            return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phoneNumber.slice(1) };
        }
      }),
    });
  }
  return components;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Reads Meta components back into an editable definition. Returns null when the template uses
 * anything outside the supported scope (see module comment).
 */
export function fromMetaComponents(
  category: string,
  components: unknown[],
): TemplateDefinition | null {
  if (category !== 'MARKETING' && category !== 'UTILITY') return null;
  const def: TemplateDefinition = {
    category,
    header: { type: 'none' },
    body: { text: '', examples: [] },
    footer: null,
    buttons: [],
  };
  let sawBody = false;
  for (const raw of components) {
    if (!isRec(raw)) return null;
    const type = str(raw.type)?.toUpperCase();
    if (type === 'HEADER') {
      const headerText = str(raw.text);
      if (str(raw.format)?.toUpperCase() !== 'TEXT' || !headerText) return null;
      const example =
        isRec(raw.example) && Array.isArray(raw.example.header_text)
          ? str(raw.example.header_text[0])
          : null;
      def.header = { type: 'text', text: headerText, example };
    } else if (type === 'BODY') {
      const text = str(raw.text);
      if (!text) return null;
      const rows =
        isRec(raw.example) && Array.isArray(raw.example.body_text) ? raw.example.body_text : [];
      const first: unknown[] = Array.isArray(rows[0]) ? (rows[0] as unknown[]) : [];
      def.body = { text, examples: first.map((v) => (typeof v === 'string' ? v : String(v))) };
      sawBody = true;
    } else if (type === 'FOOTER') {
      def.footer = str(raw.text);
    } else if (type === 'BUTTONS') {
      if (!Array.isArray(raw.buttons)) return null;
      for (const b of raw.buttons) {
        if (!isRec(b)) return null;
        const bType = str(b.type)?.toUpperCase();
        const text = str(b.text);
        if (!text) return null;
        const url = str(b.url);
        const phone = str(b.phone_number);
        if (bType === 'QUICK_REPLY') def.buttons.push({ type: 'QUICK_REPLY', text });
        else if (bType === 'URL' && url && !/\{\{/.test(url)) {
          def.buttons.push({ type: 'URL', text, url });
        } else if (bType === 'PHONE_NUMBER' && phone) {
          def.buttons.push({
            type: 'PHONE_NUMBER',
            text,
            phoneNumber: `+${phone.replace(/^\+/, '')}`,
          });
        } else return null;
      }
    } else {
      return null;
    }
  }
  if (!sawBody) return null;
  if (
    validateDefinition(def).some((i) => !i.path.endsWith('examples') && !i.path.endsWith('example'))
  ) {
    return null;
  }
  return def;
}

/**
 * The files a template's header can hold that a send gives by link (ADR-201), as the send's header
 * parameter names them (research M-195: `image`, `video` and `document` parameters, each a media
 * object without a caption).
 */
export const TEMPLATE_HEADER_MEDIA = ['image', 'video', 'document'] as const;
export type TemplateHeaderMedia = (typeof TEMPLATE_HEADER_MEDIA)[number];

/** What a template's header file is called. */
export const HEADER_MEDIA_NAMES: Record<TemplateHeaderMedia, string> = {
  image: 'photo',
  video: 'video',
  document: 'document',
};

/**
 * The template's photo, video or document header (HEADER with `format` IMAGE, VIDEO or DOCUMENT)
 * and its other components, or null when it has no such header. Its example file (`header_handle`)
 * is the one shown in review; every send gives its own.
 */
function mediaHeader(
  components: unknown[],
): { media: TemplateHeaderMedia; rest: unknown[] } | null {
  for (const [index, c] of components.entries()) {
    if (!isRec(c) || str(c.type)?.toUpperCase() !== 'HEADER') continue;
    const format = str(c.format)?.toLowerCase();
    const media = TEMPLATE_HEADER_MEDIA.find((m) => m === format);
    if (media) return { media, rest: components.filter((_, i) => i !== index) };
  }
  return null;
}

/** What a send of this template needs: parameter counts, or why HyFib cannot send it yet. */
export type SendSpec =
  | {
      supported: true;
      headerParams: 0 | 1;
      bodyParams: number;
      definition: TemplateDefinition;
      /** The header's file, which every send gives by link (ADR-201), or null. */
      headerMedia: TemplateHeaderMedia | null;
    }
  | { supported: false; reason: string };

/**
 * What a send of the template needs. A photo, video or document header is sendable only when the
 * caller gives its file by link: the API (ADR-201) passes `mediaHeaders`; the inbox, campaigns,
 * automations and store messages do not, and are told why.
 */
export function sendSpecFor(
  category: string,
  components: unknown[],
  options: { mediaHeaders?: boolean } = {},
): SendSpec {
  if (category === 'AUTHENTICATION') {
    return { supported: false, reason: 'Authentication templates are not supported yet.' };
  }
  const header = mediaHeader(components);
  const def = fromMetaComponents(category, header ? header.rest : components);
  if (!def) {
    return {
      supported: false,
      reason:
        'This template uses content HyFib cannot send yet (for example a location header or a button with a variable).',
    };
  }
  const headerVariables =
    def.header.type === 'text'
      ? positionalVariables(def.header.text)
      : { ok: true as const, numbers: [] };
  const body = positionalVariables(def.body.text);
  if (!headerVariables.ok || !body.ok)
    return { supported: false, reason: 'This template uses named variables.' };
  if (header && !options.mediaHeaders) {
    return {
      supported: false,
      reason: `This template has a ${HEADER_MEDIA_NAMES[header.media]} header: HyFib sends such templates only through the API, which gives a link to the file.`,
    };
  }
  return {
    supported: true,
    headerParams: new Set(headerVariables.numbers).size > 0 ? 1 : 0,
    bodyParams: new Set(body.numbers).size,
    definition: def,
    headerMedia: header?.media ?? null,
  };
}

export const templateParamsSchema = z.object({
  header: z
    .array(z.string().trim().min(1, 'Fill in every variable').max(TEMPLATE_LIMITS.parameterValue))
    .max(1)
    .default([]),
  body: z
    .array(z.string().trim().min(1, 'Fill in every variable').max(TEMPLATE_LIMITS.parameterValue))
    .max(TEMPLATE_LIMITS.bodyVariables)
    .default([]),
});
export type TemplateParams = z.infer<typeof templateParamsSchema>;

function substitute(text: string, values: readonly string[]): string {
  return text.replace(VARIABLE_RE, (_, n: string) => values[Number(n) - 1] ?? `{{${n}}}`);
}

/**
 * The `template` object of a Cloud API send (TemplateObject in the official spec: `language`
 * requires `policy: deterministic`; text parameters per component; a header's file as a media
 * parameter, research M-195) and the rendered text stored with the message so the conversation
 * shows what was sent, with the header's file when it has one.
 */
export function buildTemplateSend(
  template: { name: string; language: string },
  spec: Extract<SendSpec, { supported: true }>,
  params: TemplateParams,
  options: {
    /**
     * Payloads for quick-reply buttons by their zero-based position among the template's buttons
     * (research M-177); a tap returns the payload in the reply (M-178).
     */
    quickReplyPayloads?: ReadonlyMap<number, string>;
    /** The link to the header's file, for a template with a photo, video or document header. */
    headerMediaLink?: string;
  } = {},
): {
  template: Record<string, unknown>;
  rendered: RenderedTemplate;
  headerMedia: { type: TemplateHeaderMedia; link: string } | null;
} {
  if (params.header.length !== spec.headerParams || params.body.length !== spec.bodyParams) {
    throw new Error('Template parameter count mismatch');
  }
  if ((spec.headerMedia === null) !== (options.headerMediaLink === undefined)) {
    throw new Error(
      spec.headerMedia ? 'The template’s header needs a link' : 'The template has no media header',
    );
  }
  const def = spec.definition;
  const components: Record<string, unknown>[] = [];
  const headerMedia =
    spec.headerMedia && options.headerMediaLink !== undefined
      ? { type: spec.headerMedia, link: options.headerMediaLink }
      : null;
  if (headerMedia) {
    components.push({
      type: 'header',
      parameters: [{ type: headerMedia.type, [headerMedia.type]: { link: headerMedia.link } }],
    });
  }
  if (spec.headerParams === 1) {
    components.push({ type: 'header', parameters: [{ type: 'text', text: params.header[0] }] });
  }
  if (spec.bodyParams > 0) {
    components.push({
      type: 'body',
      parameters: params.body.map((text) => ({ type: 'text', text })),
    });
  }
  for (const [index, payload] of [...(options.quickReplyPayloads ?? new Map())].sort(
    ([a], [b]) => a - b,
  )) {
    if (def.buttons[index]?.type !== 'QUICK_REPLY') {
      throw new Error(`Button ${index} of the template is not a quick reply`);
    }
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(index),
      parameters: [{ type: 'payload', payload }],
    });
  }
  return {
    template: {
      name: template.name,
      language: { policy: 'deterministic', code: template.language },
      ...(components.length > 0 ? { components } : {}),
    },
    rendered: {
      header: def.header.type === 'text' ? substitute(def.header.text, params.header) : null,
      body: substitute(def.body.text, params.body),
      footer: def.footer,
      buttons: def.buttons.map((b) => ({ type: b.type, text: b.text })),
    },
    headerMedia,
  };
}

export interface RenderedTemplate {
  header: string | null;
  body: string;
  footer: string | null;
  buttons: { type: TemplateButton['type']; text: string }[];
}

/** The template's text with its {{n}} placeholders (filled in by the sender as values are typed). */
export function renderPlaceholders(def: TemplateDefinition): RenderedTemplate {
  return {
    header: def.header.type === 'text' ? def.header.text : null,
    body: def.body.text,
    footer: def.footer,
    buttons: def.buttons.map((b) => ({ type: b.type, text: b.text })),
  };
}

/** Preview of a definition with its example values (editor and template list). */
export function renderExample(def: TemplateDefinition): RenderedTemplate {
  return {
    header:
      def.header.type === 'text'
        ? substitute(def.header.text, def.header.example ? [def.header.example] : [])
        : null,
    body: substitute(def.body.text, def.body.examples),
    footer: def.footer,
    buttons: def.buttons.map((b) => ({ type: b.type, text: b.text })),
  };
}
