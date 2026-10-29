import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Daemon } from "../apps/daemon/dist/daemon.js";
import { MachineClient } from "../apps/daemon/dist/client.js";
import { MockRuntime } from "../apps/daemon/dist/runtimes/mock.js";
import { git } from "../apps/daemon/dist/worktree.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "muster-e2e-")));
const repo = join(root, "repo");
const workspaces = join(root, "server-data", "workspaces");
let daemon;
let server;
let stderr = "";
async function until(read, predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}\n${stderr}`);
}
try {
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await writeFile(join(repo, "README.md"), "Muster e2e fixture\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "fixture");
  const original = await git(repo, "rev-parse", "HEAD");
  server = spawn(process.execPath, [fileURLToPath(new URL("../apps/server/dist/index.js", import.meta.url))], {
    env: { ...process.env, PORT: "0", MUSTER_PUBLIC_URL: "", MUSTER_ENROLL_KEY: "", MUSTER_DATA_DIR: join(root, "server-data"), MUSTER_CLAIM_WAIT_MS: "100", MUSTER_CHIEF_AUTO_FOLLOW_UP: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  server.stdout.on("data", (chunk) => { stdout += chunk; });
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  server.on("error", (error) => { stderr += error.stack; });
  const url = await until(async () => stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], Boolean, "server startup");
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${url}/api${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert(response.ok, `${method} ${path}: ${JSON.stringify(result)}`);
    return result.data;
  };
  const project = await api("/projects", { name: "E2E", repoUrl: repo });
  await api("/settings", { workspaceName: "E2E workspace", appearance: "dark", language: "en" }, "PATCH");
  assert.equal((await api("/settings")).workspaceName, "E2E workspace");
  assert((await api(`/projects/${project.id}/tree`)).some((file) => file.name === "README.md"));
  assert.equal((await api(`/projects/${project.id}/file?path=README.md`)).content, "Muster e2e fixture\n");
  const externalKey = await api("/api-keys", { name: "E2E reader", scopes: ["read"] });
  const externalMcp = (method, params) => fetch(`${url}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${externalKey.key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const catalog = await (await externalMcp("tools/list")).json();
  assert(catalog.result.tools.every((tool) => tool.annotations.readOnlyHint));
  assert(!catalog.result.tools.some((tool) => tool.name === "create_todo"));
  assert.equal((await (await externalMcp("tools/call", { name: "create_todo", arguments: { projectId: project.id, title: "Denied" } })).json()).result.isError, true);
  assert.equal((await fetch(`${url}/api/api-keys/${externalKey.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await externalMcp("tools/list")).status, 401);
  console.log("PASS settings, local project browsing and external MCP scope/revocation over HTTP");
  const agent = await api("/agents", { name: "Mock", role: "Build deterministic fixtures", runtime: "mock", model: "mock" });
  const skillForm = new FormData();
  skillForm.append("files", new Blob(["---\nname: E2E Skill\ndescription: Verify resource delivery\n---\nUse the deterministic mock runtime."]), "fixture/SKILL.md");
  const skillResponse = await fetch(`${url}/api/skills/upload`, { method: "POST", body: skillForm });
  assert.equal(skillResponse.status, 201);
  const skill = (await skillResponse.json()).data[0];
  await api(`/agents/${agent.id}`, { defaultSkillIds: [skill.id], permissions: { secrets: true } }, "PATCH");
  await api(`/agents/${agent.id}/memories`, { content: "E2E persistent memory" });
  await api("/secrets", { scope: "team", name: "SERVICE_TOKEN", value: "muster-e2e-private" }, "PUT");
  const chief = (await api("/agents")).find((item) => item.isChief);
  assert.equal(chief.model, "default");
  assert.equal(chief.reasoning, "medium");
  await api(`/agents/${chief.id}`, { runtime: "mock", model: "mock" }, "PATCH");
  const client = new MachineClient({ server: url, home: join(root, "server-data"), name: "e2e", concurrency: 3, runtimes: ["mock"] });
  let lateTodoId;
  let lateTurnId;
  const complete = client.complete.bind(client);
  client.complete = async (turnId, payload) => {
    if (lateTodoId) {
      const target = await api(`/todos/${lateTodoId}`);
      if (target.builds.some((build) => build.turns.some((turn) => turn.id === turnId))) {
        const todoId = lateTodoId;
        lateTodoId = undefined;
        lateTurnId = turnId;
        // The runtime and inbox loop have finished. Queue at the completion
        // boundary, without relying on a sleep landing between two polls.
        assert.equal(target.phase, "building");
        assert.equal((await api(`/todos/${todoId}/message`, { content: "LATE_COMPLETION_STEER" })).queued, true);
        const build = target.builds.at(-1);
        assert.equal((await api(`/conversations/${build.id}/queued-messages`)).length, 1);
        // Also exercise an in-flight delivery that never receives an ACK.
        assert.equal((await client.inbox(turnId)).length, 1);
      }
    }
    await complete(turnId, payload);
  };
  class ResourceMock extends MockRuntime {
    start(job, context) {
      if (job.todoId) {
        assert.equal(job.env.SERVICE_TOKEN, "muster-e2e-private");
        assert(job.systemInstructions.includes("E2E persistent memory"));
        assert(job.systemInstructions.includes("skills-cache"));
        if (job.attachments?.length) assert(job.prompt.includes("attachments-cache"));
        context.emit({ type: "tool.completed", tool: "resource-fixture", output: job.env.SERVICE_TOKEN });
      }
      const artifactMatch = job.systemInstructions.match(/Build artifact directory: (.+)\n/);
      if (job.todoId) {
        assert(artifactMatch, "artifact directory is in system instructions");
        assert(existsSync(JSON.parse(artifactMatch[1])), "artifact directory exists before runtime start");
      }
      const running = super.start(job, context);
      return { ...running, result: running.result.then(async (result) => {
        if (job.todoId && !job.readOnly) {
          const artifact = join(JSON.parse(artifactMatch[1]), `${job.turnId}.png`);
          const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGMoKPgPRAwQCgAyNgd9JQZITgAAAABJRU5ErkJggg==", "base64");
          await writeFile(artifact, png);
          context.emit({ type: "message.completed", content: `![Artifact](<${artifact}>)\n![Temporary](/tmp/muster-screen.png)\n![Other](<${join(root, "server-data", "artifacts", "other", "screen.png")}>)` });
        }
        return result;
      }) };

    }
  }
  daemon = new Daemon({ client, workspacesDir: workspaces, log: (level, message, meta) => { if (level === "error") stderr += `${message}: ${JSON.stringify(meta)}\n`; },
    runtimes: { mock: new ResourceMock(20) }, heartbeatMs: 100, inboxMs: 20, flushMs: 20 });
  await daemon.start();
  const details = (id) => api(`/todos/${id}`);
  const phase = (id, target) => until(() => details(id), (todo) => todo.phase === target, `${id} → ${target}`);
  const create = (title) => api("/todos", { projectId: project.id, agentId: agent.id, title, spec: "Write a deterministic integration fixture." });
  const todo = await create("Plan and merge");
  const attachmentForm = new FormData(); attachmentForm.append("files", new Blob(["E2E attachment"]), "notes.txt");
  assert.equal((await fetch(`${url}/api/todos/${todo.id}/attachments`, { method: "POST", body: attachmentForm })).status, 201);
  await api(`/todos/${todo.id}/start`, { mode: "plan" });
  const planned = await phase(todo.id, "confirm");
  const resourceMessages = JSON.stringify(await api(`/conversations/${planned.builds[0].id}/messages`));
  assert(!resourceMessages.includes("muster-e2e-private"));
  assert(resourceMessages.includes("[secret:SERVICE_TOKEN]"));
  const attachment = (await api(`/todos/${todo.id}/attachments`))[0];
  assert.equal(await readFile(join(root, "server-data", "attachments-cache", `${attachment.id}-${attachment.hash}`), "utf8"), "E2E attachment");
  console.log("PASS attachment upload → authenticated machine download → cache + prompt");
  console.log("PASS agent memory + skill cache + permission-gated env + upload redaction");
  assert(planned.builds[0].documents.some((doc) => doc.kind === "plan"));
  await api(`/todos/${todo.id}/confirm`, {});
  await phase(todo.id, "building");
  await api(`/todos/${todo.id}/message`, { content: "MID_TURN_STEER" });
  const reviewed = await phase(todo.id, "review");
  const build = reviewed.builds[0];
  const taskTree = join(workspaces, build.id);
  assert.equal(await git(taskTree, "log", "-1", "--format=%s"), `#${todo.number} ${todo.title}`);
  assert.match(await git(taskTree, "log", "-1", "--format=%b"), /Turn: \d+/);
  assert(build.documents.some((doc) => doc.kind === "changes" && doc.content.includes("MUSTER_MOCK.md")));
  assert((await api(`/conversations/${build.id}/messages`)).some((message) => message.content.includes("Steer: MID_TURN_STEER")));
  assert.equal((await api(`/conversations/${build.id}/queued-messages`)).length, 0);
  const imageMessage = (await api(`/conversations/${build.id}/messages`)).find((message) => message.content.startsWith("![Artifact]"));
  assert(imageMessage, "mock image Markdown persisted");
  const imagePath = imageMessage.content.match(/!\[Artifact\]\(<(.+)>\)/)[1];
  const imageRequest = (src, buildId = build.id) => fetch(`${url}/api/todos/${todo.id}/images`, { method: "POST", headers: { "Content-Type": "application/json", "X-Muster-Image": "1", Origin: url }, body: JSON.stringify({ buildId, messageId: imageMessage.id, src }) });
  const imageResponse = await imageRequest(imagePath);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), await readFile(imagePath));
  assert.equal((await imageRequest("/tmp/muster-screen.png")).status, 403);
  assert.equal((await imageRequest(join(root, "server-data", "artifacts", "other", "screen.png"))).status, 403);
  assert.equal((await imageRequest(imagePath, "other")).status, 404);
  assert(!(await git(join(workspaces, build.id), "ls-files")).includes(".png"));
  console.log("PASS build artifact directory → mock screenshot → persisted Markdown → scoped image bytes, cross-build and temporary path denial");
  await api(`/todos/${todo.id}/done`, { merge: true });
  await phase(todo.id, "done");
  assert.notEqual(await git(repo, "rev-parse", "HEAD"), original);
  assert((await readFile(join(repo, "MUSTER_MOCK.md"), "utf8")).includes("Plan and merge"));
  assert.equal(await git(repo, "status", "--porcelain"), "");
  const mergeMessage = await git(repo, "log", "-1", "--format=%B");
  assert.equal(mergeMessage.split("\n")[0], `Merge #${todo.number}: ${todo.title}`);
  assert(mergeMessage.includes("Write a deterministic integration fixture."));
  assert(mergeMessage.includes(`Task: ${url}/todos/${todo.id}`));
  assert(mergeMessage.includes(`Task ID: ${todo.id}`));
  console.log("PASS task checkpoint and merge subjects, summary, URL and ID");
  console.log("PASS plan → confirm → build + steer → review → merge → done");

  const late = await create("Late completion steer");
  lateTodoId = late.id;
  await api(`/todos/${late.id}/start`, { mode: "run" });
  const lateReviewed = await phase(late.id, "review");
  const lateBuild = lateReviewed.builds[0];
  assert(lateTurnId, "completion boundary hook ran");
  assert.deepEqual((await git(join(workspaces, lateBuild.id), "log", "-2", "--format=%s")).split("\n"), Array(2).fill(`#${late.number} ${late.title}`));
  assert.equal(lateBuild.turns.length, 2);
  assert.equal(lateBuild.turns[0].id, lateTurnId);
  assert.equal(lateBuild.turns[1].kind, "revise");
  assert.equal(lateBuild.turns[1].status, "done");
  assert(lateBuild.turns[1].prompt.includes("LATE_COMPLETION_STEER"));
  assert.equal((await api(`/conversations/${lateBuild.id}/queued-messages`)).length, 0);
  const lateHistory = await api(`/conversations/${lateBuild.id}/messages`);
  const opening = lateHistory.filter((message) => message.role === "user" && message.content === "LATE_COMPLETION_STEER");
  assert.equal(opening.length, 1);
  assert.equal(opening[0].turnId, lateBuild.turns[1].id);
  assert(lateHistory.some((message) => message.role === "agent" && message.turnId === lateBuild.turns[1].id && message.content.includes("LATE_COMPLETION_STEER")));
  console.log("PASS steer queued at completion → automatic revise → review, empty queue and persisted conversation");

  const one = await create("ISOLATED_ONE"); const two = await create("ISOLATED_TWO");
  await Promise.all([one, two].map((item) => api(`/todos/${item.id}/start`, { mode: "run" })));
  await until(async () => Promise.all([details(one.id), details(two.id)]), (todos) => todos.every((item) => item.phase === "building"), "parallel running builds");
  const [first, second] = await Promise.all([phase(one.id, "review"), phase(two.id, "review")]);
  assert.notEqual(first.builds[0].id, second.builds[0].id);
  for (const [item, included, excluded] of [[first, "ISOLATED_ONE", "ISOLATED_TWO"], [second, "ISOLATED_TWO", "ISOLATED_ONE"]]) {
    const cwd = join(workspaces, item.builds[0].id);
    const content = await readFile(join(cwd, "MUSTER_MOCK.md"), "utf8");
    assert(content.includes(included) && !content.includes(excluded));
    assert.equal(await git(cwd, "branch", "--show-current"), item.builds[0].branch);
  }
  console.log("PASS concurrent todos use isolated worktrees and branches");

  const topic = (await api("/topics"))[0];
  await api(`/topics/${topic.id}/messages`, { content: "/split Chief integration" });
  const children = await until(() => api("/todos"), (todos) => todos.filter((item) => item.createdBy === "chief").length === 2, "Chief MCP creates two todos");
  const delegated = children.filter((item) => item.createdBy === "chief");
  assert(delegated.every((item) => item.topicId === topic.id));
  await Promise.all(delegated.map((item) => phase(item.id, "review")));
  await until(() => api("/topics"), (topics) => topics.find((item) => item.id === topic.id)?.activity === "idle", "Chief turn completion");
  const conversation = await api(`/conversations/${topic.id}/messages`);
  assert.equal(conversation.filter((item) => item.role === "tool" && item.meta.type === "tool.completed" && item.meta.tool === "create_todo").length, 2);
  assert((await api("/usage")).entries.some((entry) => entry.topicId === topic.id && entry.tokensOut > 0));
  console.log("PASS Chief → authenticated MCP → two started todos → board + persisted activity/usage");

  for (const path of ["/", "/agents", `/agents/${agent.id}`, "/skills", "/skills/new", `/skills/${skill.slug}`, "/secrets", "/settings", "/schedules", "/connections", "/projects", `/projects/${project.id}`, `/projects/${project.id}/settings`, "/machines", "/usage", `/todos/${todo.id}`]) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200); assert((await response.text()).includes('<div id="root">'));
  }
  const controller = new AbortController();
  const events = await fetch(`${url}/api/events`, { signal: controller.signal, headers: { "last-event-id": "0" } });
  assert(events.headers.get("content-type").includes("text/event-stream"));
  const reader = events.body.getReader();
  let replay = "";
  while (!replay.includes("message.delta")) replay += new TextDecoder().decode((await reader.read()).value);
  assert(replay.includes("id: ")); controller.abort();
  console.log("PASS production SPA routes, REST, and replayable SSE");
} finally {
  await daemon?.stop();
  if (server && server.exitCode === null) { const closed = once(server, "exit"); server.kill("SIGTERM"); await closed; }
  await rm(root, { recursive: true, force: true });
}
