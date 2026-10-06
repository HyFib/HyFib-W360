import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { clipText, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  campaignRecipients,
  campaigns,
  contactConsents,
  contactIdentities,
  contacts,
  conversations,
  eq,
  inArray,
  messages,
  sendIntents,
  sql,
  suppressions,
  systemScope,
  type CampaignPauseReason,
  type Database,
  type SkipReason,
  type TenantScope,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { consentPurposeFor, loadMessagingSettings } from '../consent/service';
import { phoneFromWaId, waRecipientFromPhone } from '../contacts/phone';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from '../messaging/events';
import { STATUS_RANK } from '../messaging/status';
import { buildTemplateSend, sendSpecFor } from '../templates/definition';
import { loadRateTable, marketFor, priceFor, rateCategoryFor } from './costs';
import { parseTimeOfDay, sendingWindow } from './schedule';
import {
  CAMPAIGN_TICK_MS,
  campaignLauncherStanding,
  emailCampaignCompleted,
  emailCampaignPaused,
  loadCampaignSettings,
  recordCampaignEvent,
  recountedCounters,
  releaseQueuedSends,
  requeueReleased,
  signalCampaignRunner,
  type AutomaticPauseReason,
  type CampaignNoticeDeps,
} from './service';
import { readCampaignVariables, resolveVariables } from './variables';

/**
 * The campaign runner (worker). Each tick, under the campaign's row lock and a per-company
 * advisory lock (so two campaigns of one company never race on the frequency cap):
 * 1. starts a due scheduled campaign, stops at the deadline, waits outside the sending window;
 * 2. pauses when the template is no longer sendable, the number is inactive, the member whose
 *    authority the sends use lost `campaigns.send`, a cap is reached or rates are missing;
 * 3. takes the next pending recipients (pacing: `rate_per_minute`, else the number's send rate,
 *    with a bound on sends still waiting in the queue), re-checks each one with fresh data —
 *    erasure, phone, suppression, consent, variables, frequency cap, spending cap — and either
 *    skips it with a reason or queues its message through the Phase 2 pipeline;
 * 4. schedules its next tick. The sweep re-signals ticks whose signal was lost.
 *
 * The send worker checks consent, suppression, template approval and the campaign status once
 * more right before dispatch.
 */
export interface CampaignRunnerDeps {
  db: Database;
  jobs: JobQueue;
  signer: JobSigner;
  clock: Clock;
  /** The per-number send rate (META_SEND_RATE_PER_SECOND). */
  sendRatePerSecond: number;
  /** Emails members when it pauses (ADR-210) or completes (ADR-214) a campaign. */
  notices: CampaignNoticeDeps;
}

export type TickOutcome =
  'not_found' | 'inactive' | 'early' | 'busy' | 'waiting' | 'progress' | 'paused' | 'completed';

export interface TickResult {
  outcome: TickOutcome;
  queued: number;
  skipped: number;
  nextRunAt: Date | null;
  pauseReason?: CampaignPauseReason;
}

const MAX_BATCH = 500;
const RELEASE_ON_PAUSE: ReadonlySet<CampaignPauseReason> = new Set<CampaignPauseReason>([
  'template_not_approved',
  'channel_inactive',
  'launcher_removed',
  'launcher_not_permitted',
]);
const EARLY_TOLERANCE_MS = 2_000;
const BUSY_RETRY_MS = 2_000;

const result = (
  outcome: TickOutcome,
  nextRunAt: Date | null = null,
  extra: Partial<TickResult> = {},
): TickResult => ({ outcome, queued: 0, skipped: 0, nextRunAt, ...extra });

export async function runCampaignTick(
  deps: CampaignRunnerDeps,
  scope: TenantScope,
  campaignId: string,
): Promise<TickResult> {
  const now = deps.clock.now();
  const tenantId = scope.tenantId;
  return deps.db.run(scope, async (tx) => {
    const signal = (at: Date, actorUserId: string | null) =>
      signalCampaignRunner(deps, tx, { tenantId, campaignId, actorUserId, at });

    const locked = await tx.execute<{ ok: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`campaign-runner:${tenantId}`}, 0)) as ok`,
    );
    const [c] = locked.rows[0]?.ok
      ? await tx
          .select()
          .from(campaigns)
          .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)))
          .for('update', { skipLocked: true })
      : [];
    if (!c) {
      const [exists] = await tx
        .select({
          id: campaigns.id,
          launchedBy: campaigns.launchedByUserId,
          status: campaigns.status,
        })
        .from(campaigns)
        .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
      if (!exists) return result('not_found');
      if (exists.status !== 'scheduled' && exists.status !== 'running') return result('inactive');
      // Another tick or a member's action holds a lock: try again shortly.
      const at = new Date(now.getTime() + BUSY_RETRY_MS);
      await signal(at, exists.launchedBy);
      return result('busy', at);
    }
    if (c.status !== 'scheduled' && c.status !== 'running') return result('inactive');
    const due = c.status === 'scheduled' ? c.scheduledAt : c.nextRunAt;
    if (due && due.getTime() > now.getTime() + EARLY_TOLERANCE_MS) return result('early', due);

    const update = (values: PgUpdateSetSource<typeof campaigns>) =>
      tx
        .update(campaigns)
        .set({ ...values, version: sql`${campaigns.version} + 1` })
        .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));

    const pause = async (reason: AutomaticPauseReason, detail: Record<string, unknown> = {}) => {
      // Sends already queued within a cap stay queued; when the template, the number or the
      // sender's authority is the problem, unclaimed sends go back to pending for the resume.
      if (RELEASE_ON_PAUSE.has(reason)) {
        const released = await releaseQueuedSends(
          tx,
          tenantId,
          campaignId,
          { code: 'campaign_paused', message: 'Not sent: the campaign was paused.' },
          now,
        );
        await requeueReleased(tx, tenantId, campaignId, released);
      }
      await update({
        status: 'paused',
        pauseReason: reason,
        pausedAt: now,
        nextRunAt: null,
        ...recountedCounters(tenantId, campaignId),
      });
      await recordCampaignEvent(tx, tenantId, campaignId, 'paused', null, { reason, ...detail });
      await recordSystemAudit(tx, tenantId, {
        action: 'campaign.paused',
        subjectType: 'campaign',
        subjectId: campaignId,
        metadata: { reason },
      });
      await emailCampaignPaused(deps.notices, tx, tenantId, campaignId, reason);
      await emitTenantEvent(tx, tenantId, { type: 'campaign.progress', payload: { campaignId } });
      return result('paused', null, { pauseReason: reason });
    };

    const complete = async (reason: 'all_processed' | 'deadline_passed') => {
      await update({
        status: 'completed',
        completedAt: now,
        completionReason: reason,
        nextRunAt: null,
      });
      await recordCampaignEvent(tx, tenantId, campaignId, 'completed', null, { reason });
      await emailCampaignCompleted(deps.notices, tx, tenantId, campaignId, reason);
      await emitTenantEvent(tx, tenantId, { type: 'campaign.progress', payload: { campaignId } });
      return result('completed');
    };

    let deadlineAt = c.deadlineAt;
    if (c.status === 'scheduled') {
      deadlineAt = new Date(now.getTime() + c.stopAfterHours * 3_600_000);
      await update({ status: 'running', startedAt: now, deadlineAt });
      await recordCampaignEvent(tx, tenantId, campaignId, 'started', null);
    }

    if (deadlineAt && now >= deadlineAt) {
      const expired = await tx
        .update(campaignRecipients)
        .set({ state: 'skipped', skipReason: 'expired' })
        .where(
          and(
            eq(campaignRecipients.tenantId, tenantId),
            eq(campaignRecipients.campaignId, campaignId),
            eq(campaignRecipients.state, 'pending'),
          ),
        )
        .returning({ id: campaignRecipients.id });
      await update({ skippedCount: sql`${campaigns.skippedCount} + ${expired.length}` });
      return complete('deadline_passed');
    }

    // The member whose authority the sends use must still be allowed to send campaigns.
    const standing = await campaignLauncherStanding(tx, tenantId, c.launchedByUserId);
    if (standing !== 'permitted') return pause(standing);

    const [channel] = c.channelAccountId
      ? await tx
          .execute<{ id: string; status: string; whatsapp_account_id: string }>(
            sql`
          select id, status, whatsapp_account_id from app.channel_accounts
           where tenant_id = ${tenantId} and id = ${c.channelAccountId}`,
          )
          .then((r) => r.rows)
      : [];
    if (!channel || channel.status !== 'active') return pause('channel_inactive');
    const [template] = c.templateId
      ? await tx
          .execute<{
            id: string;
            name: string;
            language: string;
            category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
            status: string;
            components: unknown[];
            whatsapp_account_id: string;
          }>(
            sql`
          select id, name, language, category, status, components, whatsapp_account_id
            from app.message_templates where tenant_id = ${tenantId} and id = ${c.templateId}`,
          )
          .then((r) => r.rows)
      : [];
    const spec = template ? sendSpecFor(template.category, template.components) : null;
    const variables = readCampaignVariables(c.variables);
    if (
      !template ||
      !spec?.supported ||
      template.status !== 'approved' ||
      template.whatsapp_account_id !== channel.whatsapp_account_id ||
      spec.headerParams !== variables.header.length ||
      spec.bodyParams !== variables.body.length
    ) {
      return pause('template_not_approved');
    }
    const sendSpec = spec;

    if (c.windowStart && c.windowEnd) {
      const start = parseTimeOfDay(c.windowStart);
      const end = parseTimeOfDay(c.windowEnd);
      if (start !== null && end !== null) {
        const window = sendingWindow(now.getTime(), c.timezone, start, end);
        if (!window.open) {
          await update({ nextRunAt: window.opensAt });
          await signal(window.opensAt, c.launchedByUserId);
          return result('waiting', window.opensAt);
        }
      }
    }

    const settings = await loadCampaignSettings(tx, tenantId);
    // The estimate currency is fixed once known, so a later change of the company's billing
    // currency cannot mix currencies within this campaign's estimates.
    const currency = c.estimateCurrency ?? c.budgetCurrency ?? settings.costCurrency;
    if (currency && c.estimateCurrency === null) await update({ estimateCurrency: currency });
    const table = currency ? await loadRateTable(tx, currency, now) : null;
    if (c.budgetMicros !== null && !table) return pause('rate_card_missing');
    if (c.maxMessages !== null && c.queuedCount >= c.maxMessages) {
      const [left] = await tx
        .select({ id: campaignRecipients.id })
        .from(campaignRecipients)
        .where(
          and(
            eq(campaignRecipients.tenantId, tenantId),
            eq(campaignRecipients.campaignId, campaignId),
            eq(campaignRecipients.state, 'pending'),
          ),
        )
        .limit(1);
      return left ? pause('message_cap_reached') : complete('all_processed');
    }

    // Pacing.
    const perTick = c.ratePerMinute
      ? Math.max(1, Math.ceil((c.ratePerMinute * CAMPAIGN_TICK_MS) / 60_000))
      : Math.max(1, Math.round((deps.sendRatePerSecond * CAMPAIGN_TICK_MS) / 1000));
    const backlogCap = Math.max(50, deps.sendRatePerSecond * 30);
    const inFlightRes = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from app.send_intents s
        join app.messages m on m.tenant_id = s.tenant_id and m.id = s.message_id
       where s.tenant_id = ${tenantId} and m.campaign_id = ${campaignId}
         and s.state in ('queued', 'deferred', 'sending')`);
    const inFlight = inFlightRes.rows[0]?.n ?? 0;
    const remainingCap =
      c.maxMessages !== null ? c.maxMessages - c.queuedCount : Number.POSITIVE_INFINITY;
    const take = Math.min(perTick, MAX_BATCH, backlogCap - inFlight, remainingCap);
    const nextTick = (queued: number) =>
      new Date(
        now.getTime() +
          (c.ratePerMinute
            ? Math.max(CAMPAIGN_TICK_MS, Math.ceil((queued * 60_000) / c.ratePerMinute))
            : CAMPAIGN_TICK_MS),
      );
    if (take <= 0) {
      const at = nextTick(0);
      await update({ nextRunAt: at });
      await signal(at, c.launchedByUserId);
      return result('waiting', at);
    }

    const batch = await tx
      .select({ id: campaignRecipients.id, contactId: campaignRecipients.contactId })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.tenantId, tenantId),
          eq(campaignRecipients.campaignId, campaignId),
          eq(campaignRecipients.state, 'pending'),
        ),
      )
      .orderBy(campaignRecipients.id)
      .limit(take)
      .for('update', { skipLocked: true });
    if (batch.length === 0) {
      const [left] = await tx
        .select({ id: campaignRecipients.id })
        .from(campaignRecipients)
        .where(
          and(
            eq(campaignRecipients.tenantId, tenantId),
            eq(campaignRecipients.campaignId, campaignId),
            eq(campaignRecipients.state, 'pending'),
          ),
        )
        .limit(1);
      if (!left) return complete('all_processed');
      const at = new Date(now.getTime() + BUSY_RETRY_MS);
      await update({ nextRunAt: at });
      await signal(at, c.launchedByUserId);
      return result('busy', at);
    }

    // Fresh data for the batch.
    const contactIds = batch.map((b) => b.contactId);
    const people = await tx
      .select({
        id: contacts.id,
        displayName: contacts.displayName,
        phoneE164: contacts.phoneE164,
        attributes: contacts.attributes,
        erasedAt: contacts.erasedAt,
      })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, contactIds)));
    const identities = await tx
      .select({ contactId: contactIdentities.contactId, waId: contactIdentities.waId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.tenantId, tenantId),
          eq(contactIdentities.whatsappAccountId, channel.whatsapp_account_id),
          inArray(contactIdentities.contactId, contactIds),
          sql`${contactIdentities.waId} is not null`,
        ),
      );
    const waPhone = new Map<string, string>();
    for (const i of identities) {
      const phone = phoneFromWaId(i.waId);
      if (phone && !waPhone.has(i.contactId)) waPhone.set(i.contactId, phone);
    }
    const candidatePhones = [
      ...new Set([
        ...people.flatMap((p) => (p.phoneE164 ? [p.phoneE164] : [])),
        ...waPhone.values(),
      ]),
    ];
    const suppressed = new Set(
      candidatePhones.length > 0
        ? (
            await tx
              .select({ phone: suppressions.phoneE164 })
              .from(suppressions)
              .where(
                and(
                  eq(suppressions.tenantId, tenantId),
                  inArray(suppressions.phoneE164, candidatePhones),
                ),
              )
          ).map((s) => s.phone)
        : [],
    );
    const purpose = consentPurposeFor(template.category);
    const consent = new Map(
      (
        await tx
          .select({ contactId: contactConsents.contactId, status: contactConsents.status })
          .from(contactConsents)
          .where(
            and(
              eq(contactConsents.tenantId, tenantId),
              eq(contactConsents.purpose, purpose),
              inArray(contactConsents.contactId, contactIds),
            ),
          )
      ).map((r) => [r.contactId, r.status]),
    );
    const messaging = await loadMessagingSettings(tx, tenantId);
    const capped = new Map<string, number>();
    if (template.category === 'MARKETING' && settings.capCount && settings.capDays) {
      const res = await tx.execute<{ contact_id: string; n: number }>(sql`
        select cv.contact_id, count(*)::int as n
          from app.messages m
          join app.conversations cv on cv.tenant_id = m.tenant_id and cv.id = m.conversation_id
          join app.message_templates t on t.tenant_id = m.tenant_id and t.id = m.template_id
         where m.tenant_id = ${tenantId} and cv.contact_id = any(${sql.param(contactIds)}::uuid[])
           and m.direction = 'outbound' and t.category = 'MARKETING'
           and m.status not in ('failed', 'canceled')
           and m.created_at > ${now.toISOString()}::timestamptz - make_interval(days => ${settings.capDays})
         group by cv.contact_id`);
      for (const row of res.rows) capped.set(row.contact_id, row.n);
    }
    const rateCategory = rateCategoryFor(template.category);

    interface Planned {
      recipientId: string;
      contactId: string;
      phone: string;
      params: { header: string[]; body: string[] };
      market: string | null;
      price: number | null;
    }
    const skips: { recipientId: string; reason: SkipReason }[] = [];
    const planned: Planned[] = [];
    let spent = c.spentEstimateMicros;
    let stop: AutomaticPauseReason | null = null;
    for (const b of batch) {
      const person = people.find((p) => p.id === b.contactId);
      const skip = (reason: SkipReason) => skips.push({ recipientId: b.id, reason });
      if (!person || person.erasedAt) {
        skip('contact_erased');
        continue;
      }
      const phone = waPhone.get(person.id) ?? person.phoneE164;
      if (!phone) {
        skip('no_phone');
        continue;
      }
      if (suppressed.has(phone) || (person.phoneE164 && suppressed.has(person.phoneE164))) {
        skip('suppressed');
        continue;
      }
      const state = consent.get(person.id);
      if (state === 'opted_out') {
        skip('opted_out');
        continue;
      }
      if (purpose === 'marketing' && messaging.requireMarketingOptIn && state !== 'opted_in') {
        skip('no_marketing_opt_in');
        continue;
      }
      const resolved = resolveVariables(variables, person);
      if (!resolved.ok) {
        skip('missing_variable');
        continue;
      }
      if (settings.capCount && (capped.get(person.id) ?? 0) >= settings.capCount) {
        skip('frequency_capped');
        continue;
      }
      const market = table ? marketFor(table, phone) : null;
      const price = table ? priceFor(table, market, rateCategory) : null;
      if (c.budgetMicros !== null) {
        if (price === null) {
          skip('cost_unknown');
          continue;
        }
        if (spent + price > c.budgetMicros) {
          stop = 'budget_reached';
          break;
        }
      }
      if (c.maxMessages !== null && c.queuedCount + planned.length >= c.maxMessages) {
        stop = 'message_cap_reached';
        break;
      }
      spent += price ?? 0;
      planned.push({
        recipientId: b.id,
        contactId: person.id,
        phone,
        params: resolved.params,
        market,
        price,
      });
    }

    // Queue the planned messages.
    if (planned.length > 0) {
      const convIds = planned.map(() => uuidv7());
      await tx.execute(sql`
        insert into app.conversations (id, tenant_id, channel_account_id, contact_id, status, resolved_at)
        select v.id, ${tenantId}::uuid, ${channel.id}::uuid, v.contact_id, 'resolved', ${now.toISOString()}::timestamptz
          from unnest(${sql.param(convIds)}::uuid[], ${sql.param(planned.map((p) => p.contactId))}::uuid[])
               as v(id, contact_id)
        on conflict (tenant_id, channel_account_id, contact_id) do nothing`);
      const threads = new Map(
        (
          await tx
            .select({ id: conversations.id, contactId: conversations.contactId })
            .from(conversations)
            .where(
              and(
                eq(conversations.tenantId, tenantId),
                eq(conversations.channelAccountId, channel.id),
                inArray(
                  conversations.contactId,
                  planned.map((p) => p.contactId),
                ),
              ),
            )
        ).map((t) => [t.contactId, t.id]),
      );
      const rows = planned.map((p) => {
        const built = buildTemplateSend(template, sendSpec, p.params);
        const conversationId = threads.get(p.contactId);
        if (!conversationId) throw new Error('Campaign conversation upsert failed');
        return {
          ...p,
          conversationId,
          messageId: uuidv7(),
          intentId: uuidv7(),
          built,
        };
      });
      await tx.insert(messages).values(
        rows.map((r) => ({
          id: r.messageId,
          tenantId,
          conversationId: r.conversationId,
          channelAccountId: channel.id,
          direction: 'outbound' as const,
          type: 'template' as const,
          content: {
            template: {
              id: template.id,
              name: template.name,
              language: template.language,
              category: template.category,
            },
            rendered: r.built.rendered,
            campaign: { id: campaignId, name: c.name },
          },
          status: 'queued' as const,
          statusRank: STATUS_RANK.queued,
          senderType: 'campaign' as const,
          templateId: template.id,
          campaignId,
        })),
      );
      await tx.insert(sendIntents).values(
        rows.map((r) => ({
          id: r.intentId,
          tenantId,
          messageId: r.messageId,
          channelAccountId: channel.id,
          request: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: waRecipientFromPhone(r.phone),
            type: 'template',
            template: r.built.template,
          },
          actorUserId: c.launchedByUserId,
        })),
      );
      await tx.execute(sql`
        update app.conversations cv
           set last_message_at = ${now.toISOString()}::timestamptz, last_message_preview = v.preview,
               version = cv.version + 1
          from unnest(${sql.param(rows.map((r) => r.conversationId))}::uuid[],
                      ${sql.param(rows.map((r) => clipText(r.built.rendered.body, 200)))}::text[]) as v(id, preview)
         where cv.tenant_id = ${tenantId} and cv.id = v.id`);
      await tx.execute(sql`
        update app.campaign_recipients r
           set state = 'queued', message_id = v.message_id, queued_at = ${now.toISOString()}::timestamptz,
               market = v.market, estimated_cost_micros = v.price
          from unnest(${sql.param(rows.map((r) => r.recipientId))}::uuid[],
                      ${sql.param(rows.map((r) => r.messageId))}::uuid[],
                      ${sql.param(rows.map((r) => r.market))}::text[],
                      ${sql.param(rows.map((r) => r.price))}::bigint[]) as v(id, message_id, market, price)
         where r.tenant_id = ${tenantId} and r.id = v.id`);
      await deps.jobs.enqueueMany(
        tx,
        QUEUES.messageSend.name,
        rows.map((r) => ({
          envelope: deps.signer.sign({
            kind: 'message.send',
            tenantId,
            actorUserId: c.launchedByUserId,
            ref: r.intentId,
          }),
          options: { singletonKey: r.intentId, group: { id: channel.id } },
        })),
      );
    }
    if (skips.length > 0) {
      await tx.execute(sql`
        update app.campaign_recipients r set state = 'skipped', skip_reason = v.reason
          from unnest(${sql.param(skips.map((s) => s.recipientId))}::uuid[],
                      ${sql.param(skips.map((s) => s.reason))}::text[]) as v(id, reason)
         where r.tenant_id = ${tenantId} and r.id = v.id`);
    }
    const queuedMicros = planned.reduce((sum, p) => sum + (p.price ?? 0), 0);
    await update({
      queuedCount: sql`${campaigns.queuedCount} + ${planned.length}`,
      skippedCount: sql`${campaigns.skippedCount} + ${skips.length}`,
      spentEstimateMicros: sql`${campaigns.spentEstimateMicros} + ${queuedMicros}`,
    });
    await emitTenantEvent(tx, tenantId, {
      type: 'campaign.progress',
      payload: { campaignId, queued: planned.length, skipped: skips.length },
    });
    if (stop) {
      const paused = await pause(stop);
      return { ...paused, queued: planned.length, skipped: skips.length };
    }
    const at = nextTick(planned.length);
    await update({ nextRunAt: at });
    await signal(at, c.launchedByUserId);
    return { outcome: 'progress', queued: planned.length, skipped: skips.length, nextRunAt: at };
  });
}

