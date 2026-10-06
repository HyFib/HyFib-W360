import { describe, expect, it } from 'vitest';
import { QUEUES } from '@w360/contracts';
import type { Database, TenantRole, TenantScope } from '@w360/db';
import type { TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import { GraphClient } from '../messaging/graph';
import {
  READ_RECEIPT_KIND,
  TYPING_INDICATOR_KIND,
  createReadReceiptsService,
  readReceiptsSettingsSchema,
  sendReadReceipt,
} from './read-receipts';

const ctxOf = (roles: TenantRole[]) =>
  ({
    tenant: { id: 't', status: 'active' },
    membership: { id: 'm' },
    user: { id: 'u' },
    permissions: permissionsForRoles(roles),
    rolePermissions: permissionsForRoles(roles),
    plan: { modules: new Set() },
    mfa: { blocking: false },
  }) as unknown as TenantContext;

const unreachableDb = {
  run: () => {
    throw new Error('the database was reached');
  },
} as unknown as Database;

const service = createReadReceiptsService({
  db: unreachableDb,
  clock: { now: () => new Date() },
  jobs: {} as never,
  signer: {} as never,
});

const CONVERSATION = '0192f3a4-5b6c-7d8e-9f00-112233445566';

describe('read receipts and typing indicators (ADR-223)', () => {
  it('sends the read receipt research M-045 gives, with a typing indicator when asked', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const graph = (answer: unknown) =>
      new GraphClient({
        baseUrl: 'https://graph.test',
        version: 'v26.0',
        fetchImpl: async (input, init) => {
          seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify(answer), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      });
    expect(
      await graph({ success: true }).markRead('1234', 'tok', {
        messageId: 'wamid.A',
        typing: false,
      }),
    ).toEqual({ ok: true, data: { read: true } });
    expect(seen[0]).toEqual({
      url: 'https://graph.test/v26.0/1234/messages',
      body: { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.A' },
    });
    await graph({ success: true }).markRead('1234', 'tok', { messageId: 'wamid.B', typing: true });
    expect(seen[1]!.body).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.B',
      typing_indicator: { type: 'text' },
    });
    expect(
      await graph({ success: false }).markRead('1234', 'tok', {
        messageId: 'wamid.C',
        typing: false,
      }),
    ).toMatchObject({ ok: false, title: 'unexpected_response_shape' });
  });

  it('names its jobs and queue, and takes the setting as a yes or no', () => {
    expect([READ_RECEIPT_KIND, TYPING_INDICATOR_KIND]).toEqual(['message.read', 'message.typing']);
    expect(QUEUES.messageRead).toMatchObject({ name: 'message.read', expireInSeconds: 60 });
    expect(readReceiptsSettingsSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(readReceiptsSettingsSchema.safeParse({ enabled: 'yes' }).success).toBe(false);
    expect(readReceiptsSettingsSchema.safeParse({}).success).toBe(false);
  });

  it('checks the permission and the input before reaching the database', async () => {
    // Settings are the company's: agents cannot change them.
    await expect(service.updateSettings(ctxOf(['agent']), { enabled: true })).rejects.toMatchObject(
      { code: 'forbidden' },
    );
    await expect(
      service.updateSettings(ctxOf(['owner']), { enabled: 'yes' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // Typing needs a member who can reply, and a conversation id.
    await expect(service.showTyping(ctxOf(['marketer']), CONVERSATION)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.showTyping(ctxOf(['agent']), 'nope')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(service.showTyping(ctxOf(['agent']), CONVERSATION)).rejects.toThrow(
      'the database was reached',
    );
    // A job naming no message of a company does nothing.
    const deps = { db: unreachableDb, keyring: {} as never, graph: {} as never };
    expect(
      await sendReadReceipt(deps, { tenantId: 't' } as TenantScope, 'not-an-id', false),
    ).toEqual({ outcome: 'not_found' });
    expect(
      await sendReadReceipt(deps, { tenantId: null } as unknown as TenantScope, CONVERSATION, true),
    ).toEqual({ outcome: 'not_found' });
  });
});
