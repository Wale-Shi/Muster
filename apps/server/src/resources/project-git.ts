import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import type { Project } from "@muster/shared";
import { StateError } from "../orchestrator/state.js";

const limit = 1024 * 1024;
export class ProjectGit {
  constructor(private project: Project) {}
  async available() { return isAbsolute(this.project.repoUrl) && await stat(this.project.repoUrl).then((s) => s.isDirectory(), () => false); }
  private async git(args: string[], maxBuffer = 4 * limit): Promise<Buffer> {
    if (!await this.available()) throw new StateError("File browsing is available for repositories on this computer", 400);
    return new Promise((resolve, reject) => execFile("git", ["--no-pager", "-C", this.project.repoUrl, ...args], { timeout: 8000, maxBuffer, encoding: "buffer", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => error ? reject(new StateError("Repository content unavailable", 400)) : resolve(stdout)));
  }
  private path(path: string) {
    if (isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((s) => s === ".." || s === ".")) throw new StateError("Invalid repository path", 400);
    return path;
  }
  private async base() { return (await this.git(["rev-parse", "--verify", "--end-of-options", `refs/heads/${this.project.baseBranch}^{commit}`])).toString().trim(); }
  async branches() { return (await this.git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).toString().trim().split("\n").filter(Boolean); }
  async tree(path = "") {
    const base = await this.base(); const clean = this.path(path).replace(/\/$/, "");
    const content = (await this.git(["ls-tree", "-z", `${base}${clean ? `:${clean}` : ""}`])).toString();
    return content.split("\0").filter(Boolean).map((entry) => { const separator = entry.indexOf("\t"); const meta = entry.slice(0, separator); const name = entry.slice(separator + 1); const [mode, type, sha] = meta.split(" "); return { name: name!, path: clean ? `${clean}/${name}` : name!, type, mode, sha }; });
  }
  async file(path: string) {
    const ref = `${await this.base()}:${this.path(path)}`;
    if ((await this.git(["cat-file", "-t", ref])).toString().trim() !== "blob") throw new StateError("Not a file", 400);
    const size = Number((await this.git(["cat-file", "-s", ref])).toString());
    if (size > limit) return { path, size, notice: "large", content: null };
    const bytes = await this.git(["cat-file", "blob", ref], limit + 1);
    const binary = bytes.includes(0);
    return { path, size, notice: binary ? "binary" : null, content: binary ? null : bytes.toString("utf8") };
  }
  async commits() {
    return (await this.git(["log", "-100", "--format=%H%x00%h%x00%an%x00%aI%x00%s", await this.base(), "--"])).toString().trim().split("\n").filter(Boolean).map((line) => { const [sha, shortSha, author, date, subject] = line.split("\0"); return { sha, shortSha, author, date, subject }; });
  }
  async commit(sha: string) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new StateError("Invalid commit", 400);
    await this.git(["merge-base", "--is-ancestor", sha, await this.base()]);
    return { sha, diff: (await this.git(["show", "--format=", "--no-ext-diff", "--no-textconv", "--no-renames", sha, "--"])).toString() };
  }
}
