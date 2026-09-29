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
 * payment on the server-created order, or authorise the server-created subscription and take its
 * first payment, and hand back the signed handler response.
 */
const FAKE_CHECKOUT = `
window.Razorpay = class {
  constructor(options) { this.options = options; }
  on() {}
  open() {
    const query = this.options.subscription_id
      ? 'subscription_id=' + encodeURIComponent(this.options.subscription_id)
      : 'order_id=' + encodeURIComponent(this.options.order_id);
    fetch('https://checkout.razorpay.com/__e2e/pay?' + query)
      .then((r) => r.json())
      .then((response) => { if (response.razorpay_payment_id) this.options.handler(response); });
  }
};`;

/**
 * Routes Razorpay Checkout in this page to the test-only replacement above. With `closeAfterPaying`,
 * the payment is taken but the page never hears of it (the customer closed Checkout right after
 * paying); `onPaid` receives each payment id.
 */
export async function routeFakeCheckout(
  page: Page,
  options: { closeAfterPaying?: boolean; onPaid?: (paymentId: string) => void } = {},
) {
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: FAKE_CHECKOUT }),
  );
  await page.route('https://checkout.razorpay.com/__e2e/pay**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const subscriptionId = params.get('subscription_id');
    const res = await fetch(`${standInUrl}/__stand-in/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        subscriptionId ? { subscription_id: subscriptionId } : { order_id: params.get('order_id') },
      ),
    });
    const response = (await res.json()) as { razorpay_payment_id?: string };
    if (response.razorpay_payment_id) options.onPaid?.(response.razorpay_payment_id);
    await route.fulfill({
      status: res.status,
      json: options.closeAfterPaying ? { closed: true } : response,
      headers: { 'access-control-allow-origin': '*' },
    });
  });
}
