import { z } from 'zod';
import { AppError, clipText, isAppError, jsonbSize, jsonbText, notFound, uuidv7 } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  asc,
  channelAccounts,
  commerceCatalogs,
  commerceProducts,
  contactIdentities,
  contactTags,
  contacts,
  conversations,
  eq,
  inArray,
  isNotNull,
  isNull,
  mediaObjects,
  messageTemplates,
  messages,
  sendIntents,
  sql,
  suppressions,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { endRunForHuman } from '../automations/runs';
import { lockCampaignSends, marketingCapReached } from '../campaigns/frequency-cap';
import {
  COMMERCE_LIMITS,
  productInteractive,
  type ResolvedProductMessage,
} from '../commerce/model';
import { checkTemplateEligibility, recordConsentEvents } from '../consent/service';
import {
  MAX_TAGS_PER_CONTACT,
  normalizeEmail,
  validDate,
  type AttributeValue,
} from '../contacts/fields';
import { normalizePhone, phoneFromWaId, waRecipientFromPhone } from '../contacts/phone';
import { contactForPhone } from '../contacts/service';
import { emitTenantEvent } from '../messaging/events';
import { REPLY_FILE_TYPES, UPLOADED_MEDIA_LIFETIME_MS } from '../messaging/file-replies';
import {
  INTERACTIVE_LIMITS,
  RESERVED_REPLY_ID_PREFIX,
  isReservedReplyId,
  listContent,
  listInteractive,
  replyButtonsContent,
  replyButtonsInteractive,
} from '../messaging/interactive';
import { INBOUND_CONTENT_BUDGET } from '../messaging/meta-webhook';
import { SERVICE_WINDOW_MS, type OutboundDeps } from '../messaging/outbound';
import {
  answeredJoin,
  answeredMessages,
  answerProblem,
  isSingleEmoji,
} from '../messaging/reply-context';
import { STATUS_RANK } from '../messaging/status';
import { loadEntitlements } from '../plans/entitlements';
import {
  buildTemplateSend,
  HEADER_MEDIA_NAMES,
  sendSpecFor,
  TEMPLATE_LIMITS,
  type SendSpec,
  type TemplateHeaderMedia,
  type TemplateParams,
} from '../templates/definition';
import { decodeKeysetCursor, likePattern, parseInput } from '../validation';
import { apiContactById, apiContactNotFound, toApiContact, type ApiContact } from './contact-view';
import {
  apiContactFieldFiltersSchema,
  apiContactPage,
  apiContactFieldsSchema,
  apiContactListFilters,
  apiFieldChanges,
  apiFieldFilters,
  apiTags,
  contactListQuery,
} from './contacts';
import { apiActor, assertAnyScope, assertScope, type ApiContext } from './context';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';
import { API_LIMITS, API_SEND_SCOPES } from './model';

/**
 * The resources of the public API v1 (ADR-052). The zod schemas below validate requests and are
 * also the source of the OpenAPI document, so the two cannot drift apart.
 */

export const phoneField = z
  .string({ error: 'Give the phone number' })
  .max(40)
  .describe('The number with its country code, starting with + (for example +919876543210).');

export const apiContactCreateSchema = z
  .object({
    phone: phoneField,
    name: z.string().trim().max(200).optional().describe('The contact’s name.'),
    email: z.string().trim().max(254).optional().describe('An email address.'),
    tags: z
      .array(z.string().max(40))
      .max(20)
      .optional()
      .describe('Tags to add (lower-cased; commas are not allowed).'),
    fields: apiContactFieldsSchema.optional(),
  })
  .strict();

export const apiContactListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    phone: z.string().max(40).optional().describe('Only the contact with this number.'),
    email: z.string().max(254).optional().describe('Only contacts with this email address.'),
    name: z.string().max(200).optional().describe('Only contacts whose name contains this text.'),
    tag: z.string().max(40).optional().describe('Only contacts with this tag.'),
    fields: apiContactFieldFiltersSchema.optional(),
  })
  .strict();

export const apiConsentSchema = z
  .object({
    purpose: z.enum(['marketing', 'utility']),
    action: z.enum(['opt_in', 'opt_out']),
    evidence: z
      .string({ error: 'Say how the contact gave or withdrew consent' })
      .trim()
      .min(1, 'Say how the contact gave or withdrew consent')
      .max(500)
      .describe(
        'How the contact gave or withdrew consent, for example "Checkout form on example.com".',
      ),
  })
  .strict();

/** The media a message can carry from a link (ADR-194), as WhatsApp's message `type` names it. */
export const API_MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const;
export type ApiMediaType = (typeof API_MEDIA_TYPES)[number];

/** A link WhatsApp may fetch media from (ADR-194): https, with a host, and no user name or password. */
export function isMediaLink(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password;
}

const mediaLinkField = z
  .string({ error: 'Give the link to the media' })
  .trim()
  .min(1, 'Give the link to the media')
  .max(API_LIMITS.mediaLinkLength, `Links are limited to ${API_LIMITS.mediaLinkLength} characters`)
  .refine(isMediaLink, 'Give an https:// link to the media, without a user name or password')
  .describe(
    'An https:// link WhatsApp fetches the media from when it sends the message: it must be reachable from the internet without signing in. HyFib neither fetches nor keeps the media.',
  );

const variableValue = z.string().trim().min(1).max(TEMPLATE_LIMITS.parameterValue);

/** The values of a template's variables, as a send gives them. */
const templateVariablesField = z
  .object({
    header: z.array(variableValue).max(1).default([]),
    body: z.array(variableValue).max(TEMPLATE_LIMITS.bodyVariables).default([]),
  })
  .strict()
  .default({ header: [], body: [] })
  .describe('Values for the template’s {{1}}, {{2}}… in order.');

/** The file of a template's photo, video or document header (ADR-201), from a link (ADR-194). */
const headerMediaField = z
  .object({ link: mediaLinkField })
  .strict()
  .optional()
  .describe(
    'The file of the template’s photo, video or document header (its `headerMedia` in GET /templates), for templates with one: WhatsApp fetches it from the link when it sends the message, and shows it without a caption. Documents must be PDF files. Leave it out for other templates.',
  );

/** The number a template is sent from. */
const templateFromField = z
  .uuid()
  .optional()
  .describe(
    'The id of the WhatsApp number to send from; optional when the company has one active number.',
  );

export const apiSendMessageSchema = z
  .object({
    type: z.literal('template').optional().describe('`template`, the default.'),
    to: phoneField,
    templateId: z.uuid().describe('A template id from GET /api/v1/templates.'),
    from: templateFromField,
    variables: templateVariablesField,
    headerMedia: headerMediaField,
  })
  .strict();

/** Sending one template to many numbers in one call (ADR-163), each with its own variables. */
export const apiSendManyTemplatesSchema = z
  .object({
    templateId: z.uuid().describe('A template id from GET /api/v1/templates.'),
    from: templateFromField,
    messages: z
      .array(
        z
          .object({
            to: phoneField,
            variables: templateVariablesField,
            headerMedia: headerMediaField,
          })
          .strict(),
      )
      .min(1, 'Give at least one number to send to')
      .max(
        API_LIMITS.messagesPerSend,
        `At most ${API_LIMITS.messagesPerSend} messages are sent in one call`,
      )
      .describe(
        `The numbers to send the template to, each with the values of its variables and, for a template with a photo, video or document header, its file, at most ${API_LIMITS.messagesPerSend}; each number once.`,
      ),
  })
  .strict();

/** The number a reply is sent from (ADR-070). */
const replyFromField = z
  .uuid()
  .optional()
  .describe(
    'The id of the WhatsApp number the contact wrote to; optional when the company has one active number.',
  );

/** The message a reply quotes (ADR-082), checked against the conversation when sending. */
const quoteField = z
  .uuid({ error: 'Give the id of a message in this conversation' })
  .optional()
  .describe(
    'The id of a message in the conversation to quote, from GET /conversations/{id}/messages, the message.received webhook or a send’s response: WhatsApp shows it above the reply. A message the contact sent, or one the business sent that WhatsApp accepted and that did not fail; not a reaction or a WhatsApp notice.',
  );

/** A free-form text reply to a contact who wrote in the last 24 hours (ADR-070). */
export const apiSendTextSchema = z
  .object({
    type: z.literal('text'),
    to: phoneField,
    from: replyFromField,
    replyTo: quoteField,
    text: z
      .string({ error: 'Give the text' })
      .trim()
      .min(1, 'Give the text')
      .max(
        API_LIMITS.textLength,
        `Text messages are limited to ${API_LIMITS.textLength} characters`,
      )
      .describe('The message.'),
    previewUrl: z
      .boolean()
      .default(false)
      .describe('Whether WhatsApp may show a preview of the first link in the text.'),
  })
  .strict();

const captionField = z
  .string({ error: 'Give the caption as text' })
  .trim()
  .min(1, 'Give the caption, or leave it out')
  .max(API_LIMITS.captionLength, `Captions are limited to ${API_LIMITS.captionLength} characters`)
  .optional()
  .describe('Text shown with the media.');

const mediaIdField = z
  .uuid({ error: 'Give the id POST /media answered for the file' })
  .optional()
  .describe(
    'The id `POST /media` answered for a file the company uploaded for the number the message is sent from, in the last 30 days. Give it in place of `link`.',
  );

/** A message's media: a link WhatsApp fetches, or a file uploaded for the number (ADR-219). */
const mediaFrame = {
  to: phoneField,
  from: replyFromField,
  replyTo: quoteField,
  link: mediaLinkField.optional(),
  mediaId: mediaIdField,
};

/** Exactly one of `link` and `mediaId`. */
const oneMediaSource = (value: { link?: string | undefined; mediaId?: string | undefined }) =>
  (value.link === undefined) !== (value.mediaId === undefined);
const ONE_MEDIA_SOURCE = {
  message: 'Give the link to the media, or the id of a file you uploaded, but not both.',
  path: ['link'],
};

