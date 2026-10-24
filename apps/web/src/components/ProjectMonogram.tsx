import { initials } from "../lib/format";
export function ProjectMonogram({ name }: { name: string }) {
  const hue = Array.from(name).reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 0);
  return <i className="project-monogram" aria-hidden="true" style={{ color: `hsl(${hue} 55% 65%)`, backgroundColor: `hsl(${hue} 40% 40% / 0.16)` }}>{initials(name)}</i>;
}
