import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { ZodError } from "zod";
import { MusterDb } from "./db/index.js";
import { EventBus } from "./events.js";
import { Orchestrator, StateError } from "./orchestrator/state.js";
import { Scheduler } from "./orchestrator/scheduler.js";
import { apiRoutes } from "./routes/api.js";
import { machineRoutes } from "./routes/machine.js";
import { eventRoutes } from "./routes/events.js";
import { handleMcp } from "./mcp/server.js";
import type { AppServices } from "./services.js";

export interface CreateAppOptions {
  databasePath?: string;
  publicUrl?: string;
  enrollKey?: string | null;
  claimWaitMs?: number;
  autoFollowUp?: boolean;
  serveWeb?: boolean;
}

export function createApp(options: CreateAppOptions = {}): { app: Hono; services: AppServices } {
  const db = new MusterDb(options.databasePath ?? ":memory:");
  const events = new EventBus(db);
  const orchestrator = new Orchestrator(db, events, options.publicUrl ?? "http://127.0.0.1:7420", options.autoFollowUp ?? true);
  const scheduler = new Scheduler(db, orchestrator, events);
  const services: AppServices = { db, events, orchestrator, scheduler, enrollKey: options.enrollKey ?? null, claimWaitMs: options.claimWaitMs ?? 25_000 };
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof ZodError) return c.json({ error: "Invalid request", details: error.issues }, 400);
    if (error instanceof StateError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof Error && /FOREIGN KEY constraint failed/.test(error.message)) return c.json({ error: "Resource is still in use" }, 409);
    console.error(error); return c.json({ error: "Internal server error" }, 500);
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/api/machine", machineRoutes(services));
  app.route("/api/events", eventRoutes(services));
  app.route("/api", apiRoutes(services));
  app.all("/mcp", (c) => handleMcp(c.req.raw, services));

  const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if ((options.serveWeb ?? process.env.NODE_ENV === "production") && existsSync(webRoot)) {
    app.use("/*", serveStatic({ root: webRoot }));
    app.get("/*", serveStatic({ root: webRoot, path: "index.html" }));
  }
  return { app, services };
}
