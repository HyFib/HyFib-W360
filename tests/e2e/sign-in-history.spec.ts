import { expect, test } from './fixtures';
import { expectNoHorizontalOverflow, signUpAndVerify, totp, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

/**
 * Sign-in history (ADR-136) through Better Auth's real flows: the email confirmation link, a password
 * with an authenticator code, a trusted device and a backup code are one sign-in each; turning
 * two-factor on, the password step that waits for a code and a wrong code are none.
 */
test('Account & security lists each completed sign-in and how it was made', async ({ page }) => {
  const email = uniqueEmail('history');
  // Following the confirmation link signs in.
  await signUpAndVerify(page, { name: 'Hana History', email, password: PASSWORD });
  await page.goto('/account');
  const rows = page.getByRole('table', { name: 'Recent sign-ins' }).locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Email confirmation link');
  await expect(rows.nth(0)).toContainText('This session');

  // Turning two-factor on renews the session: no sign-in.
  await page.getByLabel('Current password').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = (await page.locator('code').first().textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  await page.getByLabel('Code from your app').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on two-factor' }).click();
  await expect(page.getByText('Backup codes', { exact: true })).toBeVisible();
  const backupCodes = (await page.locator('ul.font-mono li').allTextContents()).map((c) =>
    c.trim(),
  );
  expect(backupCodes).toHaveLength(10);

  // A password, then a wrong code, then the right one, trusting the device: one sign-in.
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/two-factor/);
  await page.getByLabel('Authentication code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('That code is not valid.')).toBeVisible();
  await page.getByLabel('Trust this device for 30 days').check();
  await page.getByLabel('Authentication code').fill(totp(secret, Date.now() + 30_000));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/onboarding/);

  // Signed out on a trusted device, the password alone signs in.
  await page.context().clearCookies({ name: /session_token$/ });
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/onboarding/);

  // On a device that is not trusted, a backup code instead of the authenticator.
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/two-factor/);
  await page.getByRole('button', { name: 'Use a backup code instead' }).click();
  await page.getByLabel('Backup code').fill(backupCodes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/onboarding/);

  await page.goto('/account');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Password and backup code');
  await expect(rows.nth(0)).toContainText('This session');
  await expect(rows.nth(1)).toContainText('Password on a trusted device (no code asked)');
  await expect(rows.nth(2)).toContainText('Password and authenticator code');
  await expect(rows.nth(3)).toContainText('Email confirmation link');
  await expect(rows.filter({ hasText: 'This session' })).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
});