/** A photo WhatsApp fetches from a link (ADR-194), or uploaded for the number (ADR-219). */
export const apiSendImageSchema = z
  .object({ type: z.literal('image'), ...mediaFrame, caption: captionField })
  .strict()
  .refine(oneMediaSource, ONE_MEDIA_SOURCE);
/** A video WhatsApp fetches from a link (ADR-194), or uploaded for the number (ADR-219). */
export const apiSendVideoSchema = z
  .object({ type: z.literal('video'), ...mediaFrame, caption: captionField })
  .strict()
  .refine(oneMediaSource, ONE_MEDIA_SOURCE);
/** Audio from a link (ADR-194) or uploaded for the number (ADR-219), without a caption. */
export const apiSendAudioSchema = z
  .object({ type: z.literal('audio'), ...mediaFrame })
  .strict()
  .refine(oneMediaSource, ONE_MEDIA_SOURCE);
/** A document WhatsApp fetches from a link (ADR-194), or uploaded for the number (ADR-219). */
export const apiSendDocumentSchema = z
  .object({ type: z.literal('document'), ...mediaFrame, caption: captionField })
  .strict()
  .refine(oneMediaSource, ONE_MEDIA_SOURCE);
/** A sticker WhatsApp fetches from a link (ADR-198), without a caption; never uploaded. */
export const apiSendStickerSchema = z
  .object({
    type: z.literal('sticker'),
    to: phoneField,
    from: replyFromField,
    replyTo: quoteField,
    link: mediaLinkField,
  })
  .strict();

/**
 * A photo, video, audio, document or sticker WhatsApp fetches from a link, to a contact who wrote
 * in the last 24 hours (ADR-194, ADR-198); audio and stickers take no caption.
 */
export const apiSendMediaSchema = z.discriminatedUnion('type', [
  apiSendImageSchema,
  apiSendVideoSchema,
  apiSendAudioSchema,
  apiSendDocumentSchema,
  apiSendStickerSchema,
]);

/** What the conversation shows for media without a caption (ADR-194). */
const MEDIA_PREVIEWS: Record<ApiMediaType, string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  sticker: 'Sticker',
};

/**
 * A coordinate as the decimal degrees Meta's spec types as a string (research M-192), never in
 * exponent notation, which JavaScript uses for numbers under a millionth (`1e-7`).
 */
export function decimalDegrees(value: number): string {
  const plain = String(value);
  return /e/i.test(plain) ? value.toFixed(20).replace(/\.?0+$/, '') : plain;
}

const coordinateField = (
  name: 'latitude' | 'longitude',
  bound: number,
  ends: readonly [string, string],
) =>
  z
    .number({ error: `Give the ${name} as a number of degrees` })
    .min(-bound, `A ${name} runs from -${bound} to ${bound} degrees`)
    .max(bound, `A ${name} runs from -${bound} to ${bound} degrees`)
    .describe(
      `The ${name} in decimal degrees, from -${bound} (${ends[0]}) to ${bound} (${ends[1]}).`,
    );

const placeTextField = (what: 'name' | 'address') =>
  z
    .string({ error: `Give the ${what} as text` })
    .trim()
    .min(1, `Give the ${what}, or leave it out`)
    .max(
      API_LIMITS.locationTextLength,
      `A location’s ${what} is limited to ${API_LIMITS.locationTextLength} characters`,
    )
    .optional();

/**
 * A location, to a contact who wrote in the last 24 hours (ADR-195): its coordinates, and the
 * place's name and address if given, as Meta's spec sends one (research M-192).
 */
export const apiSendLocationSchema = z
  .object({
    type: z.literal('location'),
    to: phoneField,
    from: replyFromField,
    replyTo: quoteField,
    latitude: coordinateField('latitude', 90, ['south', 'north']),
    longitude: coordinateField('longitude', 180, ['west', 'east']),
    name: placeTextField('name').describe('The name of the place, such as a shop’s.'),
    address: placeTextField('address').describe('The address of the place.'),
  })
  .strict();

/** The kinds of a contact card's phone, email, link or address, as Meta's spec names them (M-193). */
export const CONTACT_CARD_TYPES = ['HOME', 'WORK'] as const;

const cardTypeField = z
  .enum(CONTACT_CARD_TYPES, { error: 'Use HOME or WORK' })
  .optional()
  .describe('HOME or WORK.');

const cardTextField = (what: string, max: number = API_LIMITS.contactCardTextLength) =>
  z
    .string({ error: `Give the ${what} as text` })
    .trim()
    .min(1, `Give the ${what}, or leave it out`)
    .max(max, `A contact card’s ${what} is limited to ${max} characters`);

const cardListField = <T extends z.ZodType>(item: T, what: string) =>
  z
    .array(item)
    .min(1, `Give at least one ${what}, or leave them out`)
    .max(
      API_LIMITS.contactCardEntries,
      `A contact gives at most ${API_LIMITS.contactCardEntries} ${what}s`,
    )
    .optional();

/** A link a contact card gives (ADR-197): http or https, with a host, without credentials. */
export function isCardLink(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.hostname !== '' &&
    !url.username &&
    !url.password
  );
}

const CARD_NAME_PARTS = ['firstName', 'lastName', 'middleName', 'prefix', 'suffix'] as const;
const CARD_ADDRESS_PARTS = ['street', 'city', 'state', 'zip', 'country', 'countryCode'] as const;

/**
 * A contact a contact card shares (ADR-197), in the API's words, as Meta's spec sends one (research
 * M-193): a name with at least one part besides the formatted name, and if wanted phones, emails,
 * links and addresses (up to 5 of each), the organisation and the birthday.
 */
export const apiContactCardInputSchema = z
  .object({
    name: z
      .object({
        formattedName: cardTextField('formatted name').describe('The name as the card shows it.'),
        firstName: cardTextField('first name').optional(),
        lastName: cardTextField('last name').optional(),
        middleName: cardTextField('middle name').optional(),
        prefix: cardTextField('prefix').optional(),
        suffix: cardTextField('suffix').optional(),
      })
      .strict()
      .refine((name) => CARD_NAME_PARTS.some((part) => name[part] !== undefined), {
        message: 'Give a first name, a last name or another part of the name too',
        path: ['firstName'],
      })
      .describe('The formatted name and at least one other part of the name.'),
    phones: cardListField(
      z
        .object({
          phone: cardTextField('phone number', 64)
            .regex(/\d/, 'Give a phone number with digits')
            .describe('The number as the card should show it, such as +91 98765 43210.'),
          type: cardTypeField,
          waId: z
            .string({ error: 'Give the WhatsApp id as digits' })
            .regex(/^\d{6,20}$/, 'A WhatsApp id is 6 to 20 digits')
            .optional()
            .describe('The WhatsApp id of the number, if it has one.'),
        })
        .strict(),
      'phone number',
    ),
    emails: cardListField(
      z
        .object({
          email: cardTextField('email address', 254).refine(
            (email) => normalizeEmail(email).ok,
            'Give a valid email address',
          ),
          type: cardTypeField,
        })
        .strict(),
      'email address',
    ),
    urls: cardListField(
      z
        .object({
          url: cardTextField('link', API_LIMITS.mediaLinkLength).refine(
            isCardLink,
            'Give an http:// or https:// link, without a user name or password',
          ),
          type: cardTypeField,
        })
        .strict(),
      'link',
    ),
    addresses: cardListField(
      z
        .object({
          street: cardTextField('street').optional(),
          city: cardTextField('city').optional(),
          state: cardTextField('state').optional(),
          zip: cardTextField('postal code').optional(),
          country: cardTextField('country').optional(),
          countryCode: z
            .string({ error: 'Give the country code as two letters' })
            .regex(/^[A-Za-z]{2}$/, 'Give the country code as two letters, such as IN')
            .optional(),
          type: cardTypeField,
        })
        .strict()
        .refine((address) => CARD_ADDRESS_PARTS.some((part) => address[part] !== undefined), {
          message: 'Give at least one part of the address',
        }),
      'address',
    ),
    org: z
      .object({
        company: cardTextField('company').optional(),
        department: cardTextField('department').optional(),
        title: cardTextField('job title').optional(),
      })
      .strict()
      .refine((org) => [org.company, org.department, org.title].some((v) => v !== undefined), {
        message: 'Give the company, the department or the job title, or leave it out',
      })
      .optional(),
    birthday: z
      .string({ error: 'Give the birthday as YYYY-MM-DD' })
      .refine(validDate, 'Give the birthday as a date that exists, written YYYY-MM-DD')
      .optional()
      .describe('YYYY-MM-DD.'),
  })
  .strict();

export type ApiContactCardInput = z.infer<typeof apiContactCardInputSchema>;

/** Contact cards, to a contact who wrote in the last 24 hours (ADR-197). */
export const apiSendContactsSchema = z
  .object({
    type: z.literal('contacts'),
    to: phoneField,
    from: replyFromField,
    replyTo: quoteField,
    contacts: z
      .array(apiContactCardInputSchema)
      .min(1, 'Give at least one contact')
      .max(
        API_LIMITS.contactsPerCard,
        `A message shares at most ${API_LIMITS.contactsPerCard} contacts`,
      )
      .describe(`The contacts to share, 1 to ${API_LIMITS.contactsPerCard}.`),
  })
  .strict();

