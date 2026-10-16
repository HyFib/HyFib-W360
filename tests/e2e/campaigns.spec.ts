import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  sendSignedWebhook,
  standInRequests,
  statusUpdate,
} from './messaging-support';
import { firstLink, signUpAndVerify, uniqueEmail, waitForEmailContaining } from './support';

const PASSWORD = 'correct horse battery staple 42';
const standIn = `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}`;

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

test('a campaign is drafted, reviewed, started by the worker and reported per recipient', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail('campaigns');
  const slug = `cmp-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Cam Campaigns', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Campaign Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  // Its number's limit as if its health had been read (ADR-398): 250 contacts in 24 hours.
  const { wabaId, phoneNumberId } = await connectTestChannel({
    ownerEmail: email,
    slug,
    messagingLimit: 'TIER_250',
  });

  // An approved marketing template.
  await page.goto(`/c/${slug}/templates/new`);
  await page.getByLabel('Name').fill('spring_sale');
  await page.getByLabel('Language code').fill('en');
  await page.getByLabel('Category').selectOption('MARKETING');
  await page.getByLabel('Body').fill('Hello {{1}}, our spring sale starts today.');
  await page.getByLabel('{{1}}').fill('Asha');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: 'spring_sale', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Submit to Meta' }).click();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  // Submitted (no draft buttons) before reloading, which could cancel the submission's request.
  await expect(page.getByRole('button', { name: /^Submit/ })).toHaveCount(0);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('In review', { exact: true }).first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });
  const approved = await request.post(`${standIn}/__stand-in/template-status`, {
    data: { wabaId, name: 'spring_sale', status: 'APPROVED' },
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

  // Two tagged contacts; only one has a marketing opt-in.
  for (const [name, phone, optIn] of [
    ['Asha Rao', '+91 98765 12345', true],
    ['Bina Shah', '+91 98765 12346', false],
  ] as const) {
    await page.goto(`/c/${slug}/contacts/new`);
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Add contact' }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await page.getByLabel('Add tags').fill('vip');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Tags' })).toContainText('vip');
    if (optIn) {
      await page.getByLabel('How and when did they tell you?').fill('Signed up at the counter');
      await page.getByRole('button', { name: 'Record consent' }).click();
      await expect(page.getByText('Consent recorded.')).toBeVisible();
    }
  }

  // Draft → review → start.
  await page.goto(`/c/${slug}/campaigns`);
  await page.getByRole('link', { name: 'New campaign' }).click();
  await page.getByLabel('Campaign name').fill('Spring launch');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Spring launch', level: 1 })).toBeVisible();
  await page.getByLabel('Send from').selectOption({ index: 1 });
  await page.getByLabel('Template').selectOption({ label: 'spring_sale (en, marketing)' });
  await page.getByLabel('Body variable {{1}}').selectOption('name');
  await expect(page.getByLabel('Campaign message preview')).toContainText(
    'Hello [name, or “there”], our spring sale starts today.',
  );
  await page.getByLabel('Tag', { exact: true }).fill('vip');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved. The review below is updated.')).toBeVisible();
  await expect(page.getByText(/of 2 contacts in the audience can receive it now/)).toContainText(
    '1',
  );
  await expect(page.getByText('No marketing opt-in: 1')).toBeVisible();
  // The number's messaging limit against the contact who can receive it, a notice only (ADR-400).
  const limitNotice = page.getByRole('status').filter({
    hasText: "Within the number's messaging limit",
  });
  await expect(limitNotice).toContainText(
    "This campaign may reach up to 1 contact, within the 250 unique customers its number's messaging limit allows outside a customer service window in a moving 24 hours (Meta reported TIER_250 when HyFib last read the number).",
  );
  await expect(limitNotice).toContainText('HyFib cannot see how much of it they have used.');
  await expect(limitNotice).toContainText('Meta, not HyFib, enforces the limit');
  await page.getByRole('button', { name: 'Start campaign' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start campaign' }).click();

  // The worker's runner queues the message and the send worker hands it to WhatsApp.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Handed to WhatsApp', { exact: true }).locator('..')).toContainText(
      '1',
      { timeout: 1_000 },
    );
  }).toPass({ timeout: 45_000 });
  let sent: { body: unknown; wamid?: string } | undefined;
  await expect(async () => {
    sent = (await standInRequests(request))
      .filter((r) => r.path === `/v26.0/${phoneNumberId}/messages`)
      .pop();
    expect(sent?.wamid).toBeTruthy();
  }).toPass({ timeout: 30_000 });
  expect(sent?.body).toMatchObject({
    to: '919876512345',
    type: 'template',
    template: {
      name: 'spring_sale',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha Rao' }] }],
    },
  });

  // Meta reports delivery; the results count it with its denominator.
  await sendSignedWebhook(
    request,
    statusUpdate(wabaId, phoneNumberId, sent!.wamid!, 'delivered', '919876512345'),
  );
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('1 of 1 sent')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  // The runner completes the campaign on its next tick (about 10 seconds after queueing).
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });
  // The owner, whose authority it sent under, is emailed that it finished (ADR-214).
  const finishedMail = await waitForEmailContaining(
    email,
    'finished sending',
    'It handed 1 message to WhatsApp and skipped 1 of the 2 contacts in its audience',
  );
  expect(finishedMail).toContain(`/c/${slug}/campaigns/`);

  // Per-recipient outcomes and a formula-safe export.
  await page.getByRole('link', { name: 'Recipients' }).click();
  await expect(page.getByText('Not sent: No marketing opt-in')).toBeVisible();
  await expect(page.getByRole('cell', { name: /Delivered/ })).toBeVisible();
  const campaignPath = new URL(page.url()).pathname.replace(/\/recipients$/, '');
  const csv = await page.request.get(`${campaignPath}/export`);
  expect(csv.status()).toBe(200);
  const text = await csv.text();
  expect(text).toContain('+919876512345,Asha Rao,queued,,delivered');
  expect(text).toContain('+919876512346,Bina Shah,skipped,no_marketing_opt_in');

  // A key that reads campaigns finds the campaign and the results the page shows (ADR-125).
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Campaign reports');
  await page.getByRole('checkbox', { name: /Read campaigns/ }).check();
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page.getByRole('checkbox', { name: /Read conversations/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const tokenField = page.getByLabel('API key', { exact: true });
  await expect(tokenField).toBeVisible();
  const token = await tokenField.inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };
  const campaignId = campaignPath.split('/').pop()!;
  const listed = await request.get('/api/v1/campaigns?status=completed', { headers: auth });
  expect(listed.status()).toBe(200);
  expect(((await listed.json()) as { data: unknown[] }).data).toEqual([
    expect.objectContaining({
      id: campaignId,
      name: 'Spring launch',
      status: 'completed',
      completionReason: 'all_processed',
      templateName: 'spring_sale',
      audienceCount: 2,
      queuedCount: 1,
      skippedCount: 1,
    }),
  ]);
  const one = await request.get(`/api/v1/campaigns/${campaignId}`, { headers: auth });
  expect(one.status()).toBe(200);
  expect(((await one.json()) as { data: { results: unknown } }).data.results).toMatchObject({
    audience: 2,
    queued: 1,
    sent: 1,
    delivered: 1,
    read: 0,
    failed: 0,
    skipped: 1,
    skipReasons: [{ reason: 'no_marketing_opt_in', count: 1 }],
  });

  // Reading contacts and conversations too, it finds the contacts by what happened to the
  // campaign's message and by when they last wrote (ADR-126): Asha answers the campaign.
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, '919876512345', 'Interested in the sale!'),
  );
  const search = async (conditions: unknown[]) => {
    const found = await request.post('/api/v1/contacts/search', {
      headers: auth,
      data: { conditions },
    });
    expect(found.status()).toBe(200);
    return ((await found.json()) as { data: { name: string }[] }).data.map((c) => c.name);
  };
  await expect(async () => {
    expect(await search([{ type: 'campaign', campaignId, outcome: 'replied' }])).toEqual([
      'Asha Rao',
    ]);
  }).toPass({ timeout: 30_000 });
  expect(await search([{ type: 'campaign', campaignId, outcome: 'delivered' }])).toEqual([
    'Asha Rao',
  ]);
  // Bina was skipped: the campaign sent her nothing, so no outcome finds her.
  expect(await search([{ type: 'campaign', campaignId, outcome: 'not_delivered' }])).toEqual([]);
  expect(await search([{ type: 'last_message', op: 'within_days', days: 1 }])).toEqual([
    'Asha Rao',
  ]);
  expect(await search([{ type: 'last_message', op: 'not_within_days', days: 1 }])).toEqual([
    'Bina Shah',
  ]);

  // Reading campaigns and contacts, it lists the recipients the Recipients page shows, each with
  // what happened to it, and those one count of the results counts (ADR-127).
  type Recipients = {
    data: {
      contact: { name: string; phone: string };
      state: string;
      skipReason: string | null;
      message: { status: string } | null;
      repliedAt: string | null;
    }[];
    nextCursor: string | null;
  };
  const recipients = await request.get(`/api/v1/campaigns/${campaignId}/recipients`, {
    headers: auth,
  });
  expect(recipients.status()).toBe(200);
  const everyone = (await recipients.json()) as Recipients;
  expect(everyone.nextCursor).toBeNull();
  const byName = new Map(everyone.data.map((r) => [r.contact.name, r]));
  expect([...byName.keys()].sort()).toEqual(['Asha Rao', 'Bina Shah']);
  expect(byName.get('Asha Rao')).toMatchObject({
    contact: { phone: '+919876512345' },
    state: 'queued',
    message: { status: 'delivered' },
    repliedAt: expect.any(String),
  });
  expect(byName.get('Bina Shah')).toMatchObject({
    state: 'skipped',
    skipReason: 'no_marketing_opt_in',
    message: null,
  });
  const replied = await request.get(`/api/v1/campaigns/${campaignId}/recipients?outcome=replied`, {
    headers: auth,
  });
  expect(((await replied.json()) as Recipients).data.map((r) => r.contact.name)).toEqual([
    'Asha Rao',
  ]);
  const unknownOutcome = await request.get(
    `/api/v1/campaigns/${campaignId}/recipients?outcome=clicked`,
    { headers: auth },
  );
  expect(unknownOutcome.status()).toBe(422);

  // A key that pauses and cancels campaigns stops one scheduled for later (ADR-128): the page says
  // it paused through the API, and its history names the key.
  await page.goto(`/c/${slug}/campaigns`);
  await page.getByRole('link', { name: 'New campaign' }).click();
  await page.getByLabel('Campaign name').fill('Autumn preview');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Autumn preview', level: 1 })).toBeVisible();
  await page.getByLabel('Send from').selectOption({ index: 1 });
  await page.getByLabel('Template').selectOption({ label: 'spring_sale (en, marketing)' });
  await page.getByLabel('Body variable {{1}}').selectOption('name');
  await page.getByLabel('Tag', { exact: true }).fill('vip');
  await page.getByLabel('When', { exact: true }).selectOption('later');
  const later = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('Date and time').fill(`${later}T10:00`);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved. The review below is updated.')).toBeVisible();
  await page.getByRole('button', { name: 'Start campaign' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start campaign' }).click();
  await expect(page.getByText('Scheduled', { exact: true }).first()).toBeVisible();
  const autumnId = new URL(page.url()).pathname.split('/').pop()!;

  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Campaign control');
  await page.getByRole('checkbox', { name: /Pause and cancel campaigns/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const stopField = page.getByLabel('API key', { exact: true });
  await expect(stopField).toBeVisible();
  const stopAuth = { Authorization: `Bearer ${await stopField.inputValue()}` };
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  // The reading key does not stop campaigns.
  const notAllowed = await request.post(`/api/v1/campaigns/${autumnId}/pause`, { headers: auth });
  expect(notAllowed.status()).toBe(403);
  const paused = await request.post(`/api/v1/campaigns/${autumnId}/pause`, { headers: stopAuth });
  expect(paused.status()).toBe(200);
  expect(((await paused.json()) as { data: unknown }).data).toMatchObject({
    id: autumnId,
    name: 'Autumn preview',
    status: 'paused',
    pauseReason: 'api',
  });
  const byKey = 'through the API, key “Campaign control”';
  await page.goto(`/c/${slug}/campaigns/${autumnId}`);
  await expect(page.getByText('Paused through the API.', { exact: true })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: byKey })).toHaveCount(1);
  // A completed campaign is not paused, and the refusal names its status.
  const refused = await request.post(`/api/v1/campaigns/${campaignId}/pause`, {
    headers: stopAuth,
  });
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { error: unknown }).error).toMatchObject({
    code: 'conflict',
    message: expect.stringContaining("This campaign's status is completed."),
  });
  // A key that resumes what keys paused resumes it (ADR-176): it never started, so it is scheduled
  // again, and the history names that key. The stopping key does not resume.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Campaign resumer');
  await page.getByRole('checkbox', { name: /Resume campaigns keys paused/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const resumeField = page.getByLabel('API key', { exact: true });
  await expect(resumeField).toBeVisible();
  const resumeAuth = { Authorization: `Bearer ${await resumeField.inputValue()}` };
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const stopperResumes = await request.post(`/api/v1/campaigns/${autumnId}/resume`, {
    headers: stopAuth,
  });
  expect(stopperResumes.status()).toBe(403);
  const resumed = await request.post(`/api/v1/campaigns/${autumnId}/resume`, {
    headers: resumeAuth,
  });
  expect(resumed.status()).toBe(200);
  expect(((await resumed.json()) as { data: unknown }).data).toMatchObject({
    id: autumnId,
    status: 'scheduled',
    pauseReason: null,
  });
  await page.goto(`/c/${slug}/campaigns/${autumnId}`);
  await expect(page.getByText('Scheduled', { exact: true }).first()).toBeVisible();
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'Resumed' })
      .filter({ hasText: 'through the API, key “Campaign resumer”' }),
  ).toHaveCount(1);
  // Cancelled through the API, and a retry answers it as it is.
  for (let i = 0; i < 2; i += 1) {
    const canceled = await request.post(`/api/v1/campaigns/${autumnId}/cancel`, {
      headers: stopAuth,
    });
    expect(canceled.status()).toBe(200);
    expect(((await canceled.json()) as { data: unknown }).data).toMatchObject({
      status: 'canceled',
    });
  }
  await page.reload();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: byKey })).toHaveCount(2);

  // A key that writes drafts creates one from the completed campaign's number and template and
  // edits it (ADR-186); members find it in the app, its history naming the key, and a key that only
  // reads campaigns gets no settings.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Campaign drafts');
  await page.getByRole('checkbox', { name: /Create, edit and submit campaign drafts/ }).check();
  await page.getByRole('checkbox', { name: /Read campaigns/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const draftField = page.getByLabel('API key', { exact: true });
  await expect(draftField).toBeVisible();
  const draftAuth = { Authorization: `Bearer ${await draftField.inputValue()}` };
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const spring = (
    (await (await request.get(`/api/v1/campaigns/${campaignId}`, { headers: auth })).json()) as {
      data: { templateId: string; channel: { id: string } };
    }
  ).data;
  const readerCreates = await request.post('/api/v1/campaigns', {
    headers: auth,
    data: { name: 'Not allowed' },
  });
  expect(readerCreates.status()).toBe(403);
  const drafted = await request.post('/api/v1/campaigns', {
    headers: { ...draftAuth, 'Idempotency-Key': randomUUID() },
    data: {
      name: 'Winter preview',
      channelId: spring.channel.id,
      templateId: spring.templateId,
      variables: { body: [{ source: 'name', fallback: 'there' }] },
      audience: { conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
    },
  });
  expect(drafted.status()).toBe(201);
  const winter = ((await drafted.json()) as { data: { id: string } & Record<string, unknown> })
    .data;
  expect(winter).toMatchObject({
    name: 'Winter preview',
    status: 'draft',
    templateName: 'spring_sale',
    version: 1,
    settings: { audience: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] } },
  });
  const edited = await request.patch(`/api/v1/campaigns/${winter.id}`, {
    headers: draftAuth,
    data: { expectedVersion: 1, maxMessages: 500 },
  });
  expect(edited.status()).toBe(200);
  expect(((await edited.json()) as { data: unknown }).data).toMatchObject({
    version: 2,
    settings: { maxMessages: 500 },
  });
  // A change made from a version read before is refused, and changes nothing.
  const stale = await request.patch(`/api/v1/campaigns/${winter.id}`, {
    headers: draftAuth,
    data: { expectedVersion: 1, maxMessages: 400 },
  });
  expect(stale.status()).toBe(409);
  const readOnly = await request.get(`/api/v1/campaigns/${winter.id}`, { headers: auth });
  expect(((await readOnly.json()) as { data: unknown }).data).toMatchObject({
    id: winter.id,
    status: 'draft',
    version: null,
    settings: null,
  });
  // A completed campaign is not edited, and the refusal names its status.
  const notDraft = await request.patch(`/api/v1/campaigns/${campaignId}`, {
    headers: draftAuth,
    data: { maxMessages: 400 },
  });
  expect(notDraft.status()).toBe(409);
  expect(((await notDraft.json()) as { error: unknown }).error).toMatchObject({
    code: 'conflict',
    message: "Only draft campaigns can be edited. This campaign's status is completed.",
  });
  await page.goto(`/c/${slug}/campaigns/${winter.id}`);
  await expect(page.getByRole('heading', { name: 'Winter preview', level: 1 })).toBeVisible();
  const byDrafts = 'through the API, key “Campaign drafts”';
  await expect(page.getByRole('listitem').filter({ hasText: byDrafts })).toHaveCount(2);
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Created' }).filter({ hasText: byDrafts }),
  ).toHaveCount(1);
  // The key reviews its draft as members see it (ADR-193): the page counts the same audience. A key
  // that only reads campaigns gets no review, and a completed campaign is not reviewed.
  const reviewed = await request.get(`/api/v1/campaigns/${winter.id}/review`, {
    headers: draftAuth,
  });
  expect(reviewed.status()).toBe(200);
  const review = (
    (await reviewed.json()) as {
      data: { campaignId: string; version: number; audience: { total: number; eligible: number } };
    }
  ).data;
  expect(review).toMatchObject({ campaignId: winter.id, version: 2 });
  // The page puts the number that can receive it in its own element, as the review above reads.
  await expect(
    page.getByText(
      new RegExp(`of ${review.audience.total} contacts in the audience can receive it now`),
    ),
  ).toContainText(String(review.audience.eligible));
  const readerReviews = await request.get(`/api/v1/campaigns/${winter.id}/review`, {
    headers: auth,
  });
  expect(readerReviews.status()).toBe(403);
  const completedReview = await request.get(`/api/v1/campaigns/${campaignId}/review`, {
    headers: draftAuth,
  });
  expect(completedReview.status()).toBe(409);
  // The key cancels its draft (ADR-187), and a retry answers it as it is.
  for (let i = 0; i < 2; i += 1) {
    const dropped = await request.post(`/api/v1/campaigns/${winter.id}/cancel`, {
      headers: draftAuth,
    });
    expect(dropped.status()).toBe(200);
    expect(((await dropped.json()) as { data: unknown }).data).toMatchObject({
      id: winter.id,
      status: 'canceled',
    });
  }
  await page.reload();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: byDrafts })).toHaveCount(3);

  // The key submits a draft set to start in a month (ADR-202): it waits for a member's approval,
  // though members' own campaigns start at once here; a key that only reads campaigns cannot, and a
  // retry answers it as it is. The page names the key, and once the owner approves it, it is
  // scheduled under the owner's authority; the stopping key then cancels it.
  const inAMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 16);
  const launchCreated = await request.post('/api/v1/campaigns', {
    headers: { ...draftAuth, 'Idempotency-Key': randomUUID() },
    data: {
      name: 'Winter launch',
      channelId: spring.channel.id,
      templateId: spring.templateId,
      variables: { body: [{ source: 'name', fallback: 'there' }] },
      audience: { conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
      schedule: { kind: 'later', local: inAMonth },
    },
  });
  expect(launchCreated.status()).toBe(201);
  const launch = ((await launchCreated.json()) as { data: { id: string; version: number } }).data;
  const submitLaunch = (headers: Record<string, string>) =>
    request.post(`/api/v1/campaigns/${launch.id}/submit`, {
      headers,
      data: { expectedVersion: launch.version },
    });
  expect((await submitLaunch(auth)).status()).toBe(403);
  for (let i = 0; i < 2; i += 1) {
    const submitted = await submitLaunch(draftAuth);
    expect(submitted.status()).toBe(200);
    expect(((await submitted.json()) as { data: unknown }).data).toMatchObject({
      id: launch.id,
      status: 'pending_approval',
      // The same audience as the draft reviewed above, taken now.
      audienceCount: review.audience.total,
      skippedCount: review.audience.total - review.audience.eligible,
    });
  }
  // The key takes its submission back (ADR-203), a draft at a new version, and submits it again
  // from that version.
  const withdrawn = await request.post(`/api/v1/campaigns/${launch.id}/withdraw`, {
    headers: draftAuth,
  });
  expect(withdrawn.status()).toBe(200);
  expect(((await withdrawn.json()) as { data: unknown }).data).toMatchObject({
    id: launch.id,
    status: 'draft',
    audienceCount: 0,
  });
  const resubmitted = await request.post(`/api/v1/campaigns/${launch.id}/submit`, {
    headers: draftAuth,
    data: { expectedVersion: launch.version + 2 },
  });
  expect(resubmitted.status()).toBe(200);
  // The owner, who approves and sends campaigns, is emailed each submission (ADR-204), with a link
  // to the campaign's page.
  const approvalMail = await waitForEmailContaining(
    email,
    'Campaign “Winter launch” waits for your approval',
    'The API key “Campaign drafts” submitted the campaign “Winter launch”',
    60_000,
  );
  expect(approvalMail).toContain(
    `It would be sent to ${review.audience.eligible} of the ${review.audience.total}`,
  );
  expect(approvalMail).toContain('Approving it needs permission to send campaigns');
  // Until when it can be approved: the end of its sending period, a day after its start (ADR-209).
  expect(approvalMail).toContain('It can be approved until ');
  const reviewLink = firstLink(approvalMail);
  expect(new URL(reviewLink).pathname).toBe(`/c/${slug}/campaigns/${launch.id}`);
  await page.goto(reviewLink);
  await expect(
    page.getByText('Submitted through the API by the key “Campaign drafts”'),
  ).toBeVisible();
  await expect(
    page.getByText(/It can be approved until .*, when its sending period ends\./),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Submitted' }).filter({ hasText: byDrafts }),
  ).toHaveCount(2);
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Withdrawn' }).filter({ hasText: byDrafts }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Scheduled', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText('Sends under the authority of', { exact: true }).locator('..'),
  ).toContainText('Cam Campaigns');
  const launchCanceled = await request.post(`/api/v1/campaigns/${launch.id}/cancel`, {
    headers: stopAuth,
  });
  expect(launchCanceled.status()).toBe(200);
});
