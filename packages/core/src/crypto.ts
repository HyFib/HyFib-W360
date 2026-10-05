import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Envelope-free symmetric encryption for secrets at rest (provider tokens, OAuth secrets, queued
 * email payloads). Keys are supplied by the deployment's secret manager through configuration and
 * are never stored in the database. Every ciphertext records the key id used, which allows key
 * rotation: new writes use the primary key, old ciphertexts stay readable until re-encrypted.
 *
 * Associated data (AAD) binds a ciphertext to its owner (for example `tenant:<id>|credential:<id>`)
 * so that a ciphertext copied into another tenant's row fails authentication instead of decrypting.
 */
const VERSION = 'v1';
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface KeyringConfig {
  primaryKeyId: string;
  /** Map of key id -> 32-byte key. */
  keys: Record<string, Buffer>;
}

export class Keyring {
  private readonly primaryKeyId: string;
  private readonly keys: Map<string, Buffer>;

  constructor(config: KeyringConfig) {
    this.keys = new Map();
    for (const [kid, key] of Object.entries(config.keys)) {
      if (!KEY_ID_RE.test(kid)) throw new Error(`Invalid encryption key id "${kid}"`);
      if (key.length !== 32) throw new Error(`Encryption key "${kid}" must be 32 bytes`);
      this.keys.set(kid, key);
    }
    if (!this.keys.has(config.primaryKeyId)) {
      throw new Error(`Primary encryption key "${config.primaryKeyId}" is not configured`);
    }
    this.primaryKeyId = config.primaryKeyId;
  }

  /**
   * Parses `kid1:base64key,kid2:base64key` (the format used in environment configuration).
   */
  static fromEnv(spec: string, primaryKeyId: string): Keyring {
    const keys: Record<string, Buffer> = {};
    for (const part of spec
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)) {
      const idx = part.indexOf(':');
      if (idx <= 0) throw new Error('Malformed encryption key entry; expected "kid:base64"');
      const kid = part.slice(0, idx);
      keys[kid] = Buffer.from(part.slice(idx + 1), 'base64');
    }
    return new Keyring({ primaryKeyId, keys });
  }

  get currentKeyId(): string {
    return this.primaryKeyId;
  }

  /** Every configured key id, the primary first (key ids only, never the keys). */
  get keyIds(): string[] {
    return [this.primaryKeyId, ...[...this.keys.keys()].filter((kid) => kid !== this.primaryKeyId)];
  }

  encrypt(plaintext: string | Buffer, aad: string): string {
    const key = this.keys.get(this.primaryKeyId);
    if (!key) throw new Error('Primary encryption key unavailable');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([
      cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      this.primaryKeyId,
      iv.toString('base64url'),
      body.toString('base64url'),
      tag.toString('base64url'),
    ].join(':');
  }

  decrypt(ciphertext: string, aad: string): Buffer {
    const parts = ciphertext.split(':');
    if (parts.length !== 5 || parts[0] !== VERSION)
      throw new Error('Unsupported ciphertext format');
    const [, kid, ivB64, bodyB64, tagB64] = parts as [string, string, string, string, string];
    const key = this.keys.get(kid);
    if (!key) throw new Error(`Encryption key "${kid}" is not available`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64url')), decipher.final()]);
  }

  decryptString(ciphertext: string, aad: string): string {
    return this.decrypt(ciphertext, aad).toString('utf8');
  }

  /** Key id embedded in a ciphertext, used by re-encryption jobs to find rows needing rotation. */
  static keyIdOf(ciphertext: string): string | null {
    const parts = ciphertext.split(':');
    return parts.length === 5 && parts[0] === VERSION ? (parts[1] ?? null) : null;
  }

  needsRotation(ciphertext: string): boolean {
    return Keyring.keyIdOf(ciphertext) !== this.primaryKeyId;
  }
}

export function hmacSha256(secret: string | Buffer, payload: string | Buffer): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function hmacSha256Hex(secret: string | Buffer, payload: string | Buffer): string {
  return hmacSha256(secret, payload).toString('hex');
}

/** Constant-time comparison of two strings; returns false for different lengths without throwing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still perform a comparison to keep timing independent of where the mismatch is.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
