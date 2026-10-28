'use server';
import { refresh } from 'next/cache';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Store connectors: connecting Shopify and WooCommerce stores, reading them again, removal. */

async function storesFor(slug: string) {
  const ctx = await tenantForAction(slug);
  const { stores } = await getRuntime();
  return { ctx, stores };
}

/** Returns Shopify's approval address; the browser goes there next. */
export async function startShopifyConnectAction(
  slug: string,
  input: { shop: string; callingCode: string },
): Promise<ActionResult<{ url: string }>> {
  return runAction(async () => {
    const { ctx, stores } = await storesFor(slug);
    return stores.startShopifyConnect(ctx, input, await requestMeta());
  });
}

/** Returns Shopify's approval address for customer access; the browser goes there next. */
export async function startCustomerAccessAction(
  slug: string,
  storeId: string,
): Promise<ActionResult<{ url: string }>> {
  return runAction(async () => {
    const { ctx, stores } = await storesFor(slug);
    return stores.startCustomerAccess(ctx, storeId, await requestMeta());
  });
}

/** Returns Shopify's approval address for shipment updates (ADR-413); the browser goes there next. */
export async function startShipmentAccessAction(
  slug: string,
  storeId: string,
): Promise<ActionResult<{ url: string }>> {
  return runAction(async () => {
    const { ctx, stores } = await storesFor(slug);
    return stores.startShipmentAccess(ctx, storeId, await requestMeta());
  });
}

/** Returns the WooCommerce store's approval address; the browser goes there next. */
export async function startWooConnectAction(
  slug: string,
  input: { url: string; callingCode: string },
): Promise<ActionResult<{ url: string; storeId: string }>> {
  return runAction(async () => {
    const { ctx, stores } = await storesFor(slug);
    return stores.startWooConnect(ctx, input, await requestMeta());
  });
}

export async function saveWooKeysAction(
  slug: string,
  input: { url: string; callingCode: string; consumerKey: string; consumerSecret: string },
): Promise<ActionResult<{ storeId: string }>> {
  return runAction(async () => {
    const { ctx, stores } = await storesFor(slug);
    const result = await stores.saveWooKeys(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function updateStoreSettingsAction(
  slug: string,
  input: { id: string; callingCode: string },
): Promise<ActionResult<{ ok: true }>> {
  return runAction(async () => {
    const { ctx, stores } = await storesFor(slug);
    const result = await stores.updateStoreSettings(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function requestStoreSyncAction(
  slug: string,
  input: { id: string },
): Promise<ActionResult<{ ok: true }>> {
  return runAction(async () => {
    const { ctx, stores } = await storesFor(slug);
    const result = await stores.requestStoreSync(ctx, input.id, await requestMeta());
    refresh();
    return result;
  });
}

export async function removeStoreAction(
  slug: string,
  input: { id: string },
): Promise<ActionResult<{ ok: true }>> {
  return runAction(async () => {
    const { ctx, stores } = await storesFor(slug);
    const result = await stores.removeStore(ctx, input.id, await requestMeta());
    refresh();
    return result;
  });
}

export async function answerPrivacyRequestAction(
  slug: string,
  input: { id: string },
): Promise<ActionResult<{ ok: true }>> {
  return runAction(async () => {
    const { ctx, stores } = await storesFor(slug);
    const result = await stores.answerPrivacyRequest(ctx, input.id, await requestMeta());
    refresh();
    return result;
  });
}
