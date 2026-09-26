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
export async function connectTestChannel(opts: { ownerEmail: string; slug: string }) {
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
  const wabaId = digits(15);
  const phoneNumberId = digits(15);
  const whatsappAccountId = randomUUID();
  const channelAccountId = randomUUID();
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query(
      "SELECT set_config('app.tenant_id', '', true), set_config('app.user_id', $1, true)",
      [ownerId],
    );
    const tenant = await app.query<{ id: string }>('SELECT id FROM app.tenants WHERE slug = $1', [
      opts.slug,
    ]);
    const tenantId = tenant.rows[0]!.id;
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    // Same associated data as credentialAad() in @w360/domain.
    const credential = keyring.encrypt(
      E2E_CHANNEL_TOKEN,
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
       VALUES ($1, $2, $3, $4, 'active', '+91 90000 12345', 'E2E Traders')`,
      [channelAccountId, tenantId, whatsappAccountId, phoneNumberId],
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
  return { wabaId, phoneNumberId };
}

export function randomWaId(): string {
  return `9198${digits(8)}`;
}

export function inboundMessage(wabaId: string, phoneNumberId: string, waId: string, text: string) {
  return envelope(wabaId, phoneNumberId, {
    contacts: [{ profile: { name: 'Priya Customer' }, wa_id: waId }],
    messages: [
      {
        from: waId,
        id: `wamid.e2e.${randomUUID()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: text },
      },
    ],
  });
}

export function statusUpdate(
  wabaId: string,
  phoneNumberId: string,
  wamid: string,
  status: 'sent' | 'delivered' | 'read',
  waId: string,
) {
  return envelope(wabaId, phoneNumberId, {
    statuses: [
      { id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: waId },
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
