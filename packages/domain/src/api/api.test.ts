import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppError, sha256Hex } from '@w360/core';
import { API_SCOPES } from '@w360/db';
import { PERMISSIONS } from '../authz/permissions';
import { apiErrorResponse, apiRequestError } from './errors';
import { bearerToken, generateApiToken } from './keys';
import {
  API_SCOPE_INFO,
  API_SCOPE_KEYS,
  API_TOKEN_RE,
  IDEMPOTENCY_KEY_RE,
  apiKeyState,
} from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';

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
    expect(writes).toEqual(['contacts.write', 'messages.send', 'messages.send_marketing']);
  });

  it('need the permission a member needs for the same work', () => {
    expect(API_SCOPE_INFO['messages.send'].permission).toBe('inbox.reply');
    expect(API_SCOPE_INFO['messages.send_marketing'].permission).toBe('campaigns.send');
    expect(API_SCOPE_INFO['contacts.write'].permission).toBe('contacts.write');
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
    expect(JSON.stringify(doc.components)).toContain('not_in_plan or quota_exceeded');
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
    expect(schemas.SendTemplate?.additionalProperties).toBe(false);
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
