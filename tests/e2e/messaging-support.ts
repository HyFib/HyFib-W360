import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import pg from 'pg';
import { Keyring } from '@w360/core';

/** Synthetic business token accepted by the Graph stand-in (never a real credential). */
export const E2E_CHANNEL_TOKEN = 'EAAGe2eTestChannelToken0000000000';

export const messagingConfigured = Boolean(
  process.env.META_APP_SECRET &&
  process.env.E2E_GRAPH_PORT &&
  process.env.DATABASE_URL_APP &&
  process.env.E2E_DATABASE_URL_AUTH &&
  process.env.W360_ENCRYPTION_KEYS &&
  process.env.W360_ENCRYPTION_PRIMARY_KEY_ID,
);

function digits(length: number): string {
  let out = String(randomInt(1, 10));
  while (out.length < length) out += String(randomInt(0, 10));
  return out;
}

/**
 * Test fixture: connects a WhatsApp number to a company the way onboarding would persist it
 * (encrypted token, provider bindings through the SECURITY DEFINER functions), acting as the
 * runtime role under the company's RLS scope. Embedded Signup itself needs Meta's popup and is
 * covered by integration tests against the stand-in.
 */
export async function connectTestChannel(opts: {
  ownerEmail: string;
  slug: string;
  /** A token registered with the stand-in (`setStandInToken`); the shared test token otherwise. */
  token?: string;
  /** The account's id, when a test sets up the stand-in for it first (`newWabaId`). */
  wabaId?: string;
  /** How WhatsApp shows the number: `+91 90000 12345` and `E2E Traders` unless given. */
  displayPhoneNumber?: string;
  verifiedName?: string;
}) {
  const auth = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL_AUTH });
  await auth.connect();
  let ownerId: string;
  try {
    const res = await auth.query<{ id: string }>('SELECT id FROM auth.users WHERE email = $1', [
      opts.ownerEmail.toLowerCase(),
    ]);
    ownerId = res.rows[0]!.id;
  } finally {
    await auth.end();
  }

  const keyring = Keyring.fromEnv(
    process.env.W360_ENCRYPTION_KEYS!,
    process.env.W360_ENCRYPTION_PRIMARY_KEY_ID!,
  );
  const wabaId = opts.wabaId ?? digits(15);
  const phoneNumberId = digits(15);
  const whatsappAccountId = randomUUID();
  const channelAccountId = randomUUID();
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP });
  await app.connect();
  let tenantId: string;
  try {
    await app.query('BEGIN');
    await app.query(
      "SELECT set_config('app.tenant_id', '', true), set_config('app.user_id', $1, true)",
      [ownerId],
    );
    const tenant = await app.query<{ id: string }>('SELECT id FROM app.tenants WHERE slug = $1', [
      opts.slug,
    ]);
    tenantId = tenant.rows[0]!.id;
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    // Same associated data as credentialAad() in @w360/domain.
    const credential = keyring.encrypt(
      opts.token ?? E2E_CHANNEL_TOKEN,
      `tenant:${tenantId}|whatsapp_account:${whatsappAccountId}`,
    );
    await app.query(
      `INSERT INTO app.whatsapp_accounts (id, tenant_id, waba_id, status, credential_ciphertext)
       VALUES ($1, $2, $3, 'connected', $4)`,
      [whatsappAccountId, tenantId, wabaId, credential],
    );
    await app.query(`SELECT app.bind_provider_asset('meta_whatsapp', 'waba', $1, $2::uuid, NULL)`, [
      wabaId,
      whatsappAccountId,
    ]);
    await app.query(
      `INSERT INTO app.channel_accounts
         (id, tenant_id, whatsapp_account_id, phone_number_id, status, display_phone_number, verified_name)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
      [
        channelAccountId,
        tenantId,
        whatsappAccountId,
        phoneNumberId,
        opts.displayPhoneNumber ?? '+91 90000 12345',
        opts.verifiedName ?? 'E2E Traders',
      ],
    );
    await app.query(
      `SELECT app.bind_provider_asset('meta_whatsapp', 'phone_number', $1, $2::uuid, $3)`,
      [phoneNumberId, channelAccountId, wabaId],
    );
    await app.query('COMMIT');
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  } finally {
    await app.end();
  }
  return { tenantId, wabaId, phoneNumberId };
}

export function randomWaId(): string {
  return `9198${digits(8)}`;
}

export function inboundMessage(
  wabaId: string,
  phoneNumberId: string,
  waId: string,
  text: string,
  sentAt: Date = new Date(),
  id = `wamid.e2e.${randomUUID()}`,
) {
  return envelope(wabaId, phoneNumberId, {
    contacts: [{ profile: { name: 'Priya Customer' }, wa_id: waId }],
    messages: [
      {
        from: waId,
        id,
        timestamp: String(Math.floor(sentAt.getTime() / 1000)),
        type: 'text',
        text: { body: text },
      },
    ],
  });
}

/**
 * A customer's text naming them by WhatsApp user id only, without their number (customers who use
 * a username, ADR-224).
 */
export function inboundByUserId(
  wabaId: string,
  phoneNumberId: string,
  userId: string,
  text: string,
  name = 'Priya Customer',
) {
  return envelope(wabaId, phoneNumberId, {
    contacts: [{ profile: { name }, user_id: userId }],
    messages: [
      {
        from: userId,
        id: `wamid.e2e.${randomUUID()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: text },
      },
    ],
  });
}

