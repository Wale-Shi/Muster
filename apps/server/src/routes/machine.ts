import type { ServerResponse } from "node:http";
import type { TurnJob } from "@muster/shared";
import { Hono } from "hono";
import { eventUploadSchema, claimSchema, inboxAckSchema, enrollMachineSchema, heartbeatSchema, turnCompleteSchema } from "@muster/shared";
import type { TurnCompletePayload } from "@muster/shared";
import type { AppServices } from "../services.js";
import { bearer, body } from "./helpers.js";
import { StateError } from "../orchestrator/state.js";

const machineToken = (authorization: string | undefined): string => {
  if (!authorization?.startsWith("Bearer ")) throw new StateError("Missing machine bearer token", 401);
  return authorization.slice(7);
};

export function machineRoutes(services: AppServices): Hono {
  const app = new Hono();
  app.post("/enroll", async (c) => {
    if (services.enrollKey) {
      const supplied = c.req.header("x-muster-enroll-key") ?? bearer(c);
      if (supplied !== services.enrollKey) return c.json({ error: "Invalid enrollment key" }, 401);
    }
    const input = await body(c, enrollMachineSchema); return c.json(services.scheduler.enroll(input.name, input.runtimes, input.concurrency), 201);
  });
  app.use("/*", async (c, next) => { services.scheduler.authenticate(machineToken(c.req.header("authorization"))); await next(); });
  app.get("/attachments/:id", (c) => c.json(services.attachments.download(c.req.param("id"))));
  app.get("/skills/:slug/archive", (c) => c.json(services.skills.archive(c.req.param("slug"), c.req.query("version"))));
  app.post("/heartbeat", async (c) => { const input = await body(c, heartbeatSchema); return c.json(services.scheduler.heartbeat(machineToken(c.req.header("authorization")), input.running)); });
  app.post("/claim", async (c) => {
    const token = machineToken(c.req.header("authorization"));
    const input = await body(c, claimSchema);
    const signal = c.req.raw.signal;
    const outgoing = (c.env as { outgoing?: ServerResponse } | undefined)?.outgoing;
    let job: TurnJob | null = null;
    const release = () => { if (job) services.scheduler.releaseClaim(token, job, input.requestId); };
    const cleanup = () => signal.removeEventListener("abort", release);
    signal.addEventListener("abort", release, { once: true });
    // Keep rollback armed until Node has actually flushed the response, not just until
    // this handler returns it. The adapter aborts the request on premature socket close.
    outgoing?.once("finish", cleanup);
    outgoing?.once("close", cleanup);
    try {
      const deadline = Date.now() + services.claimWaitMs;
      while (!signal.aborted) {
        job = services.scheduler.claim(token, input.requestId);
        if (job || Date.now() >= deadline) break;
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, Math.min(250, deadline - Date.now()));
          signal.addEventListener("abort", done, { once: true });
        });
      }
      if (signal.aborted) { release(); cleanup(); return c.json(null); }
      if (!job) cleanup();
      return c.json(job ? { ...job, attachments: job.todoId ? services.attachments.list(job.todoId) : [] } : null);
    } catch (error) { release(); cleanup(); throw error; }
  });
  app.post("/turns/:id/events", async (c) => { const input = await body(c, eventUploadSchema); services.scheduler.ingestEvents(machineToken(c.req.header("authorization")), c.req.param("id"), input.events, input.batchId); return c.json({ accepted: input.events.length }); });
  app.get("/turns/:id/inbox", (c) => c.json(services.scheduler.inbox(machineToken(c.req.header("authorization")), c.req.param("id"))));
  app.post("/turns/:id/inbox/ack", async (c) => { const input = await body(c, inboxAckSchema); services.scheduler.ackInbox(machineToken(c.req.header("authorization")), c.req.param("id"), input.ids); return c.json({ accepted: true }); });
  app.post("/turns/:id/complete", async (c) => { const input = await body(c, turnCompleteSchema) as TurnCompletePayload; services.scheduler.complete(machineToken(c.req.header("authorization")), c.req.param("id"), input); return c.json({ accepted: true }); });
  return app;
}
