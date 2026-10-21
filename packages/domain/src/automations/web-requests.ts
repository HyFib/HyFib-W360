import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock, type Keyring } from '@w360/core';
import {
  and,
  asc,
  eq,
  httpAllowedDomains,
  httpSecrets,
  isUniqueViolation,
  memberships,
  sql,
  users,
  type Database,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { parseInput } from '../validation';
import { SECRET_NAME_RE } from './graph';
import { httpSecretAad } from './http';

/**
 * Settings for the automation HTTP step ("web requests"): the domains a company's automations may
 * call and the secrets their request headers may use. Changing them needs `integrations.manage`
 * and is audited (names and domains only). Secret values are encrypted with the application
 * keyring, bound to their row, and never returned: only the worker decrypts them, when it makes a
 * request. Members who can read automations see the domains and secret names.
 */

export const WEB_REQUEST_LIMITS = {
  domains: 50,
  secrets: 50,
  secretValueLength: 2000,
  /** New secret values need this many characters (ADR-406). */
  secretValueMinLength: 4,
} as const;

const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/\.$/, ''))
  .refine(
    (v) => v.length <= 253 && DOMAIN_RE.test(v),
    'Enter a host name such as api.example.com, or *.example.com for all its subdomains.',
  );

/** A secret as Settings → Web requests saves it (new or replaced). */
export const webRequestSecretSchema = z.object({
  domain: domainSchema,
  name: z
    .string()
    .trim()
    .regex(SECRET_NAME_RE, 'Secret names start with a letter and use a-z, 0-9 and _ (at most 40).'),
  // Saved values that hold a secret the request carried are left out (ADR-406); a value of one to
  // three characters would match ordinary answers ("1" in "price 1.5"), so new values need four.
  // Secrets saved shorter before keep working. Spaces around the value do not count.
  value: z
    .string()
    .min(1, 'Enter the secret value.')
    .refine(
      (v) => v.length === 0 || v.trim().length >= WEB_REQUEST_LIMITS.secretValueMinLength,
      `Secret values need at least ${WEB_REQUEST_LIMITS.secretValueMinLength} characters.`,
    )
    .max(
      WEB_REQUEST_LIMITS.secretValueLength,
      `Secret values are limited to ${WEB_REQUEST_LIMITS.secretValueLength} characters.`,
    )
    .refine((v) => !/[\r\n]/.test(v), 'Secret values are used in headers: no line breaks.'),
});

const idSchema = z.object({ id: z.uuid() });

export interface WebRequestSettings {
  domains: { id: string; domain: string; createdAt: string; createdByName: string | null }[];
  secrets: {
    id: string;
    name: string;
    /** The allowed domain the secret is sent to (and only to). */
    domain: string;
    /** Whether that domain is still allowed (calls fail while it is not). */
    domainAllowed: boolean;
    version: number;
    updatedAt: string;
    updatedByName: string | null;
  }[];
  canManage: boolean;
}

const memberName = sql<string | null>`coalesce(${memberships.displayName}, ${users.name})`;

async function count(
  tx: Tx,
  table: typeof httpAllowedDomains | typeof httpSecrets,
  tenantId: string,
) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.tenantId, tenantId));
  return row?.n ?? 0;
}

