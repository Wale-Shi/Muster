import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from "electron";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existingDaemon } from "./existing-daemon.js";
import { watchEvents } from "./events.js";
import { resolvePath } from "./path.js";
import { chooseServer } from "./ports.js";
import { Worker, waitForServer } from "./workers.js";
import type { DesktopCommand } from "./bridge.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const runtime = app.isPackaged ? join(process.resourcesPath, "runtime") : root;
const data = process.env.MUSTER_DATA_DIR ?? join(homedir(), ".muster");
const logs = join(data, "logs");
mkdirSync(logs, { recursive: true, mode: 0o700 });
// Keep Electron state local too; smoke checks can isolate every write.
app.setPath("userData", join(data, "desktop"));
app.setPath("logs", logs);
const smoke = process.argv.includes("--smoke-test");
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let server: Worker | undefined;
let daemon: Worker | undefined;
let origin = "";
let quitting = false;
let stopped = false;
let poll: ReturnType<typeof setInterval> | undefined;
const log = (message: string) => appendFileSync(join(logs, "desktop.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
const show = () => { if (!window || smoke) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); };
const command = (value: DesktopCommand) => { show(); window?.webContents.send("muster:command", value); };

async function shutdown() {
  if (poll) clearInterval(poll);
  eventsAbort.abort();
  tray?.destroy();
  // Keep the server available while the daemon reports interrupted turns (up to 10s).
  await daemon?.stop();
  await server?.stop();
  stopped = true;
  log("Workers stopped");
}

function createWindow() {
  let bounds = { width: 1360, height: 900 } as Electron.Rectangle;
  try {
    const saved = JSON.parse(readFileSync(join(data, "desktop-window.json"), "utf8")) as Electron.Rectangle;
    if ([saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) && saved.width >= 850 && saved.height >= 600 && screen.getAllDisplays().some(({ workArea: a }) => saved.x < a.x + a.width && saved.y < a.y + a.height && saved.x + saved.width > a.x && saved.y + saved.height > a.y)) bounds = saved;
  } catch { /* first launch */ }
  window = new BrowserWindow({ ...bounds, minWidth: 850, minHeight: 600, show: false, backgroundColor: "#18181b", title: "Muster", ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 18 } } : {}), webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.on("close", (event) => {
    if (window && !window.isFullScreen()) writeFileSync(join(data, "desktop-window.json"), JSON.stringify(window.getNormalBounds()));
    if (!quitting) { event.preventDefault(); app.quit(); }
  });
  window.once("ready-to-show", () => { if (!smoke) show(); });
  const openExternal = (url: string) => { if (["https:", "http:"].includes(new URL(url).protocol)) void shell.openExternal(url); };
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== origin) { event.preventDefault(); openExternal(url); } });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  void window.loadURL(origin);
  return window;
}

function integrations() {
  const trusted = (event: Electron.IpcMainInvokeEvent) => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin;
  ipcMain.handle("muster:choose-folder", async (event) => {
    if (!trusted(event) || !window) throw new Error("Untrusted desktop request");
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"], title: "Choose project repository" });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("muster:open-path", async (event, path: unknown) => {
    if (!trusted(event) || typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("Expected a local absolute path");
    return shell.openPath(path);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { label: "File", submenu: [
      { label: "New task", accelerator: "CmdOrCtrl+N", click: () => command({ type: "new-task" }) },
      { label: "Open in browser", click: () => { void shell.openExternal(origin); } },
      { label: "Show logs", click: () => { void shell.openPath(logs); } },
      { type: "separator" }, { role: "quit" },
    ] }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]));
  const assets = app.isPackaged ? join(process.resourcesPath, "assets") : join(root, "apps/desktop/assets");
  const image = nativeImage.createFromPath(join(assets, "tray.png"));
  image.setTemplateImage(process.platform === "darwin");
  tray = new Tray(image);
  tray.on("click", show);
  tray.setToolTip("Muster — connecting");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "Machine connecting", enabled: false }, { label: "Open Muster", click: show }, { role: "quit" }]));
}

interface TodoStatus { id: string; title: string; phase: string; updatedAt: string }
let polling = false;
const eventsAbort = new AbortController();
async function refreshStatus() {
  if (polling || quitting) return;
  polling = true;
  try {
    const response = await fetch(`${origin}/api/todos`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`Status HTTP ${response.status}`);
    const { data: todos } = await response.json() as { data: TodoStatus[] };
    const needs = todos.filter((todo) => ["confirm", "review", "failed"].includes(todo.phase));
    app.setBadgeCount(needs.length);
    app.dock?.setBadge(needs.length ? String(needs.length) : "");
    const machinesResponse = await fetch(`${origin}/api/machines`, { signal: AbortSignal.timeout(3000) });
    const { data: machines } = await machinesResponse.json() as { data: { id: string; online: boolean; running: number }[] };
    let machineId: string | undefined;
    try { machineId = (JSON.parse(readFileSync(join(data, "machine.json"), "utf8")) as { machineId: string }).machineId; } catch { /* enrolling */ }
    const machine = machines.find((value) => value.id === machineId);
    const status = `Machine ${machine?.online ? "online" : "offline"} · ${machine?.running ?? 0} running`;
    tray?.setToolTip(`Muster — ${status}`);
    tray?.setContextMenu(Menu.buildFromTemplate([{ label: status, enabled: false }, { label: "Open Muster", click: show }, { role: "quit" }]));
  } catch (error) { log(`Status unavailable: ${String(error)}`); }
  finally { polling = false; }
}

