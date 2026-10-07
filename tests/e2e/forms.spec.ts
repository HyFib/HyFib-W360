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

/*
 * Controlled inputs outside a ClientForm: React keeps a value entered before hydration in the
 * field but never reports it to the component, so it showed without reaching state (a save stayed
 * disabled, or the old value was used). These controls also stay disabled until hydration.
 */

/** Signs up, creates a company and returns its address. */
async function signUpWithCompany(page: Page, name: string, prefix: string): Promise<string> {
  const slug = `${prefix}-${Date.now().toString(36)}`;
  await signUpAndVerify(page, {
    name,
    email: uniqueEmail(prefix),
    password: 'correct horse battery staple 42',
  });
  await page.getByLabel('Company name').fill(`${name} Traders`);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  return slug;
}

test('the company security checkbox stays disabled until React hydrates it', async ({ page }) => {
  const slug = await signUpWithCompany(page, 'Sena Secure', 'hy-sec');
  const releaseScripts = await holdScripts(page);

  await page.goto(`/c/${slug}/settings/security`, { waitUntil: 'commit' });
  const requireMfa = page.getByLabel('Require two-factor authentication for every member');
  await expect(requireMfa).toBeVisible();
  // Ticked before hydration, the box showed ticked while Save stayed disabled.
  await expect(requireMfa).toBeDisabled();

  releaseScripts();
  await expect(requireMfa).toBeEnabled();
  await requireMfa.check();
  // The page also saves which roles see numbers masked (ADR-226), with a Save of its own below.
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(page.getByText('Security settings saved.')).toBeVisible();
  await page.reload();
  await expect(requireMfa).toBeChecked();
});

test('the contact erasure choice stays disabled until React hydrates it', async ({ page }) => {
  const slug = await signUpWithCompany(page, 'Esha Erase', 'hy-erase');
  await page.goto(`/c/${slug}/contacts/new`);
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Phone number').fill('+91 98765 43210');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByRole('heading', { name: 'Asha Rao', level: 1 })).toBeVisible();
  const contactPage = page.url();
  const releaseScripts = await holdScripts(page);

  await page.goto(contactPage, { waitUntil: 'commit' });
  const keepSuppressed = page.getByLabel('Keep the number on the suppression list');
  await expect(keepSuppressed).toBeVisible();
  // Unticked before hydration, the box showed unticked while the erasure still suppressed the
  // number.
  await expect(keepSuppressed).toBeDisabled();

  releaseScripts();
  await expect(keepSuppressed).toBeEnabled();
  await keepSuppressed.uncheck();
  await page.getByRole('button', { name: 'Erase contact' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Erase contact' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/contacts$`));
  // The choice reached the erasure: the number was not put on the suppression list.
  await page.goto(`/c/${slug}/settings/messaging`);
  await expect(page.getByText('No numbers are suppressed.')).toBeVisible();
});

test('the automation editor and simulator stay disabled until React hydrates them', async ({
  page,
}) => {
  const slug = await signUpWithCompany(page, 'Arun Automate', 'hy-bot');
  await page.goto(`/c/${slug}/automations`);
  await page.getByLabel('Name', { exact: true }).fill('Greeter');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Greeter', level: 1 })).toBeVisible();
  const automationPage = page.url();
  const releaseScripts = await holdScripts(page);

  await page.goto(automationPage, { waitUntil: 'commit' });
  // The automation's name, a field of its first step and the simulated contact's name.
  const name = page.locator('#automation-name');
  const message = page.locator('#step-welcome-text');
  const contactName = page.locator('#sim-name');
  await expect(name).toBeVisible();
  // Typed before hydration, text showed in the field but never reached the draft.
  await expect(name).toBeDisabled();
  await expect(message).toBeDisabled();
  await expect(contactName).toBeDisabled();

  releaseScripts();
  await expect(name).toBeEnabled();
  await name.fill('Hydrated greeter');
  await message.fill('Hi {{name}}, from the hydrated greeter.');
  await contactName.fill('Ravi');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText('Hi Ravi, from the hydrated greeter.')).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Hydrated greeter', level: 1 })).toBeVisible();
});
