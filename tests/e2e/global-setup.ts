import { startGraphStandIn } from '../support/graph-stand-in';
import {
  E2E_BREACHED_PASSWORD,
  startPwnedPasswordsStandIn,
} from '../support/pwned-passwords-stand-in';
import { startRazorpayStandIn } from '../support/razorpay-stand-in';
import { startShopifyStandIn } from '../support/shopify-stand-in';
import { startWooStandIn } from '../support/woocommerce-stand-in';
import { E2E_CHANNEL_TOKEN } from './messaging-support';

/**
 * Starts the TEST-ONLY provider stand-ins when the end-to-end environment points the app at them
 * (META_GRAPH_BASE_URL=http://127.0.0.1:$E2E_GRAPH_PORT,
 * RAZORPAY_API_BASE_URL=http://127.0.0.1:$E2E_RAZORPAY_PORT and
 * SHOPIFY_TEST_BASE_URL=http://127.0.0.1:$E2E_SHOPIFY_PORT and
 * PWNED_PASSWORDS_BASE_URL=http://127.0.0.1:$E2E_PWNED_PORT, all allowed only for
 * APP_ENV=local|test). WooCommerce sites are addressed by URL, so its stand-in only needs a port
 * (and loopback egress, again only for local|test).
 */
export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  const closers: (() => Promise<void>)[] = [];
  const graphPort = Number(process.env.E2E_GRAPH_PORT ?? '0');
  if (graphPort && process.env.META_APP_ID && process.env.META_APP_SECRET) {
    const graph = await startGraphStandIn({
      appId: process.env.META_APP_ID,
      appSecret: process.env.META_APP_SECRET,
      acceptTokens: [E2E_CHANNEL_TOKEN],
      port: graphPort,
    });
    closers.push(() => graph.close());
  }
  const razorpayPort = Number(process.env.E2E_RAZORPAY_PORT ?? '0');
  if (razorpayPort && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    const razorpay = await startRazorpayStandIn({
      keyId: process.env.RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      port: razorpayPort,
    });
    closers.push(() => razorpay.close());
  }
  const shopifyPort = Number(process.env.E2E_SHOPIFY_PORT ?? '0');
  if (shopifyPort && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) {
    const shopify = await startShopifyStandIn({
      clientId: process.env.SHOPIFY_CLIENT_ID,
      clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
      complianceUri: `${process.env.E2E_BASE_URL ?? 'http://localhost:3000'}/api/webhooks/shopify`,
      port: shopifyPort,
    });
    closers.push(() => shopify.close());
  }
  const pwnedPort = Number(process.env.E2E_PWNED_PORT ?? '0');
  if (pwnedPort && process.env.PASSWORD_BREACH_CHECK === 'pwned-passwords') {
    const pwned = await startPwnedPasswordsStandIn({
      breached: { [E2E_BREACHED_PASSWORD]: 3 },
      port: pwnedPort,
    });
    closers.push(() => pwned.close());
  }
  const wooPort = Number(process.env.E2E_WOO_PORT ?? '0');
  if (wooPort) {
    const woo = await startWooStandIn({ port: wooPort });
    closers.push(() => woo.close());
  }
  if (closers.length === 0) return undefined;
  return async () => {
    await Promise.all(closers.map((close) => close()));
  };
}
