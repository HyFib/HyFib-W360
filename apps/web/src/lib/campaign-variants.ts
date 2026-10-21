/**
 * The editor's defaults for a campaign's variants after A (ADR-405, ADR-410). The server checks every
 * share again (`variantSetProblem`): these only keep the editor from offering a set it would refuse.
 */

/** The least share any variant, A included, may have. */
export const MIN_VARIANT_SHARE = 10;

/** The labels of the variants after A, in order: a campaign tests up to five templates. */
export const LABELS_AFTER_A = ['B', 'C', 'D', 'E'] as const;

/** What variant A keeps, in percent, when the variants after it take `shares`. */
export function shareLeftForA(shares: readonly number[]): number {
  return 100 - shares.reduce((sum, share) => sum + share, 0);
}

/**
 * Whether another variant can be added at its default share: only while A keeps at least twice the
 * least share, so the new variant and A both keep at least 10% (adding never makes a set the
 * server refuses).
 */
export function canAddVariant(shares: readonly number[]): boolean {
  return shares.length < LABELS_AFTER_A.length && shareLeftForA(shares) >= 2 * MIN_VARIANT_SHARE;
}

/**
 * A new variant's share: B starts at 50%; a later one takes half of what A keeps, in steps of 5,
 * at least 10%.
 */
export function newVariantShare(shares: readonly number[]): number {
  if (shares.length === 0) return 50;
  return Math.max(MIN_VARIANT_SHARE, Math.floor(shareLeftForA(shares) / 2 / 5) * 5);
}
