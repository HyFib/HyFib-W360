import { expect, test } from './fixtures';
import { signUpAndVerify, totp, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test('a user enrols TOTP two-factor and must present a code at the next sign-in', async ({
  page,
}) => {
  const email = uniqueEmail('mfa');
  await signUpAndVerify(page, { name: 'Maya MFA', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('MFA Testing Co');
  await page.getByLabel('Company address').fill(`mfa-${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'MFA Testing Co' })).toBeVisible();

  await page.goto('/account');
  await page.getByLabel('Current password').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = (await page.locator('code').first().textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  await page.getByLabel('Code from your app').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on two-factor' }).click();
  await expect(page.getByText('Backup codes', { exact: true })).toBeVisible();
  await expect(page.locator('ul.font-mono li')).toHaveCount(10);

  // Sign out, then sign in again: a second factor is now required.
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/two-factor/);
  await page.getByLabel('Authentication code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('That code is not valid.')).toBeVisible();
  await page.getByLabel('Authentication code').fill(totp(secret, Date.now() + 30_000));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'MFA Testing Co' })).toBeVisible();
  // With MFA enabled the owner no longer sees the set-up banner.
  await expect(page.getByText('Set up two-factor authentication')).toHaveCount(0);
});
