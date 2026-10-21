import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  STORED_EXPORT_RETENTION_DAYS,
  companyExportPartAad,
  expireStoredExport,
  listStoredExports,
  openStoredExport,
  outboxAad,
  requestStoredExport,
  runStoredExport,
  sweepStoredExports,
  writeCompanyExport,
  type StoredExportDeps,
  type TenantContext,
} from '@w360/domain';
import { acceptInvitation, createUser, invite, type TestUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Stored company exports (P5-11, ADR-415) against real PostgreSQL: asking (owners with a recent
 * sign-in), the worker's run writing the same export as the streamed one into sealed parts, one
 * export of a company at a time under concurrency (stored and streamed together), a crashed run
 * taken over and given up, failures recorded and visible, the minute sweep expiring files after 7
 * days and signalling lost jobs, and downloading: owners only, of their own company, signed in
 * recently, audited and told to owners and administrators.
 */
const APP_BASE = 'http://127.0.0.1:3999';
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  await fx?.close();
});

const deps = (limits?: StoredExportDeps['limits']): StoredExportDeps => ({
  keyring: fx.keyring,
  jobs: fx.jobs(),
  signer: fx.signer,
  db: fx.dbs.app,
  clock: systemClock,
  appBaseUrl: APP_BASE,
  ...(limits ? { limits } : {}),
});
const scopeOf = (c: Company) => authorizedTenantScope(c.tenant.id, null);

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.publicMessage).toMatch(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

async function member(c: Company, role: string, name = `A ${role}`): Promise<TestUser> {
  const user = await createUser(fx.dbs, { name });
  const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(fx.dbs, user, token);
  return user;
}

async function row(id: string) {
  const [found] = await fx.query<{
    status: string;
    attempts: number;
    byte_size: string | null;
    sha256: string | null;
    part_count: number | null;
    failure_reason: string | null;
    finished_at: Date | null;
    expires_at: Date | null;
    deleted_at: Date | null;
    lease_until: Date | null;
  }>('SELECT * FROM app.company_exports WHERE id = $1', [id]);
  return found!;
}

async function parts(id: string) {
  return fx.query<{ attempt: number; seq: number; byte_size: number; ciphertext: string }>(
    'SELECT attempt, seq, byte_size, ciphertext FROM app.company_export_parts WHERE export_id = $1 ORDER BY attempt, seq',
    [id],
  );
}

async function emails(tenantId: string) {
  const rows = await fx.query<{ id: string; to_address: string; payload_ciphertext: string }>(
    'SELECT id, to_address, payload_ciphertext FROM ops.email_outbox WHERE tenant_id = $1 ORDER BY created_at, id',
    [tenantId],
  );
  return rows.map((r) => ({
    to: r.to_address,
    payload: JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
      subject?: string;
      lines?: string[];
      url?: string;
    },
  }));
}

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = await fx.query<{ action: string }>(
    'SELECT action FROM app.audit_events WHERE tenant_id = $1 ORDER BY occurred_at, id',
    [tenantId],
  );
  return rows.map((r) => r.action);
}

async function download(ctx: TenantContext, id: string): Promise<Buffer> {
  const opened = await openStoredExport(deps(), ctx, id);
  const chunks: Buffer[] = [];
  for await (const bytes of opened.parts) chunks.push(Buffer.from(bytes));
  const file = Buffer.concat(chunks);
  expect(file.length).toBe(opened.byteSize);
  expect(createHash('sha256').update(file).digest('hex')).toBe(opened.sha256);
  return file;
}

async function streamed(ctx: TenantContext): Promise<string> {
  let text = '';
  await writeCompanyExport(deps(), ctx, async (chunk) => {
    text += chunk;
  });
  return text;
}

async function ready(c: Company, ctx: TenantContext) {
  const { id } = await requestStoredExport(deps(), ctx);
  const result = await runStoredExport(deps({ partBytes: 2_048 }), scopeOf(c), id);
  expect(result.outcome).toBe('ready');
  return id;
}

