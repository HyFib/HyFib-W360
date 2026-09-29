import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound, sha256Hex, uuidv7, type Clock } from '@w360/core';
import {
  and,
  apiKeys,
  desc,
  eq,
  gt,
  isNull,
  or,
  sql,
  users,
  type ApiScope,
  type Database,
  type Tx,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import { TOKEN_ALPHABET, randomToken } from '../growth/model';
import { assertApiInPlan, loadEntitlements } from '../plans/entitlements';
import { parseInput } from '../validation';
import {
  API_KEY_EXPIRY_DAYS,
  API_KEY_LIMITS,
  API_SCOPE_INFO,
  API_SCOPE_KEYS,
  API_TOKEN_RE,
  apiKeyState,
} from './model';

const DAY_MS = 86_400_000;

/** A new token: its public prefix, the token itself (shown once) and the hash that is stored. */
export function generateApiToken(): { keyPrefix: string; token: string; tokenHash: string } {
  const keyPrefix = `w360_${randomToken(TOKEN_ALPHABET, 12)}`;
  const token = `${keyPrefix}_${randomBytes(32).toString('base64url')}`;
  return { keyPrefix, token, tokenHash: sha256Hex(token) };
}

/**
 * The token in an `Authorization: Bearer …` header, when it has the token's shape (the scheme name
 * is case-insensitive, RFC 7235).
 */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer ([^\s]+)$/i.exec(header.trim());
  const token = m?.[1];
  return token && API_TOKEN_RE.test(token) ? token : null;
}

export const hashApiToken = (token: string) => sha256Hex(token);

const scopesSchema = z
  .array(z.enum(API_SCOPE_KEYS, { error: 'Choose scopes from the list' }))
  .min(1, 'Choose at least one scope')
  .transform((chosen) => API_SCOPE_KEYS.filter((s) => chosen.includes(s)));

const createSchema = z.object({
  name: z
    .string({ error: 'Name the key' })
    .trim()
    .min(1, 'Name the key')
    .max(API_KEY_LIMITS.nameLength, 'Keep the name under 80 characters'),
  scopes: scopesSchema,
  expiresInDays: z.coerce
    .number()
    .refine((d) => (API_KEY_EXPIRY_DAYS as readonly number[]).includes(d), 'Choose an expiry'),
});

const keyIdSchema = z.object({ keyId: z.uuid() });

const rotateSchema = keyIdSchema.extend({
  overlapHours: z.coerce
    .number()
    .int()
    .min(0)
    .max(API_KEY_LIMITS.rotationOverlapHours, 'The old key can stay valid for at most 72 hours'),
});

export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: ApiScope[];
  createdAt: Date;
  createdBy: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  replacedByKeyId: string | null;
  /** When owners and administrators were emailed that the key expires soon (ADR-067). */
  expiryRemindedAt: Date | null;
  state: 'active' | 'revoked' | 'expired';
}

