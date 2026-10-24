import { access, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Runtime as RuntimeName, TurnCompletePayload, TurnJob } from "@muster/shared";
import { MachineClient, HttpError } from "./client.js";
import { EventBatcher } from "./events.js";
import { Worktrees, type Workspace } from "./worktree.js";
import { MockRuntime } from "./runtimes/mock.js";
import { CodexRuntime } from "./runtimes/codex.js";
import { ClaudeRuntime } from "./runtimes/claude.js";
import type { Runtime, RunningTurn } from "./runtimes/types.js";
import type { Logger } from "./log.js";
import { delay, errorText, Mutex, safeId } from "./util.js";

export async function detectRuntimes(path = process.env.PATH ?? ""): Promise<RuntimeName[]> {
  const found: RuntimeName[] = ["mock"];
  for (const name of ["codex", "claude"] as const) {
    for (const directory of path.split(delimiter)) {
      try { await access(join(directory, name), constants.X_OK); found.push(name); break; } catch { /* next PATH directory */ }
    }
  }
  return found;
}
interface Active { stopped: boolean; runtime?: RunningTurn; task: Promise<void> }
export interface DaemonOptions {
  client: MachineClient; workspacesDir: string; log: Logger;
  runtimes?: Partial<Record<RuntimeName, Runtime>>;
  heartbeatMs?: number; inboxMs?: number; flushMs?: number;
}
export class Daemon {
  private abort = new AbortController();
  private active = new Map<string, Active>();
  private builds = new Mutex();
  private journal = new Mutex();
  private worktrees: Worktrees;
  private runtimes: Record<RuntimeName, Runtime>;
  private loop: Promise<void> | undefined;
  private heartbeatTask: Promise<void> | undefined;
  private claimsDone = false;
  private lock: string;
  private ownsLock = false;
  private stopping: Promise<void> | undefined;
  constructor(readonly options: DaemonOptions) {
    this.worktrees = new Worktrees(resolve(options.workspacesDir));
    this.runtimes = { codex: new CodexRuntime(), claude: new ClaudeRuntime(), mock: new MockRuntime(), ...options.runtimes };
    this.lock = join(options.client.options.home, "daemon.lock");
  }
  get running(): string[] { return [...this.active.keys()]; }

