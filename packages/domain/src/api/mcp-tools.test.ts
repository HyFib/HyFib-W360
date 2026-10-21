import { describe, expect, it, vi } from 'vitest';
import { AppError, sha256Hex } from '@w360/core';
import type { ApiScope, Database, TenantScope } from '@w360/db';
import type { OutboundDeps } from '../messaging/outbound';
import type { ApiContext } from './context';
import { generateApiToken } from './keys';
import { MCP_TOOLS, MCP_UNTRUSTED_NOTE, type McpToolName } from './mcp-model';
import {
  isMcpToolName,
  mcpCanonicalJson,
  mcpToolDefinitions,
  mcpToolIdempotency,
  runMcpTool,
} from './mcp-tools';

const { token: TOKEN } = generateApiToken();
const CONTACT = '0190a6d2-7e4b-7c3a-9f00-000000000001';

function ctxWith(
  scopes: ApiScope[],
  options: { planScopes?: ApiScope[]; status?: 'active' | 'suspended' } = {},
): ApiContext {
  return {
    tenant: { id: '0190a6d2-7e4b-7c3a-9f00-0000000000aa', status: options.status ?? 'active' },
    key: { id: '0190a6d2-7e4b-7c3a-9f00-0000000000bb', scopes: new Set(scopes) },
    scope: {} as TenantScope,
    requestId: 'req-1',
    planScopes: options.planScopes ? new Set(options.planScopes) : null,
  };
}

/** Deps whose database answers every query with `outcome` (a thrown error), counting the calls. */
function depsFailingWith(outcome: unknown) {
  const run = vi.fn(async () => {
    throw outcome;
  });
  const deps = {
    db: { run } as unknown as Database,
    jobs: {} as OutboundDeps['jobs'],
    signer: {} as OutboundDeps['signer'],
    clock: { now: () => new Date('2026-10-21T10:00:00Z') },
  } as OutboundDeps;
  return { deps, run };
}

const errorOf = (outcome: Awaited<ReturnType<typeof runMcpTool>>) => {
  if (outcome.ok) throw new Error('expected an error');
  return outcome;
};

