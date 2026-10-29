import { parseImageMappings } from "./routes/local-images.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

export { createApp } from "./app.js";

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  const dataDir = process.env.MUSTER_DATA_DIR ?? join(homedir(), ".muster");
  const port = Number(process.env.PORT ?? 7420);
  const publicUrl = process.env.MUSTER_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
  const { app, services } = createApp({
    databasePath: join(dataDir, "muster.db"),
    imageMappings: parseImageMappings(process.env.MUSTER_IMAGE_MAPPINGS),
    publicUrl,
    allowedHosts: (process.env.MUSTER_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean),
    claimWaitMs: Number(process.env.MUSTER_CLAIM_WAIT_MS ?? 25_000),
    enrollKey: process.env.MUSTER_ENROLL_KEY ?? null,
    autoFollowUp: process.env.MUSTER_CHIEF_AUTO_FOLLOW_UP !== "false",
    serveWeb: true,
  });
  services.schedules.tick();
  const scheduleTimer = setInterval(() => services.schedules.tick(), 30000); scheduleTimer.unref();
  const offlineTimer = setInterval(() => services.scheduler.failOfflineMachines(), 5_000);
  offlineTimer.unref();
  const server = serve({ fetch: app.fetch, hostname: process.env.HOST ?? "127.0.0.1", port }, (info) => {
    if (!process.env.MUSTER_PUBLIC_URL) services.orchestrator.publicUrl = `http://127.0.0.1:${info.port}`;
    console.log(`Muster server listening on http://127.0.0.1:${info.port}`);
  });
  const stop = () => { clearInterval(scheduleTimer); clearInterval(offlineTimer); if ("closeAllConnections" in server) server.closeAllConnections(); server.close(() => { services.db.close(); process.exit(0); }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
