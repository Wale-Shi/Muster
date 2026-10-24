import { fork, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { isMuster } from "./ports.js";

export class Worker {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  code: number | null | undefined;
  constructor(entry: string, args: string[], env: NodeJS.ProcessEnv, logs: string, name: string) {
    this.child = fork(fileURLToPath(new URL("./worker-entry.js", import.meta.url)), [entry, ...args], { execPath: process.execPath, execArgv: [], env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    for (const stream of [this.child.stdout, this.child.stderr]) stream?.on("data", (data: Buffer) => appendFileSync(join(logs, `${name}.log`), data, { mode: 0o600 }));
    this.exited = new Promise((resolve) => {
      this.child.once("error", (error) => { appendFileSync(join(logs, `${name}.log`), `${error.stack}\n`); this.code = 1; resolve(1); });
      this.child.once("exit", (code) => { this.code = code; resolve(code); });
    });
  }
  async stop(): Promise<void> {
    if (this.code !== undefined) return;
    // Windows kill(SIGTERM) is forceful; the worker bridge emits the same signal cooperatively.
    if (process.platform === "win32") this.child.send({ type: "muster:shutdown" });
    else this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 10_000);
    try { await this.exited; }
    finally { clearTimeout(timer); }
  }
}
export async function waitForServer(origin: string, worker: Worker): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (worker.code !== undefined) throw new Error(`Server exited (${worker.code}); see server.log`);
    if (await isMuster(origin)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Muster server did not become ready; see server.log");
}
