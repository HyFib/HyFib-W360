import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  channelAccounts,
  chatLinkClicks,
  chatLinks,
  chatWidgets,
  conversationSources,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  isUniqueViolation,
  sql,
  systemScope,
  WIDGET_SIDES,
  type Database,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { parseInput } from '../validation';
import {
  GROWTH_LIMITS,
  SLUG_RE,
  WIDGET_ID_RE,
  newRefCode,
  newSlug,
  newWidgetId,
  phoneDigits,
  prefilledText,
  waMeUrl,
} from './model';

/**
 * Growth tools: click-to-chat links (a short link that counts clicks and opens WhatsApp with a
 * pre-filled message), website widgets that open a link, and where conversations come from.
 * Reading needs `campaigns.read`; creating and changing links and widgets needs `campaigns.write`
 * and is audited. Visitors are not tracked: clicks are counted per link and day only.
 */

const idSchema = z.object({ id: z.uuid() });
const versioned = idSchema.extend({ expectedVersion: z.number().int().min(1) });

const linkSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name the link.')
    .max(GROWTH_LIMITS.nameLength, `Use at most ${GROWTH_LIMITS.nameLength} characters.`),
  channelAccountId: z.uuid('Choose a WhatsApp number.'),
  message: z
    .string()
    .max(GROWTH_LIMITS.messageLength, `Use at most ${GROWTH_LIMITS.messageLength} characters.`)
    .transform((v) => v.trim()),
  includeRef: z.boolean(),
});

const widgetSchema = z.object({
  linkId: z.uuid('Choose the link the button opens.'),
  label: z
    .string()
    .trim()
    .min(1, 'Enter the button text.')
    .max(
      GROWTH_LIMITS.widgetLabelLength,
      `Use at most ${GROWTH_LIMITS.widgetLabelLength} characters.`,
    ),
  greeting: z
    .string()
    .trim()
    .max(
      GROWTH_LIMITS.widgetGreetingLength,
      `Use at most ${GROWTH_LIMITS.widgetGreetingLength} characters.`,
    )
    .transform((v) => v || null),
  side: z.enum(WIDGET_SIDES),
  color: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^#[0-9a-f]{6}$/, 'Use a colour such as #1f7a4d.'),
  enabled: z.boolean(),
});

export interface ChatLinkView {
  id: string;
  name: string;
  message: string;
  refCode: string;
  includeRef: boolean;
  slug: string;
  channelAccountId: string;
  channelName: string;
  channelActive: boolean;
  /** The wa.me address the short link opens (null while the number has no usable phone number). */
  waMeUrl: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  clicks30: number;
  conversations30: number;
}

export interface ChatWidgetView {
  id: string;
  publicId: string;
  linkId: string;
  linkName: string;
  linkArchived: boolean;
  /** Whether the link's number can open a chat (the button is not shown while it cannot). */
  channelActive: boolean;
  label: string;
  greeting: string | null;
  side: (typeof WIDGET_SIDES)[number];
  color: string;
  enabled: boolean;
  version: number;
}

export interface AdSourceView {
  sourceId: string | null;
  sourceType: string | null;
  headline: string | null;
  sourceUrl: string | null;
  conversations: number;
  messages: number;
  lastAt: string;
}

const channelName = sql<string>`coalesce(${channelAccounts.verifiedName}, ${channelAccounts.displayPhoneNumber}, ${channelAccounts.phoneNumberId})`;

const stale = () =>
  new AppError(
    'conflict',
    'Someone else changed this. Reload to see the latest version, then try again.',
  );

/** Retries an insert whose random identifier collided (a new transaction per attempt). */
async function withFreshIds<T>(attempt: () => Promise<T>, constraints: string[]): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (i < 4 && constraints.some((c) => isUniqueViolation(error, c))) continue;
      throw error;
    }
  }
}

