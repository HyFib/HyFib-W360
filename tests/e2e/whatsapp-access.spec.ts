import { randomBytes } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { connectTestChannel, messagingConfigured, setStandInToken } from './messaging-support';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail, waitForEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

/**
 * A company whose WhatsApp account holds a token of its own at the Graph stand-in, described by
 * debug_token as given (ADR-137). connectTestChannel stores the account directly, never checked, so
 * the worker's minute sweep checks it within about a minute.
 */
async function companyWithToken(
  page: Page,
  request: APIRequestContext,
  token: { valid?: boolean; expiresAt?: number },
) {
  const email = uniqueEmail('access');
  const suffix = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const slug = `access-${suffix}`;
  await signUpAndVerify(page, { name: 'Asha Access', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(`Access Traders ${suffix}`);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const value = `EAAGe2eAccess${randomBytes(12).toString('hex')}`;
  await setStandInToken(request, { token: value, ...token });
  const { wabaId } = await connectTestChannel({ ownerEmail: email, slug, token: value });
  return { email, slug, account: `WhatsApp Business Account ${wabaId}` };
}

/** Reloads the page until the alert appears (the minute sweep checks within about a minute). */
async function waitForAlert(page: Page, title: string) {
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(title, { exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 150_000, intervals: [5_000] });
}

test('an account whose access Meta no longer accepts is marked for reconnecting, shown on every page and emailed once', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const { email, slug, account } = await companyWithToken(page, request, { valid: false });
  await page.goto(`/c/${slug}/settings/channels`);
  await waitForAlert(page, 'Reconnect WhatsApp');

  // Channels explains it, and the number is marked.
  const alert = page.getByRole('alert').filter({ hasText: 'Reconnect WhatsApp' });
  await expect(alert).toContainText(
    `Meta no longer accepts HyFib’s access to ${account}: Meta reports that the access token is no longer valid`,
  );
  await expect(alert).toContainText('Its numbers cannot send messages until it is reconnected.');
  await expect(alert).toContainText('Choose Connect WhatsApp and pick the same account');
  await expect(page.getByText('Reconnect needed')).toBeVisible();
  await expect(
    page.getByText(
      'Meta no longer accepts HyFib’s access to this number’s WhatsApp Business Account: Meta reports that the access token is no longer valid. Reconnect WhatsApp.',
    ),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Every page of the company shows it, with a way to Channels for an owner.
  await page.goto(`/c/${slug}/contacts`);
  const banner = page.getByRole('alert').filter({ hasText: 'Reconnect WhatsApp' });
  await expect(banner).toContainText(`Meta no longer accepts HyFib’s access to ${account}`);
  await expect(banner).toContainText('Connect the same account again on Channels.');
  await banner.getByRole('link', { name: 'Open Channels' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/settings/channels$`));

  // The owner is emailed what happened and how to reconnect.
  const text = await waitForEmail(
    email,
    `Reconnect WhatsApp: Meta no longer accepts HyFib’s access to ${account}`,
  );
  expect(text).toContain(
    `Meta no longer accepts HyFib’s access to ${account}: Meta reports that the access token is no longer valid.`,
  );
  expect(text).toContain(
    '+91 90000 12345 cannot send messages, templates or campaigns from HyFib.',
  );
  expect(text).toContain('Settings → Channels');
  expect(text).toContain(`/c/${slug}/settings/channels`);
  expect(text).not.toContain('EAAGe2eAccess');
});

test('an access that expires within 7 days is shown as a warning and its owner is reminded', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const expiresAt = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const { email, slug, account } = await companyWithToken(page, request, { expiresAt });
  await page.goto(`/c/${slug}/settings/channels`);
  await waitForAlert(page, 'HyFib’s access to WhatsApp expires soon');

  const warning = page.getByRole('status').filter({ hasText: 'expires soon' });
  await expect(warning).toContainText(`Meta reports that HyFib’s access to ${account} expires on`);
  // The number keeps sending meanwhile, and Channels says when the access was checked and expires.
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Access checked /)).toBeVisible();
  await expect(page.getByText(/^Access expires /)).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const text = await waitForEmail(email, `HyFib’s access to ${account} expires on`);
  expect(text).toContain(`Meta reports that HyFib’s access to ${account} expires on`);
  expect(text).toContain('Reconnecting gives HyFib a new access token.');
});
