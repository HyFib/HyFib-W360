import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateWebhookOAuthKeyPair } from './oauth';
import {
  readWebhookOAuthCertificate,
  selfSignedWebhookOAuthCertificate,
  WEBHOOK_OAUTH_CERTIFICATE_DAYS,
  WEBHOOK_OAUTH_CERTIFICATE_SUBJECT,
} from './x509';

const at = new Date('2026-10-11T04:00:00Z');
const hex = (value: string) => Buffer.from(value, 'hex');

describe('certificates for webhook OAuth key pairs (ADR-372)', () => {
  it('make a self-signed X.509 v3 certificate that checks against its RSA or EC key pair', () => {
    for (const algorithm of ['RS256', 'PS256', 'ES256'] as const) {
      const pair = generateWebhookOAuthKeyPair(algorithm);
      const pem = selfSignedWebhookOAuthCertificate(pair.privateKey, pair.publicKey, at);
      // PEM as RFC 7468 has it: one certificate, 64 characters a line.
      expect(pem).toMatch(
        /^-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/]{64}\n)*[A-Za-z0-9+/]{1,63}={0,2}\n-----END CERTIFICATE-----\n$/,
      );
      const read = new X509Certificate(pem);
      // Signed with the pair's own private key, and holding its public key.
      expect(read.verify(createPublicKey(pair.publicKey))).toBe(true);
      expect(read.checkPrivateKey(createPrivateKey(pair.privateKey))).toBe(true);
      expect(read.publicKey.equals(createPublicKey(pair.publicKey))).toBe(true);
      expect(read.subject).toBe(`CN=${WEBHOOK_OAUTH_CERTIFICATE_SUBJECT}`);
      expect(read.issuer).toBe(read.subject);
      expect(read.ca).toBe(false);
      // Valid from five minutes before the pair was made, for a year.
      expect(WEBHOOK_OAUTH_CERTIFICATE_DAYS).toBe(365);
      expect(read.validFromDate.toISOString()).toBe('2026-10-11T03:55:00.000Z');
      expect(read.validToDate.toISOString()).toBe('2027-10-11T04:00:00.000Z');
      // A positive serial of 16 bytes, never with a leading zero dropped.
      expect(read.serialNumber).toMatch(/^[0-7][0-9A-F]{31}$/);
      // The DER itself: version 3, the signature algorithm the key takes, and the two extensions,
      // both critical: no CA, and digital signatures only.
      expect(read.raw.includes(hex('a003020102'))).toBe(true);
      const signatureAlgorithm =
        algorithm === 'ES256'
          ? '300a06082a8648ce3d040302' // ecdsa-with-SHA256
          : '300d06092a864886f70d01010b0500'; // sha256WithRSAEncryption, NULL parameters
      // Named twice: inside what is signed, and beside the signature.
      expect(read.raw.toString('hex').split(signatureAlgorithm)).toHaveLength(3);
      expect(read.raw.includes(hex('300c0603551d130101ff04023000'))).toBe(true);
      expect(read.raw.includes(hex('300e0603551d0f0101ff040403020780'))).toBe(true);
      // The subject's common name is a UTF8String.
      expect(
        read.raw.includes(
          Buffer.concat([
            hex('0603550403'),
            hex(`0c${WEBHOOK_OAUTH_CERTIFICATE_SUBJECT.length.toString(16)}`),
            Buffer.from(WEBHOOK_OAUTH_CERTIFICATE_SUBJECT, 'utf8'),
          ]),
        ),
      ).toBe(true);
    }
  });

  it('give each certificate its own serial, and write dates from 2050 as GeneralizedTime', () => {
    const pair = generateWebhookOAuthKeyPair('ES256');
    const serials = new Set(
      Array.from(
        { length: 20 },
        () =>
          new X509Certificate(
            selfSignedWebhookOAuthCertificate(pair.privateKey, pair.publicKey, at),
          ).serialNumber,
      ),
    );
    expect(serials.size).toBe(20);
    // RFC 5280 section 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
    const late = new X509Certificate(
      selfSignedWebhookOAuthCertificate(
        pair.privateKey,
        pair.publicKey,
        new Date('2049-06-01T12:00:00Z'),
      ),
    );
    expect(late.raw.includes(Buffer.from('\x17\x0d490601115500Z', 'latin1'))).toBe(true);
    expect(late.raw.includes(Buffer.from('\x18\x0f20500601120000Z', 'latin1'))).toBe(true);
    expect(late.validToDate.toISOString()).toBe('2050-06-01T12:00:00.000Z');
  });

  it('refuse to make a certificate a pair cannot stand behind', () => {
    const pair = generateWebhookOAuthKeyPair();
    const other = generateWebhookOAuthKeyPair();
    expect(() => selfSignedWebhookOAuthCertificate(pair.privateKey, other.publicKey, at)).toThrow(
      /does not check against its key pair/,
    );
  });

  it('read a certificate as shown and named: its thumbprints, validity and DER, only for its key', () => {
    const pair = generateWebhookOAuthKeyPair('PS256');
    const pem = selfSignedWebhookOAuthCertificate(pair.privateKey, pair.publicKey, at);
    const raw = new X509Certificate(pem).raw;
    // SHA-1 and SHA-256 of the DER, base64url (RFC 7515 sections 4.1.7 and 4.1.8).
    expect(readWebhookOAuthCertificate(pem, createPublicKey(pair.publicKey))).toEqual({
      certificate: {
        pem,
        x5t: createHash('sha1').update(raw).digest('base64url'),
        x5tS256: createHash('sha256').update(raw).digest('base64url'),
        validFrom: '2026-10-11T03:55:00.000Z',
        validTo: '2027-10-11T04:00:00.000Z',
      },
      x5c: raw.toString('base64'),
    });
    const { certificate, x5c } = readWebhookOAuthCertificate(pem, createPublicKey(pair.publicKey));
    expect(certificate.x5t).toMatch(/^[A-Za-z0-9_-]{27}$/);
    expect(certificate.x5tS256).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The JWK's x5c is the PEM's body, standard base64 without line breaks.
    expect(x5c).toBe(pem.replace(/-----[A-Z ]+-----|\n/g, ''));
    // Another key's certificate, or anything else, is refused.
    expect(() =>
      readWebhookOAuthCertificate(pem, createPublicKey(generateWebhookOAuthKeyPair().publicKey)),
    ).toThrow(/does not hold its public key/);
    expect(() =>
      readWebhookOAuthCertificate(pair.publicKey, createPublicKey(pair.publicKey)),
    ).toThrow();
  });
});
