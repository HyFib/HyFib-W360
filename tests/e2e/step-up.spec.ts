import pg from 'pg';
import { expect, test } from './fixtures';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

/** A fixture step: the member's sessions started `minutes` ago (the auth role owns sessions). */
async function ageSessions(email: string, minutes: number) {
  const auth = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL_AUTH });
  await auth.connect();
  try {
    const result = await auth.query(
      `UPDATE auth.sessions s SET created_at = now() - make_interval(mins => $2)
         FROM auth.users u WHERE u.id = s.user_id AND u.email = $1`,
      [email.toLowerCase(), minutes],
    );
    expect(result.rowCount).toBeGreaterThan(0);
  } finally {
    await auth.end();
  }
}

test('a member who signed in a while ago signs in again before exporting or handing out a key', async ({
  page,
}) => {
  test.skip(!process.env.E2E_DATABASE_URL_AUTH, 'needs E2E_DATABASE_URL_AUTH');
  const email = uniqueEmail('stepup');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `stepup-${suffix}`;
  await signUpAndVerify(page, { name: 'Asha Owner', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(`Step Co ${suffix}`);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: `Step Co ${suffix}` })).toBeVisible();

  // Just signed in: the export and a new key are offered.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Order system');
  await page.getByRole('checkbox', { name: /Read templates/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  await expect(page.getByLabel('API key', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  await page.goto(`/c/${slug}/settings/data`);
  await expect(page.getByRole('link', { name: 'Download the export' })).toBeVisible();

  // An hour later the same pages ask to sign in again first.
  await ageSessions(email, 60);
  await page.reload();
  await expect(page.getByText('Sign in again to continue').first()).toBeVisible();
  await expect(
    page.getByText('Downloading the export needs a sign-in within the last 15 minutes.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download the export' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete the company' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.goto(`/c/${slug}/settings/api-keys`);
  await expect(
    page.getByText('Creating or rotating a key needs a sign-in within the last 15 minutes.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create API key' })).toHaveCount(0);

  // An action started from a page loaded earlier is refused too, and offers the same way back.
  await page.getByRole('button', { name: /Rotate/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Rotate key' }).click();
  await expect(page.getByText(/For your security, sign in again to do this/)).toBeVisible();

  // Signing in again (password; two-factor would follow if it were on) returns to the page.
  await page.getByRole('button', { name: 'Sign in again' }).first().click();
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/settings/api-keys$`));
  await expect(page.getByRole('button', { name: 'Create API key' })).toBeVisible();
  await page.getByRole('button', { name: /Rotate/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Rotate key' }).click();
  await expect(page.getByLabel('API key', { exact: true })).toBeVisible();
});
