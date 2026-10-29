import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import type { AppServices } from "../services.js";
import { jsonBody } from "./helpers.js";
import { imagePath, mapImagePath, readImage, safeRead, type ImageMapping } from "../resources/local-images.js";
import { StateError } from "../orchestrator/state.js";

const inputSchema = z.object({ buildId: z.string().regex(/^[a-zA-Z0-9_-]+$/), messageId: z.string().min(1), src: z.string().min(1).max(4096) });
const mappingSchema = z.object({ machineId: z.string().min(1), sourceDataDir: z.string().min(1), dataDir: z.string().min(1), sourceWorkspacesDir: z.string().min(1), workspacesDir: z.string().min(1) }).array();
export function parseImageMappings(json: string | undefined): ImageMapping[] {
  return json ? mappingSchema.parse(JSON.parse(json)) : [];
}

// Parse Markdown rather than substring matching: code blocks and ordinary links cannot authorize reads.
export function referencesImage(content: string, src: string): boolean {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content);
  const definitions = new Map<string, string>();
  type Node = { type: string; url?: string; identifier?: string; children?: Node[] };
  const walk = (node: Node, visit: (node: Node) => void) => { visit(node); node.children?.forEach((child) => walk(child, visit)); };
  walk(tree, (node) => { if (node.type === "definition") definitions.set(node.identifier!, node.url!); });
  const matches = (url: string | undefined) => {
    if (!url) return false;
    if (url === src) return true;
    try { return imagePath(url) === imagePath(src); } catch { return false; }
  };
  let found = false;
  walk(tree, (node) => {
    if (node.type === "image" && matches(node.url) || node.type === "imageReference" && matches(definitions.get(node.identifier!))) found = true;
  });
  return found;
}

export function localImageRoutes(services: AppServices, mappings: ImageMapping[] = []): Hono {
  const app = new Hono();
  app.post("/todos/:todoId/images", bodyLimit({ maxSize: 8192 }), async (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    const origin = c.req.header("origin");
    const publicUrl = new URL(services.orchestrator.publicUrl), requestUrl = new URL(c.req.url);
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(requestUrl.hostname);
    const validHost = localHost || requestUrl.hostname === publicUrl.hostname;
    const validOrigin = !origin || origin === publicUrl.origin || localHost && origin === requestUrl.origin;
    if (!validHost || !validOrigin || c.req.header("sec-fetch-site") === "cross-site" || c.req.header("x-muster-image") !== "1") return c.json({ error: "Image request origin denied" }, 403);
    const input = inputSchema.parse(await jsonBody(c));
    const row = services.db.row(`SELECT m.content, b.machine_id FROM messages m JOIN builds b ON b.id=m.conversation_id
      JOIN turns t ON t.id=m.turn_id AND t.build_id=b.id
      WHERE m.id=? AND b.id=? AND b.todo_id=? AND m.role='agent' AND t.machine_id=b.machine_id`, input.messageId, input.buildId, c.req.param("todoId"));
    if (!row || !referencesImage(String(row.content), input.src)) return c.json({ error: "Image reference not found" }, 404);
    try {
      const machineId = String(row.machine_id);
      let mapping = mappings.find((item) => item.machineId === machineId);
      if (!mapping) {
        // A local daemon registration proves this data directory belongs to the executing machine.
        // A remote machine with the same absolute path must never select server-local files.
        try {
          const dataDir = await realpath(services.dataDir);
          const registration = JSON.parse((await safeRead(dataDir, join(dataDir, "machine.json"), 16 * 1024)).toString()) as { machineId: string; token: string };
          const authenticated = services.scheduler.authenticate(registration.token);
          if (registration.machineId === machineId && authenticated.id === machineId) mapping = { machineId, sourceDataDir: dataDir, dataDir, sourceWorkspacesDir: join(dataDir, "workspaces"), workspacesDir: join(dataDir, "workspaces") };
        } catch { /* no trusted local registration; explicit mapping is required */ }
      }
      if (!mapping) return c.json({ error: "Image is on the execution machine", code: "remote" }, 409);
      const target = mapImagePath(imagePath(input.src), input.buildId, mapping);
      const { bytes, mime } = await readImage(target.root, target.path);
      c.header("Content-Type", mime);
      return c.body(new Uint8Array(bytes));
    } catch (error) {
      if (error instanceof StateError) return c.json({ error: error.message }, error.status as 403);
      const code = (error as NodeJS.ErrnoException).code;
      if (["ENOENT", "ENOTDIR"].includes(code ?? "")) return c.json({ error: "Image unavailable" }, 404);
      if (["EACCES", "EPERM", "ELOOP"].includes(code ?? "")) return c.json({ error: "Image unavailable" }, 403);
      throw error;
    }
  });
  return app;
}