/** Takes the company's key lock, so two creations cannot pass the limit of active keys together. */
async function lockKeys(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`api-keys:${tenantId}`}, 0))`,
  );
}

async function activeKeyCount(tx: Tx, tenantId: string, now: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.tenantId, tenantId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
      ),
    );
  return row?.n ?? 0;
}

/** Nobody grants a key more than they hold. */
function assertMayGrant(ctx: TenantContext, scopes: readonly ApiScope[]): void {
  for (const scope of scopes) {
    if (!ctx.permissions.has(API_SCOPE_INFO[scope].permission)) {
      throw new AppError(
        'forbidden',
        `You cannot grant "${API_SCOPE_INFO[scope].label}": it needs a permission you do not have.`,
      );
    }
  }
}

/**
 * Company API keys (ADR-052), managed by members with `developer.manage`. Keys belong to the
 * company; each creation, rotation and revocation is in the company's audit log (without tokens).
 */
export function createApiKeysService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;

  async function insertKey(
    tx: Tx,
    ctx: TenantContext,
    input: { name: string; scopes: ApiScope[]; expiresAt: Date | null },
  ) {
    const id = uuidv7();
    const { keyPrefix, token, tokenHash } = generateApiToken();
    await tx.insert(apiKeys).values({
      id,
      tenantId: ctx.tenant.id,
      name: input.name,
      keyPrefix,
      tokenHash,
      scopes: input.scopes,
      createdByUserId: ctx.user.id,
      expiresAt: input.expiresAt,
    });
    return { id, keyPrefix, token };
  }

  return {
    async list(ctx: TenantContext): Promise<ApiKeyView[]> {
      assertCan(ctx, 'developer.manage');
      const now = clock.now();
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              keyPrefix: apiKeys.keyPrefix,
              scopes: apiKeys.scopes,
              createdAt: apiKeys.createdAt,
              createdBy: users.name,
              expiresAt: apiKeys.expiresAt,
              lastUsedAt: apiKeys.lastUsedAt,
              revokedAt: apiKeys.revokedAt,
              replacedByKeyId: apiKeys.replacedByKeyId,
              expiryRemindedAt: apiKeys.expiryRemindedAt,
            })
            .from(apiKeys)
            .leftJoin(users, eq(users.id, apiKeys.createdByUserId))
            .where(eq(apiKeys.tenantId, ctx.tenant.id))
            .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
            .limit(200);
          return rows.map((r) => ({ ...r, state: apiKeyState(r, now) }));
        },
        { accessMode: 'read only' },
      );
    },

    /** A new key, unless the plan leaves the API out. The token is returned once, never stored. */
    async create(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const now = clock.now();
      assertRecentSignIn(ctx, now);
      const data = parseInput(createSchema, input);
      assertMayGrant(ctx, data.scopes);
      const expiresAt =
        data.expiresInDays === 0 ? null : new Date(now.getTime() + data.expiresInDays * DAY_MS);
      return db.run(ctx.scope, async (tx) => {
        await lockKeys(tx, ctx.tenant.id);
        assertApiInPlan(await loadEntitlements(tx, ctx.tenant.id));
        if ((await activeKeyCount(tx, ctx.tenant.id, now)) >= API_KEY_LIMITS.activeKeys) {
          throw new AppError(
            'precondition_failed',
            `A company can have ${API_KEY_LIMITS.activeKeys} active API keys. Revoke one first.`,
          );
        }
        const created = await insertKey(tx, ctx, {
          name: data.name,
          scopes: data.scopes,
          expiresAt,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'api_key.created',
            subjectType: 'api_key',
            subjectId: created.id,
            metadata: {
              name: data.name,
              keyPrefix: created.keyPrefix,
              scopes: data.scopes,
              expiresAt: expiresAt?.toISOString() ?? null,
            },
          },
          meta,
        );
        return created;
      });
    },

    /**
     * A new key with the same name, scopes and expiry period; the old key stays valid for the
     * overlap (0 to 72 hours) so integrations can switch, then stops working.
     */
    async rotate(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const now = clock.now();
      assertRecentSignIn(ctx, now);
      const data = parseInput(rotateSchema, input);
      return db.run(ctx.scope, async (tx) => {
        await lockKeys(tx, ctx.tenant.id);
        assertApiInPlan(await loadEntitlements(tx, ctx.tenant.id));
        // Explicit columns: the runtime role cannot read the token hash.
        const [old] = await tx
          .select({
            id: apiKeys.id,
            name: apiKeys.name,
            scopes: apiKeys.scopes,
            createdAt: apiKeys.createdAt,
            expiresAt: apiKeys.expiresAt,
            revokedAt: apiKeys.revokedAt,
            replacedByKeyId: apiKeys.replacedByKeyId,
          })
          .from(apiKeys)
          .where(and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, data.keyId)))
          .for('update');
        if (!old) throw notFound('API key');
        if (apiKeyState(old, now) !== 'active' || old.replacedByKeyId)
          throw new AppError(
            'conflict',
            'Only an active key that was not rotated yet can be rotated.',
          );
        assertMayGrant(ctx, old.scopes);
        const lifetime = old.expiresAt ? old.expiresAt.getTime() - old.createdAt.getTime() : null;
        const created = await insertKey(tx, ctx, {
          name: old.name,
          scopes: old.scopes,
          expiresAt: lifetime === null ? null : new Date(now.getTime() + lifetime),
        });
        const overlapEnds = new Date(now.getTime() + data.overlapHours * 3_600_000);
        await tx
          .update(apiKeys)
          .set(
            data.overlapHours === 0
              ? { replacedByKeyId: created.id, revokedAt: now, revokedByUserId: ctx.user.id }
              : {
                  replacedByKeyId: created.id,
                  expiresAt:
                    old.expiresAt && old.expiresAt < overlapEnds ? old.expiresAt : overlapEnds,
                },
          )
          .where(and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, old.id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'api_key.rotated',
            subjectType: 'api_key',
            subjectId: old.id,
            metadata: {
              newKeyId: created.id,
              newKeyPrefix: created.keyPrefix,
              overlapHours: data.overlapHours,
            },
          },
          meta,
        );
        return created;
      });
    },

    /** Stops the key at once. */
    async revoke(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const { keyId } = parseInput(keyIdSchema, input);
      const now = clock.now();
      await db.run(ctx.scope, async (tx) => {
        const [key] = await tx
          .select({ revokedAt: apiKeys.revokedAt, keyPrefix: apiKeys.keyPrefix })
          .from(apiKeys)
          .where(and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, keyId)))
          .for('update');
        if (!key) throw notFound('API key');
        if (key.revokedAt) return;
        await tx
          .update(apiKeys)
          .set({ revokedAt: now, revokedByUserId: ctx.user.id })
          .where(and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, keyId)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'api_key.revoked',
            subjectType: 'api_key',
            subjectId: keyId,
            metadata: { keyPrefix: key.keyPrefix },
          },
          meta,
        );
      });
    },
  };
}

export type ApiKeysService = ReturnType<typeof createApiKeysService>;
