import { toError, type Clock, type Keyring } from '@w360/core';
import {
  authorizedTenantScope,
  automationHttpCalls,
  channelAccounts,
  commercePaymentAccounts,
  commerceStores,
  emailOutbox,
  flowKeys,
  httpSecrets,
  sql,
  systemScope,
  webhookEndpoints,
  webhookReceipts,
  whatsappAccounts,
  type Database,
  type SQL,
  type Tx,
} from '@w360/db';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { httpRequestAad, httpSecretAad } from '../automations/http';
import { paymentAccountAad } from '../commerce/model';
import { outboxAad } from '../email/outbox';
import { flowKeyAad } from '../flows/model';
import { credentialAad } from '../messaging/credentials';
import { registrationPinAad } from '../messaging/onboarding';
import { receiptAad } from '../messaging/receipts';
import { storeAccessCodeAad, storeCredentialsAad, storeWebhookSecretAad } from '../stores/model';
import { webhookOAuthSecretAad } from '../webhooks/oauth';
import { webhookHeadersAad, webhookSecretAad } from '../webhooks/service';

/**
 * Re-encrypting stored secrets under the primary key (SEC-10, ADR-134). Every kind of value HyFib
 * stores sealed with the keyring, where it is stored and the associated data its service seals it
 * with (the same functions, so the two cannot drift). While more than one key is configured, the
 * minute sweep re-encrypts the values sealed with a configured key other than the primary, so that
 * key can be removed once nothing is sealed with it. The latest migration that defines
 * `ops.sealed_value_keys` (0101, then 0121) lists the same columns, in the same order.
 */
export const SEALED_VALUE_KINDS = [
  'whatsapp_token',
  'registration_pin',
  'http_secret',
  'http_request',
  'payment_key_secret',
  'payment_webhook_secret',
  'flow_private_key',
  'store_credentials',
  'store_webhook_secret',
  'store_access_code',
  'webhook_secret',
  'webhook_previous_secret',
  'webhook_headers',
  'webhook_oauth_secret',
  'provider_receipt',
  'queued_email',
] as const;
export type SealedValueKind = (typeof SEALED_VALUE_KINDS)[number];

export const SEALED_VALUE_LABELS: Record<SealedValueKind, string> = {
  whatsapp_token: 'WhatsApp access tokens',
  registration_pin: 'Number registration PINs',
  http_secret: 'HTTP request secrets',
  http_request: 'Automation HTTP requests waiting to be sent',
  payment_key_secret: 'Razorpay key secrets of companies',
  payment_webhook_secret: 'Razorpay webhook secrets of companies',
  flow_private_key: 'Flow private keys',
  store_credentials: 'Store credentials',
  store_webhook_secret: 'Store webhook secrets',
  store_access_code: 'Store access codes',
  webhook_secret: 'Webhook endpoint secrets',
  webhook_previous_secret: 'Previous webhook endpoint secrets',
  webhook_headers: 'Webhook endpoint headers',
  webhook_oauth_secret: 'Webhook endpoint OAuth client secrets',
  provider_receipt: 'Provider webhook bodies (kept 7 days)',
  queued_email: 'Emails waiting to be sent',
};

/** A sealed value the sweep found: its kind, its row and its company (null for operations rows). */
export interface SealedValueRef {
  kind: SealedValueKind;
  tenantId: string | null;
  id: string;
}

interface StoredValue {
  sealed: string;
  aad: string;
}

interface SealedValueSpec {
  read(tx: Tx, ref: SealedValueRef): Promise<StoredValue | null>;
  /** Writes the re-encrypted value only if the stored one is unchanged (compare and set). */
  write(tx: Tx, ref: SealedValueRef, stored: StoredValue, next: string): Promise<boolean>;
}

interface SealedColumn {
  table: PgTable;
  id: AnyPgColumn;
  /** The company's column; operations rows have none and are re-encrypted in the system scope. */
  tenantId: AnyPgColumn | null;
  sealed: AnyPgColumn;
  /** A webhook endpoint's secret version, part of its associated data. */
  version?: AnyPgColumn;
  /** Rows whose value is still in use: an automation's request only until its call finishes. */
  live?: SQL;
  aad: (row: { tenantId: string; id: string; version: number }) => string;
}

