import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareArtifacts } from "../src/artifacts.js";
import { makeJob, fixture } from "./helpers.js";
import { Worktrees, git } from "../src/worktree.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function home() { const root = await realpath(await mkdtemp(join(tmpdir(), "muster-artifacts-"))); roots.push(root); return root; }
const project = { id: "project", repoUrl: "/unused", baseBranch: "main" };
it("prepares a private build directory, preserves existing files, and isolates builds and homes", async () => {
  const root = await home(), other = await home();
  const job = makeJob({ project });
  const prepared = await prepareArtifacts(job, root);
  expect(prepared.systemInstructions).toContain(JSON.stringify(join(root, "artifacts", job.buildId)));
  expect(prepared.systemInstructions).toContain("![Screenshot](<");
  const file = join(root, "artifacts", job.buildId, "screenshot.png");
  await writeFile(file, "keep");
  expect((await prepareArtifacts(job, root)).systemInstructions).toBe(prepared.systemInstructions);
  expect(await readFile(file, "utf8")).toBe("keep");
  expect((await prepareArtifacts({ ...job, buildId: "another" }, root)).systemInstructions).toContain("artifacts/another");
  expect((await prepareArtifacts(job, other)).systemInstructions).toContain(other);
});
it("does not relax planning permissions or prepare a directory for Chief/merge", async () => {
  const root = await home();
  const prepared = await prepareArtifacts(makeJob({ project, readOnly: true, kind: "plan", sessionState: { threadId: "existing" } }), root);
  expect(prepared.readOnly).toBe(true);
  expect(prepared.sessionState).toEqual({ threadId: "existing" });
  expect(prepared.systemInstructions).toContain("do not create or copy artifacts");
  for (const job of [makeJob(), makeJob({ project, kind: "merge" })]) expect(await prepareArtifacts(job, root)).toBe(job);
});
it.each(["../escape", "a/b", "", ".."])("rejects unsafe build id %j", async (buildId) => {
  await expect(prepareArtifacts(makeJob({ project, buildId }), await home())).rejects.toThrow();
});
it.each(["artifacts", "artifacts/build-1"])("rejects pre-existing symlink at %s", async (part) => {
  const root = await home(), outside = await home();
  if (part.includes("/")) await mkdir(join(root, "artifacts"));
  await symlink(outside, join(root, part));
  await expect(prepareArtifacts(makeJob({ project }), root)).rejects.toThrow("Unsafe artifact directory");
});
it("reports directory creation failure rather than falling back to a temporary path", async () => {
  const root = await home(); await writeFile(join(root, "artifacts"), "not a directory");
  await expect(prepareArtifacts(makeJob({ project }), root)).rejects.toThrow();
});
it("keeps artifacts out of checkpoint and read-only worktree cleanup", async () => {
  const f = await fixture(); roots.push(f.root);
  const trees = new Worktrees(f.ws), workspace = await trees.prepare(f.job);
  await prepareArtifacts(f.job, f.root);
  const image = join(f.root, "artifacts", f.job.buildId, "screen.png"); await writeFile(image, "keep");
  await writeFile(join(workspace.cwd, "change.txt"), "tracked change");
  await trees.checkpoint(workspace, 1);
  expect(await git(workspace.cwd, "ls-files")).not.toContain("artifacts");
  await trees.reset(workspace);
  expect(await readFile(image, "utf8")).toBe("keep");
});
it.each([false, true])("delivers the artifact path to new/resumed Codex sessions (resume=%s)", async (resume) => {
  const root = await home();
  const job = await prepareArtifacts(makeJob({ project, ...(resume ? { sessionState: { threadId: "existing" } } : {}) }), root);
  const peer = `
    const assert=require('node:assert/strict'); const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line); if(m.method==='initialized') return;
      if(m.method==='initialize') send({id:m.id,result:{}});
      else if(m.method==='thread/start'||m.method==='thread/resume') {
        assert.equal(m.method,${JSON.stringify(resume ? "thread/resume" : "thread/start")});
        assert.equal(m.params.developerInstructions,${JSON.stringify(job.systemInstructions)});
        send({id:m.id,result:{thread:{id:'existing'}}});
      } else if(m.method==='turn/start') {
        send({id:m.id,result:{turn:{id:'turn'}}});
        send({method:'turn/completed',params:{threadId:'existing',turn:{id:'turn',status:'completed'}}});
      }
    });`;
  const { CodexRuntime } = await import("../src/runtimes/codex.js");
  const result = await new CodexRuntime(process.execPath, ["-e", peer, "--"]).start(job, { cwd: root, emit: () => {} }).result;
  expect(result.status).toBe("done");
});
it.each([false, true])("delivers the artifact path to new/resumed Claude sessions (resume=%s)", async (resume) => {
  const root = await home();
  const job = await prepareArtifacts(makeJob({ project, ...(resume ? { sessionState: { sessionId: "existing" } } : {}) }), root);
  const peer = `const assert=require('node:assert/strict'), args=process.argv.slice(1);
    assert.equal(args.includes('--resume'),${resume});
    assert.equal(args[args.indexOf('--append-system-prompt')+1],${JSON.stringify(job.systemInstructions)});
    require('node:readline').createInterface({input:process.stdin}).on('line',()=>process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'Done',usage:{}})+'\\n'));`;
  const { ClaudeRuntime } = await import("../src/runtimes/claude.js");
  const result = await new ClaudeRuntime(process.execPath, ["-e", peer, "--"]).start(job, { cwd: root, emit: () => {} }).result;
  expect(result.status).toBe("done");
});