const defined = (entries: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

/**
 * A contact as Meta's spec sends it (research M-193), and as HyFib keeps received ones: the same
 * parts in WhatsApp's words, those not given left out (ADR-197).
 */
export function whatsappContact(card: ApiContactCardInput): Record<string, unknown> {
  const { name } = card;
  return defined({
    name: defined({
      formatted_name: name.formattedName,
      first_name: name.firstName,
      last_name: name.lastName,
      middle_name: name.middleName,
      prefix: name.prefix,
      suffix: name.suffix,
    }),
    phones: card.phones?.map((p) => defined({ phone: p.phone, type: p.type, wa_id: p.waId })),
    emails: card.emails?.map((e) => defined({ email: e.email, type: e.type })),
    urls: card.urls?.map((u) => defined({ url: u.url, type: u.type })),
    addresses: card.addresses?.map((a) =>
      defined({
        street: a.street,
        city: a.city,
        state: a.state,
        zip: a.zip,
        country: a.country,
        country_code: a.countryCode,
        type: a.type,
      }),
    ),
    org: card.org
      ? defined({
          company: card.org.company,
          department: card.org.department,
          title: card.org.title,
        })
      : undefined,
    birthday: card.birthday,
  });
}

const LIMITS = INTERACTIVE_LIMITS;

/** Text in a reply buttons or list message, trimmed, within Meta's limit (M-157, M-159, M-179). */
const interactiveText = (label: string, max: number) =>
  z
    .string({ error: `Give the ${label}` })
    .trim()
    .min(1, `Give the ${label}`)
    .max(max, `The ${label} is limited to ${max} characters`);

/**
 * A button's or row's id: the integration's own, returned when the customer taps it. Kept exactly
 * as given (Meta refuses spaces around it), and never one of HyFib's own ids (ADR-080).
 */
const replyIdField = (max: number) =>
  z
    .string({ error: 'Give an id' })
    .min(1, 'Give an id')
    .max(max, `Ids are limited to ${max} characters`)
    .refine((id) => id.trim() === id, 'Ids cannot start or end with a space')
    .refine(
      (id) => !isReservedReplyId(id),
      `Ids cannot start with “${RESERVED_REPLY_ID_PREFIX}”: HyFib’s own buttons use it`,
    );

const interactiveFrame = {
  to: phoneField,
  from: replyFromField,
  replyTo: quoteField,
  header: interactiveText('header', LIMITS.headerLength)
    .optional()
    .describe('Text shown above the body.'),
  body: interactiveText('body', LIMITS.bodyLength).describe('The message.'),
  footer: interactiveText('footer', LIMITS.footerLength)
    .optional()
    .describe('Small text shown below the body.'),
};

/** Adds an issue at each value already seen before it (compared as `key` gives them). */
function refineUnique(
  ctx: z.RefinementCtx,
  values: { path: (string | number)[]; key: string }[],
  message: string,
) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.key)) ctx.addIssue({ code: 'custom', path: value.path, message });
    seen.add(value.key);
  }
}

/** Reply buttons to a contact who wrote in the last 24 hours (ADR-080). */
export const apiSendButtonsSchema = z
  .object({
    type: z.literal('buttons'),
    ...interactiveFrame,
    buttons: z
      .array(
        z
          .object({
            id: replyIdField(LIMITS.buttonIdLength).describe(
              'Returned as `reply.id` in the `message.received` webhook when the customer taps it.',
            ),
            title: interactiveText('button title', LIMITS.buttonTitleLength).describe(
              'The button’s label, different from the others.',
            ),
          })
          .strict(),
      )
      .min(1, 'Give at least one button')
      .max(LIMITS.buttons, `A message has at most ${LIMITS.buttons} buttons`)
      .describe('The buttons, each with its own id and label.'),
  })
  .strict()
  .superRefine((data, ctx) => {
    refineUnique(
      ctx,
      data.buttons.map((b, i) => ({ path: ['buttons', i, 'title'], key: b.title.toLowerCase() })),
      'Give each button a different title',
    );
    refineUnique(
      ctx,
      data.buttons.map((b, i) => ({ path: ['buttons', i, 'id'], key: b.id })),
      'Give each button a different id',
    );
  });

/** A list message to a contact who wrote in the last 24 hours (ADR-080). */
export const apiSendListSchema = z
  .object({
    type: z.literal('list'),
    ...interactiveFrame,
    button: interactiveText('list button', LIMITS.listButtonLength).describe(
      'The label of the button that opens the list.',
    ),
    sections: z
      .array(
        z
          .object({
            title: interactiveText('section title', LIMITS.sectionTitleLength)
              .optional()
              .describe('Required when there is more than one section.'),
            rows: z
              .array(
                z
                  .object({
                    id: replyIdField(LIMITS.rowIdLength).describe(
                      'Returned as `reply.id` in the `message.received` webhook when the customer picks the row.',
                    ),
                    title: interactiveText('row title', LIMITS.rowTitleLength),
                    description: interactiveText('row description', LIMITS.rowDescriptionLength)
                      .optional()
                      .describe('Shown under the row’s title.'),
                  })
                  .strict(),
              )
              .min(1, 'Give each section at least one row')
              .max(LIMITS.rows, `A list has at most ${LIMITS.rows} rows`),
          })
          .strict(),
      )
      .min(1, 'Give at least one section')
      .max(LIMITS.sections, `A list has at most ${LIMITS.sections} sections`)
      .describe(
        `The rows the customer picks from, in sections: at most ${LIMITS.rows} rows in all, each with its own id.`,
      ),
  })
  .strict()
  .superRefine((data, ctx) => {
    const rows = data.sections.flatMap((section, s) =>
      section.rows.map((row, r) => ({ row, path: ['sections', s, 'rows', r] })),
    );
    if (rows.length > LIMITS.rows) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections'],
        message: `A list has at most ${LIMITS.rows} rows in all`,
      });
    }
    if (data.sections.length > 1) {
      data.sections.forEach((section, s) => {
        if (!section.title) {
          ctx.addIssue({
            code: 'custom',
            path: ['sections', s, 'title'],
            message: 'Give each section a title when there is more than one',
          });
        }
      });
    }
    refineUnique(
      ctx,
      rows.map(({ row, path }) => ({ path: [...path, 'id'], key: row.id })),
      'Give each row a different id',
    );
  });

/** The longest emoji accepted, in UTF-16 code units. */
const EMOJI_LENGTH = 32;

/** A reaction to a message the contact sent in the last 30 days (ADR-082). */
export const apiSendReactionSchema = z
  .object({
    type: z.literal('reaction'),
    to: phoneField,
    from: replyFromField,
    replyTo: z
      .uuid({ error: 'Give the id of the contact’s message to react to' })
      .describe(
        'The id of the message to react to: one the contact sent in the last 30 days, from GET /conversations/{id}/messages or the message.received webhook.',
      ),
    emoji: z
      .string({ error: 'Give one emoji, such as 👍' })
      .max(EMOJI_LENGTH, 'Give one emoji, such as 👍')
      .refine(isSingleEmoji, 'Give one emoji, such as 👍')
      .describe(
        'One emoji, such as 👍, from Unicode’s recommended set: skin tones, flags and keycaps count as one.',
      ),
  })
  .strict();

/** A product's content id in a catalog (its retailer id), exactly as Meta keeps it (ADR-086). */
const retailerIdField = z
  .string({ error: 'Give the product’s content id' })
  .min(1, 'Give the product’s content id')
  .max(100, 'Content ids are limited to 100 characters')
  .describe(
    'The product’s content id (its SKU) in the catalog, exactly as Commerce Manager shows it.',
  );

const productFrame = {
  to: phoneField,
  from: replyFromField,
  replyTo: quoteField,
  catalogId: z
    .string()
    .regex(/^[0-9]{1,32}$/, 'Give the Meta catalog id (digits only)')
    .optional()
    .describe(
      'The Meta catalog the products are in; needed only when more than one catalog connected to the WhatsApp number has all the content ids.',
    ),
  footer: interactiveText('footer', COMMERCE_LIMITS.footerLength)
    .optional()
    .describe('Small text shown below the body.'),
};

/** One product from a catalog of the number, to a contact who wrote in the last 24 hours (ADR-086). */
export const apiSendProductSchema = z
  .object({
    type: z.literal('product'),
    ...productFrame,
    retailerId: retailerIdField,
    body: interactiveText('body', COMMERCE_LIMITS.bodyLength)
      .optional()
      .describe('Text shown with the product.'),
  })
  .strict();

/** Up to 30 products in sections, to a contact who wrote in the last 24 hours (ADR-086). */
export const apiSendProductListSchema = z
  .object({
    type: z.literal('product_list'),
    ...productFrame,
    header: interactiveText('header', COMMERCE_LIMITS.headerLength).describe(
      'The heading shown above the products.',
    ),
    body: interactiveText('body', COMMERCE_LIMITS.bodyLength).describe('The message.'),
    sections: z
      .array(
        z
          .object({
            title: interactiveText('section title', COMMERCE_LIMITS.sectionTitleLength)
              .optional()
              .describe('Required when there is more than one section.'),
            retailerIds: z
              .array(retailerIdField)
              .min(1, 'Give each section at least one product')
              .max(
                COMMERCE_LIMITS.productsPerMessage,
                `A message has at most ${COMMERCE_LIMITS.productsPerMessage} products`,
              ),
          })
          .strict(),
      )
      .min(1, 'Give at least one section')
      .max(COMMERCE_LIMITS.sections, `A message has at most ${COMMERCE_LIMITS.sections} sections`)
      .describe(
        `The products, in sections: at most ${COMMERCE_LIMITS.productsPerMessage} in all, each once, all from one catalog.`,
      ),
  })
  .strict()
  .superRefine((data, ctx) => {
    const products = data.sections.flatMap((section, s) =>
      section.retailerIds.map((id, i) => ({ id, path: ['sections', s, 'retailerIds', i] })),
    );
    if (products.length > COMMERCE_LIMITS.productsPerMessage) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections'],
        message: `A message has at most ${COMMERCE_LIMITS.productsPerMessage} products in all`,
      });
    }
    if (data.sections.length > 1) {
      data.sections.forEach((section, s) => {
        if (!section.title) {
          ctx.addIssue({
            code: 'custom',
            path: ['sections', s, 'title'],
            message: 'Give each section a title when there is more than one',
          });
        }
      });
    }
    refineUnique(
      ctx,
      products.map(({ id, path }) => ({ path, key: id })),
      'Give each product once',
    );
  });

