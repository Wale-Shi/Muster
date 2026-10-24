#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { homedir, hostname } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Daemon, detectRuntimes } from "./daemon.js";
import { MachineClient } from "./client.js";
import { createLogger } from "./log.js";
import { errorText } from "./util.js";

const expand = (path: string): string => resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    server: { type: "string", default: "http://localhost:7420" }, name: { type: "string", default: hostname() }, concurrency: { type: "string", default: "6" }, "workspaces-dir": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { console.log("muster-daemon start [--server http://localhost:7420] [--name <hostname>] [--concurrency 6] [--workspaces-dir ~/.muster/workspaces]"); return; }
  if (positionals.length !== 1 || positionals[0] !== "start") throw new Error("Usage: muster-daemon start [--help]");
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error("Concurrency must be an integer from 1 to 64");
  const server = new URL(values.server);
  if (!["http:", "https:"].includes(server.protocol) || server.username || server.password || server.search || server.hash || server.pathname !== "/") throw new Error("Server must be an HTTP(S) origin URL");
  const home = expand(process.env.MUSTER_HOME ?? join(homedir(), ".muster"));
  const log = createLogger(home);
  const client = new MachineClient({ server: server.origin, home, name: values.name, concurrency, runtimes: await detectRuntimes(), ...(process.env.MUSTER_ENROLL_KEY ? { enrollKey: process.env.MUSTER_ENROLL_KEY } : {}) });
  const daemon = new Daemon({ client, workspacesDir: expand(values["workspaces-dir"] ?? join(home, "workspaces")), log });
  let stopping: Promise<void> | undefined;
  const stop = () => { stopping ??= daemon.stop().catch((error: unknown) => { log("error", "Shutdown failed", { error: errorText(error) }); process.exitCode = 1; }); };
  await daemon.start();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try { await daemon.wait(); await stopping; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main().catch((error: unknown) => { process.stderr.write(`${errorText(error)}\n`); process.exitCode = 1; });
}
