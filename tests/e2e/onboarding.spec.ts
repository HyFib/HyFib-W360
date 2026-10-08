import { E2E_BREACHED_PASSWORD } from '../support/pwned-passwords-stand-in';
import { expect, test } from './fixtures';
import { firstLink, signUpAndVerify, uniqueEmail, waitForEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test.describe.configure({ mode: 'serial' });

test('owner signs up, verifies email, creates a company and invites a teammate who joins', async ({
  browser,
}) => {
  const ownerEmail = uniqueEmail('owner');
  const agentEmail = uniqueEmail('agent');
  const slug = `e2e-${Date.now().toString(36)}`;

  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await signUpAndVerify(owner, { name: 'Olivia Owner', email: ownerEmail, password: PASSWORD });

  await expect(owner.getByRole('heading', { name: 'Create your company' })).toBeVisible();
  await owner.getByLabel('Company name').fill('E2E Trading Co');
  await owner.getByLabel('Company address').fill(slug);
  await owner.getByRole('button', { name: 'Create company' }).click();
  await expect(owner).toHaveURL(new RegExp(`/c/${slug}$`));
  await expect(owner.getByRole('heading', { name: 'E2E Trading Co' })).toBeVisible();
  // Owners are privileged: the MFA grace-period banner must be shown.
  await expect(owner.getByText('Set up two-factor authentication').first()).toBeVisible();
  // The setup checklist is worked out from the company's data (ADR-233): nothing done yet.
  for (const step of [
    'Connect a WhatsApp Business number',
    'Add your contacts',
    'Invite your team',
    'Set a first-response target',
  ]) {
    await expect(owner.getByRole('link', { name: step })).toBeVisible();
  }

  await owner.getByRole('link', { name: 'Settings' }).click();
  await owner.getByRole('link', { name: 'Members' }).click();
  await owner.getByLabel('Email address').fill(agentEmail);
  await owner.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.getByText(`Invitation sent to ${agentEmail}.`)).toBeVisible();
  // A pending invitation is a team: the step is done.
  await owner.goto(`/c/${slug}`);
  await expect(owner.getByText('Invite your team (done)')).toBeVisible();
  await expect(owner.getByRole('link', { name: 'Invite your team' })).toHaveCount(0);
  await owner.goto(`/c/${slug}/settings/members`);

  const invitation = await waitForEmail(agentEmail, "You're invited");
  const inviteUrl = firstLink(invitation);
  const invitePath = new URL(inviteUrl).pathname;

  const agentCtx = await browser.newContext();
  const agent = await agentCtx.newPage();
  await agent.goto(invitePath);
  await expect(agent.getByRole('heading', { name: 'Join E2E Trading Co' })).toBeVisible();
  await signUpAndVerify(agent, {
    name: 'Arjun Agent',
    email: agentEmail,
    password: PASSWORD,
    next: invitePath,
  });
  await agent.goto(invitePath);
  await agent.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(agent).toHaveURL(new RegExp(`/c/${slug}$`));
  await expect(agent.getByRole('heading', { name: 'E2E Trading Co' })).toBeVisible();

  // Agents cannot invite or change roles.
  await agent.goto(`/c/${slug}/settings/members`);
  await expect(agent.getByRole('button', { name: 'Send invitation' })).toHaveCount(0);
  await expect(agent.getByRole('button', { name: 'Edit roles' })).toHaveCount(0);

  await owner.reload();
  await expect(owner.getByRole('cell', { name: /Arjun Agent/ })).toBeVisible();

  await ownerCtx.close();
  await agentCtx.close();
});

test('a user cannot open a company they do not belong to (same 404 as a missing company)', async ({
  browser,
}) => {
  const aEmail = uniqueEmail('tenant-a');
  const bEmail = uniqueEmail('tenant-b');
  const slugA = `iso-a-${Date.now().toString(36)}`;

  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  await signUpAndVerify(a, { name: 'Alice A', email: aEmail, password: PASSWORD });
  await a.getByLabel('Company name').fill('Isolation A');
  await a.getByLabel('Company address').fill(slugA);
  await a.getByRole('button', { name: 'Create company' }).click();
  await expect(a).toHaveURL(new RegExp(`/c/${slugA}$`));

  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await signUpAndVerify(b, { name: 'Bob B', email: bEmail, password: PASSWORD });
  const existing = await b.goto(`/c/${slugA}`);
  expect(existing?.status()).toBe(404);
  const missing = await b.goto(`/c/does-not-exist-${Date.now().toString(36)}`);
  expect(missing?.status()).toBe(404);
  const settings = await b.goto(`/c/${slugA}/settings/members`);
  expect(settings?.status()).toBe(404);

  await ctxA.close();
  await ctxB.close();
});

test('unauthenticated visitors are sent to sign-in and security headers are present', async ({
  page,
}) => {
  const response = await page.goto('/c/anything');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fc%2Fanything/);
  const headers = response?.headers() ?? {};
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['cache-control']).toContain('no-store');
});

test('choosing a company address that is taken shows a clear field error', async ({ page }) => {
  const email = uniqueEmail('dup');
  const slug = `dup-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Dana Dup', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('First Co');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  await page.goto('/onboarding');
  await page.getByLabel('Company name').fill('Second Co');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(
    page.getByText('That company address is already taken. Choose another.'),
  ).toBeVisible();
  await expect(page.getByText('Already taken', { exact: true })).toBeVisible();
});

test('a sign-up holding the NUL character is refused with a clear message before the database', async ({
  page,
  baseURL,
}) => {
  // PostgreSQL text cannot hold U+0000, so the user insert failed as an internal error (ADR-130).
  const response = await page.request.post('/api/auth/sign-up/email', {
    headers: { origin: baseURL ?? '' },
    data: { name: 'Nul\u0000Name', email: uniqueEmail('nul'), password: PASSWORD },
  });
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({
    message: 'Text cannot hold the NUL character (U+0000).',
  });
});

test('a password found in known data breaches is refused when signing up and when changing it (ADR-317)', async ({
  page,
}) => {
  test.skip(
    process.env.PASSWORD_BREACH_CHECK !== 'pwned-passwords' || !process.env.E2E_PWNED_PORT,
    'Pwned Passwords stand-in not configured',
  );
  const breached =
    'This password appears in known data breaches, so it is easy to guess. Choose a different one.';
  const email = uniqueEmail('breach');
  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill('Bea Breach');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(E2E_BREACHED_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText(breached)).toBeVisible();
  // Another password goes through.
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
  await page.goto(firstLink(await waitForEmail(email, 'Confirm your email')));
  await expect(page.getByRole('heading', { name: 'Create your company' })).toBeVisible();

  // Changing it to a breached password is refused too, and the password stays.
  await page.goto('/account');
  // The first "Current password" is the two-factor card's (the password card comes after it).
  await page.getByLabel('Current password').nth(1).fill(PASSWORD);
  await page.getByLabel('New password').fill(E2E_BREACHED_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText(breached)).toBeVisible();
  await expect(page.getByText('Password changed.')).toHaveCount(0);
});
