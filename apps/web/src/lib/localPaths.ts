interface Node { type: string; value?: string; url?: string; children?: Node[] }
export const localPathUrl = (path: string) => `muster-local:${encodeURIComponent(path)}`;
export function absolutePath(value: string): string | null {
  if (value.startsWith("muster-local:")) { try { return absolutePath(decodeURIComponent(value.slice(13))); } catch { return null; } }
  if (value.startsWith("file://")) { try { const url = new URL(value); if (url.hostname && url.hostname !== "localhost") return null; return absolutePath(decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, "$1")); } catch { return null; } }
  return /^(\/[^/]|[A-Za-z]:[\\/])/.test(value) && !value.includes("\0") ? value : null;
}
// Convert bare paths into ordinary Markdown links, without touching code blocks or existing links.
export function localPathLinks() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      if (!node.children || ["link", "code", "inlineCode"].includes(node.type)) return;
      node.children = node.children.flatMap((child): Node[] => {
        if (child.type !== "text" || !child.value) { walk(child); return [child]; }
        const parts: Node[] = []; let offset = 0;
        const pattern = /(?:\/(?:[^\s/<>"'`()\[\]]+\/)*[^\s/<>"'`()\[\]]+|[A-Za-z]:[\\/][^\s<>"'`()\[\]]+)/g;
        for (const match of child.value.matchAll(pattern)) {
          if (match.index > 0 && !/[\s(]/.test(child.value[match.index - 1]!)) continue;
          const path = match[0].replace(/[.,;:!?]+$/, "");
          if (!absolutePath(path)) continue;
          parts.push({ type: "text", value: child.value.slice(offset, match.index) }, { type: "link", url: localPathUrl(path), children: [{ type: "text", value: path }] });
          offset = match.index + path.length;
        }
        if (!parts.length) return [child];
        parts.push({ type: "text", value: child.value.slice(offset) }); return parts;
      });
    };
    walk(tree);
  };
}