/** The number's catalog, opened from a product's picture (ADR-086). */
export const apiSendCatalogSchema = z
  .object({
    type: z.literal('catalog'),
    ...productFrame,
    thumbnailRetailerId: retailerIdField.describe(
      'The content id of the product whose picture the message shows.',
    ),
    body: interactiveText('body', COMMERCE_LIMITS.bodyLength).describe('The message.'),
  })
  .strict();

export interface ApiTemplate {
  id: string;
  name: string;
  language: string;
  category: 'utility' | 'marketing';
  variables: { header: number; body: number };
  /** The file a send gives for the template's header (ADR-201), or null for other headers. */
  headerMedia: TemplateHeaderMedia | null;
  text: { header: string | null; body: string; footer: string | null };
  channels: { id: string; phone: string | null }[];
}

/**
 * The types of the messages the API sends, as a queued send and `GET /messages/{id}` give them:
 * templates, text, reply buttons and lists, reactions, media and stickers from links (ADR-194,
 * ADR-198), locations (ADR-195) and contact cards (ADR-197).
 */
export const API_MESSAGE_TYPES = [
  'template',
  'text',
  'interactive',
  'reaction',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contacts',
] as const;
export type ApiMessageType = (typeof API_MESSAGE_TYPES)[number];

/** A stored message's type as the API gives it; a template is stored as one. */
export function apiMessageType(type: string): ApiMessageType {
  return (API_MESSAGE_TYPES as readonly string[]).includes(type)
    ? (type as ApiMessageType)
    : 'template';
}

export interface ApiMessage {
  id: string;
  type: ApiMessageType;
  status: string;
  statusAt: string;
  to: string | null;
  templateId: string | null;
  templateName: string | null;
  channelId: string;
  contactId: string;
  /** The message it quotes or reacts to, when it is in the conversation (ADR-082). */
  replyTo: string | null;
  error: { code: string | null; title: string | null } | null;
  createdAt: string;
}

export const explicitPhone = (raw: string) => {
  const phone = normalizePhone(raw, { kind: 'explicit' });
  if (!phone.ok)
    throw new AppError('validation_failed', phone.message, {
      issues: [{ path: 'phone', message: phone.message }],
    });
  return phone.e164;
};

/** A number in a list of starts or sends, refused at its place in the list when it is not one. */
export function phoneAt(raw: string, path: string): string {
  const phone = normalizePhone(raw, { kind: 'explicit' });
  if (!phone.ok) {
    throw new AppError('validation_failed', phone.message, {
      issues: [{ path, message: phone.message }],
    });
  }
  return phone.e164;
}

/**
 * Refuses a list of starts or sends that gives a number twice, naming the later place
 * (ADR-161, ADR-163).
 */
export function assertEachNumberOnce(items: readonly { place: string; phone: string }[]): void {
  const firstAt = new Map<string, string>();
  for (const item of items) {
    const earlier = firstAt.get(item.phone);
    if (earlier !== undefined) {
      const message = `Give each number once: ${item.place}.to is the number of ${earlier}.to.`;
      throw new AppError('validation_failed', message, {
        issues: [{ path: `${item.place}.to`, message }],
      });
    }
    firstAt.set(item.phone, item.place);
  }
}

/** Runs work once per idempotency key (when given) in one transaction with it. */
export async function idempotent(
  tx: Tx,
  ctx: ApiContext,
  idempotency: IdempotencyInput | null,
  now: Date,
  work: () => Promise<{ status: number; body: Record<string, unknown> }>,
  /** What is kept for a replay, when not the whole body (a secret is shown once, ADR-081). */
  kept: (body: Record<string, unknown>) => Record<string, unknown> = (body) => body,
): Promise<ApiResponse> {
  let claimed: string | null = null;
  if (idempotency) {
    const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
    if ('replay' in claim) return claim.replay;
    claimed = claim.claimed;
  }
  const result = await work();
  if (claimed) {
    await storeIdempotentResponse(tx, ctx, claimed, {
      status: result.status,
      body: kept(result.body),
    });
  }
  return { ...result, replayed: false };
}

export async function apiListTemplates(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
): Promise<{ data: ApiTemplate[] }> {
  assertScope(ctx, 'templates.read');
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select({
          id: messageTemplates.id,
          name: messageTemplates.name,
          language: messageTemplates.language,
          category: messageTemplates.category,
          components: messageTemplates.components,
          whatsappAccountId: messageTemplates.whatsappAccountId,
        })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.tenantId, ctx.tenant.id),
            eq(messageTemplates.status, 'approved'),
            inArray(messageTemplates.category, ['UTILITY', 'MARKETING']),
          ),
        )
        .orderBy(asc(messageTemplates.name), asc(messageTemplates.language));
      const numbers = await tx
        .select({
          id: channelAccounts.id,
          phone: channelAccounts.displayPhoneNumber,
          whatsappAccountId: channelAccounts.whatsappAccountId,
        })
        .from(channelAccounts)
        .where(
          and(eq(channelAccounts.tenantId, ctx.tenant.id), eq(channelAccounts.status, 'active')),
        );
      const data: ApiTemplate[] = [];
      for (const t of rows) {
        // Templates with a photo, video or document header are listed: a send gives the file
        // (ADR-201).
        const spec = sendSpecFor(t.category, t.components, { mediaHeaders: true });
        if (!spec.supported) continue;
        const definition = spec.definition;
        data.push({
          id: t.id,
          name: t.name,
          language: t.language,
          category: t.category === 'MARKETING' ? 'marketing' : 'utility',
          variables: { header: spec.headerParams, body: spec.bodyParams },
          headerMedia: spec.headerMedia,
          text: {
            header: definition.header.type === 'text' ? definition.header.text : null,
            body: definition.body.text,
            footer: definition.footer ?? null,
          },
          channels: numbers
            .filter((n) => n.whatsappAccountId === t.whatsappAccountId)
            .map((n) => ({ id: n.id, phone: n.phone })),
        });
      }
      return { data };
    },
    { accessMode: 'read only' },
  );
}

/**
 * The company's contacts newest first on exact keyset pages, found by number, email address, tag
 * and custom field values (ADR-113) and part of the name (ADR-124), all of which a contact must
 * match. A page filtered by name, tag or field reads at most API_CONTACT_SEARCH_WINDOW contacts:
 * when the filters leave out most of them it shows fewer than the limit, or none, and its cursor
 * continues after the last one it read. Both reads see one snapshot.
 */
export async function apiListContacts(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiContact[]; nextCursor: string | null }> {
  assertScope(ctx, 'contacts.read');
  const q = parseInput(apiContactListQuerySchema, contactListQuery(query));
  const cursor = decodeKeysetCursor(q.cursor);
  const phone = q.phone ? explicitPhone(q.phone) : null;
  const { email, tag, name } = apiContactListFilters(q);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const filters = await apiFieldFilters(tx, ctx.tenant.id, q.fields ?? {});
      if (tag) {
        filters.push(sql`exists (select 1 from app.contact_tags t where t.tenant_id = ${contacts.tenantId}
          and t.contact_id = ${contacts.id} and t.tag = ${tag})`);
      }
      // As members' search compares names: letters whatever their case, the text as written.
      if (name) filters.push(sql`${contacts.displayName} ilike ${likePattern(name)}`);
      return apiContactPage(tx, ctx.tenant.id, {
        cursor,
        limit: q.limit,
        narrow: [
          phone ? eq(contacts.phoneE164, phone) : undefined,
          email ? sql`lower(${contacts.email}) = lower(${email})` : undefined,
        ],
        filters,
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function apiGetContact(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  contactId: string,
): Promise<ApiContact> {
  assertScope(ctx, 'contacts.read');
  if (!z.uuid().safeParse(contactId).success) throw notFound('Contact');
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const row = await apiContactById(tx, ctx.tenant.id, contactId);
      if (!row) throw await apiContactNotFound(tx, ctx.tenant.id, contactId);
      return toApiContact(row);
    },
    { accessMode: 'read only' },
  );
}

/**
 * Creates a contact, or answers with the existing one for the number (200 instead of 201); a
 * name, email or custom field values given for an existing contact fill only what is empty, and
 * tags are added (50 at most per contact, as members keep them).
 */
export async function apiCreateContact(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'contacts.write');
  const data = parseInput(apiContactCreateSchema, input);
  const phone = explicitPhone(data.phone);
  const email = normalizeEmail(data.email ?? '');
  if (!email.ok) throw new AppError('validation_failed', email.message);
  const tags = apiTags(data.tags ?? [], 'tags');
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      // Values only: an empty string, which clears a value elsewhere, gives none here.
      const values: Record<string, AttributeValue> = {};
      for (const [key, value] of Object.entries(
        await apiFieldChanges(tx, ctx.tenant.id, data.fields ?? {}),
      )) {
        if (value !== null) values[key] = value;
      }
      const [suppressed] = await tx
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(and(eq(suppressions.tenantId, ctx.tenant.id), eq(suppressions.phoneE164, phone)))
        .limit(1);
      if (suppressed) {
        throw new AppError(
          'precondition_failed',
          'This number is on the company’s suppression list, so no contact is created for it.',
        );
      }
      const [inserted] = await tx
        .insert(contacts)
        .values({
          id: uuidv7(),
          tenantId: ctx.tenant.id,
          displayName: data.name || null,
          phoneE164: phone,
          email: email.email,
          attributes: values,
          source: 'api',
        })
        .onConflictDoNothing({
          target: [contacts.tenantId, contacts.phoneE164],
          where: sql`phone_e164 is not null`,
        })
        .returning({ id: contacts.id });
      const id =
        inserted?.id ??
        (
          await tx
            .select({ id: contacts.id })
            .from(contacts)
            .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.phoneE164, phone)))
        )[0]?.id;
      if (!id) throw new Error('Contact with this number vanished during upsert');
      if (!inserted) {
        await tx
          .update(contacts)
          .set({
            displayName: sql`coalesce(${contacts.displayName}, ${data.name || null})`,
            email: sql`coalesce(${contacts.email}, ${email.email})`,
            // The contact's own values win over the request's.
            attributes: sql`${jsonbText(values)}::jsonb || ${contacts.attributes}`,
          })
          .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, id)));
        if (tags.length > 0) {
          const existing = await tx
            .select({ tag: contactTags.tag })
            .from(contactTags)
            .where(and(eq(contactTags.tenantId, ctx.tenant.id), eq(contactTags.contactId, id)));
          const all = new Set([...existing.map((e) => e.tag), ...tags]);
          if (all.size > MAX_TAGS_PER_CONTACT) {
            const message = `A contact can have at most ${MAX_TAGS_PER_CONTACT} tags.`;
            throw new AppError('validation_failed', message, {
              issues: [{ path: 'tags', message }],
            });
          }
        }
      }
      if (tags.length > 0) {
        await tx
          .insert(contactTags)
          .values(
            tags.map((tag) => ({ id: uuidv7(), tenantId: ctx.tenant.id, contactId: id, tag })),
          )
          .onConflictDoNothing();
      }
      if (inserted) {
        await recordSystemAudit(
          tx,
          ctx.tenant.id,
          {
            action: 'contact.created',
            subjectType: 'contact',
            subjectId: id,
            correlationId: ctx.requestId,
            metadata: { source: 'api' },
          },
          apiActor(ctx),
        );
      }
      const row = await apiContactById(tx, ctx.tenant.id, id);
      if (!row) throw new AppError('conflict', 'This contact was erased.');
      return {
        status: inserted ? 201 : 200,
        body: { data: toApiContact(row), created: Boolean(inserted) },
      };
    }),
  );
}