export function createGrowthService(deps: { db: Database; clock: Clock }) {
  const { db } = deps;

  const readable = (ctx: TenantContext) => assertCan(ctx, 'campaigns.read');
  const writable = (ctx: TenantContext) => assertCan(ctx, 'campaigns.write');

  async function activeChannel(tx: Tx, tenantId: string, channelAccountId: string) {
    const [channel] = await tx
      .select({ id: channelAccounts.id, status: channelAccounts.status })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.id, channelAccountId)));
    if (!channel || channel.status !== 'active') {
      const message = 'Choose an active WhatsApp number.';
      throw new AppError('validation_failed', message, {
        issues: [{ path: 'channelAccountId', message }],
      });
    }
  }

  async function lockLink(tx: Tx, tenantId: string, id: string, expectedVersion: number) {
    const [row] = await tx
      .select()
      .from(chatLinks)
      .where(and(eq(chatLinks.tenantId, tenantId), eq(chatLinks.id, id)))
      .for('update');
    if (!row) throw notFound('Link');
    if (row.version !== expectedVersion) throw stale();
    return row;
  }

  async function lockWidget(tx: Tx, tenantId: string, id: string, expectedVersion: number) {
    const [row] = await tx
      .select()
      .from(chatWidgets)
      .where(and(eq(chatWidgets.tenantId, tenantId), eq(chatWidgets.id, id)))
      .for('update');
    if (!row) throw notFound('Widget');
    if (row.version !== expectedVersion) throw stale();
    return row;
  }

  async function usableLink(tx: Tx, tenantId: string, linkId: string) {
    const [link] = await tx
      .select({ id: chatLinks.id, archivedAt: chatLinks.archivedAt })
      .from(chatLinks)
      .where(and(eq(chatLinks.tenantId, tenantId), eq(chatLinks.id, linkId)));
    if (!link || link.archivedAt) {
      const message = 'Choose a link that is not archived.';
      throw new AppError('validation_failed', message, { issues: [{ path: 'linkId', message }] });
    }
  }

  async function linkRows(tx: Tx, ctx: TenantContext, where: ReturnType<typeof and>) {
    const tz = ctx.tenant.timezone;
    const rows = await tx
      .select({
        id: chatLinks.id,
        name: chatLinks.name,
        message: chatLinks.message,
        refCode: chatLinks.refCode,
        includeRef: chatLinks.includeRef,
        slug: chatLinks.slug,
        channelAccountId: chatLinks.channelAccountId,
        channelName,
        channelStatus: channelAccounts.status,
        displayPhoneNumber: channelAccounts.displayPhoneNumber,
        archivedAt: chatLinks.archivedAt,
        version: chatLinks.version,
        createdAt: chatLinks.createdAt,
        clicks30: sql<number>`coalesce((
          select sum(k.clicks) from app.chat_link_clicks k
           where k.tenant_id = ${chatLinks.tenantId} and k.link_id = ${chatLinks.id}
             and k.day > (now() at time zone ${tz})::date - 30), 0)::int`,
        conversations30: sql<number>`(
          select count(distinct s.conversation_id) from app.conversation_sources s
           where s.tenant_id = ${chatLinks.tenantId} and s.link_id = ${chatLinks.id}
             and s.occurred_at > now() - interval '30 days')::int`,
      })
      .from(chatLinks)
      .innerJoin(
        channelAccounts,
        and(
          eq(channelAccounts.tenantId, chatLinks.tenantId),
          eq(channelAccounts.id, chatLinks.channelAccountId),
        ),
      )
      .where(where)
      .orderBy(desc(chatLinks.createdAt), desc(chatLinks.id))
      .limit(GROWTH_LIMITS.links);
    return rows.map((r): ChatLinkView => {
      const phone = phoneDigits(r.displayPhoneNumber);
      return {
        id: r.id,
        name: r.name,
        message: r.message,
        refCode: r.refCode,
        includeRef: r.includeRef,
        slug: r.slug,
        channelAccountId: r.channelAccountId,
        channelName: r.channelName,
        channelActive: r.channelStatus === 'active',
        waMeUrl: phone ? waMeUrl(phone, prefilledText(r.message, r.refCode, r.includeRef)) : null,
        archivedAt: r.archivedAt?.toISOString() ?? null,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
        clicks30: r.clicks30,
        conversations30: r.conversations30,
      };
    });
  }

  return {
    /** The company's numbers a link can open (only active ones can be chosen). */
    async channelOptions(ctx: TenantContext) {
      readable(ctx);
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ id: channelAccounts.id, name: channelName, status: channelAccounts.status })
            .from(channelAccounts)
            .where(eq(channelAccounts.tenantId, ctx.tenant.id))
            .orderBy(asc(channelName)),
        { accessMode: 'read only' },
      );
      return rows.map((r) => ({ id: r.id, name: r.name, active: r.status === 'active' }));
    },

    /** Links, newest first, with clicks and attributed conversations over the last 30 days. */
    async listLinks(
      ctx: TenantContext,
      options: { archived?: boolean } = {},
    ): Promise<ChatLinkView[]> {
      readable(ctx);
      return db.run(
        ctx.scope,
        (tx) =>
          linkRows(
            tx,
            ctx,
            and(
              eq(chatLinks.tenantId, ctx.tenant.id),
              options.archived ? isNotNull(chatLinks.archivedAt) : isNull(chatLinks.archivedAt),
            ),
          ),
        { accessMode: 'read only' },
      );
    },

    /** One link with its clicks per day over the last 30 days (company time zone). */
    async getLink(ctx: TenantContext, id: string) {
      readable(ctx);
      if (!z.uuid().safeParse(id).success) throw notFound('Link');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [link] = await linkRows(
            tx,
            ctx,
            and(eq(chatLinks.tenantId, ctx.tenant.id), eq(chatLinks.id, id)),
          );
          if (!link) throw notFound('Link');
          const days = await tx
            .select({ day: chatLinkClicks.day, clicks: chatLinkClicks.clicks })
            .from(chatLinkClicks)
            .where(
              and(
                eq(chatLinkClicks.tenantId, ctx.tenant.id),
                eq(chatLinkClicks.linkId, id),
                gte(
                  chatLinkClicks.day,
                  sql`(now() at time zone ${ctx.tenant.timezone})::date - 29`,
                ),
              ),
            )
            .orderBy(asc(chatLinkClicks.day));
          return { link, days, canManage: can(ctx, 'campaigns.write') };
        },
        { accessMode: 'read only' },
      );
    },

    async createLink(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      writable(ctx);
      const data = parseInput(linkSchema, input);
      return withFreshIds(
        () =>
          db.run(ctx.scope, async (tx) => {
            await activeChannel(tx, ctx.tenant.id, data.channelAccountId);
            const [open] = await tx
              .select({ n: count() })
              .from(chatLinks)
              .where(and(eq(chatLinks.tenantId, ctx.tenant.id), isNull(chatLinks.archivedAt)));
            if ((open?.n ?? 0) >= GROWTH_LIMITS.links) {
              throw new AppError(
                'conflict',
                `A company can have at most ${GROWTH_LIMITS.links} links; archive some first.`,
              );
            }
            const id = uuidv7();
            await tx.insert(chatLinks).values({
              id,
              tenantId: ctx.tenant.id,
              channelAccountId: data.channelAccountId,
              name: data.name,
              message: data.message,
              refCode: newRefCode(),
              includeRef: data.includeRef,
              slug: newSlug(),
              createdByMembershipId: ctx.membership.id,
            });
            await recordAudit(
              tx,
              ctx,
              {
                action: 'growth.link_created',
                subjectType: 'chat_link',
                subjectId: id,
                metadata: { name: data.name },
              },
              meta,
            );
            return { id };
          }),
        ['chat_links_ref_uq', 'chat_links_slug_uq'],
      );
    },

    async updateLink(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      writable(ctx);
      const data = parseInput(versioned.extend(linkSchema.shape), input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockLink(tx, ctx.tenant.id, data.id, data.expectedVersion);
        if (row.archivedAt) throw new AppError('conflict', 'Restore the link before changing it.');
        if (row.channelAccountId !== data.channelAccountId) {
          await activeChannel(tx, ctx.tenant.id, data.channelAccountId);
        }
        await tx
          .update(chatLinks)
          .set({
            name: data.name,
            channelAccountId: data.channelAccountId,
            message: data.message,
            includeRef: data.includeRef,
            version: row.version + 1,
          })
          .where(and(eq(chatLinks.tenantId, ctx.tenant.id), eq(chatLinks.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'growth.link_updated',
            subjectType: 'chat_link',
            subjectId: row.id,
            metadata: { name: data.name },
          },
          meta,
        );
        return { version: row.version + 1 };
      });
    },

    /** Archived links stop opening WhatsApp (the short link and its widgets answer "not found"). */
    async setLinkArchived(
      ctx: TenantContext,
      input: unknown,
      archived: boolean,
      meta: RequestMeta = {},
    ) {
      writable(ctx);
      const data = parseInput(versioned, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockLink(tx, ctx.tenant.id, data.id, data.expectedVersion);
        if (Boolean(row.archivedAt) === archived) return { version: row.version };
        await tx
          .update(chatLinks)
          .set({ archivedAt: archived ? deps.clock.now() : null, version: row.version + 1 })
          .where(and(eq(chatLinks.tenantId, ctx.tenant.id), eq(chatLinks.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: archived ? 'growth.link_archived' : 'growth.link_restored',
            subjectType: 'chat_link',
            subjectId: row.id,
            metadata: { name: row.name },
          },
          meta,
        );
        return { version: row.version + 1 };
      });
    },

    async listWidgets(ctx: TenantContext): Promise<ChatWidgetView[]> {
      readable(ctx);
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: chatWidgets.id,
              publicId: chatWidgets.publicId,
              linkId: chatWidgets.linkId,
              linkName: chatLinks.name,
              linkArchivedAt: chatLinks.archivedAt,
              channelStatus: channelAccounts.status,
              displayPhoneNumber: channelAccounts.displayPhoneNumber,
              label: chatWidgets.label,
              greeting: chatWidgets.greeting,
              side: chatWidgets.side,
              color: chatWidgets.color,
              enabled: chatWidgets.enabled,
              version: chatWidgets.version,
            })
            .from(chatWidgets)
            .innerJoin(
              chatLinks,
              and(
                eq(chatLinks.tenantId, chatWidgets.tenantId),
                eq(chatLinks.id, chatWidgets.linkId),
              ),
            )
            .innerJoin(
              channelAccounts,
              and(
                eq(channelAccounts.tenantId, chatLinks.tenantId),
                eq(channelAccounts.id, chatLinks.channelAccountId),
              ),
            )
            .where(eq(chatWidgets.tenantId, ctx.tenant.id))
            .orderBy(asc(chatWidgets.createdAt), asc(chatWidgets.id))
            .limit(GROWTH_LIMITS.widgets),
        { accessMode: 'read only' },
      );
      return rows.map(({ linkArchivedAt, channelStatus, displayPhoneNumber, ...w }) => ({
        ...w,
        linkArchived: Boolean(linkArchivedAt),
        channelActive: channelStatus === 'active' && phoneDigits(displayPhoneNumber) !== null,
      }));
    },

    async createWidget(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      writable(ctx);
      const data = parseInput(widgetSchema, input);
      return withFreshIds(
        () =>
          db.run(ctx.scope, async (tx) => {
            await usableLink(tx, ctx.tenant.id, data.linkId);
            const [existing] = await tx
              .select({ n: count() })
              .from(chatWidgets)
              .where(eq(chatWidgets.tenantId, ctx.tenant.id));
            if ((existing?.n ?? 0) >= GROWTH_LIMITS.widgets) {
              throw new AppError(
                'conflict',
                `A company can have at most ${GROWTH_LIMITS.widgets} widgets.`,
              );
            }
            const id = uuidv7();
            const publicId = newWidgetId();
            await tx.insert(chatWidgets).values({
              id,
              tenantId: ctx.tenant.id,
              publicId,
              ...data,
              createdByMembershipId: ctx.membership.id,
            });
            await recordAudit(
              tx,
              ctx,
              {
                action: 'growth.widget_created',
                subjectType: 'chat_widget',
                subjectId: id,
                metadata: { label: data.label },
              },
              meta,
            );
            return { id, publicId };
          }),
        ['chat_widgets_public_id_uq'],
      );
    },

    async updateWidget(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      writable(ctx);
      const data = parseInput(versioned.extend(widgetSchema.shape), input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockWidget(tx, ctx.tenant.id, data.id, data.expectedVersion);
        if (row.linkId !== data.linkId) await usableLink(tx, ctx.tenant.id, data.linkId);
        const { id, expectedVersion: _expected, ...values } = data;
        await tx
          .update(chatWidgets)
          .set({ ...values, version: row.version + 1 })
          .where(and(eq(chatWidgets.tenantId, ctx.tenant.id), eq(chatWidgets.id, id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'growth.widget_updated',
            subjectType: 'chat_widget',
            subjectId: id,
            metadata: { label: data.label, enabled: data.enabled },
          },
          meta,
        );
        return { version: row.version + 1 };
      });
    },

    /** Deleting a widget makes its script answer "not found"; sites keep the tag until removed. */
    async deleteWidget(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      writable(ctx);
      const data = parseInput(versioned, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockWidget(tx, ctx.tenant.id, data.id, data.expectedVersion);
        await tx
          .delete(chatWidgets)
          .where(and(eq(chatWidgets.tenantId, ctx.tenant.id), eq(chatWidgets.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'growth.widget_deleted',
            subjectType: 'chat_widget',
            subjectId: row.id,
            metadata: { label: row.label },
          },
          meta,
        );
        return { ok: true as const };
      });
    },

    /** Click-to-WhatsApp ads that started conversations in the last 30 days, busiest first. */
    async adSources(ctx: TenantContext): Promise<AdSourceView[]> {
      readable(ctx);
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              sourceId: conversationSources.adSourceId,
              sourceType: conversationSources.adSourceType,
              headline: conversationSources.adHeadline,
              sourceUrl: conversationSources.adSourceUrl,
              conversations: sql<number>`count(distinct ${conversationSources.conversationId})::int`,
              messages: sql<number>`count(*)::int`,
              lastAt: sql<Date>`max(${conversationSources.occurredAt})`,
            })
            .from(conversationSources)
            .where(
              and(
                eq(conversationSources.tenantId, ctx.tenant.id),
                eq(conversationSources.kind, 'ad'),
                sql`${conversationSources.occurredAt} > now() - interval '30 days'`,
              ),
            )
            .groupBy(
              conversationSources.adSourceId,
              conversationSources.adSourceType,
              conversationSources.adHeadline,
              conversationSources.adSourceUrl,
            )
            .orderBy(sql`count(distinct ${conversationSources.conversationId}) desc`)
            .limit(200),
        { accessMode: 'read only' },
      );
      return rows.map((r) => ({ ...r, lastAt: new Date(r.lastAt).toISOString() }));
    },
  };
}

