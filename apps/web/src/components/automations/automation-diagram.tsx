import {
  NODE_TYPE_LABELS,
  edgesOf,
  type AutomationGraph,
  type AutomationNode,
} from '@w360/domain/automation-model';

/**
 * A generated picture of the automation: steps in layers by distance from the first step, arrows
 * for each branch. It mirrors the step list (the accessible representation); each box links to its
 * step. Arrows back to an earlier layer (loops) are drawn on the right.
 */
const W = 190;
const H = 54;
const GAP_X = 36;
const GAP_Y = 64;
const PAD = 24;

interface Placed {
  node: AutomationNode;
  x: number;
  y: number;
  depth: number;
}

function layout(graph: AutomationGraph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const queue: string[] = [];
  if (byId.has(graph.start)) {
    depth.set(graph.start, 0);
    queue.push(graph.start);
  }
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = byId.get(id);
    if (!node) continue;
    for (const edge of edgesOf(node)) {
      if (edge.target && byId.has(edge.target) && !depth.has(edge.target)) {
        depth.set(edge.target, (depth.get(id) ?? 0) + 1);
        queue.push(edge.target);
      }
    }
  }
  const deepest = Math.max(-1, ...depth.values());
  for (const node of graph.nodes) if (!depth.has(node.id)) depth.set(node.id, deepest + 1);
  const layers = new Map<number, AutomationNode[]>();
  for (const node of graph.nodes) {
    const d = depth.get(node.id) ?? 0;
    layers.set(d, [...(layers.get(d) ?? []), node]);
  }
  const widest = Math.max(1, ...[...layers.values()].map((l) => l.length));
  const width = PAD * 2 + widest * W + (widest - 1) * GAP_X + 60;
  const placed = new Map<string, Placed>();
  for (const [d, nodes] of layers) {
    const rowWidth = nodes.length * W + (nodes.length - 1) * GAP_X;
    const start = (width - 60 - rowWidth) / 2;
    nodes.forEach((node, i) => {
      placed.set(node.id, { node, x: start + i * (W + GAP_X), y: PAD + d * (H + GAP_Y), depth: d });
    });
  }
  const height = PAD * 2 + (Math.max(0, ...layers.keys()) + 1) * (H + GAP_Y) - GAP_Y;
  return { placed, width, height };
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function AutomationDiagram({ graph }: { graph: AutomationGraph }) {
  const { placed, width, height } = layout(graph);
  const edges: { from: Placed; to: Placed; label: string; key: string }[] = [];
  for (const p of placed.values()) {
    edgesOf(p.node).forEach((edge, i) => {
      const to = edge.target ? placed.get(edge.target) : undefined;
      if (to) edges.push({ from: p, to, label: edge.label, key: `${p.node.id}-${i}` });
    });
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-muted/30">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Diagram of ${graph.nodes.length} steps, starting at ${graph.start}. The step list below describes the same flow.`}
        className="text-foreground"
      >
        <defs>
          <marker
            id="automation-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
          </marker>
        </defs>
        {edges.map(({ from, to, label, key }) => {
          const forward = to.depth > from.depth;
          const x1 = from.x + W / 2;
          const y1 = from.y + H;
          const x2 = to.x + W / 2;
          const y2 = to.y;
          const d = forward
            ? `M ${x1} ${y1} C ${x1} ${y1 + GAP_Y / 2}, ${x2} ${y2 - GAP_Y / 2}, ${x2} ${y2}`
            : `M ${from.x + W} ${from.y + H / 2} C ${from.x + W + 56} ${from.y + H / 2}, ${to.x + W + 56} ${to.y + H / 2}, ${to.x + W} ${to.y + H / 2}`;
          const lx = forward ? x1 + (x2 - x1) * 0.25 + 4 : from.x + W + 8;
          const ly = forward ? y1 + GAP_Y * 0.35 : from.y + H / 2 - 6;
          return (
            <g key={key}>
              <path
                d={d}
                fill="none"
                className="stroke-muted-foreground"
                strokeWidth={1.25}
                markerEnd="url(#automation-arrow)"
              />
              <text x={lx} y={ly} className="fill-muted-foreground" fontSize={10}>
                {truncate(label, 18)}
              </text>
            </g>
          );
        })}
        {[...placed.values()].map(({ node, x, y }) => (
          <a key={node.id} href={`#step-${node.id}`}>
            <rect
              x={x}
              y={y}
              width={W}
              height={H}
              rx={8}
              className={
                node.id === graph.start
                  ? 'fill-background stroke-primary'
                  : 'fill-background stroke-border'
              }
              strokeWidth={node.id === graph.start ? 2 : 1}
            />
            <text x={x + 10} y={y + 22} fontSize={12} fontWeight={600} className="fill-foreground">
              {truncate(node.label || node.id, 26)}
            </text>
            <text x={x + 10} y={y + 40} fontSize={11} className="fill-muted-foreground">
              {node.id === graph.start ? 'First · ' : ''}
              {NODE_TYPE_LABELS[node.type]}
            </text>
          </a>
        ))}
      </svg>
    </div>
  );
}