function sealedColumn(c: SealedColumn): SealedValueSpec {
  const where = (ref: SealedValueRef) =>
    sql.join(
      [
        sql`${c.id} = ${ref.id}`,
        ...(c.tenantId ? [sql`${c.tenantId} = ${ref.tenantId}`] : []),
        ...(c.live ? [c.live] : []),
      ],
      sql` and `,
    );
  return {
    async read(tx, ref) {
      const res = await tx.execute<{ sealed: string | null; version: number | null }>(
        sql`select ${c.sealed} as sealed, ${c.version ?? sql`null::integer`} as version
              from ${c.table} where ${where(ref)}`,
      );
      const row = res.rows[0];
      if (!row?.sealed) return null;
      const aad = c.aad({ tenantId: ref.tenantId ?? '', id: ref.id, version: row.version ?? 0 });
      return { sealed: row.sealed, aad };
    },
    // Every sealing has a fresh IV, so an unchanged value means nothing replaced it (nor rotated a
    // webhook endpoint's secret, whose version is part of its associated data).
    async write(tx, ref, stored, next) {
      const res = await tx.execute(
        sql`update ${c.table} set ${sql.identifier(c.sealed.name)} = ${next}
             where ${where(ref)} and ${c.sealed} = ${stored.sealed}`,
      );
      return res.rowCount === 1;
    },
  };
}

