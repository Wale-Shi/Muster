import { Hono } from "hono";
import { updateConnectionSchema, connectionSchema } from "@muster/shared";
import type { AppServices } from "../services.js";
import { body } from "./helpers.js";
export function connectionRoutes({ connections }: AppServices): Hono {
  const app = new Hono();
  app.get("/connections", (c) => c.json({ data: connections.list() }));
  app.get("/connections/:id", (c) => c.json({ data: connections.get(c.req.param("id")) }));
  app.post("/connections", async (c) => c.json({ data: connections.save(await body(c, connectionSchema)) }, 201));
  app.patch("/connections/:id", async (c) => c.json({ data: connections.save(await body(c, updateConnectionSchema), c.req.param("id")) }));
  app.delete("/connections/:id", (c) => { connections.delete(c.req.param("id")); return c.body(null, 204); });
  app.post("/connections/:id/test", async (c) => c.json({ data: await connections.test(c.req.param("id")) }));
  return app;
}
