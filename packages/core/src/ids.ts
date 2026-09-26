import { createHash, randomBytes } from 'node:crypto';

/**
 * RFC 9562 UUID version 7: 48-bit Unix millisecond timestamp followed by random bits.
 * Time-ordered ids keep B-tree inserts local. Monotonic within a process for ids generated in the
 * same millisecond by incrementing the random tail.
 */
let lastMs = -1;
let lastTail: Buffer = Buffer.alloc(10);

export function uuidv7(now: number = Date.now()): string {
  const bytes = Buffer.alloc(16);
  let tail: Buffer;
  if (now === lastMs) {
    tail = Buffer.from(lastTail);
    // Increment the 74 random bits as a big-endian counter (ignoring the version/variant nibbles
    // which are overwritten below). Overflow is astronomically unlikely within one millisecond.
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      const next = ((tail[i] ?? 0) + 1) & 0xff;
      tail[i] = next;
      if (next !== 0) break;
    }
  } else {
    tail = randomBytes(10);
    lastMs = now;
  }
  lastTail = tail;
  bytes.writeUIntBE(now, 0, 6);
  tail.copy(bytes, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Cryptographically random URL-safe token (default 32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