const SEALED_VALUES: Record<SealedValueKind, SealedValueSpec> = {
  whatsapp_token: sealedColumn({
    table: whatsappAccounts,
    id: whatsappAccounts.id,
    tenantId: whatsappAccounts.tenantId,
    sealed: whatsappAccounts.credentialCiphertext,
    aad: (r) => credentialAad(r.tenantId, r.id),
  }),
  registration_pin: sealedColumn({
    table: channelAccounts,
    id: channelAccounts.id,
    tenantId: channelAccounts.tenantId,
    sealed: channelAccounts.registrationPinCiphertext,
    aad: (r) => registrationPinAad(r.tenantId, r.id),
  }),
  http_secret: sealedColumn({
    table: httpSecrets,
    id: httpSecrets.id,
    tenantId: httpSecrets.tenantId,
    sealed: httpSecrets.valueCiphertext,
    aad: (r) => httpSecretAad(r.tenantId, r.id),
  }),
  http_request: sealedColumn({
    table: automationHttpCalls,
    id: automationHttpCalls.id,
    tenantId: automationHttpCalls.tenantId,
    sealed: automationHttpCalls.requestCiphertext,
    // A finished call clears its request, and its guard refuses any other change to it.
    live: sql`${automationHttpCalls.state} in ('queued', 'in_flight')`,
    aad: (r) => httpRequestAad(r.tenantId, r.id),
  }),
  payment_key_secret: sealedColumn({
    table: commercePaymentAccounts,
    id: commercePaymentAccounts.id,
    tenantId: commercePaymentAccounts.tenantId,
    sealed: commercePaymentAccounts.keySecretCiphertext,
    aad: (r) => paymentAccountAad(r.tenantId, r.id, 'key'),
  }),
  payment_webhook_secret: sealedColumn({
    table: commercePaymentAccounts,
    id: commercePaymentAccounts.id,
    tenantId: commercePaymentAccounts.tenantId,
    sealed: commercePaymentAccounts.webhookSecretCiphertext,
    aad: (r) => paymentAccountAad(r.tenantId, r.id, 'webhook'),
  }),
  flow_private_key: sealedColumn({
    table: flowKeys,
    id: flowKeys.id,
    tenantId: flowKeys.tenantId,
    sealed: flowKeys.privateKeyCiphertext,
    aad: (r) => flowKeyAad(r.tenantId, r.id),
  }),
  store_credentials: sealedColumn({
    table: commerceStores,
    id: commerceStores.id,
    tenantId: commerceStores.tenantId,
    sealed: commerceStores.credentialsCiphertext,
    aad: (r) => storeCredentialsAad(r.tenantId, r.id),
  }),
  store_webhook_secret: {
    ...sealedColumn({
      table: commerceStores,
      id: commerceStores.id,
      tenantId: commerceStores.tenantId,
      sealed: commerceStores.webhookSecretCiphertext,
      aad: (r) => storeWebhookSecretAad(r.tenantId, r.id),
    }),
    // The runtime role cannot write a store's webhook secret; its re-encryption is the one change.
    async write(tx, ref, stored, next) {
      const res = await tx.execute<{ swapped: boolean }>(
        sql`select app.reseal_store_webhook_secret(${ref.id}::uuid, ${stored.sealed}, ${next}) as swapped`,
      );
      return res.rows[0]?.swapped === true;
    },
  },
  store_access_code: sealedColumn({
    table: commerceStores,
    id: commerceStores.id,
    tenantId: commerceStores.tenantId,
    sealed: commerceStores.accessCodeCiphertext,
    aad: (r) => storeAccessCodeAad(r.tenantId, r.id),
  }),
  webhook_secret: sealedColumn({
    table: webhookEndpoints,
    id: webhookEndpoints.id,
    tenantId: webhookEndpoints.tenantId,
    sealed: webhookEndpoints.secretCiphertext,
    version: webhookEndpoints.secretVersion,
    aad: (r) => webhookSecretAad(r.tenantId, r.id, r.version),
  }),
  webhook_previous_secret: sealedColumn({
    table: webhookEndpoints,
    id: webhookEndpoints.id,
    tenantId: webhookEndpoints.tenantId,
    sealed: webhookEndpoints.previousSecretCiphertext,
    version: webhookEndpoints.secretVersion,
    // The secret before the last rotation, sealed with the version it had (delivery opens it so).
    aad: (r) => webhookSecretAad(r.tenantId, r.id, r.version - 1),
  }),
  webhook_headers: sealedColumn({
    table: webhookEndpoints,
    id: webhookEndpoints.id,
    tenantId: webhookEndpoints.tenantId,
    sealed: webhookEndpoints.headersCiphertext,
    aad: (r) => webhookHeadersAad(r.tenantId, r.id),
  }),
  webhook_oauth_secret: sealedColumn({
    table: webhookEndpoints,
    id: webhookEndpoints.id,
    tenantId: webhookEndpoints.tenantId,
    sealed: webhookEndpoints.oauthClientSecretCiphertext,
    aad: (r) => webhookOAuthSecretAad(r.tenantId, r.id),
  }),
  provider_receipt: sealedColumn({
    table: webhookReceipts,
    id: webhookReceipts.id,
    tenantId: null,
    sealed: webhookReceipts.bodyCiphertext,
    aad: (r) => receiptAad(r.id),
  }),
  queued_email: sealedColumn({
    table: emailOutbox,
    id: emailOutbox.id,
    tenantId: null,
    sealed: emailOutbox.payloadCiphertext,
    aad: (r) => outboxAad(r.id),
  }),
};

const KIND_SET: ReadonlySet<string> = new Set(SEALED_VALUE_KINDS);
const isSealedValueKind = (value: string): value is SealedValueKind => KIND_SET.has(value);

/**
 * Values sealed with one of `keyIds` (`ops.sealed_values_to_reseal`, ids only), leaving out `skip`
 * (`kind:id`). Each value's company comes from its row.
 */
export async function findValuesToReseal(
  db: Database,
  keyIds: readonly string[],
  skip: readonly string[],
  limit: number,
): Promise<SealedValueRef[]> {
  const res = await db.run(
    systemScope,
    (tx) =>
      tx.execute<{ kind: string; tenant_id: string | null; id: string }>(
        sql`select kind, tenant_id, id from ops.sealed_values_to_reseal(
              ${sql.param([...keyIds])}::text[], ${sql.param([...skip])}::text[], ${limit})`,
      ),
    { accessMode: 'read only' },
  );
  return res.rows.flatMap((r) =>
    isSealedValueKind(r.kind) ? [{ kind: r.kind, tenantId: r.tenant_id, id: r.id }] : [],
  );
}