export type GrowthService = ReturnType<typeof createGrowthService>;

// Public lookups (no company context) ---------------------------------------------------------------

/**
 * Follows a short link: counts the click and returns the wa.me address to redirect to, or null for
 * an unknown or archived link, or one whose number is not active. The address is built from the
 * stored link only, so the redirect can never be pointed elsewhere.
 */
export async function followChatLink(db: Database, slug: string): Promise<string | null> {
  if (!SLUG_RE.test(slug)) return null;
  const res = await db.run(systemScope, (tx) =>
    tx.execute<{ phone: string; message: string; ref_code: string; include_ref: boolean }>(
      sql`select phone, message, ref_code, include_ref from ops.follow_chat_link(${slug})`,
    ),
  );
  const row = res.rows[0];
  if (!row) return null;
  return waMeUrl(row.phone, prefilledText(row.message, row.ref_code, row.include_ref));
}

export interface WidgetConfig {
  label: string;
  greeting: string | null;
  side: 'left' | 'right';
  color: string;
  slug: string;
}

/**
 * A widget's public configuration, or null for an unknown or disabled widget, or one whose link
 * would not open (archived, or its number is not active).
 */
export async function chatWidgetConfig(
  db: Database,
  publicId: string,
): Promise<WidgetConfig | null> {
  if (!WIDGET_ID_RE.test(publicId)) return null;
  const res = await db.run(
    systemScope,
    (tx) =>
      tx.execute<{
        label: string;
        greeting: string | null;
        side: string;
        color: string;
        slug: string;
      }>(sql`select label, greeting, side, color, slug from ops.chat_widget_config(${publicId})`),
    { accessMode: 'read only' },
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    label: row.label,
    greeting: row.greeting,
    side: row.side === 'left' ? 'left' : 'right',
    color: row.color,
    slug: row.slug,
  };
}
