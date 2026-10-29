import type { MiddlewareHandler } from "hono";

// Loopback names accept a request from the machine itself, whatever port or dev proxy it came through.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Host without its port, lower-cased. Returns null for an empty or malformed value. */
function hostnameOf(host: string): string | null {
  const value = host.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith("[")) { const end = value.indexOf("]"); return end === -1 ? null : value.slice(0, end + 1); }
  const colon = value.indexOf(":");
  if (colon === -1) return value;
  return /^\d+$/.test(value.slice(colon + 1)) ? value.slice(0, colon) : value;
}

function parsePublicUrl(publicUrl: string | undefined): URL | null {
  if (!publicUrl) return null;
  try { return new URL(publicUrl); } catch { return null; }
}

export interface SecurityOptions {
  /** The server's own public URL, read per request because it is updated once the listener is bound. */
  publicUrl?: (() => string) | undefined;
  /** Additional hostnames requested through MUSTER_ALLOWED_HOSTS. */
  allowedHosts?: string[] | undefined;
}

// A browser page must not reach the loopback API through DNS rebinding or a cross-site request.
// Requests without Origin (curl, daemon, MCP clients) are fine: the Host header still gates them.
export function security({ publicUrl = () => "", allowedHosts = [] }: SecurityOptions = {}): MiddlewareHandler {
  const extra = new Set(allowedHosts.map((host) => hostnameOf(host)).filter((host): host is string => host !== null));
  return async (c, next) => {
    const url = new URL(c.req.url);
    const host = c.req.header("host") ?? url.host;
    const hostname = hostnameOf(host);
    const publicSite = parsePublicUrl(publicUrl());
    const allowed = hostname !== null && (LOOPBACK.has(hostname) || hostname.endsWith(".localhost") || hostname === publicSite?.hostname || extra.has(hostname));
    if (!allowed) return c.json({ error: "Host not allowed" }, 403);
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "Cross-origin request denied" }, 403);
    const origin = c.req.header("origin");
    if (origin && origin !== `${url.protocol}//${host}` && origin !== publicSite?.origin) return c.json({ error: "Cross-origin request denied" }, 403);
    return next();
  };
}