export type ResealOutcome =
  | { outcome: 'resealed' }
  /** Replaced, cleared or already re-encrypted meanwhile: left as it is. */
  | { outcome: 'changed' }
  /** Does not open with its associated data: left as it is (the reason, never the value). */
  | { outcome: 'unopenable'; reason: string };

/**
 * Re-encrypts one value under the primary key, in its company's scope (operations rows in the
 * system scope): reads it, opens it with its associated data, seals it again with the primary key
 * and writes it only if it is still the value it read. The row's time does not change.
 */
export async function resealValue(
  deps: { db: Database; keyring: Keyring },
  ref: SealedValueRef,
): Promise<ResealOutcome> {
  const spec = SEALED_VALUES[ref.kind];
  // The company comes from the value's own row (ops.sealed_values_to_reseal), not from a payload.
  const scope = ref.tenantId === null ? systemScope : authorizedTenantScope(ref.tenantId, null);
  return deps.db.run(scope, async (tx): Promise<ResealOutcome> => {
    const stored = await spec.read(tx, ref);
    if (!stored || !deps.keyring.needsRotation(stored.sealed)) return { outcome: 'changed' };
    let plain: Buffer;
    try {
      plain = deps.keyring.decrypt(stored.sealed, stored.aad);
    } catch (error) {
      return { outcome: 'unopenable', reason: toError(error).message };
    }
    try {
      // The shared touch trigger keeps the row's time while this is on (migration 0101).
      await tx.execute(sql`select set_config('w360.resealing', 'on', true)`);
      const next = deps.keyring.encrypt(plain, stored.aad);
      return (await spec.write(tx, ref, stored, next))
        ? { outcome: 'resealed' }
        : { outcome: 'changed' };
    } finally {
      plain.fill(0);
    }
  });
}

/** Values one sweep re-encrypts at most. */
export const RESEAL_BATCH = 500;
/** After a lookup found nothing, the next one waits this long. */
export const RESEAL_IDLE_MS = 60 * 60_000;
/** Values that do not open a worker leaves out of its lookups before it stops re-encrypting. */
export const RESEAL_SKIP_LIMIT = 1000;

/** What a worker remembers between sweeps. */
export interface ResealState {
  /** Values that did not open (`kind:id`), left out of later lookups until the worker restarts. */
  skip: Set<string>;
  /** When the next lookup may run (epoch ms): an hour after one found nothing. */
  idleUntil: number;
}

export const newResealState = (): ResealState => ({ skip: new Set(), idleUntil: 0 });

export interface ResealSweepResult {
  resealed: number;
  changed: number;
  /** Values that did not open this sweep, by kind and id only. */
  unopenable: (SealedValueRef & { reason: string })[];
  failed: (SealedValueRef & { error: unknown })[];
  /** Whether this worker stopped re-encrypting: too many values did not open. */
  stopped: boolean;
}

/**
 * The minute sweep's part: while a key other than the primary is configured, re-encrypts up to
 * `limit` values sealed with such a key. Only a server still running with an older configuration
 * seals with another key, so once a lookup finds nothing the next waits an hour. A value that does
 * not open is reported once and left out of later lookups; after RESEAL_SKIP_LIMIT of them (a wrong
 * key in the configuration, most likely) the worker stops re-encrypting until it restarts.
 */
