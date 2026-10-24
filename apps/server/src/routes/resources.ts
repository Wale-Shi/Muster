import { z } from "zod";
import { stringify } from "yaml";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { memorySchema, githubSkillSchema, putSecretSchema, createSkillSchema, type SkillFile } from "@muster/shared";
import type { AppServices } from "../services.js";
import { body } from "./helpers.js";
import { now } from "../db/index.js";
import { StateError } from "../orchestrator/state.js";
import { frontmatter, validateFiles, parseGithubUrl } from "../resources/skills.js";

export function resourceRoutes({ db, memories, skills, secrets, events }: AppServices): Hono {
  const app = new Hono();
  const changed = (type: string) => events.emit({ type: `${type}.changed`, payload: {} });
  app.get("/agents/:id/memories", (c) => c.json({ data: memories.list(c.req.param("id")) }));
  app.post("/agents/:id/memories", async (c) => { const input = await body(c, memorySchema); const data = memories.create(c.req.param("id"), input.content, "user"); changed("memory"); return c.json({ data }, 201); });
  app.patch("/agents/:id/memories/:memoryId", async (c) => { const input = await body(c, memorySchema); const data = memories.update(c.req.param("id"), c.req.param("memoryId"), input.content); changed("memory"); return c.json({ data }); });
  app.delete("/agents/:id/memories/:memoryId", (c) => { memories.delete(c.req.param("id"), c.req.param("memoryId")); changed("memory"); return c.body(null, 204); });
  app.get("/skills", (c) => c.json({ data: skills.list() }));
  app.post("/skills/github", async (c) => { const input = await body(c, githubSkillSchema); if (c.req.query("preview") === "true") { parseGithubUrl(input.url); const files = await skills.fetcher(input.url); const meta = frontmatter(Buffer.from(files.find((f) => f.path === "SKILL.md")?.content ?? "", "base64").toString("utf8")); return c.json({ data: [{ files, name: meta.name, description: meta.description, source: { type: "github", url: input.url } }] }); } const data = await skills.github(input.url); changed("skill"); return c.json({ data }, 201); });
  app.use("/skills/upload", bodyLimit({ maxSize: 6 * 1024 * 1024, onError: (c) => c.json({ error: "Upload exceeds 5 MB" }, 413) }));
  app.post("/skills/upload", async (c) => {
    const form = await c.req.raw.formData(); const files: SkillFile[] = [];
    for (const file of form.getAll("files")) { if (typeof file === "string") throw new StateError("Expected skill files", 400); files.push({ path: file.name, content: Buffer.from(await file.arrayBuffer()).toString("base64") }); }
    validateFiles(files);
    const roots = files.filter((f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md")).map((f) => f.path.slice(0, -8));
    if (!roots.length) throw new StateError("No SKILL.md found", 400);
    if (form.get("bulk") !== "true" && roots.length !== 1) throw new StateError("Choose bulk import for multiple skills", 400);
    const groups = roots.map((root) => files.filter((f) => f.path.startsWith(root) && !roots.some((other) => other !== root && other.startsWith(root) && f.path.startsWith(other))).map((f) => ({ ...f, path: f.path.slice(root.length) })));
    for (const group of groups) { validateFiles(group); frontmatter(Buffer.from(group.find((f) => f.path === "SKILL.md")!.content, "base64").toString("utf8")); }
    if (c.req.query("preview") === "true") return c.json({ data: groups.map((files) => { const meta = frontmatter(Buffer.from(files.find((f) => f.path === "SKILL.md")!.content, "base64").toString("utf8")); return { files, name: meta.name, description: meta.description, source: { type: "folder" } }; }) });
    const saved: string[] = [];
    try { const data = groups.map((group) => { const skill = skills.save(group, { type: "folder" }); saved.push(skill.slug); return skill; }); changed("skill"); return c.json({ data }, 201); }
    catch (error) { for (const slug of saved) skills.delete(slug); throw error; }
  });
  app.use("/skills/import", bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ error: "Upload exceeds 5 MB" }, 413) }));
  app.post("/skills/import", async (c) => {
    const input = await body(c, z.array(z.object({ ...createSkillSchema.omit({ instructions: true }).shape, files: z.array(z.object({ path: z.string(), content: z.string() })).max(200), source: z.object({ type: z.enum(["folder", "github"]), url: z.string().url().optional() }) })).min(1).max(200));
    validateFiles(input.flatMap((s, i) => s.files.map((f) => ({ ...f, path: `${i}/${f.path}` }))));
    const slugs = new Set<string>();
    const prepared = input.map((skill) => {
      if (skill.source.type === "github") parseGithubUrl(skill.source.url ?? "");
      validateFiles(skill.files); const file = skill.files.find((f) => f.path === "SKILL.md"); if (!file) throw new StateError("Folder must contain SKILL.md", 400);
      const original = frontmatter(Buffer.from(file.content, "base64").toString("utf8"));
      file.content = Buffer.from(`---\n${stringify({ name: skill.name, description: skill.description })}---\n${original.instructions}\n`).toString("base64");
      const slug = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!slug || slug.length > 100) throw new StateError("Skill name must produce a valid slug", 400);
      if (slugs.has(slug) || db.row("SELECT id FROM skills WHERE slug=?", slug)) throw new StateError("A skill with this slug already exists", 409);
      slugs.add(slug); return skill;
    });
    const saved: string[] = [];
    try { const data = prepared.map((s) => { const skill = skills.save(s.files, s.source); saved.push(skill.slug); return skill; }); changed("skill"); return c.json({ data }, 201); }
    catch (error) { for (const slug of saved) skills.delete(slug); throw error; }
  });
  app.get("/skills/:slug", (c) => { const skill = skills.get(c.req.param("slug")); const files = skills.archive(skill.slug).files; return c.json({ data: { ...skill, instructions: Buffer.from(files.find((f) => f.path === "SKILL.md")!.content, "base64").toString("utf8"), files: files.map((f) => f.path), agents: db.rows("SELECT * FROM agents").map((r) => db.agent(r)).filter((a) => a.defaultSkillIds?.includes(skill.id)) } }); });
  app.delete("/skills/:slug", (c) => { skills.delete(c.req.param("slug")); changed("skill"); changed("agent"); return c.body(null, 204); });
  app.get("/secrets", (c) => c.json({ data: secrets.list(c.req.query("projectId")) }));
  app.put("/secrets", async (c) => {
    const input = await body(c, putSecretSchema);
    const message = input.requestId ? db.row("SELECT * FROM messages WHERE id=?", input.requestId) : undefined;
    if (input.requestId) {
      const request = message ? db.message(message).meta.secretRequest as { name?: string; scope?: string; projectId?: string } | undefined : undefined;
      if (!request || request.name !== input.name || request.scope !== input.scope || (request.projectId ?? null) !== (input.projectId ?? null)) throw new StateError("Secret request does not match", 400);
    }
    const data = db.transaction(() => { const secret = secrets.put(input); if (message) { const meta = { ...db.message(message).meta, fulfilledAt: now() }; db.run("UPDATE messages SET meta_json=? WHERE id=?", JSON.stringify(meta), message.id); } return secret; });
    changed("secret"); if (message) events.emit({ type: "message.created", conversationId: String(message.conversation_id), payload: db.message(db.row("SELECT * FROM messages WHERE id=?", message.id)!) });
    return c.json({ data });
  });
  app.delete("/secrets/:id", (c) => { secrets.delete(c.req.param("id")); changed("secret"); return c.body(null, 204); });
  return app;
}
