import { describe, expect, it } from 'vitest';
import { AppError, isAppError } from '@w360/core';
import type { Tx } from '@w360/db';
import { CRM_LIMITS } from './common';
import {
  writeArchivePipeline,
  writeCreatePipeline,
  writeRestorePipeline,
  writeUpdatePipeline,
} from './pipelines';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const PIPELINE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const DUE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const QUOTED = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
const SIGNED = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f05';
const WRITER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f06';
const MEMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f07';
const NOW = new Date('2026-10-07T10:00:00.000Z');

/**
 * A transaction that answers its reads, in order, with `reads`, and records what is inserted and
 * updated. A read beyond them fails the test.
 */
function recorder(reads: unknown[][]) {
  const queue = [...reads];
  const inserts: unknown[] = [];
  const updates: Record<string, unknown>[] = [];
  const answer = () => {
    const rows = queue.shift();
    if (!rows) throw new Error('an unexpected read');
    return Object.assign(Promise.resolve(rows), { for: () => Promise.resolve(rows) });
  };
  const tx = {
    execute: () => Promise.resolve({ rows: [] }),
    select: () => ({ from: () => ({ where: answer }) }),
    insert: () => ({
      values: (values: unknown) => {
        inserts.push(values);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as Tx;
  return { tx, inserts, updates, unread: () => queue.length };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, error.publicMessage];
  }
  throw new Error('expected a refusal');
}

const pipeline = (overrides: Record<string, unknown> = {}) => ({
  id: PIPELINE,
  name: 'Renewals',
  version: 4,
  archivedAt: null,
  ...overrides,
});
const stages = [
  { id: DUE, name: 'Due', position: 0, archivedAt: null, winPercent: null },
  { id: QUOTED, name: 'Quoted', position: 1, archivedAt: null, winPercent: 60 },
  { id: SIGNED, name: 'Signed', position: 2, archivedAt: NOW, winPercent: null },
];
const unchanged = [
  { id: DUE, name: 'Due' },
  { id: QUOTED, name: 'Quoted', winPercent: 60 },
];

describe('adding a pipeline (ADR-286, shared by Settings and keys)', () => {
  const data = {
    name: 'Renewals',
    currency: 'INR',
    stages: [
      { name: 'Due', winPercent: null },
      { name: 'Quoted', winPercent: 60 },
    ],
  };

  it('places it last, names its creator, and writes its stages in order', async () => {
    for (const [by, creator] of [
      [{ apiKeyId: WRITER }, { createdByMembershipId: null, createdByApiKeyId: WRITER }],
      [{ membershipId: MEMBER }, { createdByMembershipId: MEMBER, createdByApiKeyId: null }],
    ] as const) {
      const r = recorder([[{ n: 3 }]]);
      const id = await writeCreatePipeline(r.tx, TENANT, data, by);
      expect(r.inserts).toEqual([
        { id, tenantId: TENANT, name: 'Renewals', currency: 'INR', position: 3, ...creator },
        [
          {
            id: expect.any(String),
            tenantId: TENANT,
            pipelineId: id,
            name: 'Due',
            winPercent: null,
            position: 0,
          },
          {
            id: expect.any(String),
            tenantId: TENANT,
            pipelineId: id,
            name: 'Quoted',
            winPercent: 60,
            position: 1,
          },
        ],
      ]);
    }
  });

  it('refuses the company’s limit and two stages of one name, writing nothing', async () => {
    const full = recorder([[{ n: CRM_LIMITS.pipelines }]]);
    expect(await refusal(writeCreatePipeline(full.tx, TENANT, data, { apiKeyId: WRITER }))).toEqual(
      [
        'conflict',
        `A company can use at most ${CRM_LIMITS.pipelines} pipelines. Archive one first.`,
      ],
    );
    const twice = recorder([]);
    const repeated = {
      ...data,
      stages: [
        { name: 'Due', winPercent: null },
        { name: 'due', winPercent: 10 },
      ],
    };
    expect(
      await refusal(writeCreatePipeline(twice.tx, TENANT, repeated, { apiKeyId: WRITER })),
    ).toEqual(['validation_failed', 'Two stages are named “due”.']);
    expect([full.inserts, twice.inserts]).toEqual([[], []]);
  });
});

describe('changing a pipeline (ADR-286, shared by Settings and keys)', () => {
  it('keeps an unchanged pipeline as it is when asked, writing nothing', async () => {
    for (const change of [
      { id: PIPELINE, name: 'Renewals', stages: unchanged },
      { id: PIPELINE, name: 'Renewals' },
      {
        id: PIPELINE,
        stages: [
          { id: DUE, name: 'Due' },
          { id: QUOTED, name: 'Quoted' },
        ],
      },
    ]) {
      const r = recorder([[pipeline()], stages]);
      expect(await writeUpdatePipeline(r.tx, TENANT, change, NOW, { keepUnchanged: true })).toEqual(
        {
          version: 4,
          changed: false,
          stages: 2,
          added: 0,
          removed: 0,
        },
      );
      expect([r.inserts, r.updates, r.unread()]).toEqual([[], [], 0]);
    }
    // Settings always moves the version on.
    const settings = recorder([[pipeline()], stages]);
    expect(
      (
        await writeUpdatePipeline(
          settings.tx,
          TENANT,
          { id: PIPELINE, name: 'Renewals', stages: unchanged },
          NOW,
        )
      ).version,
    ).toBe(5);
  });

  it('writes a rename, a reorder, a rename of a stage or another chance', async () => {
    for (const change of [
      { name: 'Renewals 2026' },
      { stages: [unchanged[1]!, unchanged[0]!] },
      { stages: [{ id: DUE, name: 'Due now' }, unchanged[1]!] },
      { stages: [unchanged[0]!, { id: QUOTED, name: 'Quoted', winPercent: 70 }] },
      { stages: [unchanged[0]!, { id: QUOTED, name: 'Quoted', winPercent: null }] },
    ]) {
      const r = recorder([[pipeline()], stages]);
      const result = await writeUpdatePipeline(r.tx, TENANT, { id: PIPELINE, ...change }, NOW, {
        keepUnchanged: true,
      });
      expect([result.version, result.changed], JSON.stringify(change)).toEqual([5, true]);
      expect(r.updates.at(-1), JSON.stringify(change)).toEqual({
        name: change.name ?? 'Renewals',
        version: 5,
      });
    }
  });

  it('takes fewer stages, or two stages trading names, as a change', async () => {
    const fewer = recorder([[pipeline()], stages, [{ n: 0 }]]);
    expect(
      await writeUpdatePipeline(fewer.tx, TENANT, { id: PIPELINE, stages: [unchanged[0]!] }, NOW, {
        keepUnchanged: true,
      }),
    ).toEqual({ version: 5, changed: true, stages: 1, added: 0, removed: 1 });
    const traded = recorder([[pipeline()], stages]);
    const change = {
      id: PIPELINE,
      stages: [
        { id: QUOTED, name: 'Due' },
        { id: DUE, name: 'Quoted', winPercent: 60 },
      ],
    };
    expect(
      (await writeUpdatePipeline(traded.tx, TENANT, change, NOW, { keepUnchanged: true })).changed,
    ).toBe(true);
  });

  it('adds, keeps and removes stages in order, archiving those left out without open deals', async () => {
    const r = recorder([[pipeline()], stages, [{ n: 0 }]]);
    const result = await writeUpdatePipeline(
      r.tx,
      TENANT,
      {
        id: PIPELINE,
        name: 'Renewals',
        stages: [
          { id: QUOTED, name: 'Quote sent' },
          { id: null, name: 'Negotiating', winPercent: 85 },
        ],
      },
      NOW,
      { keepUnchanged: true },
    );
    expect(result).toEqual({ version: 5, changed: true, stages: 2, added: 1, removed: 1 });
    expect(r.updates).toEqual([
      { archivedAt: NOW },
      { name: 'Quote sent', position: 0 },
      { name: 'Renewals', version: 5 },
    ]);
    expect(r.inserts).toEqual([
      {
        id: expect.any(String),
        tenantId: TENANT,
        pipelineId: PIPELINE,
        name: 'Negotiating',
        winPercent: 85,
        position: 1,
      },
    ]);
    expect(r.unread()).toBe(0);
  });

  it('refuses a stage holding open deals, another pipeline’s or an archived stage, and repeats', async () => {
    const busy = recorder([[pipeline()], stages, [{ n: 2 }]]);
    expect(
      await refusal(
        writeUpdatePipeline(busy.tx, TENANT, { id: PIPELINE, stages: [unchanged[1]!] }, NOW),
      ),
    ).toEqual(['conflict', 'Move the 2 open deals out of “Due” before removing it.']);
    expect(busy.updates).toEqual([]);
    for (const id of [SIGNED, WRITER]) {
      const r = recorder([[pipeline()], stages]);
      expect(
        await refusal(
          writeUpdatePipeline(
            r.tx,
            TENANT,
            { id: PIPELINE, stages: [{ id, name: 'Signed' }] },
            NOW,
          ),
        ),
      ).toEqual(['validation_failed', 'The stage “Signed” is not in this pipeline.']);
    }
    const twice = recorder([]);
    expect(
      await refusal(
        writeUpdatePipeline(
          twice.tx,
          TENANT,
          {
            id: PIPELINE,
            stages: [
              { id: DUE, name: 'Due' },
              { id: DUE, name: 'Again' },
            ],
          },
          NOW,
        ),
      ),
    ).toEqual(['validation_failed', 'A stage is listed twice.']);
  });

  it('refuses an archived pipeline, an unknown one, and another version, in the caller’s words', async () => {
    const archived = recorder([[pipeline({ archivedAt: NOW })]]);
    expect(
      await refusal(writeUpdatePipeline(archived.tx, TENANT, { id: PIPELINE, name: 'X' }, NOW)),
    ).toEqual(['conflict', 'Restore the pipeline first.']);
    const gone = recorder([[]]);
    expect(
      (await refusal(writeUpdatePipeline(gone.tx, TENANT, { id: PIPELINE, name: 'X' }, NOW)))[0],
    ).toBe('not_found');
    const stale = recorder([[pipeline()]]);
    expect(
      await refusal(
        writeUpdatePipeline(
          stale.tx,
          TENANT,
          { id: PIPELINE, name: 'X', expected: { version: 3 } },
          NOW,
        ),
      ),
    ).toEqual(['conflict', 'Someone else changed this in the meantime. Reload and try again.']);
    const worded = recorder([[pipeline()]]);
    expect(
      await refusal(
        writeUpdatePipeline(
          worded.tx,
          TENANT,
          {
            id: PIPELINE,
            name: 'X',
            expected: {
              version: 3,
              stale: (current) => new AppError('conflict', `now ${current}`),
            },
          },
          NOW,
        ),
      ),
    ).toEqual(['conflict', 'now 4']);
    const current = recorder([[pipeline()], stages]);
    expect(
      (
        await writeUpdatePipeline(
          current.tx,
          TENANT,
          { id: PIPELINE, name: 'X', expected: { version: 4 } },
          NOW,
        )
      ).version,
    ).toBe(5);
  });
});

describe('archiving and restoring a pipeline (ADR-286, shared by Settings and keys)', () => {
  it('archives one without open deals, once', async () => {
    const r = recorder([[pipeline()], [{ n: 0 }]]);
    expect(await writeArchivePipeline(r.tx, TENANT, PIPELINE, undefined, NOW)).toEqual({
      version: 5,
      changed: true,
    });
    expect(r.updates).toEqual([{ archivedAt: NOW, version: 5 }]);
    const again = recorder([[pipeline({ archivedAt: NOW })]]);
    expect(await writeArchivePipeline(again.tx, TENANT, PIPELINE, undefined, NOW)).toEqual({
      version: 4,
      changed: false,
    });
    const busy = recorder([[pipeline()], [{ n: 1 }]]);
    expect(await refusal(writeArchivePipeline(busy.tx, TENANT, PIPELINE, undefined, NOW))).toEqual([
      'conflict',
      'Close or move the 1 open deal in this pipeline first.',
    ]);
    expect([again.updates, busy.updates]).toEqual([[], []]);
  });

  it('restores an archived one within the company’s limit, once', async () => {
    const r = recorder([[{ n: 3 }], [pipeline({ archivedAt: NOW })]]);
    expect(await writeRestorePipeline(r.tx, TENANT, PIPELINE, { version: 4 })).toEqual({
      version: 5,
      changed: true,
    });
    expect(r.updates).toEqual([{ archivedAt: null, version: 5 }]);
    const active = recorder([[{ n: 3 }], [pipeline()]]);
    expect(await writeRestorePipeline(active.tx, TENANT, PIPELINE, undefined)).toEqual({
      version: 4,
      changed: false,
    });
    const full = recorder([[{ n: CRM_LIMITS.pipelines }], [pipeline({ archivedAt: NOW })]]);
    expect((await refusal(writeRestorePipeline(full.tx, TENANT, PIPELINE, undefined)))[0]).toBe(
      'conflict',
    );
    expect([active.updates, full.updates]).toEqual([[], []]);
  });
});
