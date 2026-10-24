import { Attachments } from "./resources/attachments.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { projectGitRoutes } from "./routes/project-git.js";
import { Settings } from "./resources/settings.js";
import { settingsRoutes } from "./routes/settings.js";
import { Connections } from "./resources/connections.js";
import { Schedules } from "./resources/schedules.js";
import { existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Memories } from "./resources/memories.js";
import { Secrets } from "./resources/secrets.js";
import { Skills, type GithubFetcher } from "./resources/skills.js";
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
import { handleMcp, handleExternalMcp } from "./mcp/server.js";
import type { AppServices } from "./services.js";

export interface CreateAppOptions {
  dataDir?: string;
  githubFetcher?: GithubFetcher;
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
  const dataDir = options.dataDir ?? (options.databasePath && options.databasePath !== ":memory:" ? dirname(options.databasePath) : mkdtempSync(join(tmpdir(), "muster-data-")));
  const memories = new Memories(db); const secrets = new Secrets(db, dataDir); const skills = new Skills(db, join(dataDir, "skills"), options.githubFetcher);
  const connections = new Connections(db, secrets, events); const schedules = new Schedules(db, orchestrator);
  const scheduler = new Scheduler(db, orchestrator, events, memories, secrets, skills, connections);
  const services: AppServices = { settings: new Settings(db), attachments: new Attachments(db, join(dataDir, "attachments")), dataDir, db, events, orchestrator, scheduler, memories, secrets, skills, connections, schedules, enrollKey: options.enrollKey ?? null, claimWaitMs: options.claimWaitMs ?? 25_000 };
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof ZodError) return c.json({ error: "Invalid request", details: error.issues }, 400);
    if (error instanceof StateError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof Error && /FOREIGN KEY constraint failed/.test(error.message)) return c.json({ error: "Resource is still in use" }, 409);
    console.error(error); return c.json({ error: "Internal server error" }, 500);
  });
  app.get("/health", (c) => c.json({ status: "ok", service: "muster" }));
  app.route("/api/machine", machineRoutes(services));
  app.route("/api/events", eventRoutes(services));
  app.all("/api/mcp", (c) => handleExternalMcp(c.req.raw, services));
  app.route("/api", settingsRoutes(services));
  app.route("/api", projectGitRoutes(services));
  app.route("/api", attachmentRoutes(services));
  app.route("/api", apiRoutes(services));
  app.all("/mcp", (c) => handleMcp(c.req.raw, services));

  const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if ((options.serveWeb ?? process.env.NODE_ENV === "production") && existsSync(webRoot)) {
    app.use("/*", serveStatic({ root: webRoot }));
    app.get("/*", serveStatic({ root: webRoot, path: "index.html" }));
  }
  return { app, services };
}