/** Records an opt-in or opt-out with its evidence, as the key (consent source `api`). */
export async function apiRecordConsent(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  contactId: string,
  input: unknown,
): Promise<ApiContact> {
  assertScope(ctx, 'contacts.write');
  if (!z.uuid().safeParse(contactId).success) throw notFound('Contact');
  const data = parseInput(apiConsentSchema, input);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    const [contact] = await tx
      .select({ id: contacts.id, erasedAt: contacts.erasedAt })
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, contactId)))
      .for('update');
    if (!contact || contact.erasedAt) throw await apiContactNotFound(tx, ctx.tenant.id, contactId);
    await recordConsentEvents(tx, [
      {
        tenantId: ctx.tenant.id,
        contactId,
        purpose: data.purpose,
        action: data.action,
        source: 'api',
        evidence: { note: data.evidence, apiKeyId: ctx.key.id },
        actorType: 'api_key',
        actorId: ctx.key.id,
        occurredAt: now,
      },
    ]);
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'consent.recorded',
        subjectType: 'contact',
        subjectId: contactId,
        correlationId: ctx.requestId,
        metadata: { purpose: data.purpose, consentAction: data.action, source: 'api' },
      },
      apiActor(ctx),
    );
    const row = await apiContactById(tx, ctx.tenant.id, contactId);
    if (!row) throw notFound('Contact');
    return toApiContact(row);
  });
}

/**
 * The WhatsApp number a send uses: the one named by `from`, or the company's only active number.
 * Its state is checked by the caller, after checks that name the number's account.
 */
/** The number a key sends from: the one it names, or the company's only active number. */
export async function sendingNumber(tx: Tx, ctx: ApiContext, from: string | undefined) {
  const numbers = await tx
    .select({
      id: channelAccounts.id,
      status: channelAccounts.status,
      whatsappAccountId: channelAccounts.whatsappAccountId,
      phoneNumberId: channelAccounts.phoneNumberId,
    })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, ctx.tenant.id),
        from ? eq(channelAccounts.id, from) : eq(channelAccounts.status, 'active'),
      ),
    );
  const channel = numbers.length === 1 ? numbers[0] : undefined;
  if (!channel) {
    if (from) throw notFound('WhatsApp number');
    throw new AppError(
      'validation_failed',
      numbers.length === 0
        ? 'The company has no active WhatsApp number.'
        : 'The company has several WhatsApp numbers: say which one to send from (from).',
    );
  }
  return channel;
}

/** A template message as a send queues it (ADR-052). */
export interface ApiQueuedTemplate {
  id: string;
  type: 'template';
  status: 'queued';
  contactId: string;
  channelId: string;
  templateId: string;
}

/** What a send to many numbers answers for one number (ADR-163). */
export interface ApiTemplateSend {
  to: string;
  message: ApiQueuedTemplate | null;
  error: { code: 'precondition_failed'; message: string } | null;
}

/**
 * Sends an approved template to a number (the contact is created when new) with the same checks as
 * members' template sends: erasure, suppression, consent for the template's category, the
 * marketing frequency cap, and the template's and number's state. Exactly one send per idempotency
 * key; delivery follows the send pipeline.
 */
export async function apiSendTemplate(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  // The template decides which of the two scopes is needed; a request that may use neither is
  // refused first.
  assertAnyScope(ctx, ['messages.send', 'messages.send_marketing']);
  const data = parseInput(apiSendMessageSchema, input);
  const phone = explicitPhone(data.to);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      const sendable = await loadSendableTemplate(tx, ctx, data.templateId);
      const send = { phone, variables: data.variables, headerMedia: data.headerMedia };
      assertTemplateValues(sendable.spec, send);
      const channel = await templateSendingNumber(tx, ctx, sendable.template, data.from);
      await lockMarketingSends(tx, ctx, sendable.template);
      const message = await queueTemplateFor(deps, tx, ctx, sendable, channel, send, now);
      return { status: 201, body: { data: message } };
    }),
  );
}

/**
 * Sends an approved template to up to 50 numbers in one call (ADR-163), each with its own
 * variables and header file (ADR-201). The template, every send's values and the number sent from
 * are checked once, then
 * each number is sent to as a send to one number is, in a savepoint: a refusal for its contact rolls
 * back to it and is answered in its place while the others are sent. Once per idempotency key.
 */
export async function apiSendManyTemplates(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertAnyScope(ctx, ['messages.send', 'messages.send_marketing']);
  const data = parseInput(apiSendManyTemplatesSchema, input);
  const sends = data.messages.map((message, i) => ({
    place: `messages.${i}`,
    phone: phoneAt(message.to, `messages.${i}.to`),
    variables: message.variables,
    headerMedia: message.headerMedia,
  }));
  assertEachNumberOnce(sends);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      const sendable = await loadSendableTemplate(tx, ctx, data.templateId);
      for (const send of sends) assertTemplateValues(sendable.spec, send, send.place);
      const channel = await templateSendingNumber(tx, ctx, sendable.template, data.from);
      await lockMarketingSends(tx, ctx, sendable.template);
      const answers: ApiTemplateSend[] = [];
      for (const send of sends) {
        const { phone } = send;
        try {
          const message = await tx.transaction((sp) =>
            queueTemplateFor(deps, sp, ctx, sendable, channel, send, now),
          );
          answers.push({ to: phone, message, error: null });
        } catch (error) {
          // Consent, the suppression list and the frequency cap refuse one number; anything else
          // refuses the call.
          if (!isAppError(error) || error.code !== 'precondition_failed') throw error;
          answers.push({
            to: phone,
            message: null,
            error: { code: 'precondition_failed', message: error.publicMessage },
          });
        }
      }
      return { status: 200, body: { data: answers } };
    }),
  );
}

/** An approved template a key may send, with what a send of it needs. */
interface SendableTemplate {
  template: typeof messageTemplates.$inferSelect;
  spec: Extract<SendSpec, { supported: true }>;
}

/** What one send of a template gives: the number, its variables' values and its header's file. */
interface TemplateSendValues {
  phone: string;
  variables: TemplateParams;
  headerMedia?: { link: string } | undefined;
}

/**
 * The template, when it is the company's, approved and one HyFib can send; its category decides the
 * scope the key needs. A template with a photo, video or document header is sendable here, as each
 * send gives its file by link (ADR-201).
 */
async function loadSendableTemplate(
  tx: Tx,
  ctx: ApiContext,
  templateId: string,
): Promise<SendableTemplate> {
  const [template] = await tx
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.tenantId, ctx.tenant.id), eq(messageTemplates.id, templateId)));
  if (!template) throw notFound('Template');
  assertScope(ctx, template.category === 'MARKETING' ? 'messages.send_marketing' : 'messages.send');
  if (template.status !== 'approved') {
    throw new AppError('precondition_failed', 'Only templates approved by Meta can be sent.');
  }
  const spec = sendSpecFor(template.category, template.components, { mediaHeaders: true });
  if (!spec.supported) throw new AppError('unsupported', spec.reason);
  return { template, spec };
}

/**
 * Refuses values that do not fill the template: its variables, and the file of a photo, video or
 * document header, which only a template with one takes (ADR-201). In a list of sends `place`
 * names the send (`messages.3`).
 */
function assertTemplateValues(
  spec: SendableTemplate['spec'],
  { variables, headerMedia }: TemplateSendValues,
  place?: string,
): void {
  const at = (field: string) => (place ? `${place}.${field}` : field);
  if (variables.header.length !== spec.headerParams || variables.body.length !== spec.bodyParams) {
    const message = `This template needs ${spec.headerParams} header and ${spec.bodyParams} body variables.`;
    throw new AppError(
      'validation_failed',
      message,
      place ? { issues: [{ path: at('variables'), message }] } : {},
    );
  }
  if ((spec.headerMedia === null) === (headerMedia === undefined)) return;
  const message = spec.headerMedia
    ? `This template has a ${HEADER_MEDIA_NAMES[spec.headerMedia]} header: give the link to its file.`
    : 'This template has no photo, video or document header, so it takes no file.';
  throw new AppError('validation_failed', message, {
    issues: [{ path: at('headerMedia'), message }],
  });
}

