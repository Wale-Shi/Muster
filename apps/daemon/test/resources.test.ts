import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AgentEvent } from "@muster/shared";
import { prepareSkills, redactor, secretEvents, jobCredentials } from "../src/resources.js";
import { MachineClient } from "../src/client.js";
import { makeJob } from "./helpers.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function home() { const root = await mkdtemp(join(tmpdir(), "muster-cache-test-")); roots.push(root); return root; }
it("redacts nested values, overlapping values, diffs and errors, including split streaming chunks", () => {
  const redact = redactor({ API_KEY: "private-key", LONG: "private-key-long", SHORT: "12345" });
  expect(redact({ error: "private-key-long private-key", tool: ["private-key"], diff: "+private-key", short: "12345" })).toEqual({ error: "[secret:LONG] [secret:API_KEY]", tool: ["[secret:API_KEY]"], diff: "+[secret:API_KEY]", short: "12345" });
  const events: AgentEvent[] = []; const stream = secretEvents({ TOKEN: "private-key" }, (e) => events.push(e));
  stream.emit({ type: "message.delta", content: "private-" }); expect(events).toEqual([]); stream.emit({ type: "message.delta", content: "key" }); stream.emit({ type: "message.completed" });
  stream.emit({ type: "reasoning.delta", content: "private-" }); stream.emit({ type: "reasoning.delta", content: "key" }); stream.flush();
  const text = (type: AgentEvent["type"]) => events.filter((e) => e.type === type).map((e) => "content" in e ? e.content : "").join("");
  expect(text("message.delta")).toBe("[secret:TOKEN]"); expect(events.find((e) => e.type === "message.completed")).toEqual({ type: "message.completed", content: "[secret:TOKEN]" });
  expect(text("reasoning.delta")).toBe("[secret:TOKEN]");
});
it("keeps streaming while secrets are configured and never leaks a secret prefix", () => {
  const secret = "sk-live-abcdef123456"; const events: AgentEvent[] = []; const stream = secretEvents({ API_KEY: secret }, (e) => events.push(e));
  const input = `The deploy used ${secret} and then ${secret.slice(0, 7)} was printed. ${"done ".repeat(20)}`;
  for (let i = 0; i < input.length; i += 3) stream.emit({ type: "message.delta", content: input.slice(i, i + 3) });
  const streamed = events.filter((e) => e.type === "message.delta").map((e) => (e as { content: string }).content);
  expect(streamed.length).toBeGreaterThan(5);
  for (let i = 1; i <= streamed.length; i++) expect(streamed.slice(0, i).join("")).not.toContain(secret);
  stream.emit({ type: "message.completed" });
  expect(streamed.join("") + (events.at(-2) as { content: string }).content).toBe(input.split(secret).join("[secret:API_KEY]"));
});
it("downloads once per hash outside the workspace and provides the index", async () => {
  const root = await home(); const files = [{ path: "SKILL.md", content: Buffer.from("Skill instructions").toString("base64") }, { path: "scripts/tool.sh", content: Buffer.from("echo test").toString("base64") }];
  const version = createHash("sha256").update(JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))).digest("hex"); let requests = 0;
  const client = new MachineClient({ home: root, server: "http://fixture", name: "test", concurrency: 1, runtimes: ["mock"], fetch: async (_url, init) => { expect(new Headers(init?.headers).get("authorization")).toBe("Bearer machine-token"); requests++; return Response.json({ files }); } });
  client.registration = { machineId: "test", token: "machine-token", server: "http://fixture", name: "test", concurrency: 1, runtimes: ["mock"] };
  const job = makeJob({ skills: [{ slug: "testing", name: "Testing", description: "Run tests", version }] });
  const ready = await prepareSkills(job, client); await prepareSkills(job, client); expect(requests).toBe(1); expect(ready.systemInstructions).toContain("## Available skills"); expect(ready.systemInstructions).not.toContain("Skill instructions"); expect(ready.systemInstructions).toContain(join(root, "skills-cache", `testing@${version}`, "SKILL.md"));
  expect(await readFile(join(root, "skills-cache", `testing@${version}`, "scripts/tool.sh"), "utf8")).toBe("echo test");
  await expect(prepareSkills(makeJob({ skills: [{ slug: "../escape", name: "Bad", description: "Bad", version }] }), client)).rejects.toThrow("identity");
});
it("redacts connection header values, bearer tokens and short stdio env across chunks", () => {
  const credentials = jobCredentials(makeJob({ connections: [{ identifier: "remote", transport: "http", headers: { Authorization: "Bearer fixture-credential" } }, { identifier: "local", transport: "stdio", env: { PIN: "xyz" } }] }));
  const events: AgentEvent[] = []; const stream = secretEvents(credentials, (e) => events.push(e), 1);
  for (const content of ["Bearer fixture-", "credential fixture-", "credential xyz"]) stream.emit({ type: "message.delta", content });
  stream.emit({ type: "message.completed" }); stream.emit({ type: "tool.completed", tool: "fixture", callId: "test", output: { value: "xyz", header: "Bearer fixture-credential" } }); stream.flush();
  expect(JSON.stringify(events)).not.toMatch(/fixture-credential|xyz/); expect(redactor(credentials, 1)({ diff: "+xyz", error: "fixture-credential" })).toEqual({ diff: "+[secret:local.PIN]", error: "[secret:remote.Authorization.token]" });
});