export function createWebRequestService(deps: { db: Database; clock: Clock; keyring: Keyring }) {
  const { db, keyring } = deps;

  const lockSettings = (tx: Tx, tenantId: string) =>
    tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}|web_requests`}, 0))`,
    );

  return {
    async settings(ctx: TenantContext): Promise<WebRequestSettings> {
      if (!can(ctx, 'automations.read') && !can(ctx, 'integrations.read')) {
        assertCan(ctx, 'automations.read');
      }
      return db.run(
        ctx.scope,
        async (tx) => {
          const domains = await tx
            .select({
              id: httpAllowedDomains.id,
              domain: httpAllowedDomains.domain,
              createdAt: httpAllowedDomains.createdAt,
              createdByName: memberName,
            })
            .from(httpAllowedDomains)
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, httpAllowedDomains.tenantId),
                eq(memberships.id, httpAllowedDomains.createdByMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .where(eq(httpAllowedDomains.tenantId, ctx.tenant.id))
            .orderBy(asc(httpAllowedDomains.domain));
          const secrets = await tx
            .select({
              id: httpSecrets.id,
              name: httpSecrets.name,
              domain: httpSecrets.domain,
              version: httpSecrets.version,
              updatedAt: httpSecrets.updatedAt,
              updatedByName: memberName,
            })
            .from(httpSecrets)
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, httpSecrets.tenantId),
                eq(memberships.id, httpSecrets.updatedByMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .where(eq(httpSecrets.tenantId, ctx.tenant.id))
            .orderBy(asc(httpSecrets.name));
          const allowed = new Set(domains.map((d) => d.domain));
          return {
            domains: domains.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
            secrets: secrets.map((s) => ({
              ...s,
              domainAllowed: allowed.has(s.domain),
              updatedAt: s.updatedAt.toISOString(),
            })),
            canManage: can(ctx, 'integrations.manage'),
          };
        },
        { accessMode: 'read only' },
      );
    },

    async addDomain(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'integrations.manage');
      const { domain } = parseInput(z.object({ domain: domainSchema }), input);
      try {
        return await db.run(ctx.scope, async (tx) => {
          await lockSettings(tx, ctx.tenant.id);
          if ((await count(tx, httpAllowedDomains, ctx.tenant.id)) >= WEB_REQUEST_LIMITS.domains) {
            throw new AppError(
              'conflict',
              `A company can allow at most ${WEB_REQUEST_LIMITS.domains} domains.`,
            );
          }
          const id = uuidv7();
          await tx.insert(httpAllowedDomains).values({
            id,
            tenantId: ctx.tenant.id,
            domain,
            createdByMembershipId: ctx.membership.id,
          });
          await recordAudit(
            tx,
            ctx,
            {
              action: 'http.domain_added',
              subjectType: 'http_allowed_domain',
              subjectId: id,
              metadata: { domain },
            },
            meta,
          );
          return { id };
        });
      } catch (error) {
        if (isUniqueViolation(error, 'http_allowed_domains_domain_uq')) {
          throw new AppError('conflict', `${domain} is already allowed.`);
        }
        throw error;
      }
    },

    /** Steps that call the domain fail from their next call on (the worker checks the list). */
    async removeDomain(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'integrations.manage');
      const { id } = parseInput(idSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const [row] = await tx
          .delete(httpAllowedDomains)
          .where(and(eq(httpAllowedDomains.tenantId, ctx.tenant.id), eq(httpAllowedDomains.id, id)))
          .returning({ domain: httpAllowedDomains.domain });
        if (!row) throw notFound('Domain');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'http.domain_removed',
            subjectType: 'http_allowed_domain',
            subjectId: id,
            metadata: { domain: row.domain },
          },
          meta,
        );
        return { ok: true as const };
      });
    },

    /**
     * Creates a secret, or replaces the value (and domain) of the one with that name. A secret is
     * saved for one of the allowed domains, and the worker only ever sends it there.
     */
    async saveSecret(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'integrations.manage');
      const data = parseInput(webRequestSecretSchema, input);
      return db.run(ctx.scope, async (tx) => {
        await lockSettings(tx, ctx.tenant.id);
        const [allowed] = await tx
          .select({ id: httpAllowedDomains.id })
          .from(httpAllowedDomains)
          .where(
            and(
              eq(httpAllowedDomains.tenantId, ctx.tenant.id),
              eq(httpAllowedDomains.domain, data.domain),
            ),
          );
        if (!allowed) {
          const message = 'Choose one of the allowed domains for the secret.';
          throw new AppError('validation_failed', message, {
            issues: [{ path: 'domain', message }],
          });
        }
        const [existing] = await tx
          .select({ id: httpSecrets.id, version: httpSecrets.version })
          .from(httpSecrets)
          .where(and(eq(httpSecrets.tenantId, ctx.tenant.id), eq(httpSecrets.name, data.name)))
          .for('update');
        if (existing) {
          await tx
            .update(httpSecrets)
            .set({
              domain: data.domain,
              valueCiphertext: keyring.encrypt(
                data.value,
                httpSecretAad(ctx.tenant.id, existing.id),
              ),
              version: existing.version + 1,
              updatedByMembershipId: ctx.membership.id,
            })
            .where(and(eq(httpSecrets.tenantId, ctx.tenant.id), eq(httpSecrets.id, existing.id)));
          await recordAudit(
            tx,
            ctx,
            {
              action: 'http.secret_updated',
              subjectType: 'http_secret',
              subjectId: existing.id,
              metadata: { name: data.name, domain: data.domain },
            },
            meta,
          );
          return { id: existing.id, created: false };
        }
        if ((await count(tx, httpSecrets, ctx.tenant.id)) >= WEB_REQUEST_LIMITS.secrets) {
          throw new AppError(
            'conflict',
            `A company can keep at most ${WEB_REQUEST_LIMITS.secrets} secrets.`,
          );
        }
        const id = uuidv7();
        await tx.insert(httpSecrets).values({
          id,
          tenantId: ctx.tenant.id,
          name: data.name,
          domain: data.domain,
          valueCiphertext: keyring.encrypt(data.value, httpSecretAad(ctx.tenant.id, id)),
          createdByMembershipId: ctx.membership.id,
          updatedByMembershipId: ctx.membership.id,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'http.secret_created',
            subjectType: 'http_secret',
            subjectId: id,
            metadata: { name: data.name, domain: data.domain },
          },
          meta,
        );
        return { id, created: true };
      });
    },

    /** Steps that use the secret fail from their next call on (the worker needs the value). */
    async deleteSecret(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'integrations.manage');
      const { id } = parseInput(idSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const [row] = await tx
          .delete(httpSecrets)
          .where(and(eq(httpSecrets.tenantId, ctx.tenant.id), eq(httpSecrets.id, id)))
          .returning({ name: httpSecrets.name });
        if (!row) throw notFound('Secret');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'http.secret_deleted',
            subjectType: 'http_secret',
            subjectId: id,
            metadata: { name: row.name },
          },
          meta,
        );
        return { ok: true as const };
      });
    },
  };
}

export type WebRequestService = ReturnType<typeof createWebRequestService>;
