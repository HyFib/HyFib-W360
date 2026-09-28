import type { Page } from '@playwright/test';

const razorpayPort = Number(process.env.E2E_RAZORPAY_PORT ?? '0');
const standInUrl = `http://127.0.0.1:${razorpayPort}`;

/** True when the e2e run has the Razorpay stand-in and the test key and webhook secrets. */
export const razorpayConfigured = Boolean(
  razorpayPort && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET,
);

/**
 * TEST-ONLY replacement for Razorpay's checkout.js, served to this browser by Playwright. It asks
 * the local stand-in (through an intercepted URL) to do what Standard Checkout does: take a card
 * payment on the server-created order and hand back the signed handler response.
 */
const FAKE_CHECKOUT = `
window.Razorpay = class {
  constructor(options) { this.options = options; }
  on() {}
  open() {
    fetch('https://checkout.razorpay.com/__e2e/pay?order_id=' + encodeURIComponent(this.options.order_id))
      .then((r) => r.json())
      .then((response) => this.options.handler(response));
  }
};`;

/** Routes Razorpay Checkout in this page to the test-only replacement above. */
export async function routeFakeCheckout(page: Page) {
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: FAKE_CHECKOUT }),
  );
  await page.route('https://checkout.razorpay.com/__e2e/pay**', async (route) => {
    const orderId = new URL(route.request().url()).searchParams.get('order_id');
    const res = await fetch(`${standInUrl}/__stand-in/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order_id: orderId }),
    });
    await route.fulfill({
      status: res.status,
      json: await res.json(),
      headers: { 'access-control-allow-origin': '*' },
    });
  });
}
