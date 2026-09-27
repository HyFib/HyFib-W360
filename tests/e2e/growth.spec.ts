import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures';
import {
  adInboundMessage,
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
} from './messaging-support';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

test('a chat link opens WhatsApp, counts clicks, attributes conversations and powers a website button', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const email = uniqueEmail('growth');
  const slug = `growth-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Gita Growth', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Growth Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Create a link; the preview shows what the customer's chat box will hold.
  await page.getByRole('link', { name: 'Growth' }).first().click();
  await expect(page.getByRole('heading', { name: 'Growth' })).toBeVisible();
  await expect(page.getByText('No links yet.')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Instagram bio');
  await page.getByLabel('Pre-filled message').fill('Hi! I saw your post');
  await expect(page.getByText('Hi! I saw your post (ref XXXXXX)')).toBeVisible();
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByText('Link created.')).toBeVisible();
  await page.getByRole('link', { name: 'Instagram bio' }).click();
  await expect(page.getByRole('heading', { name: 'Instagram bio' })).toBeVisible();
  const summary = await page
    .getByText(/^Opens a chat with E2E Traders, reference code/)
    .innerText();
  const refCode = /reference code ([A-HJ-NP-Z2-9]{6})\./.exec(summary)?.[1];
  expect(refCode).toBeTruthy();
  await expect(
    page.getByRole('img', { name: 'QR code for the chat link Instagram bio' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download SVG' })).toHaveAttribute(
    'download',
    'instagram-bio-qr.svg',
  );
  const shortUrl = await page.getByLabel('Short link', { exact: true }).inputValue();
  const linkPath = new URL(shortUrl).pathname;
  expect(linkPath).toMatch(/^\/l\/[a-z2-7]{12}$/);
  const waMe = `https://wa.me/919000012345?text=Hi!%20I%20saw%20your%20post%20(ref%20${refCode})`;
  await expect(page.getByLabel('Direct WhatsApp link')).toHaveValue(waMe);
  await expectNoHorizontalOverflow(page);

  // The short link counts the click and redirects to WhatsApp, telling it nothing about the page.
  const click = await request.get(linkPath, { maxRedirects: 0 });
  expect(click.status()).toBe(302);
  expect(click.headers()['location']).toBe(waMe);
  expect(click.headers()['referrer-policy']).toBe('no-referrer');
  expect(click.headers()['cache-control']).toBe('no-store');
  expect(click.headers()['set-cookie']).toBeUndefined();
  await page.reload();
  await expect(page.getByText('Clicks in the last 30 days: 1')).toBeVisible();

  // The customer sends the pre-filled message: the inbox says where the conversation came from.
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, randomWaId(), `Hi! I saw your post (ref ${refCode})`),
  );
  await page.getByRole('link', { name: 'Inbox' }).first().click();
  await page.getByRole('link', { name: /Priya Customer/ }).click({ timeout: 20_000 });
  await expect(page.getByText('Came from the chat link')).toBeVisible();
  await page.getByRole('link', { name: 'Instagram bio' }).click();
  await expect(page.getByText(/Conversations from this link in the last 30 days: 1/)).toBeVisible();

  // A click-to-WhatsApp ad: the ad is recorded, the visitor's ad click id is not.
  await sendSignedWebhook(
    request,
    adInboundMessage(wabaId, phoneNumberId, randomWaId(), 'Is the offer on?', {
      source_url: 'https://fb.me/e2e-diwali',
      source_id: '120200000000777',
      source_type: 'ad',
      headline: 'Diwali offer',
      ctwa_clid: 'e2e-click-id',
    }),
  );
  await page.goto(`/c/${slug}/growth/ads`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Diwali offer')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'https://fb.me/e2e-diwali' })).toBeVisible();

  // A website button that opens the link.
  await page.getByRole('link', { name: 'Website button' }).click();
  await expect(page.getByText('No website buttons yet.')).toBeVisible();
  await page.getByLabel('Button text').fill('Chat with us');
  await page.getByLabel('Greeting (optional)').fill('Questions? We reply on WhatsApp.');
  await page.getByRole('button', { name: 'Create widget' }).click();
  await expect(page.getByText('Widget created.')).toBeVisible();
  const tag = await page.getByLabel('Script tag').inputValue();
  const src = /<script src="([^"]+)" async><\/script>/.exec(tag)?.[1];
  expect(src).toMatch(/\/widget\/[a-z2-7]{16}\.js$/);
  await expectNoHorizontalOverflow(page);

  const script = await request.get(new URL(src!).pathname);
  expect(script.status()).toBe(200);
  expect(script.headers()['content-type']).toContain('text/javascript');
  expect(script.headers()['cross-origin-resource-policy']).toBe('cross-origin');
  expect(script.headers()['cache-control']).toBe('public, max-age=300');
  expect(script.headers()['set-cookie']).toBeUndefined();

  // Another site embeds the tag: the button appears and opens the short link in a new tab. The
  // test serves the site from its own loopback origin (another site than the app's, and not a
  // public origin, which Chromium would stop from loading scripts from this local stack).
  const shopServer = createServer((req, res) => {
    if (req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><head><title>Shop</title></head><body><h1>Our shop</h1>${tag}</body></html>`,
    );
  });
  await new Promise<void>((resolve) => shopServer.listen(0, '127.0.0.1', resolve));
  const shop = `http://127.0.0.1:${(shopServer.address() as AddressInfo).port}/`;
  try {
    const site = await page.context().newPage();
    const requested: string[] = [];
    site.on('request', (r) => requested.push(r.url()));
    await site.goto(shop);
    const button = site.getByRole('link', { name: 'Chat with us' });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('href', shortUrl);
    await expect(button).toHaveAttribute('target', '_blank');
    await expect(button).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(site.getByText('Questions? We reply on WhatsApp.')).toBeVisible();
    // The script loads nothing else, sends nothing of its own and stores nothing on the site.
    expect(requested.filter((url) => !url.startsWith(shop))).toEqual([src]);
    expect(
      await site.evaluate(() => ({
        cookie: document.cookie,
        local: localStorage.length,
        session: sessionStorage.length,
      })),
    ).toEqual({ cookie: '', local: 0, session: 0 });
    await site.close();
  } finally {
    shopServer.closeAllConnections();
    await new Promise((resolve) => shopServer.close(resolve));
  }

  // Archiving the link stops the short link and hides the button.
  await page.goto(`/c/${slug}/growth`);
  await page.getByRole('link', { name: 'Instagram bio' }).click();
  await page.getByRole('button', { name: 'Archive link Instagram bio' }).click();
  await expect(page.getByRole('button', { name: 'Restore link Instagram bio' })).toBeVisible();
  const stopped = await request.get(linkPath, { maxRedirects: 0 });
  expect(stopped.status()).toBe(404);
  expect(await stopped.text()).toContain('This chat link is not available');
  expect((await request.get(new URL(src!).pathname)).status()).toBe(404);
  await page.goto(`/c/${slug}/growth/widgets`);
  await expect(page.getByText('Link archived: the button does not appear')).toBeVisible();
});
