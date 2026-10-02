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

test('platform staff send a dead-lettered job back to its queue once, with a reason', async ({
  page,
}) => {
  test.setTimeout(180_000);
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

    // pg-boss's own retry: waiting again, with one more attempt allowed.
    const [job] = await asOwner<{ state: string; retry_limit: number; completed_on: Date | null }>(
      `SELECT state::text AS state, retry_limit, completed_on FROM pgboss.job WHERE id = $1`,
      [jobId],
    );
    expect(job).toEqual({ state: 'retry', retry_limit: 4, completed_on: null });

    // In the platform audit log.
    await page.goto('/platform');
    await expect(page.getByText('platform.dead_letter_retried').first()).toBeVisible();
  } finally {
    await asOwner(`DELETE FROM pgboss.job WHERE id = $1`, [jobId]);
    await asOwner(`DELETE FROM ops.dead_letters WHERE id = $1`, [deadLetterId]);
  }
});
