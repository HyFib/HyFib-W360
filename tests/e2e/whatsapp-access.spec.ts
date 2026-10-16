import { randomBytes } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  messagingConfigured,
  newWabaId,
  setStandInSubscription,
  setStandInToken,
} from './messaging-support';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail, waitForEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

/**
 * A company whose WhatsApp account holds a token of its own at the Graph stand-in, described by
 * debug_token as given (ADR-137). connectTestChannel stores the account directly, never checked, so
 * the worker's minute sweep checks it within about a minute; its number has the messaging limit
 * tier given, as if its health had been read (ADR-398), or was never asked for one.
 */
async function companyWithToken(
  page: Page,
  request: APIRequestContext,
  token: { valid?: boolean; expiresAt?: number },
  channel: { wabaId?: string; messagingLimitTier?: string | null } = {},
) {
  const { wabaId, messagingLimitTier } = channel;
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
  const connected = await connectTestChannel({
    ownerEmail: email,
    slug,
    token: value,
    ...(wabaId ? { wabaId } : {}),
    ...(messagingLimitTier !== undefined ? { messagingLimitTier } : {}),
  });
  return { email, slug, account: `WhatsApp Business Account ${connected.wabaId}` };
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
  // Its health was never read: nothing is said of a messaging limit (ADR-398).
  await expect(page.getByText(/messaging limit/i)).toHaveCount(0);
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
  const { email, slug, account } = await companyWithToken(
    page,
    request,
    { expiresAt },
    { messagingLimitTier: 'TIER_250' },
  );
  await page.goto(`/c/${slug}/settings/channels`);
  await waitForAlert(page, 'HyFib’s access to WhatsApp expires soon');

  const warning = page.getByRole('status').filter({ hasText: 'expires soon' });
  await expect(warning).toContainText(`Meta reports that HyFib’s access to ${account} expires on`);
  // The number keeps sending meanwhile, and Channels says when the access was checked and expires.
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Access checked /)).toBeVisible();
  // And which permissions Meta lists for the access (ADR-381).
  await expect(
    page.getByText(
      'Granted to HyFib: manage the account, its numbers and templates (whatsapp_business_management); send messages (whatsapp_business_messaging)',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(/^Access expires /)).toBeVisible();
  await expect(page.getByText(/^Webhooks checked /)).toBeVisible();
  // The number's messaging limit tier, as Meta names it, and what it is (ADR-398).
  await expect(page.getByText('Messaging limit: TIER_250', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'A number’s messaging limit is the tier Meta reports for it, named as Meta names it. Since 7 October 2025 Meta sets messaging limits per business portfolio, shared by all its numbers.',
      { exact: true },
    ),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const text = await waitForEmail(email, `HyFib’s access to ${account} expires on`);
  expect(text).toContain(`Meta reports that HyFib’s access to ${account} expires on`);
  expect(text).toContain('Reconnecting gives HyFib a new access token.');
});

test('an account whose webhooks HyFib’s app cannot be subscribed to again shows that messages are not reaching HyFib', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  // Meta no longer lists HyFib's app for the account, and refuses to subscribe it again (ADR-138).
  const wabaId = newWabaId();
  await setStandInSubscription(request, { wabaId, subscribed: false, refuse: true });
  const { email, slug, account } = await companyWithToken(page, request, {}, { wabaId });
  await page.goto(`/c/${slug}/settings/channels`);
  await waitForAlert(page, 'WhatsApp messages are not reaching HyFib');

  const alert = page.getByRole('alert').filter({ hasText: 'not reaching HyFib' });
  await expect(alert).toContainText(
    `Meta no longer sends HyFib the messages and updates of ${account}: HyFib’s app is not subscribed to the account, and subscribing it again failed`,
  );
  await expect(alert).toContainText('HyFib tries again every 30 minutes');
  // The access itself is fine: the number keeps sending.
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Every page of the company shows it, with a way to Channels for an owner.
  await page.goto(`/c/${slug}/contacts`);
  const banner = page.getByRole('alert').filter({ hasText: 'not reaching HyFib' });
  await expect(banner).toContainText(account);
  await banner.getByRole('link', { name: 'Open Channels' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/settings/channels$`));

  const text = await waitForEmail(email, `WhatsApp messages for ${account} are not reaching HyFib`);
  expect(text).toContain(
    'Until it is subscribed again, messages customers send to +91 90000 12345 do not reach HyFib.',
  );
  expect(text).toContain('HyFib tries again every 30 minutes.');
  await setStandInSubscription(request, { wabaId, subscribed: true, refuse: false });
});
