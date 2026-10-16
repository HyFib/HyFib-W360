/**
 * Browser-safe entry point for the automation builder: the graph model, its checks and the pure
 * interpreter (used by the in-browser simulator). Nothing here touches the database.
 */
export * from './graph';
export * from './interpreter';
/** Tags as the inbox stores them, for the simulator's typed tags. */
export { normalizeTag } from '../contacts/fields';
/** The limits of product messages, for products steps (ADR-383). */
export { PRODUCT_MESSAGE_LIMITS } from '../commerce/product-message';
