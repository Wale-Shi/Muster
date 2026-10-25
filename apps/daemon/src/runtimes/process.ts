import { spawn } from "node:child_process";
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
  /** Keep non-JSON stdout lines (banners, logs) as diagnostics instead of failing. */
  ignoreInvalid = false;
  private intentional = false;
  private stopping: Promise<void> | undefined;
  constructor(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
    this.child = spawn(command, args, { cwd, env: runtimeEnv(process.env, env), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    // JSONL framing splits on LF only: readline would also split on U+2028/U+2029,
    // which are valid inside JSON strings.
    let buffered = "";
    const line = (text: string) => {
      const record = text.endsWith("\r") ? text.slice(0, -1) : text;
      if (!record.trim()) return;
      try { this.onMessage(JSON.parse(record) as Wire); }
      catch (error) {
        if (this.ignoreInvalid) this.stderr = (this.stderr + record + "\n").slice(-8192);
        else this.onFailure(new Error(`Invalid runtime message: ${errorText(error)}`));
      }
    };
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (data: string) => {
      buffered += data;
      for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n")) {
        const record = buffered.slice(0, index); buffered = buffered.slice(index + 1); line(record);
      }
    });
    this.child.stderr.on("data", (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-8192); });
    this.child.stdin.on("error", (error) => { if (!this.intentional) this.onFailure(error); });
    this.child.on("error", (error) => this.onFailure(error));
    this.closed = new Promise((resolve) => this.child.on("close", (code, signal) => {
      if (buffered && !this.intentional) line(buffered);
      buffered = "";
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
