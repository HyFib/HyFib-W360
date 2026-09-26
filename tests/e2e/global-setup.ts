import { startGraphStandIn } from '../support/graph-stand-in';
import { startRazorpayStandIn } from '../support/razorpay-stand-in';
import { E2E_CHANNEL_TOKEN } from './messaging-support';

/**
 * Starts the TEST-ONLY provider stand-ins when the end-to-end environment points the app at them
 * (META_GRAPH_BASE_URL=http://127.0.0.1:$E2E_GRAPH_PORT and
 * RAZORPAY_API_BASE_URL=http://127.0.0.1:$E2E_RAZORPAY_PORT, both allowed only for
 * APP_ENV=local|test).
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
  if (closers.length === 0) return undefined;
  return async () => {
    await Promise.all(closers.map((close) => close()));
  };
}
