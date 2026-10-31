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
  expect(chief).toMatchObject({ role: "Keep this duty", permissions: { createSkills: true, updateSkills: true }, defaultSkillIds: [], updatedAt: "2026-01-01" });
  expect(db.row("PRAGMA user_version")?.user_version).toBe(migrations.length);
});
it("rebuilds agents without the runtime CHECK and keeps references intact", () => {
  const root = mkdtempSync(join(tmpdir(), "muster-runtime-")); roots.push(root); const file = join(root, "db"); const old = new DatabaseSync(file);
  const last = migrations.findIndex((migration) => typeof migration !== "string");
  migrations.slice(0, last).forEach((sql) => { if (typeof sql === "string") old.exec(sql); }); old.exec(`PRAGMA user_version=${last}`);
  old.prepare("INSERT INTO agents (id,name,role,runtime,model,is_chief,created_at) VALUES (?,?,?,?,?,?,?)").run("a1", "Builder", "Build", "codex", "gpt", 0, "2026-01-01");
  old.prepare("INSERT INTO projects (id,name,repo_url,base_branch,created_at) VALUES ('p1','P','/tmp/p','main','2026-01-01')").run();
  old.prepare("INSERT INTO todos (id,number,project_id,title,spec,phase,agent_id,mode,tags_json,created_by,created_at,updated_at) VALUES ('t1',1,'p1','T','','todo','a1','run','[]','user','2026-01-01','2026-01-01')").run();
  expect(() => old.prepare("UPDATE agents SET runtime='pi' WHERE id='a1'").run()).toThrow(); old.close();
  const db = new MusterDb(file); dbs.push(db);
  db.raw.prepare("UPDATE agents SET runtime='pi' WHERE id='a1'").run();
  expect(db.row("SELECT runtime FROM agents WHERE id='a1'")?.runtime).toBe("pi");
  expect(db.row("SELECT agent_id FROM todos WHERE id='t1'")?.agent_id).toBe("a1");
  expect(db.row("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
  expect(() => db.raw.prepare("UPDATE todos SET agent_id='missing' WHERE id='t1'").run()).toThrow();
});
it("migrates projects into workspaces and drops removed features", () => {
  const root = mkdtempSync(join(tmpdir(), "muster-workspaces-")); roots.push(root); const file = join(root, "db"); const old = new DatabaseSync(file);
  const before = migrations.length - 1;
  for (const migration of migrations.slice(0, before)) {
    if (typeof migration === "string") old.exec(migration);
    else { old.exec("PRAGMA foreign_keys=OFF"); old.exec(migration.sql); old.exec("PRAGMA foreign_keys=ON"); }
  }
  old.exec(`PRAGMA user_version=${before}`);
  old.exec(`INSERT INTO agents (id,name,role,runtime,model,is_chief,created_at) VALUES ('a1','Builder','Build','mock','mock',0,'2026-01-01');
    INSERT INTO projects (id,name,repo_url,base_branch,created_at) VALUES ('p1','Shop','/tmp/shop','main','2026-01-01');
    INSERT INTO topics VALUES ('general','General',NULL,'2026-01-01','2026-01-01');
    INSERT INTO todos (id,number,project_id,title,spec,phase,agent_id,mode,tags_json,created_by,topic_id,previous_gate,created_at,updated_at) VALUES
      ('t1',1,'p1','Planned','','confirm','a1','plan','[]','user','general','confirm','2026-01-01','2026-01-01'),
      ('t2',2,'p1','Built','','review','a1','run','[]','chief','general','review','2026-01-01','2026-01-01');
    INSERT INTO builds (id,todo_id,branch,status,created_at) VALUES ('b1','t1','muster/conv-b1','active','2026-01-01');
    INSERT INTO turns (id,build_id,kind,status,prompt) VALUES ('u1','b1','plan','queued','plan it');
    INSERT INTO documents VALUES ('d1','b1','plan',1,'Plan','2026-01-01');
    INSERT INTO settings VALUES ('language','"zh-CN"'), ('workspaceName','"Team"');`);
  old.close();
  const db = new MusterDb(file); dbs.push(db);
  const project = db.project(db.row("SELECT * FROM projects WHERE id='p1'")!);
  expect(project).toMatchObject({ chiefAgentId: null, topicId: expect.any(String) });
  expect(db.topic(db.row("SELECT * FROM topics WHERE id=?", project.topicId)!)).toMatchObject({ projectId: "p1", title: "Shop" });
  expect(db.rows("SELECT id, phase, previous_gate, topic_id FROM todos ORDER BY number")).toEqual([
    { id: "t1", phase: "todo", previous_gate: null, topic_id: project.topicId },
    { id: "t2", phase: "review", previous_gate: "review", topic_id: project.topicId },
  ]);
  expect(db.row("SELECT status FROM turns WHERE id='u1'")?.status).toBe("stopped");
  expect(db.rows("SELECT * FROM documents")).toEqual([]);
  expect(db.rows("SELECT key FROM settings")).toEqual([{ key: "workspaceName" }]);
  for (const table of ["schedules", "secrets", "agent_memories", "attachments"]) expect(db.row("SELECT name FROM sqlite_master WHERE name=?", table)).toBeUndefined();
});
it("validates profiles, drops removed permissions and reports the workspaces an agent leads", async () => {
  const { app } = setup(); const { agentId, projectId } = await seedProjectAndAgent(app);
  expect((await requestJson(app, `/api/agents/${agentId}`, "PATCH", { permissions: { createSkills: "true" } })).response.status).toBe(400);
  expect((await requestJson(app, `/api/agents/${agentId}`, "PATCH", { defaultSkillIds: ["missing"] })).response.status).toBe(400);
  expect((await requestJson(app, `/api/agents/${agentId}`, "PATCH", { permissions: { secrets: true, createSkills: true } })).json.data.permissions).toEqual({ createSkills: true, updateSkills: false });
  await requestJson(app, `/api/projects/${projectId}`, "PATCH", { chiefAgentId: agentId });
  expect((await requestJson(app, `/api/agents/${agentId}`)).json.data).toMatchObject({ skillCount: 0, inProgress: [], workspaces: [{ id: projectId }] });
  expect((await requestJson(app, `/api/agents/${agentId}`, "DELETE")).response.status).toBe(204);
  expect((await requestJson(app, `/api/projects/${projectId}`)).json.data.chiefAgentId).toBeNull();
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
it("keeps connection credentials encrypted with a private key file", async () => {
  const { services, dataDir } = setup();
  services.connections.save({ identifier: "remote", name: "Remote", transport: "http", url: "https://example.test/mcp", secrets: { Authorization: "Bearer private-value" } });
  expect(statSync(join(dataDir, "secret.key")).mode & 0o777).toBe(0o600); expect(readFileSync(join(dataDir, "secret.key"))).toHaveLength(32);
  expect(JSON.stringify(services.db.rows("SELECT * FROM connections"))).not.toContain("private-value");
});
it("gates MCP skill tools on the agent's permissions", async () => {
  const { app, services } = setup(); const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app, 2);
  const chief = services.db.agent(services.db.row("SELECT * FROM agents WHERE is_chief=1")!); await requestJson(app, `/api/agents/${chief.id}`, "PATCH", { runtime: "mock", model: "mock" });
  const todoId = await createTodo(app, projectId, agentId); services.orchestrator.start(todoId); const job = services.scheduler.claim(machine.token)!;
  const connect = async (token: string) => {
    let session = ""; let seq = 0;
    const rpc = async (method: string, params: unknown) => { const r = await requestJson(app, "/mcp", "POST", { jsonrpc: "2.0", id: ++seq, method, params }, token, session ? { "mcp-session-id": session } : undefined); session ||= r.response.headers.get("mcp-session-id") ?? ""; return r.json; };
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "resources", version: "1" } });
    return async (name: string, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  };
  const agent = await connect(job.mcp.token);
  expect((await agent("create_skill", { name: "Denied", description: "Denied", instructions: "Denied" })).isError).toBe(true);
  expect((await agent("create_task", { title: "Not for coding agents" })).isError).toBe(true);
  services.orchestrator.enqueueChief(services.orchestrator.topicFor(projectId), "Write a skill"); const chiefJob = services.scheduler.claim(machine.token)!; const call = await connect(chiefJob.mcp.token);
  expect((await call("create_skill", { name: "Allowed", description: "Useful", instructions: "Work" })).isError).not.toBe(true);
});

it("protects the running snapshot even after reassignment and rolls back bulk imports on conflict", async () => {
  const { app, services } = setup(); const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
  const todoId = await createTodo(app, projectId, agentId); services.orchestrator.start(todoId); services.scheduler.claim(machine.token);
  await requestJson(app, `/api/todos/${todoId}`, "PATCH", { agentId: null });
  expect((await requestJson(app, `/api/agents/${agentId}`, "DELETE")).response.status).toBe(409);
  const form = new FormData(); form.append("bulk", "true");
  for (const folder of ["one", "two"]) form.append("files", new Blob(["---\nname: Duplicate\ndescription: Test\n---\nWork"]), `${folder}/SKILL.md`);
  expect((await app.request("/api/skills/upload", { method: "POST", body: form })).status).toBe(409); expect(services.skills.list()).toEqual([]);
});
it("unions default and mentioned skills and updates content hashes", async () => {
  const { app, services } = setup(); const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
  const skill = services.skills.create({ name: "Default", description: "Default", instructions: "Original" }); const mentioned = services.skills.create({ name: "Mentioned", description: "Mention", instructions: "Other" });
  await requestJson(app, `/api/agents/${agentId}`, "PATCH", { defaultSkillIds: [skill.id] });
  const todoId = await createTodo(app, projectId, agentId); await requestJson(app, `/api/todos/${todoId}`, "PATCH", { spec: "Use @mentioned and @default" }); services.orchestrator.start(todoId);
  const job = services.scheduler.claim(machine.token)!; expect(job.skills?.map((s) => s.slug).sort()).toEqual(["default", "mentioned"]);
  const updated = services.skills.update(mentioned.slug, { instructions: "Revised" }); expect(updated.version).not.toBe(mentioned.version); expect(updated.description).toBe("Mention");
  services.skills.delete(skill.slug); expect(services.db.agent(services.db.row("SELECT * FROM agents WHERE id=?", agentId)!).defaultSkillIds).toEqual([]);
});
