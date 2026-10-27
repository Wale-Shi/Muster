import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../app.js";
import { migrations } from "../db/migrations.js";
import { MusterDb } from "../db/index.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";
import { frontmatter, parseGithubUrl, readSkillFolder, validateFiles } from "./skills.js";

const roots: string[] = []; const dbs: MusterDb[] = [];
afterEach(() => { dbs.splice(0).forEach((db) => db.close()); roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })); });
function setup() { const dataDir = mkdtempSync(join(tmpdir(), "muster-resources-")); roots.push(dataDir); const app = createApp({ dataDir, claimWaitMs: 0, autoFollowUp: false, githubFetcher: async () => [{ path: "SKILL.md", content: Buffer.from("---\nname: Imported\ndescription: Useful\n---\nDo the work").toString("base64") }] }); dbs.push(app.services.db); return { ...app, dataDir }; }
it("migrates v3 data forward and preserves duties with Chief permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "muster-v3-")); roots.push(root); const file = join(root, "db"); const old = new DatabaseSync(file);
  migrations.slice(0, 3).forEach((sql) => { if (typeof sql === "string") old.exec(sql); }); old.exec("PRAGMA user_version=3"); old.prepare("INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?)").run("chief", "Chief", "Keep this duty", "mock", "mock", null, null, 1, "2026-01-01"); old.close();
  const db = new MusterDb(file); dbs.push(db); const chief = db.agent(db.row("SELECT * FROM agents WHERE id='chief'")!);
  expect(chief).toMatchObject({ role: "Keep this duty", permissions: { pushBranch: false, secrets: false, createSkills: true, updateSkills: true }, defaultSkillIds: [], updatedAt: "2026-01-01" });
  expect(db.row("PRAGMA user_version")?.user_version).toBe(migrations.length);
});
it("rebuilds agents without the runtime CHECK and keeps references intact", () => {
  const root = mkdtempSync(join(tmpdir(), "muster-runtime-")); roots.push(root); const file = join(root, "db"); const old = new DatabaseSync(file);
  const last = migrations.findIndex((migration) => typeof migration !== "string");
  migrations.slice(0, last).forEach((sql) => { if (typeof sql === "string") old.exec(sql); }); old.exec(`PRAGMA user_version=${last}`);
  old.prepare("INSERT INTO agents (id,name,role,runtime,model,is_chief,created_at) VALUES (?,?,?,?,?,?,?)").run("a1", "Builder", "Build", "codex", "gpt", 0, "2026-01-01");
  old.prepare("INSERT INTO agent_memories VALUES (?,?,?,?,?,?)").run("m1", "a1", "Remember", "user", "2026-01-01", "2026-01-01");
  expect(() => old.prepare("UPDATE agents SET runtime='pi' WHERE id='a1'").run()).toThrow(); old.close();
  const db = new MusterDb(file); dbs.push(db);
  db.raw.prepare("UPDATE agents SET runtime='pi' WHERE id='a1'").run();
  expect(db.row("SELECT runtime FROM agents WHERE id='a1'")?.runtime).toBe("pi");
  expect(db.row("SELECT count(*) AS n FROM agent_memories WHERE agent_id='a1'")?.n).toBe(1);
  expect(db.row("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
  expect(() => db.raw.prepare("INSERT INTO agent_memories VALUES ('m2','missing','x','user','t','t')").run()).toThrow();
});
it("validates profiles and scopes memories, with a bounded newest-first prompt", async () => {
  const { app, services } = setup(); const { agentId } = await seedProjectAndAgent(app);
  expect((await requestJson(app, `/api/agents/${agentId}`, "PATCH", { permissions: { secrets: "true" } })).response.status).toBe(400);
  expect((await requestJson(app, `/api/agents/${agentId}`, "PATCH", { defaultSkillIds: ["missing"] })).response.status).toBe(400);
  const skill = services.skills.create({ name: "Tests", description: "Write tests", instructions: "Test behavior" });
  expect((await requestJson(app, `/api/agents/${agentId}`, "PATCH", { defaultSkillIds: [skill.id], permissions: { secrets: true } })).json.data.permissions.secrets).toBe(true);
  const memory = (await requestJson(app, `/api/agents/${agentId}/memories`, "POST", { content: "older" })).json.data;
  expect((await requestJson(app, `/api/agents/${agentId}/memories/${memory.id}`, "PATCH", { content: "edited" })).json.data.content).toBe("edited");
  const chief = services.db.agent(services.db.row("SELECT * FROM agents WHERE is_chief=1")!);
  expect((await requestJson(app, `/api/agents/${chief.id}/memories/${memory.id}`, "DELETE")).response.status).toBe(404);
  services.memories.create(agentId, "Newest ".repeat(1000), "agent"); const prompt = services.memories.instructions(agentId); expect(prompt).toContain("Newest"); expect(prompt).toContain("truncated"); expect(prompt.length).toBeLessThan(4000);
  expect((await requestJson(app, `/api/agents/${agentId}`)).json.data).toMatchObject({ memoryCount: 2, skillCount: 1, inProgress: [] });
  expect((await requestJson(app, `/api/agents/${agentId}/memories/${memory.id}`, "DELETE")).response.status).toBe(204);
});
it("validates skill paths, symlinks, limits and frontmatter; authenticates archives", async () => {
  const { app, services, dataDir } = setup();
  for (const path of ["../SKILL.md", "/SKILL.md", "a/../SKILL.md", "a\\b", "C:/SKILL.md"]) expect(() => validateFiles([{ path, content: "" }])).toThrow();
  expect(() => validateFiles(Array.from({ length: 201 }, (_, i) => ({ path: `${i}`, content: "" })))).toThrow();
  expect(() => validateFiles([{ path: "big", content: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }])).toThrow();
  expect(() => frontmatter("No header")).toThrow(); expect(frontmatter("---\nname: 'Example'\ndescription: |\n  Multi line\n---\nInstructions").name).toBe("Example");
  const folder = join(dataDir, "symlinks"); mkdirSync(folder); writeFileSync(join(folder, "file"), "safe"); symlinkSync(join(folder, "file"), join(folder, "link")); expect(() => readSkillFolder(folder)).toThrow(/symlink/);
  expect(parseGithubUrl("https://github.com/org/repo/tree/main/skills/test")).toEqual({ repo: "https://github.com/org/repo.git", ref: "main", path: "skills/test" });
  for (const url of ["http://github.com/org/repo", "https://evil.test/org/repo", "https://github.com/org/repo/blob/main/foo", "https://github.com/org/repo/tree/main/%2e%2e", "https://github.com/org/repo/tree/--upload-pack=x/skill", "https://github.com/org/repo/tree/-b/skill"]) expect(() => parseGithubUrl(url)).toThrow();
  const skill = (await requestJson(app, "/api/skills/github", "POST", { url: "https://github.com/org/repo" })).json.data;
  const path = `/api/machine/skills/${skill.slug}/archive?version=${skill.version}`;
  expect((await requestJson(app, path)).response.status).toBe(401);
  const machine = await enroll(app); expect((await requestJson(app, path, "GET", undefined, machine.token)).json.files[0].path).toBe("SKILL.md");
  expect((await requestJson(app, path.replace(skill.version, "old"), "GET", undefined, machine.token)).response.status).toBe(409);
  const form = new FormData(); form.append("files", new Blob(["---\nname: Uploaded\ndescription: Test upload\n---\nWork"]), "folder/SKILL.md");
  expect((await app.request("/api/skills/upload", { method: "POST", body: form })).status).toBe(201);
  expect(services.skills.list()).toHaveLength(2);
});
it("encrypts secrets, keeps APIs write-only, applies project overrides, and never journals env", async () => {
  const { app, services, dataDir } = setup(); const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
  const put = (value: unknown) => requestJson(app, "/api/secrets", "PUT", value);
  const team = await put({ scope: "team", name: "SERVICE_TOKEN", value: "team-private-value" });
  expect(team.response.status).toBe(200); expect(JSON.stringify(team.json)).not.toContain("team-private-value");
  await put({ scope: "team", name: "SERVICE_TOKEN", value: "team-replaced-value" });
  await put({ scope: "project", projectId, name: "SERVICE_TOKEN", value: "project-private-value" });
  expect(services.secrets.env(null)).toEqual({ SERVICE_TOKEN: "team-replaced-value" }); expect(services.secrets.env(projectId)).toEqual({ SERVICE_TOKEN: "project-private-value" });
  expect(statSync(join(dataDir, "secret.key")).mode & 0o777).toBe(0o600); expect(readFileSync(join(dataDir, "secret.key"))).toHaveLength(32);
  const serialized = JSON.stringify(services.db.rows("SELECT * FROM secrets")); expect(serialized).not.toContain("private-value");
  for (const name of ["PATH", "HOME", "MUSTER_X", "CODEX_X", "CLAUDE_X", "bad", "NODE_OPTIONS"]) expect((await put({ scope: "team", name, value: "invalid" })).response.status).toBe(400);
  expect((await put({ scope: "project", name: "VALID", value: "invalid" })).response.status).toBe(400);
  const todoId = await createTodo(app, projectId, agentId); services.orchestrator.start(todoId, "plan"); const job = services.scheduler.claim(machine.token, "retry")!; expect(job.env).toBeUndefined();
  await requestJson(app, `/api/agents/${agentId}`, "PATCH", { permissions: { secrets: true } });
  const replay = services.scheduler.claim(machine.token, "retry")!; expect(replay.env).toEqual({ SERVICE_TOKEN: "project-private-value" }); expect(replay.readOnly).toBe(true);
  expect(JSON.stringify(services.db.rows("SELECT * FROM machine_claims"))).not.toContain("private-value"); expect(JSON.parse(String(services.db.row("SELECT job_json FROM machine_claims")?.job_json))).not.toHaveProperty("env");
  const list = await requestJson(app, "/api/secrets"); expect(list.json.data).toHaveLength(2); expect(JSON.stringify(list.json)).not.toMatch(/ciphertext|iv|tag|value/);
  await requestJson(app, `/api/secrets/${team.json.data.id}`, "DELETE"); expect(services.secrets.env(null)).toEqual({});
});
it("scopes MCP memories and skill permissions and fulfills Chief secret requests without values in messages", async () => {
  const { app, services } = setup(); const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app, 2);
  const chief = services.db.agent(services.db.row("SELECT * FROM agents WHERE is_chief=1")!); await requestJson(app, `/api/agents/${chief.id}`, "PATCH", { runtime: "mock", model: "mock" });
  const todoId = await createTodo(app, projectId, agentId, "run"); services.orchestrator.start(todoId, "run"); const job = services.scheduler.claim(machine.token)!;
  const connect = async (token: string) => {
    let session = ""; let seq = 0;
    const rpc = async (method: string, params: unknown) => { const r = await requestJson(app, "/mcp", "POST", { jsonrpc: "2.0", id: ++seq, method, params }, token, session ? { "mcp-session-id": session } : undefined); session ||= r.response.headers.get("mcp-session-id") ?? ""; return r.json; };
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "resources", version: "1" } });
    return async (name: string, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  };
  const agent = await connect(job.mcp.token); const own = await agent("remember", { content: "Own memory" }); const memory = JSON.parse(own.content[0].text); expect(memory).toMatchObject({ agentId, source: "agent" });
  const other = services.memories.create(chief.id, "Chief memory", "user"); expect((await agent("forget", { memoryId: other.id })).isError).toBe(true);
  expect((await agent("list_memories")).content[0].text).not.toContain("Chief memory");
  expect((await agent("create_skill", { name: "Denied", description: "Denied", instructions: "Denied" })).isError).toBe(true);
  expect((await agent("request_secret", { name: "API_TOKEN", scope: "team", reason: "Need access" })).isError).toBe(true);
  const topicId = String(services.db.row("SELECT id FROM topics")!.id); services.orchestrator.enqueueChief(topicId, "Request access"); const chiefJob = services.scheduler.claim(machine.token)!; const call = await connect(chiefJob.mcp.token);
  expect((await call("create_skill", { name: "Allowed", description: "Useful", instructions: "Work" })).isError).not.toBe(true);
  const requested = JSON.parse((await call("request_secret", { name: "API_TOKEN", scope: "team", reason: "Need access" })).content[0].text); expect(requested.status).toBe("requested");
  expect((await requestJson(app, "/api/secrets", "PUT", { scope: "team", name: "WRONG", value: "never-in-chat", requestId: requested.messageId })).response.status).toBe(400);
  expect((await requestJson(app, "/api/secrets", "PUT", { scope: "team", name: "API_TOKEN", value: "never-in-chat", requestId: requested.messageId })).response.status).toBe(200);
  const messages = services.db.rows("SELECT * FROM messages"); expect(JSON.stringify(messages)).not.toContain("never-in-chat"); expect(services.db.message(services.db.row("SELECT * FROM messages WHERE id=?", requested.messageId)!).meta.fulfilledAt).toBeTruthy();
  expect(JSON.stringify(services.db.rows("SELECT * FROM server_events"))).not.toContain("never-in-chat");
});

