import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, uuidv7 } from '@w360/core';
import { authenticatedUserScope, authorizedTenantScope, sql, systemScope } from '@w360/db';
import {
  acceptInvitation,
  connectTestDatabases,
  createTenant,
  createUser,
  invite,
  twoTenantFixture,
  type TestDatabases,
} from './helpers';

/**
 * Phase 1 gate: two-tenant adversarial isolation suite. Every test attacks the database as the
 * runtime role (w360_app) the application uses, so a failure here means a real isolation gap.
 */
let dbs: TestDatabases;
let fx: Awaited<ReturnType<typeof twoTenantFixture>>;

beforeAll(async () => {
  dbs = connectTestDatabases();
  fx = await twoTenantFixture(dbs);
});

afterAll(async () => {
  await dbs.close();
});

const scopeA = () => authorizedTenantScope(fx.tenantA.id, fx.ownerA.id);
const scopeB = () => authorizedTenantScope(fx.tenantB.id, fx.ownerB.id);

describe('database roles', () => {
  it('runtime roles are not superusers, cannot bypass RLS and own no protected tables', async () => {
    for (const pool of [dbs.appPool, dbs.authPool, dbs.platformPool]) {
      const role = await pool.query(
        `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(role.rows[0].rolsuper).toBe(false);
      expect(role.rows[0].rolbypassrls).toBe(false);
      const owned = await pool.query(
        `SELECT count(*)::int AS n FROM pg_tables WHERE tableowner = current_user AND schemaname IN ('app','auth','ops','pgboss')`,
      );
      expect(owned.rows[0].n).toBe(0);
    }
  });

  it('the runtime role cannot assume the owner or definer roles', async () => {
    await expect(dbs.appPool.query('SET ROLE w360_owner')).rejects.toThrow(/permission denied/);
    await expect(dbs.appPool.query('SET ROLE w360_definer')).rejects.toThrow(/permission denied/);
  });

  it('every tenant-owned table enforces forced row level security', async () => {
    const res = await dbs.adminPool.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
       WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')`);
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      expect({
        table: row.relname,
        rls: row.relrowsecurity,
        forced: row.relforcerowsecurity,
      }).toEqual({
        table: row.relname,
        rls: true,
        forced: true,
      });
    }
    const tenants = await dbs.adminPool.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'app.tenants'::regclass`,
    );
    expect(tenants.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('tenant_id columns are NOT NULL on every tenant-owned app table', async () => {
    const res = await dbs.adminPool.query(`
      SELECT c.relname FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND a.attname = 'tenant_id' AND NOT a.attnotnull AND c.relkind IN ('r','p')`);
    expect(res.rows).toEqual([]);
  });

  it('SECURITY DEFINER functions pin their search_path', async () => {
    const res = await dbs.adminPool.query(`
      SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('app','ops') AND p.prosecdef`);
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      expect(row.proconfig ?? [], row.proname).toContain('search_path=pg_catalog, pg_temp');
    }
  });

  it('no function is executable by PUBLIC; each runtime role reaches only its granted functions', async () => {
    const open = await dbs.adminPool.query(`
      SELECT p.oid::regprocedure::text AS fn FROM pg_proc p
       WHERE p.pronamespace IN ('app'::regnamespace, 'ops'::regnamespace)
         AND has_function_privilege('public', p.oid, 'EXECUTE')`);
    expect(open.rows).toEqual([]);
    const can = async (role: string, fn: string) =>
      (
        await dbs.adminPool.query<{ ok: boolean }>(
          `SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`,
          [role, fn],
        )
      ).rows[0]!.ok;
    const createTenant = 'app.create_tenant(uuid,uuid,text,text,text,text)';
    const resetMfa = 'ops.platform_reset_user_mfa(text,text)';
    expect(await can('w360_app', createTenant)).toBe(true);
    expect(await can('w360_app', 'app.accept_invitation(text,uuid)')).toBe(true);
    expect(await can('w360_app', 'app.tenant_status(uuid)')).toBe(true);
    expect(await can('w360_auth', createTenant)).toBe(false);
    expect(await can('w360_platform', createTenant)).toBe(false);
    expect(await can('w360_platform', resetMfa)).toBe(true);
    expect(await can('w360_app', resetMfa)).toBe(false);
    expect(await can('w360_auth', resetMfa)).toBe(false);
    // Contact erasure and the template, campaign and order message sweeps: runtime app role only.
    for (const fn of [
      'app.erase_contact(uuid,boolean)',
      'ops.template_sync_due(integer)',
      'ops.campaigns_due(integer)',
      'ops.commerce_store_messages_due(integer)',
    ]) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    // Plans (0023): the sweep functions for the worker (with the API request notice of 0035, the
    // warnings of 0036, the subscription functions of 0037, the rate change notices of 0038, the
    // notices of staff changes and cancellations of 0077 and 0078, the refunds of plan payments of
    // 0080, and the company's own choice of a plan of 0082 and of add-ons of 0084, with API request
    // packs since 0088), the usage counts for platform staff, the entitlements for both, and the
    // plan-state triggers for nobody.
    for (const fn of [
      'ops.plan_transitions_due(integer)',
      'ops.usage_limits_reached(integer)',
      'ops.api_quota_reached(integer)',
      'ops.usage_warnings_due(integer)',
      'app.apply_plan_transition(uuid)',
      'ops.billing_resolve_subscription(text)',
      'ops.billing_resolve_plan_payment(text)',
      'app.apply_plan_subscription_period(uuid,uuid)',
      'ops.rate_change_notices_due(integer,integer)',
      'ops.plan_change_notices_due(integer)',
      'app.take_plan_change_notice()',
      'ops.plan_subscription_cancel_notices_due(integer)',
      'app.take_plan_subscription_cancel_notice(uuid)',
      'ops.plan_payment_refunds_due(integer)',
      'app.record_plan_payment_refund(text,text,bigint,uuid)',
      'app.choose_plan(uuid)',
      'app.choose_add_ons(integer,integer,integer)',
      'app.choose_add_ons(integer,integer,integer,integer)',
    ]) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    // Refunds of plan payments (0080) are asked for by platform owners only.
    const planRefund = 'ops.platform_request_plan_payment_refund(uuid,uuid,bigint,text,text)';
    expect(await can('w360_platform', planRefund)).toBe(true);
    expect(await can('w360_app', planRefund)).toBe(false);
    expect(await can('w360_auth', planRefund)).toBe(false);
    expect(await can('w360_platform', 'ops.platform_tenant_usage(uuid)')).toBe(true);
    expect(await can('w360_app', 'ops.platform_tenant_usage(uuid)')).toBe(false);
    expect(await can('w360_app', 'app.tenant_entitlements(uuid)')).toBe(true);
    expect(await can('w360_platform', 'app.tenant_entitlements(uuid)')).toBe(true);
    expect(await can('w360_auth', 'app.tenant_entitlements(uuid)')).toBe(false);
    // Public API (0024): the key lookup and the idempotency sweep, for the runtime app role only,
    // and the listing of keys due an expiry reminder (0040), for the worker. The lookup with the
    // client's address (0051) replaced the one without, which 0074 drops.
    for (const fn of [
      'ops.api_key_authenticate(text,inet)',
      'ops.purge_api_idempotency_keys(integer)',
      'ops.api_key_expiry_reminders_due(integer,integer)',
      // The counters due an email about a key's own limit (0075), for the worker.
      'ops.api_key_usage_notices_due(integer)',
      // The purge of full rate limit buckets (0041), for the worker.
      'ops.purge_rate_limit_buckets(integer)',
    ]) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    // Reconciliation alerts (0039): the listing, the mark and the platform owners' addresses, for
    // the worker only.
    for (const fn of [
      'ops.settlement_recon_alerts_due(integer)',
      'ops.settlement_recon_mark_alerted(uuid,integer)',
      'ops.settlement_recon_alert_recipients()',
      // Alerts for payments no settlement showed (0043).
      'ops.settlement_unsettled_alerts_due(integer)',
      'ops.settlement_mark_unsettled_alerted(text[])',
    ]) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    // The shared definition of an unsettled payment (0043) runs only inside definer functions.
    for (const role of ['w360_app', 'w360_auth', 'w360_platform']) {
      expect(await can(role, 'ops.settlement_unsettled_topups()'), role).toBe(false);
    }
    // Refund requests (0046, and of plan payments 0081): the notice sweeps and the platform owners'
    // addresses for the worker, and the decline marks in the company's scope; the lists and the
    // decisions for platform staff.
    for (const fn of [
      'ops.platform_owner_recipients()',
      'ops.credit_refund_requests_to_announce(integer)',
      'ops.credit_refund_requests_mark_announced(uuid[])',
      'ops.credit_refund_request_declines_due(integer)',
      'app.credit_refund_request_mark_decline_notified(uuid)',
      'ops.plan_payment_refund_requests_to_announce(integer)',
      'ops.plan_payment_refund_requests_mark_announced(uuid[])',
      'ops.plan_payment_refund_request_declines_due(integer)',
      'app.plan_payment_refund_request_mark_decline_notified(uuid)',
    ]) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    for (const fn of [
      'ops.platform_credit_refund_requests(text,timestamp with time zone,uuid,integer)',
      'ops.platform_credit_refunds(timestamp with time zone,uuid,integer)',
      'ops.platform_decide_credit_refund_request(uuid,boolean,text,text)',
      'ops.platform_plan_payment_refund_requests(text,timestamp with time zone,uuid,integer)',
      'ops.platform_plan_payment_refunds(timestamp with time zone,uuid,integer)',
      'ops.platform_decide_plan_payment_refund_request(uuid,boolean,text,text)',
    ]) {
      expect(await can('w360_platform', fn), fn).toBe(true);
      expect(await can('w360_app', fn), fn).toBe(false);
      expect(await can('w360_auth', fn), fn).toBe(false);
    }
    // Company deletion started by staff (0067): scheduling and cancelling for platform staff; the
    // notice sweep, its mark and owners' cancelling for the runtime app role; the shared rule for the
    // status a cancelled deletion restores only inside the definer functions.
    for (const fn of [
      'ops.platform_request_tenant_deletion(uuid,text,text,text)',
      'ops.platform_cancel_tenant_deletion(uuid,text,text)',
    ]) {
      expect(await can('w360_platform', fn), fn).toBe(true);
      expect(await can('w360_app', fn), fn).toBe(false);
      expect(await can('w360_auth', fn), fn).toBe(false);
    }
    for (const fn of [
      'ops.tenant_deletion_notices_due(integer)',
      'app.tenant_deletion_mark_notified(uuid,text)',
      'app.cancel_tenant_deletion()',
    ]) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    for (const role of ['w360_app', 'w360_auth', 'w360_platform']) {
      expect(await can(role, 'ops.tenant_status_after_deletion(uuid,text,text)'), role).toBe(false);
    }
    // Alerts for work that failed for good (0068): the count, the mark and the recipients for the
    // runtime app role (the worker's sweep); the rule for a used-up receipt for the worker and the
    // operations console; the receipt retry, replaced, still for platform staff only.
    for (const fn of [
      'ops.failure_alerts_due()',
      'ops.mark_failure_alert()',
      'ops.platform_failure_alert_recipients()',
    ]) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    // Late queues (0072): the check's record and the alert's mark for the worker's sweep only.
    for (const fn of ['ops.record_queue_waits(jsonb)', 'ops.mark_queue_alert()']) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    const rule = 'ops.webhook_receipt_exhausted(text,integer,timestamp with time zone)';
    expect(await can('w360_app', rule)).toBe(true);
    expect(await can('w360_platform', rule)).toBe(true);
    expect(await can('w360_auth', rule)).toBe(false);
    // Outgoing webhooks (0025, 0047, 0096): the dispatch and retention sweeps for the worker;
    // capture, which the triggers call as the role making the change (the runtime role, or a
    // definer function), and adding what a contact's change changed to the event its transaction
    // captured; the trigger functions for nobody.
    for (const fn of ['ops.webhook_dispatch_due(integer)', 'ops.purge_webhook_data(integer)']) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    for (const fn of [
      'app.webhook_subscribed(uuid,text)',
      'app.capture_webhook_event(uuid,text,uuid,uuid,uuid,uuid,text,jsonb,timestamp with time zone)',
      'app.capture_contact_webhook_event(uuid,uuid,text,text[])',
      'app.add_contact_webhook_changes(uuid,uuid,text[])',
    ]) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_definer', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    for (const fn of [
      'app.notify_webhook_delivery()',
      'app.webhook_capture_message()',
      'app.webhook_capture_consent()',
      'app.webhook_capture_template()',
      'app.webhook_capture_conversation()',
      'app.webhook_capture_contact()',
      'app.webhook_capture_contact_tag()',
      'app.webhook_capture_contact_fields()',
    ]) {
      for (const role of ['w360_app', 'w360_auth', 'w360_platform']) {
        expect(await can(role, fn), `${role} ${fn}`).toBe(false);
      }
    }
    // The plan-state triggers, and the guards of a subscription that follows another (0087) and of
    // one that follows none (0088).
    for (const fn of [
      'app.sync_tenant_plan_access()',
      'app.init_tenant_plan()',
      'app.guard_plan_subscription_follow()',
      'app.guard_plan_subscription_start()',
    ]) {
      for (const role of ['w360_app', 'w360_auth', 'w360_platform']) {
        expect(await can(role, fn), `${role} ${fn}`).toBe(false);
      }
    }
    // Platform operations (0026): the read functions, the receipt retry and the dead letter retry
    // (0086) for platform staff only; the dead-letter purge for the worker; the URL host helper for
    // the definer functions.
    for (const fn of [
      'ops.platform_ops_health(uuid)',
      'ops.platform_ops_activity(timestamp with time zone,uuid)',
      'ops.platform_ops_signup_sessions(timestamp with time zone,integer)',
      'ops.platform_ops_integration_failures(integer)',
      'ops.platform_retry_webhook_receipt(uuid,text,text)',
      'ops.platform_retry_dead_letter(uuid,text,text)',
    ]) {
      expect(await can('w360_platform', fn), fn).toBe(true);
      expect(await can('w360_app', fn), fn).toBe(false);
      expect(await can('w360_auth', fn), fn).toBe(false);
    }
    expect(await can('w360_app', 'ops.purge_dead_letters(integer)')).toBe(true);
    expect(await can('w360_platform', 'ops.purge_dead_letters(integer)')).toBe(false);
    // Settling work whose job ran out of retries (0089): the sweep's lookup and the mark for the
    // worker only; whether a job is waiting or running again for the definer functions only.
    for (const fn of [
      'ops.dead_letters_to_settle(integer)',
      'ops.settle_dead_letter(uuid,boolean)',
    ]) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    expect(await can('w360_definer', 'ops.dead_letter_work_live(text,text)')).toBe(true);
    for (const role of ['w360_app', 'w360_auth', 'w360_platform']) {
      expect(await can(role, 'ops.dead_letter_work_live(text,text)'), role).toBe(false);
    }
    expect(await can('w360_definer', 'ops.url_host(text)')).toBe(true);
    for (const role of ['w360_app', 'w360_auth', 'w360_platform']) {
      expect(await can(role, 'ops.url_host(text)'), role).toBe(false);
    }
    // Company deletion (0028): requesting, cancelling and running it for the runtime role only;
    // the helper naming the company being deleted for the definer functions only.
    for (const fn of [
      'app.request_tenant_deletion(text)',
      'app.cancel_tenant_deletion()',
      'ops.tenant_deletions_due(integer)',
      'ops.start_tenant_deletion(uuid)',
      'ops.record_tenant_deletion_cleanup(uuid,jsonb)',
      'ops.delete_tenant_data(uuid,integer)',
      'ops.finish_tenant_deletion(uuid)',
    ]) {
      expect(await can('w360_app', fn), fn).toBe(true);
      expect(await can('w360_auth', fn), fn).toBe(false);
      expect(await can('w360_platform', fn), fn).toBe(false);
    }
    expect(await can('w360_definer', 'ops.deleting_tenant_id()')).toBe(true);
    for (const role of ['w360_app', 'w360_auth', 'w360_platform']) {
      expect(await can(role, 'ops.deleting_tenant_id()'), role).toBe(false);
    }
    await expect(
      dbs.appPool.query(
        `SELECT ops.platform_reset_user_mfa('usr_x', 'Verified identity by phone')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('rate cards: the platform role drafts and publishes them, companies read published ones only', async () => {
    const [admin] = (await dbs.adminPool.query<{ id: string }>(`SELECT id FROM auth.users LIMIT 1`))
      .rows;
    const draft = await dbs.platformPool.query<{ id: string }>(
      `INSERT INTO ops.rate_cards (id, currency, effective_from, source_url, created_by_user_id)
       VALUES (gen_random_uuid(), 'EUR', now(), 'https://example.test/eur', $1) RETURNING id`,
      [admin!.id],
    );
    const id = draft.rows[0]!.id;
    const visible = async () =>
      (await dbs.appPool.query(`SELECT id FROM ops.rate_cards WHERE id = $1`, [id])).rows.length;
    expect(await visible()).toBe(0);
    await dbs.platformPool.query(
      `INSERT INTO ops.rate_card_prefixes (rate_card_id, prefix, market) VALUES ($1, '49', 'Germany')`,
      [id],
    );
    await dbs.platformPool.query(
      `INSERT INTO ops.rate_card_prices (rate_card_id, market, category, price_micros) VALUES ($1, 'Germany', 'marketing', 1)`,
      [id],
    );
    await dbs.platformPool.query(`UPDATE ops.rate_cards SET status = 'published' WHERE id = $1`, [
      id,
    ]);
    expect(await visible()).toBe(1);
    await expect(
      dbs.appPool.query(
        `INSERT INTO ops.rate_card_prices (rate_card_id, market, category, price_micros) VALUES ($1, 'Germany', 'utility', 1)`,
        [id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      dbs.platformPool.query(`DELETE FROM ops.rate_card_prices WHERE rate_card_id = $1`, [id]),
    ).rejects.toThrow(/permission denied/);
    await dbs.platformPool.query(`UPDATE ops.rate_cards SET status = 'withdrawn' WHERE id = $1`, [
      id,
    ]);
    await expect(
      dbs.platformPool.query(`UPDATE ops.rate_cards SET status = 'published' WHERE id = $1`, [id]),
    ).rejects.toThrow(/invalid rate card status change/);
  });

  it('the auth role cannot read company data and the app role cannot read credentials', async () => {
    await expect(dbs.authPool.query('SELECT * FROM app.tenants')).rejects.toThrow(
      /permission denied/,
    );
    await expect(dbs.appPool.query('SELECT password FROM auth.accounts')).rejects.toThrow(
      /permission denied/,
    );
    await expect(dbs.appPool.query('SELECT token FROM auth.sessions')).rejects.toThrow(
      /permission denied/,
    );
    await expect(dbs.appPool.query('SELECT secret FROM auth.two_factors')).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('missing or invalid context fails closed', () => {
  it('system scope sees no tenant rows', async () => {
    const counts = await dbs.app.run(systemScope, async (tx) => {
      const r = await tx.execute<{ t: number; m: number; i: number; a: number }>(sql`
        select (select count(*)::int from app.tenants) as t,
               (select count(*)::int from app.memberships) as m,
               (select count(*)::int from app.invitations) as i,
               (select count(*)::int from app.audit_events) as a`);
      return r.rows[0];
    });
    expect(counts).toEqual({ t: 0, m: 0, i: 0, a: 0 });
  });

  it('system scope cannot insert tenant rows', async () => {
    await expect(
      dbs.app.run(systemScope, (tx) =>
        tx.execute(sql`insert into app.audit_events (tenant_id, actor_type, action, result)
                        values (${fx.tenantA.id}::uuid, 'system', 'probe.insert', 'success')`),
      ),
    ).rejects.toThrow();
  });

  it('a malformed tenant setting raises instead of matching anything', async () => {
    const client = await dbs.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', 'not-a-uuid', true)`);
      await expect(client.query('SELECT count(*) FROM app.invitations')).rejects.toThrow(
        /invalid input syntax for type uuid/,
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('raw connections without our scope wrapper see nothing', async () => {
    const r = await dbs.appPool.query('SELECT count(*)::int AS n FROM app.memberships');
    expect(r.rows[0].n).toBe(0);
  });
});

describe('cross-tenant access through guessed identifiers', () => {
  it('reads by id across tenants return nothing', async () => {
    const result = await dbs.app.run(scopeA(), async (tx) => {
      const tenant = await tx.execute(
        sql`select id from app.tenants where id = ${fx.tenantB.id}::uuid`,
      );
      const membership = await tx.execute(
        sql`select id from app.memberships where id = ${fx.tenantB.ownerMembershipId}::uuid`,
      );
      const audit = await tx.execute(
        sql`select id from app.audit_events where tenant_id = ${fx.tenantB.id}::uuid`,
      );
      return {
        tenant: tenant.rows.length,
        membership: membership.rows.length,
        audit: audit.rows.length,
      };
    });
    expect(result).toEqual({ tenant: 0, membership: 0, audit: 0 });
  });

  it('updates across tenants affect zero rows', async () => {
    const affected = await dbs.app.run(scopeA(), async (tx) => {
      const t = await tx.execute(
        sql`update app.tenants set name = 'pwned' where id = ${fx.tenantB.id}::uuid`,
      );
      const m = await tx.execute(
        sql`update app.memberships set status = 'suspended' where id = ${fx.tenantB.ownerMembershipId}::uuid`,
      );
      return { t: t.rowCount, m: m.rowCount };
    });
    expect(affected).toEqual({ t: 0, m: 0 });
    const name = await dbs.app.run(scopeB(), async (tx) => {
      const r = await tx.execute<{ name: string }>(
        sql`select name from app.tenants where id = ${fx.tenantB.id}::uuid`,
      );
      return r.rows[0]?.name;
    });
    expect(name).not.toBe('pwned');
  });

  it('inserts that claim another tenant are rejected by WITH CHECK', async () => {
    await expect(
      dbs.app.run(scopeA(), (tx) =>
        tx.execute(sql`insert into app.invitations (id, tenant_id, email, roles, token_hash, expires_at, invited_by_user_id)
                        values (${uuidv7()}::uuid, ${fx.tenantB.id}::uuid, 'x@example.test', '{agent}',
                                ${'a'.repeat(64)}, now() + interval '1 day', ${fx.ownerA.id})`),
      ),
    ).rejects.toThrow(/row-level security|not permitted/);
  });

  it('moving a row to another tenant is rejected', async () => {
    const { invitationId } = await invite(dbs, fx.tenantA, fx.ownerA, 'move-me@example.test', [
      'agent',
    ]);
    await expect(
      dbs.app.run(scopeA(), (tx) =>
        tx.execute(
          sql`update app.invitations set tenant_id = ${fx.tenantB.id}::uuid where id = ${invitationId}::uuid`,
        ),
      ),
    ).rejects.toThrow(/permission denied|not permitted/);
  });

  it('joins only ever combine rows of the scoped tenant', async () => {
    await invite(dbs, fx.tenantB, fx.ownerB, 'b-invitee@example.test', ['marketer']);
    const rows = await dbs.app.run(scopeA(), async (tx) => {
      const r = await tx.execute<{ tenant_id: string }>(sql`
        select m.tenant_id from app.memberships m
        left join app.invitations i on i.invited_by_user_id = m.user_id
        union all
        select i.tenant_id from app.invitations i`);
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([fx.tenantA.id]));
  });

  it('SECURITY DEFINER previews reveal nothing without the secret token', async () => {
    const res = await dbs.app.run(systemScope, (tx) =>
      tx.execute(sql`select * from app.invitation_preview(${'0'.repeat(64)})`),
    );
    expect(res.rows).toEqual([]);
  });
});

describe('connection pool reuse', () => {
  it('a single pooled connection never carries context between transactions', async () => {
    const isolated = connectTestDatabases({ appPoolMax: 1 });
    try {
      const a = await isolated.app.run(scopeA(), async (tx) => {
        const r = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from app.memberships`,
        );
        return r.rows[0]!.n;
      });
      expect(a).toBe(2); // owner A and agent A
      const none = await isolated.app.run(systemScope, async (tx) => {
        const r = await tx.execute<{ n: number; t: string | null }>(
          sql`select count(*)::int as n, app.current_tenant_id()::text as t from app.memberships`,
        );
        return r.rows[0];
      });
      expect(none).toEqual({ n: 0, t: null });
      const b = await isolated.app.run(scopeB(), async (tx) => {
        const r = await tx.execute<{ tenant_id: string }>(
          sql`select distinct tenant_id from app.memberships`,
        );
        return r.rows.map((x) => x.tenant_id);
      });
      expect(b).toEqual([fx.tenantB.id]);
    } finally {
      await isolated.close();
    }
  });

  it('a session-level setting left behind by buggy code is overridden by every scoped transaction', async () => {
    const isolated = connectTestDatabases({ appPoolMax: 1 });
    try {
      const client = await isolated.appPool.connect();
      await client.query(`SET app.tenant_id = '${fx.tenantA.id}'`); // simulated bug: session-level
      client.release();
      const seen = await isolated.app.run(systemScope, async (tx) => {
        const r = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from app.memberships`,
        );
        return r.rows[0]!.n;
      });
      expect(seen).toBe(0);
      const inB = await isolated.app.run(scopeB(), async (tx) => {
        const r = await tx.execute<{ tenant_id: string }>(
          sql`select distinct tenant_id from app.memberships`,
        );
        return r.rows.map((x) => x.tenant_id);
      });
      expect(inB).toEqual([fx.tenantB.id]);
    } finally {
      await isolated.close();
    }
  });

  it('a failed transaction does not leak context to the next borrower', async () => {
    const isolated = connectTestDatabases({ appPoolMax: 1 });
    try {
      await expect(
        isolated.app.run(scopeA(), async (tx) => {
          await tx.execute(sql`select 1`);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const t = await isolated.app.run(systemScope, async (tx) => {
        const r = await tx.execute<{ t: string | null }>(
          sql`select app.current_tenant_id()::text as t`,
        );
        return r.rows[0]!.t;
      });
      expect(t).toBeNull();
    } finally {
      await isolated.close();
    }
  });

  it('concurrent transactions for different tenants on one pool stay isolated', async () => {
    const runs = Array.from({ length: 40 }, (_, i) => {
      const scope = i % 2 === 0 ? scopeA() : scopeB();
      const expected = i % 2 === 0 ? fx.tenantA.id : fx.tenantB.id;
      return dbs.app.run(scope, async (tx) => {
        const r = await tx.execute<{ tenant_id: string }>(
          sql`select distinct tenant_id from app.memberships`,
        );
        await tx.execute(sql`select pg_sleep(0.005)`);
        const again = await tx.execute<{ t: string }>(
          sql`select app.current_tenant_id()::text as t`,
        );
        return { ids: r.rows.map((x) => x.tenant_id), ctx: again.rows[0]!.t, expected };
      });
    });
    for (const result of await Promise.all(runs)) {
      expect(result.ids).toEqual([result.expected]);
      expect(result.ctx).toBe(result.expected);
    }
  });
});

describe('user scope (no company selected)', () => {
  it('lists only the user’s own active memberships and companies', async () => {
    const view = await dbs.app.run(authenticatedUserScope(fx.agentA.id), async (tx) => {
      const m = await tx.execute<{ tenant_id: string; user_id: string }>(
        sql`select tenant_id, user_id from app.memberships`,
      );
      const t = await tx.execute<{ id: string }>(sql`select id from app.tenants`);
      return { memberships: m.rows, tenants: t.rows.map((r) => r.id) };
    });
    expect(view.memberships).toEqual([{ tenant_id: fx.tenantA.id, user_id: fx.agentA.id }]);
    expect(view.tenants).toEqual([fx.tenantA.id]);
  });

  it('a removed member immediately loses visibility of the company', async () => {
    const temp = await createUser(dbs);
    const { token } = await invite(dbs, fx.tenantA, fx.ownerA, temp.email, ['analyst']);
    await acceptInvitation(dbs, temp, token);
    const before = await dbs.app.run(
      authenticatedUserScope(temp.id),
      async (tx) => (await tx.execute(sql`select id from app.tenants`)).rows.length,
    );
    expect(before).toBe(1);
    await dbs.app.run(scopeA(), (tx) =>
      tx.execute(sql`update app.memberships set status = 'removed' where user_id = ${temp.id}`),
    );
    const after = await dbs.app.run(
      authenticatedUserScope(temp.id),
      async (tx) => (await tx.execute(sql`select id from app.tenants`)).rows.length,
    );
    expect(after).toBe(0);
  });
});

describe('privilege boundaries inside a tenant', () => {
  it('tenant code cannot change status, slug or billing mode of its own company', async () => {
    for (const statement of [
      sql`update app.tenants set status = 'active' where id = ${fx.tenantA.id}::uuid`,
      sql`update app.tenants set slug = 'hijack' where id = ${fx.tenantA.id}::uuid`,
      sql`update app.tenants set billing_mode = 'partner_billed' where id = ${fx.tenantA.id}::uuid`,
    ]) {
      await expect(dbs.app.run(scopeA(), (tx) => tx.execute(statement))).rejects.toThrow(
        /permission denied|not permitted/,
      );
    }
  });

  it('memberships cannot be inserted directly, only via invitation acceptance', async () => {
    await expect(
      dbs.app.run(scopeA(), (tx) =>
        tx.execute(sql`insert into app.memberships (id, tenant_id, user_id, roles)
                        values (${uuidv7()}::uuid, ${fx.tenantA.id}::uuid, ${fx.ownerB.id}, '{owner}')`),
      ),
    ).rejects.toThrow(/permission denied|not permitted/);
  });

  it('audit events are append-only', async () => {
    await expect(
      dbs.app.run(scopeA(), (tx) =>
        tx.execute(sql`update app.audit_events set action = 'tampered'`),
      ),
    ).rejects.toThrow(/permission denied|not permitted/);
    await expect(
      dbs.app.run(scopeA(), (tx) => tx.execute(sql`delete from app.audit_events`)),
    ).rejects.toThrow(/permission denied|not permitted/);
    // Even the owner role cannot rewrite history without the dedicated retention path.
    await expect(
      dbs.ownerPool.query(
        `ALTER TABLE app.audit_events NO FORCE ROW LEVEL SECURITY; UPDATE app.audit_events SET action = 'x'`,
      ),
    ).rejects.toThrow(/append-only/);
  });
});

describe('company creation and invitations', () => {
  it('requires a verified email address', async () => {
    const unverified = await createUser(dbs, { verified: false });
    await expect(createTenant(dbs, unverified)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('cannot be invoked from inside a company context', async () => {
    await expect(
      dbs.app.run(scopeA(), (tx) =>
        tx.execute(
          sql`select app.create_tenant(${uuidv7()}::uuid, ${uuidv7()}::uuid, 'Sneaky Co', 'sneaky-co', 'UTC', 'en')`,
        ),
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rate limits company creation per user', async () => {
    const prolific = await createUser(dbs);
    for (let i = 0; i < 5; i += 1) await createTenant(dbs, prolific);
    await expect(createTenant(dbs, prolific)).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('rejects duplicate slugs as a conflict', async () => {
    const u = await createUser(dbs);
    await expect(createTenant(dbs, u, fx.tenantA.slug)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('only the invited email address can accept, once, before expiry', async () => {
    const invited = await createUser(dbs);
    const intruder = await createUser(dbs);
    const { token } = await invite(dbs, fx.tenantA, fx.ownerA, invited.email, ['supervisor']);
    await expect(acceptInvitation(dbs, intruder, token)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(acceptInvitation(dbs, invited, token)).resolves.toBe(fx.tenantA.id);
    await expect(acceptInvitation(dbs, invited, token)).rejects.toMatchObject({ code: 'conflict' });

    const late = await createUser(dbs);
    const expired = await invite(dbs, fx.tenantA, fx.ownerA, late.email, ['agent'], {
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(acceptInvitation(dbs, late, expired.token)).rejects.toMatchObject({
      code: 'precondition_failed',
    });
  });

  it('an unverified account cannot accept an invitation', async () => {
    const pending = await createUser(dbs, { verified: false });
    const { token } = await invite(dbs, fx.tenantA, fx.ownerA, pending.email, ['agent']);
    await expect(acceptInvitation(dbs, pending, token)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('a suspended member cannot use an invitation to restore access', async () => {
    const member = await createUser(dbs);
    const first = await invite(dbs, fx.tenantA, fx.ownerA, member.email, ['agent']);
    await acceptInvitation(dbs, member, first.token);
    await dbs.app.run(scopeA(), (tx) =>
      tx.execute(sql`update app.memberships set status = 'suspended' where user_id = ${member.id}`),
    );
    const second = await invite(dbs, fx.tenantA, fx.ownerA, member.email, ['admin']);
    await expect(acceptInvitation(dbs, member, second.token)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('last-owner protection', () => {
  it('the sole owner cannot demote or suspend themselves', async () => {
    const owner = await createUser(dbs);
    const t = await createTenant(dbs, owner);
    const scope = authorizedTenantScope(t.id, owner.id);
    await expect(
      dbs.app.run(scope, (tx) =>
        tx.execute(
          sql`update app.memberships set roles = '{admin}' where id = ${t.ownerMembershipId}::uuid`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
    await expect(
      dbs.app.run(scope, (tx) =>
        tx.execute(
          sql`update app.memberships set status = 'removed' where id = ${t.ownerMembershipId}::uuid`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  it('two owners demoting each other concurrently leaves exactly one owner', async () => {
    const o1 = await createUser(dbs);
    const o2 = await createUser(dbs);
    const t = await createTenant(dbs, o1);
    const { token } = await invite(dbs, t, o1, o2.email, ['owner']);
    await acceptInvitation(dbs, o2, token);
    const memberships = await dbs.app.run(
      authorizedTenantScope(t.id, o1.id),
      async (tx) =>
        (
          await tx.execute<{ id: string; user_id: string }>(
            sql`select id, user_id from app.memberships`,
          )
        ).rows,
    );
    const m1 = memberships.find((m) => m.user_id === o1.id)!.id;
    const m2 = memberships.find((m) => m.user_id === o2.id)!.id;

    const demote = (actor: string, target: string) =>
      dbs.app.run(authorizedTenantScope(t.id, actor), async (tx) => {
        await tx.execute(
          sql`update app.memberships set roles = '{admin}' where id = ${target}::uuid`,
        );
        await tx.execute(sql`select pg_sleep(0.2)`); // widen the race window
      });
    const results = await Promise.allSettled([demote(o1.id, m2), demote(o2.id, m1)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const owners = await dbs.app.run(
      authorizedTenantScope(t.id, o1.id),
      async (tx) =>
        (
          await tx.execute(
            sql`select id from app.memberships where status = 'active' and 'owner' = any(roles)`,
          )
        ).rows,
    );
    expect(owners).toHaveLength(1);
  });
});

describe('platform administration role', () => {
  it('reads across companies but only updates status columns', async () => {
    const admin = await createUser(dbs);
    const visible = await dbs.platform.run(
      admin.id,
      async (tx) =>
        (
          await tx.execute(
            sql`select id from app.tenants where id in (${fx.tenantA.id}::uuid, ${fx.tenantB.id}::uuid)`,
          )
        ).rows,
    );
    expect(visible).toHaveLength(2);
    await expect(
      dbs.platform.run(admin.id, (tx) =>
        tx.execute(sql`update app.tenants set name = 'x' where id = ${fx.tenantA.id}::uuid`),
      ),
    ).rejects.toThrow(/permission denied|not permitted/);
    await expect(
      dbs.platform.run(admin.id, (tx) => tx.execute(sql`select password from auth.accounts`)),
    ).rejects.toThrow(/permission denied|not permitted/);
    await expect(
      dbs.platform.run(admin.id, (tx) =>
        tx.execute(
          sql`insert into app.memberships (id, tenant_id, user_id, roles) values (${uuidv7()}::uuid, ${fx.tenantA.id}::uuid, ${admin.id}, '{owner}')`,
        ),
      ),
    ).rejects.toThrow(/permission denied|not permitted/);
  });
});

describe('support access is reasoned, scoped and time-boxed', () => {
  it('customer data requires an active grant with the matching scope', async () => {
    const operator = await createUser(dbs, { name: 'Support Operator' });
    await invite(dbs, fx.tenantB, fx.ownerB, 'support-probe@example.test', ['agent']);
    const visible = () =>
      dbs.platform.run(
        operator.id,
        async (tx) =>
          (
            await tx.execute(
              sql`select id from app.invitations where tenant_id = ${fx.tenantB.id}::uuid`,
            )
          ).rows.length,
      );
    expect(await visible()).toBe(0);

    // A grant for a different scope does not help.
    await dbs.platform.run(operator.id, (tx) =>
      tx.execute(sql`insert into ops.support_access_grants (id, tenant_id, platform_user_id, reason, scopes, expires_at)
                      values (${uuidv7()}::uuid, ${fx.tenantB.id}::uuid, ${operator.id}, 'Investigating billing ticket #1234',
                              '{billing.read}', now() + interval '1 hour')`),
    );
    expect(await visible()).toBe(0);

    const grantId = uuidv7();
    await dbs.platform.run(operator.id, (tx) =>
      tx.execute(sql`insert into ops.support_access_grants (id, tenant_id, platform_user_id, reason, scopes, expires_at)
                      values (${grantId}::uuid, ${fx.tenantB.id}::uuid, ${operator.id}, 'Customer reports invitation emails missing',
                              '{members.read}', now() + interval '1 hour')`),
    );
    expect(await visible()).toBeGreaterThan(0);
    // The grant does not extend to other companies.
    const other = await dbs.platform.run(
      operator.id,
      async (tx) =>
        (
          await tx.execute(
            sql`select id from app.invitations where tenant_id = ${fx.tenantA.id}::uuid`,
          )
        ).rows.length,
    );
    expect(other).toBe(0);

    await dbs.platform.run(operator.id, (tx) =>
      tx.execute(
        sql`update ops.support_access_grants set revoked_at = now(), revoked_by = ${operator.id} where id = ${grantId}::uuid`,
      ),
    );
    expect(await visible()).toBe(0);
  });

  it('membership directories also require a members.read grant', async () => {
    const operator = await createUser(dbs, { name: 'Directory Probe' });
    const members = () =>
      dbs.platform.run(
        operator.id,
        async (tx) =>
          (
            await tx.execute(
              sql`select user_id from app.memberships where tenant_id = ${fx.tenantA.id}::uuid`,
            )
          ).rows.length,
      );
    expect(await members()).toBe(0);
    await dbs.platform.run(operator.id, (tx) =>
      tx.execute(sql`insert into ops.support_access_grants (id, tenant_id, platform_user_id, reason, scopes, expires_at)
                      values (${uuidv7()}::uuid, ${fx.tenantA.id}::uuid, ${operator.id}, 'Customer asked why an agent cannot sign in',
                              '{members.read}', now() + interval '30 minutes')`),
    );
    expect(await members()).toBeGreaterThan(0);
  });

  it('seat counts and owner lookup are limited to platform administrators and to those facts', async () => {
    const outsider = await createUser(dbs);
    await expect(
      dbs.platform.run(outsider.id, (tx) =>
        tx.execute(sql`select * from ops.platform_tenant_owners(${fx.tenantA.id}::uuid)`),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      dbs.platform.run(outsider.id, (tx) =>
        tx.execute(
          sql`select * from ops.platform_active_member_counts(array[${fx.tenantA.id}]::uuid[])`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Tenant code cannot call them at all.
    await expect(
      dbs.app.run(scopeA(), (tx) =>
        tx.execute(sql`select * from ops.platform_tenant_owners(${fx.tenantA.id}::uuid)`),
      ),
    ).rejects.toThrow(/permission denied|not permitted/);

    const admin = await createUser(dbs);
    await dbs.ownerPool.query(
      `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
      [admin.id],
    );
    const owners = await dbs.platform.run(
      admin.id,
      async (tx) =>
        (
          await tx.execute<{ user_id: string; membership_status: string }>(
            sql`select * from ops.platform_tenant_owners(${fx.tenantA.id}::uuid)`,
          )
        ).rows,
    );
    expect(owners.map((o) => o.user_id)).toEqual([fx.ownerA.id]);
    expect(Object.keys(owners[0]!).sort()).toEqual(
      ['membership_status', 'name', 'two_factor_enabled', 'user_id'].sort(),
    );
    const counts = await dbs.platform.run(
      admin.id,
      async (tx) =>
        (
          await tx.execute<{ tenant_id: string; active_members: number }>(
            sql`select * from ops.platform_active_member_counts(array[${fx.tenantA.id}, ${fx.tenantB.id}]::uuid[])`,
          )
        ).rows,
    );
    const byTenant = Object.fromEntries(counts.map((c) => [c.tenant_id, c.active_members]));
    expect(byTenant[fx.tenantA.id]).toBeGreaterThanOrEqual(2);
    expect(byTenant[fx.tenantB.id]).toBeGreaterThanOrEqual(1);
  });

  it('grants longer than 8 hours or without a real reason are rejected', async () => {
    const operator = await createUser(dbs);
    await expect(
      dbs.platform.run(operator.id, (tx) =>
        tx.execute(sql`insert into ops.support_access_grants (id, tenant_id, platform_user_id, reason, scopes, expires_at)
                        values (${uuidv7()}::uuid, ${fx.tenantA.id}::uuid, ${operator.id}, 'Long investigation needed',
                                '{tenant.read}', now() + interval '9 hours')`),
      ),
    ).rejects.toThrow();
    await expect(
      dbs.platform.run(operator.id, (tx) =>
        tx.execute(sql`insert into ops.support_access_grants (id, tenant_id, platform_user_id, reason, scopes, expires_at)
                        values (${uuidv7()}::uuid, ${fx.tenantA.id}::uuid, ${operator.id}, 'why', '{tenant.read}', now() + interval '1 hour')`),
      ),
    ).rejects.toThrow();
  });

  it('tenants can see support grants on their own company only', async () => {
    const rows = await dbs.app.run(
      scopeA(),
      async (tx) =>
        (
          await tx.execute<{ tenant_id: string }>(
            sql`select tenant_id from ops.support_access_grants`,
          )
        ).rows,
    );
    expect(rows.every((r) => r.tenant_id === fx.tenantA.id)).toBe(true);
  });

  it('platform audit entries in a tenant log must be attributed to the acting administrator', async () => {
    const operator = await createUser(dbs);
    await expect(
      dbs.platform.run(operator.id, (tx) =>
        tx.execute(sql`insert into app.audit_events (tenant_id, actor_type, actor_id, action, result)
                        values (${fx.tenantA.id}::uuid, 'user', ${fx.ownerA.id}, 'forged.action', 'success')`),
      ),
    ).rejects.toThrow();
    await dbs.platform.run(operator.id, (tx) =>
      tx.execute(sql`insert into app.audit_events (tenant_id, actor_type, actor_id, action, result)
                      values (${fx.tenantA.id}::uuid, 'platform_admin', ${operator.id}, 'platform.tenant_viewed', 'success')`),
    );
  });

  it('MFA reset requires a platform administrator and a reason', async () => {
    const victim = await createUser(dbs, { twoFactor: true });
    const notAdmin = await createUser(dbs);
    await expect(
      dbs.platform.run(notAdmin.id, (tx) =>
        tx.execute(
          sql`select ops.platform_reset_user_mfa(${victim.id}, 'Verified identity by phone')`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const admin = await createUser(dbs);
    await dbs.ownerPool.query(
      `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
      [admin.id],
    );
    await expect(
      dbs.platform.run(admin.id, (tx) =>
        tx.execute(sql`select ops.platform_reset_user_mfa(${victim.id}, 'short')`),
      ),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
    await dbs.platform.run(admin.id, (tx) =>
      tx.execute(
        sql`select ops.platform_reset_user_mfa(${victim.id}, 'Verified identity via registered phone callback')`,
      ),
    );
    const after = await dbs.authPool.query(
      'SELECT two_factor_enabled FROM auth.users WHERE id = $1',
      [victim.id],
    );
    expect(after.rows[0].two_factor_enabled).toBe(false);
  });
});
