import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import type { WebhookOAuthCertificate } from './model';

/**
 * Self-signed X.509 certificates for the key pairs HyFib makes for webhook OAuth clients (ADR-372),
 * for authorization servers that register a client's certificate rather than its bare public key
 * and find it by thumbprint, such as Microsoft Entra ID. Node's crypto reads certificates but does
 * not make them, so the few DER structures one needs (RFC 5280 section 4.1, X.690 DER) are written
 * here; Node's `X509Certificate` checks every certificate made against its key pair before it is
 * kept.
 */

/** The subject, and issuer, of every such certificate: names neither the company nor the client. */
export const WEBHOOK_OAUTH_CERTIFICATE_SUBJECT = 'HyFib W360 webhook OAuth client';
/**
 * How long a certificate is valid from when its key pair is made: a year, as Microsoft's own
 * example of a self-signed certificate for Entra ID is.
 */
export const WEBHOOK_OAUTH_CERTIFICATE_DAYS = 365;
/** How far before its making a certificate is valid, for servers whose clocks run a little behind. */
const BACKDATE_MS = 5 * 60_000;

/** A DER length: short form below 128, else the long form's byte count and bytes. */
function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, body: Buffer) =>
  Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
const sequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
/** A positive INTEGER from its big-endian bytes: leading zeros dropped, one added before a high bit. */
function integer(bytes: Buffer): Buffer {
  let body = bytes;
  while (body.length > 1 && body[0] === 0 && ((body[1] ?? 0) & 0x80) === 0) body = body.subarray(1);
  if ((body[0] ?? 0) & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}
/** An OBJECT IDENTIFIER from its dotted form: the first two arcs in one byte, the rest base 128. */
function objectIdentifier(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const out = [40 * first + second];
  for (const arc of rest) {
    const digits = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) {
      digits.unshift((value & 0x7f) | 0x80);
    }
    out.push(...digits);
  }
  return tlv(0x06, Buffer.from(out));
}
const explicit = (tagNumber: number, body: Buffer) => tlv(0xa0 + tagNumber, body);
/** A time as RFC 5280 section 4.1.2.5 asks: UTCTime through 2049, GeneralizedTime from 2050. */
function time(at: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0');
  const rest = `${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
  const year = at.getUTCFullYear();
  return year < 2050
    ? tlv(0x17, Buffer.from(`${String(year).slice(2)}${rest}`, 'ascii'))
    : tlv(0x18, Buffer.from(`${year}${rest}`, 'ascii'));
}
/** A Name of one common name, as a UTF8String. */
const commonName = (value: string) =>
  sequence(set(sequence(objectIdentifier('2.5.4.3'), tlv(0x0c, Buffer.from(value, 'utf8')))));

/**
 * A new self-signed X.509 v3 certificate for a key pair HyFib made, as PEM: a random serial of up
 * to 128 bits, valid from five minutes before `at` for a year, its subject and issuer
 * `WEBHOOK_OAUTH_CERTIFICATE_SUBJECT`, marked as no CA and for digital signatures only (both
 * critical), signed with the pair's private key: SHA-256 with RSA (PKCS #1 v1.5) for an RSA key,
 * whichever algorithm its assertions are signed with, or ECDSA with SHA-256 for an EC key. Throws
 * when the certificate made does not check against the pair, so none is kept that the pair cannot
 * stand behind.
 */
export function selfSignedWebhookOAuthCertificate(
  privateKeyPem: string,
  publicKeyPem: string,
  at: Date,
): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(publicKeyPem);
  const algorithm =
    privateKey.asymmetricKeyType === 'ec'
      ? sequence(objectIdentifier('1.2.840.10045.4.3.2'))
      : sequence(objectIdentifier('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  // Positive and never zero, so that no leading byte is dropped from the 16 random bytes.
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;
  const extensions = explicit(
    3,
    sequence(
      // basicConstraints (2.5.29.19), critical: no CA.
      sequence(
        objectIdentifier('2.5.29.19'),
        tlv(0x01, Buffer.from([0xff])),
        tlv(0x04, sequence()),
      ),
      // keyUsage (2.5.29.15), critical: digitalSignature only.
      sequence(
        objectIdentifier('2.5.29.15'),
        tlv(0x01, Buffer.from([0xff])),
        tlv(0x04, tlv(0x03, Buffer.from([0x07, 0x80]))),
      ),
    ),
  );
  const name = commonName(WEBHOOK_OAUTH_CERTIFICATE_SUBJECT);
  const notBefore = new Date(at.getTime() - BACKDATE_MS);
  const notAfter = new Date(at.getTime() + WEBHOOK_OAUTH_CERTIFICATE_DAYS * 86_400_000);
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
  const made = new X509Certificate(pem);
  if (!made.verify(publicKey) || !made.checkPrivateKey(privateKey)) {
    throw new Error('A webhook OAuth client certificate does not check against its key pair');
  }
  return pem;
}

/**
 * Reads the certificate HyFib made for a key pair (ADR-372), checked to hold the pair's public key,
 * so that no JWK or assertion names a certificate of another key: as shown (its PEM, its
 * thumbprints and when it is valid), and its DER as base64 for a JWK's `x5c` (RFC 7517 section
 * 4.7). The thumbprints are SHA-1 (`x5t`) and SHA-256 (`x5t#S256`) of its DER, base64url, as JWS
 * headers and JWKs name them (RFC 7515 sections 4.1.7 and 4.1.8, RFC 7517 sections 4.8 and 4.9).
 * Throws for anything else than a certificate of that key.
 */
export function readWebhookOAuthCertificate(
  pem: string,
  publicKey: KeyObject,
): { certificate: WebhookOAuthCertificate; x5c: string } {
  const read = new X509Certificate(pem);
  if (!read.publicKey.equals(publicKey)) {
    throw new Error('A webhook OAuth client certificate does not hold its public key');
  }
  return {
    certificate: {
      pem,
      x5t: createHash('sha1').update(read.raw).digest('base64url'),
      x5tS256: createHash('sha256').update(read.raw).digest('base64url'),
      validFrom: read.validFromDate.toISOString(),
      validTo: read.validToDate.toISOString(),
    },
    x5c: read.raw.toString('base64'),
  };
}
