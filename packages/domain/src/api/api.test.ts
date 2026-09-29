import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppError, isAppError, sha256Hex } from '@w360/core';
import { API_SCOPES } from '@w360/db';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../authz/permissions';
import { apiErrorResponse, apiRequestError } from './errors';
import { allowedNetworksSchema, bearerToken, generateApiToken, networkEntryProblem } from './keys';
import type { ApiContext } from './context';
import { apiConversationStatusSchema, apiSetConversationStatus } from './conversations';
import {
  API_LIMITS,
  API_SCOPE_INFO,
  API_SCOPE_KEYS,
  API_SEND_SCOPES,
  API_TOKEN_RE,
  IDEMPOTENCY_KEY_RE,
  apiKeyState,
  formatAllowedNetwork,
} from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';
import {
  INTERACTIVE_LIMITS,
  listContent,
  listInteractive,
  replyButtonsContent,
  replyButtonsInteractive,
} from '../messaging/interactive';
import {
  apiSendButtonsSchema,
  apiSendListSchema,
  apiSendMessage,
  apiSendTextSchema,
} from './resources';
import {
  apiCreateWebhookEndpointSchema,
  apiUpdateWebhookEndpointSchema,
  createApiWebhookEndpoints,
  endpointAnnouncement,
} from './webhook-endpoints';

describe('API tokens', () => {
  it('have a public prefix, a 256-bit secret and only their SHA-256 is kept', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { keyPrefix, token, tokenHash } = generateApiToken();
      expect(keyPrefix).toMatch(/^w360_[a-z2-7]{12}$/);
      expect(token).toMatch(API_TOKEN_RE);
      expect(token.startsWith(`${keyPrefix}_`)).toBe(true);
      expect(token.slice(keyPrefix.length + 1)).toHaveLength(43);
      expect(tokenHash).toBe(sha256Hex(token));
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
      seen.add(keyPrefix);
      seen.add(token);
    }
    expect(seen.size).toBe(400);
  });

  it('are read from a bearer header only when they have the token shape', () => {
    const { token } = generateApiToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(`bearer ${token}`)).toBe(token);
    expect(bearerToken(`  Bearer ${token}  `)).toBe(token);
    for (const header of [
      null,
      undefined,
      '',
      'Bearer',
      'Bearer ',
      token,
      `Basic ${token}`,
      `Bearer  ${token}`,
      `Bearer ${token} ${token}`,
      `Bearer ${token}x`,
      `Bearer ${token.slice(0, -1)}`,
      `Bearer ${token.replace('w360_', 'w361_')}`,
      `Bearer ${token.toUpperCase()}`,
    ]) {
      expect(bearerToken(header)).toBeNull();
    }
  });
});