/** The number the template is sent from: of the template's WhatsApp account, and active. */
async function templateSendingNumber(
  tx: Tx,
  ctx: ApiContext,
  template: SendableTemplate['template'],
  from: string | undefined,
) {
  const channel = await sendingNumber(tx, ctx, from);
  if (channel.whatsappAccountId !== template.whatsappAccountId) {
    throw new AppError(
      'validation_failed',
      'This template belongs to another WhatsApp account than the number it would be sent from.',
    );
  }
  if (channel.status !== 'active') {
    throw new AppError('precondition_failed', 'This WhatsApp number is not active.');
  }
  return channel;
}

/**
 * A marketing template is counted under the campaign runner's company lock (ADR-049), taken before
 * any contact is created or conversation locked, by a send to one number as by a send to many
 * (ADR-163), so the two take their locks in one order.
 */
async function lockMarketingSends(
  tx: Tx,
  ctx: ApiContext,
  template: SendableTemplate['template'],
): Promise<void> {
  if (template.category === 'MARKETING') await lockCampaignSends(tx, ctx.tenant.id, 'wait');
}

/**
 * Queues the template for the number: the contact (created when new), erasure, suppression and
 * consent, the marketing frequency cap, then the message, its send intent and its job. A refusal
 * throws; the caller's transaction or savepoint rolls back what it wrote, a contact created for the
 * number included. For a marketing template the caller holds the campaign runner's company lock.
 * The message keeps the header's file link beside the rendered text (ADR-201).
 */
async function queueTemplateFor(
  deps: OutboundDeps,
  tx: Tx,
  ctx: ApiContext,
  { template, spec }: SendableTemplate,
  channel: { id: string; whatsappAccountId: string },
  { phone, variables, headerMedia }: TemplateSendValues,
  now: Date,
): Promise<ApiQueuedTemplate> {
  const contactId = await contactForPhone(tx, ctx.tenant.id, {
    phoneE164: phone,
    displayName: null,
    source: 'api',
  });
  const eligibility = await checkTemplateEligibility(tx, {
    tenantId: ctx.tenant.id,
    contactId,
    recipientPhones: [phone],
    category: template.category,
  });
  if (!eligibility.ok) throw new AppError('precondition_failed', eligibility.message);
  if (
    template.category === 'MARKETING' &&
    (await marketingCapReached(tx, ctx.tenant.id, contactId, now))
  ) {
    throw new AppError(
      'precondition_failed',
      'The contact already received as many marketing messages as the company allows in the period.',
    );
  }
  const [identity] = await tx
    .select({ waId: contactIdentities.waId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.tenantId, ctx.tenant.id),
        eq(contactIdentities.contactId, contactId),
        eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
        isNotNull(contactIdentities.waId),
      ),
    )
    .limit(1);
  const recipient = phoneFromWaId(identity?.waId) ?? phone;
  const built = buildTemplateSend(
    template,
    spec,
    variables,
    headerMedia ? { headerMediaLink: headerMedia.link } : {},
  );

  // A conversation this message starts is resolved, like a campaign's; the reply opens it.
  await tx
    .insert(conversations)
    .values({
      id: uuidv7(),
      tenantId: ctx.tenant.id,
      channelAccountId: channel.id,
      contactId,
      status: 'resolved',
      resolvedAt: now,
    })
    .onConflictDoNothing();
  const [conversation] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, ctx.tenant.id),
        eq(conversations.channelAccountId, channel.id),
        eq(conversations.contactId, contactId),
      ),
    )
    .for('update');
  if (!conversation) throw new Error('Conversation upsert failed');
  const messageId = uuidv7();
  const intentId = uuidv7();
  await tx.insert(messages).values({
    id: messageId,
    tenantId: ctx.tenant.id,
    conversationId: conversation.id,
    channelAccountId: channel.id,
    direction: 'outbound',
    type: 'template',
    content: {
      template: {
        id: template.id,
        name: template.name,
        language: template.language,
        category: template.category,
      },
      rendered: built.rendered,
      ...(built.headerMedia ? { headerMedia: built.headerMedia } : {}),
    },
    status: 'queued',
    statusRank: STATUS_RANK.queued,
    senderType: 'api',
    apiKeyId: ctx.key.id,
    templateId: template.id,
  });
  await tx.insert(sendIntents).values({
    id: intentId,
    tenantId: ctx.tenant.id,
    messageId,
    channelAccountId: channel.id,
    request: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waRecipientFromPhone(recipient),
      type: 'template',
      template: built.template,
    },
    actorUserId: null,
  });
  await tx
    .update(conversations)
    .set({
      lastMessageAt: now,
      lastMessagePreview: clipText(built.rendered.body, 200),
      version: sql`${conversations.version} + 1`,
    })
    .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversation.id)));
  await emitTenantEvent(tx, ctx.tenant.id, {
    type: 'message.created',
    conversationId: conversation.id,
    payload: { messageId },
  });
  await deps.jobs.enqueue(
    tx,
    QUEUES.messageSend.name,
    deps.signer.sign({
      kind: 'message.send',
      tenantId: ctx.tenant.id,
      actorUserId: null,
      ref: intentId,
    }),
    { singletonKey: intentId, group: { id: channel.id } },
  );
  return {
    id: messageId,
    type: 'template',
    status: 'queued',
    contactId,
    channelId: channel.id,
    templateId: template.id,
  };
}

/** The refusal for a number the reply cannot reach (ADR-070). */
const windowClosed = () =>
  new AppError(
    'precondition_failed',
    'This number has not written to this WhatsApp number in the last 24 hours, so only approved templates can be sent to it.',
    { details: { apiReason: 'window_closed' } },
  );

/**
 * The WhatsApp id of the message `messageId` of the conversation, which a reply quotes or a
 * reaction goes on (ADR-082). A message of another conversation is refused as unknown, like one
 * that does not exist.
 */
async function answeredMessage(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  messageId: string,
  options: { kind: 'quote' | 'reaction'; now: Date },
): Promise<string> {
  const [target] = await tx
    .select({
      direction: messages.direction,
      type: messages.type,
      status: messages.status,
      externalMessageId: messages.externalMessageId,
      providerTimestamp: messages.providerTimestamp,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.conversationId, conversationId),
        eq(messages.id, messageId),
      ),
    );
  const problem = target
    ? answerProblem(
        options.kind,
        { ...target, at: target.providerTimestamp ?? target.createdAt },
        options.now,
      )
    : 'Give the id of a message in this conversation.';
  if (problem) {
    throw new AppError('validation_failed', problem, {
      issues: [{ path: 'replyTo', message: problem }],
    });
  }
  if (!target?.externalMessageId) throw new Error('Only messages with a WhatsApp id are answered');
  return target.externalMessageId;
}

/** What a reply stores and sends (ADR-070, ADR-080, ADR-082). */
interface BuiltReply {
  content: Record<string, unknown>;
  preview: string;
  request: Record<string, unknown>;
  /** A file uploaded for the number that the message sends (ADR-219), recorded as its media. */
  media?: { providerMediaId: string; mimeType: string; filename: string | null; sizeBytes: number };
}

interface ApiReply {
  type: 'text' | 'interactive' | 'reaction' | ApiMediaType | 'location' | 'contacts';
  /** The message the reply quotes, or the reaction is for, as the request names it. */
  replyTo: string | undefined;
  /** Checks that do not depend on the number, made first (the plan's modules). */
  precheck?: (tx: Tx) => Promise<void>;
  /**
   * The message's stored content (as the inbox shows it), the conversation's preview, and the
   * Graph request's `type` and its object, given the WhatsApp id of the message named by `replyTo`
   * and the WhatsApp account of the number it is sent from.
   */
  build(
    answered: string | null,
    sending: { tx: Tx; whatsappAccountId: string; channelId: string },
  ): BuiltReply | Promise<BuiltReply>;
}

/**
 * Sends a free-form message to a contact who wrote to the number in the last 24 hours, as the
 * inbox's reply does (ADR-070): text, reply buttons or a list (ADR-080), which may quote a message
 * of the conversation, or a reaction to a message the contact sent (ADR-082). The contact is never
 * created: a number that is not a contact, has no conversation on the number, was erased, or last
 * wrote more than 24 hours ago gets one answer, so the refusal tells a key without `contacts.read`
 * nothing more than a sent reply would. A reply takes the conversation over from an automation
 * handling it (its queued messages are cancelled), but it is not a member's reply: the
 * conversation keeps waiting for a member. A reaction is not an answer: it leaves an automation
 * running. Exactly one send per idempotency key; the window is checked again when the worker sends.
 */
