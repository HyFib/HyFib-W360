import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signUpAndVerify, uniqueEmail } from './support';

/*
 * Regression tests for hydration races seen on WebKit in CI: input typed before React hydrated a
 * form was reset when react-hook-form registered its fields, a click before hydration submitted the
 * form natively, and a password typed into the two-factor card before hydration never reached React.
 * Such controls now stay disabled until hydration.
 */

/** Holds back the application bundles, so the server-rendered page is observable before hydration. */
async function holdScripts(page: Page): Promise<() => void> {
  let releaseScripts!: () => void;
  const scriptsReleased = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  await page.route(
    (url) => url.pathname.startsWith('/_next/static/') && url.pathname.endsWith('.js'),
    async (route) => {
      await scriptsReleased;
      await route.continue();
    },
  );
  return releaseScripts;
}

test('client forms stay disabled until React hydrates them, then accept input', async ({
  page,
}) => {
  const releaseScripts = await holdScripts(page);

  await page.goto('/sign-in', { waitUntil: 'commit' });
  const email = page.getByLabel('Email');
  const submit = page.getByRole('button', { name: 'Sign in' });
  await expect(email).toBeVisible();
  await expect(email).toBeDisabled();
  await expect(submit).toBeDisabled();

  releaseScripts();
  await expect(email).toBeEnabled();
  await email.fill('nobody@example.test');
  await page.getByLabel('Password').fill('not the right password 1');
  await submit.click();
  await expect(page.getByText('The email or password is incorrect.')).toBeVisible();
  // A native (pre-hydration) submission would have put the form fields in the query string.
  expect(new URL(page.url()).search).toBe('');
});

test('the two-factor password field stays disabled until React hydrates it', async ({ page }) => {
  const password = 'correct horse battery staple 42';
  await signUpAndVerify(page, { name: 'Hana Hydrate', email: uniqueEmail('hydrate'), password });
  const releaseScripts = await holdScripts(page);

  await page.goto('/account', { waitUntil: 'commit' });
  // The first "Current password" is the two-factor card's (the password card comes after it).
  const current = page.getByLabel('Current password').first();
  await expect(current).toBeVisible();
  // A password typed before hydration reached the field but not React, so the button stayed
  // disabled for good (seen on WebKit in CI).
  await expect(current).toBeDisabled();

  releaseScripts();
  await expect(current).toBeEnabled();
  await current.fill(password);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  await expect(page.getByLabel('Code from your app')).toBeVisible();
});
