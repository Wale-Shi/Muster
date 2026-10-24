import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { errorText } from "../util.js";
import { runtimeEnv } from "./env.js";

// JSON protocol envelopes differ by CLI; validate/map them at the adapter boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Wire = Record<string, any>;
export class JsonProcess {
  readonly child;
  readonly closed: Promise<void>;
  stderr = "";
  onMessage: (message: Wire) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  private intentional = false;
  private stopping: Promise<void> | undefined;
  constructor(command: string, args: string[], cwd: string) {
    this.child = spawn(command, args, { cwd, env: runtimeEnv(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try { this.onMessage(JSON.parse(line) as Wire); }
      catch (error) { this.onFailure(new Error(`Invalid runtime message: ${errorText(error)}`)); }
    });
    this.child.stderr.on("data", (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-8192); });
    this.child.stdin.on("error", (error) => { if (!this.intentional) this.onFailure(error); });
    this.child.on("error", (error) => this.onFailure(error));
    this.closed = new Promise((resolve) => this.child.on("close", (code, signal) => {
      lines.close();
      if (!this.intentional) this.onFailure(new Error(`Runtime exited (${code ?? signal}): ${this.stderr}`));
      resolve();
    }));
  }
  send(message: Wire): void {
    if (this.child.stdin.destroyed) throw new Error("Runtime stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private kill(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") this.child.kill(signal); // Some hosts only permit signaling the direct child.
      else if (code !== "ESRCH") throw error;
    }
  }
  stop(): Promise<void> {
    this.stopping ??= this.terminate();
    return this.stopping;
  }
  private async terminate(): Promise<void> {
    this.intentional = true;
    this.child.stdin.end();
    this.kill("SIGTERM");
    const timer = setTimeout(() => this.kill("SIGKILL"), 2000);
    timer.unref();
    await this.closed;
    clearTimeout(timer);
    this.kill("SIGKILL");
  }
}
