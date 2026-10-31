import { prepareSmokeBundle } from "./mac-bundle.js";
import { smokeId } from "../src/install-location.js";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workersOnly = process.argv.includes("--workers-only");
const built = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? (process.platform === "darwin" ? join(desktop, `release/mac${process.arch === "arm64" ? "-arm64" : ""}/Muster.app/Contents/MacOS/Muster`) : process.platform === "win32" ? join(desktop, "release/win-unpacked/Muster.exe") : join(desktop, "release/linux-unpacked/muster"));
// Run a copy outside the checkout: inside it, Node can resolve missing runtime dependencies from the repository's node_modules.
const bundle = process.platform === "darwin" ? resolve(built, "../../..") : dirname(built);
// macOS silently refuses to run an app copied into the system temp directory as Node, so use the user's caches there.
const copies = process.platform === "darwin" ? join(homedir(), "Library/Caches/Muster") : tmpdir();
await mkdir(copies, { recursive: true });
const copy = await mkdtemp(join(copies, "smoke-app-"));
const outside = join(copy, basename(bundle));
await cp(bundle, outside, { recursive: true, verbatimSymlinks: true });
process.once("exit", () => rmSync(copy, { recursive: true, force: true }));
if (process.platform === "darwin") await prepareSmokeBundle(outside);
const executable = join(outside, relative(bundle, built));
const runtime = process.platform === "darwin" ? resolve(executable, "../../Resources/runtime") : resolve(dirname(executable), "resources/runtime");
const home = await mkdtemp(join(tmpdir(), "muster-desktop-smoke-"));
let child: ChildProcess | undefined;
let external: ChildProcess | undefined;
const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
async function until<T>(fn: () => Promise<T | false>, label: string): Promise<T> {
  for (let i = 0; i < 600; i++) { const result = await fn(); if (result !== false) return result; await delay(); }
  throw new Error(`Timed out: ${label}. Logs: ${home}`);
}
async function freePort() {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((done) => listener.close(() => done())); return port;
}
async function exit(worker: ChildProcess) {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  await Promise.race([new Promise<void>((done, reject) => { worker.once("exit", (code) => code === 0 ? done() : reject(new Error(`App exit ${code}`))); }), new Promise<never>((_done, reject) => { const timer = setTimeout(() => reject(new Error("Shutdown timed out")), 65_000); timer.unref(); })]);
}
async function api<T>(origin: string, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(origin + path, body === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert(response.ok, `${path}: ${response.status}`);
  return (await response.json() as { data: T }).data;
}
try {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, MUSTER_DATA_DIR: home, MUSTER_HOME: home, MUSTER_DESKTOP_PORT: String(port), MUSTER_CHIEF_AUTO_FOLLOW_UP: "false" };
  delete env.ELECTRON_RUN_AS_NODE;
  if (workersOnly) {
    const bridge = process.platform === "darwin" ? resolve(executable, "../../Resources/app.asar/dist/src/worker-entry.js") : resolve(dirname(executable), "resources/app.asar/dist/src/worker-entry.js");
    external = spawn(executable, [bridge, join(runtime, "apps/server/dist/index.js")], { env: { ...env, HOST: "127.0.0.1", PORT: String(port), ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" });
    await until(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } }, "bundled server");
    child = spawn(executable, [bridge, join(runtime, "apps/daemon/dist/index.js"), "start", "--server", origin], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" });
    await until(async () => {
      const machines = await api<{ online: boolean }[]>(origin, "/api/machines");
      return machines.some((m) => m.online) || false;
    }, "bundled daemon enrollment");
  } else {
  child = spawn(executable, ["--smoke-test", "--smoke-hold"], { env, stdio: "inherit" });
  const first = child;
  await until(async () => {
    if (first.exitCode !== null || first.signalCode !== null) throw new Error(`App quit early: ${first.exitCode ?? first.signalCode}`);
    let ready: { executable: string; resources: string; bundleId: string };
    try { ready = JSON.parse(await readFile(join(home, "logs/smoke-ready.json"), "utf8")); } catch { return false; }
    assert.equal(ready.executable, executable);
    assert.equal(ready.resources, dirname(runtime));
    if (process.platform === "darwin") assert.equal(ready.bundleId, smokeId);
    return ready;
  }, "packaged UI + preload + SQLite server + machine enrollment");
  }
  console.log(workersOnly ? "PASS packaged worker bridge, bundled SQLite and automatic enrollment" : "PASS packaged UI, isolated preload, bundled SQLite and automatic enrollment");
  const agents = await api<{ id: string; isChief: boolean }[]>(origin, "/api/agents");
  await api(origin, `/api/agents/${agents.find((a) => a.isChief)!.id}`, { runtime: "mock", model: "mock" }, "PATCH");
  // A workspace's master agent runs outside its repository, so any path will do.
  const workspace = await api<{ topicId: string }>(origin, "/api/projects", { name: "Smoke", repoUrl: home, baseBranch: "main" });
  const { turnId } = await api<{ turnId: string }>(origin, `/api/topics/${workspace.topicId}/messages`, { content: "Mock shutdown verification ".repeat(500) });
  await until(async () => {
    const response = await fetch(`${origin}/api/machines`);
    const result = await response.json() as { data: { running: number }[] };
    return result.data.some((m) => m.running > 0) || false;
  }, "mock turn to start");
  child.kill("SIGTERM"); await exit(child); child = undefined;
  // Query the persisted completion using the packaged executable's Node, without a system Node dependency.
  const query = spawn(executable, ["--input-type=module", "-e", `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); const turn=db.prepare('SELECT status FROM turns WHERE id=?').get(process.argv[2]); if(turn?.status!=='stopped') throw new Error(JSON.stringify(turn)); db.close();`, join(home, "muster.db"), turnId], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" });
  await exit(query);
  console.log("PASS SIGTERM drains in-flight mock turn as stopped before stopping server");
  if (external) { external.kill("SIGTERM"); await exit(external); external = undefined; }
  if (!workersOnly) {
  await rm(join(home, "logs/smoke-ready.json"));
  external = spawn(executable, [join(runtime, "apps/server/dist/index.js")], { env: { ...env, PORT: String(port), HOST: "127.0.0.1", ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" });
  await until(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } }, "external server");
  child = spawn(executable, ["--smoke-test"], { env, stdio: "inherit" });
  await exit(child); child = undefined;
  assert((await fetch(`${origin}/health`)).ok, "attached server must survive desktop quit");
  assert.match(await readFile(join(home, "logs/desktop.log"), "utf8"), /Attached to/);
  console.log("PASS attach to existing Muster server and leave it running on quit");
  external.kill("SIGTERM"); await exit(external); external = undefined;
  }
  console.log(`Desktop smoke evidence: ${home}`);
} finally {
  for (const worker of [child, external]) if (worker && worker.exitCode === null) { worker.kill("SIGTERM"); await exit(worker); }
}
