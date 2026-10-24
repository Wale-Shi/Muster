import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, mkdtemp } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { AgentEvent, SkillFile, TurnJob } from "@muster/shared";
import type { MachineClient } from "./client.js";

export function redactor(env: Record<string, string> = {}) {
  const entries = Object.entries(env).filter(([, value]) => value.length >= 6).sort((a, b) => b[1].length - a[1].length);
  const redact = <T>(value: T): T => {
    if (typeof value === "string") { let text: string = value; for (const [name, secret] of entries) text = text.split(secret).join(`[secret:${name}]`); return text as T; }
    if (Array.isArray(value)) return value.map(redact) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redact(item)])) as T;
    return value;
  };
  return redact;
}

// Streams deltas while holding back the last (longest secret - 1) characters, so a secret split across deltas
// is always redacted before any part of it leaves the machine.
export function secretEvents(env: Record<string, string> | undefined, emit: (event: AgentEvent) => void) {
  const redact = redactor(env);
  const hold = Math.max(0, ...Object.values(env ?? {}).filter((v) => v.length >= 6).map((v) => v.length)) - 1;
  let message = ""; let messagePending = ""; let reasoningPending = "";
  const stream = (pending: string, content: string, type: "message.delta" | "reasoning.delta") => {
    const text = redact(pending + content); const cut = Math.max(0, text.length - hold);
    if (cut) emit({ type, content: text.slice(0, cut) });
    return text.slice(cut);
  };
  return {
    emit(event: AgentEvent) {
      if (hold <= 0) { emit(event); return; }
      if (event.type === "message.delta") { message += event.content; messagePending = stream(messagePending, event.content, "message.delta"); return; }
      if (event.type === "reasoning.delta") { reasoningPending = stream(reasoningPending, event.content, "reasoning.delta"); return; }
      if (event.type === "message.completed") {
        if (messagePending) emit({ type: "message.delta", content: messagePending });
        emit(redact({ ...event, content: event.content ?? message })); message = ""; messagePending = ""; return;
      }
      emit(redact(event));
    },
    flush() {
      if (messagePending || message) emit(redact({ type: "message.completed", content: message }));
      if (reasoningPending) emit({ type: "reasoning.delta", content: reasoningPending });
      message = ""; messagePending = ""; reasoningPending = "";
    },
  };
}

export async function prepareSkills(job: TurnJob, client: MachineClient): Promise<TurnJob> {
  if (!job.skills?.length) return job;
  const cache = join(client.options.home, "skills-cache"); await mkdir(cache, { recursive: true }); const index: string[] = [];
  for (const skill of job.skills) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.slug) || !/^[a-f0-9]{64}$/.test(skill.version)) throw new Error("Invalid skill identity");
    const path = join(cache, `${skill.slug}@${skill.version}`); let files: SkillFile[];
    try { files = JSON.parse(await readFile(join(path, ".manifest.json"), "utf8")) as SkillFile[]; }
    catch {
      files = (await client.request<{ files: SkillFile[] }>(`/api/machine/skills/${skill.slug}/archive?version=${skill.version}`)).files;
      let size = 0; const seen = new Set<string>();
      if (!files.length || files.length > 200) throw new Error("Invalid skill archive");
      for (const file of files) {
        if (/[\\\x00-\x1f:]/.test(file.path) || file.path.split("/").some((p) => !p || p === "." || p === ".." || p === ".manifest.json") || seen.has(file.path)) throw new Error("Invalid skill path");
        seen.add(file.path); size += Buffer.from(file.content, "base64").length;
      }
      if (size > 5 * 1024 * 1024 || !seen.has("SKILL.md")) throw new Error("Invalid skill archive size or manifest");
      const hash = createHash("sha256").update(JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))).digest("hex");
      if (hash !== skill.version) throw new Error("Skill hash mismatch");
      const temp = await mkdtemp(join(cache, ".download-"));
      try {
        for (const file of files) { const target = join(temp, file.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.from(file.content, "base64"), { mode: 0o444 }); }
        await writeFile(join(temp, ".manifest.json"), JSON.stringify(files), { mode: 0o444 });
        try { await rename(temp, path); } catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      } finally { await rm(temp, { recursive: true, force: true }); }
    }
    index.push(`- ${skill.name}: ${skill.description}\n  ${join(path, "SKILL.md")}`);
    if (job.readOnly) index.push(`\n### ${skill.name}\n${Buffer.from(files.find((f) => f.path === "SKILL.md")!.content, "base64").toString("utf8")}`);
  }
  return { ...job, systemInstructions: `${job.systemInstructions}\n\n## Available skills\nRead a skill's SKILL.md before doing work it covers.\n${index.join("\n")}` };
}
