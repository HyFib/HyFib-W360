import { createHash } from 'node:crypto';
import { createGzip, type Gzip } from 'node:zlib';

/** The compressed bytes of one stored part (the last part of a file may be shorter). */
export const STORED_EXPORT_PART_BYTES = 1024 * 1024;
/**
 * The largest stored export, compressed (and what a company holds at most, as it keeps one ready
 * file): a larger company downloads the streamed export (ADR-415).
 */
export const STORED_EXPORT_MAX_BYTES = 512 * 1024 * 1024;
/** Text gathered before it is handed to the compressor, so a line is not a write of its own. */
const TEXT_BATCH_CHARS = 64 * 1024;

/** The compressed file grew past `STORED_EXPORT_MAX_BYTES`. */
export class StoredExportTooLargeError extends Error {
  constructor() {
    super('The stored export is larger than the limit');
    this.name = 'StoredExportTooLargeError';
  }
}

export interface CompressedFile {
  byteSize: number;
  /** SHA-256 of the whole compressed file, hex. */
  sha256: string;
  partCount: number;
}

/**
 * Compresses the export's lines into one gzip file and hands it on in parts of
 * `STORED_EXPORT_PART_BYTES` (ADR-415). Parts are cut from the compressed bytes, so joined in
 * order they are the file; the SHA-256 and size are of the whole file. The writer drives it: each
 * part is handed on (and awaited) before more text is compressed, so at most about two parts are
 * held in memory, and a file past `maxBytes` stops with `StoredExportTooLargeError` before that
 * part is handed on.
 */
export class CompressedParts {
  private readonly gzip: Gzip;
  private readonly hash = createHash('sha256');
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private text = '';
  private byteSize = 0;
  private partCount = 0;
  private failure: Error | null = null;
  private finished = false;

  constructor(
    private readonly handPart: (seq: number, bytes: Buffer) => Promise<void>,
    private readonly options: { partBytes?: number; maxBytes?: number } = {},
  ) {
    this.gzip = createGzip();
    this.gzip.on('data', (chunk: Buffer) => {
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
    });
    // Kept to be raised by the next write or by `finish`, never lost.
    this.gzip.on('error', (error: Error) => {
      this.failure ??= error;
    });
  }

  private get partBytes() {
    return this.options.partBytes ?? STORED_EXPORT_PART_BYTES;
  }

  private get maxBytes() {
    return this.options.maxBytes ?? STORED_EXPORT_MAX_BYTES;
  }

  /** Adds text (lines, each ending in a newline) to the file. */
  async write(text: string): Promise<void> {
    if (this.finished) throw new Error('The compressed file is already finished');
    this.text += text;
    if (this.text.length >= TEXT_BATCH_CHARS) await this.compressText();
  }

  /** Compresses what is left, hands on the last parts and gives the file's size and hash. */
  async finish(): Promise<CompressedFile> {
    if (this.finished) throw new Error('The compressed file is already finished');
    await this.compressText();
    this.finished = true;
    await new Promise<void>((resolve, reject) => {
      this.gzip.once('end', resolve);
      this.gzip.once('error', reject);
      this.gzip.end();
    });
    this.raiseFailure();
    await this.handParts(true);
    return { byteSize: this.byteSize, sha256: this.hash.digest('hex'), partCount: this.partCount };
  }

  /** Stops compressing after a failure elsewhere (the file is abandoned). */
  destroy(): void {
    this.finished = true;
    this.gzip.destroy();
  }

  private raiseFailure() {
    if (this.failure) throw this.failure;
  }

  private async compressText() {
    if (this.text.length === 0) return;
    const bytes = Buffer.from(this.text, 'utf8');
    this.text = '';
    await new Promise<void>((resolve, reject) => {
      this.gzip.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
    this.raiseFailure();
    await this.handParts(false);
  }

  private async handParts(final: boolean) {
    while (this.pendingBytes >= this.partBytes || (final && this.pendingBytes > 0)) {
      const all = Buffer.concat(this.pending, this.pendingBytes);
      const size = Math.min(this.partBytes, all.length);
      const part = all.subarray(0, size);
      const rest = all.subarray(size);
      this.pending = rest.length > 0 ? [rest] : [];
      this.pendingBytes = rest.length;
      if (this.byteSize + part.length > this.maxBytes) throw new StoredExportTooLargeError();
      this.byteSize += part.length;
      this.hash.update(part);
      await this.handPart(this.partCount, part);
      this.partCount += 1;
    }
  }
}
