import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { AppError, notFound, sha256Hex, uuidv7, type Clock } from '@w360/core';
import {
  and,
  apiKeyUsage,
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
import { assertApiInPlan, assertScopesInPlan, loadEntitlements } from '../plans/entitlements';
import { usagePeriod } from '../plans/model';
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

/** Why an entry is not an IP address or network (ADR-076), or null when its shape is right. */
export function networkEntryProblem(entry: string): string | null {
  const [address = '', prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (!family || rest.length > 0 || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) {
    return `“${entry}” is not an IP address or network, such as 203.0.113.7 or 203.0.113.0/24.`;
  }
  const mapped = /^::ffff:(.+)$/i.exec(address)?.[1];
  if (mapped && isIP(mapped) === 4) return `Write “${entry}” as the IPv4 address ${mapped}.`;
  if (prefix !== undefined) {
    const bits = Number(prefix);
    if (bits > (family === 4 ? 32 : 128)) {
      return `“${entry}” has a prefix length longer than the address.`;
    }
    if (bits === 0) return `“${entry}” would accept every address: leave the list empty instead.`;
  }
  return null;
}

/**
 * The networks a key accepts requests from (ADR-076), as typed in settings: IPv4 or IPv6 addresses
 * or CIDR ranges, one per line or separated by commas or spaces. An empty list accepts any address
 * (null). PostgreSQL checks each entry as a network when it is saved (`canonicalNetworks`).
 */
export const allowedNetworksSchema = z
  .string()
  .max(API_KEY_LIMITS.allowedNetworksText, 'Keep the list of addresses under 2,000 characters')
  .optional()
  .transform((text, ctx): string[] | null => {
    const entries = [...new Set((text ?? '').split(/[\s,]+/).filter(Boolean))];
    for (const entry of entries) {
      const problem = networkEntryProblem(entry);
      if (problem) {
        ctx.addIssue({ code: 'custom', message: problem });
        return z.NEVER;
      }
    }
    if (entries.length > API_KEY_LIMITS.allowedNetworks) {
      ctx.addIssue({
        code: 'custom',
        message: `List at most ${API_KEY_LIMITS.allowedNetworks} addresses or networks.`,
      });
      return z.NEVER;
    }
    return entries.length > 0 ? entries : null;
  });

const MONTHLY_LIMIT_MESSAGE = `A key's monthly limit is a whole number of requests from 1 to ${API_KEY_LIMITS.monthlyRequests.toLocaleString('en-US')}, or empty for none.`;

/**
 * A key's own monthly request limit (ADR-097): empty for none. Digits only, with commas or spaces
 * between them if typed so.
 */
const monthlyLimitSchema = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') return v;
    const digits = v.replace(/[\s,]/g, '');
    if (digits === '') return null;
    return /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
  },
  z
    .number({ error: MONTHLY_LIMIT_MESSAGE })
    .int(MONTHLY_LIMIT_MESSAGE)
    .min(1, MONTHLY_LIMIT_MESSAGE)
    .max(API_KEY_LIMITS.monthlyRequests, MONTHLY_LIMIT_MESSAGE)
    .nullable(),
);

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
  allowedNetworks: allowedNetworksSchema,
  monthlyRequestLimit: monthlyLimitSchema,
});

const keyIdSchema = z.object({ keyId: z.uuid() });

const networksSchema = keyIdSchema.extend({ allowedNetworks: allowedNetworksSchema });

const monthlyLimitInputSchema = keyIdSchema.extend({ monthlyRequestLimit: monthlyLimitSchema });

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
  /** The networks the key accepts requests from (ADR-076); null accepts any address. */
  allowedNetworks: string[] | null;
  /** The key's own monthly request limit (ADR-097); null when only the plan limits it. */
  monthlyRequestLimit: number | null;
  /** Requests the key made in the company's current usage period (ADR-097). */
  requestsThisPeriod: number;
  state: 'active' | 'revoked' | 'expired';
}

/**
 * Each network as PostgreSQL keeps it (a single address gains /32 or /128), in the order given and
 * without repeats. An entry that is an address with bits set after its prefix length is refused
 * with the network it probably means, rather than widened or narrowed silently.
 */
async function canonicalNetworks(tx: Tx, entries: string[] | null): Promise<string[] | null> {
  if (!entries) return null;
  const res = await tx.execute<{ entry: string; network: string | null; masked: string | null }>(
    sql`select e.entry,
               case when pg_input_is_valid(e.entry, 'cidr') then e.entry::cidr::text end as network,
               case when pg_input_is_valid(e.entry, 'inet') then network(e.entry::inet)::text end as masked
          from unnest(${sql.param(entries)}::text[]) with ordinality as e(entry, n)
         order by e.n`,
  );
  const networks: string[] = [];
  for (const row of res.rows) {
    if (!row.network) {
      const message = row.masked
        ? `“${row.entry}” has address bits after its prefix length: did you mean ${row.masked}?`
        : `“${row.entry}” is not an IP address or network, such as 203.0.113.7 or 203.0.113.0/24.`;
      throw new AppError('validation_failed', message, {
        issues: [{ path: 'allowedNetworks', message }],
      });
    }
    if (!networks.includes(row.network)) networks.push(row.network);
  }
  return networks;
}