async function sendReply(
  deps: OutboundDeps,
  ctx: ApiContext,
  target: { to: string; from?: string | undefined },
  idempotency: IdempotencyInput,
  reply: ApiReply,
): Promise<ApiResponse> {
  const phone = explicitPhone(target.to);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      if (reply.precheck) await reply.precheck(tx);
      const channel = await sendingNumber(tx, ctx, target.from);
      if (channel.status !== 'active') {
        throw new AppError('precondition_failed', 'This WhatsApp number is not active.');
      }
      const [contact] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, ctx.tenant.id),
            eq(contacts.phoneE164, phone),
            isNull(contacts.erasedAt),
          ),
        );
      if (!contact) throw windowClosed();
      // Locked like a member's reply: serialised with assignments, other replies and the
      // automation's own steps on the conversation.
      const [conversation] = await tx
        .select({ id: conversations.id, lastInboundAt: conversations.lastInboundAt })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, ctx.tenant.id),
            eq(conversations.channelAccountId, channel.id),
            eq(conversations.contactId, contact.id),
          ),
        )
        .for('update');
      if (
        !conversation?.lastInboundAt ||
        now.getTime() - conversation.lastInboundAt.getTime() > SERVICE_WINDOW_MS
      ) {
        throw windowClosed();
      }
      const [identity] = await tx
        .select({ waId: contactIdentities.waId })
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.tenantId, ctx.tenant.id),
            eq(contactIdentities.contactId, contact.id),
            eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
            isNotNull(contactIdentities.waId),
          ),
        )
        .limit(1);
      if (!identity?.waId) {
        throw new AppError(
          'unsupported',
          'This contact wrote from a WhatsApp user id without a phone number. Sending to user ids is not enabled until Meta’s request format is verified.',
        );
      }
      const reaction = reply.type === 'reaction';
      const answered = reply.replyTo
        ? await answeredMessage(tx, ctx.tenant.id, conversation.id, reply.replyTo, {
            kind: reaction ? 'reaction' : 'quote',
            now,
          })
        : null;

      if (!reaction) {
        await endRunForHuman(tx, {
          tenantId: ctx.tenant.id,
          conversationId: conversation.id,
          reason: 'api_replied',
          actorMembershipId: null,
          now,
        });
      }
      const built = await reply.build(answered, {
        tx,
        whatsappAccountId: channel.whatsappAccountId,
        channelId: channel.id,
      });
      const messageId = uuidv7();
      const intentId = uuidv7();
      await tx.insert(messages).values({
        id: messageId,
        tenantId: ctx.tenant.id,
        conversationId: conversation.id,
        channelAccountId: channel.id,
        direction: 'outbound',
        type: reply.type,
        content: built.content,
        status: 'queued',
        statusRank: STATUS_RANK.queued,
        senderType: 'api',
        apiKeyId: ctx.key.id,
        // A quoted reply keeps the quoted message's WhatsApp id as inbound replies do; a
        // reaction keeps it in its content, as inbound reactions do.
        contextExternalId: reaction ? null : answered,
      });
      if (built.media) {
        await tx.insert(mediaObjects).values({
          id: uuidv7(),
          tenantId: ctx.tenant.id,
          messageId,
          providerMediaId: built.media.providerMediaId,
          mimeType: built.media.mimeType,
          filename: built.media.filename,
          sizeBytes: built.media.sizeBytes,
        });
      }
      await tx.insert(sendIntents).values({
        id: intentId,
        tenantId: ctx.tenant.id,
        messageId,
        channelAccountId: channel.id,
        request: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: identity.waId,
          ...(answered && !reaction ? { context: { message_id: answered } } : {}),
          ...built.request,
        },
        actorUserId: null,
      });
      await tx
        .update(conversations)
        .set({
          lastMessageAt: now,
          lastMessagePreview: clipText(built.preview, 200),
          version: sql`${conversations.version} + 1`,
        })
        .where(
          and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversation.id)),
        );
      await emitTenantEvent(tx, ctx.tenant.id, {
        type: 'message.created',
        conversationId: conversation.id,
        payload: { messageId },
      });
      await deps.jobs.enqueue(
        tx,
        QUEUES.messageSend.name,
        deps.signer.sign({
          kind: 'message.send',
          tenantId: ctx.tenant.id,
          actorUserId: null,
          ref: intentId,
        }),
        { singletonKey: intentId, group: { id: channel.id } },
      );
      return {
        status: 201,
        body: {
          data: {
            id: messageId,
            type: reply.type,
            status: 'queued',
            contactId: contact.id,
            channelId: channel.id,
          },
        },
      };
    }),
  );
}

/** A free-form text reply (ADR-070); see `sendReply`. */
export async function apiSendText(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendTextSchema, input);
  return sendReply(deps, ctx, data, idempotency, {
    type: 'text',
    replyTo: data.replyTo,
    build: () => ({
      content: { text: data.text },
      preview: data.text,
      request: { type: 'text', text: { body: data.text, preview_url: data.previewUrl } },
    }),
  });
}

/**
 * A photo, video, audio, document or sticker WhatsApp fetches from an https link (ADR-194,
 * ADR-198); see `sendReply`. HyFib stores the link and the caption, never the media.
 */
export async function apiSendMedia(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendMediaSchema, input);
  const caption = data.type === 'audio' || data.type === 'sticker' ? undefined : data.caption;
  const mediaId = data.type === 'sticker' ? undefined : data.mediaId;
  if (mediaId) {
    return sendReply(deps, ctx, data, idempotency, {
      type: data.type,
      replyTo: data.replyTo,
      build: async (_answered, { tx, channelId }) => {
        const upload = await uploadedFileFor(tx, ctx, mediaId, {
          type: data.type,
          channelId,
          now: deps.clock.now(),
        });
        const media = {
          id: upload.providerMediaId,
          ...(caption ? { caption } : {}),
          // The spec's examples send a document's file name with its id (research M-197).
          ...(data.type === 'document' && upload.filename ? { filename: upload.filename } : {}),
        };
        return {
          content: { ...media, mime_type: upload.mimeType },
          preview: caption ?? MEDIA_PREVIEWS[data.type],
          request: { type: data.type, [data.type]: media },
          media: {
            providerMediaId: upload.providerMediaId,
            mimeType: upload.mimeType,
            filename: data.type === 'document' ? upload.filename : null,
            sizeBytes: upload.sizeBytes,
          },
        };
      },
    });
  }
  const media = { link: data.link ?? '', ...(caption ? { caption } : {}) };
  return sendReply(deps, ctx, data, idempotency, {
    type: data.type,
    replyTo: data.replyTo,
    build: () => ({
      content: media,
      preview: caption ?? MEDIA_PREVIEWS[data.type],
      request: { type: data.type, [data.type]: media },
    }),
  });
}

/**
 * A file the company uploaded through the API (ADR-219) that a message of `type` may send from the
 * number `channelId`: uploaded for that number, of that kind, in the last 30 days.
 */
async function uploadedFileFor(
  tx: Tx,
  ctx: ApiContext,
  mediaId: string,
  send: { type: string; channelId: string; now: Date },
) {
  const [upload] = await tx
    .select({
      providerMediaId: mediaObjects.providerMediaId,
      mimeType: mediaObjects.mimeType,
      filename: mediaObjects.filename,
      sizeBytes: mediaObjects.sizeBytes,
      channelAccountId: mediaObjects.channelAccountId,
      createdAt: mediaObjects.createdAt,
    })
    .from(mediaObjects)
    .where(
      and(
        eq(mediaObjects.tenantId, ctx.tenant.id),
        eq(mediaObjects.id, mediaId),
        isNull(mediaObjects.messageId),
        isNotNull(mediaObjects.apiKeyId),
      ),
    );
  const refuse = (message: string) =>
    new AppError('validation_failed', message, { issues: [{ path: 'mediaId', message }] });
  if (!upload?.providerMediaId || !upload.mimeType)
    throw refuse('No file with this id was uploaded for the company.');
  if (upload.channelAccountId !== send.channelId) {
    throw refuse(
      'This file was uploaded for another WhatsApp number: upload it for the number you send from.',
    );
  }
  const kind = REPLY_FILE_TYPES[upload.mimeType];
  if (kind !== send.type) throw refuse(`This file is sent as type ${kind ?? 'document'}.`);
  if (send.now.getTime() - upload.createdAt.getTime() > UPLOADED_MEDIA_LIFETIME_MS) {
    throw new AppError(
      'precondition_failed',
      'This file was uploaded more than 30 days ago, so WhatsApp no longer keeps it: upload it again.',
      { details: { apiReason: 'file_expired' } },
    );
  }
  return {
    providerMediaId: upload.providerMediaId,
    mimeType: upload.mimeType,
    filename: upload.filename,
    sizeBytes: upload.sizeBytes ?? 0,
  };
}

/**
 * A location (ADR-195); see `sendReply`. The message keeps the coordinates as numbers, as received
 * locations keep theirs; the Graph request gives them as decimal strings, as Meta's spec types them
 * (research M-192).
 */
export async function apiSendLocation(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendLocationSchema, input);
  const place = {
    ...(data.name ? { name: data.name } : {}),
    ...(data.address ? { address: data.address } : {}),
  };
  return sendReply(deps, ctx, data, idempotency, {
    type: 'location',
    replyTo: data.replyTo,
    build: () => ({
      content: { latitude: data.latitude, longitude: data.longitude, ...place },
      preview: data.name ?? data.address ?? 'Location',
      request: {
        type: 'location',
        location: {
          latitude: decimalDegrees(data.latitude),
          longitude: decimalDegrees(data.longitude),
          ...place,
        },
      },
    }),
  });
}

/**
 * Contact cards (ADR-197); see `sendReply`. The message keeps the contacts as the Graph request
 * gives them, in WhatsApp's words, as received cards are kept, so reads give both alike (ADR-196).
 */
export async function apiSendContacts(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendContactsSchema, input);
  const cards = data.contacts.map(whatsappContact);
  // Within the budget received content keeps to, below what the database takes for a message.
  if (jsonbSize({ contacts: cards }) > INBOUND_CONTENT_BUDGET) {
    throw new AppError('validation_failed', 'These contacts are more than a message may hold.', {
      issues: [{ path: 'contacts', message: 'Share fewer contacts, or less about them' }],
    });
  }
  return sendReply(deps, ctx, data, idempotency, {
    type: 'contacts',
    replyTo: data.replyTo,
    build: () => ({
      content: { contacts: cards },
      preview: `Contact card: ${data.contacts.map((c) => c.name.formattedName).join(', ')}`,
      request: { type: 'contacts', contacts: cards },
    }),
  });
}

/** Reply buttons (ADR-080); see `sendReply`. */
export async function apiSendButtons(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendButtonsSchema, input);
  return sendReply(deps, ctx, data, idempotency, {
    type: 'interactive',
    replyTo: data.replyTo,
    build: () => ({
      content: replyButtonsContent(data),
      preview: data.body,
      request: { type: 'interactive', interactive: replyButtonsInteractive(data) },
    }),
  });
}