describe('API scopes', () => {
  it('are the scopes the database accepts, each granted by a real permission', () => {
    expect([...API_SCOPE_KEYS].sort()).toEqual([...API_SCOPES].sort());
    expect(Object.keys(API_SCOPE_INFO).sort()).toEqual([...API_SCOPES].sort());
    for (const scope of API_SCOPE_KEYS) {
      expect(PERMISSIONS).toContain(API_SCOPE_INFO[scope].permission);
    }
  });

  it('mark exactly the changing scopes as writes (refused while a company is not active)', () => {
    const writes = API_SCOPE_KEYS.filter((s) => API_SCOPE_INFO[s].writes);
    expect(writes).toEqual([
      'contacts.write',
      'messages.send',
      'messages.send_marketing',
      'messages.reply',
      'conversations.write',
      'automations.start',
      'webhooks.manage',
    ]);
    expect([...API_SEND_SCOPES]).toEqual(API_SCOPE_KEYS.filter((s) => s.startsWith('messages.')));
  });

  it('need the permission a member needs for the same work', () => {
    expect(API_SCOPE_INFO['messages.send'].permission).toBe('inbox.reply');
    expect(API_SCOPE_INFO['messages.send_marketing'].permission).toBe('campaigns.send');
    expect(API_SCOPE_INFO['messages.reply'].permission).toBe('inbox.reply');
    expect(API_SCOPE_INFO['contacts.write'].permission).toBe('contacts.write');
    expect(API_SCOPE_INFO['conversations.read'].permission).toBe('inbox.read_all');
    expect(API_SCOPE_INFO['conversations.write'].permission).toBe('inbox.supervise');
    expect(API_SCOPE_INFO['automations.start'].permission).toBe('automations.publish');
    expect(API_SCOPE_INFO['webhooks.manage'].permission).toBe('developer.manage');
  });

  it('let only members who manage webhook endpoints in settings grant webhooks.manage, who also read every conversation (ADR-081)', () => {
    const granting = Object.entries(ROLE_PERMISSIONS).filter(([, permissions]) =>
      permissions.has('developer.manage'),
    );
    expect(granting.map(([role]) => role).sort()).toEqual(['admin', 'owner']);
    // An endpoint for message.received gets what contacts write: the grantors read it all already.
    for (const [, permissions] of granting) expect(permissions.has('inbox.read_all')).toBe(true);
  });

  it('let only members who publish automations grant automations.start (ADR-077)', () => {
    const granting = Object.entries(ROLE_PERMISSIONS).filter(([, permissions]) =>
      permissions.has('automations.publish'),
    );
    expect(granting.map(([role]) => role).sort()).toEqual(['admin', 'owner']);
  });

  it('let only members who resolve every conversation in the inbox grant conversations.write', () => {
    const granting = Object.entries(ROLE_PERMISSIONS).filter(([, permissions]) =>
      permissions.has('inbox.supervise'),
    );
    expect(granting.map(([role]) => role).sort()).toEqual(['admin', 'owner', 'supervisor']);
    for (const [, permissions] of granting) {
      expect(permissions.has('inbox.read_all')).toBe(true);
      expect(permissions.has('inbox.reply')).toBe(true);
    }
  });
});