/** Several messages from one customer in one webhook, each `{ type, [type]: fields }`. */
export function inboundMessages(
  wabaId: string,
  phoneNumberId: string,
  waId: string,
  messages: Record<string, unknown>[],
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return envelope(wabaId, phoneNumberId, {
    contacts: [{ profile: { name: 'Priya Customer' }, wa_id: waId }],
    messages: messages.map((m) => ({
      from: waId,
      id: `wamid.e2e.${randomUUID()}`,
      timestamp,
      ...m,
    })),
  });
}

/** A message sent from a click-to-WhatsApp ad: the webhook carries the ad as `referral` (M-130). */
export function adInboundMessage(
  wabaId: string,
  phoneNumberId: string,
  waId: string,
  text: string,
  referral: Record<string, string>,
) {
  return envelope(wabaId, phoneNumberId, {
    contacts: [{ profile: { name: 'Arjun Customer' }, wa_id: waId }],
    messages: [
      {
        from: waId,
        id: `wamid.e2e.${randomUUID()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: text },
        referral,
      },
    ],
  });
}

/** A customer's tap on a reply button of the message `contextId` (research M-158). */
export function buttonReply(
  wabaId: string,
  phoneNumberId: string,
  waId: string,
  button: { id: string; title: string },
  contextId: string,
) {
  return envelope(wabaId, phoneNumberId, {
    contacts: [{ profile: { name: 'Priya Customer' }, wa_id: waId }],
    messages: [
      {
        from: waId,
        id: `wamid.e2e.${randomUUID()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: button },
        context: { from: '919000012345', id: contextId },
      },
    ],
  });
}

