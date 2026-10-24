import { Hono } from "hono";
import { notificationPreferencesSchema } from "@muster/shared";
import type { AppServices } from "../services.js";
export function settingsRoutes({ settings }: AppServices) {
  const app = new Hono();
  app.get("/settings", (c) => c.json({ data: settings.get() }));
  app.patch("/settings", async (c) => c.json({ data: settings.update(await c.req.json()) }));
  app.get("/settings/notifications", (c) => c.json({ data: settings.get().notifications }));
  app.patch("/settings/notifications", async (c) => c.json({ data: settings.update({ notifications: { ...settings.get().notifications, ...notificationPreferencesSchema.partial().parse(await c.req.json()) } }).notifications }));
  app.get("/api-keys", (c) => c.json({ data: settings.keys() }));
  app.post("/api-keys", async (c) => c.json({ data: settings.createKey(await c.req.json()) }, 201));
  app.delete("/api-keys/:id", (c) => { settings.revoke(c.req.param("id")); return c.body(null, 204); });
  return app;
}
