import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { attachmentLimit } from "../resources/attachments.js";
import type { AppServices } from "../services.js";
export function attachmentRoutes({ attachments }: AppServices) {
  const app = new Hono();
  app.get("/todos/:id/attachments", (c) => c.json({ data: attachments.list(c.req.param("id")) }));
  app.post("/todos/:id/attachments", bodyLimit({ maxSize: attachmentLimit + 64 * 1024, onError: (c) => c.json({ error: "Attachment limit exceeded (10 files, 20 MB)" }, 413) }), async (c) => { const form = await c.req.formData(); return c.json({ data: await attachments.add(c.req.param("id"), form.getAll("files").filter((f): f is File => f instanceof File)) }, 201); });
  return app;
}