/** A customer's pick of a row of the list message `contextId` (research M-158, M-180). */
export function listReply(
  wabaId: string,
  phoneNumberId: string,
  waId: string,
  row: { id: string; title: string; description?: string },
  contextId: string,
) {
  return envelope(wabaId, phoneNumberId, {
    contacts: [{ profile: { name: 'Priya Customer' }, wa_id: waId }],
    messages: [
      {
        from: waId,
        id: `wamid.e2e.${randomUUID()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: row },
        context: { from: '919000012345', id: contextId },
      },
    ],
  });
}

/** A customer's reaction to the message `messageId` (research M-184). */
export function reactionMessage(
  wabaId: string,
  phoneNumberId: string,
  waId: string,
  emoji: string,
  messageId: string,
) {
  return envelope(wabaId, phoneNumberId, {
    contacts: [{ profile: { name: 'Priya Customer' }, wa_id: waId }],
    messages: [
      {
        from: waId,
        id: `wamid.e2e.${randomUUID()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'reaction',
        reaction: { message_id: messageId, emoji },
      },
    ],
  });
}

/** A customer's tap on a quick-reply button of the template message `contextId` (research M-178). */
export function templateButtonReply(
  wabaId: string,
  phoneNumberId: string,
  waId: string,
  button: { payload: string; text: string },
  contextId: string,
) {
  return envelope(wabaId, phoneNumberId, {
    contacts: [{ profile: { name: 'Priya Customer' }, wa_id: waId }],
    messages: [
      {
        from: waId,
        id: `wamid.e2e.${randomUUID()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'button',
        button,
        context: { from: '919000012345', id: contextId },
      },
    ],
  });
}

/**
 * A completed WhatsApp Flow: an interactive `nfm_reply` whose `response_json` string holds the flow
 * token and the answers, in reply to the flow message `contextId` (research M-166).
 */
export function flowCompletion(
  wabaId: string,
  phoneNumberId: string,
  waId: string,
  response: Record<string, unknown>,
  contextId: string,
) {
  return envelope(wabaId, phoneNumberId, {
    contacts: [{ profile: { name: 'Priya Customer' }, wa_id: waId }],
    messages: [
      {
        from: waId,
        id: `wamid.e2e.${randomUUID()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'interactive',
        interactive: {
          type: 'nfm_reply',
          nfm_reply: { name: 'flow', body: 'Sent', response_json: JSON.stringify(response) },
        },
        context: { from: '919000012345', id: contextId },
      },
    ],
  });
}

/** A cart sent from the catalog: an `order` message with prices in major units (M-170). */
export function orderMessage(
  wabaId: string,
  phoneNumberId: string,
  waId: string,
  order: {
    catalogId: string;
    text?: string;
    items: { retailerId: string; quantity: number; price: number }[];
  },
) {
  return envelope(wabaId, phoneNumberId, {
    contacts: [{ profile: { name: 'Priya Customer' }, wa_id: waId }],
    messages: [
      {
        from: waId,
        id: `wamid.e2e.${randomUUID()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'order',
        order: {
          catalog_id: order.catalogId,
          text: order.text ?? '',
          product_items: order.items.map((i) => ({
            product_retailer_id: i.retailerId,
            quantity: i.quantity,
            item_price: i.price,
            currency: 'INR',
          })),
        },
      },
    ],
  });
}

/** A status update; `pricing` is Meta's pricing object (research M-076) when given. */
export function statusUpdate(
  wabaId: string,
  phoneNumberId: string,
  wamid: string,
  status: 'sent' | 'delivered' | 'read',
  waId: string,
  pricing?: { billable: boolean; pricing_model: string; type: string; category: string },
) {
  return envelope(wabaId, phoneNumberId, {
    statuses: [
      {
        id: wamid,
        status,
        timestamp: String(Math.floor(Date.now() / 1000)),
        recipient_id: waId,
        ...(pricing ? { pricing } : {}),
      },
    ],
  });
}

function envelope(wabaId: string, phoneNumberId: string, value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919000012345', phone_number_id: phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

/** Posts a webhook signed exactly as Meta does (HMAC-SHA256 of the raw body with the app secret). */
export async function sendSignedWebhook(request: APIRequestContext, body: unknown) {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', process.env.META_APP_SECRET!).update(raw).digest('hex')}`;
  const res = await request.post('/api/webhooks/meta', {
    data: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  });
  expect(res.status()).toBe(200);
}

/**
 * TEST-ONLY: registers a business token with the Graph stand-in, or changes what its debug_token
 * says about one (validity, permissions, expiry in Unix seconds), as a business changing HyFib's
 * access in Meta's tools would.
 */
export async function setStandInToken(
  request: APIRequestContext,
  token: { token: string; valid?: boolean; scopes?: string[]; expiresAt?: number },
) {
  const res = await request.post(
    `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}/__stand-in/token`,
    {
      data: token,
    },
  );
  expect(res.ok()).toBe(true);
}

/** An id for a WhatsApp Business Account a test sets up at the stand-in before connecting it. */
export function newWabaId(): string {
  return digits(15);
}

/**
 * Whether the stand-in has HyFib's app subscribed to an account's webhooks, and whether subscribing
 * it again fails (ADR-138).
 */
export async function setStandInSubscription(
  request: APIRequestContext,
  subscription: { wabaId: string; subscribed?: boolean; refuse?: boolean },
) {
  const res = await request.post(
    `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}/__stand-in/subscription`,
    { data: subscription },
  );
  expect(res.ok()).toBe(true);
}

/** An id for a file a customer sends, as WhatsApp names one in a webhook (ADR-216). */
export function newMediaId(): string {
  return digits(16);
}

/** TEST-ONLY: a file a customer sent, as WhatsApp keeps it for the account (ADR-216). */
export async function setStandInMedia(
  request: APIRequestContext,
  media: { id: string; mimeType: string; bytes: Buffer },
) {
  const res = await request.post(
    `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}/__stand-in/media`,
    { data: { id: media.id, mimeType: media.mimeType, base64: media.bytes.toString('base64') } },
  );
  expect(res.ok()).toBe(true);
}

export async function standInRequests(request: APIRequestContext) {
  const res = await request.get(
    `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}/__stand-in/requests`,
  );
  return (await res.json()) as {
    method: string;
    path: string;
    authorization: string | null;
    body: unknown;
    wamid?: string;
  }[];
}
