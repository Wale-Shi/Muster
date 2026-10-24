import { Hono } from "hono";
import type { AppServices } from "../services.js";

export function eventRoutes(services: AppServices): Hono {
  const app = new Hono();
  app.get("/", () => {
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        unsubscribe = services.events.subscribe((event) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { unsubscribe?.(); }
        });
        interval = setInterval(() => { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { unsubscribe?.(); } }, 15_000);
      },
      cancel() { unsubscribe?.(); if (interval) clearInterval(interval); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  });
  return app;
}
