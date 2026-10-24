import { Hono } from "hono";
import { agentEventsSchema, enrollMachineSchema, heartbeatSchema, turnCompleteSchema } from "@muster/shared";
import type { AgentEvent, TurnCompletePayload } from "@muster/shared";
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
  app.post("/heartbeat", async (c) => { const input = await body(c, heartbeatSchema); return c.json(services.scheduler.heartbeat(machineToken(c.req.header("authorization")), input.running)); });
  app.post("/claim", async (c) => {
    const token = machineToken(c.req.header("authorization"));
    const deadline = Date.now() + services.claimWaitMs; let job = services.scheduler.claim(token);
    while (!job && Date.now() < deadline && !c.req.raw.signal.aborted) { await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now()))); job = services.scheduler.claim(token); }
    return c.json(job);
  });
  app.post("/turns/:id/events", async (c) => { const input = await body(c, agentEventsSchema) as AgentEvent[]; services.scheduler.ingestEvents(machineToken(c.req.header("authorization")), c.req.param("id"), input); return c.json({ accepted: input.length }); });
  app.get("/turns/:id/inbox", (c) => c.json(services.scheduler.inbox(machineToken(c.req.header("authorization")), c.req.param("id"))));
  app.post("/turns/:id/complete", async (c) => { const input = await body(c, turnCompleteSchema) as TurnCompletePayload; services.scheduler.complete(machineToken(c.req.header("authorization")), c.req.param("id"), input); return c.json({ accepted: true }); });
  return app;
}
