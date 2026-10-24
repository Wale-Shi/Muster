import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineClient } from "../src/client.js";
import { EventBatcher } from "../src/events.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function client(fetcher: typeof fetch) {
  const home = await mkdtemp(join(tmpdir(), "muster-client-")); roots.push(home);
  return new MachineClient({ server: "http://test", home, name: "test", concurrency: 6, runtimes: ["mock"], retryMs: 1, fetch: fetcher });
}
it("retries transport/server failures with the machine bearer token", async () => {
  const calls: string[] = [];
  const c = await client((async (_input, options) => {
    calls.push(new Headers(options?.headers).get("authorization") ?? "");
    if (calls.length === 1) throw new TypeError("network");
    if (calls.length === 2) return new Response("unavailable", { status: 503 });
    return Response.json({ stop: [] });
  }) as typeof fetch);
  c.registration = { ...c.options, machineId: "machine", token: "secret" };
  expect(await c.heartbeat([])).toEqual({ stop: [] }); expect(calls).toEqual(["Bearer secret", "Bearer secret", "Bearer secret"]);
});
it("persists a private registration and reuses it on restart", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ machineId: "id", token: "token" })).mockResolvedValueOnce(Response.json({ stop: [] }));
  const first = await client(fetcher); await first.enroll();
  const file = join(first.options.home, "machine.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ machineId: "id", token: "token" });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const second = new MachineClient({ ...first.options, fetch: fetcher }); await second.enroll();
  expect(fetcher).toHaveBeenCalledTimes(2); expect(String(fetcher.mock.calls[1]![0])).toContain("heartbeat");
});
it("retains a failed event batch and drains in order before close", async () => {
  const batches: unknown[] = []; let fail = true;
  const c = await client((async (_url, options) => {
    if (fail) return new Response("bad", { status: 400 });
    batches.push(JSON.parse(String(options?.body))); return Response.json({ accepted: 1 });
  }) as typeof fetch);
  const batch = new EventBatcher(c, "turn", () => {}, 60_000);
  batch.emit({ type: "message.delta", content: "a" });
  await expect(batch.flush()).rejects.toThrow("400");
  batch.emit({ type: "message.completed", content: "ab" }); fail = false;
  await batch.close(); expect(batches).toEqual([[{ type: "message.delta", content: "a" }, { type: "message.completed", content: "ab" }]]);
});
it("does not retry an ambiguous claim or enrollment", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("connection lost")); const c = await client(fetcher);
  await expect(c.claim()).rejects.toThrow("connection lost"); expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(c.enroll()).rejects.toThrow("connection lost"); expect(fetcher).toHaveBeenCalledTimes(2);
});
it("drains a claim assigned during shutdown and reports that turn as stopped", async () => {
  const { Daemon } = await import("../src/daemon.js");
  const { makeJob } = await import("./helpers.js");
  let release!: (response: Response) => void;
  let claimed = false;
  const completions: unknown[] = [];
  const c = await client((async (url, options) => {
    const path = String(url);
    if (path.endsWith("/enroll")) return Response.json({ machineId: "id", token: "token" });
    if (path.endsWith("/heartbeat")) return Response.json({ stop: [] });
    if (path.endsWith("/claim")) { claimed = true; return await new Promise<Response>((resolve) => { release = resolve; }); }
    if (path.endsWith("/complete")) { completions.push(JSON.parse(String(options?.body))); return Response.json({ accepted: true }); }
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch);
  const daemon = new Daemon({ client: c, workspacesDir: join(c.options.home, "ws"), log: () => {}, heartbeatMs: 10 });
  await daemon.start(); expect(claimed).toBe(true);
  const stopping = daemon.stop(); release(Response.json(makeJob()));
  await stopping;
  expect(completions).toEqual([{ status: "stopped" }]); expect(daemon.running).toEqual([]);
});
it("reports journaled turns as stopped when reusing a registration after restart", async () => {
  const { Daemon } = await import("../src/daemon.js");
  const { writeFile } = await import("node:fs/promises");
  const completions: unknown[] = [];
  const c = await client((async (url, options) => {
    const path = String(url);
    if (path.endsWith("/enroll")) return Response.json({ machineId: "id", token: "token" });
    if (path.endsWith("/heartbeat")) return Response.json({ stop: [] });
    if (path.endsWith("/claim")) return Response.json(null);
    if (path.endsWith("/complete")) { completions.push(JSON.parse(String(options?.body))); return Response.json({ accepted: true }); }
    throw new Error(path);
  }) as typeof fetch);
  await c.enroll();
  await writeFile(join(c.options.home, "running.json"), JSON.stringify({ machineId: "id", turns: ["abandoned"] }));
  const daemon = new Daemon({ client: new MachineClient(c.options), workspacesDir: join(c.options.home, "ws"), log: () => {}, heartbeatMs: 10 });
  await daemon.start(); await daemon.stop();
  expect(completions).toEqual([{ status: "stopped", error: expect.stringContaining("restarted") }]);
  expect(JSON.parse(await readFile(join(c.options.home, "running.json"), "utf8"))).toMatchObject({ turns: [] });
});
