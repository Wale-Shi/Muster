import { afterEach, describe, expect, it } from "vitest";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Worktrees, git } from "../src/worktree.js";
import { fixture } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() { const f = await fixture(); roots.push(f.root); return { ...f, manager: new Worktrees(f.ws) }; }

describe("worktree lifecycle", () => {
  it("clones, reuses, checkpoints, and diffs against the merge base", async () => {
    const { manager, job, ws, origin } = await setup();
    const tree = await manager.prepare(job);
    expect(tree.cwd).toBe(join(ws, job.buildId));
    expect(await git(tree.cwd, "branch", "--show-current")).toBe("muster/conv-build-1");
    await writeFile(join(tree.cwd, "feature.txt"), "hello\n");
    const first = await manager.checkpoint(tree);
    expect(first.diff).toContain("+hello");
    expect(await git(tree.cwd, "log", "-1", "--format=%s")).toBe("muster: turn 1");
    expect((await manager.checkpoint(tree)).headCommit).toBe(first.headCommit);
    const reused = await manager.prepare(job);
    expect(await git(reused.cwd, "rev-parse", "HEAD")).toBe(first.headCommit);
    await writeFile(join(tree.cwd, "feature.txt"), "hello again\n");
    await manager.checkpoint(reused);
    expect(await git(tree.cwd, "log", "-1", "--format=%s")).toBe("muster: turn 2");
    expect(await git(origin, "status", "--porcelain")).toBe("");
    expect(await readFile(join(origin, "README.md"), "utf8")).toBe("original\n");
  });
  it("merges --no-ff and fast-forwards the checked-out local origin", async () => {
    const { manager, job, origin } = await setup(); const tree = await manager.prepare(job);
    await writeFile(join(tree.cwd, "feature.txt"), "merged\n"); await manager.checkpoint(tree);
    const merge = await manager.merge(tree);
    expect(merge.ok).toBe(true);
    expect(await git(origin, "rev-parse", "HEAD")).toBe(merge.headCommit);
    expect((await git(origin, "show", "-s", "--format=%P", "HEAD")).split(" ")).toHaveLength(2);
    expect(await readFile(join(origin, "feature.txt"), "utf8")).toBe("merged\n");
    expect(await git(origin, "status", "--porcelain")).toBe("");
  });
  it("pushes to a bare local origin", async () => {
    const { manager, job, origin, root } = await setup();
    const bare = join(root, "bare.git"); await git(origin, "clone", "--bare", origin, bare);
    const tree = await manager.prepare({ ...job, project: { ...job.project!, repoUrl: bare } });
    await writeFile(join(tree.cwd, "feature.txt"), "bare\n"); await manager.checkpoint(tree);
    const merge = await manager.merge(tree);
    expect(merge.ok).toBe(true); expect(await git(bare, "rev-parse", "main")).toBe(merge.headCommit);
  });
  it("aborts conflicts and leaves the origin unchanged", async () => {
    const { manager, job, origin } = await setup(); const tree = await manager.prepare(job);
    await writeFile(join(tree.cwd, "README.md"), "build change\n"); await manager.checkpoint(tree);
    await writeFile(join(origin, "README.md"), "origin change\n"); await git(origin, "add", "."); await git(origin, "commit", "-m", "origin changed");
    const originHead = await git(origin, "rev-parse", "HEAD");
    const merge = await manager.merge(tree);
    expect(merge.ok).toBe(false); expect(merge.error).toMatch(/CONFLICT|conflict/);
    expect(await git(origin, "rev-parse", "HEAD")).toBe(originHead);
    expect(await git(tree.repo, "status", "--porcelain")).toBe("");
    await expect(git(tree.repo, "rev-parse", "--verify", "MERGE_HEAD")).rejects.toThrow();
  });
  it("refuses a dirty checked-out origin without losing the worktree changes", async () => {
    const { manager, job, origin } = await setup(); const tree = await manager.prepare(job);
    await writeFile(join(tree.cwd, "feature.txt"), "feature\n"); const checkpoint = await manager.checkpoint(tree);
    await writeFile(join(origin, "README.md"), "uncommitted user work\n");
    expect(await manager.merge(tree)).toMatchObject({ ok: false, error: expect.stringContaining("dirty") });
    expect(await readFile(join(origin, "README.md"), "utf8")).toBe("uncommitted user work\n");
    expect(await git(tree.cwd, "rev-parse", "HEAD")).toBe(checkpoint.headCommit);
  });
  it("serializes project git operations while keeping distinct builds", async () => {
    const { manager, job } = await setup();
    const trees = await Promise.all([manager.prepare(job), manager.prepare({ ...job, buildId: "build-2" })]);
    expect(trees[0]!.repo).toBe(trees[1]!.repo); expect(trees[0]!.cwd).not.toBe(trees[1]!.cwd);
  });
});

it("writes task messages safely and preserves history across revisions and repeated merges", async () => {
  const { manager, job, origin } = await setup();
  const title = '修复 "引号" `touch injected` $(touch injected)\n第二行\u0000';
  job.task = { number: 7, title, summary: "First paragraph\nwith details", url: "https://muster.example/todos/todo-1" };
  const tree = await manager.prepare(job);
  const original = await git(origin, "rev-parse", "HEAD");
  await writeFile(join(tree.cwd, "feature.txt"), "first\n");
  const first = await manager.checkpoint(tree, 2, job);
  const subject = '#7 修复 "引号" `touch injected` $(touch injected) 第二行';
  expect(await git(tree.cwd, "log", "-1", "--format=%B")).toBe(`${subject}\n\nTurn: 2`);
  expect((await manager.checkpoint(tree, 2, job)).headCommit).toBe(first.headCommit);
  await writeFile(join(tree.cwd, "feature.txt"), "revised\n");
  const second = await manager.checkpoint(tree, 3, job);
  expect(await git(tree.cwd, "log", "-1", "--format=%B")).toBe(`${subject}\n\nTurn: 3`);
  expect(await git(tree.cwd, "rev-parse", "HEAD^")).toBe(first.headCommit);
  expect(await git(tree.cwd, "rev-parse", "HEAD^^")).toBe(original);
  await expect(readFile(join(tree.cwd, "injected"))).rejects.toThrow();
  const merged = await manager.merge(tree, job);
  expect(merged.ok).toBe(true);
  expect(await git(origin, "log", "-1", "--format=%B")).toBe(`Merge ${subject.replace("#7 ", "#7: ")}\n\nFirst paragraph with details\n\nTask: https://muster.example/todos/todo-1\nTask ID: todo-1`);
  expect(await git(origin, "rev-parse", "HEAD^1")).toBe(original);
  expect(await git(origin, "rev-parse", "HEAD^2")).toBe(second.headCommit);
  expect((await manager.merge(tree, job)).headCommit).toBe(merged.headCommit);
  expect(await git(origin, "status", "--porcelain")).toBe("");
});