describe('conversation status (ADR-075)', () => {
  const ctx = (scopes: string[], status = 'active') =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
    }) as unknown as ApiContext;
  const id = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';

  it('is open or resolved, and nothing else', () => {
    expect(apiConversationStatusSchema.parse({ status: 'resolved' })).toEqual({
      status: 'resolved',
    });
    expect(apiConversationStatusSchema.parse({ status: 'open' })).toEqual({ status: 'open' });
    for (const bad of [
      {},
      { status: 'pending' },
      { status: 'closed' },
      { status: 'RESOLVED' },
      { status: null },
      { status: 'resolved', assigned: false },
      'resolved',
      null,
    ]) {
      expect(apiConversationStatusSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('is refused before anything is read: without the scope, while the company is not active, for ids that are not ids, and for other bodies', async () => {
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'resolved',
        (error: unknown) => (isAppError(error) ? error.code : String(error)),
      );
    const set = (c: ApiContext, conversationId: string, body: unknown) =>
      code(apiSetConversationStatus({} as never, c, conversationId, body));
    const body = { status: 'resolved' };
    expect(await set(ctx(['conversations.read']), id, body)).toBe('forbidden');
    for (const status of ['suspended', 'restricted']) {
      expect(await set(ctx(['conversations.write'], status), id, body)).toBe('tenant_suspended');
    }
    expect(await set(ctx(['conversations.write']), 'not-a-uuid', body)).toBe('not_found');
    expect(await set(ctx(['conversations.write']), id, { status: 'pending' })).toBe(
      'validation_failed',
    );
  });
});

describe('text replies (ADR-070)', () => {
  const base = { type: 'text', to: '+919876543210' };

  it('take 1 to 4096 characters of trimmed text, with link previews off unless asked for', () => {
    expect(apiSendTextSchema.parse({ ...base, text: '  Your order ships today.  ' })).toEqual({
      ...base,
      text: 'Your order ships today.',
      previewUrl: false,
    });
    const long = 'x'.repeat(API_LIMITS.textLength);
    expect(apiSendTextSchema.parse({ ...base, text: long, previewUrl: true })).toMatchObject({
      text: long,
      previewUrl: true,
    });
    for (const bad of [
      { ...base, text: '   ' },
      { ...base, text: `${long}x` },
      { ...base },
      { ...base, text: 'Hi', templateId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01' },
      { ...base, text: 'Hi', from: 'not-a-number-id' },
      { ...base, type: 'template', text: 'Hi' },
    ]) {
      expect(apiSendTextSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('are chosen by the body’s type; any other type is refused before anything is read', async () => {
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set() },
    } as unknown as ApiContext;
    const idem = { key: 'k-1', requestHash: 'h' };
    for (const body of [{ type: 'image' }, { type: 'TEXT' }, { type: null }]) {
      const error: unknown = await apiSendMessage(
        {} as never,
        ctx,
        { ...body, to: '+919876543210' },
        idem,
      ).catch((caught: unknown) => caught);
      expect(isAppError(error) && error.code, JSON.stringify(body)).toBe('validation_failed');
      expect(isAppError(error) && error.issues?.[0]?.path).toBe('type');
    }
  });
});

describe('reply buttons and lists (ADR-080)', () => {
  const base = { to: '+919876543210' };
  const buttons = {
    ...base,
    type: 'buttons',
    header: '  Your appointment ',
    body: 'Tomorrow at 10:00 with Dr Rao. Can you come?',
    footer: 'Sunrise Clinic',
    buttons: [
      { id: 'appt-42:yes', title: ' Confirm ' },
      { id: 'appt-42:move', title: 'Reschedule' },
      { id: 'appt-42:no', title: 'Cancel' },
    ],
  };
  const list = {
    ...base,
    type: 'list',
    body: 'Pick a time for tomorrow.',
    button: 'See times',
    sections: [
      {
        title: 'Morning',
        rows: [
          { id: 'slot-10', title: '10:00', description: 'Dr Rao' },
          { id: 'slot-11', title: '11:00' },
        ],
      },
      { title: 'Afternoon', rows: [{ id: 'slot-15', title: '15:00', description: 'Dr Iyer' }] },
    ],
  };
  const refused = (schema: typeof apiSendButtonsSchema | typeof apiSendListSchema, body: unknown) =>
    schema.safeParse(body).success;

  it('use Meta’s published limits, with 10 rows in all (research M-157, M-159, M-179, M-181)', () => {
    expect(INTERACTIVE_LIMITS).toEqual({
      headerLength: 60,
      bodyLength: 1024,
      footerLength: 60,
      buttons: 3,
      buttonIdLength: 256,
      buttonTitleLength: 20,
      listButtonLength: 20,
      sections: 10,
      sectionTitleLength: 24,
      rows: 10,
      rowIdLength: 200,
      rowTitleLength: 24,
      rowDescriptionLength: 72,
    });
  });

  it('take 1 to 3 buttons with ids kept as given and trimmed texts within Meta’s limits', () => {
    expect(apiSendButtonsSchema.parse(buttons)).toEqual({
      ...buttons,
      header: 'Your appointment',
      buttons: [{ id: 'appt-42:yes', title: 'Confirm' }, ...buttons.buttons.slice(1)],
    });
    const L = INTERACTIVE_LIMITS;
    const one = {
      ...base,
      type: 'buttons',
      body: 'x'.repeat(L.bodyLength),
      buttons: [{ id: 'i'.repeat(L.buttonIdLength), title: 't'.repeat(L.buttonTitleLength) }],
    };
    expect(apiSendButtonsSchema.safeParse(one).success).toBe(true);
    const button = (b: Record<string, unknown>) => ({
      ...base,
      type: 'buttons',
      body: 'Hi',
      buttons: [b],
    });
    for (const bad of [
      { ...buttons, buttons: [] },
      { ...buttons, buttons: [...buttons.buttons, { id: 'four', title: 'Four' }] },
      {
        ...buttons,
        buttons: [
          { id: 'a', title: 'Yes' },
          { id: 'b', title: 'YES' },
        ],
      },
      {
        ...buttons,
        buttons: [
          { id: 'a', title: 'Yes' },
          { id: 'a', title: 'No' },
        ],
      },
      button({ id: ' a', title: 'Yes' }),
      button({ id: 'a ', title: 'Yes' }),
      button({ id: '', title: 'Yes' }),
      button({ id: 'i'.repeat(L.buttonIdLength + 1), title: 'Yes' }),
      button({ id: 'a', title: 't'.repeat(L.buttonTitleLength + 1) }),
      button({ id: 'a', title: '   ' }),
      button({ id: 'w360csat:0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01:3', title: 'Great' }),
      button({ id: 'W360bot:run:node:1:0', title: 'Yes' }),
      button({ id: 'a', title: 'Yes', url: 'https://example.com' }),
      { ...one, body: 'x'.repeat(L.bodyLength + 1) },
      { ...one, header: 'h'.repeat(L.headerLength + 1) },
      { ...one, footer: 'f'.repeat(L.footerLength + 1) },
      { ...one, body: '  ' },
      { ...one, text: 'Hi' },
      { ...one, type: 'list' },
    ]) {
      expect(refused(apiSendButtonsSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('take up to 10 rows in all, in titled sections, with unique ids within Meta’s limits', () => {
    expect(apiSendListSchema.parse(list)).toEqual(list);
    const L = INTERACTIVE_LIMITS;
    const rows = (n: number, prefix = 'r') =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, title: `Row ${i}` }));
    const single = (section: Record<string, unknown>) => ({ ...list, sections: [section] });
    expect(apiSendListSchema.safeParse(single({ rows: rows(L.rows) })).success).toBe(true);
    const longest = {
      id: 'i'.repeat(L.rowIdLength),
      title: 't'.repeat(L.rowTitleLength),
      description: 'd'.repeat(L.rowDescriptionLength),
    };
    expect(
      apiSendListSchema.safeParse(
        single({ title: 's'.repeat(L.sectionTitleLength), rows: [longest] }),
      ).success,
    ).toBe(true);
    for (const bad of [
      single({ rows: rows(L.rows + 1) }),
      {
        ...list,
        sections: [
          { title: 'A', rows: rows(6, 'a') },
          { title: 'B', rows: rows(5, 'b') },
        ],
      },
      { ...list, sections: [{ title: 'A', rows: rows(1, 'a') }, { rows: rows(1, 'b') }] },
      {
        ...list,
        sections: [
          { title: 'A', rows: rows(1) },
          { title: 'B', rows: rows(1) },
        ],
      },
      {
        ...list,
        sections: Array.from({ length: L.sections + 1 }, (_, i) => ({
          title: `S${i}`,
          rows: rows(1, `s${i}-`),
        })),
      },
      { ...list, sections: [] },
      single({ rows: [] }),
      single({ title: 's'.repeat(L.sectionTitleLength + 1), rows: rows(1) }),
      single({ rows: [{ ...longest, id: 'i'.repeat(L.rowIdLength + 1) }] }),
      single({ rows: [{ ...longest, title: 't'.repeat(L.rowTitleLength + 1) }] }),
      single({ rows: [{ ...longest, description: 'd'.repeat(L.rowDescriptionLength + 1) }] }),
      single({ rows: [{ id: 'w360:anything', title: 'Row' }] }),
      single({ rows: [{ id: 'r ', title: 'Row' }] }),
      { ...list, button: 'b'.repeat(L.listButtonLength + 1) },
      { ...list, button: ' ' },
      { ...list, buttons: buttons.buttons },
    ]) {
      expect(refused(apiSendListSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('become the interactive objects Meta describes, with the inbox’s content beside them', () => {
    const b = apiSendButtonsSchema.parse(buttons);
    expect(replyButtonsInteractive(b)).toEqual({
      type: 'button',
      header: { type: 'text', text: 'Your appointment' },
      body: { text: b.body },
      footer: { text: 'Sunrise Clinic' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'appt-42:yes', title: 'Confirm' } },
          { type: 'reply', reply: { id: 'appt-42:move', title: 'Reschedule' } },
          { type: 'reply', reply: { id: 'appt-42:no', title: 'Cancel' } },
        ],
      },
    });
    expect(replyButtonsContent(b)).toEqual({
      header: 'Your appointment',
      body: b.body,
      footer: 'Sunrise Clinic',
      buttons: ['Confirm', 'Reschedule', 'Cancel'],
    });
    const l = apiSendListSchema.parse(list);
    // No header or footer given, none sent; a row without a description has none.
    expect(listInteractive(l)).toEqual({
      type: 'list',
      body: { text: 'Pick a time for tomorrow.' },
      action: {
        button: 'See times',
        sections: [
          {
            title: 'Morning',
            rows: [
              { id: 'slot-10', title: '10:00', description: 'Dr Rao' },
              { id: 'slot-11', title: '11:00' },
            ],
          },
          { title: 'Afternoon', rows: [{ id: 'slot-15', title: '15:00', description: 'Dr Iyer' }] },
        ],
      },
    });
    expect(listContent(l)).toEqual({
      header: null,
      body: 'Pick a time for tomorrow.',
      footer: null,
      list: {
        button: 'See times',
        sections: [
          {
            title: 'Morning',
            rows: [
              { title: '10:00', description: 'Dr Rao' },
              { title: '11:00', description: null },
            ],
          },
          { title: 'Afternoon', rows: [{ title: '15:00', description: 'Dr Iyer' }] },
        ],
      },
    });
    // Ids stay out of what the inbox stores: they travel only in the request to Meta.
    expect(JSON.stringify(listContent(l))).not.toContain('slot-');
    expect(JSON.stringify(replyButtonsContent(b))).not.toContain('appt-42');
  });

  it('need the reply scope, checked before anything is read', async () => {
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['messages.send']) },
    } as unknown as ApiContext;
    for (const body of [buttons, list]) {
      const error: unknown = await apiSendMessage({} as never, ctx, body, {
        key: 'k-1',
        requestHash: 'h',
      }).catch((caught: unknown) => caught);
      expect(isAppError(error) && error.code, body.type).toBe('forbidden');
    }
  });
});

describe('webhook endpoints through the API (ADR-081)', () => {
  it('take an address, events and a description, events in the settings order and once each', () => {
    expect(
      apiCreateWebhookEndpointSchema.parse({
        url: ' https://hooks.example.com/w360 ',
        events: ['contact.created', 'message.received', 'contact.created'],
        description: '  CRM sync ',
      }),
    ).toEqual({
      url: 'https://hooks.example.com/w360',
      events: ['message.received', 'contact.created'],
      description: 'CRM sync',
    });
    for (const body of [
      { events: ['message.received'] },
      { url: 'https://hooks.example.com', events: [] },
      { url: 'https://hooks.example.com', events: ['message.deleted'] },
      { url: 'https://hooks.example.com', events: ['message.received'], secret: 'whsec_mine' },
      {
        url: 'https://hooks.example.com',
        events: ['message.received'],
        description: 'x'.repeat(201),
      },
      { url: `https://hooks.example.com/${'x'.repeat(2048)}`, events: ['message.received'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });

  it('change the events, description or state, never the address, and need something to change', () => {
    expect(apiUpdateWebhookEndpointSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(apiUpdateWebhookEndpointSchema.parse({ description: '' })).toEqual({ description: '' });
    for (const body of [{}, { url: 'https://elsewhere.example.com' }, { events: [] }]) {
      expect(apiUpdateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });

  it('announce a key’s endpoint by its host and events, with the key’s name and prefix and the company’s time', () => {
    // A made-up prefix: the public part of a key, which settings list and the email names.
    const prefix = 'w360_abcdefghijkl';
    expect(
      endpointAnnouncement({
        keyName: 'Zap connector',
        keyPrefix: prefix,
        host: 'hooks.example.com',
        events: ['message.received', 'contact.created'],
        at: new Date('2026-09-29T10:15:00Z'),
        timeZone: 'Asia/Kolkata',
      }),
    ).toEqual({
      subject: 'Webhook endpoint added through the API',
      lines: [
        'The API key “Zap connector” (w360_abcdefghijkl_…) added a webhook endpoint at hooks.example.com on 29 September 2026 at 15:45 GMT+5:30. It receives: Message received, Contact added.',
        'If you did not expect this, delete the endpoint in Settings, Webhooks, and revoke the key in Settings, API keys.',
      ],
    });
  });

  it('need the scope, checked before anything is read', async () => {
    const endpoints = createApiWebhookEndpoints({} as never);
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['contacts.read']) },
    } as unknown as ApiContext;
    const idempotency = { key: 'k-1', requestHash: 'h' };
    for (const call of [
      () => endpoints.list(ctx),
      () => endpoints.get(ctx, 'e'),
      () => endpoints.create(ctx, {}, idempotency),
      () => endpoints.update(ctx, 'e', {}),
      () => endpoints.remove(ctx, 'e'),
      () => endpoints.rotateSecret(ctx, 'e', idempotency),
    ]) {
      const error: unknown = await call().catch((caught: unknown) => caught);
      expect(isAppError(error) && error.code).toBe('forbidden');
    }
  });

  it('are described with the secret shown once and a body without the address for changes', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as Record<string, Record<string, { parameters?: unknown[] }>>;
    expect(paths['/webhook-endpoints']?.post?.parameters).toEqual([
      { $ref: '#/components/parameters/IdempotencyKey' },
    ]);
    expect(paths['/webhook-endpoints/{id}/rotate-secret']?.post?.parameters).toContainEqual({
      $ref: '#/components/parameters/IdempotencyKey',
    });
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const withSecret = schemas.WebhookEndpointWithSecret as {
      properties: Record<string, { type?: unknown }>;
    };
    expect(withSecret.properties.secret?.type).toEqual(['string', 'null']);
    const update = schemas.UpdateWebhookEndpoint as {
      properties: Record<string, unknown>;
      additionalProperties: unknown;
    };
    expect(Object.keys(update.properties).sort()).toEqual(['description', 'enabled', 'events']);
    expect(update.additionalProperties).toBe(false);
  });
});

describe('allowed networks (ADR-076)', () => {
  it('take IPv4 and IPv6 addresses and networks, one per line or separated by commas or spaces', () => {
    expect(allowedNetworksSchema.parse(undefined)).toBeNull();
    expect(allowedNetworksSchema.parse('  \n ')).toBeNull();
    expect(
      allowedNetworksSchema.parse(
        '203.0.113.0/24\n198.51.100.7, 2001:db8::/32 2001:db8::1\n203.0.113.0/24',
      ),
    ).toEqual(['203.0.113.0/24', '198.51.100.7', '2001:db8::/32', '2001:db8::1']);
    const twenty = Array.from({ length: 20 }, (_, i) => `198.51.100.${i}`).join('\n');
    expect(allowedNetworksSchema.parse(twenty)).toHaveLength(20);
    expect(allowedNetworksSchema.safeParse(`${twenty}\n198.51.100.20`).success).toBe(false);
    expect(allowedNetworksSchema.safeParse('1'.repeat(2001)).success).toBe(false);
  });

  it('refuse what is not an address or network, a prefix longer than the address, /0 and mapped IPv4', () => {
    for (const entry of ['203.0.113.7', '203.0.113.0/24', '2001:db8::/32', '::1', '10.0.0.0/8']) {
      expect(networkEntryProblem(entry), entry).toBeNull();
    }
    const problems: [string, RegExp][] = [
      ['example.com', /not an IP address or network/],
      ['203.0.113', /not an IP address or network/],
      ['203.0.113.0/24/8', /not an IP address or network/],
      ['203.0.113.0/x', /not an IP address or network/],
      ['203.0.113.0/', /not an IP address or network/],
      ['203.0.113.0/33', /prefix length longer than the address/],
      ['2001:db8::/129', /prefix length longer than the address/],
      ['0.0.0.0/0', /accept every address/],
      ['::/0', /accept every address/],
      ['::ffff:203.0.113.7', /as the IPv4 address 203\.0\.113\.7/],
    ];
    for (const [entry, problem] of problems) {
      expect(networkEntryProblem(entry), entry).toMatch(problem);
      expect(allowedNetworksSchema.safeParse(`198.51.100.7\n${entry}`).success, entry).toBe(false);
    }
  });

  it('show a single address without its prefix length', () => {
    expect(formatAllowedNetwork('203.0.113.7/32')).toBe('203.0.113.7');
    expect(formatAllowedNetwork('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(formatAllowedNetwork('2001:db8::1/128')).toBe('2001:db8::1');
    expect(formatAllowedNetwork('2001:db8::/32')).toBe('2001:db8::/32');
  });
});

describe('apiKeyState', () => {
  const now = new Date('2026-09-28T10:00:00.000Z');
  it('is revoked before expired, and expired from the expiry instant on', () => {
    expect(apiKeyState({ revokedAt: null, expiresAt: null }, now)).toBe('active');
    expect(apiKeyState({ revokedAt: null, expiresAt: new Date(now.getTime() + 1) }, now)).toBe(
      'active',
    );
    expect(apiKeyState({ revokedAt: null, expiresAt: now }, now)).toBe('expired');
    expect(apiKeyState({ revokedAt: now, expiresAt: new Date(now.getTime() - 1) }, now)).toBe(
      'revoked',
    );
  });
});

describe('Idempotency-Key header', () => {
  it('accepts 1 to 255 visible ASCII characters', () => {
    expect(IDEMPOTENCY_KEY_RE.test('a')).toBe(true);
    expect(IDEMPOTENCY_KEY_RE.test('0b9f6c1e-6a52-4c1e-9d0e-3f5a2b7c8d9e')).toBe(true);
    expect(IDEMPOTENCY_KEY_RE.test('!~'.repeat(127) + '!')).toBe(true);
    for (const bad of ['', 'x'.repeat(256), 'has space', 'tab\tkey', 'naïve', 'line\nbreak']) {
      expect(IDEMPOTENCY_KEY_RE.test(bad)).toBe(false);
    }
  });
});

describe('API errors', () => {
  it('expose only the public message, issues and curated reason of application errors', () => {
    const mapped = apiErrorResponse(
      new AppError('validation_failed', 'Bad key', {
        details: { apiReason: 'idempotency_key_reused', secret: 'x' },
        issues: [{ path: 'to', message: 'Invalid' }],
      }),
      'req-1',
    );
    expect(mapped).toEqual({
      status: 422,
      internal: false,
      body: {
        error: {
          code: 'validation_failed',
          message: 'Bad key',
          reason: 'idempotency_key_reused',
          issues: [{ path: 'to', message: 'Invalid' }],
        },
        requestId: 'req-1',
      },
    });
    expect(apiErrorResponse(new AppError('tenant_suspended', 'Suspended'), 'r').status).toBe(423);
    expect(apiErrorResponse(new AppError('forbidden', 'No'), 'r').status).toBe(403);
  });

  it('turn anything else into a generic internal error without its message', () => {
    const mapped = apiErrorResponse(new Error('connection string postgres://secret'), 'req-2');
    expect(mapped.status).toBe(500);
    expect(mapped.internal).toBe(true);
    expect(JSON.stringify(mapped.body)).not.toContain('secret');
    expect(apiRequestError(401, 'unauthenticated', 'No key', 'r')).toEqual({
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'No key' }, requestId: 'r' },
    });
    expect(apiRequestError(429, 'rate_limited', 'Used up', 'r', 'quota_exceeded')).toEqual({
      status: 429,
      body: {
        error: { code: 'rate_limited', message: 'Used up', reason: 'quota_exceeded' },
        requestId: 'r',
      },
    });
  });
});

describe('OpenAPI document', () => {
  const doc = buildOpenApiDocument('https://app.example.com/api/v1');
  type Operation = { operationId: string; responses: Record<string, unknown> };
  const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;

  it('describes exactly the API routes, each with a unique operation id and error responses', () => {
    const described = Object.entries(paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((method) => `${method} ${path}`),
    );
    expect(described.sort()).toEqual(API_ROUTES.map(([m, p]) => `${m} ${p}`).sort());
    const ids = described.map((d) => {
      const [method, path] = d.split(' ') as [string, string];
      return paths[path]?.[method]?.operationId;
    });
    expect(new Set(ids).size).toBe(ids.length);
    for (const [method, path] of API_ROUTES) {
      const responses = Object.keys(paths[path]?.[method]?.responses ?? {});
      // 403 and 429 also carry the plan's refusals (not_in_plan, quota_exceeded; ADR-061).
      expect(responses).toEqual(expect.arrayContaining(['401', '403', '429', '500']));
      expect(responses.some((s) => s.startsWith('2'))).toBe(true);
    }
  });

  it('names the plan refusals in the 403 and 429 responses and the error reason', () => {
    const responses = paths['/contacts']?.get?.responses as Record<string, { description: string }>;
    expect(responses['403']?.description).toContain('not_in_plan');
    expect(responses['429']?.description).toContain('quota_exceeded');
    expect(JSON.stringify(doc.components)).toContain(
      'ip_not_allowed, not_in_plan, quota_exceeded or window_closed',
    );
    expect(responses['403']?.description).toContain('ip_not_allowed');
  });

  it('sends a template or a reply (text, buttons, list) from one operation, naming the window refusal', () => {
    const send = paths['/messages']?.post as unknown as {
      operationId: string;
      description: string;
      requestBody: { content: { 'application/json': { schema: unknown } } };
      responses: Record<string, { description: string }>;
    };
    expect(send.operationId).toBe('sendMessage');
    expect(send.requestBody.content['application/json'].schema).toEqual({
      oneOf: [
        { $ref: '#/components/schemas/SendTemplate' },
        { $ref: '#/components/schemas/SendText' },
        { $ref: '#/components/schemas/SendButtons' },
        { $ref: '#/components/schemas/SendList' },
      ],
    });
    for (const scope of API_SEND_SCOPES) expect(send.description).toContain(`\`${scope}\``);
    expect(send.description).toContain('window_closed');
    expect(send.description).toContain('`reply.id`');
    expect(send.description).toContain('`w360`');
    expect(send.responses['412']?.description).toContain('window_closed');
    const read = paths['/messages/{id}']?.get as unknown as { description: string };
    for (const scope of API_SEND_SCOPES) expect(read.description).toContain(`\`${scope}\``);
  });

  it('resolves or reopens a conversation with the status alone', () => {
    const patch = paths['/conversations/{id}']?.patch as unknown as {
      operationId: string;
      description: string;
      requestBody: { content: { 'application/json': { schema: unknown } } };
      responses: Record<string, unknown>;
    };
    expect(patch.operationId).toBe('setConversationStatus');
    expect(patch.description).toContain('`conversations.write`');
    expect(patch.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ConversationStatus',
    });
    expect(Object.keys(patch.responses)).toEqual(
      expect.arrayContaining(['200', '404', '422', '423']),
    );
    const schemas = doc.components.schemas as Record<
      string,
      {
        required?: string[];
        additionalProperties?: unknown;
        properties?: Record<string, { enum?: string[] }>;
      }
    >;
    expect(schemas.ConversationStatus?.required).toEqual(['status']);
    expect(schemas.ConversationStatus?.additionalProperties).toBe(false);
    expect(schemas.ConversationStatus?.properties?.status?.enum).toEqual(['open', 'resolved']);
  });

  it('resolves every reference to a component', () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(10);
    const components = doc.components as unknown as Record<string, Record<string, unknown>>;
    for (const [, section, name] of refs) {
      expect(components[section as string]?.[name as string], `${section}/${name}`).toBeDefined();
    }
  });

  it('takes request bodies from the validation schemas (strict, with required fields)', () => {
    const schemas = doc.components.schemas as Record<
      string,
      { required?: string[]; additionalProperties?: unknown }
    >;
    expect(schemas.SendTemplate?.required).toEqual(expect.arrayContaining(['to', 'templateId']));
    expect(schemas.SendTemplate?.required).not.toContain('type');
    expect(schemas.SendTemplate?.additionalProperties).toBe(false);
    expect(schemas.SendText?.required).toEqual(expect.arrayContaining(['type', 'to', 'text']));
    expect(schemas.SendText?.required).not.toContain('previewUrl');
    expect(schemas.SendText?.additionalProperties).toBe(false);
    expect(schemas.ContactCreate?.required).toEqual(['phone']);
    expect(schemas.Consent?.required).toEqual(
      expect.arrayContaining(['purpose', 'action', 'evidence']),
    );
    expect(doc.servers).toEqual([{ url: 'https://app.example.com/api/v1' }]);
  });

  it('matches the route handlers in the web app', () => {
    const root = fileURLToPath(new URL('../../../../apps/web/src/app/api/v1/', import.meta.url));
    for (const [method, path] of API_ROUTES) {
      const file = `${root}${path.slice(1).replace(/\{(\w+)\}/g, '[$1]')}/route.ts`;
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, 'utf8')).toMatch(
        new RegExp(`export (async )?function ${method.toUpperCase()}\\(`),
      );
    }
  });
});
