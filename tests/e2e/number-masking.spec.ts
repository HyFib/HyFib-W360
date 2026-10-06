import { expect, test } from './fixtures';
import { firstLink, signUpAndVerify, uniqueEmail, waitForEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test('an owner hides customers’ numbers from agents, whose pages then never hold them whole (ADR-226)', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const ownerEmail = uniqueEmail('mask-owner');
  const agentEmail = uniqueEmail('mask-agent');
  const slug = `mask-${Date.now().toString(36)}`;
  // A number unique to this run, so the page checks below cannot match anything else.
  const tail = String(Date.now()).slice(-7);
  const whole = `+9198${tail}1`;
  const digits = whole.slice(1);

  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await signUpAndVerify(owner, { name: 'Mira Owner', email: ownerEmail, password: PASSWORD });
  await owner.getByLabel('Company name').fill('Masked Traders');
  await owner.getByLabel('Company address').fill(slug);
  await owner.getByRole('button', { name: 'Create company' }).click();
  await expect(owner).toHaveURL(new RegExp(`/c/${slug}$`));

  // A contact with a number.
  await owner.goto(`/c/${slug}/contacts/new`);
  await owner.getByLabel('Name').fill('Dev Customer');
  await owner.getByLabel('Phone number').fill(whole);
  await owner.getByRole('button', { name: 'Add contact' }).click();
  await expect(owner.getByRole('heading', { name: 'Dev Customer', level: 1 })).toBeVisible();
  const contactUrl = new URL(owner.url()).pathname;
  await expect(owner.getByText(whole).first()).toBeVisible();

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

  // Before masking the agent sees the number.
  await agent.goto(contactUrl);
  await expect(agent.getByRole('heading', { name: 'Dev Customer', level: 1 })).toBeVisible();
  await expect(agent.getByText(whole).first()).toBeVisible();

  // The owner hides numbers from agents in Settings → Security.
  await owner.goto(`/c/${slug}/settings/security`);
  await expect(owner.getByText('+919•••••••45')).toBeVisible();
  await owner.getByRole('checkbox', { name: /^Agents/ }).check();
  await owner.getByRole('button', { name: 'Save' }).nth(1).click();
  await expect(owner.getByText('Number masking saved.')).toBeVisible();

  // The agent's contact page and list show the number masked, and nothing on them holds it whole:
  // neither the HTML nor the data React was given.
  const masked = `+919${'•'.repeat(digits.length - 5)}${digits.slice(-2)}`;
  await agent.goto(contactUrl);
  await expect(agent.getByRole('heading', { name: 'Dev Customer', level: 1 })).toBeVisible();
  await expect(agent.getByText(masked).first()).toBeVisible();
  expect(await agent.content()).not.toContain(digits);
  await expect(agent.getByLabel('Phone number')).toBeDisabled();
  await agent.goto(`/c/${slug}/contacts`);
  await expect(agent.getByRole('cell', { name: masked })).toBeVisible();
  expect(await agent.content()).not.toContain(digits);
  // Part of the number finds nothing; the whole number finds the contact.
  await agent.goto(`/c/${slug}/contacts?q=${digits.slice(3, 9)}`);
  await expect(agent.getByRole('cell', { name: masked })).toHaveCount(0);
  await agent.goto(`/c/${slug}/contacts?q=${encodeURIComponent(whole)}`);
  await expect(agent.getByRole('cell', { name: masked })).toBeVisible();

  // The owner still sees it whole.
  await owner.goto(contactUrl);
  await expect(owner.getByText(whole).first()).toBeVisible();

  await ownerCtx.close();
  await agentCtx.close();
});
