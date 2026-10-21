import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { AppError, isAppError } from '@w360/core';
import { API_SCOPES, type Database, type SQL, type Tx } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import {
  MAX_SAVED_REPLIES,
  writeCreateSavedReply,
  writeDeleteSavedReply,
  writeUpdateSavedReply,
} from '../inbox/saved-replies';
import type { ApiContext } from './context';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_ROUTES, apiSavedReplySchema, buildOpenApiDocument } from './openapi';
import {
  apiCreateSavedReply,
  apiCreateSavedReplySchema,
  apiDeleteSavedReply,
  apiListSavedReplies,
  apiUpdateSavedReply,
  apiUpdateSavedReplySchema,
  toApiSavedReply,
} from './saved-replies';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const REPLY = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const CALLER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const MEMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
const CREATED = new Date('2026-10-01T09:00:00.000Z');
const NOW = new Date('2026-10-07T10:00:00.000Z');

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: CALLER, scopes: new Set(scopes) },
    planScopes: null,
    requestId: 'req-1',
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read or written. */
const untouched = {
  run: () => {
    throw new Error('used the database');
  },
} as unknown as Database;
const deps = { db: untouched, clock: { now: () => NOW } };

/** The code, message and paths of a refusal. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, error.publicMessage, (error.issues ?? []).map((i) => i.path)];
  }
  throw new Error('expected a refusal');
}

/**
 * A transaction that answers its reads and the rows its updates and deletes return, in order, with
 * `answers`, and records each step: the lock taken, reads (with any row lock), reads of a reply's
 * file (`join`, ADR-411), inserts (without their new ids), updates and deletes. An answer beyond
 * them fails the test.
 */
