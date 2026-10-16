/**
 * The limits and rules of product messages (research M-169), without server dependencies: shared
 * by the inbox and the public API (`commerce/model`) and by automations, whose model also runs in
 * the browser (ADR-383).
 */
export const PRODUCT_MESSAGE_LIMITS = {
  /** product_list: 1 to 10 sections (M-169); HyFib also keeps the total at 30 products. */
  sections: 10,
  productsPerMessage: 30,
  sectionTitleLength: 24,
  headerLength: 60,
  bodyLength: 1024,
  footerLength: 60,
} as const;

/** Further rules the schema cannot express (the product_list limits of M-169). */
export function productListProblem(sections: { title: string; productIds: string[] }[]) {
  const total = sections.reduce((n, s) => n + s.productIds.length, 0);
  if (total > PRODUCT_MESSAGE_LIMITS.productsPerMessage) {
    return `Send at most ${PRODUCT_MESSAGE_LIMITS.productsPerMessage} products in one message.`;
  }
  if (sections.length > 1 && sections.some((s) => !s.title)) {
    return 'Give every section a title when there is more than one.';
  }
  const ids = sections.flatMap((s) => s.productIds);
  if (new Set(ids).size !== ids.length) return 'Each product can appear only once.';
  return null;
}