const sameNetworks = (a: string[] | null, b: string[] | null) =>
  (a ?? []).join(',') === (b ?? []).join(',');

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
    input: {
      name: string;
      scopes: ApiScope[];
      expiresAt: Date | null;
      allowedNetworks: string[] | null;
      monthlyRequestLimit: number | null;
    },
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
      allowedNetworks: input.allowedNetworks,
      monthlyRequestLimit: input.monthlyRequestLimit,
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
          // Each key's requests are counted in the company's usage period (ADR-097).
          const { start } = usagePeriod(
            (await loadEntitlements(tx, ctx.tenant.id)).usageAnchor,
            now,
          );
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
              allowedNetworks: apiKeys.allowedNetworks,
              monthlyRequestLimit: apiKeys.monthlyRequestLimit,
              requestsThisPeriod: sql<number>`coalesce(${apiKeyUsage.used}, 0)::int`,
            })
            .from(apiKeys)
            .leftJoin(users, eq(users.id, apiKeys.createdByUserId))
            .leftJoin(
              apiKeyUsage,
              and(
                eq(apiKeyUsage.tenantId, apiKeys.tenantId),
                eq(apiKeyUsage.apiKeyId, apiKeys.id),
                eq(apiKeyUsage.periodStart, start),
              ),
            )
            .where(eq(apiKeys.tenantId, ctx.tenant.id))
            .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
            .limit(200);
          return rows.map((r) => ({ ...r, state: apiKeyState(r, now) }));
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * A new key, unless the plan leaves the API out or any of its scopes (ADR-092). The token is
     * returned once, never stored.
     */
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
        const entitlements = await loadEntitlements(tx, ctx.tenant.id);
        assertApiInPlan(entitlements);
        assertScopesInPlan(entitlements, data.scopes);
        if ((await activeKeyCount(tx, ctx.tenant.id, now)) >= API_KEY_LIMITS.activeKeys) {
          throw new AppError(
            'precondition_failed',
            `A company can have ${API_KEY_LIMITS.activeKeys} active API keys. Revoke one first.`,
          );
        }
        const allowedNetworks = await canonicalNetworks(tx, data.allowedNetworks);
        const created = await insertKey(tx, ctx, {
          name: data.name,
          scopes: data.scopes,
          expiresAt,
          allowedNetworks,
          monthlyRequestLimit: data.monthlyRequestLimit,
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
              allowedNetworks,
              monthlyRequestLimit: data.monthlyRequestLimit,
            },
          },
          meta,
        );
        return created;
      });
    },

    /**
     * A new key with the same name, scopes, expiry period, addresses and monthly limit; the old key
     * stays valid for the overlap (0 to 72 hours) so integrations can switch, then stops working.
     * Scopes the plan leaves out are kept: requests are refused them while it does (ADR-092). The
     * new key's requests are counted from zero (ADR-097).
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
            allowedNetworks: apiKeys.allowedNetworks,
            monthlyRequestLimit: apiKeys.monthlyRequestLimit,
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
          allowedNetworks: old.allowedNetworks,
          monthlyRequestLimit: old.monthlyRequestLimit,
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

    /**
     * Changes the networks an active key accepts requests from (ADR-076); an empty list accepts
     * any address. The change is audited with the lists before and after.
     */
    async setAllowedNetworks(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const now = clock.now();
      assertRecentSignIn(ctx, now);
      const data = parseInput(networksSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const [key] = await tx
          .select({
            keyPrefix: apiKeys.keyPrefix,
            expiresAt: apiKeys.expiresAt,
            revokedAt: apiKeys.revokedAt,
            allowedNetworks: apiKeys.allowedNetworks,
          })
          .from(apiKeys)
          .where(and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, data.keyId)))
          .for('update');
        if (!key) throw notFound('API key');
        if (apiKeyState(key, now) !== 'active') {
          throw new AppError('conflict', 'Only the addresses of an active key can be changed.');
        }
        const allowedNetworks = await canonicalNetworks(tx, data.allowedNetworks);
        if (sameNetworks(key.allowedNetworks, allowedNetworks)) return { allowedNetworks };
        await tx
          .update(apiKeys)
          .set({ allowedNetworks })
          .where(and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, data.keyId)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'api_key.networks_changed',
            subjectType: 'api_key',
            subjectId: data.keyId,
            metadata: { keyPrefix: key.keyPrefix, from: key.allowedNetworks, to: allowedNetworks },
          },
          meta,
        );
        return { allowedNetworks };
      });
    },

    /**
     * Changes an active key's own monthly request limit (ADR-097); empty removes it, leaving only
     * the plan's. It applies from the key's next request, to the requests already counted this
     * period. The change is audited with the limits before and after.
     */
    async setMonthlyLimit(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'developer.manage');
      const now = clock.now();
      assertRecentSignIn(ctx, now);
      const data = parseInput(monthlyLimitInputSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const [key] = await tx
          .select({
            keyPrefix: apiKeys.keyPrefix,
            expiresAt: apiKeys.expiresAt,
            revokedAt: apiKeys.revokedAt,
            monthlyRequestLimit: apiKeys.monthlyRequestLimit,
          })
          .from(apiKeys)
          .where(and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, data.keyId)))
          .for('update');
        if (!key) throw notFound('API key');
        if (apiKeyState(key, now) !== 'active') {
          throw new AppError('conflict', 'Only the limit of an active key can be changed.');
        }
        const monthlyRequestLimit = data.monthlyRequestLimit;
        if (key.monthlyRequestLimit === monthlyRequestLimit) return { monthlyRequestLimit };
        await tx
          .update(apiKeys)
          .set({ monthlyRequestLimit })
          .where(and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, data.keyId)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'api_key.limit_changed',
            subjectType: 'api_key',
            subjectId: data.keyId,
            metadata: {
              keyPrefix: key.keyPrefix,
              from: key.monthlyRequestLimit,
              to: monthlyRequestLimit,
            },
          },
          meta,
        );
        return { monthlyRequestLimit };
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
