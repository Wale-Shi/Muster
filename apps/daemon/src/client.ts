import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { EventUpload, MachineModels, Runtime, TurnCompletePayload, TurnJob } from "@muster/shared";
import { delay } from "./util.js";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface Registration { machineId: string; token: string; server: string; name: string; concurrency: number; runtimes: Runtime[] }
export interface ClientOptions { server: string; home: string; name: string; concurrency: number; runtimes: Runtime[]; enrollKey?: string; fetch?: typeof fetch; retryMs?: number }
export class MachineClient {
  registration: Registration | undefined;
  private fetcher: typeof fetch;
  constructor(readonly options: ClientOptions) { this.fetcher = options.fetch ?? fetch; }

  async request<T>(path: string, body?: unknown, signal?: AbortSignal, retry = true): Promise<T> {
    const attempts = retry ? 6 : 1;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (this.registration) headers.authorization = `Bearer ${this.registration.token}`;
        if (path.endsWith("/enroll") && this.options.enrollKey) headers["x-muster-enroll-key"] = this.options.enrollKey;
        const timeout = AbortSignal.timeout(path.endsWith("/claim") ? 30_000 : 8000);
        const response = await this.fetcher(`${this.options.server}${path}`, {
          method: body === undefined ? "GET" : "POST", headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) throw new HttpError(response.status, `HTTP ${response.status}: ${await response.text()}`);
        return await response.json() as T;
      } catch (error) {
        if (signal?.aborted || attempt + 1 >= attempts || (error instanceof HttpError && error.status < 500 && error.status !== 429)) throw error;
        await delay(Math.min(4000, (this.options.retryMs ?? 200) * 2 ** attempt), signal);
      }
    }
  }

  async enroll(): Promise<Registration> {
    await mkdir(this.options.home, { recursive: true, mode: 0o700 });
    const file = join(this.options.home, "machine.json");
    let saved: Registration | undefined;
    try { saved = JSON.parse(await readFile(file, "utf8")) as Registration; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const { server, name, concurrency, runtimes } = this.options;
    if (saved?.server === server && saved.name === name && saved.concurrency === concurrency && JSON.stringify(saved.runtimes) === JSON.stringify(runtimes) && saved.token && saved.machineId) {
      this.registration = saved;
      try { await this.heartbeat([]); return saved; }
      catch (error) { if (!(error instanceof HttpError && error.status === 401)) throw error; }
    }
    this.registration = undefined;
    // Re-enrolling against the same server keeps this machine's identity.
    const previousToken = saved?.server === server && saved.token ? { previousToken: saved.token } : {};
    const enrolled = await this.request<{ machineId: string; token: string }>("/api/machine/enroll", { name, concurrency, runtimes, ...previousToken }, undefined, false);
    this.registration = { ...enrolled, server, name, concurrency, runtimes };
    await writeFile(`${file}.tmp`, JSON.stringify(this.registration, null, 2) + "\n", { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    return this.registration;
  }
  heartbeat(running: string[], signal?: AbortSignal, retry = true): Promise<{ stop: string[]; refreshModels?: boolean }> { return this.request("/api/machine/heartbeat", { running }, signal, retry); }
  reportModels(models: MachineModels, signal?: AbortSignal): Promise<{ accepted: boolean }> { return this.request("/api/machine/models", { models }, signal); }
  claim(signal?: AbortSignal): Promise<TurnJob | null> { return this.request("/api/machine/claim", { requestId: crypto.randomUUID() }, signal); }
  events(turnId: string, upload: EventUpload): Promise<{ accepted: number }> { return this.request(`/api/machine/turns/${turnId}/events`, upload); }
  inbox(turnId: string, signal?: AbortSignal): Promise<Array<{ id: string; content: string }>> { return this.request(`/api/machine/turns/${turnId}/inbox`, undefined, signal); }
  ackInbox(turnId: string, ids: string[], signal?: AbortSignal): Promise<{ accepted: true }> { return this.request(`/api/machine/turns/${turnId}/inbox/ack`, { ids }, signal); }
  async complete(turnId: string, payload: TurnCompletePayload): Promise<void> {
    await this.request(`/api/machine/turns/${turnId}/complete`, payload);
  }

  async turnNumber(job: TurnJob): Promise<number> {
    const todo = await this.request<{ data: { builds: Array<{ id: string; turns: Array<{ id: string }> }> } }>(`/api/todos/${encodeURIComponent(job.todoId!)}`);
    const index = todo.data.builds.find((build) => build.id === job.buildId)?.turns.findIndex((turn) => turn.id === job.turnId);
    if (index === undefined || index < 0) throw new Error(`Turn ${job.turnId} is missing from its build`);
    return index + 1;
  }

}
