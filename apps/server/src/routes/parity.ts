import { Hono } from "hono";
import { updateConnectionSchema, connectionSchema, updateScheduleSchema, scheduleSchema } from "@muster/shared";
import type { AppServices } from "../services.js";
import { body } from "./helpers.js";
export function parityRoutes({ schedules, connections }: AppServices): Hono {
  const app = new Hono();
  app.get("/schedules", (c) => c.json({ data: schedules.list(c.req.query("todoId")) }));
  app.get("/schedules/:id", (c) => c.json({ data: schedules.get(c.req.param("id")) }));
  app.post("/schedules", async (c) => c.json({ data: schedules.save(await body(c, scheduleSchema)) }, 201));
  app.patch("/schedules/:id", async (c) => c.json({ data: schedules.save(await body(c, updateScheduleSchema), c.req.param("id")) }));
  app.delete("/schedules/:id", (c) => { schedules.delete(c.req.param("id")); return c.body(null, 204); });
  app.post("/schedules/:id/run", (c) => c.json({ data: schedules.run(c.req.param("id")) }));
  app.get("/connections", (c) => c.json({ data: connections.list() }));
  app.get("/connections/:id", (c) => c.json({ data: connections.get(c.req.param("id")) }));
  app.post("/connections", async (c) => c.json({ data: connections.save(await body(c, connectionSchema)) }, 201));
  app.patch("/connections/:id", async (c) => c.json({ data: connections.save(await body(c, updateConnectionSchema), c.req.param("id")) }));
  app.delete("/connections/:id", (c) => { connections.delete(c.req.param("id")); return c.body(null, 204); });
  app.post("/connections/:id/test", async (c) => c.json({ data: await connections.test(c.req.param("id")) }));
  return app;
}
