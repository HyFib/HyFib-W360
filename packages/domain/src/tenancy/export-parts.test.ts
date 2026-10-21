import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CompressedParts,
  STORED_EXPORT_MAX_BYTES,
  STORED_EXPORT_PART_BYTES,
  StoredExportTooLargeError,
} from './export-parts';

/** Lines that compress poorly (random hex), so a small part size gives several parts. */
const lines = (count: number) =>
  Array.from(
    { length: count },
    (_, i) =>
      `${JSON.stringify({ table: 'app.contacts', row: { n: i, v: randomBytes(48).toString('hex') } })}\n`,
  );

async function compress(text: string[], options: { partBytes?: number; maxBytes?: number }) {
  const parts: { seq: number; bytes: Buffer }[] = [];
  const file = new CompressedParts(async (seq, bytes) => {
    parts.push({ seq, bytes: Buffer.from(bytes) });
  }, options);
  for (const line of text) await file.write(line);
  const done = await file.finish();
  return { parts, done };
}

describe('compressed export parts (ADR-415)', () => {
  it('stores 1 MiB parts and at most 512 MiB, compressed', () => {
    expect(STORED_EXPORT_PART_BYTES).toBe(1_048_576);
    expect(STORED_EXPORT_MAX_BYTES).toBe(536_870_912);
    // The database's checks hold the same bounds: 512 parts of 1 MiB.
    expect(STORED_EXPORT_MAX_BYTES / STORED_EXPORT_PART_BYTES).toBe(512);
  });

  it('cuts the gzip file into numbered parts that join into it, with its size and SHA-256', async () => {
    const text = lines(3_000);
    const { parts, done } = await compress(text, { partBytes: 16_384 });
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.map((p) => p.seq)).toEqual(parts.map((_, i) => i));
    // Every part but the last is exactly the part size; none is empty.
    for (const part of parts.slice(0, -1)) expect(part.bytes.length).toBe(16_384);
    expect(parts.at(-1)!.bytes.length).toBeGreaterThan(0);
    expect(parts.at(-1)!.bytes.length).toBeLessThanOrEqual(16_384);
    const file = Buffer.concat(parts.map((p) => p.bytes));
    expect(done).toEqual({
      byteSize: file.length,
      sha256: createHash('sha256').update(file).digest('hex'),
      partCount: parts.length,
    });
    expect(gunzipSync(file).toString('utf8')).toBe(text.join(''));
  });

  it('gives one part for a small export, and keeps text that never fills a batch', async () => {
    const { parts, done } = await compress(['{"end":true}\n'], {});
    expect(parts).toHaveLength(1);
    expect(done.partCount).toBe(1);
    expect(gunzipSync(parts[0]!.bytes).toString('utf8')).toBe('{"end":true}\n');
  });

  it('stops before handing on the part that would pass the largest size', async () => {
    const handed: number[] = [];
    const file = new CompressedParts(
      async (seq, bytes) => {
        handed.push(bytes.length);
      },
      { partBytes: 4_096, maxBytes: 10_000 },
    );
    const run = async () => {
      for (const line of lines(2_000)) await file.write(line);
      await file.finish();
    };
    await expect(run()).rejects.toBeInstanceOf(StoredExportTooLargeError);
    // Two whole parts fit (8,192 bytes); the third would pass 10,000 and is never handed on.
    expect(handed).toEqual([4_096, 4_096]);
  });

  it('keeps a file of exactly the largest size and refuses one byte less of room', async () => {
    const fixed = 'x'.repeat(200_000);
    const sized = await compress([fixed], { partBytes: 2_048 });
    const atLimit = new CompressedParts(async () => undefined, {
      partBytes: 2_048,
      maxBytes: sized.done.byteSize,
    });
    await atLimit.write(fixed);
    await expect(atLimit.finish()).resolves.toMatchObject({ byteSize: sized.done.byteSize });
    const overLimit = new CompressedParts(async () => undefined, {
      partBytes: 2_048,
      maxBytes: sized.done.byteSize - 1,
    });
    await overLimit.write(fixed);
    await expect(overLimit.finish()).rejects.toBeInstanceOf(StoredExportTooLargeError);
  });

  it('passes on a failure to store a part, and refuses writes once finished', async () => {
    const failing = new CompressedParts(
      async () => {
        throw new Error('database down');
      },
      { partBytes: 1_024 },
    );
    const run = async () => {
      for (const line of lines(500)) await failing.write(line);
      await failing.finish();
    };
    await expect(run()).rejects.toThrow('database down');

    const file = new CompressedParts(async () => undefined);
    await file.write('{"end":true}\n');
    await file.finish();
    await expect(file.write('more\n')).rejects.toThrow(/already finished/);
    await expect(file.finish()).rejects.toThrow(/already finished/);
  });
});
