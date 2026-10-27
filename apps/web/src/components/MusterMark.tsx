// The Muster mark: an "M" of four strokes whose joints are small rings, like
// connected nodes. Keep the geometry in sync with apps/desktop/scripts/icon.ts.
const NODES = [[5, 18], [5, 6], [12, 13.5], [19, 6], [19, 18]] as const;
const RING = 1.7;
// Strokes stop at the ring edge so each joint reads as a node.
const SEGMENTS = NODES.slice(1).map((b, i) => {
  const a = NODES[i]!; const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const [ux, uy] = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  return `M${a[0] + ux * RING} ${a[1] + uy * RING}L${b[0] - ux * RING} ${b[1] - uy * RING}`;
}).join("");

export function MusterMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="muster-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <path d={SEGMENTS} stroke="currentColor" />
      {NODES.map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={RING} stroke="var(--accent)" />)}
    </svg>
  );
}
