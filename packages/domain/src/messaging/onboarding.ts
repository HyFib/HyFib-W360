import { randomInt } from 'node:crypto';
import { z } from 'zod';
import {
  AppError,
  forbidden,
  notFound,
  randomToken,
  sha256Hex,
  uuidv7,
  type Clock,
  type Keyring,
  type MetaConfig,
} from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  asc,
  channelAccounts,
  channelOnboardingSessions,
  eq,
  gt,
  ne,
  sql,
  whatsappAccounts,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { recordAudit, recordSystemAudit, type RequestMeta } from '../audit';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from './events';
import type { GraphClient, GraphResult } from './graph';
import { credentialAad } from './outbound';
import { COUNTED_CHANNEL_STATUSES, assertNumberAvailable } from '../plans/entitlements';

/**
 * Connecting a company's own WhatsApp Business Account through Meta Embedded Signup
 * (docs/research/meta-whatsapp.md M-010..M-019, M-144).
 *
 * The browser only relays what Meta's popup returned (an authorization code plus the WABA and phone
 * number ids from the session-info event); none of it is trusted:
 * - a single-use state, stored hashed and bound to the member, their auth session and the company,
 *   must match and be unexpired (CSRF and code-injection protection);
 * - the code is exchanged server-side for a business token within its 30-second lifetime;
 * - `debug_token` must report our app id, a valid token and the WhatsApp permissions, and when Meta
 *   returns target ids for the management permission they must include the WABA;
 * - independently, the new token must be able to list that WABA's phone numbers and the number
 *   must be among them (proof that the grant covers the assets the browser named);
 * - assets are bound through SECURITY DEFINER functions that refuse an asset already connected to
 *   another company.
 * The token is stored encrypted (AAD binds it to company and account) and never leaves the server.
 */
export const ONBOARDING_SESSION_TTL_MS = 15 * 60_000;
export const REQUIRED_META_PERMISSIONS = [
  'whatsapp_business_management',
  'whatsapp_business_messaging',
] as const;

const numericId = z.string().regex(/^[0-9]{1,32}$/);

export const completeOnboardingSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  // Authorization codes are opaque; accept printable ASCII only, bounded.
  code: z.string().regex(/^[\x21-\x7e]{10,2048}$/),
  wabaId: numericId,
  phoneNumberId: numericId,
  businessId: numericId.optional(),
});

export function registrationPinAad(tenantId: string, channelAccountId: string): string {
  return `tenant:${tenantId}|channel_account:${channelAccountId}|registration_pin`;
}

export interface OnboardingDeps {
  db: Database;
  keyring: Keyring;
  jobs: JobQueue;
  signer: JobSigner;
  clock: Clock;
  graph: GraphClient;
  meta: MetaConfig;
}

export interface ChannelView {
  id: string;
  whatsappAccountId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  status: 'onboarding' | 'active' | 'needs_reconnect' | 'disconnected' | 'failed';
  onboardingStep: string | null;
  onboardingError: string | null;
  qualityRating: string | null;
  nameStatus: string | null;
  healthCheckedAt: string | null;
}

class OnboardingFailure extends AppError {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super('provider_rejected', message);
  }
}

function describeFailure(result: Extract<GraphResult<never>, { ok: false }>): string {
  return [result.title, result.detail].filter(Boolean).join(': ').slice(0, 500);
}