/** A list message (ADR-080); see `sendReply`. */
export async function apiSendList(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendListSchema, input);
  return sendReply(deps, ctx, data, idempotency, {
    type: 'interactive',
    replyTo: data.replyTo,
    build: () => ({
      content: listContent(data),
      preview: data.body,
      request: { type: 'interactive', interactive: listInteractive(data) },
    }),
  });
}

/**
 * A reaction to a message the contact sent in the last 30 days (ADR-082); see `sendReply`. Stored
 * as inbound reactions are, with the WhatsApp id of the message in its content.
 */
export async function apiSendReaction(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendReactionSchema, input);
  return sendReply(deps, ctx, data, idempotency, {
    type: 'reaction',
    replyTo: data.replyTo,
    build: (answered) => {
      if (!answered) throw new Error('A reaction is sent only for a message it names');
      return {
        content: { emoji: data.emoji, message_id: answered },
        preview: `Reacted ${data.emoji}`,
        request: { type: 'reaction', reaction: { message_id: answered, emoji: data.emoji } },
      };
    },
  });
}

/**
 * The products a message names by content id, in one catalog connected to the sending number's
 * WhatsApp account, neither disconnected nor removed at Meta (ADR-086). `catalogId` picks the
 * catalog when two of them hold the ids. Unknown ids are refused by name.
 */
async function catalogProducts(
  tx: Tx,
  tenantId: string,
  whatsappAccountId: string,
  retailerIds: string[],
  catalogId: string | undefined,
): Promise<{ catalogId: string; names: Map<string, string> }> {
  const rows = await tx
    .select({
      retailerId: commerceProducts.retailerId,
      name: commerceProducts.name,
      catalogId: commerceCatalogs.metaCatalogId,
    })
    .from(commerceProducts)
    .innerJoin(
      commerceCatalogs,
      and(
        eq(commerceCatalogs.tenantId, commerceProducts.tenantId),
        eq(commerceCatalogs.id, commerceProducts.catalogId),
      ),
    )
    .where(
      and(
        eq(commerceProducts.tenantId, tenantId),
        inArray(commerceProducts.retailerId, retailerIds),
        eq(commerceCatalogs.whatsappAccountId, whatsappAccountId),
        isNull(commerceCatalogs.disconnectedAt),
        isNull(commerceProducts.removedAt),
        catalogId ? eq(commerceCatalogs.metaCatalogId, catalogId) : undefined,
      ),
    );
  const refuse = (path: string, message: string) =>
    new AppError('validation_failed', message, { issues: [{ path, message }] });
  const known = new Set(rows.map((r) => r.retailerId));
  const missing = retailerIds.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw refuse(
      'products',
      `Not in a catalog of this WhatsApp number${catalogId ? ' with that id' : ''}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`,
    );
  }
  const complete = [...new Set(rows.map((r) => r.catalogId))].filter((c) =>
    retailerIds.every((id) => rows.some((r) => r.catalogId === c && r.retailerId === id)),
  );
  const [chosen, other] = complete;
  if (!chosen) throw refuse('products', 'Give products from one catalog.');
  if (other) {
    throw refuse(
      'catalogId',
      'More than one catalog of this WhatsApp number has these products: name one with catalogId.',
    );
  }
  return {
    catalogId: chosen,
    names: new Map(rows.filter((r) => r.catalogId === chosen).map((r) => [r.retailerId, r.name])),
  };
}

type ApiProductInput =
  | z.infer<typeof apiSendProductSchema>
  | z.infer<typeof apiSendProductListSchema>
  | z.infer<typeof apiSendCatalogSchema>;

/**
 * A product, several products or the catalog (ADR-086), as the inbox sends them (P4-06); see
 * `sendReply`. The company's plan must include Commerce.
 */
export async function apiSendProducts(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const type =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as { type?: unknown }).type
      : undefined;
  const data: ApiProductInput =
    type === 'product'
      ? parseInput(apiSendProductSchema, input)
      : type === 'product_list'
        ? parseInput(apiSendProductListSchema, input)
        : parseInput(apiSendCatalogSchema, input);
  const retailerIds =
    data.type === 'product'
      ? [data.retailerId]
      : data.type === 'catalog'
        ? [data.thumbnailRetailerId]
        : data.sections.flatMap((s) => s.retailerIds);
  return sendReply(deps, ctx, data, idempotency, {
    type: 'interactive',
    replyTo: data.replyTo,
    precheck: async (tx) => {
      const entitlements = await loadEntitlements(tx, ctx.tenant.id);
      if (!entitlements.modules.has('commerce')) {
        throw new AppError('forbidden', "Your company's plan does not include Commerce.", {
          details: { apiReason: 'not_in_plan' },
        });
      }
    },
    build: async (_answered, sending) => {
      const found = await catalogProducts(
        sending.tx,
        ctx.tenant.id,
        sending.whatsappAccountId,
        retailerIds,
        data.catalogId,
      );
      const footer = data.footer ?? '';
      const resolved: ResolvedProductMessage =
        data.type === 'product'
          ? {
              kind: 'product',
              catalogId: found.catalogId,
              retailerId: data.retailerId,
              body: data.body ?? '',
              footer,
            }
          : data.type === 'catalog'
            ? {
                kind: 'catalog',
                thumbnailRetailerId: data.thumbnailRetailerId,
                body: data.body,
                footer,
              }
            : {
                kind: 'product_list',
                catalogId: found.catalogId,
                header: data.header,
                body: data.body,
                footer,
                sections: data.sections.map((s) => ({
                  title: s.title ?? '',
                  retailerIds: s.retailerIds,
                })),
              };
      const names = retailerIds.map((id) => found.names.get(id) ?? id);
      return {
        // Stored as the inbox stores the products it sends, so the thread shows them alike.
        content: {
          products: {
            kind: resolved.kind,
            names,
            ...(resolved.kind === 'product_list' ? { header: resolved.header } : {}),
            body: resolved.body,
            footer,
          },
        },
        preview:
          resolved.kind === 'catalog'
            ? '[Catalog]'
            : resolved.kind === 'product'
              ? `[Product] ${names[0] ?? ''}`
              : `[Products] ${names.length}`,
        request: { type: 'interactive', interactive: productInteractive(resolved) },
      };
    },
  });
}

/**
 * POST /api/v1/messages: a template (the default), or a reply inside the service window as text,
 * reply buttons, a list, products (ADR-086), a reaction, media from a link (ADR-194), a location
 * (ADR-195) or contact cards (ADR-197), by the body's `type`.
 */
export async function apiSendMessage(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  const type =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as { type?: unknown }).type
      : undefined;
  if (type === 'text') return apiSendText(deps, ctx, input, idempotency);
  if (type === 'buttons') return apiSendButtons(deps, ctx, input, idempotency);
  if (type === 'list') return apiSendList(deps, ctx, input, idempotency);
  if (type === 'reaction') return apiSendReaction(deps, ctx, input, idempotency);
  if ((API_MEDIA_TYPES as readonly unknown[]).includes(type)) {
    return apiSendMedia(deps, ctx, input, idempotency);
  }
  if (type === 'location') return apiSendLocation(deps, ctx, input, idempotency);
  if (type === 'contacts') return apiSendContacts(deps, ctx, input, idempotency);
  if (type === 'product' || type === 'product_list' || type === 'catalog') {
    return apiSendProducts(deps, ctx, input, idempotency);
  }
  if (type === undefined || type === 'template') {
    return apiSendTemplate(deps, ctx, input, idempotency);
  }
  throw new AppError(
    'validation_failed',
    'Send a template, a text, buttons, a list, products, a reaction, media, a location or contacts.',
    {
      issues: [
        {
          path: 'type',
          message:
            'Use template, text, buttons, list, product, product_list, catalog, reaction, image, video, audio, document, location or contacts.',
        },
      ],
    },
  );
}

/** The status of a message the API sent (any key of the company). */
export async function apiGetMessage(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  messageId: string,
): Promise<ApiMessage> {
  assertAnyScope(ctx, API_SEND_SCOPES);
  if (!z.uuid().safeParse(messageId).success) throw notFound('Message');
  const row = await deps.db.run(
    ctx.scope,
    async (tx) => {
      const [m] = await tx
        .select({
          id: messages.id,
          type: messages.type,
          status: messages.status,
          statusAt: messages.statusAt,
          content: messages.content,
          templateId: messages.templateId,
          channelId: messages.channelAccountId,
          errorCode: messages.errorCode,
          errorTitle: messages.errorTitle,
          createdAt: messages.createdAt,
          contactId: conversations.contactId,
          phone: contacts.phoneE164,
          replyTo: answeredMessages.id,
        })
        .from(messages)
        .innerJoin(
          conversations,
          and(
            eq(conversations.tenantId, messages.tenantId),
            eq(conversations.id, messages.conversationId),
          ),
        )
        .innerJoin(
          contacts,
          and(
            eq(contacts.tenantId, conversations.tenantId),
            eq(contacts.id, conversations.contactId),
          ),
        )
        .leftJoin(answeredMessages, answeredJoin())
        .where(
          and(
            eq(messages.tenantId, ctx.tenant.id),
            eq(messages.id, messageId),
            eq(messages.senderType, 'api'),
            isNotNull(messages.apiKeyId),
          ),
        );
      return m ?? null;
    },
    { accessMode: 'read only' },
  );
  if (!row) throw notFound('Message');
  const template = (row.content as { template?: { name?: string } }).template;
  return {
    id: row.id,
    type: apiMessageType(row.type),
    status: row.status,
    statusAt: row.statusAt.toISOString(),
    to: row.phone,
    templateId: row.templateId,
    templateName: template?.name ?? null,
    channelId: row.channelId,
    contactId: row.contactId,
    replyTo: row.replyTo,
    error: row.errorCode || row.errorTitle ? { code: row.errorCode, title: row.errorTitle } : null,
    createdAt: row.createdAt.toISOString(),
  };
}
