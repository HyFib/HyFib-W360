import { expect, test } from './fixtures';

/**
 * Regression test for a hydration race seen on WebKit in CI: input typed before React hydrated a
 * form was reset when react-hook-form registered its fields, and a click before hydration submitted
 * the form natively. Client-submitted forms now keep their controls disabled until hydration.
 */
test('client forms stay disabled until React hydrates them, then accept input', async ({
  page,
}) => {
  let releaseScripts!: () => void;
  const scriptsReleased = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  // Hold back the application bundles so the server-rendered form is observable before hydration.
  await page.route(
    (url) => url.pathname.startsWith('/_next/static/') && url.pathname.endsWith('.js'),
    async (route) => {
      await scriptsReleased;
      await route.continue();
    },
  );

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