export function createOnboardingService(deps: OnboardingDeps) {
  const { db, keyring, clock, graph, meta } = deps;

  async function failSession(ctx: TenantContext, sessionId: string, reason: string) {
    await db.run(ctx.scope, async (tx) => {
      await tx
        .update(channelOnboardingSessions)
        .set({ status: 'failed', failureReason: reason.slice(0, 1000) })
        .where(
          and(
            eq(channelOnboardingSessions.tenantId, ctx.tenant.id),
            eq(channelOnboardingSessions.id, sessionId),
          ),
        );
      await recordAudit(tx, ctx, {
        action: 'channel.onboarding_failed',
        subjectType: 'onboarding_session',
        subjectId: sessionId,
        result: 'failure',
        metadata: { reason: reason.slice(0, 200) },
      });
    });
  }

  /** Verifies the token and the assets the browser named; returns the granted permissions. */
  async function verifyGrant(
    token: string,
    wabaId: string,
    phoneNumberId: string,
  ): Promise<string[]> {
    const debug = await graph.debugToken(token, meta.appId, meta.appSecret);
    if (!debug.ok) throw new OnboardingFailure('debug_token_failed', describeFailure(debug));
    if (!debug.data.isValid || debug.data.appId !== meta.appId) {
      throw new OnboardingFailure(
        'token_not_for_app',
        'The returned token is not valid for this app.',
      );
    }
    const missing = REQUIRED_META_PERMISSIONS.filter((p) => !debug.data.scopes.includes(p));
    if (missing.length > 0) {
      throw new OnboardingFailure(
        'missing_permissions',
        `WhatsApp permissions were not granted: ${missing.join(', ')}.`,
      );
    }
    const management = debug.data.granularScopes.find(
      (g) => g.scope === 'whatsapp_business_management',
    );
    if (management && management.targetIds.length > 0 && !management.targetIds.includes(wabaId)) {
      throw new OnboardingFailure(
        'waba_not_granted',
        'The WhatsApp Business Account was not shared with this app.',
      );
    }
    const numbers = await graph.listPhoneNumbers(wabaId, token);
    if (!numbers.ok) throw new OnboardingFailure('waba_not_accessible', describeFailure(numbers));
    if (!numbers.data.ids.includes(phoneNumberId)) {
      throw new OnboardingFailure(
        'number_not_in_waba',
        'The selected phone number does not belong to that WhatsApp Business Account.',
      );
    }
    return debug.data.scopes.slice(0, 50);
  }

  return {
    /** Starts an Embedded Signup attempt and returns the values the browser needs. */
    async start(ctx: TenantContext, request: RequestMeta = {}) {
      assertCan(ctx, 'channels.manage');
      const authSessionId = ctx.sessionId;
      if (!authSessionId) {
        throw forbidden('Connecting WhatsApp requires a signed-in browser session.');
      }
      if (!meta.embeddedSignupConfigId) {
        throw new AppError(
          'provider_unavailable',
          'WhatsApp signup is not configured for this platform yet.',
        );
      }
      const state = randomToken(32);
      const id = uuidv7();
      const expiresAt = new Date(clock.now().getTime() + ONBOARDING_SESSION_TTL_MS);
      await db.run(ctx.scope, async (tx) => {
        await tx.insert(channelOnboardingSessions).values({
          id,
          tenantId: ctx.tenant.id,
          stateHash: sha256Hex(state),
          createdByUserId: ctx.user.id,
          authSessionId,
          expiresAt,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'channel.onboarding_started',
            subjectType: 'onboarding_session',
            subjectId: id,
          },
          request,
        );
      });
      return {
        state,
        appId: meta.appId,
        configId: meta.embeddedSignupConfigId,
        graphApiVersion: meta.graphApiVersion,
        expiresAt: expiresAt.toISOString(),
      };
    },

    /** Completes an attempt: verifies state, exchanges the code, verifies assets, binds them. */
    async complete(ctx: TenantContext, input: unknown, request: RequestMeta = {}) {
      assertCan(ctx, 'channels.manage');
      const parsed = completeOnboardingSchema.safeParse(input);
      if (!parsed.success)
        throw new AppError('validation_failed', 'The signup response was incomplete.');
      const data = parsed.data;
      const authSessionId = ctx.sessionId;
      if (!authSessionId) throw forbidden();
      const now = clock.now();

      // Claim the attempt atomically: single use, same member, same auth session, unexpired.
      const [session] = await db.run(ctx.scope, (tx) =>
        tx
          .update(channelOnboardingSessions)
          .set({ status: 'exchanging' })
          .where(
            and(
              eq(channelOnboardingSessions.tenantId, ctx.tenant.id),
              eq(channelOnboardingSessions.stateHash, sha256Hex(data.state)),
              eq(channelOnboardingSessions.status, 'started'),
              eq(channelOnboardingSessions.createdByUserId, ctx.user.id),
              eq(channelOnboardingSessions.authSessionId, authSessionId),
              gt(channelOnboardingSessions.expiresAt, now),
            ),
          )
          .returning({ id: channelOnboardingSessions.id }),
      );
      if (!session) {
        throw new AppError(
          'precondition_failed',
          'This connection attempt expired or was already used. Start again.',
        );
      }

      let token: string;
      let scopes: string[];
      try {
        const exchanged = await graph.exchangeCode(meta.appId, meta.appSecret, data.code);
        if (!exchanged.ok)
          throw new OnboardingFailure('code_exchange_failed', describeFailure(exchanged));
        token = exchanged.data.accessToken;
        scopes = await verifyGrant(token, data.wabaId, data.phoneNumberId);
      } catch (error) {
        const reason = error instanceof OnboardingFailure ? error.reason : 'verification_error';
        await failSession(ctx, session.id, reason);
        if (error instanceof OnboardingFailure) {
          throw new AppError(
            'provider_rejected',
            `WhatsApp could not be connected: ${error.message}`,
          );
        }
        throw error;
      }

      try {
        return await db.run(ctx.scope, async (tx) => {
          const [existingAccount] = await tx
            .select({ id: whatsappAccounts.id })
            .from(whatsappAccounts)
            .where(
              and(
                eq(whatsappAccounts.tenantId, ctx.tenant.id),
                eq(whatsappAccounts.wabaId, data.wabaId),
              ),
            );
          const whatsappAccountId = existingAccount?.id ?? uuidv7();
          const credential = keyring.encrypt(
            token,
            credentialAad(ctx.tenant.id, whatsappAccountId),
          );
          if (existingAccount) {
            await tx
              .update(whatsappAccounts)
              .set({
                status: 'connected',
                credentialCiphertext: credential,
                grantedScopes: scopes,
                tokenCheckedAt: now,
                ...(data.businessId ? { businessId: data.businessId } : {}),
              })
              .where(
                and(
                  eq(whatsappAccounts.tenantId, ctx.tenant.id),
                  eq(whatsappAccounts.id, whatsappAccountId),
                ),
              );
          } else {
            await tx.insert(whatsappAccounts).values({
              id: whatsappAccountId,
              tenantId: ctx.tenant.id,
              wabaId: data.wabaId,
              businessId: data.businessId ?? null,
              status: 'connected',
              credentialCiphertext: credential,
              grantedScopes: scopes,
              tokenCheckedAt: now,
              connectedByUserId: ctx.user.id,
            });
          }
          await tx.execute(
            sql`select app.bind_provider_asset('meta_whatsapp', 'waba', ${data.wabaId}, ${whatsappAccountId}::uuid, null)`,
          );

          const [existingChannel] = await tx
            .select({
              id: channelAccounts.id,
              whatsappAccountId: channelAccounts.whatsappAccountId,
              status: channelAccounts.status,
              pin: channelAccounts.registrationPinCiphertext,
            })
            .from(channelAccounts)
            .where(
              and(
                eq(channelAccounts.tenantId, ctx.tenant.id),
                eq(channelAccounts.phoneNumberId, data.phoneNumberId),
              ),
            );
          if (existingChannel && existingChannel.whatsappAccountId !== whatsappAccountId) {
            throw new AppError(
              'conflict',
              'This number is connected here under a different WhatsApp Business Account. Disconnect it first.',
            );
          }
          // A new number, or one connected again after it was disconnected, takes a slot of the plan.
          if (
            !existingChannel ||
            !(COUNTED_CHANNEL_STATUSES as readonly string[]).includes(existingChannel.status)
          ) {
            await assertNumberAvailable(tx, ctx.tenant.id);
          }
          const channelAccountId = existingChannel?.id ?? uuidv7();
          const pin =
            existingChannel?.pin ??
            keyring.encrypt(
              String(randomInt(0, 1_000_000)).padStart(6, '0'),
              registrationPinAad(ctx.tenant.id, channelAccountId),
            );
          if (existingChannel) {
            await tx
              .update(channelAccounts)
              .set({
                status: 'onboarding',
                onboardingStep: 'subscribe_app',
                onboardingError: null,
                registrationPinCiphertext: pin,
              })
              .where(
                and(
                  eq(channelAccounts.tenantId, ctx.tenant.id),
                  eq(channelAccounts.id, channelAccountId),
                ),
              );
          } else {
            await tx.insert(channelAccounts).values({
              id: channelAccountId,
              tenantId: ctx.tenant.id,
              whatsappAccountId,
              phoneNumberId: data.phoneNumberId,
              status: 'onboarding',
              onboardingStep: 'subscribe_app',
              registrationPinCiphertext: pin,
            });
          }
          await tx.execute(
            sql`select app.bind_provider_asset('meta_whatsapp', 'phone_number', ${data.phoneNumberId}, ${channelAccountId}::uuid, ${data.wabaId})`,
          );
          await tx
            .update(channelOnboardingSessions)
            .set({ status: 'completed', resultWhatsappAccountId: whatsappAccountId })
            .where(
              and(
                eq(channelOnboardingSessions.tenantId, ctx.tenant.id),
                eq(channelOnboardingSessions.id, session.id),
              ),
            );
          await recordAudit(
            tx,
            ctx,
            {
              action: 'channel.connected',
              subjectType: 'channel',
              subjectId: channelAccountId,
              metadata: {
                wabaId: data.wabaId,
                phoneNumberId: data.phoneNumberId,
                reconnect: Boolean(existingChannel),
              },
            },
            request,
          );
          await emitTenantEvent(tx, ctx.tenant.id, {
            type: 'channel.updated',
            payload: { channelAccountId },
          });
          await deps.jobs.enqueue(
            tx,
            QUEUES.channelOnboard.name,
            deps.signer.sign({
              kind: 'channel.onboard',
              tenantId: ctx.tenant.id,
              actorUserId: ctx.user.id,
              ref: channelAccountId,
            }),
            { singletonKey: channelAccountId },
          );
          return { channelAccountId, whatsappAccountId };
        });
      } catch (error) {
        await failSession(
          ctx,
          session.id,
          error instanceof AppError && error.code === 'conflict'
            ? 'asset_conflict'
            : 'binding_error',
        );
        throw error;
      }
    },

    /** Re-queues setup for a number whose previous attempt failed. */
    async retrySetup(ctx: TenantContext, channelAccountId: string, request: RequestMeta = {}) {
      assertCan(ctx, 'channels.manage');
      if (!z.uuid().safeParse(channelAccountId).success) throw notFound('Channel');
      await db.run(ctx.scope, async (tx) => {
        const [channel] = await tx
          .select({ id: channelAccounts.id, status: channelAccounts.status })
          .from(channelAccounts)
          .where(
            and(
              eq(channelAccounts.tenantId, ctx.tenant.id),
              eq(channelAccounts.id, channelAccountId),
            ),
          )
          .for('update');
        if (!channel) throw notFound('Channel');
        if (channel.status !== 'failed' && channel.status !== 'onboarding') {
          throw new AppError(
            'precondition_failed',
            'Only numbers with incomplete setup can be retried.',
          );
        }
        // A failed number takes no slot of the plan; retrying its setup takes one again.
        if (channel.status === 'failed') await assertNumberAvailable(tx, ctx.tenant.id);
        await tx
          .update(channelAccounts)
          .set({ status: 'onboarding', onboardingError: null })
          .where(
            and(eq(channelAccounts.tenantId, ctx.tenant.id), eq(channelAccounts.id, channel.id)),
          );
        await recordAudit(
          tx,
          ctx,
          { action: 'channel.setup_retried', subjectType: 'channel', subjectId: channel.id },
          request,
        );
        await deps.jobs.enqueue(
          tx,
          QUEUES.channelOnboard.name,
          deps.signer.sign({
            kind: 'channel.onboard',
            tenantId: ctx.tenant.id,
            actorUserId: ctx.user.id,
            ref: channel.id,
          }),
          { singletonKey: channel.id },
        );
      });
    },

    /**
     * Disconnects a number: routing stops immediately (the provider binding is released). When no
     * other number of the WABA remains connected, the WABA binding is released and the stored
     * token erased. Meta-side deregistration is not performed here (docs/META-SETUP.md).
     */
    async disconnect(ctx: TenantContext, channelAccountId: string, request: RequestMeta = {}) {
      assertCan(ctx, 'channels.manage');
      if (!z.uuid().safeParse(channelAccountId).success) throw notFound('Channel');
      await db.run(ctx.scope, async (tx) => {
        const [locked] = await tx
          .select({
            id: channelAccounts.id,
            phoneNumberId: channelAccounts.phoneNumberId,
            whatsappAccountId: channelAccounts.whatsappAccountId,
            status: channelAccounts.status,
          })
          .from(channelAccounts)
          .where(
            and(
              eq(channelAccounts.tenantId, ctx.tenant.id),
              eq(channelAccounts.id, channelAccountId),
            ),
          )
          .for('update');
        const [account] = locked
          ? await tx
              .select({ wabaId: whatsappAccounts.wabaId })
              .from(whatsappAccounts)
              .where(
                and(
                  eq(whatsappAccounts.tenantId, ctx.tenant.id),
                  eq(whatsappAccounts.id, locked.whatsappAccountId),
                ),
              )
          : [];
        const channel = locked && account ? { ...locked, wabaId: account.wabaId } : null;
        if (!channel) throw notFound('Channel');
        if (channel.status === 'disconnected') return;
        await tx
          .update(channelAccounts)
          .set({ status: 'disconnected' })
          .where(
            and(eq(channelAccounts.tenantId, ctx.tenant.id), eq(channelAccounts.id, channel.id)),
          );
        await tx.execute(
          sql`select app.release_provider_asset('meta_whatsapp', 'phone_number', ${channel.phoneNumberId})`,
        );
        const remaining = await tx
          .select({ id: channelAccounts.id })
          .from(channelAccounts)
          .where(
            and(
              eq(channelAccounts.tenantId, ctx.tenant.id),
              eq(channelAccounts.whatsappAccountId, channel.whatsappAccountId),
              ne(channelAccounts.status, 'disconnected'),
            ),
          );
        if (remaining.length === 0) {
          await tx.execute(
            sql`select app.release_provider_asset('meta_whatsapp', 'waba', ${channel.wabaId})`,
          );
          await tx
            .update(whatsappAccounts)
            .set({ status: 'disconnected', credentialCiphertext: null })
            .where(
              and(
                eq(whatsappAccounts.tenantId, ctx.tenant.id),
                eq(whatsappAccounts.id, channel.whatsappAccountId),
              ),
            );
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'channel.disconnected',
            subjectType: 'channel',
            subjectId: channel.id,
            metadata: {
              phoneNumberId: channel.phoneNumberId,
              wabaReleased: remaining.length === 0,
            },
          },
          request,
        );
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: 'channel.updated',
          payload: { channelAccountId: channel.id },
        });
      });
    },

    async listChannels(ctx: TenantContext): Promise<ChannelView[]> {
      assertCan(ctx, 'channels.read');
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: channelAccounts.id,
              whatsappAccountId: channelAccounts.whatsappAccountId,
              wabaId: whatsappAccounts.wabaId,
              phoneNumberId: channelAccounts.phoneNumberId,
              displayPhoneNumber: channelAccounts.displayPhoneNumber,
              verifiedName: channelAccounts.verifiedName,
              status: channelAccounts.status,
              onboardingStep: channelAccounts.onboardingStep,
              onboardingError: channelAccounts.onboardingError,
              qualityRating: channelAccounts.qualityRating,
              nameStatus: channelAccounts.nameStatus,
              healthCheckedAt: channelAccounts.healthCheckedAt,
            })
            .from(channelAccounts)
            .innerJoin(
              whatsappAccounts,
              and(
                eq(whatsappAccounts.tenantId, channelAccounts.tenantId),
                eq(whatsappAccounts.id, channelAccounts.whatsappAccountId),
              ),
            )
            .where(eq(channelAccounts.tenantId, ctx.tenant.id))
            .orderBy(asc(channelAccounts.createdAt)),
        { accessMode: 'read only' },
      );
      return rows.map((r) => ({ ...r, healthCheckedAt: r.healthCheckedAt?.toISOString() ?? null }));
    },
  };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;

