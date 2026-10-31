import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { taskCommitMessage, type TurnJob } from "@muster/shared";
import { Mutex, safeId, errorText } from "./util.js";

const execute = promisify(execFile);
export async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execute("git", ["-c", "user.name=Muster", "-c", "user.email=muster@localhost", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", cwd, ...args], {
      timeout: 120_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trimEnd();
  } catch (error) {
    const details = error as Error & { stdout?: string; stderr?: string };
    throw new Error([details.message, details.stdout, details.stderr].filter(Boolean).join("\n"));
  }
}

type Project = NonNullable<TurnJob["project"]>;
export interface Workspace { cwd: string; repo: string; branch: string; baseCommit: string; project: Project }
export class Worktrees {
  private mutex = new Mutex();
  constructor(readonly root: string) {}

  async prepare(job: TurnJob): Promise<Workspace> {
    if (!job.project) throw new Error("Project required for a worktree");
    const project = job.project;
    return this.mutex.run(project.id, async () => {
      const repo = join(this.root, safeId(project.id), "repo");
      const cwd = join(this.root, safeId(job.buildId));
      const branch = `muster/conv-${safeId(job.buildId)}`;
      await mkdir(resolve(repo, ".."), { recursive: true });
      await git(this.root, "check-ref-format", "--branch", project.baseBranch);
      if (!existsSync(repo)) await git(this.root, "clone", "--no-hardlinks", "--", (existsSync(resolve(project.repoUrl)) ? resolve(project.repoUrl) : project.repoUrl), repo);
      await git(repo, "fetch", "origin", `+refs/heads/${project.baseBranch}:refs/remotes/origin/${project.baseBranch}`);
      if (!existsSync(cwd)) {
        let exists = false;
        try { await git(repo, "show-ref", "--verify", `refs/heads/${branch}`); exists = true; } catch { /* new build */ }
        await git(repo, "worktree", "prune");
        await git(repo, "worktree", "add", ...(exists ? [] : ["-b", branch]), cwd, exists ? branch : `refs/remotes/origin/${project.baseBranch}`);
      } else {
        const commonDirectory = resolve(cwd, await git(cwd, "rev-parse", "--git-common-dir"));
        if (await realpath(commonDirectory) !== await realpath(join(repo, ".git")) || await realpath(await git(cwd, "rev-parse", "--show-toplevel")) !== await realpath(cwd) || await git(cwd, "branch", "--show-current") !== branch) {
          throw new Error(`Workspace ${cwd} does not belong to ${branch}`);
        }
      }
      return { cwd, repo, branch, baseCommit: await git(cwd, "merge-base", "HEAD", `refs/remotes/origin/${project.baseBranch}`), project };
    });
  }

  async checkpoint(workspace: Workspace, turnNumber?: number, job?: Pick<TurnJob, "todoId" | "task">): Promise<{ headCommit: string; diff: string }> {
    return this.mutex.run(workspace.project.id, async () => {
      await git(workspace.cwd, "add", "-A");
      if (await git(workspace.cwd, "diff", "--cached", "--name-only")) {
        const base = await git(workspace.cwd, "merge-base", "HEAD", `refs/remotes/origin/${workspace.project.baseBranch}`);
        const count = Number(await git(workspace.cwd, "rev-list", "--count", `${base}..HEAD`)) + 1;
        await git(workspace.cwd, "commit", "-m", job ? taskCommitMessage(job, "checkpoint", `muster: turn ${turnNumber ?? count}`, turnNumber ?? count) : `muster: turn ${turnNumber ?? count}`);
      }
      const mergeBase = await git(workspace.cwd, "merge-base", "HEAD", `refs/remotes/origin/${workspace.project.baseBranch}`);
      return { headCommit: await git(workspace.cwd, "rev-parse", "HEAD"), diff: await git(workspace.cwd, "diff", "--binary", mergeBase, "HEAD", "--") };
    });
  }

  async merge(workspace: Workspace, job?: Pick<TurnJob, "todoId" | "task">): Promise<{ ok: boolean; headCommit?: string; error?: string }> {
    return this.mutex.run(workspace.project.id, async () => {
      const { repo, branch, project } = workspace;
      let original: string | undefined;
      try {
        await git(repo, "fetch", "origin", `+refs/heads/${project.baseBranch}:refs/remotes/origin/${project.baseBranch}`);
        await git(repo, "checkout", project.baseBranch);
        await git(repo, "merge", "--ff-only", `refs/remotes/origin/${project.baseBranch}`);
        original = await git(repo, "rev-parse", "HEAD");
        await git(repo, "merge", "--no-ff", "-m", job ? taskCommitMessage(job, "merge", `muster: merge ${branch}`) : `muster: merge ${branch}`, branch);
        const local = project.repoUrl.startsWith("file://") ? fileURLToPath(project.repoUrl) : resolve(project.repoUrl);
        if (existsSync(local)) {
          // Pushing into a checked-out branch is unsafe. Fetch into a private ref,
          // then fast-forward the clean checkout, preserving normal Git semantics.
          const trees = (await git(local, "worktree", "list", "--porcelain")).split("\n\n");
          const checkedOut = trees.find((tree) => tree.includes(`branch refs/heads/${project.baseBranch}\n`) || tree.endsWith(`branch refs/heads/${project.baseBranch}`));
          if (checkedOut) {
            const originTree = checkedOut.split("\n")[0]!.slice("worktree ".length);
            if (await git(originTree, "status", "--porcelain")) throw new Error("Local origin working tree is dirty; commit or stash before merging");
            const ref = `refs/muster/incoming/${branch.slice("muster/conv-".length)}`;
            await git(originTree, "fetch", repo, `+refs/heads/${project.baseBranch}:${ref}`);
            try { await git(originTree, "merge", "--ff-only", ref); }
            finally { await git(originTree, "update-ref", "-d", ref); }
          } else await git(repo, "push", "origin", `refs/heads/${project.baseBranch}:refs/heads/${project.baseBranch}`);
        } else await git(repo, "push", "origin", `refs/heads/${project.baseBranch}:refs/heads/${project.baseBranch}`);
        return { ok: true, headCommit: await git(repo, "rev-parse", "HEAD") };
      } catch (error) {
        try { await git(repo, "merge", "--abort"); } catch { /* no merge in progress */ }
        if (original) await git(repo, "reset", "--hard", original);
        return { ok: false, error: errorText(error) };
      }
    });
  }
}
