import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import {
  createApiKeysService,
  createBillingService,
  createCommerceService,
  createCompanyDeletionService,
  createTenancyService,
  createWebhooksService,
  resolveTenantContext,
  writeCompanyExport,
  type TenantContext,
} from '@w360/domain';
import type { TestUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Step-up re-authentication (ADR-056) against real PostgreSQL: every action that hands out
 * credentials, moves money, takes or destroys the whole company's data, or weakens account
 * security refuses a member who signed in more than 15 minutes ago, before it changes anything;
 * the same member may do it right after signing in again; changes in the safe direction (turning
 * things off, revoking, cancelling) never need it.
 */
const APP_BASE = 'http://127.0.0.1:3999';

let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  await fx?.close();
});

const outbox = () => ({ keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer });
const deps = () => ({ ...outbox(), db: fx.dbs.app, clock: systemClock, appBaseUrl: APP_BASE });
const services = () => ({
  keys: createApiKeysService({ db: fx.dbs.app, clock: systemClock }),
  webhooks: createWebhooksService({
    db: fx.dbs.app,
    clock: systemClock,
    keyring: fx.keyring,
    egressPolicy: { allowLoopbackForTests: false },
  }),
  billing: createBillingService({
    db: fx.dbs.app,
    clock: systemClock,
    razorpay: null,
    razorpayConfig: null,
    notices: { outbox: outbox(), appBaseUrl: APP_BASE },
  }),
  commerce: createCommerceService({
    ...outbox(),
    db: fx.dbs.app,
    clock: systemClock,
    appBaseUrl: APP_BASE,
    allowLiveKeys: false,
  }),
  tenancy: createTenancyService({
    ...outbox(),
    db: fx.dbs.app,
    clock: systemClock,
    appBaseUrl: APP_BASE,
    invitationTtlHours: 24,
  }),
  deletion: createCompanyDeletionService(deps()),
});

/** The member's context as a browser session that started `minutesAgo` minutes ago. */
function signedIn(c: Company, user: TestUser, minutesAgo: number | null): Promise<TenantContext> {
  return resolveTenantContext(
    { db: fx.dbs.app, clock: systemClock, mfaGracePeriodHours: 72 },
    {
      userId: user.id,
      sessionId: `sess_${user.id}`,
      sessionCreatedAt: minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000),
      tenantSlug: c.tenant.slug,
      correlationId: uuidv7(),
    },
  );
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

/** Resolves when the call passed the step-up check (it may still fail a later check). */
async function passesStepUp(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error) && error.code === 'step_up_required') {
      throw new Error('refused for step-up', { cause: error });
    }
  }
}

const AUTO_RECHARGE = {
  thresholdMinor: 50_000,
  amountMinor: 100_000,
  dailyCapMinor: 200_000,
  monthlyCapMinor: 500_000,
};
const PAYMENT_KEYS = {
  keyId: 'rzp_test_StepUp00000001',
  keySecret: 'step-up-key-secret-000000000001',
  webhookSecret: 'step-up-webhook-secret-00001',
};
const exportTo = (ctx: TenantContext) => writeCompanyExport(deps(), ctx, async () => undefined);
const count = async (sql: string, params: unknown[]) =>
  Number((await fx.query<{ n: string }>(sql, params))[0]!.n);