/** A transaction holding the company's export lock, as a streamed export does while it runs. */
async function holdingExportLock<T>(c: Company, fn: () => Promise<T>): Promise<T> {
  const client = await fx.dbs.adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `company-export:${c.tenant.id}`,
    ]);
    return await fn();
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('preparing and downloading a stored export', () => {
  it('writes the streamed export’s lines from one snapshot, sealed in parts, for owners to download', async () => {
    const c = await fx.company();
    const admin = await member(c, 'admin', 'Admin Person');
    const owner = await fx.ctx(c, c.owner);

    const { id } = await requestStoredExport(deps(), owner);
    expect(await row(id)).toMatchObject({ status: 'queued', attempts: 0, byte_size: null });
    // The job is queued with the request, keyed by the export.
    const [job] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'company.export' AND singleton_key = $1`,
      [id],
    );
    expect(job!.n).toBe(1);

    const result = await runStoredExport(deps({ partBytes: 2_048 }), scopeOf(c), id);
    expect(result).toMatchObject({ outcome: 'ready', attempt: 1 });
    const stored = await row(id);
    expect(stored).toMatchObject({ status: 'ready', attempts: 1, lease_until: null });
    expect(stored.part_count).toBeGreaterThan(1);
    const days =
      (stored.expires_at!.getTime() - stored.finished_at!.getTime()) / (24 * 3600 * 1000);
    expect(days).toBeCloseTo(STORED_EXPORT_RETENTION_DAYS, 5);
    // Sealed at rest: no part shows the company's data.
    const sealed = await parts(id);
    expect(sealed).toHaveLength(stored.part_count!);
    for (const part of sealed) {
      expect(part.ciphertext.startsWith('v1:test:')).toBe(true);
      expect(part.ciphertext).not.toContain(c.tenant.slug);
    }

    const file = await download(owner, id);
    expect(file.length).toBe(Number(stored.byte_size));
    expect(createHash('sha256').update(file).digest('hex')).toBe(stored.sha256);
    const lines = gunzipSync(file).toString('utf8').trimEnd().split('\n');
    // The same export as the streamed one: the same header but its time, and the same rows,
    // but for the audit events of this download and of the streamed export itself.
    const live = (await streamed(owner)).trimEnd().split('\n');
    const header = (text: string) => {
      const { exportedAt: _at, ...rest } = JSON.parse(text) as Record<string, unknown>;
      return rest;
    };
    expect(header(lines[0]!)).toEqual(header(live[0]!));
    expect(JSON.parse(lines[0]!)).toMatchObject({
      format: 'hyfib-w360-company-export',
      company: { id: c.tenant.id, slug: c.tenant.slug },
    });
    const rows = (all: string[]) =>
      all.slice(1, -1).filter((line) => !line.startsWith('{"table":"app.audit_events"'));
    expect(rows(lines)).toEqual(rows(live));
    const counts = (line: string) => {
      const { 'app.audit_events': _audit, ...rest } = (
        JSON.parse(line) as { counts: Record<string, number> }
      ).counts;
      return rest;
    };
    expect(counts(lines.at(-1)!)).toEqual(counts(live.at(-1)!));
    expect(lines.at(-1)).toMatch(/^\{"end":true/);
    expect(lines.join('\n')).not.toContain('"table":"app.company_export');

    // Audited, and owners and administrators told at each step, with a link to the page only.
    const actions = await auditActions(c.tenant.id);
    expect(actions).toEqual(
      expect.arrayContaining(['tenant.export_requested', 'tenant.export_downloaded']),
    );
    const told = await emails(c.tenant.id);
    for (const subject of [
      'Company data export requested',
      'Company data export ready',
      'Company data export downloaded',
    ]) {
      const sent = told.filter((e) => e.payload.subject === subject);
      expect(sent.map((e) => e.to).sort(), subject).toEqual([c.owner.email, admin.email].sort());
      for (const e of sent)
        expect(e.payload.url).toBe(`${APP_BASE}/c/${c.tenant.slug}/settings/data`);
    }
    expect(JSON.stringify(told)).not.toContain(id);

    // The list shows it with who asked.
    const listed = await listStoredExports(deps(), owner);
    expect(listed[0]).toMatchObject({
      id,
      status: 'ready',
      requestedByName: c.owner.name,
      byteSize: Number(stored.byte_size),
    });
  });

  it('lets only an owner of the company, signed in recently, download a ready export', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const id = await ready(c, owner);
    const admin = await fx.ctx(c, await member(c, 'admin'));
    await expectAppError(openStoredExport(deps(), admin, id), 'forbidden');
    await expectAppError(listStoredExports(deps(), admin), 'forbidden');
    await expectAppError(openStoredExport(deps(), await fx.ctx(c, c.agent), id), 'forbidden');
    const stale = { ...owner, signedInAt: new Date(Date.now() - 20 * 60_000) } as TenantContext;
    await expectAppError(openStoredExport(deps(), stale, id), 'step_up_required');
    await expectAppError(requestStoredExport(deps(), stale), 'step_up_required');

    // Another company's owner finds nothing, and lists nothing of it.
    const other = await fx.company();
    const otherOwner = await fx.ctx(other, other.owner);
    await expectAppError(openStoredExport(deps(), otherOwner, id), 'not_found');
    expect((await listStoredExports(deps(), otherOwner)).map((e) => e.id)).not.toContain(id);
    // None of these was recorded as a download.
    expect(await auditActions(c.tenant.id)).not.toContain('tenant.export_downloaded');
    expect(await auditActions(other.tenant.id)).not.toContain('tenant.export_downloaded');
  });
});

describe('what a company keeps (ADR-415)', () => {
  it('keeps one ready file: a newer export expires the older one and deletes its parts', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const first = await ready(c, owner);
    const other = await fx.company();
    const othersFile = await ready(other, await fx.ctx(other, other.owner));
    const second = await ready(c, owner);
    const old = await row(first);
    expect(old).toMatchObject({ status: 'expired' });
    expect(old.deleted_at).not.toBeNull();
    expect(await parts(first)).toEqual([]);
    expect(await row(second)).toMatchObject({ status: 'ready' });
    await expectAppError(openStoredExport(deps(), owner, first), 'not_found');
    // Another company's file is not touched.
    expect(await row(othersFile)).toMatchObject({ status: 'ready' });
    expect((await parts(othersFile)).length).toBeGreaterThan(0);
  });
});

describe('one export of a company at a time (ADR-415)', () => {
  it('lets one of several owners asking at once through, and refuses the rest', async () => {
    const c = await fx.company();
    const second = await member(c, 'owner', 'Second Owner');
    const ctxs = [await fx.ctx(c, c.owner), await fx.ctx(c, second)];
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => requestStoredExport(deps(), ctxs[i % 2]!)),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(isAppError(r.reason) && r.reason.code, String(r.reason)).toBe('conflict');
      }
    }
    const [{ n }] = (await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.company_exports WHERE tenant_id = $1`,
      [c.tenant.id],
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('counts the streamed export and a stored one together, in both directions', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    // A streamed export running: no stored export can be asked for.
    await holdingExportLock(c, () =>
      expectAppError(requestStoredExport(deps(), owner), 'conflict', /already running/),
    );
    // A stored export waiting: the streamed export is refused until it is ready.
    const { id } = await requestStoredExport(deps(), owner);
    await expectAppError(streamed(owner), 'conflict', /being prepared/);
    // Its run, meeting the lock of a streamed export, waits (still queued) for the next signal.
    const waited = await holdingExportLock(c, () => runStoredExport(deps(), scopeOf(c), id));
    expect(waited).toEqual({ outcome: 'locked' });
    expect(await row(id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect((await runStoredExport(deps(), scopeOf(c), id)).outcome).toBe('ready');
    // Ready: the streamed export works again, and a new stored export can be asked for.
    expect(await streamed(owner)).toContain('"end":true');
    await requestStoredExport(deps(), owner);
  });

  it('leaves an export a live run holds alone', async () => {
    const c = await fx.company();
    const { id } = await requestStoredExport(deps(), await fx.ctx(c, c.owner));
    await fx.query(
      `UPDATE app.company_exports SET status = 'running', attempts = 1, started_at = now(),
              lease_until = now() + interval '5 minutes' WHERE id = $1`,
      [id],
    );
    expect(await runStoredExport(deps(), scopeOf(c), id)).toEqual({ outcome: 'busy' });
    expect(await row(id)).toMatchObject({ status: 'running', attempts: 1 });
  });
});

describe('crashes and failures (ADR-415)', () => {
  it('takes over a run whose lease ran out, and never reads that run’s parts', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id } = await requestStoredExport(deps(), owner);
    // A run that crashed after writing a part: its lease ran out.
    await fx.query(
      `UPDATE app.company_exports SET status = 'running', attempts = 1, started_at = now(),
              lease_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    const strayId = uuidv7();
    await fx.query(
      `INSERT INTO app.company_export_parts (id, tenant_id, export_id, attempt, seq, byte_size, ciphertext)
       VALUES ($1, $2, $3, 1, 0, 5, $4)`,
      [
        strayId,
        c.tenant.id,
        id,
        fx.keyring.encrypt('stray', companyExportPartAad(c.tenant.id, strayId)),
      ],
    );
    const result = await runStoredExport(deps({ partBytes: 2_048 }), scopeOf(c), id);
    expect(result).toMatchObject({ outcome: 'ready', attempt: 2 });
    const left = await parts(id);
    expect(new Set(left.map((p) => p.attempt))).toEqual(new Set([2]));
    expect(gunzipSync(await download(owner, id)).toString('utf8')).toMatch(/"end":true/);
  });

  it(`gives up after ${3} interrupted runs, tells the owners and lets them ask again`, async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id } = await requestStoredExport(deps(), owner);
    await fx.query(
      `UPDATE app.company_exports SET status = 'running', attempts = 3, started_at = now(),
              lease_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    const result = await runStoredExport(deps(), scopeOf(c), id);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'interrupted' });
    expect(await row(id)).toMatchObject({ status: 'failed', failure_reason: 'interrupted' });
    expect(await parts(id)).toEqual([]);
    const failed = (await emails(c.tenant.id)).filter(
      (e) => e.payload.subject === 'Company data export failed',
    );
    expect(failed.map((e) => e.to)).toEqual([c.owner.email]);
    expect((await listStoredExports(deps(), owner))[0]).toMatchObject({
      id,
      status: 'failed',
      failureReason: 'interrupted',
    });
    // Not blocked for good: a new request goes through.
    await requestStoredExport(deps(), owner);
  });

  it('fails a file past the largest size, keeping no part of it', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id } = await requestStoredExport(deps(), owner);
    const result = await runStoredExport(deps({ partBytes: 512, maxBytes: 1_024 }), scopeOf(c), id);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'too_large' });
    const stored = await row(id);
    expect(stored).toMatchObject({
      status: 'failed',
      failure_reason: 'too_large',
      byte_size: null,
    });
    expect(stored.deleted_at).not.toBeNull();
    expect(await parts(id)).toEqual([]);
    await expectAppError(openStoredExport(deps(), owner, id), 'not_found');
    await requestStoredExport(deps(), owner);
  });

  it('does not prepare an export for someone who is no longer an owner, or one waiting a day', async () => {
    const c = await fx.company();
    const second = await member(c, 'owner', 'Leaving Owner');
    const { id } = await requestStoredExport(deps(), await fx.ctx(c, second));
    await fx.query(
      `UPDATE app.memberships SET roles = ARRAY['agent'] WHERE tenant_id = $1 AND user_id = $2`,
      [c.tenant.id, second.id],
    );
    expect(await runStoredExport(deps(), scopeOf(c), id)).toMatchObject({
      outcome: 'failed',
      reason: 'requester_not_allowed',
    });
    expect(await parts(id)).toEqual([]);

    const { id: waiting } = await requestStoredExport(deps(), await fx.ctx(c, c.owner));
    await fx.query(
      `UPDATE app.company_exports SET requested_at = now() - interval '25 hours' WHERE id = $1`,
      [waiting],
    );
    expect(await runStoredExport(deps(), scopeOf(c), waiting)).toMatchObject({
      outcome: 'failed',
      reason: 'timed_out',
    });
    expect(await row(waiting)).toMatchObject({ status: 'failed', failure_reason: 'timed_out' });
  });
});

