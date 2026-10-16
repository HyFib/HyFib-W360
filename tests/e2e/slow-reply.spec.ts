import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
  standInRequests,
} from './messaging-support';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

/**
 * The automatic reply when members are slow to answer (ADR-384), end to end: turned on in
 * Settings → Inbox, sent by the worker's minute sweep once a customer has waited the delay without
 * a member's reply, accepted by Meta's stand-in as a plain text and shown in the thread as an
 * automatic message. The shortest delay is a minute and the sweep runs each minute, so the test
 * waits up to a few minutes for it, polling.
 */
test('an automatic reply goes to a customer members are slow to answer', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const email = uniqueEmail('slow');
  const slug = `slow-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Sana Slow', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Slow Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Settings → Inbox: an unknown placeholder is refused, then the reply is turned on.
  await page.goto(`/c/${slug}/settings/inbox`);
  await page.getByLabel('Reply automatically when members are slow to answer').check();
  await page.getByLabel('Message', { exact: true }).fill('Hi {{agent}}, one moment.');
  await page.getByLabel('Send after (minutes)').fill('1');
  await page.getByRole('button', { name: 'Save automatic reply' }).click();
  await expect(
    page.getByText('Unknown placeholder {{agent}}. Use {{name}} or {{company}}.'),
  ).toBeVisible();
  await page
    .getByLabel('Message', { exact: true })
    .fill('Thanks {{name}}, {{company}} will reply shortly.');
  await page.getByRole('button', { name: 'Save automatic reply' }).click();
  await expect(page.getByText('Automatic reply saved.')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  // Saved: a reload shows the setting as it is stored.
  await page.reload();
  await expect(
    page.getByLabel('Reply automatically when members are slow to answer'),
  ).toBeChecked();
  await expect(page.getByLabel('Send after (minutes)')).toHaveValue('1');

  // A customer writes and nobody answers.
  const customer = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, customer, 'Is my order on its way?'),
  );
  const body = 'Thanks Priya Customer, Slow Traders will reply shortly.';

  // The worker sends it once the minute has passed (the sweep runs each minute).
  await expect
    .poll(
      async () =>
        (await standInRequests(request)).filter((r) => {
          const sent = r.body as { to?: string; type?: string; text?: { body?: string } } | null;
          return sent?.to === customer && sent.type === 'text' && sent.text?.body === body;
        }).length,
      { timeout: 240_000, intervals: [5_000] },
    )
    .toBe(1);

  // The thread shows it as an automatic reply, and the customer still waits for a member.
  await page.goto(`/c/${slug}/inbox`);
  await page.getByRole('link', { name: /Priya Customer/ }).click();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText(body)).toBeVisible();
  await expect(thread.getByText('Automatic reply')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
