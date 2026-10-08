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

/** A link's name, as members and keys (ADR-300) give it. */
export const chatLinkNameSchema = z
  .string()
  .trim()
  .min(1, 'Name the link.')
  .max(GROWTH_LIMITS.nameLength, `Use at most ${GROWTH_LIMITS.nameLength} characters.`);

/** The message a link opens the chat with, likewise (empty for none). */
export const chatLinkMessageSchema = z
  .string()
  .max(GROWTH_LIMITS.messageLength, `Use at most ${GROWTH_LIMITS.messageLength} characters.`)
  .transform((v) => v.trim());

const linkSchema = z.object({
  name: chatLinkNameSchema,
  channelAccountId: z.uuid('Choose a WhatsApp number.'),
  message: chatLinkMessageSchema,
  includeRef: z.boolean(),
});

/** What a link is made of, members' and keys' alike. */
export type ChatLinkFields = z.infer<typeof linkSchema>;

/** Who adds a link: a member on the Growth pages, or a key through the API (ADR-300). */
export type ChatLinkAuthor = { membershipId: string } | { apiKeyId: string };

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

/**
 * The click-to-WhatsApp ads customers wrote from in the last 30 days, as Growth → Ads lists them and
 * the public API gives them (ADR-302): one row for each id, type, headline and web address Meta sent,
 * those that started the most conversations first, then the latest, at most `GROWTH_LIMITS.adsShown`.
 */
export async function readAdSources(tx: Tx, tenantId: string): Promise<AdSourceView[]> {
  const conversationCount = sql`count(distinct ${conversationSources.conversationId})`;
  const lastAt = sql`max(${conversationSources.occurredAt})`;
  const rows = await tx
    .select({
      sourceId: conversationSources.adSourceId,
      sourceType: conversationSources.adSourceType,
      headline: conversationSources.adHeadline,
      sourceUrl: conversationSources.adSourceUrl,
      conversations: sql<number>`${conversationCount}::int`,
      messages: sql<number>`count(*)::int`,
      lastAt: sql<Date>`${lastAt}`,
    })
    .from(conversationSources)
    .where(
      and(
        eq(conversationSources.tenantId, tenantId),
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
    // Ties broken by every grouped column, so the order is the same on every read.
    .orderBy(
      sql`${conversationCount} desc`,
      sql`${lastAt} desc`,
      sql`${conversationSources.adSourceId} asc nulls last`,
      sql`${conversationSources.adSourceType} asc nulls last`,
      sql`${conversationSources.adHeadline} asc nulls last`,
      sql`${conversationSources.adSourceUrl} asc nulls last`,
    )
    .limit(GROWTH_LIMITS.adsShown);
  return rows.map((r) => ({ ...r, lastAt: new Date(r.lastAt).toISOString() }));
}

const channelName = sql<string>`coalesce(${channelAccounts.verifiedName}, ${channelAccounts.displayPhoneNumber}, ${channelAccounts.phoneNumberId})`;

/**
 * A link's clicks on the company's last 30 days, today included, as the Growth pages and the public
 * API (ADR-299) count them, for a query that selects from `chat_links`.
 */
export const linkClicks30 = (timezone: string) =>
  sql<number>`coalesce((
          select sum(k.clicks) from app.chat_link_clicks k
           where k.tenant_id = ${chatLinks.tenantId} and k.link_id = ${chatLinks.id}
             and k.day > (now() at time zone ${timezone})::date - 30), 0)::int`;

/** The conversations a link started in the last 30 days, likewise. */
export const linkConversations30 = () =>
  sql<number>`(
          select count(distinct s.conversation_id) from app.conversation_sources s
           where s.tenant_id = ${chatLinks.tenantId} and s.link_id = ${chatLinks.id}
             and s.occurred_at > now() - interval '30 days')::int`;

const stale = () =>
  new AppError(
    'conflict',
    'Someone else changed this. Reload to see the latest version, then try again.',
  );

/** The constraints a new link's random reference and slug can collide on. */
export const CHAT_LINK_ID_CONSTRAINTS = ['chat_links_ref_uq', 'chat_links_slug_uq'];

/** Retries an insert whose random identifier collided (a new transaction per attempt). */
export async function withFreshIds<T>(
  attempt: () => Promise<T>,
  constraints: string[],
): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (i < 4 && constraints.some((c) => isUniqueViolation(error, c))) continue;
      throw error;
    }
  }
}

/**
 * Refuses a number that is not one of the company's active ones (422 at `path`): links open only
 * those.
 */
export async function assertLinkChannel(
  tx: Tx,
  tenantId: string,
  channelAccountId: string,
  path = 'channelAccountId',
) {
  const [channel] = await tx
    .select({ id: channelAccounts.id, status: channelAccounts.status })
    .from(channelAccounts)
    .where(and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.id, channelAccountId)));
  if (!channel || channel.status !== 'active') {
    const message = 'Choose an active WhatsApp number.';
    throw new AppError('validation_failed', message, { issues: [{ path, message }] });
  }
}

