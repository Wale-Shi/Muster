import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@muster/shared";
import { MockRuntime } from "../src/runtimes/mock.js";
import { makeJob } from "./helpers.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() { const cwd = await mkdtemp(join(tmpdir(), "muster-mock-")); roots.push(cwd); const events: AgentEvent[] = []; return { cwd, events, ctx: { cwd, emit: (event: AgentEvent) => { events.push(event); } } }; }
it("streams a deterministic master-agent reply, echoes steering, and resumes", async () => {
  const { ctx, events, cwd } = await setup();
  const running = new MockRuntime(1).start(makeJob({ kind: "chief", todoId: null, topicId: "topic", branch: null, sessionState: { turns: 2 } }), ctx);
  await running.steer("Also test it");
  const result = await running.result;
  expect(result.status).toBe("done"); expect(result.text).toContain("Chief: Add a greeting"); expect(result.text).toContain("Steer: Also test it");
  expect(result.sessionState.turns).toBe(3); expect(events.filter((event) => event.type === "message.delta").length).toBeGreaterThan(2);
  await expect(readFile(join(cwd, "MUSTER_MOCK.md"))).rejects.toThrow();
});
it("writes the prompt on writable project turns and reports usage", async () => {
  const { ctx, cwd } = await setup();
  const job = makeJob({ project: { id: "p", repoUrl: "/unused", baseBranch: "main" } });
  const result = await new MockRuntime(1).start(job, ctx).result;
  expect(await readFile(join(cwd, "MUSTER_MOCK.md"), "utf8")).toContain(job.prompt);
  expect(result.usage.tokensIn).toBe(job.prompt.length);
});
it("interrupts without writing the build file", async () => {
  const { ctx, cwd } = await setup(); const running = new MockRuntime(20).start(makeJob({ project: { id: "p", repoUrl: "/unused", baseBranch: "main" } }), ctx);
  await running.interrupt(); expect((await running.result).status).toBe("stopped");
  await expect(readFile(join(cwd, "MUSTER_MOCK.md"))).rejects.toThrow();
});
