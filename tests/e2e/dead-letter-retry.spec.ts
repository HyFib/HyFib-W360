import pg from 'pg';
import { expect, test } from './fixtures';
import {
  expectNoHorizontalOverflow,
  makePlatformOwner,
  platformConfigured,
  signUpAndVerify,
  turnOnTwoFactor,
  uniqueEmail,
} from './support';

const PASSWORD = 'correct horse battery staple 42';

test.skip(!platformConfigured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
test.use({ actionTimeout: 30_000 });

async function asOwner<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** The company's id (only the definer role reads companies outside their own scope). */
async function companyId(slug: string): Promise<string> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE w360_definer');
    const res = await client.query<{ id: string }>('SELECT id FROM app.tenants WHERE slug = $1', [
      slug,
    ]);
    await client.query('COMMIT');
    return res.rows[0]!.id;
  } finally {
    await client.end();
  }
}

test('platform staff send a dead-lettered job back to its queue once, with a reason, and acknowledge it', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail('deadletter');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const companyName = `Dead Letter Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Rita Retry', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(`deadletter-${suffix}`);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);

  // A platform job that failed all its retries, as pg-boss keeps it, and the dead letter the worker
  // recorded (already emailed about). It is due in 30 days, so no worker takes it during the test,
  // and pg-boss deletes it unstarted after its 14-day retention if the clean-up does not run.
  const [failed] = await asOwner<{ id: string }>(
    `INSERT INTO pgboss.job (name, data, state, retry_limit, retry_count, start_after, started_on,
       completed_on, policy, singleton_key)
     VALUES ('template.sync', '{}'::jsonb, 'failed', 3, 3, now() + interval '30 days', now(), now(),
       'exclusive', $1)
     RETURNING id`,
    [`e2e-dead-letter-${suffix}`],
  );
  const jobId = failed!.id;
  const [letter] = await asOwner<{ id: string }>(
    `INSERT INTO ops.dead_letters (id, source_queue, source_job_id, kind, tenant_id, ref, verified,
       retries, error_name, error_code, failed_at, alerted_at)
     VALUES (gen_random_uuid(), 'template.sync', $1, 'template.sync', NULL, $2, true, 3, 'AppError',
       'provider_unavailable', now(), now())
     RETURNING id`,
    [jobId, `e2e-${suffix}`],
  );
  const deadLetterId = letter!.id;
  const stranded: string[] = [];
  try {
    await page.goto('/platform/ops/queues');
    const letters = page.getByRole('table', { name: 'Recent dead letters' });
    const row = letters.getByRole('row').filter({ hasText: deadLetterId });
    await expect(row).toContainText('template.sync');
    await expect(row).toContainText('provider_unavailable');
    await expect(row).toContainText('Until');

    await row.getByText('Retry', { exact: true }).click();
    await row
      .getByLabel('Reason (the fix made)')
      .fill('Meta outage over, retrying the template sync');
    await row.getByRole('button', { name: 'Retry job' }).click();
    // Sent back once: the row says who retried it and offers no second retry.
    await expect(row).toContainText(/Retried .+ by Rita Retry/);
    await expect(row.getByText('Retry', { exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    // Acknowledged with a note for the other administrators (ADR-169): who, when and what.
    await row.getByText('Acknowledge', { exact: true }).click();
    await row
      .getByLabel('Note (what was found or done)')
      .fill('Meta confirmed the outage is over; watching the retry.');
    await row.getByRole('button', { name: 'Acknowledge dead letter' }).click();
    await expect(row).toContainText('By Rita Retry');
    await expect(row).toContainText('Meta confirmed the outage is over; watching the retry.');
    await expect(row.getByText('Replace the note', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // pg-boss's own retry: waiting again, with one more attempt allowed.
    const [job] = await asOwner<{ state: string; retry_limit: number; completed_on: Date | null }>(
      `SELECT state::text AS state, retry_limit, completed_on FROM pgboss.job WHERE id = $1`,
      [jobId],
    );
    expect(job).toEqual({ state: 'retry', retry_limit: 4, completed_on: null });

    // In the platform audit log.
    await page.goto('/platform');
    await expect(page.getByText('platform.dead_letter_retried').first()).toBeVisible();
    await expect(page.getByText('platform.dead_letter_acknowledged').first()).toBeVisible();

    // The company's template deletion that ran out of retries: the worker's minute sweep ends
    // such work for the company (ADR-111). This template is gone, so nothing is left to end. A
    // second deletion's work was ended earlier.
    const tenantId = await companyId(`deadletter-${suffix}`);
    for (const ended of [null, true]) {
      const [row] = await asOwner<{ id: string }>(
        `INSERT INTO ops.dead_letters (id, source_queue, source_job_id, kind, tenant_id, ref,
           verified, retries, error_name, error_code, failed_at, alerted_at, settled_at,
           settled_ended)
         VALUES (gen_random_uuid(), 'template.delete', gen_random_uuid(), 'template.delete', $1,
           gen_random_uuid()::text, true, 10, 'AppError', 'provider_unavailable', now(), now(),
           CASE WHEN $2::boolean IS NOT NULL THEN now() END, $2::boolean)
         RETURNING id`,
        [tenantId, ended],
      );
      stranded.push(row!.id);
    }
    const [toSettle, endedEarlier] = stranded as [string, string];
    await expect(async () => {
      const [row] = await asOwner<{ settled: boolean; ended: boolean | null }>(
        `SELECT settled_at IS NOT NULL AS settled, settled_ended AS ended FROM ops.dead_letters
          WHERE id = $1`,
        [toSettle],
      );
      expect(row).toEqual({ settled: true, ended: false });
    }).toPass({ timeout: 100_000, intervals: [2_000] });
    await page.goto('/platform/ops/queues');
    const nothingLeft = letters.getByRole('row').filter({ hasText: toSettle });
    await expect(nothingLeft).toContainText('Nothing left to end');
    await expect(nothingLeft).toContainText('The work had finished or was started again.');
    await expect(nothingLeft.getByText('Retry', { exact: true })).toHaveCount(0);
    const ended = letters.getByRole('row').filter({ hasText: endedEarlier });
    await expect(ended).toContainText('Work ended for its company');
    await expect(ended).toContainText('The company can start it again.');
    await expect(ended.getByText('Retry', { exact: true })).toHaveCount(0);
  } finally {
    await asOwner(`DELETE FROM pgboss.job WHERE id = $1`, [jobId]);
    await asOwner(`DELETE FROM ops.dead_letters WHERE id = ANY($1::uuid[])`, [
      [deadLetterId, ...stranded],
    ]);
  }
});
