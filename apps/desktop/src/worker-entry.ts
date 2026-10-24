// Use Electron's bundled Node, including node:sqlite. This file also bridges graceful Windows shutdown.
import { pathToFileURL } from "node:url";
const entry = process.argv[2];
if (!entry) throw new Error("Missing worker entry");
process.argv.splice(1, 2, entry);
process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "type" in message && message.type === "muster:shutdown") process.emit("SIGTERM");
});
// Do not keep a normally finished daemon alive solely because of IPC.
process.channel?.unref();
await import(pathToFileURL(entry).href);
