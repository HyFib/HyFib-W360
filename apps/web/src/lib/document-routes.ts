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

/**
 * The inbox's files passed on from WhatsApp (ADR-216). They are never pages of HyFib, so proxy.ts
 * gives them `FILE_POLICY` in place of a page's policy (ADR-382).
 */
export const FILE_ROUTE = /^\/c\/[^/]+\/inbox\/[^/]+\/media\/[^/]+\/?$/;

/** A file's Content-Security-Policy: nothing in it runs or loads, should a browser render it. */
export const FILE_POLICY = "default-src 'none'; sandbox";