it("protects the running snapshot even after reassignment and rolls back bulk imports on conflict", async () => {
  const { app, services } = setup(); const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
  const todoId = await createTodo(app, projectId, agentId, "run"); services.orchestrator.start(todoId, "run"); services.scheduler.claim(machine.token);
  await requestJson(app, `/api/todos/${todoId}`, "PATCH", { agentId: null });
  expect((await requestJson(app, `/api/agents/${agentId}`, "DELETE")).response.status).toBe(409);
  const form = new FormData(); form.append("bulk", "true");
  for (const folder of ["one", "two"]) form.append("files", new Blob(["---\nname: Duplicate\ndescription: Test\n---\nWork"]), `${folder}/SKILL.md`);
  expect((await app.request("/api/skills/upload", { method: "POST", body: form })).status).toBe(409); expect(services.skills.list()).toEqual([]);
});
it("unions default and mentioned skills, scopes planning to its agent and updates content hashes", async () => {
  const { app, services } = setup(); const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
  const skill = services.skills.create({ name: "Default", description: "Default", instructions: "Original" }); const mentioned = services.skills.create({ name: "Mentioned", description: "Mention", instructions: "Other" });
  await requestJson(app, `/api/agents/${agentId}`, "PATCH", { defaultSkillIds: [skill.id] }); services.memories.create(agentId, "Planning memory", "user");
  const todoId = await createTodo(app, projectId, agentId); await requestJson(app, `/api/todos/${todoId}`, "PATCH", { spec: "Use @mentioned and @default" }); services.orchestrator.start(todoId, "plan");
  const job = services.scheduler.claim(machine.token)!; expect(job.skills?.map((s) => s.slug).sort()).toEqual(["default", "mentioned"]); expect(job.systemInstructions).toContain("Planning memory");
  const updated = services.skills.update(mentioned.slug, { instructions: "Revised" }); expect(updated.version).not.toBe(mentioned.version); expect(updated.description).toBe("Mention");
  services.skills.delete(skill.slug); expect(services.db.agent(services.db.row("SELECT * FROM agents WHERE id=?", agentId)!).defaultSkillIds).toEqual([]);
});