describe('MCP tool definitions (ADR-416)', () => {
  const definitions = mcpToolDefinitions();

  it('lists the nine tools in a fixed order, each named as the specification advises', () => {
    expect(definitions.map((d) => d.name)).toEqual([
      'search_contacts',
      'get_contact',
      'list_conversations',
      'list_conversation_messages',
      'list_templates',
      'list_campaigns',
      'get_campaign',
      'send_text_reply',
      'send_template',
    ]);
    expect(mcpToolDefinitions()).toBe(definitions);
    for (const d of definitions) expect(d.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
  });

  it('gives every tool an object input schema without $schema, closed to unknown arguments', () => {
    for (const d of definitions) {
      expect(d.inputSchema.type).toBe('object');
      expect(d.inputSchema).not.toHaveProperty('$schema');
      expect(d.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('derives the input schemas from the REST API’s zod schemas', () => {
    const byName = new Map(definitions.map((d) => [d.name, d]));
    const props = (name: string) =>
      Object.keys(byName.get(name)?.inputSchema.properties as Record<string, unknown>);
    expect(props('search_contacts')).toEqual([
      'limit',
      'cursor',
      'phone',
      'email',
      'name',
      'tag',
      'fields',
    ]);
    expect(props('send_text_reply').sort()).toEqual(
      ['from', 'idempotencyKey', 'previewUrl', 'replyTo', 'text', 'to'].sort(),
    );
    expect(props('send_template').sort()).toEqual(
      ['from', 'headerMedia', 'idempotencyKey', 'templateId', 'to', 'variables'].sort(),
    );
    expect(byName.get('list_templates')?.inputSchema.properties).toEqual({});
  });

  it('makes the idempotency key required for both send tools, with the header’s rule', () => {
    for (const name of ['send_text_reply', 'send_template']) {
      const schema = definitions.find((d) => d.name === name)?.inputSchema;
      expect(schema?.required).toContain('idempotencyKey');
      const key = (schema?.properties as Record<string, { pattern?: string }>).idempotencyKey;
      expect(key?.pattern).toBe('^[\\x21-\\x7e]{1,255}$');
    }
  });

  it('marks customer-written content as untrusted on every tool that returns it', () => {
    for (const name of [
      'search_contacts',
      'get_contact',
      'list_conversations',
      'list_conversation_messages',
    ]) {
      expect(definitions.find((d) => d.name === name)?.description).toContain(MCP_UNTRUSTED_NOTE);
    }
  });

  it('names the scopes each tool needs, and hints which tools only read', () => {
    for (const info of MCP_TOOLS) {
      const d = definitions.find((x) => x.name === info.name);
      for (const scope of info.scopes) expect(d?.description).toContain(scope);
      expect(d?.annotations.readOnlyHint).toBe(!info.sends);
    }
    expect(MCP_TOOLS.find((t) => t.name === 'send_template')?.scopes).toEqual([
      'messages.send',
      'messages.send_marketing',
    ]);
    expect(MCP_TOOLS.find((t) => t.name === 'send_text_reply')?.scopes).toEqual(['messages.reply']);
  });

  it('knows its tools by name only', () => {
    expect(isMcpToolName('get_contact')).toBe(true);
    expect(isMcpToolName('delete_everything')).toBe(false);
  });
});

describe('MCP tool calls (ADR-416)', () => {
  it('refuses a key without the tool’s scope before touching data, with the REST message', async () => {
    const { deps, run } = depsFailingWith(new Error('must not run'));
    const outcome = errorOf(
      await runMcpTool(deps, ctxWith(['templates.read']), 'get_contact', { contactId: CONTACT }),
    );
    expect(outcome).toMatchObject({
      internal: false,
      invalidArguments: false,
      status: 403,
      body: {
        error: {
          code: 'forbidden',
          message: 'This API key does not have the contacts.read scope.',
        },
        requestId: 'req-1',
      },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('checks the scope before the arguments, as the REST call does', async () => {
    const { deps, run } = depsFailingWith(new Error('must not run'));
    const outcome = errorOf(
      await runMcpTool(deps, ctxWith(['templates.read']), 'get_campaign', { campaignId: 'nope' }),
    );
    expect(outcome).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a scope the plan leaves out, as the REST API does', async () => {
    const { deps, run } = depsFailingWith(new Error('must not run'));
    const outcome = errorOf(
      await runMcpTool(
        deps,
        ctxWith(['contacts.read', 'templates.read'], { planScopes: ['templates.read'] }),
        'search_contacts',
        {},
      ),
    );
    expect(outcome).toMatchObject({ status: 403, body: { error: { reason: 'not_in_plan' } } });
    expect(run).not.toHaveBeenCalled();
  });

  it('lets either sending scope reach the template send, and neither refuses it', async () => {
    const args = {
      idempotencyKey: 'k-1',
      to: '+919876543210',
      templateId: '0190a6d2-7e4b-7c3a-9f00-000000000002',
    };
    const refusedBy = depsFailingWith(new Error('must not run'));
    const refused = errorOf(
      await runMcpTool(refusedBy.deps, ctxWith(['messages.reply']), 'send_template', args),
    );
    expect(refused.status).toBe(403);
    expect(refusedBy.run).not.toHaveBeenCalled();
    for (const scope of ['messages.send', 'messages.send_marketing'] as const) {
      const { deps, run } = depsFailingWith(new AppError('not_found', 'Template not found.'));
      const outcome = errorOf(await runMcpTool(deps, ctxWith([scope]), 'send_template', args));
      expect(outcome).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses a send without an idempotency key, or with one the header rule refuses', async () => {
    for (const idempotencyKey of [undefined, '', 'has space', 'x'.repeat(256)]) {
      const { deps, run } = depsFailingWith(new Error('must not run'));
      const outcome = errorOf(
        await runMcpTool(deps, ctxWith(['messages.reply']), 'send_text_reply', {
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          to: '+919876543210',
          text: 'Hello',
        }),
      );
      expect(outcome.status).toBe(422);
      expect(outcome.body.error.issues?.[0]?.path).toBe('idempotencyKey');
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('refuses unknown arguments and invalid ids as the REST schemas do, before any query', async () => {
    const { deps, run } = depsFailingWith(new Error('must not run'));
    const unknown = errorOf(
      await runMcpTool(deps, ctxWith(['contacts.read']), 'search_contacts', { tenantId: 'x' }),
    );
    expect(unknown).toMatchObject({
      status: 422,
      invalidArguments: true,
      body: { error: { code: 'validation_failed' } },
    });
    const badId = errorOf(
      await runMcpTool(deps, ctxWith(['campaigns.read']), 'get_campaign', { campaignId: 'nope' }),
    );
    expect(badId.body.error.issues?.[0]).toMatchObject({
      path: 'campaignId',
      message: 'Give the id of the campaign',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses text with the NUL character as invalid arguments naming its path', async () => {
    const { deps, run } = depsFailingWith(new Error('must not run'));
    const outcome = errorOf(
      await runMcpTool(deps, ctxWith(['messages.reply']), 'send_text_reply', {
        idempotencyKey: 'k-nul',
        to: '+919876543210',
        text: 'Hello\u0000there',
      }),
    );
    expect(outcome).toMatchObject({ status: 422, invalidArguments: true });
    expect(outcome.body.error.issues?.[0]?.path).toBe('text');
    expect(run).not.toHaveBeenCalled();
  });

  it('maps a service refusal to the REST error body, with its reason', async () => {
    const { deps } = depsFailingWith(
      new AppError(
        'precondition_failed',
        'This number has not written to this WhatsApp number in the last 24 hours, so only approved templates can be sent to it.',
        { details: { apiReason: 'window_closed' } },
      ),
    );
    const outcome = errorOf(
      await runMcpTool(deps, ctxWith(['messages.reply']), 'send_text_reply', {
        idempotencyKey: 'k-2',
        to: '+919876543210',
        text: 'Hello',
      }),
    );
    expect(outcome).toEqual({
      ok: false,
      internal: false,
      invalidArguments: false,
      status: 412,
      body: {
        error: {
          code: 'precondition_failed',
          message:
            'This number has not written to this WhatsApp number in the last 24 hours, so only approved templates can be sent to it.',
          reason: 'window_closed',
        },
        requestId: 'req-1',
      },
    });
  });

  it('keeps an unexpected error to the generic message, and the cause for the log only', async () => {
    const cause = new Error(`connection to db failed for ${TOKEN}`);
    const { deps } = depsFailingWith(cause);
    const outcome = errorOf(
      await runMcpTool(deps, ctxWith(['contacts.read']), 'get_contact', { contactId: CONTACT }),
    );
    expect(outcome).toMatchObject({
      internal: true,
      status: 500,
      body: { error: { code: 'internal', message: 'Something went wrong. Retry later.' } },
    });
    expect(JSON.stringify(outcome.body)).not.toContain(TOKEN);
    if (outcome.internal) expect(outcome.cause).toBe(cause);
  });

  it('refuses sends while the company is suspended, reading stays', async () => {
    const send = depsFailingWith(new Error('must not run'));
    const refused = errorOf(
      await runMcpTool(
        send.deps,
        ctxWith(['messages.reply'], { status: 'suspended' }),
        'send_text_reply',
        {
          idempotencyKey: 'k-3',
          to: '+919876543210',
          text: 'Hello',
        },
      ),
    );
    expect(refused).toMatchObject({ status: 423, body: { error: { code: 'tenant_suspended' } } });
    expect(send.run).not.toHaveBeenCalled();
    const readDeps = depsFailingWith(new AppError('not_found', 'Contact not found.'));
    const read = errorOf(
      await runMcpTool(
        readDeps.deps,
        ctxWith(['contacts.read'], { status: 'suspended' }),
        'get_contact',
        {
          contactId: CONTACT,
        },
      ),
    );
    expect(read.status).toBe(404);
    expect(readDeps.run).toHaveBeenCalledTimes(1);
  });
});

describe('MCP send idempotency (ADR-416)', () => {
  it('hashes the same arguments alike whatever their order, and other arguments apart', () => {
    const a = mcpToolIdempotency('send_text_reply', 'k', { type: 'text', to: '+91', text: 'Hi' });
    const b = mcpToolIdempotency('send_text_reply', 'k', { text: 'Hi', to: '+91', type: 'text' });
    const c = mcpToolIdempotency('send_text_reply', 'k', { type: 'text', to: '+91', text: 'Ho' });
    expect(a).toEqual(b);
    expect(a.requestHash).not.toBe(c.requestHash);
    expect(a.key).toBe('k');
  });

  it('never hashes like a REST request, so a key is not replayed across the two', () => {
    const body = { type: 'text', to: '+91', text: 'Hi' };
    const rest = sha256Hex(`POST /api/v1/messages\n${JSON.stringify(body)}`);
    const tool: McpToolName = 'send_text_reply';
    expect(mcpToolIdempotency(tool, 'k', body).requestHash).not.toBe(rest);
    expect(mcpToolIdempotency('send_template', 'k', body).requestHash).not.toBe(
      mcpToolIdempotency(tool, 'k', body).requestHash,
    );
  });

  it('writes canonical JSON with sorted keys at every depth', () => {
    expect(mcpCanonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null }, u: undefined })).toBe(
      '{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });
});
