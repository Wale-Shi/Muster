import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnJob } from "@muster/shared";
import { git } from "../src/worktree.js";

export async function fixture(): Promise<{ root: string; origin: string; ws: string; job: TurnJob }> {
  const root = await mkdtemp(join(tmpdir(), "muster-daemon-"));
  const origin = join(root, "origin"); const ws = join(root, "workspaces");
  await mkdir(origin); await mkdir(ws);
  await git(origin, "init", "-b", "main");
  await writeFile(join(origin, "README.md"), "original\n");
  await git(origin, "add", "."); await git(origin, "commit", "-m", "initial");
  return { root, origin, ws, job: makeJob({ project: { id: "project-1", repoUrl: origin, baseBranch: "main" } }) };
}
export function makeJob(overrides: Partial<TurnJob> = {}): TurnJob {
  return { turnId: "turn-1", buildId: "build-1", todoId: "todo-1", topicId: null, kind: "build", project: null, branch: "muster/conv-build-1", agent: { runtime: "mock", model: "mock-1", reasoning: null, role: "Builder" }, prompt: "Add a greeting", systemInstructions: "Follow the task", sessionState: null, readOnly: false, mcp: { url: "http://localhost:7420/mcp", token: "test-only" }, ...overrides };
}
export async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) { const value = await read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 15)); }
}