/**
 * The job's acting member is no longer a member: pause the campaign so another member can resume
 * it, releasing the sends no worker has claimed (their recipients return to pending, like any
 * pause for lost authority). Sends the worker rejects for the same reason return their recipients
 * too (cancelSendIntent), so a resumed campaign reaches everyone it had not reached. The
 * company's owners and administrators are emailed (ADR-210).
 */
export async function pauseCampaignForRemovedLauncher(
  deps: Pick<CampaignRunnerDeps, 'db' | 'clock' | 'notices'>,
  scope: TenantScope,
  campaignId: string,
  actorUserId: string | null,
): Promise<boolean> {
  // A signal from before another member resumed the campaign names the previous member.
  if (!actorUserId) return false;
  const now = deps.clock.now();
  return deps.db.run(scope, async (tx) => {
    const [row] = await tx
      .update(campaigns)
      .set({
        status: 'paused',
        pauseReason: 'launcher_removed',
        pausedAt: now,
        nextRunAt: null,
        version: sql`${campaigns.version} + 1`,
      })
      .where(
        and(
          eq(campaigns.tenantId, scope.tenantId),
          eq(campaigns.id, campaignId),
          eq(campaigns.launchedByUserId, actorUserId),
          inArray(campaigns.status, ['scheduled', 'running']),
        ),
      )
      .returning({ id: campaigns.id });
    if (!row) return false;
    const released = await releaseQueuedSends(
      tx,
      scope.tenantId,
      campaignId,
      { code: 'campaign_paused', message: 'Not sent: the campaign was paused.' },
      now,
    );
    await requeueReleased(tx, scope.tenantId, campaignId, released);
    await tx
      .update(campaigns)
      .set(recountedCounters(scope.tenantId, campaignId))
      .where(and(eq(campaigns.tenantId, scope.tenantId), eq(campaigns.id, campaignId)));
    await recordCampaignEvent(tx, scope.tenantId, campaignId, 'paused', null, {
      reason: 'launcher_removed',
    });
    await recordSystemAudit(tx, scope.tenantId, {
      action: 'campaign.paused',
      subjectType: 'campaign',
      subjectId: campaignId,
      metadata: { reason: 'launcher_removed' },
    });
    await emailCampaignPaused(deps.notices, tx, scope.tenantId, campaignId, 'launcher_removed');
    return true;
  });
}

/** Campaign ticks the sweep must signal (definer function; ids only, active companies only). */
export async function findDueCampaigns(
  db: Database,
  limit = 200,
): Promise<{ tenantId: string; campaignId: string; launchedByUserId: string | null }[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{
        tenant_id: string;
        campaign_id: string;
        launched_by_user_id: string | null;
      }>(sql`select tenant_id, campaign_id, launched_by_user_id from ops.campaigns_due(${limit})`);
      return res.rows.map((r) => ({
        tenantId: r.tenant_id,
        campaignId: r.campaign_id,
        launchedByUserId: r.launched_by_user_id,
      }));
    },
    { accessMode: 'read only' },
  );
}
