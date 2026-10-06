import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  buttonReply,
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
  standInRequests,
} from './messaging-support';
import { expectNoHorizontalOverflow, openFromNav, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

/** The value box of a report statistic, found by its label. */
function stat(page: Page, label: string) {
  return page
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('..');
}

test('teams route conversations, saved replies fill the composer and CSAT answers reach reports', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const email = uniqueEmail('teams');
  const slug = `team-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Tara Teams', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Team Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Settings → Inbox: a target counted in business hours (open all week, so the timer runs
  // whenever this test runs), a closed day, and CSAT surveys.
  await page.goto(`/c/${slug}/settings/inbox`);
  await page.getByLabel('Set a first-response target').check();
  await page.getByLabel('Target (minutes)').fill('30');
  await page.getByRole('button', { name: 'Save response target' }).click();
  await expect(page.getByText('Response target saved.')).toBeVisible();
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
    await page.getByLabel(day, { exact: true }).fill('00:00-24:00');
  await page.getByLabel('Count the first-response target in business hours').check();
  await page.getByRole('button', { name: 'Save business hours' }).click();
  await expect(page.getByText('Business hours saved.')).toBeVisible();
  await page.getByLabel('Date').fill('2030-01-01');
  await page.getByLabel('Name', { exact: true }).fill('New Year');
  await page.getByRole('button', { name: 'Add closed day' }).click();
  await expect(page.getByRole('list', { name: 'Closed days' })).toContainText('New Year');
  await page.getByRole('button', { name: /Remove/ }).click();
  await expect(page.getByText('No closed days.')).toBeVisible();
  await page.getByLabel('Ask customers to rate the help they received').check();
  await page.getByRole('button', { name: 'Save CSAT settings' }).click();
  await expect(page.getByText('CSAT settings saved.')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Settings → Teams: a round-robin team with the owner and the number.
  await page.goto(`/c/${slug}/settings/teams`);
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Create team' }) });
  await form.getByLabel('Team name').fill('Support');
  await form.getByLabel('Assign in turn (round robin)').check();
  await form.getByLabel('Tara Teams').check();
  await form.getByLabel(/\+91/).check();
  await form.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByText('Team created.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Support/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Settings → Saved replies.
  await page.goto(`/c/${slug}/settings/saved-replies`);
  await page.getByLabel('Shortcut').fill('hours');
  await page.getByLabel('Title').fill('Opening hours');
  await page.getByLabel('Reply', { exact: true }).fill('Hi {{name}}, we are open 9 to 5.');
  await page.getByRole('button', { name: 'Add saved reply' }).click();
  await expect(page.getByText('Saved reply added.')).toBeVisible();

  // The owner starts taking conversations; a customer writes and is routed straight to them.
  await page.goto(`/c/${slug}/inbox`);
  await page.getByRole('button', { name: 'Take conversations' }).click();
  await expect(page.getByText('Available for new conversations')).toBeVisible();
  const customer = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, customer, 'When are you open?'),
  );
  const item = page.getByRole('link', { name: /Priya Customer/ });
  await expect(item).toContainText('Assigned to Tara Teams', { timeout: 30_000 });
  await expect(item).toContainText('Support');
  await expect(item).toContainText(/reply due/);

  // Filters: the team filter keeps it, "No team" hides it.
  await page.getByLabel('Team').selectOption({ label: 'No team' });
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByText('No conversations here')).toBeVisible();
  await page.getByLabel('Team').selectOption({ label: 'Support' });
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await item.click();

  // A saved reply fills the composer with the customer's name; the member reviews and sends it.
  await page.getByLabel('Insert a saved reply').selectOption({ label: '/hours · Opening hours' });
  await expect(page.getByLabel('Reply', { exact: true })).toHaveValue(
    'Hi Priya Customer, we are open 9 to 5.',
  );
  // Exact: the conversation also has a “Send file” button.
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Hi Priya Customer, we are open 9 to 5.')).toBeVisible();
  await expect(thread.getByText('Sent to WhatsApp')).toBeVisible({ timeout: 20_000 });

  // Resolving sends the CSAT question with three reply buttons.
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(thread.getByText('CSAT survey')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/CSAT survey sent, no answer yet/)).toBeVisible();
  let surveyWamid: string | undefined;
  let buttonId: string | undefined;
  await expect
    .poll(
      async () => {
        const sent = (await standInRequests(request)).filter(
          (r) =>
            (r.body as { type?: string; to?: string })?.type === 'interactive' &&
            (r.body as { to?: string }).to === customer,
        );
        const last = sent.at(-1);
        const buttons = (
          last?.body as { interactive?: { action?: { buttons?: { reply: { id: string } }[] } } }
        )?.interactive?.action?.buttons;
        surveyWamid = last?.wamid;
        buttonId = buttons?.[0]?.reply.id;
        return Boolean(surveyWamid && buttonId);
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  // The customer taps the best rating: recorded, and the conversation stays resolved.
  await sendSignedWebhook(
    request,
    buttonReply(wabaId, phoneNumberId, customer, { id: buttonId!, title: 'Great' }, surveyWamid!),
  );
  await expect(page.getByText(/answered with the best rating/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();

  // Reports show the answer (the live inbox is left through the navigation, see openFromNav).
  await openFromNav(page, 'Reports');
  await expect(stat(page, 'CSAT')).toContainText('100%');
  await expect(stat(page, 'CSAT response rate')).toContainText('1 of 1 delivered');
  await expectNoHorizontalOverflow(page);
});