async function launch() {
  const env = { ...process.env, PATH: await resolvePath(), MUSTER_DATA_DIR: data, MUSTER_HOME: data };
  // Retry discovery when another application wins the bind race.
  for (let attempt = 0; attempt < 5; attempt++) {
    const target = await chooseServer(Number(process.env.MUSTER_DESKTOP_PORT ?? 7420));
    origin = `http://127.0.0.1:${target.port}`;
    if (target.attach) { log(`Attached to ${origin}`); break; }
    server = new Worker(join(runtime, "apps/server/dist/index.js"), [], { ...env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(target.port), MUSTER_PUBLIC_URL: origin }, logs, "server");
    try { await waitForServer(origin, server); log(`Started ${origin}`); break; }
    catch (error) { await server.stop(); server = undefined; if (attempt === 4) throw error; }
  }
  if (quitting) return;
  if (existingDaemon(data, origin)) log("Reusing the existing machine daemon (left running on quit)");
  else daemon = new Worker(join(runtime, "apps/daemon/dist/index.js"), ["start", "--server", origin], env, logs, "daemon");
  const failed = (name: string, worker: Worker) => { void worker.exited.then((code) => { if (!quitting) { log(`${name} exited: ${code}`); if (!smoke) dialog.showErrorBox("Muster worker stopped", `${name} exited unexpectedly. See ${logs}`); app.quit(); } }); };
  if (server) failed("Server", server);
  if (daemon) failed("Daemon", daemon);
  void watchEvents(origin, eventsAbort.signal, async (event) => {
    if (event.type !== "todo.changed" || !event.todoId || !["confirm", "review", "failed"].includes(event.payload?.phase ?? "")) return;
    void refreshStatus();
    if (!Notification.isSupported() || smoke || quitting) return;
    const response = await fetch(`${origin}/api/todos/${encodeURIComponent(event.todoId)}`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return;
    const { data: todo } = await response.json() as { data: TodoStatus };
    const notification = new Notification({ title: `${event.payload?.phase} · Muster`, body: todo.title });
    notification.on("click", () => command({ type: "open-todo", id: todo.id }));
    notification.show();
  });
  integrations();
  const win = createWindow();
  poll = setInterval(() => { void refreshStatus(); }, 1500);
  void refreshStatus();
  if (smoke) {
    await new Promise<void>((resolve, reject) => { win.webContents.once("did-finish-load", resolve); win.webContents.once("did-fail-load", (_e, code, description) => reject(new Error(`${code}: ${description}`))); });
    const bridge = await win.webContents.executeJavaScript("window.muster?.desktop === true && !!document.querySelector('.sidebar')");
    if (!bridge) throw new Error("Desktop preload or web UI missing");
    const shot = await win.webContents.capturePage();
    writeFileSync(join(logs, "smoke-window.png"), shot.toPNG());
    // Wait for real enrollment, without starting any model turns.
    for (let i = 0; i < 100; i++) {
      if (daemon && daemon.code !== undefined) throw new Error("Daemon failed in smoke test");
      const response = await fetch(`${origin}/api/machines`);
      const machines = await response.json() as { data: { online: boolean }[] };
      if (machines.data.some((m) => m.online)) { log(`SMOKE OK ${origin} electron=${process.versions.electron} node=${process.versions.node}`); writeFileSync(join(logs, "smoke-ready.json"), JSON.stringify({ origin, electron: process.versions.electron, node: process.versions.node })); if (!process.argv.includes("--smoke-hold")) app.quit(); return; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Daemon did not enroll in smoke test");
  }
}

if (!app.requestSingleInstanceLock({ data })) app.quit();
else {
  process.on("SIGTERM", () => app.quit());
  process.on("SIGINT", () => app.quit());
  app.on("second-instance", show);
  app.on("activate", show);
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void startup.catch(() => {}).then(shutdown).then(() => { if (process.exitCode) app.exit(Number(process.exitCode)); else app.quit(); }).catch((error: unknown) => { log(`Shutdown error: ${String(error)}`); app.exit(1); });
  });
  const startup = app.whenReady().then(launch).catch((error: unknown) => {
    log(error instanceof Error ? error.stack ?? error.message : String(error));
    if (!smoke) dialog.showErrorBox("Muster could not start", `${String(error)}\nLogs: ${logs}`);
    process.exitCode = 1;
    app.quit();
  });
}
