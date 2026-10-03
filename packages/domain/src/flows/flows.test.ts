import {
  constants,
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FlowDecryptError,
  decryptFlowRequest,
  encryptFlowResponse,
  generateFlowKeyPair,
  isEncryptedFlowRequest,
  privateKeyFromPem,
  publicKeyFingerprint,
} from './crypto';
import { STARTER_FLOW_JSON, checkFlowJson } from './flow-json';
import { buildFlowMessageRequest, flowHealthSummary } from './model';

/** Encrypts a request the way WhatsApp does (Meta's endpoint sample, research M-100). */
function clientEncrypt(publicKeyPem: string, body: unknown) {
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
  return {
    request: {
      encrypted_aes_key: wrapped.toString('base64'),
      encrypted_flow_data: data.toString('base64'),
      initial_vector: iv.toString('base64'),
    },
    aesKey,
    iv,
  };
}

/** Decrypts an endpoint answer the way WhatsApp does: same key, inverted IV, tag at the end. */
function clientDecrypt(answer: string, aesKey: Buffer, iv: Buffer): unknown {
  const raw = Buffer.from(answer, 'base64');
  const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
  const decipher = createDecipheriv('aes-128-gcm', aesKey, flipped);
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(
    Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString(
      'utf8',
    ),
  );
}

describe('flow endpoint encryption', () => {
  const current = generateFlowKeyPair();
  const previous = generateFlowKeyPair();

  it('decrypts a request, with the previous key during a rotation, and answers with the inverted IV', () => {
    expect(current.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyFingerprint(current.publicKeyPem)).toBe(current.fingerprint);
    expect(current.privateKeyPem).toContain('BEGIN PRIVATE KEY');

    const keys = [
      privateKeyFromPem(current.privateKeyPem),
      privateKeyFromPem(previous.privateKeyPem),
    ];
    const body = { version: '3.0', action: 'ping' };
    const sent = clientEncrypt(current.publicKeyPem, body);
    expect(isEncryptedFlowRequest(sent.request)).toBe(true);
    const opened = decryptFlowRequest(sent.request, keys);
    expect(opened.body).toEqual(body);
    const answer = encryptFlowResponse({ data: { status: 'active' } }, opened.aesKey, opened.iv);
    expect(clientDecrypt(answer, sent.aesKey, sent.iv)).toEqual({ data: { status: 'active' } });

    // A client that still has the previous public key is served during the rotation.
    const late = clientEncrypt(previous.publicKeyPem, { action: 'INIT', flow_token: 'x' });
    expect(decryptFlowRequest(late.request, keys).body).toEqual({
      action: 'INIT',
      flow_token: 'x',
    });
  });

  it('refuses requests no key opens, tampered data and malformed fields', () => {
    const keys = [privateKeyFromPem(current.privateKeyPem)];
    const stranger = generateFlowKeyPair();
    const foreign = clientEncrypt(stranger.publicKeyPem, { action: 'ping' });
    expect(() => decryptFlowRequest(foreign.request, keys)).toThrow(FlowDecryptError);

    const sent = clientEncrypt(current.publicKeyPem, { action: 'ping' });
    const data = Buffer.from(sent.request.encrypted_flow_data, 'base64');
    data[0] = data[0]! ^ 0xff;
    expect(() =>
      decryptFlowRequest({ ...sent.request, encrypted_flow_data: data.toString('base64') }, keys),
    ).toThrow(FlowDecryptError);
    expect(() =>
      decryptFlowRequest({ ...sent.request, initial_vector: 'not base64!' }, keys),
    ).toThrow(FlowDecryptError);
    expect(isEncryptedFlowRequest({ encrypted_aes_key: 'a' })).toBe(false);
  });
});