/** Locks a link to change it from `expectedVersion`: 404 for none, 409 for another version. */
export async function lockChatLink(tx: Tx, tenantId: string, id: string, expectedVersion: number) {
  const [row] = await tx
    .select()
    .from(chatLinks)
    .where(and(eq(chatLinks.tenantId, tenantId), eq(chatLinks.id, id)))
    .for('update');
  if (!row) throw notFound('Link');
  if (row.version !== expectedVersion) throw stale();
  return row;
}

/**
 * Adds a link in the caller's transaction, as the Growth pages and the API (ADR-300) do: on an
 * active number, within the cap on open links, with a new reference and short link. Either can
 * collide with another link's, which aborts the transaction: run it in `withFreshIds`.
 */
export async function writeCreateChatLink(
  tx: Tx,
  tenantId: string,
  data: ChatLinkFields,
  author: ChatLinkAuthor,
  channelPath = 'channelAccountId',
): Promise<string> {
  await assertLinkChannel(tx, tenantId, data.channelAccountId, channelPath);
  const [open] = await tx
    .select({ n: count() })
    .from(chatLinks)
    .where(and(eq(chatLinks.tenantId, tenantId), isNull(chatLinks.archivedAt)));
  if ((open?.n ?? 0) >= GROWTH_LIMITS.links) {
    throw new AppError(
      'conflict',
      `A company can have at most ${GROWTH_LIMITS.links} links; archive some first.`,
    );
  }
  const id = uuidv7();
  await tx.insert(chatLinks).values({
    id,
    tenantId,
    channelAccountId: data.channelAccountId,
    name: data.name,
    message: data.message,
    refCode: newRefCode(),
    includeRef: data.includeRef,
    slug: newSlug(),
    ...('membershipId' in author
      ? { createdByMembershipId: author.membershipId }
      : { createdByApiKeyId: author.apiKeyId }),
  });
  return id;
}

/**
 * Sets a locked link's name, number, message and reference, as the Growth pages' edit and the API
 * (ADR-300) do: never an archived link's (restore it first), and only an active number when the
 * number changes. Returns the link's new version.
 */
export async function writeUpdateChatLink(
  tx: Tx,
  tenantId: string,
  row: typeof chatLinks.$inferSelect,
  data: ChatLinkFields,
  channelPath = 'channelAccountId',
): Promise<number> {
  if (row.archivedAt) throw new AppError('conflict', 'Restore the link before changing it.');
  if (row.channelAccountId !== data.channelAccountId) {
    await assertLinkChannel(tx, tenantId, data.channelAccountId, channelPath);
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
    .where(and(eq(chatLinks.tenantId, tenantId), eq(chatLinks.id, row.id)));
  return row.version + 1;
}

/**
 * Archives or restores a locked link (an archived link's short link and buttons open nothing), as
 * the Growth pages and the API (ADR-300) do. Returns the new version, or null when it already was.
 */
export async function writeSetChatLinkArchived(
  tx: Tx,
  tenantId: string,
  row: typeof chatLinks.$inferSelect,
  archived: boolean,
  at: Date,
): Promise<number | null> {
  if (Boolean(row.archivedAt) === archived) return null;
  await tx
    .update(chatLinks)
    .set({ archivedAt: archived ? at : null, version: row.version + 1 })
    .where(and(eq(chatLinks.tenantId, tenantId), eq(chatLinks.id, row.id)));
  return row.version + 1;
}

export function createGrowthService(deps: { db: Database; clock: Clock }) {
  const { db } = deps;

  const readable = (ctx: TenantContext) => assertCan(ctx, 'campaigns.read');
  const writable = (ctx: TenantContext) => assertCan(ctx, 'campaigns.write');

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
        clicks30: linkClicks30(tz),
        conversations30: linkConversations30(),
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
            const id = await writeCreateChatLink(tx, ctx.tenant.id, data, {
              membershipId: ctx.membership.id,
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
        CHAT_LINK_ID_CONSTRAINTS,
      );
    },

    async updateLink(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      writable(ctx);
      const data = parseInput(versioned.extend(linkSchema.shape), input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockChatLink(tx, ctx.tenant.id, data.id, data.expectedVersion);
        const version = await writeUpdateChatLink(tx, ctx.tenant.id, row, data);
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
        return { version };
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
        const row = await lockChatLink(tx, ctx.tenant.id, data.id, data.expectedVersion);
        const version = await writeSetChatLinkArchived(
          tx,
          ctx.tenant.id,
          row,
          archived,
          deps.clock.now(),
        );
        if (version === null) return { version: row.version };
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
        return { version };
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
      return db.run(ctx.scope, (tx) => readAdSources(tx, ctx.tenant.id), {
        accessMode: 'read only',
      });
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
