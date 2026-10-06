import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
} from './messaging-support';
import { firstLink, signUpAndVerify, uniqueEmail, waitForEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

test('members who open the same conversation see each other until one leaves (ADR-243)', async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const ownerEmail = uniqueEmail('presence-owner');
  const agentEmail = uniqueEmail('presence-agent');
  const slug = `here-${Date.now().toString(36)}`;

  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await signUpAndVerify(owner, { name: 'Mira Owner', email: ownerEmail, password: PASSWORD });
  await owner.getByLabel('Company name').fill('Present Traders');
  await owner.getByLabel('Company address').fill(slug);
  await owner.getByRole('button', { name: 'Create company' }).click();
  await expect(owner).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail, slug });

  // An agent joins.
  await owner.goto(`/c/${slug}/settings/members`);
  await owner.getByLabel('Email address').fill(agentEmail);
  await owner.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.getByText(`Invitation sent to ${agentEmail}.`)).toBeVisible();
  const invitePath = new URL(firstLink(await waitForEmail(agentEmail, "You're invited"))).pathname;
  const agentCtx = await browser.newContext();
  const agent = await agentCtx.newPage();
  await agent.goto(invitePath);
  await signUpAndVerify(agent, {
    name: 'Ari Agent',
    email: agentEmail,
    password: PASSWORD,
    next: invitePath,
  });
  await agent.goto(invitePath);
  await agent.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(agent).toHaveURL(new RegExp(`/c/${slug}$`));

  // A customer writes; the conversation is unassigned, so both members see it.
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, randomWaId(), 'Is my order on its way?'),
  );
  await owner.goto(`/c/${slug}/inbox`);
  await owner.getByRole('link', { name: /Priya Customer/ }).click({ timeout: 30_000 });
  // The link navigates on the client: the address changes after the click returns.
  await expect(owner).toHaveURL(new RegExp(`/c/${slug}/inbox/[0-9a-f-]{36}(\\?|$)`));
  await expect(owner.getByRole('heading', { name: 'Priya Customer', level: 2 })).toBeVisible();
  const conversationPath = new URL(owner.url()).pathname;
  // Nobody else has it open yet.
  await expect(owner.getByText(/also (has|have) this conversation open/)).toHaveCount(0);

  // The agent opens it and is told at once that the owner has it open; the owner's next report,
  // within 20 seconds, names the agent.
  await agent.goto(conversationPath);
  await expect(agent.getByText('Mira Owner also has this conversation open.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(owner.getByText('Ari Agent also has this conversation open.')).toBeVisible({
    timeout: 30_000,
  });

  // The agent leaves the conversation; the owner's next report no longer names them.
  await agent.goto(`/c/${slug}/inbox`);
  await expect(agent.getByRole('link', { name: /Priya Customer/ })).toBeVisible();
  await expect(owner.getByText('Ari Agent also has this conversation open.')).toBeHidden({
    timeout: 30_000,
  });

  await ownerCtx.close();
  await agentCtx.close();
});
