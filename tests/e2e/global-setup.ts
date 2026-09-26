import { startGraphStandIn } from '../support/graph-stand-in';
import { E2E_CHANNEL_TOKEN } from './messaging-support';

/**
 * Starts the TEST-ONLY Graph API stand-in when the end-to-end environment points the worker at it
 * (META_GRAPH_BASE_URL=http://127.0.0.1:$E2E_GRAPH_PORT, allowed only for APP_ENV=local|test).
 */
export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  const port = Number(process.env.E2E_GRAPH_PORT ?? '0');
  if (!port || !process.env.META_APP_ID || !process.env.META_APP_SECRET) return undefined;
  const standIn = await startGraphStandIn({
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    acceptTokens: [E2E_CHANNEL_TOKEN],
    port,
  });
  return () => standIn.close();
}