describe('step-up re-authentication', () => {
  it('refuses every protected action to a member who signed in more than 15 minutes ago, before it changes anything', async () => {
    const c = await fx.company();
    const svc = services();
    const fresh = await signedIn(c, c.owner, 0);
    // Things to rotate and update, made while signed in recently.
    const key = await svc.keys.create(fresh, {
      name: 'Orders',
      scopes: ['contacts.read'],
      expiresInDays: 30,
    });
    const endpoint = await svc.webhooks.create(fresh, {
      url: 'https://hooks.example.com/w360',
      eventTypes: ['message.received'],
    });
    await svc.tenancy.updateSecurity(fresh, { requireMfaAllMembers: true });
    const [agentMembership] = await fx.query<{ id: string }>(
      'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
      [c.tenant.id, c.agent.id],
    );

    const stale = await signedIn(c, c.owner, 16);
    const auditBefore = await count(
      'SELECT count(*) AS n FROM app.audit_events WHERE tenant_id = $1',
      [c.tenant.id],
    );
    await expectCode(exportTo(stale), 'step_up_required');
    await expectCode(svc.deletion.request(stale, { confirm: c.tenant.slug }), 'step_up_required');
    await expectCode(
      svc.billing.startMandateSetup(stale, {
        maxAmountMinor: 1_500_000,
        email: 'billing@example.test',
        contact: '+91 90000 00001',
      }),
      'step_up_required',
    );
    await expectCode(
      svc.billing.updateAutoRecharge(stale, { enabled: true, ...AUTO_RECHARGE }),
      'step_up_required',
    );
    await expectCode(svc.commerce.savePaymentAccount(stale, PAYMENT_KEYS), 'step_up_required');
    await expectCode(
      svc.keys.create(stale, { name: 'More', scopes: ['contacts.read'], expiresInDays: 30 }),
      'step_up_required',
    );
    await expectCode(
      svc.keys.rotate(stale, { keyId: key.id, overlapHours: 0 }),
      'step_up_required',
    );
    await expectCode(
      svc.webhooks.create(stale, {
        url: 'https://elsewhere.example.com/hook',
        eventTypes: ['message.received'],
      }),
      'step_up_required',
    );
    await expectCode(
      svc.webhooks.update(stale, {
        endpointId: endpoint.id,
        url: 'https://elsewhere.example.com/hook',
        eventTypes: ['message.received'],
      }),
      'step_up_required',
    );
    await expectCode(
      svc.webhooks.rotateSecret(stale, { endpointId: endpoint.id }),
      'step_up_required',
    );
    await expectCode(
      svc.tenancy.createInvitation(stale, { email: 'new.owner@example.test', roles: ['owner'] }),
      'step_up_required',
    );
    await expectCode(
      svc.tenancy.changeMemberRoles(stale, {
        membershipId: agentMembership!.id,
        roles: ['owner'],
      }),
      'step_up_required',
    );
    await expectCode(
      svc.tenancy.updateSecurity(stale, { requireMfaAllMembers: false }),
      'step_up_required',
    );

    // Nothing changed and nothing was recorded.
    expect(
      await count('SELECT count(*) AS n FROM app.audit_events WHERE tenant_id = $1', [c.tenant.id]),
    ).toBe(auditBefore);
    const [tenant] = await fx.query<{ status: string; require_mfa_all_members: boolean }>(
      'SELECT status, require_mfa_all_members FROM app.tenants WHERE id = $1',
      [c.tenant.id],
    );
    expect(tenant).toEqual({ status: 'active', require_mfa_all_members: true });
    expect(
      await count('SELECT count(*) AS n FROM app.api_keys WHERE tenant_id = $1', [c.tenant.id]),
    ).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM app.webhook_endpoints WHERE tenant_id = $1', [
        c.tenant.id,
      ]),
    ).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM app.commerce_payment_accounts WHERE tenant_id = $1', [
        c.tenant.id,
      ]),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM app.invitations WHERE tenant_id = $1', [c.tenant.id]),
    ).toBe(2); // the fixture's agent and marketer invitations only
    const [agent] = await fx.query<{ roles: string[] }>(
      'SELECT roles FROM app.memberships WHERE id = $1',
      [agentMembership!.id],
    );
    expect(agent!.roles).toEqual(['agent']);

    // A context without a sign-in time (not a browser session) is never recent.
    await expectCode(
      svc.keys.create(await signedIn(c, c.owner, null), {
        name: 'No session',
        scopes: ['contacts.read'],
        expiresInDays: 30,
      }),
      'step_up_required',
    );
  });

  it('lets the member do them right after signing in again', async () => {
    const c = await fx.company();
    const svc = services();
    const again = await signedIn(c, c.owner, 1);
    let lines = 0;
    await writeCompanyExport(deps(), again, async () => {
      lines += 1;
    });
    expect(lines).toBeGreaterThan(2);
    const key = await svc.keys.create(again, {
      name: 'Orders',
      scopes: ['contacts.read'],
      expiresInDays: 30,
    });
    await svc.keys.rotate(again, { keyId: key.id, overlapHours: 0 });
    const endpoint = await svc.webhooks.create(again, {
      url: 'https://hooks.example.com/w360',
      eventTypes: ['message.received'],
    });
    await svc.webhooks.rotateSecret(again, { endpointId: endpoint.id });
    await svc.commerce.savePaymentAccount(again, PAYMENT_KEYS);
    // These reach their own next checks (no Razorpay here, no card for automatic top-ups).
    await passesStepUp(
      svc.billing.startMandateSetup(again, {
        maxAmountMinor: 1_500_000,
        email: 'billing@example.test',
        contact: '+91 90000 00001',
      }),
    );
    await passesStepUp(svc.billing.updateAutoRecharge(again, { enabled: true, ...AUTO_RECHARGE }));
    await svc.tenancy.createInvitation(again, {
      email: 'second.owner@example.test',
      roles: ['owner'],
    });
    const [agentMembership] = await fx.query<{ id: string }>(
      'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
      [c.tenant.id, c.agent.id],
    );
    await svc.tenancy.changeMemberRoles(again, {
      membershipId: agentMembership!.id,
      roles: ['owner'],
    });
    await svc.tenancy.updateSecurity(again, { requireMfaAllMembers: true });
    await svc.tenancy.updateSecurity(await signedIn(c, c.owner, 2), {
      requireMfaAllMembers: false,
    });
    await svc.deletion.request(again, { confirm: c.tenant.slug });
    const [tenant] = await fx.query<{ status: string }>(
      'SELECT status FROM app.tenants WHERE id = $1',
      [c.tenant.id],
    );
    expect(tenant!.status).toBe('pending_deletion');
  });

  it('never asks for changes in the safe direction', async () => {
    const c = await fx.company();
    const svc = services();
    const fresh = await signedIn(c, c.owner, 0);
    const key = await svc.keys.create(fresh, {
      name: 'Orders',
      scopes: ['contacts.read'],
      expiresInDays: 30,
    });
    const endpoint = await svc.webhooks.create(fresh, {
      url: 'https://hooks.example.com/w360',
      eventTypes: ['message.received'],
    });
    const [agentMembership] = await fx.query<{ id: string }>(
      'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
      [c.tenant.id, c.agent.id],
    );

    const stale = await signedIn(c, c.owner, 90);
    await svc.billing.updateAutoRecharge(stale, { enabled: false, ...AUTO_RECHARGE });
    await svc.keys.revoke(stale, { keyId: key.id });
    await svc.webhooks.setEnabled(stale, { endpointId: endpoint.id, enabled: false });
    await svc.webhooks.remove(stale, { endpointId: endpoint.id });
    await svc.tenancy.createInvitation(stale, { email: 'agent2@example.test', roles: ['agent'] });
    await svc.tenancy.changeMemberRoles(stale, {
      membershipId: agentMembership!.id,
      roles: ['marketer'],
    });
    await svc.tenancy.updateSecurity(stale, { requireMfaAllMembers: true });
    // Keeping the requirement off when it is already off is not a change either.
    const other = await fx.company();
    await services().tenancy.updateSecurity(await signedIn(other, other.owner, 90), {
      requireMfaAllMembers: false,
    });
    // A scheduled deletion is cancelled without signing in again.
    await svc.deletion.request(await signedIn(c, c.owner, 0), { confirm: c.tenant.slug });
    expect(await svc.deletion.cancel(await signedIn(c, c.owner, 90))).toEqual({
      status: 'active',
    });
  });
});
