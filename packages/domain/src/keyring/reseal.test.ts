import { readdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring } from '@w360/core';
import type { Database } from '@w360/db';
import {
  RESEAL_SKIP_LIMIT,
  SEALED_VALUE_KINDS,
  SEALED_VALUE_LABELS,
  keyringOverview,
  newResealState,
  parseSealedValueCounts,
  resealStoredValues,
} from './reseal';

/** A database that fails the test if the sweep looks anything up. */
const noLookups = {
  run: () => {
    throw new Error('no lookup expected');
  },
} as unknown as Database;

const ring = (primary: string, ...ids: string[]) =>
  new Keyring({
    primaryKeyId: primary,
    keys: Object.fromEntries([primary, ...ids].map((id) => [id, randomBytes(32)])),
  });

const clock = { now: () => new Date('2026-10-03T12:00:00Z') };

describe('the sealed values the sweep re-encrypts (ADR-134)', () => {
  it('lists the same kinds as the latest migration that finds and counts them', () => {
    const migrations = new URL('../../../db/migrations/', import.meta.url);
    const defining = readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
      .filter((sql) => sql.includes('CREATE FUNCTION ops.sealed_value_keys()'));
    // 0101, 0121 (the OAuth client secrets), 0258 (the alerts' chat channel), 0287 (the OAuth
    // clients' private keys) and 0288 (their next private keys) so far.
    expect(defining.length).toBeGreaterThanOrEqual(5);
    const migration = defining.at(-1)!;
    const body = migration.slice(migration.indexOf('CREATE FUNCTION ops.sealed_value_keys()'));
    const kinds = [...body.matchAll(/^\s+SELECT '([a-z_]+)'(?:::text)?,/gm)].map((m) => m[1]);
    expect(kinds).toEqual([...SEALED_VALUE_KINDS]);
    for (const kind of SEALED_VALUE_KINDS) expect(SEALED_VALUE_LABELS[kind]).toBeTruthy();
  });

  it('reads counts of known kinds only', () => {
    expect(
      parseSealedValueCounts([
        { kind: 'http_secret', key_id: 'k1', sealed: '3' },
        { kind: 'queued_email', key_id: null, sealed: 2 },
        { kind: 'something_else', key_id: 'k1', sealed: '9' },
      ]),
    ).toEqual([
      { kind: 'http_secret', keyId: 'k1', sealed: 3 },
      { kind: 'queued_email', keyId: null, sealed: 2 },
    ]);
  });
});

describe('what the operations console shows of the keyring', () => {
  it('lists every configured key, primary first, then keys found only in stored values', () => {
    const overview = keyringOverview({ currentKeyId: 'k2', keyIds: ['k2', 'k1', 'k0'] }, [
      { kind: 'http_secret', keyId: 'k1', sealed: 4 },
      { kind: 'http_secret', keyId: 'k2', sealed: 6 },
      { kind: 'whatsapp_token', keyId: 'k2', sealed: 2 },
      { kind: 'whatsapp_token', keyId: 'gone', sealed: 1 },
      { kind: 'queued_email', keyId: null, sealed: 5 },
    ]);
    expect(overview.primaryKeyId).toBe('k2');
    expect(overview.keys).toEqual([
      { keyId: 'k2', state: 'primary', sealed: 8 },
      { keyId: 'k0', state: 'configured', sealed: 0 },
      { keyId: 'k1', state: 'configured', sealed: 4 },
      { keyId: 'gone', state: 'not_configured', sealed: 1 },
      { keyId: null, state: 'unknown_format', sealed: 5 },
    ]);
    // Kinds in the registry's order, only those with stored values.
    expect(overview.kinds).toEqual([
      { kind: 'whatsapp_token', primary: 2, configured: 0, other: 1 },
      { kind: 'http_secret', primary: 6, configured: 4, other: 0 },
      { kind: 'queued_email', primary: 0, configured: 0, other: 5 },
    ]);
    expect(overview.unused).toEqual(['k0']);
  });

  it('shows a lone primary key with nothing sealed yet', () => {
    expect(keyringOverview({ currentKeyId: 'k1', keyIds: ['k1'] }, [])).toEqual({
      primaryKeyId: 'k1',
      keys: [{ keyId: 'k1', state: 'primary', sealed: 0 }],
      kinds: [],
      unused: [],
    });
  });
});

describe('the minute sweep', () => {
  it('looks nothing up while the primary key is the only one', async () => {
    const result = await resealStoredValues(
      { db: noLookups, keyring: ring('k1'), clock },
      newResealState(),
    );
    expect(result).toEqual({ resealed: 0, changed: 0, unopenable: [], failed: [], stopped: false });
  });

  it('looks nothing up within the hour after a lookup found nothing', async () => {
    const state = { ...newResealState(), idleUntil: clock.now().getTime() + 1 };
    const result = await resealStoredValues(
      { db: noLookups, keyring: ring('k2', 'k1'), clock },
      state,
    );
    expect(result.stopped).toBe(false);
    expect(result.resealed + result.changed).toBe(0);
  });

  it('stops once too many values did not open', async () => {
    const state = newResealState();
    for (let i = 0; i < RESEAL_SKIP_LIMIT; i += 1) state.skip.add(`http_secret:${i}`);
    const result = await resealStoredValues(
      { db: noLookups, keyring: ring('k2', 'k1'), clock },
      state,
    );
    expect(result.stopped).toBe(true);
  });
});