export type OnboardingJobOutcome = 'active' | 'failed' | 'needs_reconnect' | 'retry' | 'skipped';

/**
 * Worker side of onboarding: subscribe the app to the WABA's webhooks, register the number with our
 * two-step verification PIN, then read the number's health. Each completed step is persisted, so
 * a retry resumes where the previous attempt stopped.
 */
export async function processChannelOnboarding(
  deps: { db: Database; keyring: Keyring; graph: GraphClient; clock: Clock },
  scope: TenantScope,
  channelAccountId: string,
): Promise<OnboardingJobOutcome> {
  const loaded = await deps.db.run(
    scope,
    async (tx) => {
      const [row] = await tx
        .select({
          id: channelAccounts.id,
          status: channelAccounts.status,
          step: channelAccounts.onboardingStep,
          phoneNumberId: channelAccounts.phoneNumberId,
          pin: channelAccounts.registrationPinCiphertext,
          whatsappAccountId: channelAccounts.whatsappAccountId,
          wabaId: whatsappAccounts.wabaId,
          credential: whatsappAccounts.credentialCiphertext,
        })
        .from(channelAccounts)
        .innerJoin(
          whatsappAccounts,
          and(
            eq(whatsappAccounts.tenantId, channelAccounts.tenantId),
            eq(whatsappAccounts.id, channelAccounts.whatsappAccountId),
          ),
        )
        .where(
          and(
            eq(channelAccounts.tenantId, scope.tenantId),
            eq(channelAccounts.id, channelAccountId),
          ),
        );
      return row ?? null;
    },
    { accessMode: 'read only' },
  );
  if (!loaded || loaded.status !== 'onboarding') return 'skipped';

  const update = async (
    values: Partial<typeof channelAccounts.$inferInsert>,
    extra?: (tx: Tx) => Promise<void>,
  ) =>
    deps.db.run(scope, async (tx) => {
      await tx
        .update(channelAccounts)
        .set(values)
        .where(
          and(eq(channelAccounts.tenantId, scope.tenantId), eq(channelAccounts.id, loaded.id)),
        );
      if (extra) await extra(tx);
      await emitTenantEvent(tx, scope.tenantId, {
        type: 'channel.updated',
        payload: { channelAccountId: loaded.id },
      });
    });

  const handleFailure = async (
    result: Extract<GraphResult<never>, { ok: false }>,
    step: string,
  ): Promise<OnboardingJobOutcome> => {
    if (result.kind === 'auth') {
      await update(
        {
          status: 'needs_reconnect',
          onboardingError: 'Meta rejected the stored token. Reconnect WhatsApp.',
        },
        (tx) =>
          tx
            .update(whatsappAccounts)
            .set({ status: 'needs_reconnect' })
            .where(
              and(
                eq(whatsappAccounts.tenantId, scope.tenantId),
                eq(whatsappAccounts.id, loaded.whatsappAccountId),
              ),
            )
            .then(() => undefined),
      );
      return 'needs_reconnect';
    }
    if (result.kind === 'retryable' || result.kind === 'unknown') return 'retry';
    const blocked = result.code === 133016;
    await update(
      {
        status: 'failed',
        onboardingError: blocked
          ? 'Meta temporarily blocked registration for this number after too many attempts (72 hours).'
          : `Setup failed at ${step}: ${describeFailure(result)}`.slice(0, 1000),
      },
      (tx) =>
        recordSystemAudit(tx, scope.tenantId, {
          action: 'channel.setup_failed',
          subjectType: 'channel',
          subjectId: loaded.id,
          result: 'failure',
          metadata: { step, code: result.code ?? null },
        }),
    );
    return 'failed';
  };

  if (!loaded.credential) {
    await update({
      status: 'needs_reconnect',
      onboardingError: 'No stored token. Reconnect WhatsApp.',
    });
    return 'needs_reconnect';
  }
  const token = deps.keyring.decryptString(
    loaded.credential,
    credentialAad(scope.tenantId, loaded.whatsappAccountId),
  );
  let step = loaded.step ?? 'subscribe_app';

  if (step === 'subscribe_app') {
    const result = await deps.graph.subscribeApp(loaded.wabaId, token);
    if (!result.ok) return handleFailure(result, 'subscribe_app');
    step = 'register_number';
    await update({ onboardingStep: step });
  }
  if (step === 'register_number') {
    if (!loaded.pin) {
      await update({
        status: 'failed',
        onboardingError: 'Registration PIN missing; reconnect the number.',
      });
      return 'failed';
    }
    const pin = deps.keyring.decryptString(
      loaded.pin,
      registrationPinAad(scope.tenantId, loaded.id),
    );
    const result = await deps.graph.registerNumber(loaded.phoneNumberId, token, pin);
    if (!result.ok) return handleFailure(result, 'register_number');
    step = 'health_check';
    await update({ onboardingStep: step });
  }
  if (step === 'health_check' || step === 'done') {
    const result = await deps.graph.getPhoneNumber(loaded.phoneNumberId, token);
    if (!result.ok) return handleFailure(result, 'health_check');
    await update(
      {
        status: 'active',
        onboardingStep: 'done',
        onboardingError: null,
        displayPhoneNumber: result.data.displayPhoneNumber,
        verifiedName: result.data.verifiedName,
        qualityRating: result.data.qualityRating,
        nameStatus: result.data.nameStatus,
        codeVerificationStatus: result.data.codeVerificationStatus,
        healthCheckedAt: deps.clock.now(),
      },
      (tx) =>
        recordSystemAudit(tx, scope.tenantId, {
          action: 'channel.activated',
          subjectType: 'channel',
          subjectId: loaded.id,
        }),
    );
    return 'active';
  }
  return 'skipped';
}