describe('the minute sweep (ADR-415)', () => {
  it('deletes a ready export’s file once it expires, once, and records it', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const id = await ready(c, owner);
    expect((await parts(id)).length).toBeGreaterThan(0);
    // Not yet due: nothing happens to it.
    await sweepStoredExports(deps(), 500);
    expect(await row(id)).toMatchObject({ status: 'ready' });

    await fx.query(
      `UPDATE app.company_exports SET finished_at = now() - interval '8 days',
              expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    const swept = await sweepStoredExports(deps(), 500);
    expect(swept.failed).toEqual([]);
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    const expired = await row(id);
    expect(expired).toMatchObject({ status: 'expired' });
    expect(expired.deleted_at).not.toBeNull();
    expect(await parts(id)).toEqual([]);
    // Idempotent: once expired, again is nothing to do.
    expect(await expireStoredExport(deps(), c.tenant.id, id)).toBe(false);
    expect(await row(id)).toMatchObject({ status: 'expired', deleted_at: expired.deleted_at });
    await expectAppError(openStoredExport(deps(), owner, id), 'not_found');
  });

  it('expires only within the export’s own company', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const id = await ready(c, await fx.ctx(c, c.owner));
    await fx.query(
      `UPDATE app.company_exports SET finished_at = now() - interval '8 days',
              expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    expect(await expireStoredExport(deps(), other.tenant.id, id)).toBe(false);
    expect(await row(id)).toMatchObject({ status: 'ready' });
    expect(await expireStoredExport(deps(), c.tenant.id, id)).toBe(true);
  });

  it('signals an export whose job was lost again', async () => {
    const c = await fx.company();
    const { id } = await requestStoredExport(deps(), await fx.ctx(c, c.owner));
    await fx.query(`DELETE FROM pgboss.job WHERE name = 'company.export' AND singleton_key = $1`, [
      id,
    ]);
    await sweepStoredExports(deps(), 500);
    const [job] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'company.export' AND singleton_key = $1`,
      [id],
    );
    expect(job!.n).toBe(1);
  });
});

describe('row level security of stored exports', () => {
  it('shows a company’s exports and parts to that company only, and lets no one delete a record', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const id = await ready(c, await fx.ctx(c, c.owner));
    const seen = await fx.dbs.app.run(scopeOf(other), async (tx) => {
      const exportsSeen = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from app.company_exports where id = ${id}::uuid`,
      );
      const partsSeen = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from app.company_export_parts where export_id = ${id}::uuid`,
      );
      return [exportsSeen.rows[0]!.n, partsSeen.rows[0]!.n];
    });
    expect(seen).toEqual([0, 0]);
    // A part claiming another company is refused by the policy's check.
    await expectAppError(
      fx.dbs.app.run(scopeOf(other), (tx) =>
        tx.execute(
          sql`insert into app.company_export_parts (id, tenant_id, export_id, attempt, seq, byte_size, ciphertext)
              values (${uuidv7()}::uuid, ${c.tenant.id}::uuid, ${id}::uuid, 1, 99, 1, 'v1:x')`,
        ),
      ),
      'forbidden',
    );
    const [grants] = await fx.query<{ del: boolean; upd_status: boolean; parts_upd: boolean }>(
      `SELECT has_table_privilege('w360_app', 'app.company_exports', 'DELETE') AS del,
              has_column_privilege('w360_app', 'app.company_exports', 'tenant_id', 'UPDATE') AS upd_status,
              has_column_privilege('w360_app', 'app.company_export_parts', 'export_id', 'UPDATE') AS parts_upd`,
    );
    expect(grants).toEqual({ del: false, upd_status: false, parts_upd: false });
  });
});
