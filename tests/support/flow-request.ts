import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHmac,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';

/**
 * TEST-ONLY: a WhatsApp Flows data request, encrypted and signed the way WhatsApp does it
 * (research M-100 to M-102, M-167): the body is AES-128-GCM with the tag appended, the AES key is
 * RSA-OAEP (SHA-256) with the business public key, and the raw envelope is signed with the app
 * secret. `open` decrypts an answer, which uses the same key with the bit-inverted IV.
 */
export function whatsappFlowRequest(publicKeyPem: string, body: unknown, appSecret: string) {
  const aesKey = randomBytes(16);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-gcm', aesKey, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(body), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const wrapped = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey,
  );
  const rawBody = Buffer.from(
    JSON.stringify({
      encrypted_aes_key: wrapped.toString('base64'),
      encrypted_flow_data: data.toString('base64'),
      initial_vector: iv.toString('base64'),
    }),
  );
  const signature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const open = (answer: string | null): unknown => {
    if (!answer) return null;
    const raw = Buffer.from(answer, 'base64');
    const decipher = createDecipheriv('aes-128-gcm', aesKey, Buffer.from(iv.map((b) => ~b & 0xff)));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(
      Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString(
        'utf8',
      ),
    );
  };
  return { rawBody, signature, open };
}