describe('Flow JSON checks', () => {
  it('accepts the starter flow and lists its screens and answers', () => {
    const check = checkFlowJson(STARTER_FLOW_JSON);
    expect(check).toMatchObject({
      ok: true,
      summary: {
        version: '7.1',
        dataApiVersion: null,
        screens: ['DETAILS'],
        firstScreen: 'DETAILS',
        answerKeys: ['email', 'full_name'],
      },
    });
  });

  it('reports what is missing or not allowed', () => {
    const issues = (text: string) => {
      const check = checkFlowJson(text);
      return check.ok ? [] : check.issues.map((i) => `${i.path}: ${i.message}`);
    };
    expect(issues('{"version": "7.1", "screens": [')[0]).toMatch(/^\$: This is not valid JSON/);
    expect(issues('[]')).toEqual(['$: The Flow JSON must be an object.']);
    expect(issues('{"screens": []}')).toEqual([
      '$.version: Set "version" to a Flow JSON version such as "7.1".',
      '$.screens: Add at least one screen.',
    ]);
    expect(
      issues(
        JSON.stringify({
          version: '7.1',
          data_api_version: 3,
          screens: [
            { id: 'SUCCESS', layout: { children: [] } },
            { id: 'A B', layout: {} },
            { id: 'ONE', layout: { children: Array.from({ length: 51 }, () => ({})) } },
            { id: 'ONE', terminal: true, layout: { children: [] } },
          ],
        }),
      ),
    ).toEqual([
      '$.data_api_version: Set "data_api_version" to a version such as "3.0", or remove it.',
      '$.screens[0].id: "SUCCESS" is reserved; use another screen id.',
      '$.screens[1].id: Give the screen an id of letters, digits and underscores.',
      '$.screens[1].layout: Give the screen a layout with children.',
      '$.screens[2].layout.children: A screen can hold at most 50 components.',
      '$.screens[3].id: Another screen already uses the id "ONE".',
    ]);
    expect(
      issues(JSON.stringify({ version: '7.1', screens: [{ id: 'A', layout: { children: [] } }] })),
    ).toEqual([
      '$.screens: Mark at least one screen as terminal ("terminal": true) so the flow can end.',
    ]);
    expect(issues(`{"version":"7.1","pad":"${'x'.repeat(300 * 1024)}"}`)).toEqual([
      '$: Use at most 256 KB of JSON.',
    ]);
  });

  it('reads the data API version of flows that use an endpoint', () => {
    const check = checkFlowJson(
      JSON.stringify({
        version: '7.1',
        data_api_version: '3.0',
        routing_model: { START: [] },
        screens: [
          { id: 'START', terminal: true, layout: { type: 'SingleColumnLayout', children: [] } },
        ],
      }),
    );
    expect(check.ok && check.summary.dataApiVersion).toBe('3.0');
  });
});

describe('flow messages and health', () => {
  it('builds the interactive flow message of research M-165', () => {
    expect(
      buildFlowMessageRequest(
        '919876543210',
        { header: null, body: 'Tell us about you', footer: 'Takes a minute', cta: 'Open form' },
        { metaFlowId: '7000000001', token: 't'.repeat(43), mode: 'draft' },
      ),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: 'Tell us about you' },
        footer: { text: 'Takes a minute' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_id: '7000000001',
            flow_cta: 'Open form',
            mode: 'draft',
            flow_token: 't'.repeat(43),
            flow_action: 'navigate',
          },
        },
      },
    });
  });

  it('reads Meta’s health status and leaves out what it cannot read', () => {
    expect(flowHealthSummary(null)).toEqual({ canSendMessage: null, problems: [] });
    expect(
      flowHealthSummary({
        can_send_message: 'BLOCKED',
        entities: [
          {
            entity_type: 'WABA',
            id: '1',
            can_send_message: 'BLOCKED',
            errors: [
              {
                error_code: 141014,
                error_description: 'The WABA is banned.',
                possible_solution: 'Visit Business Support Home.',
              },
            ],
          },
          { entity_type: 'FLOW', id: '2', can_send_message: 'AVAILABLE' },
          'not an entity',
          { entity_type: 'APP', errors: [{ error_code: 1 }, null, { error_description: 7 }] },
        ],
      }),
    ).toEqual({
      canSendMessage: 'BLOCKED',
      problems: [
        {
          entity: 'WABA',
          description: 'The WABA is banned.',
          solution: 'Visit Business Support Home.',
        },
      ],
    });
    // Meta's text is clipped without splitting an emoji (ADR-133).
    expect(
      flowHealthSummary({
        entities: [
          { entity_type: 'FLOW', errors: [{ error_description: `${'x'.repeat(499)}😀 more` }] },
        ],
      }).problems,
    ).toEqual([{ entity: 'FLOW', description: 'x'.repeat(499), solution: null }]);
  });
});
