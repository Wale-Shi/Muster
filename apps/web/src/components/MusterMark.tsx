// The Muster mark: a loose, asymmetric "M" of four strokes whose joints are small
// rings, the first one solid like a lead node. Keep the geometry in sync with
// apps/desktop/scripts/icon.ts (strokes are heavier here for 16–18px rendering).
const NODES = [[5, 19.5], [5.8, 4.8], [11.2, 14.2], [18.2, 7.4], [19.2, 18.8]] as const;
const LEAD = 1;
const RING = 1.5;
// Strokes stop at the ring edge so each joint reads as a node.
const SEGMENTS = NODES.slice(1).map((b, i) => {
  const a = NODES[i]!; const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const [ux, uy] = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  return `M${a[0] + ux * RING} ${a[1] + uy * RING}L${b[0] - ux * RING} ${b[1] - uy * RING}`;
}).join("");

export function MusterMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="muster-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth={1.25} strokeLinecap="round" aria-hidden="true">
      <path d={SEGMENTS} stroke="currentColor" />
      {NODES.map(([cx, cy], i) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={RING} stroke="var(--accent)" fill={i === LEAD ? "var(--accent)" : "none"} />)}
    </svg>
  );
}
