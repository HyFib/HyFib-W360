import { expect, test } from './fixtures';
import {
  connectTestChannel,
  messagingConfigured,
  sendSignedWebhook,
  standInRequests,
  templateButtonReply,
} from './messaging-support';
import { expectNoHorizontalOverflow, openFromNav, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
const standIn = `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}`;

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

test('an automation started by replies to a chosen campaign and button is built, simulated, published and answers a customer’s tap (ADR-414)', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const email = uniqueEmail('cmpreply');
  const slug = `cmpreply-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Rhea Replies', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Reply Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // An approved marketing template with two quick replies.
  await page.goto(`/c/${slug}/templates/new`);
  await page.getByLabel('Name').fill('diwali_offer');
  await page.getByLabel('Language code').fill('en');
  await page.getByLabel('Category').selectOption('MARKETING');
  await page.getByLabel('Body').fill('Hello {{1}}, our Diwali offers are here.');
  await page.getByLabel('{{1}}').fill('Asha');
  for (const [i, text] of ['Interested', 'Not now'].entries()) {
    await page.getByRole('button', { name: 'Add quick reply' }).click();
    await page.getByLabel('Quick reply text').nth(i).fill(text);
  }
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: 'diwali_offer', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Submit to Meta' }).click();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('button', { name: /^Submit/ })).toHaveCount(0);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('In review', { exact: true }).first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });
  const approved = await request.post(`${standIn}/__stand-in/template-status`, {
    data: { wabaId, name: 'diwali_offer', status: 'APPROVED' },
  });
  expect(approved.status()).toBe(200);
  await page.goto(`/c/${slug}/templates`);
  await page.getByRole('button', { name: 'Refresh from Meta' }).click();
  await expect(page.getByText(/Refresh requested/)).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });

  // A tagged contact with a marketing opt-in.
  await page.goto(`/c/${slug}/contacts/new`);
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Phone number').fill('+91 98765 22345');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByRole('heading', { name: 'Asha Rao', level: 1 })).toBeVisible();
  await page.getByLabel('Add tags').fill('festive');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Tags' })).toContainText('festive');
  await page.getByLabel('How and when did they tell you?').fill('Signed up at the counter');
  await page.getByRole('button', { name: 'Record consent' }).click();
  await expect(page.getByText('Consent recorded.')).toBeVisible();

  // The campaign sends the template to her.
  await page.goto(`/c/${slug}/campaigns`);
  await page.getByRole('link', { name: 'New campaign' }).click();
  await page.getByLabel('Campaign name').fill('Diwali launch');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Diwali launch', level: 1 })).toBeVisible();
  await page.getByLabel('Send from').selectOption({ index: 1 });
  await page.getByLabel('Template').selectOption({ label: 'diwali_offer (en, marketing)' });
  await page.getByLabel('Body variable {{1}}').selectOption('name');
  await page.getByLabel('Tag', { exact: true }).fill('festive');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved. The review below is updated.')).toBeVisible();
  await page.getByRole('button', { name: 'Start campaign' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start campaign' }).click();
  let sent: { body: unknown; wamid?: string } | undefined;
  await expect(async () => {
    sent = (await standInRequests(request))
      .filter(
        (r) =>
          r.path === `/v26.0/${phoneNumberId}/messages` &&
          (r.body as { to?: string })?.to === '919876522345',
      )
      .pop();
    expect(sent?.wamid).toBeTruthy();
  }).toPass({ timeout: 60_000 });
  expect(sent?.body).toMatchObject({ type: 'template', template: { name: 'diwali_offer' } });

  // The automation: started by a tap on “Interested” in that campaign.
  await openFromNav(page, 'Automations');
  await page.getByLabel('Name', { exact: true }).fill('Diwali follow-up');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Diwali follow-up' })).toBeVisible();
  await page.getByLabel('Start when').selectOption('campaign_reply');
  const campaignPicker = page.getByLabel('Campaign', { exact: true });
  await expect(campaignPicker.locator('option').first()).toHaveText('Any campaign');
  // The company's one campaign, named with its status (sending or completed by now).
  await expect(campaignPicker.locator('option').nth(1)).toHaveText(/^Diwali launch \(/);
  await campaignPicker.selectOption({ index: 1 });
  // The chosen campaign's quick replies, from its template.
  const replyPicker = page.getByLabel('Reply', { exact: true });
  await expect(replyPicker.locator('option')).toHaveText([
    'Any reply',
    'Tapping “Interested”',
    'Tapping “Not now”',
  ]);
  await replyPicker.selectOption('Interested');
  // Campaign fields work here, and are named in the help.
  await page.getByText('Campaign fields for texts').click();
  await expect(
    page.getByText('Quick-reply button tapped (empty for a quoting reply)'),
  ).toBeVisible();
  await page
    .locator('#step-welcome-text')
    .fill('Thanks {{name}}, we noted “{{campaign.button}}” for {{campaign.name}}.');
  await expect(page.getByText(/to fix before publishing/)).toBeHidden();
  await expectNoHorizontalOverflow(page);

  // The simulator answers as a reply to the chosen campaign, tapping the chosen button.
  await expect(page.getByText('Sample campaign reply')).toBeVisible();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(
    page.getByText('Thanks Asha, we noted “Interested” for Diwali launch.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published.')).toBeVisible();

  // She taps “Interested” on the campaign message: the worker runs the automation.
  await sendSignedWebhook(
    request,
    templateButtonReply(
      wabaId,
      phoneNumberId,
      '919876522345',
      { payload: 'Interested', text: 'Interested' },
      sent!.wamid!,
    ),
  );
  await expect
    .poll(
      async () =>
        (await standInRequests(request)).filter(
          (r) =>
            (r.body as { to?: string; type?: string })?.to === '919876522345' &&
            (r.body as { type?: string }).type === 'text',
        ).length,
      { timeout: 30_000 },
    )
    .toBe(1);
  const answer = (await standInRequests(request)).find(
    (r) =>
      (r.body as { to?: string; type?: string })?.to === '919876522345' &&
      (r.body as { type?: string }).type === 'text',
  );
  expect(answer?.body).toMatchObject({
    text: { body: 'Thanks Asha Rao, we noted “Interested” for Diwali launch.' },
  });

  // The run's page names the campaign, the variant and the button.
  await openFromNav(page, 'Automations');
  await page.getByRole('link', { name: 'All runs' }).click();
  await expect(page.getByRole('table')).toContainText('Reply to a campaign');
  await page.getByRole('table').getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: 'Run of Diwali follow-up' })).toBeVisible();
  await expect(page.getByText(/started .* by reply to a campaign\./)).toBeVisible();
  await expect(
    page.getByText('A reply to Diwali launch, variant A, tapping “Interested”.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Diwali launch' })).toHaveAttribute(
    'href',
    new RegExp(`/c/${slug}/campaigns/[0-9a-f-]{36}$`),
  );
  await expectNoHorizontalOverflow(page);
});
