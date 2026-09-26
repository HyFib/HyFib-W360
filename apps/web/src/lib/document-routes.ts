/**
 * Pages whose Content-Security-Policy allows a provider's browser SDK (set per document by
 * proxy.ts). A CSP belongs to the document that was loaded, so these pages must be opened with a
 * full page load; client-side navigation would keep the previous page's stricter policy.
 */
export const PROVIDER_PAGES = {
  /** Meta Embedded Signup (Facebook JS SDK and login popup). */
  facebook: /^\/c\/[^/]+\/settings\/channels\/?$/,
  /** Razorpay Standard Checkout (script and payment frame). */
  razorpay: /^\/c\/[^/]+\/billing\/?$/,
} as const;

export function needsOwnDocument(pathname: string): boolean {
  return Object.values(PROVIDER_PAGES).some((pattern) => pattern.test(pathname));
}
