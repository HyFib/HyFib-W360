import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import type { Database, SQL, TenantRole, Tx } from '@w360/db';
import type { TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import type { ApiContext } from '../api/context';
import { apiCreateSavedReply, toApiSavedReplyAttachment } from '../api/saved-replies';
import { apiSavedReplySchema, buildOpenApiDocument } from '../api/openapi';
import {
  createFileRepliesService,
  REPLY_FILE_MAX_BYTES,
  REPLY_FILE_TYPES,
  savedReplyFileReplySchema,
} from '../messaging/file-replies';
import { EXPORT_TABLES } from '../tenancy/export-spec';
import { exportRow } from '../tenancy/export';
import {
  createSavedRepliesService,
  savedReplyGoneError,
  writeDeleteSavedReply,
  writeUpdateSavedReply,
} from './saved-replies';
import {
  SAVED_REPLY_CAPTION_MAX,
  SAVED_REPLY_FILES_MAX_TOTAL_BYTES,
  checkSavedReplyText,
  deleteUnusedSavedReplyFiles,
  readableSavedReplyFile,
  savedReplyFileContent,
  savedReplyTextLimit,
  takesCaption,
  writeAttachSavedReplyFile,
  writeRemoveSavedReplyFile,
} from './saved-reply-files';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const REPLY = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const MEMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
const OLD_FILE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f05';
const STORED_FILE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f06';
const CONVERSATION = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f07';
const MB = 1024 * 1024;

const LOCK = 'select pg_advisory_xact_lock(hashtextextended($1, 0))';

const photo = (size = 10, name = 'price list.png') => ({
  name,
  type: 'image/png',
  bytes: new Uint8Array(size).fill(7) as Uint8Array<ArrayBuffer>,
});
const recording = { name: 'hello.ogg', type: 'audio/ogg', bytes: new Uint8Array(4).fill(1) };

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
 * A transaction answering, in order, each read (a select, a join, an `execute` other than the lock,
 * a delete's returned rows) with `answers`, and recording every step: the lock, reads, joins,
 * inserts (their values without ids), deletes. An answer beyond them fails the test.
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
      if (sql === LOCK) {
        steps.push(['lock', params]);
        return Promise.resolve({ rows: [] });
      }
      steps.push(['execute']);
      return Promise.resolve({ rows: next() });
    },
    select: () => ({
      from: () => ({
        where: () => {
          steps.push(['read']);
          return Promise.resolve(next());
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
      set: () => ({
        where: () => ({
          returning: () => {
            steps.push(['update']);
            return Promise.resolve(next());
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        // Awaited without `returning`: a plain delete.
        then: (resolve: (value: undefined) => void, reject: (error: unknown) => void) => {
          steps.push(['delete']);
          return Promise.resolve(undefined).then(resolve, reject);
        },
        returning: () => {
          steps.push(['delete returning']);
          return Promise.resolve(next());
        },
      }),
    }),
  } as unknown as Tx;
  return { tx, steps, unread: () => queue.length };
}

const ctxOf = (roles: TenantRole[]) => {
  const permissions = permissionsForRoles(roles);
  return {
    permissions,
    rolePermissions: permissions,
    tenant: { id: TENANT, status: 'active', name: 'Acme' },
    membership: { id: MEMBER },
    user: { name: 'Asha' },
    scope: {},
  } as unknown as TenantContext;
};

/** A database that fails the test if anything is read or written. */
const untouched = {
  run: () => {
    throw new Error('used the database');
  },
} as unknown as Database;

describe('what a saved reply’s text may be with a file (ADR-411)', () => {
  it('is a caption of at most 1,024 characters with a photo, video or document, and stays text with a recording', () => {
    expect(SAVED_REPLY_CAPTION_MAX).toBe(1024);
    for (const kind of ['image', 'video', 'document'] as const) {
      expect(takesCaption(kind), kind).toBe(true);
      expect(savedReplyTextLimit(kind), kind).toBe(1024);
    }
    for (const kind of ['audio', null, undefined] as const) {
      expect(takesCaption(kind), String(kind)).toBe(false);
      expect(savedReplyTextLimit(kind), String(kind)).toBe(4096);
    }
    expect(() => checkSavedReplyText('x'.repeat(1024), 'image')).not.toThrow();
    expect(() => checkSavedReplyText('x'.repeat(4096), 'audio')).not.toThrow();
    expect(() => checkSavedReplyText('x'.repeat(4096), null)).not.toThrow();
    try {
      checkSavedReplyText('x'.repeat(1025), 'document');
      throw new Error('accepted');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'validation_failed',
        issues: [{ path: 'body' }],
      });
      expect((error as Error & { publicMessage: string }).publicMessage).toContain(
        'limited to 1024 characters',
      );
    }
  });

  it('refuses a change of the text that the reply’s photo cannot carry, before writing', async () => {
    const tx = recorder([[{ fileId: OLD_FILE, kind: 'image' }], [{ body: 'Short' }]]);
    expect(
      (
        await refusal(
          writeUpdateSavedReply(
            tx.tx,
            TENANT,
            REPLY,
            { shortcut: 'hi', title: 'Hi', body: 'x'.repeat(1025) },
            { membershipId: MEMBER },
          ),
        )
      )[2],
    ).toEqual(['body']);
    expect(tx.steps).toEqual([['lock', [`saved-replies:${TENANT}`]], ['join'], ['read']]);
  });

  it('lets the title change on a reply whose long text an older server stored with its photo', async () => {
    const long = 'x'.repeat(1025);
    const tx = recorder([[{ fileId: OLD_FILE, kind: 'image' }], [{ body: long }], [{ id: REPLY }]]);
    expect(
      await writeUpdateSavedReply(
        tx.tx,
        TENANT,
        REPLY,
        { shortcut: 'hi', title: 'Renamed', body: long },
        { membershipId: MEMBER },
      ),
    ).toBe(true);
    expect(tx.steps.map((s) => s[0])).toEqual(['lock', 'join', 'read', 'update']);
    // Within the limit, the stored text is not read again.
    const short = recorder([[{ fileId: OLD_FILE, kind: 'image' }], [{ id: REPLY }]]);
    await writeUpdateSavedReply(
      short.tx,
      TENANT,
      REPLY,
      { shortcut: 'hi', title: 'Hi', body: 'Short' },
      { membershipId: MEMBER },
    );
    expect(short.steps.map((s) => s[0])).toEqual(['lock', 'join', 'update']);
  });
});

describe('giving a saved reply a file (ADR-411)', () => {
  it('checks the file as the inbox does before taking the lock', async () => {
    for (const file of [
      photo(0),
      photo(REPLY_FILE_MAX_BYTES + 1),
      { ...photo(), type: 'image/gif' },
    ]) {
      const tx = recorder([]);
      expect(
        (await refusal(writeAttachSavedReplyFile(tx.tx, TENANT, REPLY, file, MEMBER)))[0],
      ).toBe('validation_failed');
      expect(tx.steps).toEqual([]);
    }
  });

  it('answers 404 for another company’s or a deleted reply, and refuses a text too long for a caption', async () => {
    const gone = recorder([[]]);
    expect(
      (await refusal(writeAttachSavedReplyFile(gone.tx, TENANT, REPLY, photo(), MEMBER)))[0],
    ).toBe('not_found');
    const long = recorder([[{ shortcut: 'list', body: 'x'.repeat(1025) }]]);
    expect(
      (await refusal(writeAttachSavedReplyFile(long.tx, TENANT, REPLY, photo(), MEMBER)))[2],
    ).toEqual(['body']);
    expect(long.steps.map((s) => s[0])).toEqual(['lock', 'read']);
    // A recording takes no caption, so a long text is fine with it.
    const voice = recorder([
      [{ shortcut: 'hi', body: 'x'.repeat(4000) }],
      [],
      [],
      [],
      [{ bytes: '0' }],
    ]);
    await writeAttachSavedReplyFile(voice.tx, TENANT, REPLY, recording, MEMBER);
    expect(voice.steps.filter((s) => s[0] === 'insert')).toHaveLength(2);
  });

  it('stores a new file once, with its SHA-256 and cleaned name, and names it from the reply', async () => {
    const file = photo(10, 'price:list.png');
    const tx = recorder([[{ shortcut: 'list', body: 'Our prices' }], [], [], [], [{ bytes: '0' }]]);
    const result = await writeAttachSavedReplyFile(tx.tx, TENANT, REPLY, file, MEMBER);
    expect(result).toMatchObject({
      shortcut: 'list',
      shared: false,
      unchanged: false,
      replacedFileId: null,
      attachment: {
        kind: 'image',
        mimeType: 'image/png',
        filename: 'price list.png',
        sizeBytes: 10,
      },
    });
    expect(tx.steps).toEqual([
      ['lock', [`saved-replies:${TENANT}`]],
      ['read'],
      // Files an older server left without a reply are deleted first.
      ['delete returning'],
      ['read'],
      ['join'],
      ['read'],
      [
        'insert',
        {
          tenantId: TENANT,
          kind: 'image',
          mimeType: 'image/png',
          filename: 'price list.png',
          sizeBytes: 10,
          sha256: createHash('sha256').update(file.bytes).digest('hex'),
          content: file.bytes,
          createdByMembershipId: MEMBER,
        },
      ],
      [
        'insert',
        {
          tenantId: TENANT,
          savedReplyId: REPLY,
          fileId: result.attachment.fileId,
          attachedByMembershipId: MEMBER,
        },
      ],
    ]);
    expect(tx.unread()).toBe(0);
  });

  it('shares the company’s stored file with the same bytes, type and name instead of storing it again', async () => {
    const tx = recorder([[{ shortcut: 'list', body: 'Prices' }], [], [{ id: STORED_FILE }], []]);
    const result = await writeAttachSavedReplyFile(tx.tx, TENANT, REPLY, photo(), MEMBER);
    expect(result).toMatchObject({ shared: true, unchanged: false });
    expect(result.attachment.fileId).toBe(STORED_FILE);
    const inserts = tx.steps.filter((s) => s[0] === 'insert');
    expect(inserts).toEqual([
      ['insert', expect.objectContaining({ savedReplyId: REPLY, fileId: STORED_FILE })],
    ]);
    // No total counted: nothing new is stored.
    expect(tx.steps.map((s) => s[0])).toEqual([
      'lock',
      'read',
      'delete returning',
      'read',
      'join',
      'insert',
    ]);
  });

  it('changes nothing when the reply already carries that very file', async () => {
    const tx = recorder([
      [{ shortcut: 'list', body: 'Prices' }],
      [],
      [{ id: STORED_FILE }],
      [{ fileId: STORED_FILE, kind: 'image' }],
    ]);
    const result = await writeAttachSavedReplyFile(tx.tx, TENANT, REPLY, photo(), MEMBER);
    expect(result).toMatchObject({ unchanged: true, replacedFileId: null });
    expect(tx.steps.map((s) => s[0])).toEqual(['lock', 'read', 'delete returning', 'read', 'join']);
  });

  it(`keeps the company within ${SAVED_REPLY_FILES_MAX_TOTAL_BYTES / MB} MB of files, counting a replaced file as freed only when no other reply has it`, async () => {
    expect(SAVED_REPLY_FILES_MAX_TOTAL_BYTES).toBe(100 * MB);
    const over = recorder([
      [{ shortcut: 'list', body: 'Prices' }],
      [],
      [],
      [],
      [{ bytes: String(SAVED_REPLY_FILES_MAX_TOTAL_BYTES - 9) }],
    ]);
    expect(
      await refusal(writeAttachSavedReplyFile(over.tx, TENANT, REPLY, photo(10), MEMBER)),
    ).toEqual([
      'conflict',
      'Saved replies’ files are limited to 100 MB for the company. Remove a file from another saved reply first.',
      [],
    ]);
    expect(over.steps.some((s) => s[0] === 'insert')).toBe(false);
    // Exactly at the limit is allowed.
    const at = recorder([
      [{ shortcut: 'list', body: 'Prices' }],
      [],
      [],
      [],
      [{ bytes: String(SAVED_REPLY_FILES_MAX_TOTAL_BYTES - 10) }],
    ]);
    await writeAttachSavedReplyFile(at.tx, TENANT, REPLY, photo(10), MEMBER);
    // Replacing a 5-byte file only this reply has frees its bytes.
    const freed = recorder([
      [{ shortcut: 'list', body: 'Prices' }],
      [],
      [],
      [{ fileId: OLD_FILE, kind: 'image' }],
      [{ bytes: String(SAVED_REPLY_FILES_MAX_TOTAL_BYTES - 5) }],
      [{ named: false }],
      [{ sizeBytes: 5 }],
      [{ id: OLD_FILE }],
    ]);
    const replaced = await writeAttachSavedReplyFile(freed.tx, TENANT, REPLY, photo(10), MEMBER);
    expect(replaced.replacedFileId).toBe(OLD_FILE);
    expect(freed.steps.map((s) => s[0])).toEqual([
      'lock',
      'read',
      'delete returning',
      'read',
      'join',
      'read',
      'execute',
      'read',
      'insert',
      'delete',
      'insert',
      'delete returning',
    ]);
    // When another reply still has it, it stays and frees nothing.
    const shared = recorder([
      [{ shortcut: 'list', body: 'Prices' }],
      [],
      [],
      [{ fileId: OLD_FILE, kind: 'image' }],
      [{ bytes: String(SAVED_REPLY_FILES_MAX_TOTAL_BYTES - 5) }],
      [{ named: true }],
    ]);
    expect(
      (await refusal(writeAttachSavedReplyFile(shared.tx, TENANT, REPLY, photo(10), MEMBER)))[0],
    ).toBe('conflict');
  });

  it('takes a file away, deleting it only when no other reply has it; a reply without one answers null', async () => {
    const none = recorder([[{ shortcut: 'list' }], []]);
    expect(await writeRemoveSavedReplyFile(none.tx, TENANT, REPLY)).toBeNull();
    expect(none.steps.map((s) => s[0])).toEqual(['lock', 'read', 'join']);
    const last = recorder([
      [{ shortcut: 'list' }],
      [{ fileId: OLD_FILE, kind: 'video' }],
      [{ id: OLD_FILE }],
    ]);
    expect(await writeRemoveSavedReplyFile(last.tx, TENANT, REPLY)).toEqual({
      shortcut: 'list',
      kind: 'video',
      fileDeleted: true,
    });
    expect(last.steps.map((s) => s[0])).toEqual([
      'lock',
      'read',
      'join',
      'delete',
      'delete returning',
    ]);
    const kept = recorder([[{ shortcut: 'list' }], [{ fileId: OLD_FILE, kind: 'video' }], []]);
    expect((await writeRemoveSavedReplyFile(kept.tx, TENANT, REPLY))?.fileDeleted).toBe(false);
    const gone = recorder([[]]);
    expect((await refusal(writeRemoveSavedReplyFile(gone.tx, TENANT, REPLY)))[0]).toBe('not_found');
  });

  it('deletes a reply’s file with the reply when no other reply has it', async () => {
    const attached = {
      savedReplyId: REPLY,
      fileId: OLD_FILE,
      kind: 'image',
      mimeType: 'image/png',
      filename: 'a.png',
      sizeBytes: 3,
    };
    const tx = recorder([[attached], [{ shortcut: 'list' }], [{ id: OLD_FILE }]]);
    expect(await writeDeleteSavedReply(tx.tx, TENANT, REPLY)).toEqual({ shortcut: 'list' });
    expect(tx.steps.map((s) => s[0])).toEqual([
      'lock',
      'join',
      'delete returning',
      'delete returning',
    ]);
    expect(tx.unread()).toBe(0);
  });

  it('reads only the part of a file a Range request asks for, and nothing for a part past its end', async () => {
    const meta = { filename: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 10 };
    const sizes: number[] = [];
    const part = recorder([[meta], [{ content: Buffer.from('2345') }]]);
    expect(
      await savedReplyFileContent(part.tx, TENANT, OLD_FILE, (size) => {
        sizes.push(size);
        return { kind: 'part', start: 2, end: 5 };
      }),
    ).toEqual({ ...meta, part: { kind: 'part', start: 2, end: 5 }, content: Buffer.from('2345') });
    expect(sizes).toEqual([10]);
    expect(part.steps).toEqual([['read'], ['read']]);
    const past = recorder([[meta]]);
    expect(
      (await savedReplyFileContent(past.tx, TENANT, OLD_FILE, () => ({ kind: 'unsatisfiable' })))
        ?.content.byteLength,
    ).toBe(0);
    expect(past.steps).toEqual([['read']]);
    const whole = recorder([[meta], [{ content: new Uint8Array(10) }]]);
    expect((await savedReplyFileContent(whole.tx, TENANT, OLD_FILE))?.part).toEqual({
      kind: 'whole',
    });
    expect(await savedReplyFileContent(recorder([[]]).tx, TENANT, OLD_FILE)).toBeNull();
  });

  it('answers a reply deleted during an attach (an older server’s delete) as not found', () => {
    const gone = Object.assign(new Error('insert or update violates foreign key constraint'), {
      code: '23503',
      constraint: 'saved_reply_attachments_reply_fk',
    });
    expect(savedReplyGoneError(gone)).toMatchObject({ code: 'not_found' });
    const other = Object.assign(new Error('fk'), {
      code: '23503',
      constraint: 'saved_reply_attachments_file_fk',
    });
    expect(savedReplyGoneError(other)).toBe(other);
    const unique = Object.assign(new Error('dup'), {
      code: '23505',
      constraint: 'saved_reply_attachments_reply_fk',
    });
    expect(savedReplyGoneError(unique)).toBe(unique);
  });

  it('deletes unused files only when given some, each once', async () => {
    const nothing = recorder([]);
    expect(await deleteUnusedSavedReplyFiles(nothing.tx, TENANT, [null, null])).toBe(0);
    expect(nothing.steps).toEqual([]);
    const some = recorder([[{ id: OLD_FILE }]]);
    expect(await deleteUnusedSavedReplyFiles(some.tx, TENANT, [OLD_FILE, OLD_FILE, null])).toBe(1);
    expect(some.steps).toEqual([['delete returning']]);
  });

  it('reports a file as unreadable when its bytes do not match or its type is no longer one members send', async () => {
    const view = { savedReplyId: REPLY, fileId: OLD_FILE, filename: 'a.png', sizeBytes: 3 };
    expect(
      await readableSavedReplyFile(
        recorder([[{ ...view, kind: 'image', mimeType: 'image/png', readable: true }]]).tx,
        TENANT,
        REPLY,
      ),
    ).toMatchObject({ readable: true, fileId: OLD_FILE });
    expect(
      (
        await readableSavedReplyFile(
          recorder([[{ ...view, kind: 'image', mimeType: 'image/png', readable: false }]]).tx,
          TENANT,
          REPLY,
        )
      )?.readable,
    ).toBe(false);
    expect(
      (
        await readableSavedReplyFile(
          recorder([[{ ...view, kind: 'image', mimeType: 'image/gif', readable: true }]]).tx,
          TENANT,
          REPLY,
        )
      )?.readable,
    ).toBe(false);
    expect(await readableSavedReplyFile(recorder([[]]).tx, TENANT, REPLY)).toBeNull();
  });
});

describe('who manages and who uses saved replies’ files (ADR-411)', () => {
  const service = createSavedRepliesService({ db: untouched, clock: { now: () => new Date() } });

  it('lets only members who supervise the inbox add or remove a file', async () => {
    for (const role of ['agent', 'marketer'] as const) {
      expect((await refusal(service.attachSavedReplyFile(ctxOf([role]), REPLY, photo())))[0]).toBe(
        'forbidden',
      );
      expect((await refusal(service.removeSavedReplyFile(ctxOf([role]), REPLY)))[0]).toBe(
        'forbidden',
      );
    }
  });

  it('lets members who reply, without managing, check a file when inserting it and look at it', async () => {
    const agent = ctxOf(['agent']);
    expect(agent.permissions.has('inbox.supervise')).toBe(false);
    expect(agent.permissions.has('inbox.reply')).toBe(true);
    // Allowed past the permission: the database is reached.
    await expect(service.savedReplyFileForInsert(agent, CONVERSATION, REPLY)).rejects.toThrow(
      'used the database',
    );
    await expect(service.openSavedReplyFile(agent, OLD_FILE)).rejects.toThrow('used the database');
    expect(await service.openSavedReplyFile(agent, 'not-a-uuid')).toBeNull();
    expect((await refusal(service.savedReplyFileForInsert(agent, 'x', REPLY)))[0]).toBe(
      'not_found',
    );
    const marketer = ctxOf(['marketer']);
    expect(marketer.permissions.has('inbox.reply')).toBe(false);
    expect((await refusal(service.savedReplyFileForInsert(marketer, CONVERSATION, REPLY)))[0]).toBe(
      'forbidden',
    );
    expect((await refusal(service.openSavedReplyFile(marketer, OLD_FILE)))[0]).toBe('forbidden');
  });

  it('reports a file that is gone or unreadable when inserted, not when sent', async () => {
    const answers = (file: unknown[]) => {
      const tx = recorder([[{ assignedMembershipId: null }], [{ title: 'Price list' }], file]);
      return {
        run: (_scope: unknown, fn: (tx: Tx) => Promise<unknown>) => fn(tx.tx),
      } as unknown as Database;
    };
    const agent = ctxOf(['agent']);
    const view = { savedReplyId: REPLY, fileId: OLD_FILE, filename: 'a.png', sizeBytes: 3 };
    const of = (db: Database) =>
      createSavedRepliesService({ db, clock: { now: () => new Date() } }).savedReplyFileForInsert(
        agent,
        CONVERSATION,
        REPLY,
      );
    expect(await refusal(of(answers([])))).toEqual([
      'conflict',
      'The file of “Price list” was removed after the page loaded, so nothing was inserted. Reload the page to see the saved reply as it is now.',
      [],
    ]);
    expect(
      await refusal(
        of(answers([{ ...view, kind: 'image', mimeType: 'image/png', readable: false }])),
      ),
    ).toEqual([
      'precondition_failed',
      'The file of “Price list” can no longer be read, so nothing was inserted. A supervisor can attach it again in Settings → Saved replies.',
      [],
    ]);
    expect(
      await of(answers([{ ...view, kind: 'audio', mimeType: 'audio/ogg', readable: true }])),
    ).toEqual({
      fileId: OLD_FILE,
      kind: 'audio',
      mimeType: 'audio/ogg',
      filename: 'a.png',
      sizeBytes: 3,
      caption: false,
    });
  });
});

describe('sending a saved reply’s file from the inbox (ADR-411)', () => {
  const base = {
    conversationId: CONVERSATION,
    clientKey: 'file-1234abcd',
    savedReplyId: REPLY,
    savedReplyFileId: OLD_FILE,
  };

  it('names the reply and the file inserted, as ids', () => {
    expect(savedReplyFileReplySchema.safeParse(base).success).toBe(true);
    for (const missing of ['savedReplyId', 'savedReplyFileId'] as const) {
      const { [missing]: _gone, ...rest } = base;
      expect(savedReplyFileReplySchema.safeParse(rest).success, missing).toBe(false);
      expect(savedReplyFileReplySchema.safeParse({ ...base, [missing]: 'x' }).success).toBe(false);
    }
  });

  it('needs inbox.reply and refuses, before any upload, a file the reply no longer carries', async () => {
    const uploads: unknown[] = [];
    const graph = {
      uploadMedia: (...args: unknown[]) => {
        uploads.push(args);
        return Promise.resolve({ ok: true, data: { mediaId: 'm' } });
      },
    };
    const service = createFileRepliesService({
      db: untouched,
      graph,
    } as unknown as Parameters<typeof createFileRepliesService>[0]);
    const marketer = ctxOf(['marketer']);
    expect(marketer.permissions.has('inbox.reply')).toBe(false);
    expect((await refusal(service.queueSavedReplyFileReply(marketer, base)))[0]).toBe('forbidden');
    expect(
      (
        await refusal(
          service.queueSavedReplyFileReply(ctxOf(['agent']), { ...base, savedReplyFileId: 'x' }),
        )
      )[0],
    ).toBe('validation_failed');
    expect(uploads).toEqual([]);
  });
});

describe('saved replies’ files in the API, the export and the database (ADR-411)', () => {
  it('gives a file’s details and whether the text is its caption, never its bytes', () => {
    const view = {
      fileId: OLD_FILE,
      kind: 'image' as const,
      mimeType: 'image/png',
      filename: 'a.png',
      sizeBytes: 3,
    };
    expect(toApiSavedReplyAttachment(view)).toEqual({
      id: OLD_FILE,
      type: 'image',
      mimeType: 'image/png',
      filename: 'a.png',
      sizeBytes: 3,
      caption: true,
    });
    expect(
      toApiSavedReplyAttachment({ ...view, kind: 'audio', mimeType: 'audio/ogg' })?.caption,
    ).toBe(false);
    expect(toApiSavedReplyAttachment(null)).toBeNull();
    const shape = apiSavedReplySchema.shape.attachment;
    expect(shape.safeParse(toApiSavedReplyAttachment(view)).success).toBe(true);
    expect(shape.safeParse(null).success).toBe(true);
    expect(
      shape.safeParse({ ...toApiSavedReplyAttachment(view), sizeBytes: REPLY_FILE_MAX_BYTES + 1 })
        .success,
    ).toBe(false);
  });

  it('is described in the API document: the file in each reply, the caption limit on a change, the file deleted with the reply', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { description: string }>>;
    };
    expect(doc.paths['/saved-replies']?.get?.description).toContain(
      'Each reply names the file it carries, if any, in `attachment`.',
    );
    expect(doc.paths['/saved-replies/{id}']?.patch?.description).toContain(
      'the text is its caption and is refused over 1,024 characters (422 naming `body`)',
    );
    expect(doc.paths['/saved-replies/{id}']?.delete?.description).toContain(
      'Its file is deleted with it unless another saved reply carries the same file.',
    );
    expect(apiSavedReplySchema.shape.attachment.description).toContain(
      'the API gives neither its content nor where it is kept, and keys cannot add or remove it',
    );
  });

  it('answers a reply a key added with its file’s details', async () => {
    const tx = recorder([
      [{ n: 0 }],
      [
        {
          id: REPLY,
          shortcut: 'list',
          title: 'List',
          body: 'Prices',
          createdByApiKeyId: MEMBER,
          updatedByMembershipId: null,
          updatedByApiKeyId: MEMBER,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          updatedAt: new Date('2026-10-01T00:00:00Z'),
        },
      ],
      [
        {
          savedReplyId: REPLY,
          fileId: OLD_FILE,
          kind: 'document',
          mimeType: 'application/pdf',
          filename: 'list.pdf',
          sizeBytes: 9,
        },
      ],
    ]);
    const db = {
      run: (_scope: unknown, fn: (tx: Tx) => Promise<unknown>) => fn(tx.tx),
    } as unknown as Database;
    const key = {
      tenant: { id: TENANT, status: 'active' },
      key: { id: MEMBER, scopes: new Set(['saved_replies.manage']) },
      planScopes: null,
      requestId: 'req-1',
    } as unknown as ApiContext;
    const response = await apiCreateSavedReply(
      { db, clock: { now: () => new Date() } },
      key,
      { shortcut: 'list', title: 'List', body: 'Prices' },
      null,
    );
    expect((response.body as { data: { attachment: unknown } }).data.attachment).toEqual({
      id: OLD_FILE,
      type: 'document',
      mimeType: 'application/pdf',
      filename: 'list.pdf',
      sizeBytes: 9,
      caption: true,
    });
  });

  it('exports both tables, the files a few rows at a time with their bytes as base64', () => {
    const files = EXPORT_TABLES.find((t) => t.table === 'app.saved_reply_files');
    expect(files?.columns).toContain('content');
    expect(files?.pageSize).toBe(2);
    expect(EXPORT_TABLES.find((t) => t.table === 'app.saved_reply_attachments')?.columns).toEqual([
      'id',
      'saved_reply_id',
      'file_id',
      'attached_by_membership_id',
      'attached_at',
    ]);
    expect(exportRow({ id: OLD_FILE, content: Buffer.from('hello'), size_bytes: 5 })).toEqual({
      id: OLD_FILE,
      content: 'aGVsbG8=',
      size_bytes: 5,
    });
    expect(exportRow({ content: new Uint8Array([255, 0]) })).toEqual({ content: '/wA=' });
  });

  it('holds in migration 0321 the types members send and the 16 MB limit, and deletes with the company in order', () => {
    const migration = readFileSync(
      fileURLToPath(new URL('../../../db/migrations/0321_saved_reply_files.sql', import.meta.url)),
      'utf8',
    );
    const pairs = [...migration.matchAll(/\('(image|video|audio|document)', '([^']+)'\)/g)].map(
      (m) => [m[2], m[1]],
    );
    expect(Object.fromEntries(pairs)).toEqual(REPLY_FILE_TYPES);
    expect(pairs).toHaveLength(Object.keys(REPLY_FILE_TYPES).length);
    expect(migration).toContain(`size_bytes BETWEEN 1 AND ${REPLY_FILE_MAX_BYTES}`);
    expect(migration).toContain('char_length(filename) BETWEEN 1 AND 150');
    expect(migration).toContain("sha256 = encode(pg_catalog.sha256(content), 'hex')");
    expect(migration).toContain('UNIQUE (tenant_id, saved_reply_id)');
    expect(migration).toContain('REFERENCES app.saved_replies (tenant_id, id) ON DELETE CASCADE');
    expect(migration).toMatch(
      /saved_reply_attachments_file_fk FOREIGN KEY \(tenant_id, file_id\)\s+REFERENCES app\.saved_reply_files \(tenant_id, id\),\n/,
    );
    expect(migration).toContain("(125, ARRAY['app.saved_reply_attachments']::regclass[], 'batch')");
    expect(migration).toContain("(126, ARRAY['app.saved_reply_files']::regclass[], 'batch')");
    expect(migration).not.toMatch(/GRANT UPDATE/);
    expect(migration).toContain(
      'ALTER TABLE app.saved_reply_files ALTER COLUMN content SET STORAGE EXTERNAL;',
    );
  });
});