  async start(): Promise<void> {
    if (this.loop || this.abort.signal.aborted) throw new Error("Daemon already started or stopped");
    await mkdir(this.options.client.options.home, { recursive: true, mode: 0o700 });
    try { await mkdir(this.lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(join(this.lock, "pid"), "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid daemon lock; remove it after checking for another daemon");
      try { process.kill(pid, 0); throw new Error(`Daemon already running (pid ${pid})`); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; }
      await rm(this.lock, { recursive: true }); await mkdir(this.lock);
    }
    this.ownsLock = true;
    await writeFile(join(this.lock, "pid"), String(process.pid));
    try {
      const machine = await this.options.client.enroll();
      await this.recoverTurns(machine.machineId);
      this.options.log("info", "Machine enrolled", { machineId: machine.machineId, runtimes: machine.runtimes });
      this.heartbeatTask = this.heartbeats();
      this.loop = this.claims();
    } catch (error) { await this.releaseLock(); throw error; }
  }
  async wait(): Promise<void> { await this.loop; }
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }
  private async shutdown(): Promise<void> {
    this.abort.abort();
    for (const active of this.active.values()) {
      active.stopped = true;
      void active.runtime?.interrupt().catch((error: unknown) => this.options.log("error", "Interrupt failed", { error: errorText(error) }));
    }
    await this.loop;
    await Promise.all([...this.active.values()].map((entry) => entry.task));
    await this.heartbeatTask;
    try { await this.options.client.heartbeat([]); }
    catch (error) { this.options.log("error", "Final heartbeat failed", { error: errorText(error) }); }
    await this.journal.run("running", async () => {});
    await this.releaseLock();
    this.options.log("info", "Daemon stopped");
  }
  private async recoverTurns(machineId: string): Promise<void> {
    let saved: { machineId: string; turns: string[] };
    try { saved = JSON.parse(await readFile(join(this.options.client.options.home, "running.json"), "utf8")) as typeof saved; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (saved.machineId !== machineId) return;
    for (const turnId of saved.turns) {
      await this.options.client.complete(turnId, { status: "stopped", error: "Daemon restarted before this turn was reported complete" });
      this.options.log("info", "Recovered abandoned turn", { turnId });
    }
    await this.saveRunning();
  }
  private async saveRunning(): Promise<void> {
    await this.journal.run("running", async () => {
      const path = join(this.options.client.options.home, "running.json");
      await writeFile(`${path}.tmp`, JSON.stringify({ machineId: this.options.client.registration!.machineId, turns: this.running }), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
  }
  private async releaseLock(): Promise<void> {
    if (this.ownsLock) { this.ownsLock = false; await rm(this.lock, { recursive: true, force: true }); }
  }
  private async heartbeats(): Promise<void> {
    // Continue heartbeating while turns drain during shutdown.
    while (!this.abort.signal.aborted || !this.claimsDone || this.active.size) {
      try {
        const { stop } = await this.options.client.heartbeat(this.running);
        for (const id of stop) {
          const active = this.active.get(id);
          if (active) { active.stopped = true; void active.runtime?.interrupt().catch((error: unknown) => this.options.log("error", "Interrupt failed", { turnId: id, error: errorText(error) })); }
        }
      } catch (error) { this.options.log("error", "Heartbeat failed", { error: errorText(error) }); }
      await delay(this.options.heartbeatMs ?? 5000);
    }
  }
  private async claims(): Promise<void> {
    try {
      while (!this.abort.signal.aborted) {
        if (this.active.size >= this.options.client.options.concurrency) { await delay(100, this.abort.signal); continue; }
        try {
          // Drain the current long poll on shutdown: aborting its HTTP response can
          // hide a job M1 has already assigned, leaving no way to stop that turn.
          const job = await this.options.client.claim();
          if (!job) { await delay(100, this.abort.signal); continue; }
          const active: Active = { stopped: this.abort.signal.aborted, task: Promise.resolve() };
          this.active.set(job.turnId, active);
          try { await this.saveRunning(); }
          catch (error) { active.stopped = true; this.options.log("error", "Cannot journal claimed turn", { turnId: job.turnId, error: errorText(error) }); }
          active.task = this.builds.run(job.buildId, () => this.run(job, active)).catch((error: unknown) => {
            this.options.log("error", "Turn reporting failed", { turnId: job.turnId, error: errorText(error) });
          }).finally(async () => {
            this.active.delete(job.turnId);
            try { await this.saveRunning(); }
            catch (error) { this.options.log("error", "Cannot update turn journal", { error: errorText(error) }); }
          });
        } catch (error) {
          if (!this.abort.signal.aborted) { this.options.log("error", "Claim failed", { error: errorText(error) }); await delay(1000, this.abort.signal); }
        }
      }
    } finally { this.claimsDone = true; }
  }
  private async run(job: TurnJob, active: Active): Promise<void> {
    const started = Date.now();
    const batch = new EventBatcher(this.options.client, job.turnId, (error) => this.options.log("error", "Event upload failed", { turnId: job.turnId, error: errorText(error) }), this.options.flushMs);
    let workspace: Workspace | undefined;
    let inboxDone = false;
    const inboxAbort = new AbortController();
    let inboxTask: Promise<void> | undefined;
    let payload: TurnCompletePayload = { status: "failed" };
    this.options.log("info", "Turn started", { turnId: job.turnId, kind: job.kind, runtime: job.agent.runtime });
    try {
      if (active.stopped) { payload = { status: "stopped" }; return; }
      let cwd: string;
      if (job.project) { workspace = await this.worktrees.prepare(job); cwd = workspace.cwd; }
      else {
        const topicId = await this.options.client.chiefTopic(job);
        cwd = join(this.options.client.options.home, "chief", safeId(topicId));
        await mkdir(cwd, { recursive: true });
      }
      if (active.stopped) { payload = { status: "stopped" }; return; }
      if (job.kind === "merge" && workspace) {
        const merge = await this.worktrees.merge(workspace);
        payload = { status: merge.ok ? "done" : "failed", merge: { ok: merge.ok, ...(merge.error ? { error: merge.error } : {}) }, ...(merge.headCommit ? { headCommit: merge.headCommit } : {}) };
      } else {
        const runtime = this.runtimes[job.agent.runtime].start(job, { cwd, emit: batch.emit });
        active.runtime = runtime;
        if (active.stopped) await runtime.interrupt();
        inboxTask = (async () => {
          // Retain destructively-read inbox messages until the adapter accepts them.
          const pending: Array<{ id: string; content: string }> = [];
          while (!inboxDone) {
            try {
              if (!pending.length) pending.push(...await this.options.client.inbox(job.turnId, inboxAbort.signal));
              while (pending.length && !inboxDone) { await runtime.steer(pending[0]!.content); pending.shift(); }
            } catch (error) { if (!inboxDone) this.options.log("error", "Inbox delivery failed", { turnId: job.turnId, error: errorText(error) }); }
            await delay(this.options.inboxMs ?? 500, inboxAbort.signal);
          }
        })();
        const result = await runtime.result;
        payload = { status: active.stopped ? "stopped" : result.status, usage: { ...result.usage, durationMs: Date.now() - started }, sessionState: result.sessionState, ...(result.error ? { error: result.error } : {}) };
        if (job.readOnly) payload.plan = result.text;
        else if (workspace) Object.assign(payload, await this.worktrees.checkpoint(workspace, await this.options.client.turnNumber(job)));
      }
    } catch (error) { payload = { ...payload, status: active.stopped ? "stopped" : "failed", error: errorText(error) }; }
    finally {
      inboxDone = true; inboxAbort.abort();
      await inboxTask;
      if (job.readOnly && workspace) {
        try { await this.worktrees.reset(workspace); }
        catch (error) { payload.status = "failed"; payload.error = `Read-only cleanup failed: ${errorText(error)}`; }
      }
      try { await batch.close(); }
      catch (error) { this.options.log("error", "Final event upload failed", { turnId: job.turnId, error: errorText(error) }); }
      // Keep the turn owned and heartbeating until its result reaches the server.
      // Otherwise a long outage would strand it forever on an online machine.
      for (;;) {
        try { await this.options.client.complete(job.turnId, payload); break; }
        catch (error) {
          if (error instanceof HttpError && error.status < 500 && error.status !== 429) throw error;
          this.options.log("error", "Retrying turn completion", { turnId: job.turnId, error: errorText(error) });
          await delay(4000);
        }
      }
      this.options.log("info", "Turn completed", { turnId: job.turnId, status: payload.status });
    }
  }
}
