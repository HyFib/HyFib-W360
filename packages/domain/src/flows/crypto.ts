import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  type KeyObject,
} from 'node:crypto';

/**
 * Encryption for the WhatsApp Flows data endpoint (research M-100, M-167, Meta's endpoint sample):
 * WhatsApp encrypts a fresh AES-128 key with the business public key (RSA-OAEP, SHA-256) and the
 * request with AES-128-GCM (the 16-byte tag appended); the answer is encrypted with the same key and
 * the bitwise-inverted IV, tag appended, and sent as base64 text.
 */

export interface EncryptedFlowRequest {
  encrypted_aes_key: string;
  encrypted_flow_data: string;
  initial_vector: string;
}

export interface DecryptedFlowRequest {
  body: unknown;
  aesKey: Buffer;
  iv: Buffer;
}

/** Thrown when no key can decrypt the request: the endpoint answers 421 (WhatsApp refreshes the key). */
export class FlowDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowDecryptError';
  }
}

const TAG_LENGTH = 16;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function fromBase64(value: unknown, what: string): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_400_000 ||
    !B64_RE.test(value)
  ) {
    throw new FlowDecryptError(`${what} is not base64`);
  }
  return Buffer.from(value, 'base64');
}

/** Whether a parsed JSON body has the three encrypted fields. */
export function isEncryptedFlowRequest(value: unknown): value is EncryptedFlowRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.encrypted_aes_key === 'string' &&
    typeof v.encrypted_flow_data === 'string' &&
    typeof v.initial_vector === 'string'
  );
}

/**
 * Decrypts a request with the first private key that opens its AES key (the current key, then the
 * previous one during a rotation). Throws FlowDecryptError when none does or the data is not valid.
 */
export function decryptFlowRequest(
  request: EncryptedFlowRequest,
  privateKeys: KeyObject[],
): DecryptedFlowRequest {
  const wrappedKey = fromBase64(request.encrypted_aes_key, 'encrypted_aes_key');
  const data = fromBase64(request.encrypted_flow_data, 'encrypted_flow_data');
  const iv = fromBase64(request.initial_vector, 'initial_vector');
  if (data.length <= TAG_LENGTH || iv.length !== 16) throw new FlowDecryptError('bad lengths');
  let aesKey: Buffer | null = null;
  for (const key of privateKeys) {
    try {
      aesKey = privateDecrypt(
        { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        wrappedKey,
      );
      break;
    } catch {
      // Not this key: try the next one; the caller answers 421 when none works.
    }
  }
  if (!aesKey || aesKey.length !== 16) throw new FlowDecryptError('no key opens the request');
  try {
    const decipher = createDecipheriv('aes-128-gcm', aesKey, iv);
    decipher.setAuthTag(data.subarray(data.length - TAG_LENGTH));
    const plain = Buffer.concat([
      decipher.update(data.subarray(0, data.length - TAG_LENGTH)),
      decipher.final(),
    ]);
    return { body: JSON.parse(plain.toString('utf8')), aesKey, iv };
  } catch {
    throw new FlowDecryptError('the request data could not be decrypted');
  }
}

/** Encrypts an answer for WhatsApp with the request's AES key and the inverted IV. */
export function encryptFlowResponse(response: unknown, aesKey: Buffer, iv: Buffer): string {
  const flipped = Buffer.from(iv.map((byte) => ~byte & 0xff));
  const cipher = createCipheriv('aes-128-gcm', aesKey, flipped);
  return Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}

export interface FlowKeyPair {
  publicKeyPem: string;
  /** PKCS#8 PEM; stored only encrypted with the keyring. */
  privateKeyPem: string;
  fingerprint: string;
}

/** SHA-256 of the public key's DER encoding (shown to members to compare keys). */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/** A new RSA-2048 key pair, as in Meta's key generator sample (research M-104). */
export function generateFlowKeyPair(): FlowKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    fingerprint: publicKeyFingerprint(publicKey),
  };
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}
