import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readdirSync, lstatSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { createSkillSchema, type Skill, type SkillFile } from "@muster/shared";
import { id, now, type MusterDb } from "../db/index.js";
import { StateError } from "../orchestrator/state.js";

const fail = (message: string): never => { throw new StateError(message, 400); };
export function validateFiles(files: SkillFile[]): void {
  if (!files.length || files.length > 200) fail("Skills must contain 1–200 files");
  const paths = new Set<string>(); let size = 0;
  for (const file of files) {
    if (!file.path || /[\\\x00-\x1f:]/.test(file.path) || file.path.startsWith("/") || file.path.split("/").some((p) => !p || p === "." || p === ".." || p === ".git" || p === ".manifest.json") || paths.has(file.path)) fail("Invalid skill file path");
    paths.add(file.path); size += Buffer.from(file.content, "base64").length;
    if (size > 5 * 1024 * 1024) fail("Skill exceeds 5 MB");
  }
}
export function frontmatter(text: string): { name: string; description: string; instructions: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return fail("SKILL.md requires YAML name and description");
  try { return createSkillSchema.parse({ ...parse(match[1]!, { maxAliasCount: 0 }), instructions: match[2] }); }
  catch { return fail("Invalid SKILL.md frontmatter or empty instructions"); }
}
export function parseGithubUrl(input: string): { repo: string; ref?: string; path: string } {
  let url: URL; try { url = new URL(input); } catch { return fail("Invalid GitHub skill URL"); }
  if (input.split("/").some((p) => p === "." || p === "..")) return fail("Invalid GitHub skill URL");
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || /%|\\/.test(input)) return fail("Use a public https://github.com/owner/repo URL");
  const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (parts.length < 2 || !parts.slice(0, 2).every((p) => /^[\w.-]+$/.test(p) && p !== "." && p !== "..") || (parts.length > 2 && (parts[2] !== "tree" || !parts[3])) || parts.some((p) => p === "." || p === ".." || !p) || (parts[3] !== undefined && !/^[\w.][\w.-]*$/.test(parts[3]))) return fail("Invalid GitHub skill URL");
  return { repo: `https://github.com/${parts[0]}/${parts[1]!.replace(/\.git$/, "")}.git`, ...(parts[3] ? { ref: parts[3] } : {}), path: parts.slice(4).join("/") };
}
export function readSkillFolder(root: string): SkillFile[] {
  const files: SkillFile[] = []; let total = 0;
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name; const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) fail("Skill symlinks are not allowed");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) { total += stat.size; if (total > 5 * 1024 * 1024 || files.length >= 200) fail("Skill exceeds 5 MB or 200 files"); files.push({ path, content: readFileSync(join(root, path)).toString("base64") }); }
      else fail("Only regular skill files are allowed");
    }
  };
  if (lstatSync(root).isSymbolicLink()) fail("Skill symlinks are not allowed"); walk(""); validateFiles(files); return files;
}
export type GithubFetcher = (url: string) => Promise<SkillFile[]>;
export const fetchGithub: GithubFetcher = async (url) => {
  const parsed = parseGithubUrl(url); const temp = mkdtempSync(join(tmpdir(), "muster-skill-"));
  try {
    const git = promisify(execFile); const repo = join(temp, "repo");
    await git("git", ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--filter=blob:none", "--sparse", ...(parsed.ref ? ["--branch", parsed.ref] : []), "--", parsed.repo, repo], { timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (parsed.path) await git("git", ["-C", repo, "sparse-checkout", "set", "--", parsed.path], { timeout: 60_000 });
    else await git("git", ["-C", repo, "sparse-checkout", "disable"], { timeout: 60_000 });
    const root = join(repo, parsed.path); for (const part of parsed.path.split("/").filter(Boolean).map((_, i, a) => join(repo, ...a.slice(0, i + 1)))) if (lstatSync(part).isSymbolicLink()) fail("Skill symlinks are not allowed");
    return readSkillFolder(root);
  } catch (error) { if (error instanceof StateError) throw error; return fail("Could not import GitHub skill. Check that the public repository, branch and folder exist."); }
  finally { rmSync(temp, { recursive: true, force: true }); }
};

export class Skills {
  constructor(readonly db: MusterDb, readonly directory: string, readonly fetcher: GithubFetcher = fetchGithub) { mkdirSync(directory, { recursive: true }); }
  private files(slug: string): SkillFile[] { return readSkillFolder(join(this.directory, slug)); }
  private map(row: Record<string, unknown>): Skill { const files = this.files(String(row.slug)); return { id: String(row.id), slug: String(row.slug), name: String(row.name), description: String(row.description), source: JSON.parse(String(row.source_json)), createdAt: String(row.created_at), updatedAt: String(row.updated_at), version: this.hash(files) }; }
  hash(files: SkillFile[]): string { return createHash("sha256").update(JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))).digest("hex"); }
  list(): Skill[] { return this.db.rows("SELECT * FROM skills ORDER BY name").map((r) => this.map(r)); }
  get(slug: string): Skill { const row = this.db.row("SELECT * FROM skills WHERE slug=?", slug); if (!row) throw new StateError("Skill not found", 404); return this.map(row); }
  archive(slug: string, version?: string): { files: SkillFile[] } { const skill = this.get(slug); if (version && skill.version !== version) throw new StateError("Skill version changed; retry the task", 409); return { files: this.files(slug) }; }
  save(files: SkillFile[], source: Record<string, unknown>, existing?: string): Skill {
    validateFiles(files); const skillFile = files.find((f) => f.path === "SKILL.md"); if (!skillFile) return fail("Folder must contain SKILL.md");
    const meta = frontmatter(Buffer.from(skillFile.content, "base64").toString("utf8")); const slug = existing ?? meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug || slug.length > 100) return fail("Skill name must produce a valid slug");
    if (!existing && this.db.row("SELECT id FROM skills WHERE slug=?", slug)) throw new StateError("A skill with this slug already exists", 409);
    const temp = mkdtempSync(join(this.directory, ".import-"));
    try {
      for (const file of files) { const path = join(temp, file.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(file.content, "base64")); }
      const target = join(this.directory, slug); const old = `${temp}-old`;
      if (existing) renameSync(target, old);
      try { renameSync(temp, target); this.db.run("INSERT INTO skills VALUES (?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET name=excluded.name,description=excluded.description,updated_at=excluded.updated_at", id(), slug, meta.name, meta.description, JSON.stringify(source), now(), now()); }
      catch (error) { rmSync(target, { recursive: true, force: true }); if (existing) renameSync(old, target); throw error; }
      rmSync(old, { recursive: true, force: true }); return this.get(slug);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  create(input: { name: string; description: string; instructions: string }): Skill { const meta = createSkillSchema.parse(input); return this.save([{ path: "SKILL.md", content: Buffer.from(`---\n${stringify({ name: meta.name, description: meta.description })}---\n${meta.instructions}\n`).toString("base64") }], { type: "authored" }); }
  update(slug: string, input: { description?: string | undefined; instructions?: string | undefined }): Skill {
    const skill = this.get(slug); const files = this.files(slug); const file = files.find((f) => f.path === "SKILL.md")!; const meta = { ...frontmatter(Buffer.from(file.content, "base64").toString("utf8")), ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) };
    file.content = Buffer.from(`---\n${stringify({ name: meta.name, description: meta.description })}---\n${meta.instructions}\n`).toString("base64"); return this.save(files, skill.source, slug);
  }
  async github(url: string): Promise<Skill> { parseGithubUrl(url); return this.save(await this.fetcher(url), { type: "github", url }); }
  delete(slug: string): void { const skill = this.get(slug); this.db.transaction(() => { for (const row of this.db.rows("SELECT * FROM agents")) { const agent = this.db.agent(row); this.db.run("UPDATE agents SET default_skill_ids_json=?,updated_at=? WHERE id=?", JSON.stringify(agent.defaultSkillIds?.filter((s) => s !== skill.id)), now(), agent.id); } this.db.run("DELETE FROM skills WHERE id=?", skill.id); }); rmSync(join(this.directory, slug), { recursive: true, force: true }); }
}
