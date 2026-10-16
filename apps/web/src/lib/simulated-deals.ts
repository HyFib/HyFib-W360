import {
  coerceDealFieldValue,
  type AutomationGraph,
  type DealFacts,
  type DealFieldShape,
} from '@w360/domain/automation-model';

/**
 * The simulated deal the builder's simulator gives conditions on deal fields (ADR-393): no open
 * deal, one or several in each pipeline, and one's values typed one key=value per line.
 */
export type SimulatedDealCount = 'one' | 'none' | 'several';

/** key=value lines as a map (the last line for a key wins); lines without a key are left out. */
export function typedPairs(typed: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const line of typed.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) pairs.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return pairs;
}

/** The typed lines with `key` set to `value` (null removes it), blank lines left out. */
export function withPair(typed: string, key: string, value: string | null): string {
  return [
    ...typed.split('\n').filter((line) => {
      const i = line.indexOf('=');
      return line.trim() && (i <= 0 || line.slice(0, i).trim() !== key);
    }),
    ...(value === null ? [] : [`${key}=${value}`]),
  ].join('\n');
}

/**
 * What a simulated run's deal field rules read: the same simulated deal in every active pipeline,
 * with its typed values read as the deal's form reads them (values of no field, or that their field
 * does not take, are left out), or no deal or several there; a pipeline that is not active reads as
 * the runner reads an archived one.
 */
export function simulatedDeals(
  sim: { deals: SimulatedDealCount; dealValues: string },
  graph: AutomationGraph,
  pipelines: readonly { id: string }[],
  dealFields: readonly (DealFieldShape & { key: string })[],
): Map<string, DealFacts> {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, typed] of typedPairs(sim.dealValues)) {
    const field = dealFields.find((f) => f.key === key);
    const coerced = field ? coerceDealFieldValue(field, typed) : null;
    if (coerced?.ok && coerced.value !== null) attributes[key] = coerced.value;
  }
  const deal: DealFacts =
    sim.deals === 'one'
      ? { ok: true, attributes }
      : { ok: false, note: sim.deals === 'none' ? 'deal_not_open' : 'deal_ambiguous' };
  const deals = new Map<string, DealFacts>(pipelines.map((pl) => [pl.id, deal]));
  for (const node of graph.nodes) {
    if (node.type !== 'condition') continue;
    for (const rule of node.rules) {
      if (rule.kind === 'deal_field' && !deals.has(rule.pipelineId))
        deals.set(rule.pipelineId, { ok: false, note: 'deal_stage_unavailable' });
    }
  }
  return deals;
}