export async function resealStoredValues(
  deps: { db: Database; keyring: Keyring; clock: Clock },
  state: ResealState,
  limit = RESEAL_BATCH,
): Promise<ResealSweepResult> {
  const result: ResealSweepResult = {
    resealed: 0,
    changed: 0,
    unopenable: [],
    failed: [],
    stopped: state.skip.size >= RESEAL_SKIP_LIMIT,
  };
  const others = deps.keyring.keyIds.filter((kid) => kid !== deps.keyring.currentKeyId);
  const now = deps.clock.now().getTime();
  if (others.length === 0 || result.stopped || now < state.idleUntil) return result;
  const values = await findValuesToReseal(deps.db, others, [...state.skip], limit);
  if (values.length === 0) state.idleUntil = now + RESEAL_IDLE_MS;
  for (const value of values) {
    try {
      const done = await resealValue(deps, value);
      if (done.outcome === 'resealed') result.resealed += 1;
      else if (done.outcome === 'changed') result.changed += 1;
      else {
        state.skip.add(`${value.kind}:${value.id}`);
        result.unopenable.push({ ...value, reason: done.reason });
      }
    } catch (error) {
      result.failed.push({ ...value, error });
    }
  }
  result.stopped = state.skip.size >= RESEAL_SKIP_LIMIT;
  return result;
}

export interface SealedValueCount {
  kind: SealedValueKind;
  /** The key that sealed the values; null for values in another format. */
  keyId: string | null;
  sealed: number;
}

export type SealingKeyState = 'primary' | 'configured' | 'not_configured' | 'unknown_format';

export const SEALING_KEY_STATE_LABELS: Record<SealingKeyState, string> = {
  primary: 'Primary',
  configured: 'Configured',
  not_configured: 'Not configured',
  unknown_format: 'Not a sealed value',
};

export interface KeyringOverview {
  primaryKeyId: string;
  /** Every configured key (even with nothing sealed), then keys found only in stored values. */
  keys: { keyId: string | null; state: SealingKeyState; sealed: number }[];
  /** Kinds with stored values: how many the primary key, other configured keys and others sealed. */
  kinds: { kind: SealedValueKind; primary: number; configured: number; other: number }[];
  /** Configured keys other than the primary that seal nothing stored. */
  unused: string[];
}

const KEY_STATE_ORDER: SealingKeyState[] = [
  'primary',
  'configured',
  'not_configured',
  'unknown_format',
];

/** What the operations console shows of the keyring: key ids and counts, never a key or value. */
export function keyringOverview(
  keyring: { currentKeyId: string; keyIds: readonly string[] },
  counts: readonly SealedValueCount[],
): KeyringOverview {
  const configured = new Set(keyring.keyIds);
  const stateOf = (keyId: string | null): SealingKeyState =>
    keyId === null
      ? 'unknown_format'
      : keyId === keyring.currentKeyId
        ? 'primary'
        : configured.has(keyId)
          ? 'configured'
          : 'not_configured';
  const totals = new Map<string | null, number>(keyring.keyIds.map((kid) => [kid, 0]));
  for (const c of counts) totals.set(c.keyId, (totals.get(c.keyId) ?? 0) + c.sealed);
  const keys = [...totals]
    .map(([keyId, sealed]) => ({ keyId, state: stateOf(keyId), sealed }))
    .sort(
      (a, b) =>
        KEY_STATE_ORDER.indexOf(a.state) - KEY_STATE_ORDER.indexOf(b.state) ||
        (a.keyId ?? '').localeCompare(b.keyId ?? ''),
    );
  const kinds = SEALED_VALUE_KINDS.map((kind) => {
    const row = { kind, primary: 0, configured: 0, other: 0 };
    for (const c of counts) {
      if (c.kind !== kind) continue;
      const state = stateOf(c.keyId);
      if (state === 'primary') row.primary += c.sealed;
      else if (state === 'configured') row.configured += c.sealed;
      else row.other += c.sealed;
    }
    return row;
  }).filter((k) => k.primary + k.configured + k.other > 0);
  return {
    primaryKeyId: keyring.currentKeyId,
    keys,
    kinds,
    unused: keys
      .filter((k) => k.state === 'configured' && k.sealed === 0)
      .map((k) => k.keyId ?? ''),
  };
}

export function parseSealedValueCounts(
  rows: readonly { kind: string; key_id: string | null; sealed: number | string }[],
): SealedValueCount[] {
  return rows.flatMap((r) =>
    isSealedValueKind(r.kind) ? [{ kind: r.kind, keyId: r.key_id, sealed: Number(r.sealed) }] : [],
  );
}
