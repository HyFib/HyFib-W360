import { expect, test } from './fixtures';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test('a member turns a notice email off for their company, and it stays off (ADR-215)', async ({
  page,
}) => {
  const email = uniqueEmail('notices');
  const slug = `nt-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Nina Notices', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Notice Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  await page.goto(`/c/${slug}/settings`);
  await page.getByRole('link', { name: 'Notifications' }).click();
  await expect(page.getByText('Emails to you')).toBeVisible();
  await expect(
    page.getByText(/Security, sign-in and billing emails are always sent/),
  ).toBeVisible();
  // An owner can receive every kind; all start on.
  const boxes = page.getByRole('checkbox');
  await expect(boxes).toHaveCount(5);
  const mentions = page.getByRole('checkbox', { name: /Mentions in notes/ });
  await expect(mentions).toBeChecked();
  await mentions.uncheck();
  await page.getByRole('button', { name: 'Save email settings' }).click();
  await expect(page.getByText('Email settings saved.')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('checkbox', { name: /Mentions in notes/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Your campaigns finished/ })).toBeChecked();
  await expectNoHorizontalOverflow(page);
});