function recorder(answers: unknown[][]) {
  const queue = [...answers];
  const steps: unknown[][] = [];
  const next = () => {
    const rows = queue.shift();
    if (!rows) throw new Error('an unexpected read');
    return rows;
  };
  const tx = {
    execute: (query: SQL) => {
      const { sql, params } = new PgDialect().sqlToQuery(query);
      steps.push(['lock', sql, params]);
      return Promise.resolve({ rows: [] });
    },
    select: () => ({
      from: () => ({
        where: () => {
          const rows = next();
          steps.push(['read']);
          return Object.assign(Promise.resolve(rows), {
            for: (mode: string) => {
              steps[steps.length - 1] = ['read', mode];
              return Promise.resolve(rows);
            },
          });
        },
        innerJoin: () => ({
          where: () => {
            steps.push(['join']);
            return Promise.resolve(next());
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const written = { ...values };
        delete written.id;
        steps.push(['insert', written]);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            steps.push(['update', values]);
            return Promise.resolve(next());
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => {
          steps.push(['delete']);
          return Promise.resolve(next());
        },
      }),
    }),
  } as unknown as Tx;
  return { tx, steps, unread: () => queue.length };
}

/** A database whose transactions run on `tx`, recording the options each was asked for. */
function on(tx: Tx) {
  const runs: unknown[] = [];
  const db = {
    run: (_scope: unknown, fn: (tx: Tx) => Promise<unknown>, options?: unknown) => {
      runs.push(options);
      return fn(tx);
    },
  } as unknown as Database;
  return { db, runs };
}

const thanks = { shortcut: 'thanks', title: 'Thank you', body: 'Thanks, {{name}}!' };

/** A saved reply row as it is read back. */
const row = (overrides: Record<string, unknown> = {}) => ({
  id: REPLY,
  ...thanks,
  createdByApiKeyId: null,
  updatedByMembershipId: MEMBER,
  updatedByApiKeyId: null,
  createdAt: CREATED,
  updatedAt: NOW,
  ...overrides,
});

/** The audit entry of a saved reply change made by the key. */
const audited = (action: string, shortcut: string) => [
  'insert',
  {
    tenantId: TENANT,
    actorType: 'api_key',
    actorId: CALLER,
    action,
    subjectType: 'saved_reply',
    subjectId: REPLY,
    result: 'success',
    correlationId: 'req-1',
    metadata: { shortcut, source: 'api' },
  },
];

describe('saved replies through the API (ADR-291)', () => {
  it('needs saved_replies.manage to write, a scope the database accepts, granted with inbox.supervise', () => {
    expect(API_SCOPES).toContain('saved_replies.manage');
    // After business_hours.manage and before webhooks.manage, in the order the database's checks list them.
    expect(API_SCOPE_KEYS.indexOf('saved_replies.manage')).toBe(
      API_SCOPE_KEYS.indexOf('business_hours.manage') + 1,
    );
    expect(API_SCOPE_KEYS.indexOf('webhooks.manage')).toBeGreaterThan(
      API_SCOPE_KEYS.indexOf('saved_replies.manage'),
    );
    expect(API_SCOPE_INFO['saved_replies.manage']).toMatchObject({
      label: 'Manage saved replies',
      permission: 'inbox.supervise',
      writes: true,
    });
    for (const words of [
      "Read, add, change and delete the company's saved replies",
      'as members who supervise the inbox do in Settings → Saved replies',
      'recorded as changed through the API and in the audit log as done by the key',
      'Keys that send replies read them too.',
    ]) {
      expect(API_SCOPE_INFO['saved_replies.manage'].description).toContain(words);
    }
    // Owners and administrators, who create keys, supervise the inbox.
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('inbox.supervise')).toBe(true);
    }
  });

  it('takes a reply as Settings checks it, and a change of any of its three parts', () => {
    expect(
      apiCreateSavedReplySchema.parse({
        shortcut: ' Thanks ',
        title: ' Thank you ',
        body: ' Thanks, {{name}}! ',
      }),
    ).toEqual(thanks);
    for (const input of [
      { ...thanks, id: REPLY },
      { ...thanks, body: 'Your order {{order}} is ready.' },
      { ...thanks, shortcut: 'two words' },
      { shortcut: 'thanks', title: 'Thank you' },
    ]) {
      expect(apiCreateSavedReplySchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
    expect(apiUpdateSavedReplySchema.parse({ shortcut: ' HI ' })).toEqual({ shortcut: 'hi' });
    expect(apiUpdateSavedReplySchema.parse({ title: 'Thanks again' })).toEqual({
      title: 'Thanks again',
    });
    expect(apiUpdateSavedReplySchema.parse({ body: 'Hello {{agent}}' })).toEqual({
      body: 'Hello {{agent}}',
    });
    for (const input of [
      {},
      { createdBy: 'api' },
      { title: 'Thanks again', createdBy: 'api' },
      { body: 'Hello {{price}}' },
      { title: '  ' },
      { shortcut: 'x'.repeat(33) },
    ]) {
      expect(apiUpdateSavedReplySchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
    expect(apiUpdateSavedReplySchema.safeParse({}).error?.issues[0]?.message).toBe(
      'Give at least one of `shortcut`, `title` and `body`.',
    );
  });

  it('refuses before touching anything: the scope, a suspended company, an unknown id, a bad body', async () => {
    const replies = ctx(['messages.reply']);
    expect(await refusal(apiCreateSavedReply(deps, replies, thanks, null))).toEqual([
      'forbidden',
      'This API key does not have the saved_replies.manage scope.',
      [],
    ]);
    expect((await refusal(apiUpdateSavedReply(deps, replies, REPLY, { title: 'A' })))[0]).toBe(
      'forbidden',
    );
    expect((await refusal(apiDeleteSavedReply(deps, replies, REPLY)))[0]).toBe('forbidden');
    expect(await refusal(apiListSavedReplies(deps, ctx(['contacts.read'])))).toEqual([
      'forbidden',
      'This API key does not have the messages.reply scope.',
      [],
    ]);
    for (const status of ['suspended', 'restricted']) {
      const suspended = ctx(['saved_replies.manage'], status);
      for (const attempt of [
        () => apiCreateSavedReply(deps, suspended, thanks, null),
        () => apiUpdateSavedReply(deps, suspended, REPLY, { title: 'A' }),
        () => apiDeleteSavedReply(deps, suspended, REPLY),
      ]) {
        expect((await refusal(attempt()))[0]).toBe('tenant_suspended');
      }
    }
    const key = ctx(['saved_replies.manage']);
    expect(await refusal(apiUpdateSavedReply(deps, key, 'thanks', { title: 'A' }))).toEqual([
      'not_found',
      'Saved reply not found.',
      [],
    ]);
    expect((await refusal(apiDeleteSavedReply(deps, key, 'thanks')))[1]).toBe(
      'Saved reply not found.',
    );
    expect(
      (await refusal(apiCreateSavedReply(deps, key, { ...thanks, body: '{{price}}' }, null)))[2],
    ).toEqual(['body']);
    expect((await refusal(apiUpdateSavedReply(deps, key, REPLY, { title: '' })))[2]).toEqual([
      'title',
    ]);
  });

  it('lists them all by shortcut, read only, for keys that reply or manage them, even while suspended', async () => {
    const byKey = row({
      id: CALLER,
      shortcut: 'hours',
      createdByApiKeyId: CALLER,
      updatedByMembershipId: null,
      updatedByApiKeyId: CALLER,
    });
    for (const scopes of [['messages.reply'], ['saved_replies.manage']]) {
      for (const status of ['active', 'suspended']) {
        const limits: unknown[] = [];
        const tx = {
          select: () => ({
            from: () => ({
              // The replies' files (ADR-411): none.
              innerJoin: () => ({ where: () => Promise.resolve([]) }),
              where: () => ({
                orderBy: () => ({
                  limit: (n: number) => {
                    limits.push(n);
                    return Promise.resolve([
                      byKey,
                      row({ updatedByMembershipId: null, updatedByApiKeyId: CALLER }),
                    ]);
                  },
                }),
              }),
            }),
          }),
        } as unknown as Tx;
        const { db, runs } = on(tx);
        const { data } = await apiListSavedReplies({ db }, ctx(scopes, status));
        expect(data.map((r) => [r.shortcut, r.createdBy, r.updatedBy])).toEqual([
          ['hours', 'api', 'api'],
          ['thanks', 'member', 'api'],
        ]);
        expect(runs).toEqual([{ accessMode: 'read only' }]);
        expect(data.map((r) => r.attachment)).toEqual([null, null]);
        expect(limits).toEqual([MAX_SAVED_REPLIES]);
      }
    }
    expect(MAX_SAVED_REPLIES).toBe(500);
  });

  it('gives who added and last changed a reply, a member (never which) or a key by its id', () => {
    expect(toApiSavedReply(row())).toEqual({
      id: REPLY,
      ...thanks,
      createdBy: 'member',
      createdByApiKeyId: null,
      updatedBy: 'member',
      updatedByApiKeyId: null,
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-07T10:00:00.000Z',
      attachment: null,
    });
    expect(toApiSavedReply(row({ createdByApiKeyId: CALLER }))).toMatchObject({
      createdBy: 'api',
      createdByApiKeyId: CALLER,
      updatedBy: 'member',
    });
    expect(
      toApiSavedReply(row({ updatedByMembershipId: null, updatedByApiKeyId: CALLER })),
    ).toMatchObject({ createdBy: 'member', updatedBy: 'api', updatedByApiKeyId: CALLER });
    // A member's change from a server of an earlier release, which leaves the key's column as it
    // was: the member changed it last.
    expect(toApiSavedReply(row({ updatedByApiKeyId: CALLER }))).toMatchObject({
      updatedBy: 'member',
      updatedByApiKeyId: null,
    });
    expect(
      apiSavedReplySchema.safeParse(toApiSavedReply(row({ createdByApiKeyId: CALLER }))).success,
    ).toBe(true);
  });

  it("adds a reply within the company's limit, counted under its lock, as the key or the member", async () => {
    const byKey = recorder([[{ n: MAX_SAVED_REPLIES - 1 }]]);
    const id = await writeCreateSavedReply(byKey.tx, TENANT, thanks, { apiKeyId: CALLER });
    expect(byKey.steps).toEqual([
      [
        'lock',
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`saved-replies:${TENANT}`],
      ],
      ['read'],
      [
        'insert',
        {
          tenantId: TENANT,
          ...thanks,
          createdByMembershipId: null,
          createdByApiKeyId: CALLER,
          updatedByMembershipId: null,
          updatedByApiKeyId: CALLER,
        },
      ],
    ]);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const byMember = recorder([[]]);
    await writeCreateSavedReply(byMember.tx, TENANT, thanks, { membershipId: MEMBER });
    expect(byMember.steps.at(-1)).toEqual([
      'insert',
      {
        tenantId: TENANT,
        ...thanks,
        createdByMembershipId: MEMBER,
        createdByApiKeyId: null,
        updatedByMembershipId: MEMBER,
        updatedByApiKeyId: null,
      },
    ]);
    const full = recorder([[{ n: MAX_SAVED_REPLIES }]]);
    expect(
      await refusal(writeCreateSavedReply(full.tx, TENANT, thanks, { apiKeyId: CALLER })),
    ).toEqual([
      'conflict',
      'The company already has 500 saved replies. Delete one before adding another.',
      [],
    ]);
    expect(full.steps.map((s) => s[0])).toEqual(['lock', 'read']);
  });

  it('changes a reply naming who changed it last, and deletes one; neither finds another company’s', async () => {
    // Under the company's lock, the reply's file read first (ADR-411): none here.
    const byKey = recorder([[], [{ id: REPLY }]]);
    expect(await writeUpdateSavedReply(byKey.tx, TENANT, REPLY, thanks, { apiKeyId: CALLER })).toBe(
      true,
    );
    expect(byKey.steps).toEqual([
      [
        'lock',
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`saved-replies:${TENANT}`],
      ],
      ['join'],
      ['update', { ...thanks, updatedByMembershipId: null, updatedByApiKeyId: CALLER }],
    ]);
    const byMember = recorder([[], [{ id: REPLY }]]);
    await writeUpdateSavedReply(byMember.tx, TENANT, REPLY, thanks, { membershipId: MEMBER });
    expect(byMember.steps.at(-1)).toEqual([
      'update',
      { ...thanks, updatedByMembershipId: MEMBER, updatedByApiKeyId: null },
    ]);
    const missing = recorder([[], []]);
    expect(
      await writeUpdateSavedReply(missing.tx, TENANT, REPLY, thanks, { apiKeyId: CALLER }),
    ).toBe(false);
    const deleted = recorder([[], [{ shortcut: 'thanks' }]]);
    expect(await writeDeleteSavedReply(deleted.tx, TENANT, REPLY)).toEqual({ shortcut: 'thanks' });
    expect(deleted.steps.map((s) => s[0])).toEqual(['lock', 'join', 'delete']);
    expect(await writeDeleteSavedReply(recorder([[], []]).tx, TENANT, REPLY)).toBeNull();
  });

  it('adds a reply as the key, audited as the key, and answers 201 with it', async () => {
    const byKey = {
      createdByApiKeyId: CALLER,
      updatedByMembershipId: null,
      updatedByApiKeyId: CALLER,
    };
    const added = recorder([[{ n: 3 }], [row(byKey)], []]);
    const { db } = on(added.tx);
    const response = await apiCreateSavedReply(
      { db, clock: { now: () => NOW } },
      ctx(['saved_replies.manage']),
      { shortcut: ' Thanks ', title: 'Thank you', body: 'Thanks, {{name}}!' },
      null,
    );
    expect(response).toEqual({
      status: 201,
      body: {
        data: toApiSavedReply(row(byKey)),
      },
      replayed: false,
    });
    const [lock, count, insert, audit, readBack, file] = added.steps;
    expect([lock?.[0], count, readBack, file]).toEqual(['lock', ['read'], ['read'], ['join']]);
    expect(insert).toEqual([
      'insert',
      expect.objectContaining({ ...thanks, createdByApiKeyId: CALLER, updatedByApiKeyId: CALLER }),
    ]);
    expect(audit).toEqual([
      'insert',
      expect.objectContaining({
        actorType: 'api_key',
        actorId: CALLER,
        action: 'saved_reply.created',
        subjectType: 'saved_reply',
        correlationId: 'req-1',
        metadata: { shortcut: 'thanks', source: 'api' },
      }),
    ]);
    expect(added.unread()).toBe(0);
  });

  it('changes only what is given, leaves a reply already so unwritten and unaudited, and audits the rest as the key', async () => {
    const current = { ...thanks };
    for (const [change, written] of [
      [{ title: 'Thanks again' }, { ...thanks, title: 'Thanks again' }],
      [{ body: 'Thank you, {{name}}.' }, { ...thanks, body: 'Thank you, {{name}}.' }],
      [{ shortcut: 'ty' }, { ...thanks, shortcut: 'ty' }],
    ] as const) {
      const changed = recorder([[current], [], [{ id: REPLY }], [row(written)], []]);
      const { db } = on(changed.tx);
      expect(
        await apiUpdateSavedReply({ db }, ctx(['saved_replies.manage']), REPLY, change),
      ).toEqual(toApiSavedReply(row(written)));
      // The company's lock before the reply's row lock (ADR-411), then the reply's file.
      expect(changed.steps).toEqual([
        [
          'lock',
          'select pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`saved-replies:${TENANT}`],
        ],
        ['read', 'update'],
        [
          'lock',
          'select pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`saved-replies:${TENANT}`],
        ],
        ['join'],
        ['update', { ...written, updatedByMembershipId: null, updatedByApiKeyId: CALLER }],
        audited('saved_reply.updated', written.shortcut),
        ['read'],
        ['join'],
      ]);
    }
    // The same text after the checks tidy it: nothing written, nothing audited.
    const same = recorder([[current], [row()], []]);
    const { db } = on(same.tx);
    expect(
      await apiUpdateSavedReply({ db }, ctx(['saved_replies.manage']), REPLY, {
        shortcut: ' THANKS ',
        title: 'Thank you ',
      }),
    ).toEqual(toApiSavedReply(row()));
    expect(same.steps.map((s) => s.slice(0, 2))).toEqual([
      ['lock', 'select pg_advisory_xact_lock(hashtextextended($1, 0))'],
      ['read', 'update'],
      ['read'],
      ['join'],
    ]);
    const missing = recorder([[]]);
    expect(
      (
        await refusal(
          apiUpdateSavedReply({ db: on(missing.tx).db }, ctx(['saved_replies.manage']), REPLY, {
            title: 'A',
          }),
        )
      )[1],
    ).toBe('Saved reply not found.');
    expect(missing.steps.map((s) => s[0])).toEqual(['lock', 'read']);
  });

  it('deletes a reply audited as the key; one already deleted answers 404', async () => {
    const deleted = recorder([[], [{ shortcut: 'thanks' }]]);
    expect(
      await apiDeleteSavedReply({ db: on(deleted.tx).db }, ctx(['saved_replies.manage']), REPLY),
    ).toEqual({ id: REPLY, deleted: true });
    expect(deleted.steps).toEqual([
      [
        'lock',
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`saved-replies:${TENANT}`],
      ],
      ['join'],
      ['delete'],
      audited('saved_reply.deleted', 'thanks'),
    ]);
    const gone = recorder([[], []]);
    expect(
      await refusal(
        apiDeleteSavedReply({ db: on(gone.tx).db }, ctx(['saved_replies.manage']), REPLY),
      ),
    ).toEqual(['not_found', 'Saved reply not found.', []]);
    expect(gone.steps.map((s) => s[0])).toEqual(['lock', 'join', 'delete']);
  });

  it('answers a shortcut another reply has with 409, adding or changing', async () => {
    const taken = new AppError('conflict', 'A record with the same unique value already exists.', {
      details: { constraint: 'saved_replies_shortcut_uq' },
    });
    const db = {
      run: () => Promise.reject(taken),
    } as unknown as Database;
    const key = ctx(['saved_replies.manage']);
    for (const attempt of [
      () => apiCreateSavedReply({ db, clock: { now: () => NOW } }, key, thanks, null),
      () => apiUpdateSavedReply({ db }, key, REPLY, { shortcut: 'hours' }),
    ]) {
      expect(await refusal(attempt())).toEqual([
        'conflict',
        'Another saved reply already uses this shortcut.',
        [],
      ]);
    }
    // Any other conflict stays as it is.
    const other = new AppError('conflict', 'The operation conflicted with a concurrent change.');
    expect(
      await refusal(
        apiCreateSavedReply(
          { db: { run: () => Promise.reject(other) } as unknown as Database, clock: deps.clock },
          key,
          thanks,
          null,
        ),
      ),
    ).toEqual(['conflict', 'The operation conflicted with a concurrent change.', []]);
  });

  it('is described: the scopes, the checks, the limit, retries and placeholders', () => {
    for (const route of [
      ['get', '/saved-replies'],
      ['post', '/saved-replies'],
      ['patch', '/saved-replies/{id}'],
      ['delete', '/saved-replies/{id}'],
    ]) {
      expect(API_ROUTES).toContainEqual(route);
    }
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { operationId: string; description: string }>>;
    };
    const list = doc.paths['/saved-replies']?.get;
    expect(list?.operationId).toBe('listSavedReplies');
    for (const words of [
      '`messages.reply` or `saved_replies.manage`',
      'all of them (a company keeps at most 500), by shortcut',
      'fill {{name}}, {{agent}} and {{company}} before sending it',
      'Reading works while the company is suspended.',
    ]) {
      expect(list?.description).toContain(words);
    }
    const create = doc.paths['/saved-replies']?.post;
    expect(create?.operationId).toBe('createSavedReply');
    for (const words of [
      'Scope: `saved_replies.manage`.',
      'a shortcut unique in the company (409 otherwise)',
      'with only the placeholders {{name}}, {{agent}} and {{company}} (422 otherwise)',
      'A company keeps at most 500 (409 at the limit: delete one first)',
      'Settings shows it as changed through the API, and the audit log names the key.',
      'With an `Idempotency-Key`, a retry answers the first response.',
    ]) {
      expect(create?.description).toContain(words);
    }
    const update = doc.paths['/saved-replies/{id}']?.patch;
    expect(update?.operationId).toBe('updateSavedReply');
    for (const words of [
      'what is given changes and the rest stays as it is',
      'A change that leaves the reply as it is answers it as it is, with no audit entry, so a retry needs no `Idempotency-Key`',
    ]) {
      expect(update?.description).toContain(words);
    }
    const remove = doc.paths['/saved-replies/{id}']?.delete;
    expect(remove?.operationId).toBe('deleteSavedReply');
    expect(remove?.description).toContain('One already deleted answers 404.');
  });
});
